import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import { ModsManager } from "../manager"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import type { CompletionGateInput } from "../../agent/skill-lifecycle/completion-gate"

vi.mock("electron", () => ({
  utilityProcess: {
    fork: () => {
      throw Error("unexpected guest start")
    }
  }
}))
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})

function fixture(claim = true) {
  const root = mkdtempSync(join(tmpdir(), "mods-completion-operation-"))
  const threadId = randomUUID()
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  manager.configure(root, true, false)
  const runtimeSignal = new AbortController()
  const binding = { workspace: root, threadId, turnId: "turn", signal: runtimeSignal.signal }
  const instance = manager.createRuntimeAuthority(binding)
  manager.bindThread({ ...binding, runtimeAuthority: instance.authority })
  if (claim) claimLocalThreadRunLease({ threadId, owner: "mods", runId: "original" })
  let entered = false
  let finish = () => {}
  manager.attachFunctions({
    invalidate: () => {},
    closeThread: () => {},
    close: () => {},
    completionGate: async () => (input: CompletionGateInput) => {
      entered = true
      return new Promise((resolve, reject) => {
        finish = () => resolve({ decision: "pass" })
        if (input.signal.aborted) reject(input.signal.reason)
        else
          input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true })
      })
    }
  })
  cleanups.push(() => {
    finish()
    runtimeSignal.abort()
    instance.release()
    releaseLocalThreadRunLease(threadId, "mods", "original")
    releaseLocalThreadRunLease(threadId, "mods", "replacement")
    manager.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { manager, root, threadId, runtimeSignal, entered: () => entered, finish: () => finish() }
}
const input = () => ({
  signal: new AbortController().signal,
  revisionAttempts: 0,
  maxRevisionAttempts: 2
})

it("requires an actual run lease before entering a completion operation", async () => {
  const f = fixture(false)
  const gate = await f.manager.createCompletionGate(f.root, f.threadId, () => ({ turnId: "turn" }))
  const result = gate!(input()).then(
    () => "passed",
    () => "rejected"
  )
  const settled = await Promise.race([
    result,
    new Promise((resolve) => setTimeout(() => resolve("still running"), 250))
  ])
  f.finish()
  expect(settled).toBe("rejected")
  expect(f.entered()).toBe(false)
})

it.each(["handoff", "release", "replace", "runtime-cancel", "off"])(
  "actively aborts the original completion operation after %s",
  async (action) => {
    const f = fixture()
    const gate = await f.manager.createCompletionGate(f.root, f.threadId, () => ({
      turnId: "turn"
    }))
    const result = gate!(input()).then(
      () => "passed",
      () => "aborted"
    )
    await vi.waitFor(() => expect(f.entered()).toBe(true))
    if (action === "handoff")
      claimLocalThreadRunLease({
        threadId: f.threadId,
        owner: "mods",
        runId: "replacement",
        handoffFromRunId: "original"
      })
    if (action === "release") releaseLocalThreadRunLease(f.threadId, "mods", "original")
    if (action === "replace")
      f.manager.createRuntimeAuthority({ workspace: f.root, threadId: f.threadId, turnId: "other" })
    if (action === "runtime-cancel") f.runtimeSignal.abort()
    if (action === "off") f.manager.configure(f.root, false, false)
    const settled = await Promise.race([
      result,
      new Promise((resolve) => setTimeout(() => resolve("still running"), 500))
    ])
    f.finish()
    expect(settled).toBe("aborted")
  }
)

it("does not adopt a successor lease while an older gate awaits its first invocation", async () => {
  const f = fixture()
  const gate = await f.manager.createCompletionGate(f.root, f.threadId, () => ({ turnId: "turn" }))
  claimLocalThreadRunLease({
    threadId: f.threadId,
    owner: "mods",
    runId: "replacement",
    handoffFromRunId: "original"
  })
  const result = gate!(input()).then(
    () => "passed",
    () => "rejected"
  )
  const settled = await Promise.race([
    result,
    new Promise((resolve) => setTimeout(() => resolve("still running"), 250))
  ])
  f.finish()
  expect(settled).toBe("rejected")
  expect(f.entered()).toBe(false)
})

it("releases completion resources after success and leaves off mode without a gate", async () => {
  const f = fixture()
  const resources = (f.manager as unknown as { activeActions: Map<unknown, unknown> }).activeActions
  const gate = await f.manager.createCompletionGate(f.root, f.threadId, () => ({ turnId: "turn" }))
  const result = gate!(input())
  await vi.waitFor(() => expect(f.entered()).toBe(true))
  expect(resources.size).toBe(1)
  f.finish()
  expect(await result).toEqual({ decision: "pass" })
  expect(resources.size).toBe(0)
  f.manager.configure(f.root, false, false)
  expect(
    await f.manager.createCompletionGate(f.root, f.threadId, () => ({ turnId: "turn" }))
  ).toBeUndefined()
  expect(resources.size).toBe(0)
})
