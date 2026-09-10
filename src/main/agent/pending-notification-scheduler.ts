import { randomUUID } from "node:crypto"
import { WORKFLOW_NOTIFICATION_TURN_PROMPT } from "../../shared/checkpoint-transcript"
import { COORDINATOR_NOTIFICATION_PROMPT } from "../../shared/internal-notification-turn"
import { getThread } from "../db"
import { parseStandardThreadMetadata } from "./standard-thread-turn"
import { startAgentRun, type AgentRunDelivery } from "./agent-run-service"
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
 * restart all ask this scheduler, and it answers from the run's own recorded
 * owner rather than from whatever the caller could see.
 *
 * The turn runs on the managed transport, so a desktop with the thread open
 * watches it live through the same mirror an IM-driven run uses. Nothing about
 * ordinary desktop input changes — this only owns the automatic follow-up.
 */

/** Matches the renderer hold this replaced, so Stop feels the same. */
const SUPPRESS_AFTER_STOP_MS = 15_000

export type PendingNotificationSkipReason =
  | "no-pending-notification"
  | "owned-by-managed-runner"
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
  log: (message: string, detail: Record<string, unknown>) => void
}

const defaultDependencies: SchedulerDependencies = {
  getThread,
  startRun: startAgentRun,
  getDelivery: createManagedTransportAgentRunDelivery,
  createRunId: () => randomUUID(),
  // Never the message body: these lines exist to explain a decision, and a
  // summary prompt carries whatever the task was working on.
  log: (message, detail) => console.log(`[PendingNotification] ${message}`, detail)
}

