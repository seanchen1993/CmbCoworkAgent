import { ipcMain, type IpcMain } from "electron"
import { setWorkflowAgentStreamInterest, workflowRunManager } from "../agent/workflow/run-manager"
import {
  hasUndeliveredWorkflowRunAsync,
  listWorkflowRunsPage,
  loadWorkflowRunAsync,
  markWorkflowRunInterrupted,
  readAgentToolStream,
  toRunSummary,
  updateWorkflowWorktreeRecord,
  updateWorkflowWorktreeRecords
} from "../agent/workflow/run-store"
import type { WorkflowRunListPage } from "../agent/workflow/run-store"
import type {
  PersistedWorkflowRun,
  WorkflowWorktreeRecord
} from "../agent/workflow/types"
import {
  diffWorkflowWorktree,
  cleanupWorkflowWorktree,
  discardWorkflowWorktree,
  finalizeWorkflowWorktreeRecord,
  identifyRepository,
  listWorkflowWorktreeRecords,
  mergeWorkflowWorktree,
  recoverInterruptedWorkflowWorktree
} from "../services/git-worktree"
import { getThreadCore } from "../db"
import {
  assertWorktreeActionPayload,
  type WorkflowWorktreeActionResponse
} from "./workflow-worktree-payload"

/**
 * Dynamic Workflows management IPC — the desktop equivalent of Claude Code's
 * `/workflows`: list runs, drill into one run (agents with prompt/result
 * previews, logs, script — the journal is stripped before crossing IPC, see
 * stripJournalForRenderer), cancel the active run, and hydrate the live panel
 * after a renderer reload / app restart.
 */

