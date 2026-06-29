import { BrowserWindow } from "electron"
import { mkdirSync, realpathSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import { runWorkflowEngine, toJsonSafe } from "./engine"
import { isPathInside } from "./paths"
import {
  createWorkflowRunStore,
  findUndeliveredTerminalRun,
  getWorkflowRunsDir,
  markWorkflowRunNotified,
  persistRecoveredRun,
  pruneWorkflowRuns
} from "./run-store"
import { runWorkflowSubagent, type WorkflowSubagentDeps } from "./subagent"
import {
  type ParsedWorkflowScript,
  type PersistedWorkflowRun,
  type WorkflowProgressEvent
} from "./types"
import { emitAppAttention } from "../../app-attention-events"

/**
 * Background workflow run manager — the Claude Code execution model: the
 * `workflow` tool returns immediately with a run id, the run continues
 * detached from the agent turn, live progress streams to the renderer on a
 * DURABLE per-thread channel (it outlives the turn), and on completion a
 * `<task-notification>` is folded back into the conversation so the model can
 * report the outcome (mirrors how coordinator async workers notify).
 *
 * One active run per thread (the workflow tool is exclusive per thread, and a
 * second concurrent run over the same workspace would fight the first).
 */

export const WORKFLOW_EVENTS_CHANNEL_PREFIX = "agent:workflow-events:"

export interface WorkflowLaunchRequest {
  threadId: string
  workspacePath: string
  runId: string
  parsed: ParsedWorkflowScript
  script: string
  scriptSha256: string
  args?: unknown
  tokenBudget?: number | null
  resumeJournal?: PersistedWorkflowRun["journal"]
  resumeNote?: string
  subagentDeps: WorkflowSubagentDeps
  /** Run-level exclusive file-write lock, shared with subagent tool writes (see
   * WorkflowEngineOptions.runExclusiveFileWrite). Threaded straight to the engine. (#2) */
  runExclusiveFileWrite?: <T>(fn: () => Promise<T>) => Promise<T>
}

export interface WorkflowLaunchResult {
  runId: string
  scriptFilePath: string
  /** Resolves once the run's initial snapshot is durably on disk. Await before
   * reporting "launched" so a reload right after the tool returns can't miss the
   * run (the eager initial persist is otherwise fire-and-forget). */
  whenInitialPersisted: Promise<boolean>
}

interface ActiveWorkflowRun {
  threadId: string
  workspacePath: string
  runId: string
  workflowName: string
  controller: AbortController
  userCancelled: boolean
  settled: Promise<void>
}

/** Renderer-facing envelope on the durable channel. */
export interface WorkflowChannelPayload {
  type: "workflow_progress" | "workflow_notification"
  workflowEvent?: WorkflowProgressEvent
  runId?: string
}

function broadcast(threadId: string, payload: WorkflowChannelPayload): void {
  const channel = `${WORKFLOW_EVENTS_CHANNEL_PREFIX}${threadId}`
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    } catch (error) {
      console.warn("[Workflow] Broadcast failed:", error)
    }
  }
}

/** Max automatic re-reports of one run after a failed notification turn (E). */
const MAX_RENOTIFY_ATTEMPTS = 3
/** SOFT cap on in-memory flush-failed run snapshots (each holds a full journal under
 * a persistent disk fault). Best-effort, NOT a hard bound: only already-delivered,
 * not-in-flight snapshots are evicted, so the map CAN still exceed this when every
 * snapshot is unreported — we never drop a real completed/error result just to
 * enforce the cap. */
const MAX_FLUSH_FAILED_RUNS = 8

/**
 * Canonical key for workspace mutual exclusion. Two threads can name one directory
 * via a symlink, a macOS case-variant, or a trailing slash — a raw string compare
 * misses all three and lets a second run slip past the lock. realpathSync resolves
 * them; if the path can't be resolved (shouldn't happen for a live workspace) we
 * fall back to a lexical resolve so the check degrades safely rather than throwing.
 */
