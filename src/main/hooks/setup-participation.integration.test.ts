import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HookConfig } from "./types"

const classicEvent = vi.hoisted(() => vi.fn())
const modsEnabled = vi.hoisted(() => vi.fn())
const resolveHooks = vi.hoisted(() => vi.fn())
vi.mock("../mods/manager", () => ({
  getModsManager: () => ({ classicEvent, isEnabled: modsEnabled })
}))
vi.mock("./scope", () => ({ resolveEnabledHooksForRun: resolveHooks }))

import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../mods/v2/session"
import { participatedClassicHandler } from "../mods/v2/classic-result"
import { fireSessionEndAll, fireSessionStartOnce } from "./session-lifecycle"
import { resetHookOnceStateForTests, runHooks } from "./runner"
import { hasWorkspaceBeenInitialised } from "../services/setup-state"

let workspace: string
let session: FunctionSession | undefined
let server: Server
let url: string
let responseStatus = 200
let responseBody = ""
let legacyRequests: unknown[] = []
let hooks: HookConfig[] = []
const threadId = "setup-participation"

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    legacyRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    response.writeHead(responseStatus, { "Content-Type": "application/json" })
    response.end(responseBody)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw Error("missing test HTTP address")
  url = `http://127.0.0.1:${address.port}/setup`
})

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "setup-participation-"))
  hooks = []
  legacyRequests = []
  responseStatus = 200
  responseBody = ""
  modsEnabled.mockReset().mockReturnValue(true)
  classicEvent.mockReset()
  resolveHooks.mockReset().mockImplementation(() => hooks)
  resetHookOnceStateForTests()
})