function resolveWorkspacePath(threadId: string): string | null {
  const thread = getThreadCore(threadId)
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

async function persistActionWorktreeRecord(
  workspacePath: string,
  threadId: string,
  runId: string,
  record: WorkflowWorktreeRecord
): Promise<PersistedWorkflowRun | null> {
  if (workflowRunManager.getFlushFailedRun(runId)) {
    const snapshot = workflowRunManager.updateFlushFailedWorktreeRecord(runId, record)
    if (snapshot) {
      if (snapshot.threadId !== threadId) return null
      await workflowRunManager.retryPersistFlushFailedRun(workspacePath, threadId, runId)
      return snapshot
    }
    // A concurrent read-path retry may have persisted and removed the in-memory
    // snapshot between the checks above. Continue against that fresh disk copy.
    if (workflowRunManager.getFlushFailedRun(runId)) return null
  }
  return updateWorkflowWorktreeRecord(workspacePath, threadId, runId, record)
}

/** Reconcile crash-remnant per-run records with the independent ownership
 * manifest. A terminal run cannot legitimately still own a running/provisioning
 * worktree, so expose it as recoverable on the first history/hydrate read after a
 * restart. This keeps recovery usable even when no new workflow is launched. */
async function reconcileWorktreeRecordsForRenderer(
  workspacePath: string,
  threadId: string,
  run: PersistedWorkflowRun | null
): Promise<PersistedWorkflowRun | null> {
  if (!run || run.status === "running") return run
  const recordsByCommonDir = new Map<string, Map<string, WorkflowWorktreeRecord>>()
  const manifestIds = new Set<string>()
  let changed = false
  const worktrees: WorkflowWorktreeRecord[] = []
  const repository = await identifyRepository(workspacePath)
  if (repository) {
    const records = await listWorkflowWorktreeRecords(repository.commonDir)
    recordsByCommonDir.set(
      repository.commonDir,
      new Map(records.map((record) => [record.id, record]))
    )
  }
  for (const persisted of run.worktrees ?? []) {
    let records = recordsByCommonDir.get(persisted.commonDir)
    if (!records) {
      const loaded = await listWorkflowWorktreeRecords(persisted.commonDir)
      records = new Map(loaded.map((record) => [record.id, record]))
      recordsByCommonDir.set(persisted.commonDir, records)
    }
    const manifestRecord = records.get(persisted.id)
    if (manifestRecord) manifestIds.add(manifestRecord.id)
    let record = manifestRecord ?? persisted
    if (
      record.status === "provisioning" ||
      record.status === "running" ||
      record.status === "integrating"
    ) {
      try {
        const inspected = await diffWorkflowWorktree({ workspacePath, record })
        record = await recoverInterruptedWorkflowWorktree({
          record: inspected.record,
          error: "application stopped before this worktree operation settled; retained for recovery"
        })
      } catch (error) {
        // Missing/unreadable state cannot authorize mutation or deletion, but a
        // terminal run must not remain falsely "running" forever in the UI.
        const recoveryError = `worktree state is unreadable; retained for manual recovery: ${error instanceof Error ? error.message : String(error)}`
        record = await recoverInterruptedWorkflowWorktree({
          record,
          error: recoveryError
        }).catch(() => ({
          ...record,
          status: "recoverable" as const,
          error: recoveryError,
          updatedAt: new Date().toISOString()
        }))
      }
    }
    if (JSON.stringify(record) !== JSON.stringify(persisted)) changed = true
    worktrees.push(record)
  }
  // The ownership manifest is written before `git worktree add`, while the run
  // snapshot is throttled. Recover records from the narrow crash window where the
  // checkout exists but the run file never learned about it.
  const knownWorktreeIds = new Set(worktrees.map((record) => record.id))
  for (const records of recordsByCommonDir.values()) {
    for (const record of records.values()) {
      if (
        record.runId !== run.runId ||
        record.threadId !== threadId ||
        knownWorktreeIds.has(record.id)
      ) {
        continue
      }
      changed = true
      let recovered = record
      if (
        record.status === "provisioning" ||
        record.status === "running" ||
        record.status === "integrating"
      ) {
        try {
          const inspected = await diffWorkflowWorktree({ workspacePath, record })
          recovered = await recoverInterruptedWorkflowWorktree({
            record: inspected.record,
            error:
              "application stopped before this worktree entered run history; retained for recovery"
          })
        } catch (error) {
          // Keep the manifest visible even when the checkout is unreadable. Its
          // durable provenance still matters, and uncertainty cannot authorize cleanup.
          const recoveryError = `worktree state is unreadable; retained for manual recovery: ${error instanceof Error ? error.message : String(error)}`
          recovered = await recoverInterruptedWorkflowWorktree({
            record,
            error: recoveryError
          }).catch(() => ({
            ...record,
            status: "recoverable" as const,
            error: recoveryError,
            updatedAt: new Date().toISOString()
          }))
        }
      }
      manifestIds.add(recovered.id)
      worktrees.push(recovered)
      knownWorktreeIds.add(recovered.id)
    }
  }
  if (!changed && worktrees.length === 0) return run
  let updated: PersistedWorkflowRun | null = run
  const durableManifestIds = new Set<string>()
  if (changed) {
    const next = await updateWorkflowWorktreeRecords(workspacePath, threadId, run.runId, worktrees)
    if (next) {
      updated = next
      for (const record of worktrees) {
        if (manifestIds.has(record.id)) durableManifestIds.add(record.id)
      }
    }
  } else {
    for (const id of manifestIds) durableManifestIds.add(id)
  }
  // At this point either the run already matched the terminal manifest or the
  // atomic updates above made it match. The small independent tombstone can now
  // be removed without reopening the merge/discard crash window.
  for (const record of worktrees) {
    if (
      durableManifestIds.has(record.id) &&
      (record.status === "merged" || record.status === "discarded")
    ) {
      // Two-phase terminal cleanup: make run.json say cleanup is authorized and
      // complete before deleting the independent manifest. If the process dies
      // between these steps, restart still sees the manifest and can retry the
      // idempotent finalizer instead of losing the only cleanup route.
      const cleanupRecord = {
        ...record,
        cleanupPending: false,
        error: undefined,
        updatedAt: new Date().toISOString()
      }
      const persistedCleanup = await updateWorkflowWorktreeRecord(
        workspacePath,
        threadId,
        run.runId,
        cleanupRecord
      )
      updated = persistedCleanup ?? updated
      const durableCleanup =
        persistedCleanup?.worktrees?.find((candidate) => candidate.id === record.id) ?? null
      const finalized =
        durableCleanup &&
        durableCleanup.status === record.status &&
        durableCleanup.cleanupPending === false
          ? await finalizeWorkflowWorktreeRecord(durableCleanup).catch(() => false)
          : false
      if (!finalized) {
        updated =
          (await updateWorkflowWorktreeRecord(workspacePath, threadId, run.runId, {
            ...cleanupRecord,
            cleanupPending: true,
            updatedAt: new Date().toISOString(),
            error:
              record.error ??
              "terminal cleanup remains pending; retry cleanup from the worktree panel"
          })) ?? updated
      }
    }
  }
  // Return the same monotonic record set that actually reached run.json. The
  // bulk writer may deliberately keep a newer/terminal record over this
  // reconciliation snapshot; replacing it with the local `worktrees` array
  // here would make the renderer regress even though disk stayed correct.
  return updated
}

export function registerWorkflowHandlers(ipc: IpcMain = ipcMain): void {
  ipc.handle(
    "workflow:list-runs",
    async (
      _event,
      {
        threadId,
        cursor,
        limit
      }: { threadId: string; cursor?: string | null; limit?: number }
    ): Promise<WorkflowRunListPage> => {
      const workspacePath = resolveWorkspacePath(threadId)
      if (!workspacePath) return { runs: [], nextCursor: null }
      // Reconcile any crash-remnant "running" runs (not the in-process active
      // one) so the history list doesn't show perpetual "运行中" rows either.
      const activeRunId = workflowRunManager.activeRunId(threadId)
      // A flush-failed run finished but its disk copy is a stale "running" — show its
      // true in-memory terminal summary, and never reconcile it to "aborted" (#4).
      const overlays = workflowRunManager.listFlushFailedRuns(threadId).map(toRunSummary)
      const page = await listWorkflowRunsPage(workspacePath, threadId, {
        cursor,
        limit,
        overlays
      })
      const zombies = page.runs.filter(
        (s) =>
          s.status === "running" &&
          s.runId !== activeRunId &&
          !workflowRunManager.getFlushFailedRun(s.runId)
      )
      if (zombies.length === 0) return page
      const reconciled = await Promise.all(
        zombies.map((s) => markWorkflowRunInterrupted(workspacePath, threadId, s.runId))
      )
      const reconciledById = new Map(
        reconciled.flatMap((run) => (run ? [[run.runId, toRunSummary(run)] as const] : []))
      )
      return {
        ...page,
        runs: page.runs.map((summary) => reconciledById.get(summary.runId) ?? summary)
      }
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
      if (recovered?.threadId === threadId) {
        // Retry the disk write-back (the disk may have recovered) so it isn't
        // stranded in memory until restart (#3); serve the in-memory copy regardless.
        void workflowRunManager.retryPersistFlushFailedRun(workspacePath, threadId, runId)
        return stripJournalForRenderer(recovered)
      }
      let run = await loadWorkflowRunAsync(workspacePath, threadId, runId)
      // Same zombie reconciliation as hydrate, for runs opened from history.
      if (run && run.status === "running" && workflowRunManager.activeRunId(threadId) !== runId) {
        run = await markWorkflowRunInterrupted(workspacePath, threadId, runId)
      }
      run = await reconcileWorktreeRecordsForRenderer(workspacePath, threadId, run)
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

  ipc.handle(
    "workflow:worktree-action",
    async (_event, rawPayload: unknown): Promise<WorkflowWorktreeActionResponse> => {
      const payload = assertWorktreeActionPayload(rawPayload)
      const workspacePath = resolveWorkspacePath(payload.threadId)
      if (!workspacePath) throw new Error("workflow workspace is unavailable")
      await workflowRunManager.waitForRunLifecycle(payload.threadId, payload.runId)
      const performAction = async (): Promise<WorkflowWorktreeActionResponse> => {
        const run =
          workflowRunManager.getFlushFailedRun(payload.runId) ??
          (await loadWorkflowRunAsync(workspacePath, payload.threadId, payload.runId))
        if (!run) throw new Error("workflow run was not found")
        if (run.threadId !== payload.threadId) throw new Error("workflow run ownership mismatch")
        if (run.status === "running") {
          throw new Error("workflow run has not been reconciled yet; refresh its history first")
        }
        const record = run.worktrees?.find((candidate) => candidate.id === payload.worktreeId)
        if (!record || record.runId !== run.runId)
          throw new Error("workflow worktree was not found")

        try {
          let response: WorkflowWorktreeActionResponse
          if (payload.action === "diff") {
            response = await diffWorkflowWorktree({ workspacePath, record })
          } else if (payload.action === "discard") {
            response = await discardWorkflowWorktree({ workspacePath, record })
          } else if (payload.action === "cleanup") {
            response = await cleanupWorkflowWorktree({ workspacePath, record })
          } else {
            // Sibling package workspaces still share one source checkout. Lease
            // that checkout, not the selected package directory, so a merge for
            // /repo/packages/a cannot overlap a workflow/merge for packages/b.
            response = await workflowRunManager.withWorkspaceIntegrationLease(
              record.sourceRoot,
              `ui:${payload.threadId}:${payload.runId}`,
              () => mergeWorkflowWorktree({ workspacePath, record })
            )
          }
          const updated = await persistActionWorktreeRecord(
            workspacePath,
            payload.threadId,
            payload.runId,
            response.record
          )
          if (!updated) throw new Error("failed to persist workflow worktree state")
          const durableRecord =
            updated.worktrees?.find((candidate) => candidate.id === response.record.id) ??
            response.record
          response = { ...response, record: durableRecord }
          workflowRunManager.broadcastWorktreeRecord(payload.threadId, payload.runId, durableRecord)
          if (durableRecord.status === "merged" || durableRecord.status === "discarded") {
            // The independent terminal manifest is the only crash-safe recovery
            // source while run.json remains unwritable. Finalize it only after
            // the in-memory flush-failed snapshot has reached disk.
            const finalized = workflowRunManager.getFlushFailedRun(payload.runId)
              ? false
              : await finalizeWorkflowWorktreeRecord(durableRecord).catch(() => false)
            const cleanupRecord = {
              ...durableRecord,
              cleanupPending: !finalized,
              updatedAt: new Date().toISOString(),
              ...(finalized ? { error: undefined } : {})
            }
            const cleanupUpdated = await persistActionWorktreeRecord(
              workspacePath,
              payload.threadId,
              payload.runId,
              cleanupRecord
            )
            const cleanupDurable =
              cleanupUpdated?.worktrees?.find((candidate) => candidate.id === cleanupRecord.id) ??
              cleanupRecord
            response = { ...response, record: cleanupDurable }
            workflowRunManager.broadcastWorktreeRecord(
              payload.threadId,
              payload.runId,
              cleanupDurable
            )
          }
          return response
        } catch (error) {
          // Merge/setup recovery may advance the independent ownership manifest
          // before throwing. Mirror that state into run history so the UI never
          // stays falsely "ready" after a failed integration attempt.
          const latest = (await listWorkflowWorktreeRecords(record.commonDir)).find(
            (candidate) => candidate.id === record.id
          )
          if (latest) {
            const updated = await persistActionWorktreeRecord(
              workspacePath,
              payload.threadId,
              payload.runId,
              latest
            ).catch(() => undefined)
            const durableRecord =
              updated?.worktrees?.find((candidate) => candidate.id === latest.id) ?? latest
            workflowRunManager.broadcastWorktreeRecord(
              payload.threadId,
              payload.runId,
              durableRecord
            )
          }
          throw error
        }
      }
      // Diff is read-only. Discard/Cleanup touch only the retained checkout and
      // Git administration; the merge branch above alone leases the source.
      return performAction()
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
      // The sidecar is keyed by the COMPOSITE toolStreamKey (<callHash>_c<callIndex>), NOT the
      // execution-order agentIndex (which shifts across resume): callHash separates different agents
      // that land on the same callIndex, callIndex separates same-prompt instances. Resolve
      // agentIndex → toolStreamKey via the persisted run, so a resumed/cached agent reads its OWN
      // flow. No key (pre-feature run, or the agent's state not yet persisted) → null, panel retries.
      // read is centralized in run-store (size cap + parse + ENOENT→null), shared with writer/cleaner.
      // Resolve from the flush-failed in-memory run FIRST (parity with workflow:get-run above): if
      // the final run.json flush failed, the agent's toolStreamKey can live ONLY in the in-memory
      // terminal state, so mapping off stale disk would miss it and return an empty stream even
      // though the sidecar was written. Fall back to disk for the normal (flushed) path.
      const run =
        workflowRunManager.getFlushFailedRun(runId) ??
        (await loadWorkflowRunAsync(workspacePath, threadId, runId))
      const toolStreamKey = run?.agents.find((agent) => agent.index === agentIndex)?.toolStreamKey
      if (toolStreamKey === undefined) return null
      return readAgentToolStream(workspacePath, threadId, runId, toolStreamKey)
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
      const overlays = workflowRunManager.listFlushFailedRuns(threadId).map(toRunSummary)
      const latestPage = await listWorkflowRunsPage(workspacePath, threadId, {
        limit: 1,
        overlays
      })
      // Pick the genuinely-newest run. Active wins; otherwise compare the newest DISK
      // run against the newest memory-only flush-failed snapshot — a run whose INITIAL
      // persist also failed has no disk row, so summaries[0] alone would surface a
      // STALE older run instead of the just-failed one that most needs triage. (#5)
      const latestRunId = activeRunId ?? latestPage.runs[0]?.runId
      // A flush-failed run's disk copy is stale; use its true in-memory terminal
      // state (#4 boundary) instead of parsing the potentially-large stale file
      // or reconciling it to "aborted".
      const recovered = latestRunId ? workflowRunManager.getFlushFailedRun(latestRunId) : undefined
      let latestRun =
        recovered ??
        (latestRunId ? await loadWorkflowRunAsync(workspacePath, threadId, latestRunId) : null)
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
      // DELIBERATE: this consults findPendingNotification WITHOUT the renotify
      // exhaustion filter. "Exhausted" caps the same-process AUTO-retry loop;
      // a hydrate (renderer reload) is a fresh user-driven entry and gives a
      // wedged report one more chance — same at-least-once spirit as the
      // restart-resets-the-budget rule. The mode-exit guards use the stricter
      // deliverable/in-flight semantics instead (hasDeliverablePendingNotification).
      const mightHavePendingNotification =
        overlays.some(
          (summary) =>
            summary.status !== "running" && summary.notificationDelivered !== true
        ) || (await hasUndeliveredWorkflowRunAsync(workspacePath, threadId))
      // Preserve the manager's exact in-flight/flush-failure semantics, but only
      // invoke its legacy synchronous scan when the compact index proves a pending
      // candidate can exist. The normal all-delivered hydrate path stays async/O(1).
      const hasPendingNotification =
        mightHavePendingNotification &&
        workflowRunManager.findPendingNotification(workspacePath, threadId) !== null
      latestRun = await reconcileWorktreeRecordsForRenderer(workspacePath, threadId, latestRun)
      return {
        latestRun: stripJournalForRenderer(latestRun),
        activeRunId,
        hasPendingNotification
      }
    }
  )
}