export class PendingNotificationScheduler {
  private readonly dependencies: SchedulerDependencies
  /** Threads with a check in flight, so concurrent asks collapse into one. */
  private readonly checking = new Set<string>()
  /** Threads whose check was deferred until the current run releases the lease. */
  private readonly waitingForIdle = new Set<string>()
  /** Threads the user just stopped; see suppressAfterStop. */
  private readonly suppressedUntil = new Map<string, number>()
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
    this.waitingForIdle.clear()
    this.checking.clear()
    this.suppressedUntil.clear()
  }

  /**
   * Holds off the automatic summary after the user presses Stop.
   *
   * Stop has to actually stop. A coordinator whose workers already finished has
   * a notification waiting, and without this the summary turn starts again the
   * instant the cancelled run releases the thread — which reads as the stop
   * button not working. The hold expires rather than latching, so a result is
   * delayed, never dropped.
   */
  suppressAfterStop(threadId: string, suppressed = true): void {
    if (!suppressed) {
      // The user said something new, which is a clearer signal than the timer:
      // they are back, and whatever they stopped is no longer what they mean.
      this.suppressedUntil.delete(threadId)
      return
    }
    this.suppressedUntil.set(threadId, Date.now() + SUPPRESS_AFTER_STOP_MS)
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

  async check(threadId: string): Promise<PendingNotificationOutcome> {
    if (this.checking.has(threadId)) return { started: false, reason: "thread-busy" }
    this.checking.add(threadId)
    try {
      return await this.checkOnce(threadId)
    } finally {
      this.checking.delete(threadId)
    }
  }

  /**
   * Coordinator results carry their own ownership signal, per worker rather
   * than per run: a managed runner that takes a worker's result marks it
   * suppressed, and that mark is persisted, so a restart reaches the same
   * answer. Reused here instead of adding a second notion of ownership.
   *
   * There is nothing to claim — the manager holds the queue and drops each
   * notification when its turn acknowledges it — so the lease is what keeps two
   * turns from starting, exactly as it does for workflow.
   */
  private async checkCoordinator(threadId: string): Promise<PendingNotificationOutcome> {
    if (!coordinatorWorkerManager.hasAutoRunnableNotifications(threadId)) {
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
      const handle = await this.dependencies.startRun(
        {
          threadId,
          message: COORDINATOR_NOTIFICATION_PROMPT,
          agentMode: "coordinator",
          coordinatorInternalNotification: true,
          userMessageId: `coordinator-notification:${notificationRunId}`
        },
        this.dependencies.getDelivery(),
        {
          source: "desktop",
          localRunLease: {
            owner: "desktop",
            runId: notificationRunId,
            managedExternally: true
          }
        }
      )
      await handle.completion
      return { started: true }
    } catch (error) {
      // The manager only drops a notification when a turn acknowledges it, so a
      // failure leaves it queued and the next idle wake picks it up again.
      this.dependencies.log("summary turn failed", {
        threadId,
        kind: "coordinator",
        notificationRunId,
        reason: error instanceof Error ? error.message : String(error)
      })
      return { started: false, reason: "thread-busy" }
    } finally {
      releaseLocalThreadRunLease(threadId, "desktop", notificationRunId)
    }
  }

  private async checkOnce(threadId: string): Promise<PendingNotificationOutcome> {
    const suppressedUntil = this.suppressedUntil.get(threadId)
    if (suppressedUntil !== undefined) {
      if (suppressedUntil > Date.now()) {
        this.waitingForIdle.add(threadId)
        return { started: false, reason: "suppressed-after-stop" }
      }
      this.suppressedUntil.delete(threadId)
    }
    const thread = this.dependencies.getThread(threadId)
    if (!thread) return { started: false, reason: "thread-missing" }
    const metadata = parseStandardThreadMetadata(thread.metadata)
    const workspacePath = metadata.workspacePath
    if (metadata.agentMode === "coordinator") return await this.checkCoordinator(threadId)
    if (metadata.agentMode !== "workflow" || !workspacePath) {
      return { started: false, reason: "not-a-background-mode" }
    }

    // Claimed before anything else can look at it: the claim is what stops a
    // second checker picking up the same run, and it is released again on every
    // path that does not go on to run the turn.
    const run = await workflowRunManager.claimPendingNotificationAsync(workspacePath, threadId)
    if (!run) return { started: false, reason: "no-pending-notification" }

    const owner = run.notificationOwner ?? "desktop"
    if (owner === "managed") {
      workflowRunManager.clearNotificationInFlight(run.runId)
      this.dependencies.log("left to the managed runner", {
        threadId,
        runId: run.runId,
        owner,
        reason: "owned-by-managed-runner"
      })
      return { started: false, reason: "owned-by-managed-runner" }
    }

    const existingLease = getLocalThreadRunLease(threadId)
    if (existingLease) {
      // Yield, never preempt. The notification keeps its undelivered mark, so
      // going idle brings it straight back.
      workflowRunManager.clearNotificationInFlight(run.runId)
      this.waitingForIdle.add(threadId)
      this.dependencies.log("deferred until the thread is idle", {
        threadId,
        runId: run.runId,
        owner,
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
      workflowRunManager.clearNotificationInFlight(run.runId)
      this.waitingForIdle.add(threadId)
      return { started: false, reason: "thread-busy" }
    }

    this.dependencies.log("running the summary turn", {
      threadId,
      runId: run.runId,
      owner,
      notificationRunId
    })
    try {
      const handle = await this.dependencies.startRun(
        {
          threadId,
          message: WORKFLOW_NOTIFICATION_TURN_PROMPT,
          agentMode: "workflow",
          userMessageId: `workflow-notification:${notificationRunId}`
        },
        this.dependencies.getDelivery(),
        {
          source: "desktop",
          // Released here, not by the run body: the in-flight mark has to
          // outlive the run so a failure frees it for a retry instead of
          // leaving the notification claimed by a run that is already gone.
          localRunLease: {
            owner: "desktop",
            runId: notificationRunId,
            managedExternally: true
          }
        }
      )
      await handle.completion
      return { started: true }
    } catch (error) {
      // A failed summary must not count as delivered. The persisted
      // notificationDelivered flag is only written by a turn that succeeded, so
      // clearing the in-flight mark is enough to make it eligible again.
      this.dependencies.log("summary turn failed", {
        threadId,
        runId: run.runId,
        notificationRunId,
        reason: error instanceof Error ? error.message : String(error)
      })
      workflowRunManager.clearNotificationInFlight(run.runId)
      return { started: false, reason: "thread-busy" }
    } finally {
      releaseLocalThreadRunLease(threadId, "desktop", notificationRunId)
    }
  }
}

export const pendingNotificationScheduler = new PendingNotificationScheduler()
