import { expect, it, vi } from "vitest"
import { actualAgentCancelHandler } from "../../../tests/support/agent-cancel-handler"

function fixture(lease?: { owner: string }) {
  const pending = Promise.withResolvers<void>()
  const cancel = vi.fn(() => pending.promise)
  const busy = vi.fn((id: string) => id === "idle-owner")
  const notice = vi.fn(), autoMode = vi.fn(), flush = vi.fn()
  const controller = new AbortController()
  const activeRuns = new Map<string, AbortController>()
  const foregroundCancel = vi.fn()
  const handler = actualAgentCancelHandler({
    withThreadRunMutationLock: (_id: string, run: () => unknown) => run(),
    getLocalThreadRunLease: () => lease, activeRuns,
    turnStates: new Map([["foreground", { runToken: "turn" }]]),
    BrowserWindow: { fromWebContents: () => ({}) }, sendDesktopForeignOwnerBusy: notice,
    coordinatorWorkerManager: { cancelWorkersForThread: vi.fn(() => []) },
    sendCoordinatorWorkers: vi.fn(), LocalSandbox: { hasActiveBackgroundTasks: busy,
      cancelBackgroundTasksAndWait: cancel, cancelBackgroundTasks: foregroundCancel },
    flushPendingStreamTranscriptMessages: flush, handleAutoModeAgentCancelled: autoMode,
    console: { log: vi.fn(), warn: vi.fn() }
  })
  const invoke = (threadId: string, cancelWorkers = false) =>
    handler({ sender: {} }, { threadId, cancelWorkers })
  return { invoke, pending, cancel, busy, notice, autoMode, activeRuns, controller,
    foregroundCancel, flush }
}

it("awaits physical idle cleanup before the native cancellation receipt", async () => {
  const f = fixture()
  let returned = false
  const run = f.invoke("idle-owner").then(value => { returned = true; return value })
  await Promise.resolve()
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith("idle-owner")
  expect(returned).toBe(false)
  expect(f.autoMode).not.toHaveBeenCalled()
  f.pending.resolve()
  await expect(run).resolves.toBe(true)
  expect(f.autoMode).toHaveBeenCalledExactlyOnceWith("idle-owner")
})

it("does not acknowledge successful cancellation when physical cleanup rejects", async () => {
  const f = fixture()
  const run = f.invoke("idle-owner")
  f.pending.reject(Error("PHYSICAL_CLEANUP_UNKNOWN"))
  await expect(run).rejects.toThrow("PHYSICAL_CLEANUP_UNKNOWN")
  expect(f.autoMode).not.toHaveBeenCalled()
})

it("preserves foreign-owner, empty-thread and workers-only boundaries", async () => {
  const foreign = fixture({ owner: "im" })
  await expect(foreign.invoke("idle-owner")).resolves.toBe(false)
  expect(foreign.notice).toHaveBeenCalledOnce()
  expect(foreign.busy).not.toHaveBeenCalled()
  expect(foreign.cancel).not.toHaveBeenCalled()
  const ordinary = fixture()
  await expect(ordinary.invoke("foreign-empty")).resolves.toBe(false)
  await expect(ordinary.invoke("idle-owner", true)).resolves.toBe(false)
  expect(ordinary.cancel).not.toHaveBeenCalled()
})

it("keeps the original foreground flush, abort and immediate receipt", async () => {
  const f = fixture()
  f.activeRuns.set("foreground", f.controller)
  await expect(f.invoke("foreground")).resolves.toBe(true)
  expect(f.foregroundCancel).toHaveBeenCalledExactlyOnceWith("foreground")
  expect(f.flush).toHaveBeenCalledExactlyOnceWith("foreground", "turn")
  expect(f.controller.signal.aborted).toBe(true)
  expect(f.cancel).not.toHaveBeenCalled()
  expect(f.busy).not.toHaveBeenCalled()
})
