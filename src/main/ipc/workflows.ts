import { ipcMain, type IpcMain } from "electron"
import { readFile, stat } from "fs/promises"
import { setWorkflowAgentStreamInterest, workflowRunManager } from "../agent/workflow/run-manager"
import {
  agentToolStreamPath,
  byNewestRun,
  listWorkflowRuns,
  loadWorkflowRun,
  markWorkflowRunInterrupted,
  toRunSummary
} from "../agent/workflow/run-store"
import type { PersistedWorkflowRun, WorkflowRunSummary } from "../agent/workflow/types"
import { getThread } from "../db"

/**
 * Dynamic Workflows management IPC — the desktop equivalent of Claude Code's
 * `/workflows`: list runs, drill into one run (agents with prompt/result
 * previews, logs, script — the journal is stripped before crossing IPC, see
 * stripJournalForRenderer), cancel the active run, and hydrate the live panel
 * after a renderer reload / app restart.
 */

// Upper bound on a per-agent tool-stream sidecar we'll read: well above the ~1MB content
// write budget (plus JSON overhead), but caps a corrupted/externally-grown file.
const WORKFLOW_AGENT_TOOLSTREAM_MAX_BYTES = 8 * 1024 * 1024

function resolveWorkspacePath(threadId: string): string | null {
  const thread = getThread(threadId)
  if (!thread?.metadata) return null
  try {
    const metadata = JSON.parse(thread.metadata) as Record<string, unknown>
    return typeof metadata.workspacePath === "string" ? metadata.workspacePath : null
  } catch {
    return null
  }
}

export interface WorkflowHydrateResult {
  latestRun: PersistedWorkflowRun | null
  activeRunId: string | null
  hasPendingNotification: boolean
}

/**
 * Strips the journal before a run crosses IPC to the renderer. The renderer DTO
 * (PersistedWorkflowRunDTO) never reads `journal`, yet it can be tens of MB on a
 * large run — serializing + shipping it is pure waste. Resume reads the journal
 * main-side via loadWorkflowRun, never from a renderer round-trip, so dropping it
 * here is safe. `script` is intentionally kept — the run dialog renders it.
 */
function stripJournalForRenderer(run: PersistedWorkflowRun | null): PersistedWorkflowRun | null {
  if (!run || run.journal.length === 0) return run
  return { ...run, journal: [] }
}

