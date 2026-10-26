import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionProcessHost } from "./process-sdk"
import { observeFunctionProcess, runFunctionHostCall } from "./host-call"
import type { ModObject } from "../../../shared/mods/types"

const native = vi.hoisted(() => ({
  spawn: vi.fn(() => {
    throw Error("dispatch failed")
  })
}))
vi.mock("node:child_process", () => ({ spawn: native.spawn }))
vi.mock("../../agent/windows-background-job-controller-path", () => ({
  resolveWindowsBackgroundJobControllerPath: () => "fixture-controller"
}))
const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
  vi.clearAllMocks()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mods-process-lifecycle-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "ledger.sqlite")
  const store = new ModControlStore(file)
  cleanup.push(() => store.close())
  const identity = {
    workspace: root,
    threadId: "thread",
    turnId: "turn",
    agentId: "main",
    callId: "process",
    origin: "mod" as const,
    grantEpoch: 1
  }
  const controller = new AbortController()
  const context = {
    cwd: root,
    signal: controller.signal,
    assertLive: () => controller.signal.throwIfAborted(),
    authorize: vi.fn(async () => {}),
    publish: vi.fn(async (value: ModObject) => value)
  }
  const call = {
    store,
    identity,
    assertLive: context.assertLive,
    admit: async () => {},
    claim: () => store.claim(identity.callId, "process.run", {}, identity),
    processLifecycle: (event: Parameters<ModControlStore["recordProcessLifecycle"]>[1]) =>
      store.recordProcessLifecycle(identity.callId, event),
    invoke: () =>
      new FunctionProcessHost().run(
        { argv: ["fixture-command"], init: { stdin: "PRIVATE_INPUT" } },
        context
      ),
    status: () => "succeeded" as const,
    publish: async (value: ModObject) => value
  }
  return { root, file, store, controller, context, call, audit: () => store.audit(root)[0] }
}

it("persists cancellation before spawn as not_started and cannot launch after late approval", async () => {
  const f = fixture()
  let allowed!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.context.authorize.mockImplementation(async () => {
    observeFunctionProcess("approval-waiting")
    entered()
    await new Promise<void>((resolve) => {
      allowed = resolve
    })
  })
  const pending = runFunctionHostCall(f.call)
  await waiting
  const rejected = expect(pending).rejects.toThrow("cancelled")
  f.controller.abort(Error("cancelled"))
  await rejected
  allowed()
  await new Promise((resolve) => setImmediate(resolve))
  expect(native.spawn).not.toHaveBeenCalled()
  expect(f.context.publish).not.toHaveBeenCalled()
  expect(f.audit()).toMatchObject({ status: "not_started", publication: "blocked" })
  expect(f.audit().processLifecycle?.events.map((event) => event.phase)).toEqual([
    "preparing",
    "prepared",
    "authorizing",
    "approval-waiting",
    "not-started"
  ])
  expect(JSON.stringify(f.audit())).not.toContain("PRIVATE_INPUT")
  expect(f.audit().processLifecycle?.events[1].requestDigest).toMatch(/^[a-f0-9]{64}$/)
  const cold = new ModControlStore(f.file)
  try {
    expect(cold.audit(f.root)[0]).toEqual(f.audit())
  } finally {
    cold.close()
  }
})

it("retains unknown after dispatch even without startup acknowledgement", async () => {
  const f = fixture()
  await expect(runFunctionHostCall(f.call)).rejects.toThrow("dispatch failed")
  expect(native.spawn).toHaveBeenCalledOnce()
  expect(f.audit()).toMatchObject({ status: "unknown", publication: "blocked" })
  expect(f.audit().processLifecycle?.events.at(-1)?.phase).toBe("spawn-dispatched")
})

it("does not infer not_started without SDK evidence or let a forged error claim it", async () => {
  const f = fixture()
  await expect(
    runFunctionHostCall({
      ...f.call,
      invoke: async () => {
        throw Object.assign(Error("not-started"), { processLifecycle: { dispatched: false } })
      }
    })
  ).rejects.toThrow("not-started")
  expect(f.audit().status).toBe("unknown")
  expect(f.audit().processLifecycle).toBeUndefined()
})

it("records denial before dispatch and rejects late lifecycle writes to settled calls", async () => {
  const f = fixture()
  f.context.authorize.mockImplementation(async () => {
    observeFunctionProcess("approval-waiting")
    observeFunctionProcess("approval-rejected")
    throw Error("denied")
  })
  await expect(runFunctionHostCall(f.call)).rejects.toThrow("denied")
  expect(f.audit().status).toBe("not_started")
  expect(() =>
    f.store.recordProcessLifecycle("process", { phase: "started", at: Date.now() })
  ).toThrow("MODS_PROCESS_OBSERVATION_STALE")
  expect(native.spawn).not.toHaveBeenCalled()
})
