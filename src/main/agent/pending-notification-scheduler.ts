import { randomUUID } from "node:crypto"
import { WORKFLOW_NOTIFICATION_TURN_PROMPT } from "../../shared/checkpoint-transcript"
import { COORDINATOR_NOTIFICATION_PROMPT } from "../../shared/internal-notification-turn"
import {
  isCoordinatorModeForcedForMetadata,
  isProjectModeAgentTeamEnabled
} from "../../shared/project-mode-agent-team"
import { getThread } from "../db"
import { isCoordinatorModeForcedByEnvironment } from "./coordinator-mode"
import { parseStandardThreadMetadata } from "./standard-thread-turn"
import { startAgentRun, type AgentRunDelivery, type AgentRunTerminal } from "./agent-run-service"
import { createManagedTransportAgentRunDelivery } from "./managed-transport-delivery"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  onLocalThreadRunLeaseReleased,
  releaseLocalThreadRunLease
} from "./thread-run-lease"
import { coordinatorWorkerManager } from "./coordinator-worker-manager"
import { workflowRunManager } from "./workflow/run-manager"

/**
 * The single place that decides whether a completed background task gets its
 * follow-up summary turn, and runs it.
 *
 * There used to be two. The renderer submitted one when it saw a completion,
 * and the IM pump submitted one for threads reachable from Zhaohu — each
 * consulting a different notion of "is this thread free". A run driven from
 * Zhaohu with the desktop watching satisfied both, so the same task was
 * summarised twice; the second submission then lost the run lease and surfaced
 * as an agent error on a conversation the user had only left open.
 *
 * Everything routes here now: a live completion, a reopened thread, and a
 * restart all ask this scheduler, and it answers from the task's own recorded
 * owner rather than from whatever the caller could see.
 *
 * The turn runs on the managed transport, so a desktop with the thread open
 * watches it live through the same mirror an IM-driven run uses. Nothing about
 * ordinary desktop input changes — this only owns the automatic follow-up.
 */

/** Matches the renderer hold this replaced, so Stop feels the same. */
const SUPPRESS_AFTER_STOP_MS = 15_000

/**
 * A summary that failed is retried, but not forever.
 *
 * The old renderer retried a busy thread on a 1s timer up to 30 times. That
 * budget belonged to polling; waiting on the lease needs none of it. What is
 * still needed is a bound on a summary that keeps *failing* — the notification
 * stays queued on purpose, so an unbounded wake loop would spin on it.
 */
const PROJECT_MODE_AGENT_TEAM_ENABLED = isProjectModeAgentTeamEnabled(
  import.meta.env?.VITE_PROJECT_MODE_AGENT_TEAM_ENABLED
)

const MAX_SUMMARY_ATTEMPTS = 3
const RETRY_AFTER_FAILURE_MS = 2_000

/** Terminal codes that mean a decision was made, not that something went wrong. */
const NON_RETRYABLE_TERMINAL_CODES = new Set(["hook_halt", "failure_fuse", "prompt_blocked"])

export type PendingNotificationSkipReason =
  | "no-pending-notification"
  | "thread-missing"
  | "not-a-background-mode"
  | "thread-busy"
  | "suppressed-after-stop"

export interface PendingNotificationOutcome {
  started: boolean
  reason?: PendingNotificationSkipReason
}

interface SchedulerDependencies {
  getThread: typeof getThread
  startRun: typeof startAgentRun
  getDelivery: () => AgentRunDelivery
  createRunId: () => string
  isCoordinatorModeForcedByEnvironment: () => boolean
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  log: (message: string, detail: Record<string, unknown>) => void
}

const defaultDependencies: SchedulerDependencies = {
  getThread,
  startRun: startAgentRun,
  getDelivery: createManagedTransportAgentRunDelivery,
  createRunId: () => randomUUID(),
  isCoordinatorModeForcedByEnvironment,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
  // Never the message body: these lines exist to explain a decision, and a
  // summary prompt carries whatever the task was working on.
  log: (message, detail) => console.log(`[PendingNotification] ${message}`, detail)
}

