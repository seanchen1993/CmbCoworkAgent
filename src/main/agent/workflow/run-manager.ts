import { BrowserWindow, webContents, type WebContents } from "electron"
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import { serializeWorkflowAgentSnapshotMessages } from "./agent-snapshot"
import { runWorkflowEngine, toJsonSafe } from "./engine"
import { isPathInside } from "./paths"
import {
  clearAgentToolStream,
  countUnresolvedWorkflowWorktrees,
  createWorkflowRunStore,
  findUndeliveredTerminalRun,
  getWorkflowRunsDir,
  isWorkflowRunDirDisposed,
  markWorkflowRunNotified,
  newerWorkflowWorktreeRecord,
  persistAgentToolStream,
  persistRecoveredRun,
  pruneWorkflowRuns,
  workflowThreadDisposalEpoch
} from "./run-store"
import { runWorkflowSubagent, type WorkflowSubagentDeps } from "./subagent"
import {
  type ParsedWorkflowScript,
  type PersistedWorkflowRun,
  type WorkflowProgressEvent,
  type WorkflowSubagentResult,
  type WorkflowWorktreeIsolationBoundary,
  type WorkflowWorktreeRecord
} from "./types"
import { WorkflowWorktreeLedger } from "./worktree-lease"
import {
  identifyRepository,
  listWorkflowWorktreeRecordsForPrune,
  resolveWorkflowWorktreeIsolationBoundary
} from "../../services/git-worktree"
import { emitAppAttention } from "../../app-attention-events"

/**
 * Background workflow run manager — the Claude Code execution model: the
 * `workflow` tool returns immediately with a run id, the run continues
 * detached from the agent turn, live progress streams to the renderer on a
 * DURABLE per-thread channel (it outlives the turn), and on completion a
 * `<task-notification>` is folded back into the conversation so the model can
 * report the outcome (mirrors how coordinator async workers notify).
 *
 * One active run per thread (the workflow tool is exclusive per thread).
 * Same-WORKSPACE concurrency across different threads is intentionally
 * ALLOWED — see launch() and activeRunForWorkspace() for the tradeoff notes.
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
  /** Durable deliverables retained by the previous incarnation of this runId. */
  existingWorktrees?: PersistedWorkflowRun["worktrees"]
  /** True when this launch reuses a prior runId, even if it has no replayable journal. */
  resumed?: boolean
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
  /** Worktrees created by this run's isolated agents. Reclaimed when the run
   * settles or is cancelled; kept deliverables survive both. */
  worktrees: WorkflowWorktreeLedger
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

// ── Subagent tool-stream (DISPLAY-ONLY) ───────────────────────────────────────
// Two best-effort, fully-guarded mechanisms let the renderer show ANY subagent's tool
// flow on demand, WITHOUT ever perturbing the run (no run.json/journal/checkpoint/engine
// change; fed by the subagent's onValues tap, deep-cloned before use):
//   1. LIVE — while you view a still-running agent, its "values" snapshots are broadcast
//      on a per-PARENT-thread channel (payload carries runId+agentIndex). Gated by
//      per-AGENT "viewing interest", so ONLY the agent you're looking at is serialized/
//      broadcast — a background run, or sibling agents you aren't viewing, cost nothing.
//   2. PERSISTED — when an agent FINISHES, its final complete flow is written once to a
//      small bounded per-agent sidecar (run-store agentToolStreamPath), so it can be
//      opened on demand later (an agent you never watched, or after the run ended). Read
//      lazily via IPC; deleted with the run.
export const WORKFLOW_AGENT_STREAM_CHANNEL_PREFIX = "agent:workflow-agent-stream:"

// Per-AGENT "viewing interest" gate (key = threadId+runId+agentIndex): the focus panel
// registers while it shows a RUNNING agent and deregisters on close/switch. emit does
// ZERO serialize/broadcast unless that exact agent is being viewed. Each key maps to the
// Set of viewing webContents ids (NOT a counter) so it is robust to renderer hard-reload
// / crash — re-registering is idempotent, and a webContents's interest is purged on its
// main-frame navigation / render-process-gone / destroy so no phantom keeps the tap on.
const agentStreamInterest = new Map<string, Set<number>>() // interestKey -> webContents ids
const trackedAgentStreamWebContents = new Set<number>()

// Latest values frame per RUNNING agent (interestKey -> {snapshot,label}), kept so a viewer
// who opens a long-running agent gets an IMMEDIATE catch-up frame instead of a blank panel
// until the next super-step (values frames arrive only per super-step, so a multi-minute tool
// call would otherwise show "waiting" the whole time). Just a ref swap per frame — the
// cumulative snapshot is already alive in the run — and cleared when the agent finishes.
const agentLatestSnapshot = new Map<string, { snapshot: unknown; label: string }>()

/** Serialize ONE agent snapshot and send it to a single webContents (catch-up on open).
 * Best-effort + display-only: never throws, never touches the run. */
