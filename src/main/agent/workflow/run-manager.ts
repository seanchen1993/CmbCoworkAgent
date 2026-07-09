import { BrowserWindow, webContents, type WebContents } from "electron"
import { mkdirSync, realpathSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import { serializeWorkflowAgentSnapshotMessages } from "./agent-snapshot"
import { runWorkflowEngine, toJsonSafe } from "./engine"
import { isPathInside } from "./paths"
import {
  clearAgentToolStream,
  createWorkflowRunStore,
  findUndeliveredTerminalRun,
  getWorkflowRunsDir,
  isWorkflowRunDirDisposed,
  markWorkflowRunNotified,
  persistAgentToolStream,
  persistRecoveredRun,
  pruneWorkflowRuns,
  workflowThreadDisposalEpoch
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
  /** Disposal epoch at snapshot capture, in lockstep with flushFailedRuns.
   * persistRecoveredRun mkdirs, so a snapshot from an incarnation deleted
   * since must be DROPPED, not written — even after reviveWorkflowThread
   * cleared the set tombstones for a fixed-id recreation. */
  private readonly flushFailedEpochs = new Map<string, number>()

  private dropFlushFailedRun(runId: string): void {
    this.flushFailedRuns.delete(runId)
    this.flushFailedEpochs.delete(runId)
  }

  isActive(threadId: string): boolean {
    return this.active.has(threadId)
  }

  activeRunId(threadId: string): string | undefined {
    return this.active.get(threadId)?.runId
  }

  /** The workspace of the thread's ACTIVE run, if any. threads:delete uses it
   * as a fallback when the thread's metadata lost its workspacePath — the run
   * entry knows where its artifacts live, so the sweep can still find them. */
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
    return this.hasDeliverablePendingNotification(workspacePath, threadId)
  }

  /** Busy-guard variant of findPendingNotification WITHOUT its first-candidate
   * blind spot: that lookup returns the newest/flush-failed candidate only, so
   * an exhausted (or in-flight) FIRST candidate makes single-candidate guards
   * report idle while an older, perfectly deliverable run still waits — and a
   * workspace switch / mode exit would orphan it off the auto-report path.
   * Deliverable = not delivered AND renotify not exhausted; an in-flight one
   * COUNTS as busy (it stays undelivered until its ack lands). */
  hasDeliverablePendingNotification(workspacePath: string, threadId: string): boolean {
    // In-flight explicitly counts as busy even for an exhausted run: a
    // hydrate/kick can re-report an exhausted run, and exiting workflow mode
    // mid-report would strand that delivery.
    const deliverable = (runId: string): boolean =>
      this.inFlightNotifications.has(runId) || !this.isRenotifyExhausted(runId)
    for (const snapshot of this.flushFailedRuns.values()) {
      if (
        snapshot.threadId === threadId &&
        !snapshot.notificationDelivered &&
        deliverable(snapshot.runId)
      ) {
        return true
      }
    }
    return findUndeliveredTerminalRun(workspacePath, threadId, deliverable) !== null
  }

  /** Launches a run in the background. Throws synchronously on invalid state. */
  launch(request: WorkflowLaunchRequest): WorkflowLaunchResult {
    if (this.active.has(request.threadId)) {
      throw new Error(
        `A dynamic workflow (${this.active.get(request.threadId)!.runId}) is already running in this thread. Wait for its task-notification or cancel it from the workflow panel.`
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
          subagentRunner: (subRequest) => {
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
            return runWorkflowSubagent(request.subagentDeps, {
              prompt: subRequest.prompt,
              schema: subRequest.schema,
              model: subRequest.model,
              agentIndex: subRequest.agentIndex,
              label: subRequest.label,
              runId: request.runId,
              signal: subRequest.signal,
              roleSystemPrompt: subRequest.roleSystemPrompt,
              disallowedTools: subRequest.disallowedTools,
              shellAccess: subRequest.shellAccess,
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
            }).finally(() => {
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
            })
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
            this.flushFailedEpochs.set(request.runId, workflowThreadDisposalEpoch(request.threadId))
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
    if (
      await persistRecoveredRun(
        workspacePath,
        threadId,
        snapshot,
        this.flushFailedEpochs.get(runId)
      )
    ) {
      this.dropFlushFailedRun(runId)
    }
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
    const snapshot = this.flushFailedRuns.get(runId)
    if (!snapshot) return false
    if (
      await persistRecoveredRun(
        workspacePath,
        threadId,
        snapshot,
        this.flushFailedEpochs.get(runId)
      )
    ) {
      this.dropFlushFailedRun(runId)
      return true
    }
    return false
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
