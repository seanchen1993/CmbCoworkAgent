import { createHash, randomUUID } from "crypto"
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "fs"
import { mkdir, rename, writeFile } from "fs/promises"
import { join, resolve } from "path"
import type {
  PersistedWorkflowRun,
  WorkflowAgentStateRecord,
  WorkflowJournalEntry,
  WorkflowRunSummary
} from "./types"
import { WORKFLOW_RUN_ID_PATTERN } from "./types"

/** Fields the engine supplies for an agent upsert; timestamps are managed by the store. */
export type WorkflowAgentUpsert = Omit<WorkflowAgentStateRecord, "startedAt" | "endedAt">

/** Keep at most this many run files per thread; older ones are pruned. */
const MAX_RUNS_PER_THREAD = 30

/**
 * Workflow run persistence.
 *
 * Each run is one JSON file under `<workspace>/.cmbdevclaw/workflows/<threadId>/`,
 * written atomically (tmp + rename) with a best-effort `.bak` of the previous
 * good save as corruption fallback. The journal inside the run state powers
 * `resumeFromRunId` content-based replay (each call matches its journal entry by
 * (child/prompt/schema/model) hash, so concurrent/reordered calls still replay).
 */

const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/

export function generateWorkflowRunId(): string {
  return `wf_${randomUUID().replace(/-/g, "").slice(0, 12)}`
}

export function isValidWorkflowRunId(runId: string): boolean {
  return WORKFLOW_RUN_ID_PATTERN.test(runId)
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function assertSafeSegment(value: string, label: string): string {
  if (!SEGMENT_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
  return value
}

export function getWorkflowRunsDir(workspacePath: string, threadId: string): string {
  return join(
    resolve(workspacePath),
    ".cmbdevclaw",
    "workflows",
    assertSafeSegment(threadId, "threadId")
  )
}

/**
 * Removes all persisted workflow artifacts for a thread (run JSON/.bak/.tmp and
 * .workflow.js scripts under `<workspace>/.cmbdevclaw/workflows/<threadId>/`).
 * Called when the thread is deleted so workflow data doesn't outlive it as disk
 * litter. Best-effort. Marks the directory disposed FIRST so that even if an
 * active run is still settling (its abort wait timed out), its late flush is a
 * no-op and cannot recreate the directory — no need to fully settle it first.
 */
export function deleteWorkflowRunsForThread(workspacePath: string, threadId: string): void {
  const dir = getWorkflowRunsDir(workspacePath, threadId)
  // Mark disposed FIRST: a background run still settling (e.g. cancelAndWait
  // timed out) must not recreate this directory via a late flush/persist.
  disposedRunDirs.add(dir)
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    console.warn("[Workflow] Failed to delete run artifacts for thread:", error)
  }
}

export function runFilePath(workspacePath: string, threadId: string, runId: string): string {
  return join(
    getWorkflowRunsDir(workspacePath, threadId),
    `${assertSafeSegment(runId, "runId")}.json`
  )
}

/** Summary sidecar (`<runId>.summary`, no `.json` so it's skipped by the run-file
 * scans): a tiny cache of the list fields, tagged with the run file's mtime, so
 * listing history does NOT parse each run's whole (possibly huge) journal just to
 * render it. Stale (run file rewritten since) or missing → reparse + rewrite. */
function summaryFilePath(workspacePath: string, threadId: string, runId: string): string {
  return join(
    getWorkflowRunsDir(workspacePath, threadId),
    `${assertSafeSegment(runId, "runId")}.summary`
  )
}

/** Journal sidecar (`<runId>.journal`, no `.json` so it's skipped by the run-file
 * scans): the replay journal lives HERE, not inside run.json, so get-run / hydrate
 * / history scan / mark-delivered parse a small run.json and never pay for a
 * (potentially tens-of-MB) journal they don't use. Only resume reads it back, via
 * loadWorkflowRunForResume. */
function journalFilePath(workspacePath: string, threadId: string, runId: string): string {
  return join(
    getWorkflowRunsDir(workspacePath, threadId),
    `${assertSafeSegment(runId, "runId")}.journal`
  )
}

export function toRunSummary(run: PersistedWorkflowRun): WorkflowRunSummary {
  return {
    runId: run.runId,
    workflowName: run.workflowName,
    description: run.description,
    status: run.status,
    stats: run.stats,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    agentCount: run.agents.length
  }
}

function readFreshSidecar(sidecarPath: string, srcMtime: number): WorkflowRunSummary | null {
  try {
    const parsed = JSON.parse(readFileSync(sidecarPath, "utf-8")) as {
      srcMtime?: number
      summary?: WorkflowRunSummary
    }
    if (parsed.srcMtime === srcMtime && parsed.summary) return parsed.summary
  } catch {
    /* missing/corrupt sidecar → caller reparses and rewrites it */
  }
  return null
}

/** Order two runs newest-first by startedAt, with runId as a stable tie-breaker so a
 * same-millisecond startedAt (fast retries / tests / same-ms launches) yields a
 * DETERMINISTIC order instead of an implementation-dependent one. Same-ms can't tell
 * which truly ran later, so the tie-break only guarantees stability, not "correct". */
export function byNewestRun(
  a: { startedAt: string; runId: string },
  b: { startedAt: string; runId: string }
): number {
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1
  return a.runId < b.runId ? 1 : -1
}

/** Lists persisted runs for a thread, newest first. Tolerates corrupt files. */
export function listWorkflowRuns(workspacePath: string, threadId: string): WorkflowRunSummary[] {
  try {
    const dir = getWorkflowRunsDir(workspacePath, threadId)
    if (!existsSync(dir)) return []
    const summaries: WorkflowRunSummary[] = []
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json") || file.endsWith(".bak")) continue
      const runId = file.slice(0, -".json".length)
      if (!isValidWorkflowRunId(runId)) continue
      let srcMtime: number
      try {
        srcMtime = statSync(runFilePath(workspacePath, threadId, runId)).mtimeMs
      } catch {
        continue // vanished between readdir and stat
      }
      // Fast path: a sidecar tagged with the run file's CURRENT mtime lets us skip
      // parsing the (possibly huge) journal. Stale/missing → full parse, then
      // (re)write the sidecar so the next listing is cheap.
      const sidecarPath = summaryFilePath(workspacePath, threadId, runId)
      const cached = readFreshSidecar(sidecarPath, srcMtime)
      if (cached) {
        summaries.push(cached)
        continue
      }
      const run = loadWorkflowRun(workspacePath, threadId, runId)
      if (!run) continue
      const summary = toRunSummary(run)
      summaries.push(summary)
      try {
        writeFileSync(sidecarPath, JSON.stringify({ srcMtime, summary }))
      } catch {
        /* sidecar is a best-effort cache; listing still works without it */
      }
    }
    return summaries.sort(byNewestRun)
  } catch (error) {
    console.warn("[Workflow] Failed to list runs:", error)
    return []
  }
}