function sendAgentSnapshotTo(
  wc: WebContents,
  parentThreadId: string,
  runId: string,
  agentIndex: number,
  label: string,
  snapshot: unknown
): void {
  try {
    if (wc.isDestroyed()) return
    const snapshotMessages = serializeWorkflowAgentSnapshotMessages(snapshot)
    if (!snapshotMessages) return
    wc.send(`${WORKFLOW_AGENT_STREAM_CHANNEL_PREFIX}${parentThreadId}`, {
      runId,
      agentIndex,
      label,
      snapshotMessages
    })
  } catch {
    /* catch-up send is best-effort */
  }
}

function agentStreamInterestKey(threadId: string, runId: string, agentIndex: number): string {
  return `${threadId}|${runId}|${agentIndex}`
}

function purgeAgentStreamInterestFor(webContentsId: number): void {
  for (const [key, ids] of agentStreamInterest) {
    if (ids.delete(webContentsId) && ids.size === 0) agentStreamInterest.delete(key)
  }
}

export function setWorkflowAgentStreamInterest(
  threadId: string,
  runId: string,
  agentIndex: number,
  interested: boolean,
  webContents: WebContents
): void {
  const id = webContents.id
  const key = agentStreamInterestKey(threadId, runId, agentIndex)
  if (interested) {
    let ids = agentStreamInterest.get(key)
    if (!ids) {
      ids = new Set<number>()
      agentStreamInterest.set(key, ids)
    }
    ids.add(id)
    // Attach self-purge listeners ONCE per webContents so a reload (skips React
    // cleanup), a crash, or a close can't leave a phantom interest behind.
    if (!trackedAgentStreamWebContents.has(id)) {
      trackedAgentStreamWebContents.add(id)
      // A full main-frame navigation (reload / new page) voids the prior page's
      // registrations; the reloaded page re-registers via its own effects if it
      // still shows a focused running agent.
      webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) purgeAgentStreamInterestFor(id)
      })
      // A renderer CRASH does NOT destroy the webContents (it can reload), so KEEP it
      // tracked — its listeners stay attached and re-registration must not re-add them
      // (re-adding would leak one listener per crash). Just drop its interest.
      webContents.on("render-process-gone", () => purgeAgentStreamInterestFor(id))
      // Only a real destroy removes the webContents (Electron then drops its listeners);
      // untrack so a fresh webContents that reuses this id attaches its own listeners.
      webContents.once("destroyed", () => {
        trackedAgentStreamWebContents.delete(id)
        purgeAgentStreamInterestFor(id)
      })
    }
    // Catch-up: send the latest remembered frame immediately to THIS newly-interested
    // webContents, so opening an agent mid-(long)-tool-call shows the flow-so-far at once
    // instead of a blank "waiting" panel until the next super-step. The renderer attaches
    // its stream listener synchronously right after this IPC call, so it is ready to receive.
    const latest = agentLatestSnapshot.get(key)
    if (latest) {
      sendAgentSnapshotTo(webContents, threadId, runId, agentIndex, latest.label, latest.snapshot)
    }
  } else {
    const ids = agentStreamInterest.get(key)
    if (ids && ids.delete(id) && ids.size === 0) agentStreamInterest.delete(key)
  }
}

const WORKFLOW_AGENT_SNAPSHOT_WINDOW_MS = 120

/** Per-(runId:agentIndex) leading+trailing coalescer: emits the first frame at
 * once, collapses a burst within the window, and flushes the LATEST frame at window
 * close — so the terminal snapshot is never dropped. Snapshots are low-frequency
 * (one per LangGraph super-step), so this only smooths the occasional fast burst. */
const agentSnapshotCoalescers = new Map<
  string,
  { timer: NodeJS.Timeout | null; latest: (() => void) | null }
>()

function coalesceAgentSnapshotEmit(key: string, doEmit: () => void): void {
  let state = agentSnapshotCoalescers.get(key)
  if (!state) {
    state = { timer: null, latest: null }
    agentSnapshotCoalescers.set(key, state)
  }
  if (state.timer) {
    state.latest = doEmit // a window is open — keep only the latest
    return
  }
  doEmit() // leading edge
  state.timer = setTimeout(() => {
    const pending = state.latest
    state.latest = null
    state.timer = null
    if (pending) pending()
    // Always drop the entry once the window closes (idle) so the map can't accumulate
    // one dead record per (runId:agentIndex) over a long session — the next frame for
    // this key recreates it via the leading edge.
    agentSnapshotCoalescers.delete(key)
  }, WORKFLOW_AGENT_SNAPSHOT_WINDOW_MS)
  state.timer.unref?.()
}

