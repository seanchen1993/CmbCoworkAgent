import { describe, expect, it, vi } from "vitest"
import { PendingNotificationScheduler } from "./pending-notification-scheduler"
import { workflowRunManager } from "./workflow/run-manager"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"
import type { PersistedWorkflowRun } from "./workflow/types"

/**
 * The regression these cover is a combination, not a single side: the desktop
 * and the Zhaohu runner each behaved correctly alone, and the existing
 * notification tests exercise them that way. Summarising twice only appears
 * when both observe the same completion, which is the ordinary case whenever
 * somebody has the thread open while a remote run finishes.
 */

const THREAD = "thread-1"
const WORKSPACE = "/tmp/workspace"

function persistedRun(overrides: Partial<PersistedWorkflowRun> = {}): PersistedWorkflowRun {
  return {
    version: 1,
    runId: "wf_1",
    threadId: THREAD,
    workflowName: "test",
    script: "",
    scriptSha256: "sha",
    status: "completed",
    phases: [],
    currentPhase: null,
    agents: [],
    logs: [],
    journal: [],
    stats: {} as PersistedWorkflowRun["stats"],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  }
}

function createScheduler(run: PersistedWorkflowRun | null) {
  const startRun = vi.fn(async () => ({ completion: Promise.resolve() }) as never)
  vi.spyOn(workflowRunManager, "claimPendingNotificationAsync").mockResolvedValue(run)
  const cleared = vi
    .spyOn(workflowRunManager, "clearNotificationInFlight")
    .mockImplementation(() => undefined)
  const scheduler = new PendingNotificationScheduler({
    getThread: (() =>
      ({
        thread_id: THREAD,
        metadata: JSON.stringify({ workspacePath: WORKSPACE, agentMode: "workflow" })
      }) as never) as never,
    startRun: startRun as never,
    getDelivery: (() => ({}) as never) as never,
    createRunId: () => "fixed",
    log: () => undefined
  })
  return { scheduler, startRun, cleared }
}

describe("pending notification scheduler", () => {
  it("leaves a Zhaohu-owned summary to the runner that started it", async () => {
    const { scheduler, startRun, cleared } = createScheduler(
      persistedRun({ notificationOwner: "managed" })
    )
    const outcome = await scheduler.check(THREAD)

    expect(outcome).toEqual({ started: false, reason: "owned-by-managed-runner" })
    expect(startRun).not.toHaveBeenCalled()
    // Released, not held: the managed runner has to be able to claim it.
    expect(cleared).toHaveBeenCalledWith("wf_1")
    vi.restoreAllMocks()
  })

  it("runs a desktop-owned summary exactly once", async () => {
    const { scheduler, startRun } = createScheduler(persistedRun({ notificationOwner: "desktop" }))
    await scheduler.check(THREAD)
    expect(startRun).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it("treats a run recorded before ownership existed as the desktop's", async () => {
    const { scheduler, startRun } = createScheduler(persistedRun())
    await scheduler.check(THREAD)
    expect(startRun).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it("yields to a turn already holding the thread instead of preempting it", async () => {
    const { scheduler, startRun, cleared } = createScheduler(
      persistedRun({ notificationOwner: "desktop" })
    )
    const claim = claimLocalThreadRunLease({ threadId: THREAD, owner: "im", runId: "im-run" })
    expect(claim.acquired).toBe(true)
    try {
      const outcome = await scheduler.check(THREAD)
      expect(outcome).toEqual({ started: false, reason: "thread-busy" })
      expect(startRun).not.toHaveBeenCalled()
      // The claim must be given back, or the notification is stranded: nothing
      // re-delivers it and the run's persisted flag still says undelivered.
      expect(cleared).toHaveBeenCalledWith("wf_1")
    } finally {
      releaseLocalThreadRunLease(THREAD, "im", "im-run")
      vi.restoreAllMocks()
    }
  })

  it("does not summarise twice when two checks race one completion", async () => {
    const { scheduler, startRun } = createScheduler(persistedRun({ notificationOwner: "desktop" }))
    await Promise.all([scheduler.check(THREAD), scheduler.check(THREAD)])
    expect(startRun).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })
})