/**
 * The newest terminal run whose completion notification has not been delivered,
 * or null. It `stat`s the dir entries (no JSON parse) to order by recency, then
 * parses newest-first and STOPS at the first undelivered run — usually the first
 * (newest) file. `pruneWorkflowRuns` only deletes terminal+delivered runs; running,
 * undelivered, and unreadable run files are exempt so results are never lost. That
 * means this scan is usually small, but is not strictly bounded by
 * MAX_RUNS_PER_THREAD when protected files accumulate.
 */
export function findUndeliveredTerminalRun(
  workspacePath: string,
  threadId: string
): PersistedWorkflowRun | null {
  try {
    const dir = getWorkflowRunsDir(workspacePath, threadId)
    if (!existsSync(dir)) return null
    const candidates: Array<{ runId: string; mtimeMs: number }> = []
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json") || file.endsWith(".bak")) continue
      const runId = file.slice(0, -".json".length)
      if (!isValidWorkflowRunId(runId)) continue
      try {
        candidates.push({ runId, mtimeMs: statSync(join(dir, file)).mtimeMs })
      } catch {
        // entry vanished between readdir and stat — skip
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    // Scan newest-first and parse LAZILY, stopping at the first undelivered
    // terminal run. Do NOT cap at the newest few: a run that finished but was
    // never delivered keeps its original (older) mtime, so newer delivered runs
    // would otherwise bury it past the cap and its result would be lost forever.
    // The common case stops at the first (newest) entry. NOTE: pruneWorkflowRuns
    // now EXEMPTS undelivered/running runs from the MAX_RUNS_PER_THREAD cap (it
    // only deletes terminal+delivered ones) — precisely so this scan never loses
    // an undelivered run; so the count of files here can exceed the cap if many
    // runs stay undelivered (the "don't lose results" invariant wins over the cap).
    for (const candidate of candidates) {
      const run = loadWorkflowRun(workspacePath, threadId, candidate.runId)
      if (run && run.status !== "running" && !run.notificationDelivered) return run
    }
    return null
  } catch (error) {
    console.warn("[Workflow] Failed to scan for pending notification:", error)
    return null
  }
}

/**
 * Sets a TERMINAL run's notification-delivered flag. Safe to call outside an
 * active store: a terminal run's store has flushed and released its generation,
 * so a direct read-modify-write cannot race a live writer. Async I/O so it never
 * blocks the main event loop on the (possibly multi-MB) run file.
 */
async function setWorkflowRunNotified(
  workspacePath: string,
  threadId: string,
  runId: string,
  delivered: boolean
): Promise<boolean> {
  // Returns whether the flag is now (durably) in the requested state. Callers use
  // this to gate follow-up work — e.g. only drain the NEXT pending notification
  // once delivered=true actually hit disk, never on a write error (otherwise the
  // still-undelivered run would be re-selected and double-reported).
  try {
    const run = loadWorkflowRun(workspacePath, threadId, runId)
    if (!run || run.status === "running") return false
    if (Boolean(run.notificationDelivered) === delivered) return true // already in the target state
    run.notificationDelivered = delivered
    run.updatedAt = new Date().toISOString()
    const path = runFilePath(workspacePath, threadId, runId)
    const json = JSON.stringify(run)
    await writeFile(`${path}.tmp`, json)
    await rename(`${path}.tmp`, path)
    return true
  } catch (error) {
    console.warn("[Workflow] Failed to set run notification flag:", error)
    return false
  }
}

/** Marks a run's completion notification as delivered (at-most-once gate). */
export function markWorkflowRunNotified(
  workspacePath: string,
  threadId: string,
  runId: string
): Promise<boolean> {
  return setWorkflowRunNotified(workspacePath, threadId, runId, true)
}

/**
 * Rolls the delivered flag back to false, so a notification turn that FAILED
 * after consuming the run can be retried (the result is never silently lost).
 */
export function rollbackWorkflowRunNotified(
  workspacePath: string,
  threadId: string,
  runId: string
): Promise<boolean> {
  return setWorkflowRunNotified(workspacePath, threadId, runId, false)
}

/**
 * Reconciles a run file left as "running" by an app crash/restart. The caller
 * has already established there is NO in-process run for it, so the persisted
 * "running" status is a stale remnant — flip it to "aborted" (interrupted) and
 * mark its notification delivered (we don't auto-report a crash on startup; the
 * user sees it in the panel/history and can resume from the journal). Returns
 * the reconciled run (or the original/null when nothing to do). Safe direct
 * write: no live writer can exist for a non-active run.
 */
export async function markWorkflowRunInterrupted(
  workspacePath: string,
  threadId: string,
  runId: string
): Promise<PersistedWorkflowRun | null> {
  try {
    const run = loadWorkflowRun(workspacePath, threadId, runId)
    if (!run || run.status !== "running") return run
    run.status = "aborted"
    run.error = run.error ?? "Workflow was interrupted (app restarted before it finished)"
    run.notificationDelivered = true
    const completedAt = run.completedAt ?? new Date().toISOString()
    run.completedAt = completedAt
    run.updatedAt = new Date().toISOString()
    let interruptedAgents = 0
    for (const agent of run.agents) {
      if (agent.status === "running") {
        agent.status = "error"
        agent.error = agent.error ?? "interrupted"
        agent.endedAt = agent.endedAt ?? new Date().toISOString()
        interruptedAgents += 1
      }
    }
    // Keep the displayed stats consistent with the reconciled agent states: the
    // interrupted in-flight agents count as failed, and a never-finalized run
    // has durationMs 0 — fill it from the start→interrupt span.
    run.stats.agentsFailed += interruptedAgents
    if (run.stats.durationMs === 0) {
      const startedMs = Date.parse(run.startedAt)
      const endedMs = Date.parse(completedAt)
      if (Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs) {
        run.stats.durationMs = endedMs - startedMs
      }
    }
    const path = runFilePath(workspacePath, threadId, runId)
    const json = JSON.stringify(run)
    await writeFile(`${path}.tmp`, json)
    await rename(`${path}.tmp`, path)
    return run
  } catch (error) {
    console.warn("[Workflow] Failed to reconcile interrupted run:", error)
    return loadWorkflowRun(workspacePath, threadId, runId)
  }
}

/**
 * Write-back of a run whose live store's FINAL flush failed (disk full), once disk
 * may have recovered: run.json (journal split out) + journal sidecar, atomic
 * tmp+rename. Reconciles the stale on-disk copy so history/hydrate/resume stop
 * reading it. Best-effort: returns false if it still can't write (caller keeps the
 * in-memory snapshot for a later retry).
 */
export async function persistRecoveredRun(
  workspacePath: string,
  threadId: string,
  run: PersistedWorkflowRun
): Promise<boolean> {
  try {
    await mkdir(getWorkflowRunsDir(workspacePath, threadId), { recursive: true })
    const path = runFilePath(workspacePath, threadId, run.runId)
    const journalPath = journalFilePath(workspacePath, threadId, run.runId)
    const json = JSON.stringify({ ...run, journal: [] })
    // Journal first, run.json second — same crash-safe ordering as doWrite (#3): a
    // crash between the renames leaves journal>=run.json (resume re-runs nothing),
    // never run.json>journal (which would re-execute completed edit agents twice).
    await writeFile(`${journalPath}.tmp`, JSON.stringify(run.journal ?? []))
    await rename(`${journalPath}.tmp`, journalPath)
    await writeFile(`${path}.tmp`, json)
    await rename(`${path}.tmp`, path)
    return true
  } catch (error) {
    console.warn(`[Workflow] Failed to write back recovered run ${run.runId}:`, error)
    return false
  }
}

/**
 * Caps accumulated run artifacts per thread by deleting old terminal+delivered
 * runs beyond the newest `keep` files. Running, undelivered, and unreadable runs
 * are kept even when they exceed the cap; preserving results/notifications wins
 * over a hard file-count limit. Best-effort; never throws.
 */
export function pruneWorkflowRuns(
  workspacePath: string,
  threadId: string,
  keep: number = MAX_RUNS_PER_THREAD
): void {
  try {
    const dir = getWorkflowRunsDir(workspacePath, threadId)
    if (!existsSync(dir)) return
    const runs = readdirSync(dir)
      .filter((file) => file.endsWith(".json") && !file.endsWith(".bak"))
      .map((file) => {
        const full = join(dir, file)
        let mtimeMs = 0
        try {
          mtimeMs = statSync(full).mtimeMs
        } catch {
          /* ignore unreadable entry */
        }
        return { runId: file.slice(0, -".json".length), mtimeMs }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const stale of runs.slice(keep)) {
      // NEVER prune a still-running run, or a terminal run whose completion
      // notification was never delivered: an undelivered run keeps its original
      // (older) mtime, so it falls past the cap as newer runs arrive — and
      // findUndeliveredTerminalRun relies on it surviving. Deleting it here would
      // silently lose the run's result (no notification, no resume). If it can't
      // be loaded, keep it (fail safe). Only terminal + delivered runs are pruned.
      const run = loadWorkflowRun(workspacePath, threadId, stale.runId)
      if (!run || run.status === "running" || !run.notificationDelivered) continue
      for (const suffix of [
        ".json",
        ".json.bak",
        ".json.tmp",
        ".workflow.js",
        ".summary",
        ".journal",
        ".journal.tmp"
      ]) {
        try {
          const path = join(dir, `${stale.runId}${suffix}`)
          if (existsSync(path)) unlinkSync(path)
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  } catch (error) {
    console.warn("[Workflow] Run prune failed:", error)
  }
}

/**
 * Like loadWorkflowRun but ALSO loads the replay journal from its sidecar — use
 * this ONLY on the resume path (replaying completed agents). Everything else
 * (get-run / hydrate / history / scan) must use loadWorkflowRun, which leaves the
 * journal empty so it never parses a huge journal it won't use. Falls back to an
 * inline journal for runs persisted before the journal/run split (back-compat).
 */
export function loadWorkflowRunForResume(
  workspacePath: string,
  threadId: string,
  runId: string
): PersistedWorkflowRun | null {
  const run = loadWorkflowRun(workspacePath, threadId, runId)
  if (!run) return null
  // Legacy run persisted with an inline journal (pre-split) — already populated.
  if (run.journal.length > 0) return run
  const journalPath = journalFilePath(workspacePath, threadId, runId)
  // A run whose journal can't be recovered must NOT silently resume with an empty
  // journal — that would RE-RUN every agent (re-applying edit-agent side effects)
  // and overwrite the record under the same runId. A new-format run ALWAYS writes a
  // sidecar (even "[]" for 0 agents), so an absent/corrupt sidecar for a run that
  // ALREADY executed agents means the journal was lost → return null so
  // resolveResumeRun refuses instead of full-rerunning. A genuine 0-agent run has
  // nothing to replay, so it stays resumable. (#3)
  if (!existsSync(journalPath)) {
    return run.agents.length > 0 ? null : run
  }
  try {
    const parsed = JSON.parse(readFileSync(journalPath, "utf-8"))
    if (Array.isArray(parsed)) {
      run.journal = parsed
      return run
    }
    // Parsed but not an array → malformed; treat as a lost journal.
    return run.agents.length > 0 ? null : run
  } catch (error) {
    console.warn(`[Workflow] Failed to read journal sidecar ${journalPath}:`, error)
    return run.agents.length > 0 ? null : run
  }
}

export function loadWorkflowRun(
  workspacePath: string,
  threadId: string,
  runId: string
): PersistedWorkflowRun | null {
  if (!isValidWorkflowRunId(runId)) return null
  const path = runFilePath(workspacePath, threadId, runId)
  for (const candidate of [path, `${path}.bak`]) {
    try {
      if (!existsSync(candidate)) continue
      const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as PersistedWorkflowRun
      if (parsed && parsed.version === 1 && parsed.runId === runId) {
        return parsed
      }
    } catch (error) {
      console.warn(`[Workflow] Failed to read run file ${candidate}:`, error)
    }
  }
  return null
}

export interface WorkflowRunStore {
  /** Mutate-and-save. Saves are throttled; pending state always lands via flush(). */
  update(mutator: (run: PersistedWorkflowRun) => void): void
  /** Upsert a journal entry by lexical call index and save. */
  appendJournal(entry: WorkflowJournalEntry): void
  /** O(1) upsert of one agent's live state record (start → running, then completed/error/cached). */
  upsertAgent(record: WorkflowAgentUpsert): void
  readonly state: PersistedWorkflowRun
  /**
   * Write the final state (with .bak) and wait for it to land. Call once at the
   * end of the run and AWAIT it before reporting the run done. Throttled saves
   * during the run are async and non-blocking; this guarantees durability.
   */
  flush(): Promise<boolean>
  /**
   * Resolves once the INITIAL snapshot has been written to disk (the eager
   * launch-time persist). Await this before reporting a run "launched" so a
   * reload or crash right after the tool returns can still find the run file.
   */
  readonly whenInitialPersisted: Promise<boolean>
}

const SAVE_THROTTLE_MS = 500

/**
 * Latest store generation per run file. An abandoned engine (user aborted the
 * turn but its drain is still finishing) must not overwrite the file after a
 * newer resume of the same runId has taken over.
 */
const storeGenerations = new Map<string, number>()

/**
 * Run directories whose thread has been deleted. Any persist targeting one of
 * these is a no-op, so a background run that settles AFTER its thread was
 * deleted cannot recreate the removed `.cmbdevclaw/workflows/<threadId>/`
 * directory as an orphan (the thread is gone from the DB, so nothing would ever
 * reconcile it). Keyed by the resolved run directory. ThreadIds are unique and
 * never reused, so entries can stay for the process lifetime (tiny, bounded).
 */
const disposedRunDirs = new Set<string>()

export function createWorkflowRunStore(options: {
  workspacePath: string
  threadId: string
  initial: PersistedWorkflowRun
}): WorkflowRunStore {
  const { workspacePath, threadId, initial } = options
  const path = runFilePath(workspacePath, threadId, initial.runId)
  const journalPath = journalFilePath(workspacePath, threadId, initial.runId)
  // Deep-copy so the store never mutates the caller's `initial` object. update/
  // appendJournal/upsertAgent all mutate `state` in place; now that resume keeps
  // an append-only journal (resume no longer wipes it), a live append would push
  // straight into the caller's array — e.g. a resumed run corrupting the journal
  // it was seeded with, or two resumes sharing one journal object. The run is
  // JSON-persisted, so a JSON round-trip is a sound, fully-safe deep clone.
  const state: PersistedWorkflowRun = JSON.parse(JSON.stringify(initial))
  const generation = (storeGenerations.get(path) ?? 0) + 1
  storeGenerations.set(path, generation)

  // O(1) indexes that mirror the persisted arrays, so a large run (up to 1000
  // agents) does not pay O(n²) for the per-agent state upserts and journal
  // appends. Seeded from the initial state (non-empty on resume).
  const agentsByIndex = new Map<number, WorkflowAgentStateRecord>(
    state.agents.map((record) => [record.index, record])
  )
  let maxJournalIndex = state.journal.reduce((max, entry) => Math.max(max, entry.index), -1)

  let dirty = false
  let lastSaveAt = 0
  let timer: NodeJS.Timeout | null = null
  // Serialize all writes so two in-flight async persists never collide on the
  // shared `.tmp` file (the last enqueued write reflects the latest state).
  let writeChain: Promise<void> = Promise.resolve()

  const runDir = getWorkflowRunsDir(workspacePath, threadId)
  // Whether the eager initial snapshot reached disk. Surfaced via
  // whenInitialPersisted so launch can warn the user when the run won't be
  // resumable / won't appear in history (e.g. disk full) instead of silently
  // reporting success — without BLOCKING the launch on a transient fault.
  let initialPersistOk = true
  const doWrite = async (withBak: boolean, isInitial = false): Promise<boolean> => {
    if (storeGenerations.get(path) !== generation || disposedRunDirs.has(runDir)) {
      // A newer store owns this run file now (stale writer), OR the thread was
      // deleted (disposed) — either way, go silent so we never recreate a
      // removed run directory. Not a failure: report success so a flush() caller
      // doesn't treat an intentional skip as a persist error.
      dirty = false
      return true
    }
    dirty = false
    lastSaveAt = Date.now()
    state.updatedAt = new Date().toISOString()
    try {
      await mkdir(getWorkflowRunsDir(workspacePath, threadId), { recursive: true })
      // Journal lives in a SEPARATE sidecar so run.json stays small: get-run /
      // hydrate / history scan / mark-delivered parse run.json without paying for a
      // (potentially tens-of-MB) journal they never use. Only resume reads it back
      // (loadWorkflowRunForResume).
      const json = JSON.stringify({ ...state, journal: [] })
      // Write the JOURNAL first, run.json second (each atomic tmp+rename). Resume
      // replays completed agents from the journal (by content hash), so if we crash
      // BETWEEN the two renames, "journal newer than run.json" is the SAFE ordering:
      // resume sees a complete journal and re-runs nothing already done. The reverse
      // (run.json newer, journal stale) would make resume re-run already-completed
      // agents — re-executing edit agents a second time (duplicate side effects). A
      // momentarily-stale run.json only affects hydrate/history display, not resume
      // correctness. Async I/O so a long run never blocks the Electron main loop. (#3)
      // (tmp+rename each: a torn .journal would otherwise leave an empty/corrupt
      // sidecar and loadWorkflowRunForResume would silently lose the replay cache.)
      await writeFile(`${journalPath}.tmp`, JSON.stringify(state.journal))
      await rename(`${journalPath}.tmp`, journalPath)
      await writeFile(`${path}.tmp`, json)
      await rename(`${path}.tmp`, path)
      if (withBak) {
        // .bak is only written on the final flush — mid-run the atomic
        // tmp+rename already protects the primary file, and skipping the
        // backup halves write volume during the run.
        try {
          await writeFile(`${path}.bak`, json)
        } catch {
          // backup is best-effort; the primary write already succeeded
        }
      }
      return true
    } catch (error) {
      console.warn(`[Workflow] Failed to persist run ${state.runId}:`, error)
      if (isInitial) initialPersistOk = false
      return false
    }
  }

  const enqueueWrite = (withBak: boolean, isInitial = false): Promise<boolean> => {
    // Keep the serialization chain (writeChain) a VOID promise so a failed write
    // never poisons later writes, but return THIS write's success to the caller —
    // flush() / whenInitialPersisted need to know whether it actually persisted.
    const result = writeChain.then(() => doWrite(withBak, isInitial))
    writeChain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  const scheduleSave = (): void => {
    dirty = true
    if (timer) return
    const elapsed = Date.now() - lastSaveAt
    if (elapsed >= SAVE_THROTTLE_MS) {
      void enqueueWrite(false)
      return
    }
    timer = setTimeout(() => {
      timer = null
      if (dirty) void enqueueWrite(false)
    }, SAVE_THROTTLE_MS - elapsed)
    timer.unref?.()
  }

  // Persist the initial snapshot eagerly: the store is created at launch with
  // status:"running" but starts dirty=false, so without this the run isn't on
  // disk until its first throttled update. A crash or reload in that
  // launch→first-progress window would otherwise lose the run entirely (no panel
  // entry, no resume). enqueueWrite(false) KEEPS the generation (unlike flush(),
  // the final write, which drops it). Exposed as whenInitialPersisted so launch
  // can AWAIT it before the tool reports "launched" — making the run durable
  // first, so a reload right after can't miss it.
  // Resolves to whether the initial snapshot actually reached disk. Best-effort: a
  // write fault never blocks launch, but the boolean lets launch warn the user that
  // the run isn't durable (not resumable / absent from history).
  const whenInitialPersisted: Promise<boolean> = enqueueWrite(false, true).then(
    () => initialPersistOk
  )

  return {
    state,
    whenInitialPersisted,
    update(mutator) {
      mutator(state)
      scheduleSave()
    },
    appendJournal(entry) {
      // Common case: lexical call indexes are monotonic, so an append keeps the
      // array sorted with no scan or sort (the engine reads order-independently
      // via a Map, so order is only cosmetic). Replace-by-index — needed when a
      // resume re-runs a changed call — falls back to a scan but is rare.
      if (entry.index > maxJournalIndex) {
        state.journal.push(entry)
        maxJournalIndex = entry.index
      } else {
        const existingIndex = state.journal.findIndex(
          (journalEntry) => journalEntry.index === entry.index
        )
        if (existingIndex >= 0) {
          state.journal[existingIndex] = entry
        } else {
          // Out-of-order insert (not expected in normal flow); keep it tidy.
          state.journal.push(entry)
          state.journal.sort((a, b) => a.index - b.index)
        }
      }
      scheduleSave()
    },
    upsertAgent(record) {
      // O(1) by-index upsert (mirrors run.agents, which the renderer/file read).
      const existing = agentsByIndex.get(record.index)
      if (existing) {
        existing.status = record.status
        existing.error = record.error
        existing.outputTokens = record.outputTokens
        if (record.promptPreview !== undefined) existing.promptPreview = record.promptPreview
        if (record.resultPreview !== undefined) existing.resultPreview = record.resultPreview
        if (record.status !== "running") existing.endedAt = new Date().toISOString()
      } else {
        const created: WorkflowAgentStateRecord = {
          index: record.index,
          label: record.label,
          phase: record.phase,
          status: record.status,
          error: record.error,
          outputTokens: record.outputTokens,
          promptPreview: record.promptPreview,
          resultPreview: record.resultPreview,
          startedAt: new Date().toISOString(),
          endedAt: record.status !== "running" ? new Date().toISOString() : undefined
        }
        state.agents.push(created)
        agentsByIndex.set(record.index, created)
      }
      scheduleSave()
    },
    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      // Chain the final write after any in-flight throttled save and AWAIT it, so
      // the caller knows the run is durably persisted (with .bak). Return whether it
      // actually reached disk so the caller can warn/retry on a final-persist failure.
      const persisted = await enqueueWrite(true)
      // flush() is the run's final write (called from the engine/run-manager
      // after the engine fully drains). If we still own the generation, drop
      // the map entry so it doesn't accumulate one stale key per run for the
      // process lifetime. A later resume of this runId re-registers from 1,
      // which is safe because no overlapping store exists once flush has run.
      // Only drop the generation when the final write actually SUCCEEDED. On
      // failure, KEEP ownership so a retry flush() truly re-attempts the write
      // instead of hitting the stale-writer fast-path above (which returns true and
      // would mask the failure — a pseudo-retry that flips finalPersisted to true
      // and silently bypasses the flushFailedRuns fallback). (#1)
      if (persisted && storeGenerations.get(path) === generation) {
        storeGenerations.delete(path)
      }
      return persisted
    }
  }
}