function emitWorkflowAgentSnapshot(
  parentThreadId: string,
  runId: string,
  agentIndex: number,
  label: string,
  snapshot: unknown
): void {
  const interestKey = agentStreamInterestKey(parentThreadId, runId, agentIndex)
  // Remember the latest frame for catch-up on a LATER open (see setWorkflowAgentStreamInterest),
  // even when nobody is watching yet — a ref swap, no serialize/clone. Cleared on finish.
  agentLatestSnapshot.set(interestKey, { snapshot, label })
  // Gate: do NOTHING further (no serialize, no clone, no send) unless a renderer is actively
  // viewing THIS agent. Just a Map.has — near-zero cost for everyone else.
  if (!agentStreamInterest.has(interestKey)) return
  try {
    // Coalesce key matches the interest key's scoping (parentThreadId|runId|agentIndex): runId is
    // only 48-bit random, so without the thread the throttle slots of two threads' runs that collide
    // on runId + agentIndex could overwrite each other. Near-zero, but keep it consistent.
    coalesceAgentSnapshotEmit(`${parentThreadId}:${runId}:${agentIndex}`, () => {
      try {
        // Re-read at flush time (a window may have closed during the coalesce window) and
        // send ONLY to the webContents that registered interest for THIS agent — never a
        // getAllWindows() broadcast — so other windows (a different agent, pet/login
        // windows) never receive this agent's tool data or pay any IPC.
        const recipients = agentStreamInterest.get(interestKey)
        if (!recipients || recipients.size === 0) return
        const snapshotMessages = serializeWorkflowAgentSnapshotMessages(snapshot)
        if (!snapshotMessages) return
        const channel = `${WORKFLOW_AGENT_STREAM_CHANNEL_PREFIX}${parentThreadId}`
        const payload = { runId, agentIndex, label, snapshotMessages }
        for (const wcId of recipients) {
          try {
            const wc = webContents.fromId(wcId)
            if (wc && !wc.isDestroyed()) wc.send(channel, payload)
          } catch {
            /* per-window best-effort */
          }
        }
      } catch {
        /* serialization/send is best-effort */
      }
    })
  } catch {
    /* the tap must never throw into the run */
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
  private readonly workspaceIntegrationLeases = new Map<
    string,
    { workspacePath: string; ownerRunId: string }
  >()
  private shuttingDown = false
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
  /** In-memory mutation revision for each flush-failed snapshot. A read-path
   * write-back can overlap a worktree action; only the revision it actually
   * persisted may remove the authoritative snapshot. */
  private readonly flushFailedRevisions = new Map<string, number>()
  /** Disposal epoch at snapshot capture, in lockstep with flushFailedRuns.
   * persistRecoveredRun mkdirs, so a snapshot from an incarnation deleted
   * since must be DROPPED, not written — even after reviveWorkflowThread
   * cleared the set tombstones for a fixed-id recreation. */
  private readonly flushFailedEpochs = new Map<string, number>()

  private dropFlushFailedRun(runId: string): void {
    this.flushFailedRuns.delete(runId)
    this.flushFailedEpochs.delete(runId)
    this.flushFailedRevisions.delete(runId)
  }

  private async persistCurrentFlushFailedRun(
    workspacePath: string,
    threadId: string,
    runId: string
  ): Promise<boolean> {
    const snapshot = this.flushFailedRuns.get(runId)
    if (!snapshot) return false
    const revision = this.flushFailedRevisions.get(runId) ?? 0
    // persistRecoveredRun awaits filesystem work. Freeze the exact revision so
    // a concurrent action cannot mutate the object being serialized underneath it.
    const frozen = JSON.parse(JSON.stringify(snapshot)) as PersistedWorkflowRun
    const persisted = await persistRecoveredRun(
      workspacePath,
      threadId,
      frozen,
      this.flushFailedEpochs.get(runId)
    )
    if (
      persisted &&
      this.flushFailedRuns.get(runId) === snapshot &&
      (this.flushFailedRevisions.get(runId) ?? 0) === revision
    ) {
      this.dropFlushFailedRun(runId)
      return true
    }
    return false
  }

  isActive(threadId: string): boolean {
    return this.active.has(threadId)
  }

  hasActiveRuns(): boolean {
    return this.active.size > 0
  }

  activeRunId(threadId: string): string | undefined {
    return this.active.get(threadId)?.runId
  }

  /** A renderer can observe the engine's terminal event while manager-owned
   * worktree reclaim/final persistence is still finishing. Let a matching UI
   * action wait for that short lifecycle tail instead of failing as "active". */
  async waitForRunLifecycle(threadId: string, runId: string): Promise<void> {
    const entry = this.active.get(threadId)
    if (entry?.runId === runId) await entry.settled
  }

  broadcastWorktreeRecord(threadId: string, runId: string, record: WorkflowWorktreeRecord): void {
    broadcast(threadId, {
      type: "workflow_progress",
      workflowEvent: { kind: "worktree_update", runId, worktree: record }
    })
  }

  /** The workspace of the thread's ACTIVE run, if any. threads:delete uses it
   * as a fallback when the thread's metadata lost its workspacePath — the run
   * entry knows where its artifacts live, so deletion can still find them. */
  activeWorkspaceForThread(threadId: string): string | undefined {
    return this.active.get(threadId)?.workspacePath
  }

  /**
   * A run active over the same workspace on ANY thread. NOT a launch mutex —
   * concurrent same-workspace workflows on different threads are intentionally
   * ALLOWED (see launch(): matches Claude Code desktop; same-thread exclusivity
   * still holds). This lookup serves the callers that must know a workspace is
   * busy, e.g. auto-commit skips while any run is active on it. Compared by
   * CANONICAL path (workspaceKey), NOT raw string: two threads can name one
   * directory via a symlink, a macOS case-variant, or a trailing slash, all of
   * which a string compare would miss.
   */
  activeRunForWorkspace(workspacePath: string): { threadId: string; runId: string } | undefined {
    const key = workspaceKey(workspacePath)
    for (const run of this.active.values()) {
      const runKey = workspaceKey(run.workspacePath)
      // Equal OR nested EITHER way: a run on /repo and a launch/turn on
      // /repo/packages/a write into the same tree — the parent run can touch the
      // child dir, and the child's auto-commit can capture the parent run's edits.
      // An exact-path match alone leaves nested workspaces racing, so treat a
      // parent/child overlap as a clash too. (auto-commit skip reuses this method,
      // so both the launch mutex and the skip are covered by this one change.)
      if (runKey === key || isPathInside(runKey, key) || isPathInside(key, runKey)) {
        return { threadId: run.threadId, runId: run.runId }
      }
    }
    return undefined
  }

  private overlappingIntegrationLease(
    workspacePath: string
  ): { workspacePath: string; ownerRunId: string } | undefined {
    const key = workspaceKey(workspacePath)
    for (const lease of this.workspaceIntegrationLeases.values()) {
      const leaseKey = workspaceKey(lease.workspacePath)
      if (leaseKey === key || isPathInside(leaseKey, key) || isPathInside(key, leaseKey)) {
        return lease
      }
    }
    return undefined
  }

  private acquireWorkspaceIntegrationLease(
    workspacePath: string,
    ownerRunId: string
  ): { acquired: false; reason: string } | { acquired: true; release: () => void } {
    const existing = this.overlappingIntegrationLease(workspacePath)
    if (existing) {
      return {
        acquired: false,
        reason: `workspace integration is already in progress for ${existing.ownerRunId}`
      }
    }
    const active = this.activeRunForWorkspace(workspacePath)
    if (active && active.runId !== ownerRunId) {
      return {
        acquired: false,
        reason: `workflow ${active.runId} is active on the source workspace; wait before integration`
      }
    }
    const key = workspaceKey(workspacePath)
    const lease = { workspacePath, ownerRunId }
    this.workspaceIntegrationLeases.set(key, lease)
    return {
      acquired: true,
      release: () => {
        if (this.workspaceIntegrationLeases.get(key) === lease) {
          this.workspaceIntegrationLeases.delete(key)
        }
      }
    }
  }

  /** Reserve the source workspace across a merge's clean-check → source-ref
   * mutation. The reservation is acquired synchronously before awaiting, so a
   * workflow launch cannot slip between the busy check and the Git mutation. */
  async withWorkspaceIntegrationLease<T>(
    workspacePath: string,
    ownerRunId: string,
    task: () => Promise<T>
  ): Promise<T> {
    const lease = this.acquireWorkspaceIntegrationLease(workspacePath, ownerRunId)
    if (!lease.acquired) throw new Error(lease.reason)
    try {
      return await task()
    } finally {
      lease.release()
    }
  }

  /** Whether the thread has a workflow running or a result still pending.
   * Retained worktrees and UI integration actions have their own workspace pin;
   * they must not change the existing workflow-mode busy contract. */
  isBusyForThread(threadId: string, workspacePath: string | undefined): boolean {
    if (this.isActive(threadId)) return true
    if (!workspacePath) return false
    return this.hasDeliverablePendingNotification(workspacePath, threadId)
  }

  /** Workspace switching has one additional constraint beyond an active run:
   * retained deliverables are indexed by the workspace that owns run.json.
   * Pin only that workspace until its explicit Merge/Discard/Cleanup decision;
   * mode changes and unrelated/non-worktree tasks remain unaffected. */
  async isWorkspacePinnedForThread(
    threadId: string,
    workspacePath: string | undefined
  ): Promise<boolean> {
    if (this.isBusyForThread(threadId, workspacePath)) return true
    if (!workspacePath) return false
    // Unlike thread deletion, workspace switching must not be locked forever by
    // an unrelated corrupt legacy run. Pin only a worktree record we can prove exists.
    if (
      countUnresolvedWorkflowWorktrees(workspacePath, threadId, {
        failClosedOnUnreadable: false
      }) > 0
    ) {
      return true
    }
    if (
      this.listFlushFailedRuns(threadId).some((run) =>
        (run.worktrees ?? []).some(
          (record) =>
            (record.status !== "merged" && record.status !== "discarded") ||
            record.cleanupPending === true
        )
      )
    ) {
      return true
    }

    // Ownership is persisted before `git worktree add`, while run.json learns
    // the record through a throttled update. After a crash there can therefore
    // be a real manifest that is not yet in run history. Workspace switching is
    // rare and already asynchronous, so consult the existing manifest store here
    // instead of adding another index or making every provisioning write block.
    // Read failures remain fail-open, matching the non-corrupt-run policy above;
    // only a manifest we can positively attribute pins the workspace.
    try {
      const repository = await identifyRepository(workspacePath)
      if (!repository) return false
      const manifests = await listWorkflowWorktreeRecordsForPrune(repository.commonDir)
      // A damaged sibling manifest is not evidence about this thread, but it
      // must not erase a valid, positively attributed record we did parse.
      // `reliable` remains important to destructive prune callers; this guard
      // performs no mutation and needs only positive ownership evidence.
      return manifests.records.some(
        (record) =>
          record.threadId === threadId &&
          ((record.status !== "merged" && record.status !== "discarded") ||
            record.cleanupPending === true ||
            existsSync(record.directory))
      )
    } catch {
      return false
    }
  }

  /** Busy-guard variant of findPendingNotification WITHOUT its first-candidate
   * blind spot: that lookup returns the newest/flush-failed candidate only, so
   * an exhausted (or in-flight) FIRST candidate makes single-candidate guards
   * report idle while an older, perfectly deliverable run still waits — and a
   * workspace switch / mode exit would orphan it off the auto-report path.
   * Deliverable = not delivered AND renotify not exhausted; an in-flight one
   * COUNTS as busy (it stays undelivered until its ack lands). */
  hasDeliverablePendingNotification(workspacePath: string, threadId: string): boolean {
    return this.hasDeliverablePendingNotificationExcept(workspacePath, threadId, undefined)
  }

  /** Like hasDeliverablePendingNotification, but ignores the run instance a
   * delivery turn is CURRENTLY reporting. Runs support a pending BACKLOG (only
   * one notification is delivered per turn; the next is kicked after ack), so a
   * caller that runs DURING a delivery turn (the goal defer check, which happens
   * BEFORE the settlement markNotified()s the current run) must exclude that
   * in-flight run — otherwise it would see its own delivery as "still pending"
   * and self-defer — yet still detect an OTHER already-completed run whose result
   * has not entered the conversation, so the goal doesn't evaluate on partial
   * evidence. Pass undefined (the plain method) when there is no current delivery
   * to exclude (e.g. auto-commit, which runs AFTER settlement).
   *
   * Excludes by INSTANCE identity (runId + startedAt), not runId alone: a resume
   * REUSES the runId (see setWorkflowRunNotified's identical fence), so if the
   * model resumes the just-delivered run inside its own notification turn and
   * that resumed instance completes, excluding by runId would also hide the
   * resumed instance's pending notification — the exact partial-evidence bug this
   * guard exists to prevent. startedAt is minted fresh per launch, so only the
   * true current-delivery instance is excluded. */
  hasDeliverablePendingNotificationExcept(
    workspacePath: string,
    threadId: string,
    except: { runId: string; startedAt: string } | undefined
  ): boolean {
    const isCurrentDelivery = (runId: string, startedAt: string): boolean =>
      except !== undefined && runId === except.runId && startedAt === except.startedAt
    // In-flight explicitly counts as busy even for an exhausted run: a
    // hydrate/kick can re-report an exhausted run, and exiting workflow mode
    // mid-report would strand that delivery.
    const deliverableByRunId = (runId: string): boolean =>
      this.inFlightNotifications.has(runId) || !this.isRenotifyExhausted(runId)
    for (const snapshot of this.flushFailedRuns.values()) {
      if (
        snapshot.threadId === threadId &&
        !snapshot.notificationDelivered &&
        !isCurrentDelivery(snapshot.runId, snapshot.startedAt) &&
        deliverableByRunId(snapshot.runId)
      ) {
        return true
      }
    }
    return (
      findUndeliveredTerminalRun(
        workspacePath,
        threadId,
        (run) => !isCurrentDelivery(run.runId, run.startedAt) && deliverableByRunId(run.runId)
      ) !== null
    )
  }

  /** Launches a run in the background. Throws synchronously on invalid state. */
  launch(request: WorkflowLaunchRequest): WorkflowLaunchResult {
    if (this.shuttingDown) {
      throw new Error("The application is quitting; a workflow can no longer be launched.")
    }
    if (this.active.has(request.threadId)) {
      throw new Error(
        `A dynamic workflow (${this.active.get(request.threadId)!.runId}) is already running in this thread. Wait for its task-notification or cancel it from the workflow panel.`
      )
    }
    const integration = this.overlappingIntegrationLease(request.workspacePath)
    if (integration) {
      throw new Error(
        `Cannot launch a workflow while source integration is in progress for ${integration.ownerRunId}.`
      )
    }
    // Deletion tombstone: a foreground turn that outlived its thread's deletion
    // could still reach the workflow tool. Refusing here (rather than silently
    // skipping artifacts) keeps `.cmbdevclaw/workflows/<threadId>` deleted —
    // persistScriptFile below would otherwise mkdir it back — and fails the
    // tool call cleanly instead of starting a run whose every persist and
    // subagent checkpointer is already tombstoned.
    if (isWorkflowRunDirDisposed(request.workspacePath, request.threadId)) {
      throw new Error("This thread has been deleted; a workflow can no longer be launched on it.")
    }
    // No workspace-level mutual exclusion: concurrent workflows over one workspace on
    // different threads remain allowed. Scripts that request worktree isolation
    // get independent checkouts; shared-workspace agents retain their documented
    // overlap risk. The same-thread lock above still serializes one conversation,
    // and auto-commit skips while ANY workflow is active on the workspace.
    // Fresh launch (incl. a resume reusing this runId) → reset its re-notify
    // budget, so a prior run's exhausted attempts don't pre-throttle this one.
    this.renotifyAttempts.delete(request.runId)
    // Drop any stale flush-failed terminal snapshot for this runId: a fresh run REUSES the id, so the
    // old in-memory terminal state is superseded. Without this, get-run/hydrate (which prefer
    // getFlushFailedRun) would keep showing the OLD terminal run instead of the NEW active one — the
    // disk re-persist may still be failing, so it isn't cleared on the success/ack paths.
    this.dropFlushFailedRun(request.runId)

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
      worktrees: request.existingWorktrees ?? [],
      logs: [],
      journal: request.resumeJournal ?? [],
      resumed: request.resumed === true,
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
      settled: Promise.resolve(),
      worktrees: new WorkflowWorktreeLedger({
        workspacePath: request.workspacePath,
        runId: request.runId,
        threadId: request.threadId,
        signal: controller.signal,
        onRecordChange: (record) => {
          runStore.update((run) => {
            const records = run.worktrees ?? []
            const index = records.findIndex((candidate) => candidate.id === record.id)
            run.worktrees =
              index >= 0
                ? records.map((candidate, i) => (i === index ? record : candidate))
                : [...records, record]
          })
          broadcast(request.threadId, {
            type: "workflow_progress",
            workflowEvent: { kind: "worktree_update", runId: request.runId, worktree: record }
          })
        },
        onRecordDelete: (record) => {
          runStore.update((run) => {
            run.worktrees = (run.worktrees ?? []).filter((candidate) => candidate.id !== record.id)
          })
          broadcast(request.threadId, {
            type: "workflow_progress",
            workflowEvent: {
              kind: "worktree_remove",
              runId: request.runId,
              worktreeId: record.id
            }
          })
        }
      })
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
          subagentRunner: async (subRequest) => {
            // Display-only tool stream (best-effort; never affects the run): keep this
            // agent's latest "values" snapshot, broadcast it live while it's being
            // viewed (gated per-agent), and persist the FINAL flow once it settles so it
            // can be opened on demand later — even if you never watched it live.
            let latestSnapshot: unknown
            // resume REUSES the runId, so clear any stale sidecar from a PRIOR run at this
            // <runId>.<callHash>_c<callIndex> path. FIRE-AND-FORGET (never awaited): display I/O must never
            // block the agent. Correctness comes from ORDERING, not waiting — run-store serializes
            // every sidecar op on a per-path chain as write(old) → clear → write(new), so this clear
            // can't delete this run's own finish-write and a prior write's late rename can't
            // resurrect a cleared file, all WITHOUT any awaited I/O on the run's path. A hung write
            // stalls only that chain, not the run. Cached agents skip this runner (sidecar kept).
            void clearAgentToolStream(
              request.workspacePath,
              request.threadId,
              request.runId,
              subRequest.toolStreamKey
            )
            const finishToolStream = (): void => {
              persistAgentToolStream(
                request.workspacePath,
                request.threadId,
                request.runId,
                subRequest.toolStreamKey,
                latestSnapshot
              )
              // Drop the catch-up snapshot now the agent is done — the sidecar is authoritative
              // from here, and the map must not retain one cumulative snapshot per finished agent.
              agentLatestSnapshot.delete(
                agentStreamInterestKey(request.threadId, request.runId, subRequest.agentIndex)
              )
            }
            const spawn = (
              worktreeIsolation?: WorkflowWorktreeIsolationBoundary
            ): Promise<WorkflowSubagentResult> =>
              runWorkflowSubagent(request.subagentDeps, {
                prompt: subRequest.prompt,
                schema: subRequest.schema,
                model: subRequest.model,
                agentIndex: subRequest.agentIndex,
                label: subRequest.label,
                phase: subRequest.phase,
                runId: request.runId,
                signal: subRequest.signal,
                roleSystemPrompt: subRequest.roleSystemPrompt,
                disallowedTools: subRequest.disallowedTools,
                shellAccess: subRequest.shellAccess,
                worktreeIsolation,
                onValues: (snapshot) => {
                  latestSnapshot = snapshot
                  emitWorkflowAgentSnapshot(
                    request.threadId,
                    request.runId,
                    subRequest.agentIndex,
                    subRequest.label,
                    snapshot
                  )
                }
              })

            if (subRequest.isolation !== "worktree") {
              return await spawn().finally(finishToolStream)
            }

            // ── Isolated agent ────────────────────────────────────────────────
            // A failure to provision the worktree FAILS the call. Falling back to
            // the shared workspace would silently give the script less isolation
            // than it asked for — and an isolated fan-out is usually isolated
            // precisely because its agents would otherwise clobber each other.
            // The independent ownership manifest is written before `worktree add`.
            // Do not create it unless this run already has its durable index entry;
            // otherwise an initial run.json write fault followed by a crash would
            // leave a real checkout that history and recovery cannot discover.
            if (
              !(await runStore.whenInitialPersisted) &&
              !runStore.isCurrentSnapshotPersisted()
            ) {
              throw new Error(
                "cannot provision an isolated worktree because the workflow's initial run state was not persisted"
              )
            }
            const worktree = await entry.worktrees.acquire(
              `a${subRequest.agentIndex}-${subRequest.label}`
            )
            try {
              const worktreeIsolation = await resolveWorkflowWorktreeIsolationBoundary(worktree)
              const result = await spawn(worktreeIsolation)
              // Reaching here means the subagent produced a result. Its worktree is
              // kept only if it also left changes behind (settle decides).
              await entry.worktrees.settle(worktree, { succeeded: true }).catch(() => undefined)
              return result
            } catch (error) {
              // Failed / timed out / cancelled: pristine checkouts are removed;
              // changed ones are durably retained as recoverable. Cleanup errors
              // must not mask the agent's real error.
              await entry.worktrees.settle(worktree, { succeeded: false }).catch(() => null)
              throw error
            } finally {
              finishToolStream()
            }
          },
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
        // Reclaim any worktree the run still owns. In the normal case every
        // isolated agent already settled its own (kept or removed) and this is a
        // no-op; it matters when the run was aborted mid-flight, when an agent
        // died in a way that skipped its settle, or when acquire raced the cancel.
        // Kept deliverables are untouched. Awaited (with the ledger's per-worktree
        // timeout) so a completed run never reports finished while checkouts it
        // created are still on disk.
        await entry.worktrees.reclaimAll()
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
        // Publish the terminal fallback BEFORE removing the active lifecycle
        // entry. Readers either wait on the active run or see this snapshot;
        // there must be no gap where only a stale running run.json is visible.
        if (!entry.userCancelled && !finalPersisted) {
          this.flushFailedRuns.set(request.runId, JSON.parse(JSON.stringify(runStore.state)))
          this.flushFailedEpochs.set(request.runId, workflowThreadDisposalEpoch(request.threadId))
          this.flushFailedRevisions.set(request.runId, 0)
        }
        // Keep the run active until its last live-store writer and terminal
        // manifest finalization have settled. UI integration cannot otherwise
        // race this final flush and be overwritten by the in-memory snapshot.
        this.active.delete(request.threadId)
        let protectedRunIds: string[] | undefined
        let pruneAllowed = true
        const repository = await identifyRepository(request.workspacePath)
        if (repository) {
          const manifestState = await listWorkflowWorktreeRecordsForPrune(repository.commonDir)
          if (!manifestState.reliable) {
            pruneAllowed = false
          } else {
            protectedRunIds = manifestState.records.map((record) => record.runId)
          }
        }
        if (pruneAllowed) {
          pruneWorkflowRuns(request.workspacePath, request.threadId, 30, protectedRunIds)
        }
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
                  this.dropFlushFailedRun(id)
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

  /** Cancel every background workflow and give its terminal state a bounded
   * opportunity to flush before the application exits. */
  async cancelAllAndWait(timeoutMs = 5_000): Promise<void> {
    this.shuttingDown = true
    const entries = Array.from(this.active.values())
    if (entries.length === 0) return

    for (const entry of entries) {
      entry.userCancelled = true
      entry.controller.abort()
    }

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled(entries.map((entry) => entry.settled)).then(() => undefined),
        new Promise<void>((resolve) => {
          timeoutTimer = setTimeout(resolve, Math.max(0, timeoutMs))
        })
      ])
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
    }

    // Last chance before the process exits. A run that honoured the abort already
    // reclaimed its worktrees in its own `finally`; this covers the one that did
    // NOT settle within the budget above — its finally will never run, so without
    // this its checkouts survive the shutdown. reclaimAll is idempotent, and its
    // per-worktree timeout bounds the extra wait for a removal that is genuinely
    // stuck; unresolved worktrees remain durable for explicit cleanup.
    await Promise.allSettled(entries.map((entry) => entry.worktrees.reclaimAll()))
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
    // NOTE: this scans in Map INSERTION order (oldest flush-failure first,
    // FIFO reporting) — deliberately NOT the disk path's newest-first; with
    // multiple flush-failed snapshots the earliest completed one reports
    // first, and nothing is lost either way.
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
    this.dropFlushFailedRun(runId)
  }

  /**
   * The in-memory terminal snapshot for a flush-failed run, if any. Zombie
   * reconciliation uses it: a run WITH a snapshot actually finished, so its stale
   * "running" on-disk copy must NOT be flipped to "aborted" (boundary #2).
   */
  getFlushFailedRun(runId: string): PersistedWorkflowRun | undefined {
    return this.flushFailedRuns.get(runId)
  }

  /** Keep a flush-failed run actionable while its run.json is stale. The
   * independent worktree manifest remains the mutation authority; this mirrors
   * its latest record into the in-memory terminal snapshot before a best-effort
   * write-back retry. */
  updateFlushFailedWorktreeRecord(
    runId: string,
    record: WorkflowWorktreeRecord
  ): PersistedWorkflowRun | undefined {
    const snapshot = this.flushFailedRuns.get(runId)
    if (!snapshot || record.runId !== runId) return undefined
    const worktrees = snapshot.worktrees ?? []
    const index = worktrees.findIndex((candidate) => candidate.id === record.id)
    if (index < 0) return undefined
    const current = worktrees[index]
    const next = newerWorkflowWorktreeRecord(current, record)
    if (next === current) return snapshot
    snapshot.worktrees = worktrees.map((candidate, candidateIndex) =>
      candidateIndex === index ? next : candidate
    )
    snapshot.updatedAt = new Date().toISOString()
    this.flushFailedRevisions.set(runId, (this.flushFailedRevisions.get(runId) ?? 0) + 1)
    return snapshot
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
        this.dropFlushFailedRun(runId)
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
   *
   * `expectedStartedAt` is the startedAt of the run snapshot the ack's notification
   * reported — the same fence as markNotified: an old notification's ack must not
   * settle a NEWER instance's flush-failed snapshot (same runId via resume), or that
   * instance's completion would be marked delivered without ever being reported. On
   * mismatch we still retry plain persistence (disk may have recovered) but leave
   * `notificationDelivered` untouched — the new instance's own ack owns that flag.
   *
   * @returns whether the ack path should KICK THE PENDING DRAIN — deliberately NOT
   * "did the write-back land". The two diverge exactly when the disk is still faulty,
   * and that is the case that matters: findPendingNotification reads flushFailedRuns
   * BEFORE the disk, so a snapshot stranded in memory is still perfectly reportable.
   * Gating the kick on disk success stalls it until the next hydrate/reload. A kick can
   * never re-report the run we just acked: on a match the snapshot is marked delivered
   * (memory scan skips it) and its disk copy is still the pre-terminal "running" record
   * (disk scan skips it too); on a mismatch the snapshot IS a never-reported new
   * instance, so serving it is the whole point. When no snapshot exists this run never
   * flush-failed — say nothing and let markNotified's `delivered` govern the kick, which
   * is what guards the ordinary double-report case.
   */
  async recoverFlushFailedRun(
    workspacePath: string,
    threadId: string,
    runId: string,
    expectedStartedAt?: string
  ): Promise<boolean> {
    const snapshot = this.flushFailedRuns.get(runId)
    if (!snapshot) return false
    if (expectedStartedAt !== undefined && snapshot.startedAt !== expectedStartedAt) {
      // Stale ack: never claim the NEW instance's delivered flag — that belongs to its
      // own ack. Best-effort write-back for disk consistency, then kick regardless: an
      // unreported instance exists under this runId, and markNotified already returned
      // false for it (a flush-failed run's disk copy is still "running", and that check
      // precedes markNotified's own fence), so this is its ONLY kick signal.
      await this.retryPersistFlushFailedRun(workspacePath, threadId, runId)
      return true
    }
    snapshot.notificationDelivered = true
    this.flushFailedRevisions.set(runId, (this.flushFailedRevisions.get(runId) ?? 0) + 1)
    await this.persistCurrentFlushFailedRun(workspacePath, threadId, runId)
    // Kick even when the write-back failed: this run is settled either way (delivered in
    // memory, drop deferred to a later retry), and the BACKLOG behind it — other
    // flush-failed snapshots, other terminal runs — must not wait for a hydrate.
    return true
  }

  /**
   * Retry write-back of a flush-failed snapshot from a READ path (get-run / hydrate):
   * the disk may have recovered since the ack-time write-back failed, so this is a
   * real retry entry point instead of leaving it stranded in memory until restart
   * (#3). Does NOT touch notificationDelivered (the ack owns that) — just persists the
   * current snapshot and drops it on success. Read-path callers fire-and-forget; the
   * stale-ack path uses the boolean to decide whether the pending drain is worth a kick.
   */
  async retryPersistFlushFailedRun(
    workspacePath: string,
    threadId: string,
    runId: string
  ): Promise<boolean> {
    return this.persistCurrentFlushFailedRun(workspacePath, threadId, runId)
  }

  /** Persists delivered=true. Called ONLY after the notification turn SUCCEEDS, so
   * a crash mid-turn leaves it false on disk and the run is re-reported.
   * `expectedStartedAt` must be the startedAt of the run snapshot the notification
   * was built from: a resume reuses the runId, so without it a late ack can mark a
   * NEWER instance delivered and swallow that instance's own notification. */
  markNotified(
    workspacePath: string,
    threadId: string,
    runId: string,
    expectedStartedAt?: string
  ): Promise<boolean> {
    return markWorkflowRunNotified(workspacePath, threadId, runId, expectedStartedAt)
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
    if (attempts > MAX_RENOTIFY_ATTEMPTS) {
      // Record the REFUSAL as the exhaustion sentinel (attempts becomes
      // MAX+1). Exhaustion must not be declared one step earlier — at the
      // MAXth broadcast the final re-report is merely SCHEDULED, and treating
      // it as exhausted lets the mode-exit guard unlock before the renderer's
      // timer fires; the renderer then drops the notification (thread no
      // longer in workflow mode) and the last allowed report is silently
      // thrown away.
      this.renotifyAttempts.set(runId, attempts)
      return false
    }
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
    // STRICTLY greater: attempts === MAX means the final re-report has been
    // dispatched and is still pending — deliverable, not exhausted. The
    // sentinel (MAX+1) is written only when a further attempt is refused.
    return (this.renotifyAttempts.get(runId) ?? 0) > MAX_RENOTIFY_ATTEMPTS
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
