import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HookResult } from "./types"
import type { ModJson } from "../../shared/mods/types"

const state = vi.hoisted(() => ({ enabled: false, bridge: vi.fn(), execute: vi.fn() }))
vi.mock("../mods/manager", () => ({
  getModsManager: () => ({ isEnabled: () => state.enabled, classicEvent: state.bridge })
}))
vi.mock("./http-runner", () => ({ executeHttpHook: state.execute }))
vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined
}))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))

import { runHooks } from "./runner"
import { ModControlStore } from "../mods/control-store"
import { FunctionModsManager } from "../mods/v2/manager"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"

const cleanup: Array<() => Promise<void>> = []

it("Notification dispatch uses the child runtime scope and preserves the legacy approval owner", async () => {
  state.enabled = true
  let nativeSession: string | undefined
  state.bridge.mockImplementation(async (_workspace, thread, event, input, signal, core) => {
    expect(thread).toBe("child")
    expect(event).toBe("classic.Notification")
    expect(input.session_id).toBe("child")
    return core(input, signal)
  })
  state.execute.mockImplementation(async (_hook, payload) => {
    nativeSession = JSON.parse(payload).session_id
    return { exitCode: 0, stdout: "", stderr: "", blocked: false }
  })
  await runHooks([{
    id: "notify", event: "Notification", type: "http", url: "http://unused.invalid",
    enabled: true, createdAt: "", updatedAt: ""
  }], "Notification", { workspacePath: "/workspace", sessionId: "parent", functionSessionId: "child" })
  expect(state.bridge).toHaveBeenCalledOnce()
  expect(nativeSession).toBe("parent")
})
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.clearAllMocks()
})

async function fixture(code?: string, approved = true, protect = false) {
  const root = await mkdtemp(join(tmpdir(), "classic-native-"))
  const path = join(root, "plugin")
  if (code) {
    await mkdir(join(path, "hooks"), { recursive: true })
    await writeFile(
      join(path, "plugin.json"),
      JSON.stringify({ name: "observer", version: "1.0.0" })
    )
    await writeFile(join(path, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
    await writeFile(join(path, "hooks/register.ts"), `export function register(on){${code}}`)
  }
  const store = new ModControlStore(join(root, "control.sqlite"))
  const guests = new Set<FunctionGuestRuntime>()
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => (code ? [{ id: "observer", name: "observer", path, enabled: true }] : []),
      enabled: () => state.enabled,
      publish: async (_workspace, value) =>
        protect
          ? (JSON.parse(JSON.stringify(value).replaceAll("ADVISORY", "FILTERED")) as ModJson)
          : value,
      changed: () => {}
    },
    () => ({
      async load(source, options) {
        const guest = await FunctionGuestRuntime.create(source, options)
        guests.add(guest)
        return guest
      },
      stop() {
        for (const guest of guests) guest.dispose()
      }
    })
  )
  cleanup.push(async () => {
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  if (code && approved) {
    const status = (await manager.status(root))[0]
    await manager.approve(root, status.pluginId, status.digest!)
  }
  state.bridge.mockImplementation((workspace, thread, event, input, signal, core) =>
    manager.classicEvent(workspace, thread, event, input, signal, core)
  )
  state.execute.mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: false,
    additionalContext: "ADVISORY",
    systemMessage: "Legacy Plugin notice"
  } satisfies HookResult)
  const run = () =>
    runHooks(
      [
        {
          id: "legacy",
          event: "Stop",
          type: "http",
          url: "http://unused.invalid",
          enabled: true,
          createdAt: "",
          updatedAt: ""
        }
      ],
      "Stop",
      { workspacePath: root, sessionId: "thread" }
    )
  return { run, manager, root }
}

it.each([
  ["no sources", undefined, true],
  ["unapproved source", 'on("classic.Stop",()=>({additionalContext:["guest"]}))', false],
  ["unrelated registration", 'on("classic.PreToolUse",($,e,next)=>next(e))', true],
  [
    "unmatched registration",
    'on("classic.Stop",{session_id:"other"},()=>({additionalContext:["guest"]}))',
    true
  ],
  ["next passthrough", 'on("classic.Stop",($,e,next)=>next(e))', true]
] as const)("retains complete native Stop semantics for %s", async (_name, code, approved) => {
  const f = await fixture(code, approved)
  state.enabled = false
  const native = await f.run()
  state.enabled = true
  const enabled = await f.run()
  expect(enabled).toEqual(native)
  expect(enabled?.additionalContext).toBe("ADVISORY")
  expect(enabled?.systemMessage).toBe("Legacy Plugin notice")
  expect(enabled?.stopFeedbackContinuation).toBeUndefined()
  expect(state.execute).toHaveBeenCalledTimes(2)
})

it.each([
  'on("classic.Stop",async($,e,next)=>{const result=await next(e);return {...result,additionalContext:[...result.additionalContext,"guest feedback"]}})',
  'on("classic.Stop",()=>({additionalContext:["guest feedback"]}))'
])("keeps genuine guest-added or short-circuit Stop feedback", async (code) => {
  const f = await fixture(code)
  state.enabled = true
  expect(await f.run()).toMatchObject({
    additionalContext: expect.stringContaining("guest feedback"),
    stopFeedbackContinuation: true
  })
})

it("does not attribute publication-only redaction of native context to a guest", async () => {
  const f = await fixture('on("classic.Stop",($,e,next)=>next(e))', true, true)
  state.enabled = true
  expect(await f.run()).toMatchObject({
    additionalContext: "FILTERED",
    systemMessage: "Legacy Plugin notice"
  })
  expect((await f.run())?.stopFeedbackContinuation).toBeUndefined()
})

it.each(["block", "halt"])("retains native %s without any authorized guest", async (kind) => {
  const f = await fixture()
  state.execute.mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: kind === "block",
    ...(kind === "block"
      ? { decision: "block", reason: "legacy gate" }
      : { continue: false, stopReason: "legacy halt" }),
    additionalContext: "ADVISORY",
    systemMessage: "Legacy notice"
  })
  state.enabled = false
  const native = await f.run()
  state.enabled = true
  expect(await f.run()).toEqual(native)
})

it("preserves a native halt even if a real guest changes feedback and removes preventContinuation", async () => {
  const f = await fixture(
    'on("classic.Stop",async($,e,next)=>{await next(e);return {additionalContext:["guest feedback"]}})'
  )
  state.execute.mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: false,
    continue: false,
    stopReason: "mandatory halt"
  })
  state.enabled = true
  expect(await f.run()).toMatchObject({ continue: false, stopReason: "mandatory halt" })
})