function workspaceKey(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

class WorkflowRunManager {
  private readonly active = new Map<string, ActiveWorkflowRun>()
  /** Per-run count of auto re-reports after a failed notification turn (E). */
  private readonly renotifyAttempts = new Map<string, number>()
  /**
   * runIds whose completion notification turn is in flight THIS process. Kept in
   * memory and NEVER persisted: the durable `delivered` flag is only set on a
   * turn's SUCCESS (markNotified), so a crash mid-turn leaves delivered=false on
   * disk and the run is rediscovered + re-reported on the next hydrate
   * (at-least-once) — mirroring coordinator's in-memory drain + persist-on-ack.
   * This set only stops a second turn from racing the same run in-process; it is
   * empty after a restart, which is exactly what allows the crash re-report.
   */
  private readonly inFlightNotifications = new Set<string>()
  /**
   * Completed runs whose FINAL persist failed (disk full / permissions): an
   * in-memory snapshot of the true terminal state, so the completion notification
   * reports the real result instead of the stale on-disk copy (which may still say
   * "running" and be invisible to findUndeliveredTerminalRun). Cleared once the run
   * is acked. In-memory ONLY: a restart loses it, which is acceptable — at that
   * point the disk is still stale (disk full) and there's nothing better to report.
   */
  private readonly flushFailedRuns = new Map<string, PersistedWorkflowRun>()

  isActive(threadId: string): boolean {
    return this.active.has(threadId)
  }

  activeRunId(threadId: string): string | undefined {
    return this.active.get(threadId)?.runId
  }

  /**
   * A run active over the same workspace on ANY thread. Two workflows over one
   * workspace would race on file writes (the script's host writeFile + every
   * subagent's edit_file land in the same tree, serialized only WITHIN a run), so
   * the second launch must be refused. Compared by CANONICAL path (workspaceKey),
   * NOT raw string: two threads can name one directory via a symlink, a macOS
   * case-variant, or a trailing slash, all of which a string compare would miss.
   */
  activeRunForWorkspace(workspacePath: string): { threadId: string; runId: string } | undefined {
    const key = workspaceKey(workspacePath)
    for (const run of this.active.values()) {
      const runKey = workspaceKey(run.workspacePath)
      // Equal OR nested EITHER way: a run on /repo and a launch/turn on
      // /repo/packages/a write into the same tree — the parent run can touch the
      // child dir, and the child's auto-commit can sweep the parent run's edits.
      // An exact-path match alone leaves nested workspaces racing, so treat a
      // parent/child overlap as a clash too. (auto-commit skip reuses this method,
      // so both the launch mutex and the skip are covered by this one change.)
      if (runKey === key || isPathInside(runKey, key) || isPathInside(key, runKey)) {
        return { threadId: run.threadId, runId: run.runId }
      }
    }
    return undefined
  }

  /**
   * Whether the thread has a workflow RUNNING or a result still PENDING (auto-
   * re-report not exhausted). The workspace-picker guard (models.ts) and the
   * threads:update guard both call this so a workspace switch / mode exit can't
   * orphan a run. Pass the run's CURRENT (old) workspacePath — that's where the run
   * files live, and findPendingNotification looks them up there. (#2)
   */
  isBusyForThread(threadId: string, workspacePath: string | undefined): boolean {
    if (this.isActive(threadId)) return true
    if (!workspacePath) return false
    const pendingRun = this.findPendingNotification(workspacePath, threadId)
    return pendingRun !== null && !this.isRenotifyExhausted(pendingRun.runId)
  }

  /** Launches a run in the background. Throws synchronously on invalid state. */
  launch(request: WorkflowLaunchRequest): WorkflowLaunchResult {
    if (this.active.has(request.threadId)) {
      throw new Error(
        `A dynamic workflow (${this.active.get(request.threadId)!.runId}) is already running in this thread. Wait for its task-notification or cancel it from the workflow panel.`
      )
    }
    // No workspace-level mutual exclusion: concurrent workflows over the SAME
    // workspace on different threads are intentionally allowed (matches Claude
    // Code desktop). Trade-off: cmbcowork has no per-run git-worktree isolation
    // (CC's mechanism for safe concurrency), so two write-heavy workflows touching
    // the same file can clobber each other — low-frequency (most workflows are
    // read-only) and git-recoverable. The same-thread lock above still serializes
    // runs within one conversation, and auto-commit still skips while ANY workflow
    // is active on the workspace (activeRunForWorkspace is still used there).
    // Fresh launch (incl. a resume reusing this runId) → reset its re-notify
    // budget, so a prior run's exhausted attempts don't pre-throttle this one.
    this.renotifyAttempts.delete(request.runId)

    const now = new Date().toISOString()
    const initial: PersistedWorkflowRun = {
      version: 1,
      runId: request.runId,
      threadId: request.threadId,
      workflowName: request.parsed.meta.name,
      description: request.parsed.meta.description,
      script: request.script,
      scriptSha256: request.scriptSha256,
      args: toJsonSafe(request.args),
      status: "running",
      phases: [],
      currentPhase: null,
      agents: [],
      logs: [],
      journal: request.resumeJournal ?? [],
      // Matches engine's run-start `resumed = journal.length > 0` exactly (initial
      // journal IS the resumeJournal), but persisted so it survives reload.
      resumed: (request.resumeJournal?.length ?? 0) > 0,
      stats: { agentsTotal: 0, agentsCached: 0, agentsFailed: 0, outputTokens: 0, durationMs: 0 },
      startedAt: now,
      updatedAt: now
    }
    const runStore = createWorkflowRunStore({
      workspacePath: request.workspacePath,
      threadId: request.threadId,
      initial
    })
    const scriptFilePath = persistScriptFile(
      request.workspacePath,
      request.threadId,
      request.runId,
      request.script
    )

    const controller = new AbortController()
    const entry: ActiveWorkflowRun = {
      threadId: request.threadId,
      workspacePath: request.workspacePath,
      runId: request.runId,
      workflowName: request.parsed.meta.name,
      controller,
      userCancelled: false,
      settled: Promise.resolve()
    }
    this.active.set(request.threadId, entry)

    entry.settled = (async () => {
      try {
        if (request.resumeNote) {
          runStore.update((run) => {
            run.logs.push(request.resumeNote!)
          })
          broadcast(request.threadId, {
            type: "workflow_progress",
            workflowEvent: { kind: "log", runId: request.runId, message: request.resumeNote! }
          })
        }
        const engineResult = await runWorkflowEngine({
          parsed: request.parsed,
          runStore,
          args: request.args,
          tokenBudget: request.tokenBudget ?? null,
          // Fold the session-default model into the engine's call-identity hash so a
          // resume after the user switched the thread's model re-runs default-model
          // agents instead of replaying the old model's cached result. (#1)
          defaultModelId: request.subagentDeps.defaultModelId,
          runExclusiveFileWrite: request.runExclusiveFileWrite,
          subagentRunner: (subRequest) =>
            runWorkflowSubagent(request.subagentDeps, {
              prompt: subRequest.prompt,
              schema: subRequest.schema,
              model: subRequest.model,
              agentIndex: subRequest.agentIndex,
              label: subRequest.label,
              runId: request.runId,
              signal: subRequest.signal,
              roleSystemPrompt: subRequest.roleSystemPrompt,
              disallowedTools: subRequest.disallowedTools,
              shellAccess: subRequest.shellAccess
            }),
          emit: (event) =>
            broadcast(request.threadId, { type: "workflow_progress", workflowEvent: event }),
          signal: controller.signal,
          workspacePath: request.workspacePath,
          // Scope the watchdog's "awaiting approval" check to THIS run, so a
          // sibling run on the same parent thread can't suppress its hung-run timeout.
          isAwaitingApproval: () =>
            request.subagentDeps.hasPendingApproval?.(request.runId) ?? false
        })
        console.log("[Workflow] Background run settled:", {
          threadId: request.threadId,
          runId: request.runId,
          status: engineResult.status
        })
      } catch (error) {
        // runWorkflowEngine finalizes internally for every known path; this
        // catch is a backstop against unexpected synchronous faults.
        console.error("[Workflow] Background run crashed:", error)
        runStore.update((run) => {
          run.status = "error"
          run.error = error instanceof Error ? error.message : String(error)
          run.completedAt = new Date().toISOString()
        })
        await runStore.flush()
      } finally {
        this.active.delete(request.threadId)
        // Final persist. If it fails (disk full / permissions) the in-memory run is
        // complete but disk is stale, so the notification (read from disk) and a
        // later resume/reload could be incomplete. Retry once for a transient fault;
        // log loudly either way. We still broadcast below so the user isn't left
        // hanging — the live panel is correct from the event stream.
        const finalPersisted = (await runStore.flush()) || (await runStore.flush())
        if (!finalPersisted) {
          console.error(
            `[Workflow] Run ${request.runId} completed but its final state could NOT be persisted (disk full / permissions?) — keeping an in-memory snapshot so its notification still reports the real result.`
          )
        }
        pruneWorkflowRuns(request.workspacePath, request.threadId)
        // A user-initiated cancel needs no model turn — the user was present.
        if (!entry.userCancelled) {
          if (!finalPersisted) {
            // Keep the FULL run incl. journal: recoverFlushFailedRun writes this
            // snapshot back to disk on ack, and writing an empty journal would wipe
            // the resume cache and force subagents to re-run (data-loss boundary).
            // The journal can be large, but a failed final persist is rare and this
            // holds one run. ONLY for a non-cancelled run: a cancelled run is never
            // reported, so a snapshot would just get re-surfaced by
            // findPendingNotification and wrongly reported.
            this.flushFailedRuns.set(request.runId, JSON.parse(JSON.stringify(runStore.state)))
            // Bound memory: under a persistent disk fault these (each holding a full
            // journal) could pile up. Evict the oldest ALREADY-DELIVERED snapshot —
            // its result was already reported, so only its stale history copy is lost.
            // NEVER evict an undelivered or in-flight one: that would drop a real
            // completed/error result (its disk copy is a stale "running" that would
            // then be mis-reconciled to "aborted"). If none are safely evictable the
            // cap goes soft — correctness over a hard bound under a (rare) disk fault.
            while (this.flushFailedRuns.size > MAX_FLUSH_FAILED_RUNS) {
              let evicted = false
              for (const [id, snap] of this.flushFailedRuns) {
                if (snap.notificationDelivered && !this.inFlightNotifications.has(id)) {
                  this.flushFailedRuns.delete(id)
                  evicted = true
                  break
                }
              }
              if (!evicted) break
            }
          }
          emitAppAttention({
            kind: runStore.state.status === "completed" ? "task-complete" : "task-error",
            threadId: request.threadId,
            key: `workflow:${request.runId}`
          })
          broadcast(request.threadId, { type: "workflow_notification", runId: request.runId })
        } else {
          // Mark the cancelled run delivered too: otherwise a later hydrate's
          // findUndeliveredTerminalRun would resurface this aborted run as a
          // pending notification and fire a model turn the user never asked for
          // (engine finalize("aborted") leaves delivered=false). markNotified
          // swallows IO errors, so it's safe in finally.
          await markWorkflowRunNotified(request.workspacePath, request.threadId, request.runId)
        }
      }
    })()

    return {
      runId: request.runId,
      scriptFilePath,
      whenInitialPersisted: runStore.whenInitialPersisted
    }
  }

  /** Cancels the thread's active run. Returns false when nothing is running. */
  cancel(threadId: string, runId?: string, userInitiated = true): boolean {
    const entry = this.active.get(threadId)
    if (!entry) return false
    if (runId && entry.runId !== runId) return false
    entry.userCancelled = entry.userCancelled || userInitiated
    entry.controller.abort()
    return true
  }

  /**
   * Cancels the thread's active run AND waits (bounded) for it to fully settle
   * (its final flush completes). Used before deleting a thread's run artifacts so
   * the settling run's flush can't recreate the directory after it's removed.
   *
   * The wait is bounded so a subagent that is slow to honor abort can't hang the
   * caller (the threads:delete IPC). On timeout we proceed and delete the run
   * dir anyway — deleteWorkflowRunsForThread marks the dir disposed, so even a
   * late flush from the still-settling run becomes a no-op and cannot recreate
   * it as an orphan. (The deleted thread would never be hydrated/listed again,
   * so we can't rely on reconciliation here.)
   */
  async cancelAndWait(threadId: string, timeoutMs = 10_000): Promise<void> {
    const entry = this.active.get(threadId)
    if (!entry) return
    entry.userCancelled = true
    entry.controller.abort()
    await Promise.race([
      entry.settled.catch(() => {}),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      })
    ])
  }

  /**
   * The newest terminal run whose completion has not yet been folded into a
   * model turn. Delegates to a lean disk scan (stat-then-parse-newest-few) so
   * the per-turn lookup on the main process doesn't parse every run file.
   */
  findPendingNotification(workspacePath: string, threadId: string): PersistedWorkflowRun | null {
    // A run whose final persist failed has a stale on-disk copy (maybe still
    // "running", invisible to the disk scan below), so prefer its in-memory
    // snapshot — that's its true terminal state. Skip one already in-flight.
    for (const snapshot of this.flushFailedRuns.values()) {
      if (
        snapshot.threadId === threadId &&
        !snapshot.notificationDelivered &&
        !this.inFlightNotifications.has(snapshot.runId)
      ) {
        return snapshot
      }
    }
    const run = findUndeliveredTerminalRun(workspacePath, threadId)
    // Don't hand out a run already being reported by an in-flight turn this
    // process — otherwise a concurrent invoke could double-report it.
    if (run && this.inFlightNotifications.has(run.runId)) return null
    return run
  }

  /**
   * After a notification turn acks one run, re-broadcast for the NEXT still-
   * undelivered terminal run on this thread (if any). The user can launch a
   * second workflow while the first's report is deferred (a settled run is no
   * longer active, so launch isn't blocked), and findUndeliveredTerminalRun
   * returns newest-first — so acking the newest would otherwise strand an older
   * completed run until the next hydrate. This drains the backlog one run per
   * ack: each kicked run gets its own report turn + ack, which kicks the next.
   */
  kickNextPendingNotification(workspacePath: string, threadId: string): void {
    const next = this.findPendingNotification(workspacePath, threadId)
    if (next) broadcast(threadId, { type: "workflow_notification", runId: next.runId })
  }

  /** Marks a run's notification turn as in flight (in-memory, not persisted). */
  markNotificationInFlight(runId: string): void {
    this.inFlightNotifications.add(runId)
  }

  /** Clears the in-flight mark (turn settled — success persisted it, failure frees it). */
  clearNotificationInFlight(runId: string): void {
    this.inFlightNotifications.delete(runId)
  }

  /**
   * Drops the in-memory snapshot kept for a run whose final persist failed, once
   * its notification has been reported. The user has the result; further reports
   * (e.g. after a restart) would have to come from disk anyway.
   */
  clearFlushFailedRun(runId: string): void {
    this.flushFailedRuns.delete(runId)
  }

  /**
   * The in-memory terminal snapshot for a flush-failed run, if any. Zombie
   * reconciliation uses it: a run WITH a snapshot actually finished, so its stale
   * "running" on-disk copy must NOT be flipped to "aborted" (boundary #2).
   */
  getFlushFailedRun(runId: string): PersistedWorkflowRun | undefined {
    return this.flushFailedRuns.get(runId)
  }

  /**
   * All in-memory flush-failed snapshots for a thread. A run whose INITIAL persist
   * also failed has NO on-disk file to enumerate, so a disk-only listing hides it —
   * exactly the disk-fault case the user most needs to see. list-runs / hydrate use
   * this to also surface those memory-only runs in history. (#5)
   */
  listFlushFailedRuns(threadId: string): PersistedWorkflowRun[] {
    const out: PersistedWorkflowRun[] = []
    for (const snap of this.flushFailedRuns.values()) {
      if (snap.threadId === threadId) out.push(snap)
    }
    return out
  }

  /**
   * Drop all in-memory flush-failed snapshots for a deleted thread (each holds a FULL
   * journal — the real memory cost), plus their per-run notification bookkeeping.
   * A run whose persist failed lives ONLY in memory; without this it leaks in the
   * main process until restart even after its thread is gone. cancelAndWait only
   * aborts the active run — it never touches this table. (#3) */
  forgetThread(threadId: string): void {
    for (const [runId, snap] of this.flushFailedRuns) {
      if (snap.threadId === threadId) {
        this.flushFailedRuns.delete(runId)
        this.inFlightNotifications.delete(runId)
        this.renotifyAttempts.delete(runId)
      }
    }
  }

  /**
   * Once a flush-failed run's notification is acked, try to write its true terminal
   * state back to disk (disk may have recovered since the failed flush), so history /
   * hydrate / resume stop reading the stale copy. Marks the snapshot delivered first
   * so it can't be re-reported; keeps it (for a later retry) only if the write-back
   * still fails — otherwise drops it.
   */
  async recoverFlushFailedRun(
    workspacePath: string,
    threadId: string,
    runId: string
  ): Promise<boolean> {
    const snapshot = this.flushFailedRuns.get(runId)
    if (!snapshot) return false
    snapshot.notificationDelivered = true
    if (await persistRecoveredRun(workspacePath, threadId, snapshot)) {
      this.flushFailedRuns.delete(runId)
      return true
    }
    return false
  }

  /**
   * Retry write-back of a flush-failed snapshot from a READ path (get-run / hydrate):
   * the disk may have recovered since the ack-time write-back failed, so this is a
   * real retry entry point instead of leaving it stranded in memory until restart
   * (#3). Does NOT touch notificationDelivered (the ack owns that) — just persists the
   * current snapshot and drops it on success. Callers fire-and-forget.
   */
  async retryPersistFlushFailedRun(
    workspacePath: string,
    threadId: string,
    runId: string
  ): Promise<void> {
    const snapshot = this.flushFailedRuns.get(runId)
    if (!snapshot) return
    if (await persistRecoveredRun(workspacePath, threadId, snapshot)) {
      this.flushFailedRuns.delete(runId)
    }
  }

  /** Persists delivered=true. Called ONLY after the notification turn SUCCEEDS, so
   * a crash mid-turn leaves it false on disk and the run is re-reported. */
  markNotified(workspacePath: string, threadId: string, runId: string): Promise<boolean> {
    return markWorkflowRunNotified(workspacePath, threadId, runId)
  }

  /**
   * Asks the renderer to re-report a run whose notification turn FAILED — but at
   * most MAX_RENOTIFY_ATTEMPTS times per run, so a persistently failing turn
   * (e.g. a hard API outage) cannot spin a fail→rollback→re-report loop. After
   * the cap the run stays re-discoverable (it surfaces again on the next thread
   * hydrate) but is no longer auto-re-reported. Returns true if it broadcast.
   */
  renotify(threadId: string, runId: string): boolean {
    const attempts = (this.renotifyAttempts.get(runId) ?? 0) + 1
    if (attempts > MAX_RENOTIFY_ATTEMPTS) return false
    this.renotifyAttempts.set(runId, attempts)
    broadcast(threadId, { type: "workflow_notification", runId })
    return true
  }

  /**
   * True once auto-re-report has given up on a run THIS PROCESS (its report turn
   * kept failing, e.g. a hard API outage). The mode-switch guard consults this so
   * a wedged notification can't lock the user in workflow mode with no escape but
   * deleting the thread: once exhausted, the guard lets them leave. The run stays
   * delivered=false on disk, so a RESTART (which resets this in-memory budget)
   * still retries it while the thread remains in workflow mode.
   */
  isRenotifyExhausted(runId: string): boolean {
    return (this.renotifyAttempts.get(runId) ?? 0) >= MAX_RENOTIFY_ATTEMPTS
  }

  /**
   * Drops a run's re-notify counter once its notification turn SUCCEEDS — so the
   * Map doesn't grow unbounded and a later re-notification of the same run (e.g.
   * after a resume) starts from a fresh budget rather than a stale exhausted one.
   */
  clearRenotify(runId: string): void {
    this.renotifyAttempts.delete(runId)
  }
}

export const workflowRunManager = new WorkflowRunManager()

function persistScriptFile(
  workspacePath: string,
  threadId: string,
  runId: string,
  script: string
): string {
  const dir = getWorkflowRunsDir(workspacePath, threadId)
  const path = join(dir, `${runId}.workflow.js`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, script)
  } catch (error) {
    console.warn("[Workflow] Failed to persist script file:", error)
  }
  return path
}
