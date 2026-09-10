import { afterEach, describe, expect, it, vi } from "vitest"
import { PendingNotificationScheduler } from "./pending-notification-scheduler"
import { coordinatorWorkerManager } from "./coordinator-worker-manager"
import { workflowRunManager } from "./workflow/run-manager"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"
import type { AgentRunExecutionContext, AgentRunTerminal } from "./agent-run-service"
import type { PersistedWorkflowRun } from "./workflow/types"

/**
 * The regression these cover is a combination, not a single side: the desktop
 * and the Zhaohu runner each behaved correctly alone, and the existing
 * notification tests exercise them that way. Summarising twice only appears
 * when both observe the same completion, which is the ordinary case whenever
 * somebody has the thread open while a remote run finishes.
 *
 * The fake run body below matters as much as any assertion. A `startRun` stub
 * that only resolves cannot see the run body claim the notification, and it
 * cannot report a failure the way the real body does — it sends the error to
 * the renderer and returns normally. Both blind spots hid a real defect.
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

/**
 * Stands in for the pending set the real manager keeps on disk: runs are
 * discoverable newest-first until somebody claims one, the lookup honours the
 * owner filter, and a delivered turn removes it. The scheduler and the run body
 * both go through this, so a claim taken twice is visible here the way it is in
 * production.
 */
function pendingRuns(...runs: PersistedWorkflowRun[]) {
  const queue = [...runs]
  const inFlight = new Set<string>()
  const delivered = new Set<string>()
  const next = (owner?: "desktop" | "managed"): PersistedWorkflowRun | null =>
    queue.find(
      (run) =>
        !inFlight.has(run.runId) &&
        !delivered.has(run.runId) &&
        (owner === undefined || (run.notificationOwner ?? "desktop") === owner)
    ) ?? null

  vi.spyOn(workflowRunManager, "findPendingNotification").mockImplementation(() => next())
  vi.spyOn(workflowRunManager, "findPendingNotificationAsync").mockImplementation(
    async (_workspacePath, _threadId, options) => next(options?.owner)
  )
  vi.spyOn(workflowRunManager, "claimPendingNotificationAsync").mockImplementation(
    async (_workspacePath, _threadId, options) => {
      const run = next(options?.owner)
      if (run) inFlight.add(run.runId)
      return run
    }
  )
  vi.spyOn(workflowRunManager, "clearNotificationInFlight").mockImplementation((runId) => {
    inFlight.delete(runId)
  })
  return {
    /**
     * What the run body does: claim one of its own, report it, mark it
     * delivered. Owner-scoped like the real one — claiming whatever was newest
     * let a desktop summary report a run owed to Zhaohu.
     */
    deliverOne: async (
      owner: "desktop" | "managed" = "desktop"
    ): Promise<PersistedWorkflowRun | null> => {
      const claimed = await workflowRunManager.claimPendingNotificationAsync(WORKSPACE, THREAD, {
        owner
      })
      if (claimed) {
        delivered.add(claimed.runId)
        workflowRunManager.clearNotificationInFlight(claimed.runId)
      }
      return claimed
    }
  }
}

interface Harness {
  scheduler: PendingNotificationScheduler
  startRun: ReturnType<typeof vi.fn>
  timers: { run: () => void; pending: () => number; delays: () => number[] }
}

function createHarness(options: {
  agentMode: string
  runBody?: () => Promise<void>
  environmentForcesCoordinator?: boolean
  /**
   * What the run body reports through onRunTerminated. Defaults to an ordinary
   * success; the interesting cases resolve normally while reporting a failure,
   * because that is exactly what the real body does with a model error.
   */
  terminal?: AgentRunTerminal
  /** The run was aborted. The body reports this separately from its terminal. */
  cancelled?: boolean
}): Harness {
  const runBody = options.runBody ?? (async () => undefined)
  const startRun = vi.fn(
    async (_request: unknown, _delivery: unknown, context: AgentRunExecutionContext) => {
      await runBody()
      if (options.cancelled) context.onRunCancelled?.()
      context.onRunTerminated?.(options.terminal ?? { outcome: "success", code: "normal" })
      return { completion: Promise.resolve() } as never
    }
  )
  // Honours clearTimer, so "one wake per thread" is observable here. A fake that
  // only ever appends made a replaced wake look like an extra pending one.
  const queued = new Map<number, { callback: () => void; delayMs: number }>()
  let nextTimerId = 1
  const scheduler = new PendingNotificationScheduler({
    getThread: (() =>
      ({
        thread_id: THREAD,
        metadata: JSON.stringify({ workspacePath: WORKSPACE, agentMode: options.agentMode })
      }) as never) as never,
    startRun: startRun as never,
    getDelivery: (() => ({}) as never) as never,
    createRunId: () => "fixed",
    isCoordinatorModeForcedByEnvironment: () => options.environmentForcesCoordinator === true,
    setTimer: ((callback: () => void, delayMs: number) => {
      const id = nextTimerId++
      queued.set(id, { callback, delayMs })
      return id as never
    }) as never,
    clearTimer: ((id: number) => {
      queued.delete(id)
    }) as never,
    log: () => undefined
  })
  return {
    scheduler,
    startRun,
    timers: {
      run: () => {
        const due = [...queued.values()]
        queued.clear()
        for (const timer of due) timer.callback()
      },
      pending: () => queued.size,
      delays: () => [...queued.values()].map((timer) => timer.delayMs)
    }
  }
}