export function registerWorkflowHandlers(ipc: IpcMain = ipcMain): void {
  ipc.handle(
    "workflow:list-runs",
    async (_event, { threadId }: { threadId: string }): Promise<WorkflowRunSummary[]> => {
      const workspacePath = resolveWorkspacePath(threadId)
      if (!workspacePath) return []
      // Reconcile any crash-remnant "running" runs (not the in-process active
      // one) so the history list doesn't show perpetual "运行中" rows either.
      const activeRunId = workflowRunManager.activeRunId(threadId)
      // A flush-failed run finished but its disk copy is a stale "running" — show its
      // true in-memory terminal summary, and never reconcile it to "aborted" (#4).
      const withSnapshots = (list: WorkflowRunSummary[]): WorkflowRunSummary[] => {
        const merged = list.map((s) => {
          const snapshot = workflowRunManager.getFlushFailedRun(s.runId)
          return snapshot ? toRunSummary(snapshot) : s
        })
        // A run whose INITIAL persist also failed has no disk file to enumerate, so
        // it's absent from `list` — append those memory-only snapshots so the worst
        // disk-fault case (the one most needing triage) stays visible in history. (#5)
        const seen = new Set(merged.map((s) => s.runId))
        for (const snap of workflowRunManager.listFlushFailedRuns(threadId)) {
          if (!seen.has(snap.runId)) merged.push(toRunSummary(snap))
        }
        return merged.sort(byNewestRun)
      }
      const summaries = listWorkflowRuns(workspacePath, threadId)
      const zombies = summaries.filter(
        (s) =>
          s.status === "running" &&
          s.runId !== activeRunId &&
          !workflowRunManager.getFlushFailedRun(s.runId)
      )
      if (zombies.length === 0) return withSnapshots(summaries)
      await Promise.all(
        zombies.map((s) => markWorkflowRunInterrupted(workspacePath, threadId, s.runId))
      )
      return withSnapshots(listWorkflowRuns(workspacePath, threadId))
    }
  )

  ipc.handle(
    "workflow:get-run",
    async (
      _event,
      { threadId, runId }: { threadId: string; runId: string }
    ): Promise<PersistedWorkflowRun | null> => {
      const workspacePath = resolveWorkspacePath(threadId)
      if (!workspacePath) return null
      // A flush-failed run's disk copy is stale; serve its true in-memory terminal
      // state (#4 boundary) instead of reconciling it to "aborted".
      const recovered = workflowRunManager.getFlushFailedRun(runId)
      if (recovered) {
        // Retry the disk write-back (the disk may have recovered) so it isn't
        // stranded in memory until restart (#3); serve the in-memory copy regardless.
        void workflowRunManager.retryPersistFlushFailedRun(workspacePath, threadId, runId)
        return stripJournalForRenderer(recovered)
      }
      const run = loadWorkflowRun(workspacePath, threadId, runId)
      // Same zombie reconciliation as hydrate, for runs opened from history.
      if (run && run.status === "running" && workflowRunManager.activeRunId(threadId) !== runId) {
        return stripJournalForRenderer(
          await markWorkflowRunInterrupted(workspacePath, threadId, runId)
        )
      }
      return stripJournalForRenderer(run)
    }
  )

  ipc.handle(
    "workflow:cancel-run",
    (_event, { threadId, runId }: { threadId: string; runId?: string }): boolean => {
      console.log("[Workflow] Cancel requested:", { threadId, runId })
      return workflowRunManager.cancel(threadId, runId)
    }
  )

  // Display-only: the focus panel registers/deregisters per-AGENT "viewing interest"
  // while it shows a RUNNING agent, so the live tool-stream tap only serializes +
  // broadcasts the one agent you're looking at. No-op for the run itself.
  ipc.handle(
    "workflow:set-agent-stream-interest",
    (
      event,
      {
        threadId,
        runId,
        agentIndex,
        interested
      }: { threadId: string; runId: string; agentIndex: number; interested: boolean }
    ): boolean => {
      // Pass the calling webContents so interest is keyed per-window and self-purges on
      // that window's reload / crash / close (robust to a hard reload that skips the
      // renderer's unmount cleanup).
      setWorkflowAgentStreamInterest(threadId, runId, agentIndex, interested, event.sender)
      return true
    }
  )

  // Display-only: read a FINISHED subagent's persisted complete tool flow on demand
  // (lazy — only the clicked agent). Returns the serialized "values" messages array, or
  // null when there is no sidecar (cached/instant agent, pruned run, or pre-feature run).
  ipc.handle(
    "workflow:get-agent-toolstream",
    async (
      _event,
      { threadId, runId, agentIndex }: { threadId: string; runId: string; agentIndex: number }
    ): Promise<unknown[] | null> => {
      const workspacePath = resolveWorkspacePath(threadId)
      if (!workspacePath) return null
      try {
        const path = agentToolStreamPath(workspacePath, threadId, runId, agentIndex)
        // Defensive size cap: a normal sidecar is bounded (~1MB content write budget plus
        // JSON overhead); refuse to read+parse a corrupted or externally-grown file
        // unbounded into the main process.
        if ((await stat(path)).size > WORKFLOW_AGENT_TOOLSTREAM_MAX_BYTES) return null
        const parsed = JSON.parse(await readFile(path, "utf8")) as { snapshotMessages?: unknown }
        return Array.isArray(parsed.snapshotMessages) ? parsed.snapshotMessages : null
      } catch {
        // Missing sidecar (ENOENT) or unreadable/parse error → no displayable flow.
        return null
      }
    }
  )

  ipc.handle(
    "workflow:hydrate",
    async (_event, { threadId }: { threadId: string }): Promise<WorkflowHydrateResult> => {
      const workspacePath = resolveWorkspacePath(threadId)
      if (!workspacePath) {
        return { latestRun: null, activeRunId: null, hasPendingNotification: false }
      }
      const activeRunId = workflowRunManager.activeRunId(threadId) ?? null
      const summaries = listWorkflowRuns(workspacePath, threadId)
      // Pick the genuinely-newest run. Active wins; otherwise compare the newest DISK
      // run against the newest memory-only flush-failed snapshot — a run whose INITIAL
      // persist also failed has no disk row, so summaries[0] alone would surface a
      // STALE older run instead of the just-failed one that most needs triage. (#5)
      const memLatest = workflowRunManager
        .listFlushFailedRuns(threadId)
        .filter((s) => !summaries.some((d) => d.runId === s.runId))
        .sort(byNewestRun)[0]
      const diskLatest = summaries[0]
      const latestRunId =
        activeRunId ??
        (memLatest && (!diskLatest || byNewestRun(memLatest, diskLatest) < 0)
          ? memLatest.runId
          : diskLatest?.runId)
      let latestRun = latestRunId ? loadWorkflowRun(workspacePath, threadId, latestRunId) : null
      // A flush-failed run's disk copy is stale; use its true in-memory terminal
      // state (#4 boundary) instead of reconciling it to "aborted".
      const recovered = latestRunId ? workflowRunManager.getFlushFailedRun(latestRunId) : undefined
      if (recovered && latestRunId) {
        // Retry the disk write-back (disk may have recovered) — real retry entry (#3).
        void workflowRunManager.retryPersistFlushFailedRun(workspacePath, threadId, latestRunId)
        latestRun = recovered
      } else if (latestRun && latestRun.status === "running" && latestRun.runId !== activeRunId) {
        // Zombie reconciliation: a run persisted as "running" that is NOT the
        // in-process active run is a crash/restart remnant — flip it to "aborted"
        // so the panel shows "已中断" (no dead cancel button) instead of "运行中".
        latestRun = await markWorkflowRunInterrupted(workspacePath, threadId, latestRun.runId)
      }
      const hasPendingNotification =
        workflowRunManager.findPendingNotification(workspacePath, threadId) !== null
      return {
        latestRun: stripJournalForRenderer(latestRun),
        activeRunId,
        hasPendingNotification
      }
    }
  )
}