afterEach(async () => {
  await fireSessionEndAll()
  await session?.close()
  session = undefined
  resetHookOnceStateForTests()
  rmSync(workspace, { recursive: true, force: true })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

async function guest(registrations: string, name = "setup", rewrite = false): Promise<void> {
  const runtime = await FunctionGuestRuntime.create(
    `var __cmbFunctionMod={register(on){${registrations}}}`
  )
  session = new FunctionSession([{
    name, root: workspace, tier: "user", guest: runtime,
    capabilities: [...SESSION_CAPABILITIES]
  }], {
    workspace, threadId, assertLive: () => undefined,
    publish: async value => rewrite ? { additionalContext: ["publication only"] } : value
  })
  classicEvent.mockImplementation((_workspace, _thread, event, input, signal, core) =>
    session!.classicEvent(event, input, signal, core))
}

function legacy(overrides: Partial<HookConfig> = {}): HookConfig {
  return {
    id: "legacy-setup", event: "Setup", type: "http", url, enabled: true,
    fallback: "block", createdAt: "2026-10-28", updatedAt: "2026-10-28", ...overrides
  }
}

async function start(onResult = vi.fn()): Promise<void> {
  await fireSessionStartOnce(threadId, workspace, onResult)
}

function expectMarker(present: boolean): void {
  expect(hasWorkspaceBeenInitialised(workspace)).toBe(present)
  expect(existsSync(join(workspace, ".cmbdevclaw", "setup-state.json"))).toBe(present)
}

describe("Setup marker requires a normally completed matching participant", () => {
  it.each([
    ["empty registration chain", ""],
    ["only an unrelated registration", 'on("classic.Stop",async($,e,next)=>next(e));'],
    ["unmatched Setup registration", 'on("classic.Setup",{trigger:"maintenance"},async()=>({}));'],
    ["failed matcher", 'on("classic.Setup",()=>{throw Error("matcher failed")},async()=>({}));'],
    ["failed handler", 'on("classic.Setup",async()=>{throw Error("setup failed")});'],
    ["invalid handler result", 'on("classic.Setup",async()=>"invalid");']
  ])("does not mark %s", async (_label, registration) => {
    await guest(registration)
    await start()
    expectMarker(false)
    expect(legacyRequests).toHaveLength(0)
  })

  it("does not mistake publication context or guest-shaped provenance for participation", async () => {
    await guest("", "setup", true)
    await start()
    expectMarker(false)
    expect(participatedClassicHandler({ participated: true, feedbackChanged: true })).toBe(false)
  })

  it("does not load a disabled Function Setup participant", async () => {
    await guest('on("classic.Setup",async()=>({}));')
    modsEnabled.mockReturnValue(false)
    await start()
    expectMarker(false)
    expect(classicEvent).not.toHaveBeenCalled()
  })

  it("leaves a fresh Git workspace clean after engine-only Setup", async () => {
    execFileSync("git", ["-C", workspace, "init", "--quiet"])
    await guest("")
    await start()
    expectMarker(false)
    expect(existsSync(join(workspace, ".cmbdevclaw"))).toBe(false)
    expect(execFileSync("git", ["-C", workspace, "status", "--porcelain=v1"],
      { encoding: "utf8" })).toBe("")
  })

  it("allows Setup installed after an empty first encounter to initialize on a new thread", async () => {
    await guest("")
    await start()
    expectMarker(false)
    hooks = [legacy()]
    await fireSessionStartOnce("after-install", workspace)
    expect(legacyRequests).toHaveLength(1)
    expectMarker(true)
  })

  it.each([
    ["valid no-op", 'on("classic.Setup",async()=>({}));'],
    ["next passthrough", 'on("classic.Setup",async($,e,next)=>next(e));'],
    ["additional context", 'on("classic.Setup",async()=>({additionalContext:["setup ready"]}));']
  ])("marks a real Function %s and retains workspace deduplication", async (_label, registration) => {
    await guest(registration)
    await start()
    expectMarker(true)
    const original = readFileSync(join(workspace, ".cmbdevclaw", "setup-state.json"), "utf8")
    await fireSessionStartOnce("another-thread", workspace)
    expect(classicEvent.mock.calls.filter(call => call[2] === "classic.Setup")).toHaveLength(1)
    expect(readFileSync(join(workspace, ".cmbdevclaw", "setup-state.json"), "utf8")).toBe(original)
  })

  it("counts a legitimate plugin named engine without counting its downstream core", async () => {
    await guest('on("classic.Setup",async($,e,next)=>next(e));', "engine")
    await start()
    expectMarker(true)
  })

  it.each([
    '{block:"setup blocked"}',
    '{preventContinuation:true,stopReason:"setup stopped"}'
  ])("does not mark a participating Function that blocks with %s", async result => {
    await guest(`on("classic.Setup",async()=>(${result}));`)
    await start()
    expectMarker(false)
  })

  it("runs the legacy HTTP Setup through the original runner and forwards its callback", async () => {
    await guest("")
    hooks = [legacy()]
    const onResult = vi.fn()
    await start(onResult)
    expectMarker(true)
    expect(legacyRequests).toEqual([expect.objectContaining({ trigger: "init" })])
    expect(onResult).toHaveBeenCalledExactlyOnceWith("Setup", hooks[0],
      expect.objectContaining({ exitCode: 0, blocked: false }))
  })

  it("preserves legacy participation while Function Mods are disabled", async () => {
    await guest('on("classic.Setup",async()=>({block:"disabled"}));')
    modsEnabled.mockReturnValue(false)
    hooks = [legacy()]
    await start()
    expectMarker(true)
    expect(legacyRequests).toHaveLength(1)
    expect(classicEvent).not.toHaveBeenCalled()
  })

  it.each([
    ["disabled legacy entry", { enabled: false }],
    ["unmatched legacy entry", { matcher: "maintenance" }]
  ])("does not mark %s", async (_label, overrides) => {
    await guest("")
    hooks = [legacy(overrides)]
    await start()
    expectMarker(false)
    expect(legacyRequests).toHaveLength(0)
  })

  it("does not mark a pure legacy once skip", async () => {
    await guest("")
    hooks = [legacy({ once: true })]
    expect(await runHooks(hooks, "Setup", {
      workspacePath: workspace, sessionId: threadId, setupTrigger: "init"
    })).toBeNull()
    expect(legacyRequests).toHaveLength(1)
    expectMarker(false)
    await start()
    expect(legacyRequests).toHaveLength(1)
    expectMarker(false)
  })

  it("does not mark a failed legacy Setup even with a successful Function participant", async () => {
    await guest('on("classic.Setup",async($,e,next)=>next(e));')
    hooks = [legacy()]
    responseStatus = 500
    responseBody = "setup failed"
    await start()
    expect(legacyRequests).toHaveLength(1)
    expectMarker(false)
  })

  it("retries a failed legacy Setup on a new thread without changing the failure convention", async () => {
    await guest("")
    hooks = [legacy()]
    responseStatus = 500
    await start()
    expectMarker(false)
    responseStatus = 200
    await fireSessionStartOnce("retry-thread", workspace)
    expect(legacyRequests).toHaveLength(2)
    expectMarker(true)
  })

  it("keeps the existing successful empty-command convention", async () => {
    await guest("")
    hooks = [legacy({ type: "command", command: "", url: undefined })]
    await start()
    expectMarker(true)
  })
})
