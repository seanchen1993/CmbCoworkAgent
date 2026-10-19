import { expect, it, vi } from "vitest"
import {
  createWorkflowPlatformProvider,
  type WorkflowPlatformDependencies
} from "./platform-workflow-provider"
import type { NativePlatformCallContext } from "./platform-capabilities-types"
import type { WorkflowRunObservation } from "../../agent/workflow/observation"

const run = {
  runId: "run",
  status: "running",
  agents: [],
  worktrees: []
} as unknown as WorkflowRunObservation
function setup() {
  const context: NativePlatformCallContext = {
    workspace: "/project",
    threadId: "thread",
    incarnation: "one",
    generation: "one",
    caller: { name: "consumer", provider: "consumer", digest: "source", generation: "one" },
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
    publish: vi.fn(),
    invoke: vi.fn()
  }
  let listener: ((thread: string, runId: string) => void) | undefined
  const stop = vi.fn()
  const deps: WorkflowPlatformDependencies = {
    active: vi.fn(async () => run),
    latest: vi.fn(async () => null),
    inspect: vi.fn(async () => run),
    changed: vi.fn((next) => {
      listener = next
      return stop
    }),
    confirmCancel: vi.fn(async () => true),
    cancel: vi.fn(() => true),
    settled: vi.fn(async () => {})
  }
  return {
    context,
    deps,
    provider: createWorkflowPlatformProvider(deps),
    stop,
    emit: (thread = "thread") => listener?.(thread, "run")
  }
}

it("does not read services or attach listeners until a native read or subscription", async () => {
  const f = setup()
  expect(f.deps.active).not.toHaveBeenCalled()
  expect(f.deps.changed).not.toHaveBeenCalled()
  expect(await f.provider.read!(f.context)).toMatchObject({ activeRunId: "run" })
  expect(f.deps.active).toHaveBeenCalledWith("/project", "thread")
  expect(f.deps.latest).not.toHaveBeenCalled()
})

it("scopes and coalesces native notifications and ignores them after unsubscribe", async () => {
  const f = setup()
  const close = f.provider.watch!(f.context)
  f.emit("other-thread")
  await Promise.resolve()
  expect(f.deps.active).not.toHaveBeenCalled()
  f.emit()
  f.emit()
  f.emit()
  await vi.waitFor(() => expect(f.context.publish).toHaveBeenCalledTimes(1))
  expect(f.deps.active).toHaveBeenCalledTimes(1)
  close()
  f.emit()
  await Promise.resolve()
  expect(f.stop).toHaveBeenCalledTimes(1)
  expect(f.context.publish).toHaveBeenCalledTimes(1)
})

it("cannot cancel a different run and leaves a declined run running", async () => {
  const f = setup()
  expect(await f.provider.act(f.context, "cancel", { runId: "foreign" })).toEqual({
    requested: false,
    reason: "not-active"
  })
  expect(f.deps.confirmCancel).not.toHaveBeenCalled()
  vi.mocked(f.deps.confirmCancel).mockResolvedValue(false)
  expect(await f.provider.act(f.context, "cancel", { runId: "run" })).toEqual({
    requested: false,
    reason: "user-declined"
  })
  expect(f.deps.cancel).not.toHaveBeenCalled()
})

it("rechecks the active run after native confirmation and waits for actual original cleanup", async () => {
  const f = setup()
  let finish!: () => void
  vi.mocked(f.deps.settled).mockImplementation(
    () =>
      new Promise<void>((done) => {
        finish = done
      })
  )
  let returned = false
  const pending = f.provider.act(f.context, "cancel", { runId: "run" }).then((result) => {
    returned = true
    return result
  })
  await vi.waitFor(() => expect(f.deps.settled).toHaveBeenCalledWith("thread", "run"))
  expect(f.deps.active).toHaveBeenCalledTimes(2)
  expect(f.deps.cancel).toHaveBeenCalledWith("thread", "run")
  expect(returned).toBe(false)
  finish()
  expect(await pending).toMatchObject({ requested: true, cleanupSettled: true })
})

it("does not turn an original run change during confirmation into cancellation of its successor", async () => {
  const f = setup()
  vi.mocked(f.deps.active)
    .mockResolvedValueOnce(run)
    .mockResolvedValueOnce({ ...run, runId: "successor" })
  expect(await f.provider.act(f.context, "cancel", { runId: "run" })).toEqual({
    requested: false,
    reason: "not-active"
  })
  expect(f.deps.cancel).not.toHaveBeenCalled()
})