/** The run context the scheduler hands the run body, from the last start. */
function lastContext(startRun: ReturnType<typeof vi.fn>): AgentRunExecutionContext {
  return startRun.mock.calls[startRun.mock.calls.length - 1]?.[2] as AgentRunExecutionContext
}

function coordinatorOwnedBy(owner: "desktop" | "managed"): void {
  vi.spyOn(coordinatorWorkerManager, "hasAutoRunnableNotifications").mockImplementation(
    (_threadId, queryOptions) => (queryOptions?.owner ?? owner) === owner
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("pending notification scheduler", () => {
  it("leaves the notification for the run body to claim", async () => {
    const runs = pendingRuns(persistedRun({ notificationOwner: "desktop" }))
    let claimedByBody: PersistedWorkflowRun | null | undefined
    const { scheduler, startRun } = createHarness({
      agentMode: "workflow",
      runBody: async () => {
        claimedByBody = await runs.deliverOne()
      }
    })

    const outcome = await scheduler.check(THREAD)

    expect(outcome).toEqual({ started: true })
    expect(startRun).toHaveBeenCalledTimes(1)
    // The whole point: claiming here as well left the body with nothing to
    // report, so the turn ended as a stale trigger and the run stayed in flight
    // for the life of the process — no summary, and no way back to it.
    expect(claimedByBody?.runId).toBe("wf_1")
  })

  it("leaves a Zhaohu-owned summary to the runner that started it", async () => {
    const runs = pendingRuns(persistedRun({ notificationOwner: "managed" }))
    const { scheduler, startRun } = createHarness({ agentMode: "workflow" })

    const outcome = await scheduler.check(THREAD)

    expect(outcome).toEqual({ started: false, reason: "no-pending-notification" })
    expect(startRun).not.toHaveBeenCalled()
    // Left claimable, or the managed runner has nothing to pick up either.
    expect(await runs.deliverOne("managed")).not.toBeNull()
  })

  it("still finds an older desktop run standing behind a managed one", async () => {
    // The scan is newest-first. Reading the newest and deciding from it meant a
    // run owed to Zhaohu stood in front of the desktop's own and hid it for good.
    const runs = pendingRuns(
      persistedRun({ runId: "wf_new", notificationOwner: "managed" }),
      persistedRun({ runId: "wf_old", notificationOwner: "desktop" })
    )
    let claimedByBody: PersistedWorkflowRun | null | undefined
    const { scheduler, startRun } = createHarness({
      agentMode: "workflow",
      runBody: async () => {
        claimedByBody = await runs.deliverOne()
      }
    })

    expect(await scheduler.check(THREAD)).toEqual({ started: true })
    expect(startRun).toHaveBeenCalledTimes(1)
    expect(claimedByBody?.runId).toBe("wf_old")
  })

  it("treats a run recorded before ownership existed as the desktop's", async () => {
    pendingRuns(persistedRun())
    const { scheduler, startRun } = createHarness({ agentMode: "workflow" })
    await scheduler.check(THREAD)
    expect(startRun).toHaveBeenCalledTimes(1)
  })

  it("yields to a turn already holding the thread instead of preempting it", async () => {
    const runs = pendingRuns(persistedRun({ notificationOwner: "desktop" }))
    const { scheduler, startRun } = createHarness({ agentMode: "workflow" })
    const claim = claimLocalThreadRunLease({ threadId: THREAD, owner: "im", runId: "im-run" })
    expect(claim.acquired).toBe(true)
    try {
      const outcome = await scheduler.check(THREAD)
      expect(outcome).toEqual({ started: false, reason: "thread-busy" })
      expect(startRun).not.toHaveBeenCalled()
      expect(await runs.deliverOne()).not.toBeNull()
    } finally {
      releaseLocalThreadRunLease(THREAD, "im", "im-run")
    }
  })

  it("does not summarise twice when two checks race one completion", async () => {
    const runs = pendingRuns(persistedRun({ notificationOwner: "desktop" }))
    const { scheduler, startRun } = createHarness({
      agentMode: "workflow",
      runBody: async () => {
        await runs.deliverOne()
      }
    })
    await Promise.all([scheduler.check(THREAD), scheduler.check(THREAD)])
    expect(startRun).toHaveBeenCalledTimes(1)
  })

  it("summarises a result that arrives while it is summarising the previous one", async () => {
    const runs = pendingRuns(
      persistedRun({ runId: "wf_1", notificationOwner: "desktop" }),
      persistedRun({ runId: "wf_2", notificationOwner: "desktop" })
    )
    let asked = false
    const harness = createHarness({
      agentMode: "workflow",
      runBody: async () => {
        await runs.deliverOne()
        if (asked) return
        asked = true
        // The second completion lands mid-turn. Its only wake would have been
        // the lease going idle — and the lease it is waiting on is this
        // scheduler's own, so without a recorded re-check it waits forever.
        await harness.scheduler.check(THREAD)
      }
    })

    await harness.scheduler.check(THREAD)

    expect(harness.startRun).toHaveBeenCalledTimes(2)
  })

  it("runs its own summary as the desktop even though it releases its own lease", async () => {
    pendingRuns(persistedRun({ notificationOwner: "desktop" }))
    const { scheduler, startRun } = createHarness({ agentMode: "workflow" })
    await scheduler.check(THREAD)

    const context = lastContext(startRun)
    // Two different questions. The lease is managed here because this scheduler
    // releases it itself; anything the turn launches is still owed to the
    // desktop, and inferring the second from the first handed it to a runner
    // with no callback for it.
    expect(context.localRunLease?.managedExternally).toBe(true)
    expect(context.backgroundNotificationOwner).toBe("desktop")
  })

  it("leaves a coordinator result to the transport that launched the worker", async () => {
    coordinatorOwnedBy("managed")
    const { scheduler, startRun } = createHarness({ agentMode: "coordinator" })
    const outcome = await scheduler.check(THREAD)
    expect(outcome).toEqual({ started: false, reason: "no-pending-notification" })
    expect(startRun).not.toHaveBeenCalled()
  })

  it("runs a coordinator summary the desktop still owns", async () => {
    coordinatorOwnedBy("desktop")
    const { scheduler, startRun } = createHarness({ agentMode: "coordinator" })
    await scheduler.check(THREAD)
    expect(startRun).toHaveBeenCalledTimes(1)
  })

  it("summarises a thread the environment forces into coordinator mode", async () => {
    coordinatorOwnedBy("desktop")
    // Persisted metadata still says normal; the run body would resolve
    // coordinator anyway. Reading only the metadata dropped every summary on
    // these threads without a trace.
    const { scheduler, startRun } = createHarness({
      agentMode: "normal",
      environmentForcesCoordinator: true
    })
    await scheduler.check(THREAD)
    expect(startRun).toHaveBeenCalledTimes(1)
  })

  it("holds the summary after a stop, and lets a new user message release it", async () => {
    coordinatorOwnedBy("desktop")
    const { scheduler, startRun } = createHarness({ agentMode: "coordinator" })
    scheduler.suppressAfterStop(THREAD)
    expect(await scheduler.check(THREAD)).toEqual({
      started: false,
      reason: "suppressed-after-stop"
    })
    expect(startRun).not.toHaveBeenCalled()

    scheduler.suppressAfterStop(THREAD, false)
    await scheduler.check(THREAD)
    expect(startRun).toHaveBeenCalledTimes(1)
  })

  it("does not strand the summary when a new message lifts the hold early", async () => {
    coordinatorOwnedBy("desktop")
    const { scheduler, startRun } = createHarness({ agentMode: "coordinator" })
    scheduler.suppressAfterStop(THREAD)
    await scheduler.check(THREAD)
    expect(startRun).not.toHaveBeenCalled()

    // Lifting the hold cancels the wake that came with it. Nothing else was
    // going to bring the held summary back, so this has to.
    scheduler.suppressAfterStop(THREAD, false)
    await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(1))
  })

  it("summarises a finished workflow with no window open to relay it", async () => {
    const runs = pendingRuns(persistedRun({ notificationOwner: "desktop" }))
    const { scheduler, startRun } = createHarness({
      agentMode: "workflow",
      runBody: async () => {
        await runs.deliverOne()
      }
    })
    scheduler.start()
    try {
      // The run manager broadcasts this to renderers, and the page used to be
      // what acted on it. It no longer decides, and a broadcast to no open
      // window reaches nobody — so a run that finished with the app closed to
      // the tray waited for the next hydrate instead of being reported. There
      // is no window here either, which is the point.
      workflowRunManager.kickNextPendingNotification(WORKSPACE, THREAD)
      await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(1))
    } finally {
      scheduler.stop()
    }

    // And the subscription is given back, or a stopped scheduler keeps working.
    workflowRunManager.kickNextPendingNotification(WORKSPACE, THREAD)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(startRun).toHaveBeenCalledTimes(1)
  })

  it("wakes itself when a stop hold expires, since no lease is coming", async () => {
    coordinatorOwnedBy("desktop")
    const { scheduler, startRun, timers } = createHarness({ agentMode: "coordinator" })
    scheduler.suppressAfterStop(THREAD)
    await scheduler.check(THREAD)
    expect(startRun).not.toHaveBeenCalled()

    // The thread this is holding is idle by definition, so the lease release
    // every other deferral waits on will never fire. Expiry has to wake itself
    // or the result is not delayed, it is dropped.
    expect(timers.pending()).toBe(1)
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000)
    timers.run()
    await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(1))
  })

  it("retries a model failure the run body reported and then swallowed", async () => {
    coordinatorOwnedBy("desktop")
    // The body sends the error to the renderer and returns normally, so the
    // completion promise resolves. Reading only that counted this as a
    // delivered summary: the failure budget was cleared and nothing retried.
    const { scheduler, startRun, timers } = createHarness({
      agentMode: "coordinator",
      terminal: { outcome: "error", code: "provider_error", message: "upstream unavailable" }
    })

    expect((await scheduler.check(THREAD)).started).toBe(false)
    expect(startRun).toHaveBeenCalledTimes(1)
    expect(timers.pending()).toBe(1)
  })

  it("does not retry a summary that was aborted", async () => {
    coordinatorOwnedBy("desktop")
    // An abort does not classify itself, so it reaches the terminal contract as
    // plain `unknown` — indistinguishable from a run that ended without saying
    // why, and retried two seconds later against a thread somebody had just
    // pressed Stop on.
    const { scheduler, startRun, timers } = createHarness({
      agentMode: "coordinator",
      cancelled: true,
      terminal: { outcome: "unknown", code: "unknown" }
    })

    expect((await scheduler.check(THREAD)).started).toBe(false)
    expect(startRun).toHaveBeenCalledTimes(1)
    expect(timers.pending()).toBe(0)
  })

  it("never wakes a retry inside the hold a stop just set", async () => {
    coordinatorOwnedBy("desktop")
    // A genuine failure landing at the same moment as a stop. There is one wake
    // per thread, so a two-second retry replaced the fifteen-second hold, found
    // itself still suppressed, and scheduled nothing — the hold then expired
    // with nothing left to notice it and the summary was dropped, not delayed.
    const { scheduler, timers } = createHarness({
      agentMode: "coordinator",
      terminal: { outcome: "error", code: "provider_error" }
    })

    const started = scheduler.check(THREAD)
    scheduler.suppressAfterStop(THREAD)
    await started

    expect(timers.pending()).toBe(1)
    expect(timers.delays()[0]).toBeGreaterThan(14_000)
  })

  it("does not retry a summary a hook deliberately halted", async () => {
    coordinatorOwnedBy("desktop")
    const { scheduler, startRun, timers } = createHarness({
      agentMode: "coordinator",
      terminal: { outcome: "error", code: "hook_halt", message: "Stop hook halted the turn" }
    })

    expect((await scheduler.check(THREAD)).started).toBe(false)
    expect(startRun).toHaveBeenCalledTimes(1)
    // A halt is a decision, not a fault. Retrying it fights whoever made it.
    expect(timers.pending()).toBe(0)
  })

  it("stops retrying a summary that keeps failing, and tries again when asked afresh", async () => {
    coordinatorOwnedBy("desktop")
    const { scheduler, startRun, timers } = createHarness({
      agentMode: "coordinator",
      terminal: { outcome: "error", code: "provider_error" }
    })

    await scheduler.check(THREAD)
    expect(startRun).toHaveBeenCalledTimes(1)
    expect(timers.pending()).toBe(1)

    timers.run()
    await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(timers.pending()).toBe(1))

    timers.run()
    await vi.waitFor(() => expect(startRun).toHaveBeenCalledTimes(3))
    // Bounded: the notification stays queued either way, so an unbounded wake
    // loop would only spin on it.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(timers.pending()).toBe(0)
    expect(startRun).toHaveBeenCalledTimes(3)

    // A fresh reason to try is not part of that budget.
    await scheduler.check(THREAD)
    expect(startRun).toHaveBeenCalledTimes(4)
  })
})