export class PendingNotificationScheduler {
  private readonly dependencies: SchedulerDependencies
  /** Threads with a check in flight, so concurrent asks collapse into one. */
  private readonly checking = new Set<string>()
  /**
   * Threads that asked again while a check was already running.
   *
   * Collapsing concurrent asks is right; dropping them is not. A check holds
   * this thread for the whole summary turn, and a second worker finishing
   * underneath it would otherwise wait for an event that has already passed.
   */
  private readonly recheckRequested = new Set<string>()
  /** Threads whose check was deferred until the current run releases the lease. */
  private readonly waitingForIdle = new Set<string>()
  /** Threads the user just stopped; see suppressAfterStop. */
  private readonly suppressedUntil = new Map<string, number>()
  /** Wake-ups for holds that expire on their own clock, not on a lease. */
  private readonly wakeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Consecutive failed summary attempts, per thread; see MAX_SUMMARY_ATTEMPTS. */
  private readonly failedAttempts = new Map<string, number>()
  private unsubscribeLeaseReleased: (() => void) | null = null

  constructor(overrides: Partial<SchedulerDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...overrides }
  }

  /**
   * Wakes deferred checks when a thread goes idle.
   *
   * A notification deferred for a busy thread has no timer of its own — it waits
   * for the lease that blocked it, which is the only event that can change the
   * answer. Polling would race the same way the two schedulers did.
   */
  start(): void {
    if (this.unsubscribeLeaseReleased) return
    this.unsubscribeLeaseReleased = onLocalThreadRunLeaseReleased((lease) => {
      if (!this.waitingForIdle.delete(lease.threadId)) return
      void this.check(lease.threadId)
    })
  }

  stop(): void {
    this.unsubscribeLeaseReleased?.()
    this.unsubscribeLeaseReleased = null
    for (const timer of this.wakeTimers.values()) this.dependencies.clearTimer(timer)
    this.wakeTimers.clear()
    this.waitingForIdle.clear()
    this.checking.clear()
    this.recheckRequested.clear()
    this.suppressedUntil.clear()
    this.failedAttempts.clear()
  }

  /**
   * Holds off the automatic summary after the user presses Stop.
   *
   * Stop has to actually stop. A coordinator whose workers already finished has
   * a notification waiting, and without this the summary turn starts again the
   * instant the cancelled run releases the thread — which reads as the stop
   * button not working. The hold expires rather than latching, so a result is
   * delayed, never dropped — which is only true because expiry wakes a check of
   * its own: the thread it is holding is idle, so no lease release is coming.
   */
  suppressAfterStop(threadId: string, suppressed = true): void {
    if (!suppressed) {
      // The user said something new, which is a clearer signal than the timer:
      // they are back, and whatever they stopped is no longer what they mean.
      const wasHeld = this.suppressedUntil.delete(threadId)
      this.cancelWake(threadId)
      // Lifting the hold early also cancels the wake that came with it, so the
      // held summary would have nothing left to bring it back. Checking now
      // finds the thread busy with whatever the user just sent and defers onto
      // that run's lease, which is the wake it should have been waiting for.
      if (wasHeld) this.requestCheck(threadId)
      return
    }
    this.suppressedUntil.set(threadId, Date.now() + SUPPRESS_AFTER_STOP_MS)
    this.scheduleWake(threadId, SUPPRESS_AFTER_STOP_MS)
  }

  /** Fire-and-forget entry for callers that cannot await (IPC, event handlers). */
  requestCheck(threadId: string): void {
    void this.check(threadId).catch((error) => {
      this.dependencies.log("check failed", {
        threadId,
        reason: error instanceof Error ? error.message : String(error)
      })
    })
  }

  /**
   * @param options.retry marks a wake this scheduler set for itself after a
   * failure. Anything else — an IPC request, a reopened thread, a lease going
   * idle — is a fresh reason to try, and clears the failure budget so a run of
   * bad luck cannot disable the summary for the life of the process.
   */
  async check(
    threadId: string,
    options: { retry?: boolean } = {}
  ): Promise<PendingNotificationOutcome> {
    if (!options.retry) this.failedAttempts.delete(threadId)
    if (this.checking.has(threadId)) {
      this.recheckRequested.add(threadId)
      return { started: false, reason: "thread-busy" }
    }
    this.checking.add(threadId)
    try {
      let outcome = await this.checkOnce(threadId)
      // Only after a turn actually ran. That is the one window with no other
      // wake coming: a second worker can finish while the first is being
      // summarised, and the lease release it would have waited for is this
      // scheduler's own. Every other outcome already has a wake — a lease
      // release, or the timer set with the hold or the failure.
      //
      // Bounded by external asks, not by what it finds: each pass consumes the
      // flag, and only another caller can set it again.
      while (outcome.started && this.recheckRequested.delete(threadId)) {
        outcome = await this.checkOnce(threadId)
      }
      return outcome
    } finally {
      this.checking.delete(threadId)
      this.recheckRequested.delete(threadId)
    }
  }

  /** A hold that ends on its own clock needs its own wake; a lease is not coming. */
  private scheduleWake(threadId: string, delayMs: number, options: { retry?: boolean } = {}): void {
    this.cancelWake(threadId)
    this.wakeTimers.set(
      threadId,
      this.dependencies.setTimer(() => {
        this.wakeTimers.delete(threadId)
        void this.check(threadId, options).catch((error) => {
          this.dependencies.log("check failed", {
            threadId,
            reason: error instanceof Error ? error.message : String(error)
          })
        })
      }, delayMs)
    )
  }

  private cancelWake(threadId: string): void {
    const timer = this.wakeTimers.get(threadId)
    if (timer === undefined) return
    this.dependencies.clearTimer(timer)
    this.wakeTimers.delete(threadId)
  }

  /**
   * Records a failed summary and says whether to try again.
   *
   * The turn's own failure handling already leaves the notification queued, so
   * the result is not lost either way; this only decides whether to reach for it
   * again now or leave it to the next hydrate.
   */
  private noteFailure(threadId: string, kind: "workflow" | "coordinator"): void {
    const attempts = (this.failedAttempts.get(threadId) ?? 0) + 1
    this.failedAttempts.set(threadId, attempts)
    if (attempts >= MAX_SUMMARY_ATTEMPTS) {
      this.dependencies.log("giving up on the summary turn for now", {
        threadId,
        kind,
        attempts,
        reason: "summary-attempts-exhausted"
      })
      return
    }
    this.scheduleWake(threadId, RETRY_AFTER_FAILURE_MS, { retry: true })
  }

  /**
   * Coordinator results record who owes their summary, per worker rather than
   * per run: a worker launched from Zhaohu is summarised by the transport that
   * launched it, and the mark is persisted so a restart reaches the same answer.
   *
   * There is nothing to claim — the manager holds the queue and drops each
   * notification when its turn acknowledges it — so the lease is what keeps two
   * turns from starting, exactly as it does for workflow.
   */
  private async checkCoordinator(threadId: string): Promise<PendingNotificationOutcome> {
    if (!coordinatorWorkerManager.hasAutoRunnableNotifications(threadId, { owner: "desktop" })) {
      // Either nothing is waiting, or what is waiting belongs to the transport
      // that launched it. Both mean this scheduler has nothing to do.
      return { started: false, reason: "no-pending-notification" }
    }

    const existingLease = getLocalThreadRunLease(threadId)
    if (existingLease) {
      this.waitingForIdle.add(threadId)
      this.dependencies.log("deferred until the thread is idle", {
        threadId,
        kind: "coordinator",
        blockedBy: existingLease.owner,
        reason: "thread-busy"
      })
      return { started: false, reason: "thread-busy" }
    }

    const notificationRunId = `pending-notification:${this.dependencies.createRunId()}`
    const claim = claimLocalThreadRunLease({
      threadId,
      owner: "desktop",
      runId: notificationRunId
    })
    if (!claim.acquired) {
      this.waitingForIdle.add(threadId)
      return { started: false, reason: "thread-busy" }
    }

    this.dependencies.log("running the summary turn", {
      threadId,
      kind: "coordinator",
      notificationRunId
    })
    try {
      const terminal = await this.runSummaryTurn(
        {
          threadId,
          message: COORDINATOR_NOTIFICATION_PROMPT,
          agentMode: "coordinator",
          coordinatorInternalNotification: true,
          userMessageId: `coordinator-notification:${notificationRunId}`
        },
        notificationRunId
      )
      // The manager only drops a notification when a turn acknowledges it, so a
      // failed summary leaves it queued and a bounded retry picks it up again.
      return this.settle(threadId, "coordinator", notificationRunId, terminal)
    } catch (error) {
      this.dependencies.log("summary turn could not start", {
        threadId,
        kind: "coordinator",
        notificationRunId,
        reason: error instanceof Error ? error.message : String(error)
      })
      this.noteFailure(threadId, "coordinator")
      return { started: false, reason: "thread-busy" }
    } finally {
      releaseLocalThreadRunLease(threadId, "desktop", notificationRunId)
    }
  }

  /** Turns a reported terminal into an outcome, and decides about a retry. */
  private settle(
    threadId: string,
    kind: "workflow" | "coordinator",
    notificationRunId: string,
    terminal: AgentRunTerminal
  ): PendingNotificationOutcome {
    if (terminal.outcome === "success") {
      this.failedAttempts.delete(threadId)
      return { started: true }
    }
    this.dependencies.log("summary turn did not deliver", {
      threadId,
      kind,
      notificationRunId,
      outcome: terminal.outcome,
      code: terminal.code,
      retryable: this.isRetryable(terminal)
    })
    if (this.isRetryable(terminal)) this.noteFailure(threadId, kind)
    else this.failedAttempts.delete(threadId)
    return { started: false, reason: "thread-busy" }
  }

  /**
   * Runs one summary turn and reports what actually happened to it.
   *
   * The run body reports failures to the renderer and then returns normally, so
   * its completion promise resolves either way. Reading only that counted a
   * provider error as a delivered summary — it cleared the failure budget and
   * scheduled nothing, which is the ordinary case this retry exists for. The
   * classification comes from onRunTerminated, which the body is contracted to
   * fire exactly once; `catch` still covers what genuinely throws, which is
   * setup and transport rather than the model.
   */
  private async runSummaryTurn(
    request: Parameters<typeof startAgentRun>[0],
    notificationRunId: string
  ): Promise<AgentRunTerminal> {
    let terminal: AgentRunTerminal | undefined
    const handle = await this.dependencies.startRun(request, this.dependencies.getDelivery(), {
      source: "desktop",
      // The lease is released here rather than by the run body, and the summary
      // is owed to the desktop rather than to a transport. Those are different
      // questions and this says both explicitly — inferring the second from the
      // first marked anything the turn launched as managed, leaving it to a
      // runner with no callback for it.
      localRunLease: {
        owner: "desktop",
        runId: notificationRunId,
        managedExternally: true
      },
      backgroundNotificationOwner: "desktop",
      onRunTerminated: (reported) => {
        terminal = reported
      }
    })
    await handle.completion
    // The body's own finally reports `unknown` for anything it did not
    // classify, so an absent terminal means the contract was not met at all.
    // Not treated as success: a summary that silently did nothing is exactly
    // what this was supposed to stop.
    return terminal ?? { outcome: "unknown", code: "unreported" }
  }

  /**
   * Whether a non-success terminal should be tried again.
   *
   * A halt is a decision, not a fault: a hook, the failure fuse or a blocked
   * prompt stopped this turn on purpose, and retrying fights that. A provider
   * error is the case this budget exists for. `unknown` covers an aborted run
   * too — retried, because the deliberate abort is the Stop button, and Stop
   * already holds the summary off through its own path.
   */
  private isRetryable(terminal: AgentRunTerminal): boolean {
    if (terminal.outcome === "success") return false
    return !NON_RETRYABLE_TERMINAL_CODES.has(terminal.code)
  }

  /**
   * Whether an automatic summary is even a thing on this thread.
   *
   * Reads the mode the run body would resolve, not just the persisted one: the
   * environment can force coordinator on a thread whose metadata still says
   * normal, and treating that as "not a background mode" silently drops every
   * summary on it.
   */
  private isCoordinatorThread(metadata: Record<string, unknown>): boolean {
    if (metadata.agentMode === "coordinator") return true
    if (!this.dependencies.isCoordinatorModeForcedByEnvironment()) return false
    return isCoordinatorModeForcedForMetadata(metadata, PROJECT_MODE_AGENT_TEAM_ENABLED, true)
  }

  private async checkOnce(threadId: string): Promise<PendingNotificationOutcome> {
    const suppressedUntil = this.suppressedUntil.get(threadId)
    if (suppressedUntil !== undefined) {
      if (suppressedUntil > Date.now()) {
        // Waits on the timer set with the hold, not on a lease: the thread this
        // is holding is idle by definition, so no release is coming.
        return { started: false, reason: "suppressed-after-stop" }
      }
      this.suppressedUntil.delete(threadId)
    }
    const thread = this.dependencies.getThread(threadId)
    if (!thread) return { started: false, reason: "thread-missing" }
    const metadata = parseStandardThreadMetadata(thread.metadata)
    const workspacePath = metadata.workspacePath
    if (this.isCoordinatorThread(metadata.metadata)) {
      return await this.checkCoordinator(threadId)
    }
    if (metadata.agentMode !== "workflow" || !workspacePath) {
      return { started: false, reason: "not-a-background-mode" }
    }

    // Peeked, not claimed. The run body claims exactly one notification and owns
    // its release on every settle path; claiming here as well meant the body
    // found the run already in flight, treated it as a stale trigger and ended
    // without summarising, leaving the mark set for the life of the process.
    const run = await workflowRunManager.findPendingNotificationAsync(workspacePath, threadId, {
      owner: "desktop"
    })
    if (!run) {
      // Either nothing is waiting or what is waiting belongs to the transport
      // that started it. Filtered in the lookup rather than checked afterwards:
      // the scan is newest-first, so a managed run standing in front of an older
      // desktop one used to hide it for good.
      return { started: false, reason: "no-pending-notification" }
    }

    const existingLease = getLocalThreadRunLease(threadId)
    if (existingLease) {
      // Yield, never preempt. The notification keeps its undelivered mark, so
      // going idle brings it straight back.
      this.waitingForIdle.add(threadId)
      this.dependencies.log("deferred until the thread is idle", {
        threadId,
        runId: run.runId,
        blockedBy: existingLease.owner,
        reason: "thread-busy"
      })
      return { started: false, reason: "thread-busy" }
    }

    const notificationRunId = `pending-notification:${this.dependencies.createRunId()}`
    const claim = claimLocalThreadRunLease({
      threadId,
      owner: "desktop",
      runId: notificationRunId
    })
    if (!claim.acquired) {
      this.waitingForIdle.add(threadId)
      return { started: false, reason: "thread-busy" }
    }

    this.dependencies.log("running the summary turn", {
      threadId,
      runId: run.runId,
      notificationRunId
    })
    try {
      const terminal = await this.runSummaryTurn(
        {
          threadId,
          message: WORKFLOW_NOTIFICATION_TURN_PROMPT,
          agentMode: "workflow",
          userMessageId: `workflow-notification:${notificationRunId}`
        },
        notificationRunId
      )
      // A failed summary must not count as delivered. The run body releases its
      // own claim on every settle path, so the notification is eligible again;
      // this only decides whether to reach for it now.
      return this.settle(threadId, "workflow", notificationRunId, terminal)
    } catch (error) {
      this.dependencies.log("summary turn could not start", {
        threadId,
        runId: run.runId,
        notificationRunId,
        reason: error instanceof Error ? error.message : String(error)
      })
      this.noteFailure(threadId, "workflow")
      return { started: false, reason: "thread-busy" }
    } finally {
      releaseLocalThreadRunLease(threadId, "desktop", notificationRunId)
    }
  }
}

export const pendingNotificationScheduler = new PendingNotificationScheduler()
