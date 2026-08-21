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
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "fs/promises"
import { basename, dirname, join, resolve } from "path"
import { serializeWorkflowAgentSnapshotMessages } from "./agent-snapshot"
import type {
  PersistedWorkflowRun,
  WorkflowAgentStateRecord,
  WorkflowJournalEntry,
  WorkflowRunSummary,
  WorkflowWorktreeRecord
} from "./types"
import { WORKFLOW_RESULT_SIDECAR_MAX_BYTES, WORKFLOW_RUN_ID_PATTERN } from "./types"

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
 *
 * Fixed-id caveat (documented tradeoff, no attempt token by design): this runs
 * in the deletion's LATE half, after awaited cleanups — a fixed-id thread
 * (heartbeat) revived in that window gets re-tombstoned/epoch-bumped by this
 * late call. Safe today: heartbeat's per-beat revive converges it within one
 * beat, and its runtime never registers the workflow tool (isWorkflowMode
 * only), so no NEW incarnation's workflow artifacts can exist here to be
 * swept. Revisit if fixed-id threads ever gain workflow access.
 */
export function deleteWorkflowRunsForThread(workspacePath: string, threadId: string): void {
  const dir = getWorkflowRunsDir(workspacePath, threadId)
  // Mark disposed FIRST: a background run still settling (e.g. cancelAndWait
  // timed out) must not recreate this directory via a late flush/persist.
  disposedRunDirs.add(dir)
  markWorkflowThreadDisposed(threadId)
  commitWorkflowThreadDisposal(threadId)
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    console.warn("[Workflow] Failed to delete run artifacts for thread:", error)
  }
  const indexPath = workflowRunIndexFilePath(workspacePath, threadId)
  workflowRunIndexCaches.delete(indexPath)
  workflowRunIndexMutationChains.delete(indexPath)
}

export function runFilePath(workspacePath: string, threadId: string, runId: string): string {
  return join(
    getWorkflowRunsDir(workspacePath, threadId),
    `${assertSafeSegment(runId, "runId")}.json`
  )
}

/** Full-result sidecar (`<runId>.result`, no `.json` so it's skipped by the run-file
 * scans): holds the COMPLETE workflow return value (compact JSON) when it exceeds
 * the run record's WORKFLOW_RESULT_MAX_CHARS bound but fits the sidecar cap.
 * run.json keeps only the bounded copy (small for listing / the runs panel); the
 * completion notification's <output-file> points here only when the file is complete. */
export function workflowResultFilePath(
  workspacePath: string,
  threadId: string,
  runId: string
): string {
  return join(
    getWorkflowRunsDir(workspacePath, threadId),
    `${assertSafeSegment(runId, "runId")}.result`
  )
}

/**
 * The file the completion notification advertises as holding the COMPLETE result, or
 * undefined when no file faithfully holds it (so the notification omits the false
 * "full result in <path>"). The run record's `resultSidecarStatus` is the source of
 * truth — never `existsSync` alone, so a stale `.result` left by a failed cleanup is
 * not mistaken for the current result:
 * - "available": the `<runId>.result` sidecar (double-checked it still exists).
 * - "unavailable": truncated but sidecar is missing, over the cap, or failed to
 *   write → no complete file → undefined.
 * - "none": result fit under the bound → run.json holds it whole, but only when the
 *   current terminal run is actually present on disk (flush-failed in-memory snapshots
 *   must not point at a missing/stale run.json).
 * - legacy (absent): run.json, unless its stored result already carries the engine's
 *   truncation marker (then run.json is NOT complete → undefined). Any unknown
 *   `.result` sidecar on a legacy run is deliberately ignored.
 */
export function resolveWorkflowOutputFile(
  workspacePath: string,
  threadId: string,
  run: Pick<PersistedWorkflowRun, "runId" | "result" | "resultSidecarStatus"> &
    Partial<
      Pick<
        PersistedWorkflowRun,
        "status" | "startedAt" | "completedAt" | "scriptSha256" | "updatedAt"
      >
    >
): string | undefined {
  if (run.resultSidecarStatus === "available") {
    const resultPath = workflowResultFilePath(workspacePath, threadId, run.runId)
    return isReadableJsonFile(resultPath) ? resultPath : undefined
  }
  if (run.resultSidecarStatus === "unavailable") return undefined
  if (run.resultSidecarStatus === "none") {
    return resolveCurrentRunJsonOutputFile(workspacePath, threadId, run)
  }
  if (typeof run.result === "string" && /\n…\[truncated \d+ chars\]$/.test(run.result)) {
    return undefined
  }
  return resolveCurrentRunJsonOutputFile(workspacePath, threadId, run)
}

function resolveCurrentRunJsonOutputFile(
  workspacePath: string,
  threadId: string,
  run: Pick<PersistedWorkflowRun, "runId" | "resultSidecarStatus"> &
    Partial<
      Pick<
        PersistedWorkflowRun,
        "status" | "startedAt" | "completedAt" | "scriptSha256" | "updatedAt"
      >
    >
): string | undefined {
  const persisted = loadWorkflowRun(workspacePath, threadId, run.runId)
  if (!persisted) return undefined
  if (run.status !== undefined && persisted.status !== run.status) return undefined
  // A flush-failed in-memory terminal snapshot can share a runId with a stale
  // completed run.json from an earlier generation/resume. Status alone is not a
  // strong enough identity check, so compare every stable identity timestamp/hash
  // the caller supplied before advertising run.json as the complete output file.
  for (const field of ["startedAt", "completedAt", "scriptSha256", "updatedAt"] as const) {
    if (run[field] !== undefined && persisted[field] !== run[field]) return undefined
  }
  if (
    run.resultSidecarStatus !== undefined &&
    persisted.resultSidecarStatus !== run.resultSidecarStatus
  ) {
    return undefined
  }
  return runFilePath(workspacePath, threadId, run.runId)
}

function isReadableJsonFile(path: string): boolean {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return false
    if (stat.size > WORKFLOW_RESULT_SIDECAR_MAX_BYTES) return false
    JSON.parse(readFileSync(path, "utf-8"))
    return true
  } catch {
    return false
  }
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

/** Filename infix of a per-agent tool-stream sidecar = the composite key `<callHash>_c<callIndex>`
 * (e.g. `.<hash>_c12.toolstream`). callHash distinguishes DIFFERENT agents that land on the same
 * callIndex across a resume (cache-hit + live-miss); callIndex distinguishes same-prompt instances;
 * a cached agent uses its ORIGINAL callIndex so it reads its OWN flow. */
function agentToolStreamSuffix(toolStreamKey: string): string {
  return `.${assertSafeSegment(toolStreamKey, "toolStreamKey")}.toolstream`
}

/** Per-agent tool-stream sidecar (`<runId>.<callHash>_c<callIndex>.toolstream`, no `.json` so the
 * run-file scans skip it): the DISPLAY-ONLY complete tool flow of ONE subagent, written once when
 * that agent finishes so its flow can be opened on demand afterwards (a still running agent streams
 * live instead). Keyed by the composite callHash+callIndex (NOT the execution-order agentIndex) —
 * so a resumed/cached agent reads its OWN flow, two same-prompt agents never collide (callIndex),
 * and a cache-hit/live-miss never collide on the same index (callHash). get-agent-toolstream
 * resolves agentIndex → toolStreamKey via run.json. Bounded/truncated; never read by resume/the
 * engine; deleted with the run (prune + thread delete). */
export function agentToolStreamPath(
  workspacePath: string,
  threadId: string,
  runId: string,
  toolStreamKey: string
): string {
  return join(
    getWorkflowRunsDir(workspacePath, threadId),
    `${assertSafeSegment(runId, "runId")}${agentToolStreamSuffix(toolStreamKey)}`
  )
}

const WORKFLOW_AGENT_TOOLSTREAM_MAX_BYTES = 8 * 1024 * 1024
// Upper bound (UI read path ONLY) on how long a read waits for a pending sidecar op before
// reading anyway, so a hung write can't wedge the panel read. Normal ops settle in ms.
const WORKFLOW_AGENT_TOOLSTREAM_READ_WAIT_MS = 3000

// Per-sidecar-path serialized op chain. A re-run's clear is enqueued AFTER the prior run's write
// and BEFORE this run's write, so the order is always write(old) → clear → write(new): clear can
// never delete THIS run's file, and a prior write's late rename can't resurrect a cleared one —
// purely by ordering, with NO awaited I/O on the run's critical path. The run fires these
// fire-and-forget (display I/O must never block the agent); a hung write only stalls this chain,
// not the run. Self-evicting when idle.
const agentSidecarOps = new Map<string, Promise<unknown>>()

function enqueueAgentSidecarOp(path: string, op: () => Promise<void>): Promise<void> {
  const prev = agentSidecarOps.get(path) ?? Promise.resolve()
  const next = prev.then(op, op) // run op regardless of the previous op's outcome
  agentSidecarOps.set(path, next)
  void next.finally(() => {
    if (agentSidecarOps.get(path) === next) agentSidecarOps.delete(path)
  })
  return next
}

/** Write a FINISHED subagent's complete tool flow to its bounded per-agent sidecar so it can
 * be opened on demand later — even an agent you never watched live, or after the run ended.
 * Display-only + best-effort: NEVER throws into the run, NEVER touches run.json/journal/
 * checkpoint. Skips when the agent produced no snapshot (cached/instant/early-error agent); a
 * stale sidecar from a prior same-runId run (resume reuses the runId) is cleared at re-run
 * start by clearAgentToolStream — NOT here — so this never races a delete against the
 * finish-time read. */
export function persistAgentToolStream(
  workspacePath: string,
  threadId: string,
  runId: string,
  toolStreamKey: string,
  snapshot: unknown
): void {
  try {
    if (isWorkflowRunDirDisposed(workspacePath, threadId)) return
    const snapshotMessages = serializeWorkflowAgentSnapshotMessages(snapshot)
    if (!snapshotMessages || snapshotMessages.length === 0) return
    const path = agentToolStreamPath(workspacePath, threadId, runId, toolStreamKey)
    const payload = JSON.stringify({ runId, toolStreamKey, snapshotMessages })
    // Atomic write (tmp + rename, like run.json/journal): a crash mid-write leaves a stray
    // .tmp (swept by prune/thread-delete), never a half-written .toolstream the reader chokes
    // on; rename is atomic on one filesystem, so a concurrent read sees old-or-new, never torn.
    // Enqueued on the per-path op chain so a re-run's clear is ordered BEFORE this write (clear
    // can't delete it) and any prior write is ordered before that clear (no late-rename resurrect).
    // Fire-and-forget — never blocks the event loop or the run's settle. No mkdir: an active run
    // already created the dir, so a late write after thread-delete just ENOENTs.
    void enqueueAgentSidecarOp(path, async () => {
      try {
        await writeFile(`${path}.tmp`, payload)
        await rename(`${path}.tmp`, path)
      } catch {
        /* best-effort display-only */
      }
    })
  } catch {
    /* serialization is best-effort and display-only */
  }
}

/** Delete a per-agent tool-stream sidecar for a (re-)running agent. resume reuses the runId
 * (tool.ts), so without this a re-run that errors before any snapshot — or whose new write hasn't
 * landed when the finished-state UI reads — would let the panel show the PRIOR run's stream.
 * Enqueued on the per-path op chain (after any in-flight write, before the next write), so the
 * delete is strictly ordered: it never races or deletes THIS run's own write, and a prior write's
 * late rename can't resurrect a cleared file — with NO awaited I/O on the run's critical path.
 * Returns the op promise (tests await it; the runner fires it fire-and-forget so it never blocks
 * the agent). Cached agents skip the runner, so their valid sidecar is preserved. */
export function clearAgentToolStream(
  workspacePath: string,
  threadId: string,
  runId: string,
  toolStreamKey: string
): Promise<void> {
  const path = agentToolStreamPath(workspacePath, threadId, runId, toolStreamKey)
  return enqueueAgentSidecarOp(path, async () => {
    try {
      await unlink(path)
    } catch {
      /* no prior sidecar (fresh run) or already gone — fine */
    }
    try {
      await unlink(`${path}.tmp`)
    } catch {
      /* no stray tmp from an interrupted write — fine */
    }
  })
}

/** Clear ALL per-agent tool-stream sidecars for a runId. Used when a resume DROPS the journal
 * (script/args changed): the re-run REUSES the runId but its agents now have different callHashes,
 * so the prior run's `<runId>.<oldHash>_cN.toolstream` files are orphaned — the per-agent runner only
 * clears the CURRENT agent's key, never the removed/reordered ones. Sweeping them once at launch
 * (after approval, before the fresh run writes any sidecar) stops disk garbage piling up across
 * repeated edit-and-resume. NEVER blocks the launch on display I/O (mirrors persist/clear): an
 * in-flight write of this run could rename a file AFTER a bare sync sweep and revive the orphan, so
 * instead of AWAITING those writes (which would put hung display I/O on the launch path) we enqueue
 * an ordered delete on each pending path's OWN op chain — it runs AFTER that write's rename (no
 * revival) and BEFORE the fresh run's writes (this runs first, pre-launch). Everything already on
 * disk is swept synchronously (fast metadata ops, never waits). Globs by the runId prefix +
 * .toolstream suffix, same as pruneWorkflowRuns. */
export function clearAllAgentToolStreams(
  workspacePath: string,
  threadId: string,
  runId: string
): void {
  if (!isValidWorkflowRunId(runId)) return
  const dir = getWorkflowRunsDir(workspacePath, threadId)
  const prefix = `${runId}.`
  // In-flight writes for THIS run (op map keyed by full path): enqueue an ordered delete on each so
  // it runs after the write's rename — no await, so a hung write can't stall the launch.
  const pathPrefix = join(dir, prefix)
  for (const opPath of agentSidecarOps.keys()) {
    if (!opPath.startsWith(pathPrefix)) continue
    void enqueueAgentSidecarOp(opPath, async () => {
      try {
        await unlink(opPath)
      } catch {
        /* already gone / never written */
      }
      try {
        await unlink(`${opPath}.tmp`)
      } catch {
        /* no stray tmp */
      }
    })
  }
  // Sweep everything ALREADY on disk (settled writes / paths with no pending op). Sync metadata ops.
  try {
    for (const file of readdirSync(dir)) {
      if (
        file.startsWith(prefix) &&
        (file.endsWith(".toolstream") || file.endsWith(".toolstream.tmp"))
      ) {
        try {
          unlinkSync(join(dir, file))
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  } catch {
    /* dir may not exist yet (first run) — nothing to clear */
  }
}

/** Read a finished subagent's persisted tool flow (the serialized "values" messages), or null
 * when there is no sidecar (cached/instant agent, pruned/pre-feature run) or it is unreadable/
 * corrupt/over the size cap. */
export async function readAgentToolStream(
  workspacePath: string,
  threadId: string,
  runId: string,
  toolStreamKey: string
): Promise<unknown[] | null> {
  const path = agentToolStreamPath(workspacePath, threadId, runId, toolStreamKey)
  // Wait for any pending op on this path (a queued clear/write) to settle FIRST, so the UI reads
  // the POST-op state — never a stale file a queued clear is about to delete (the chain only
  // orders writes; without this the read could still beat the clear). This is on the UI's read
  // path ONLY (never the run's), so it can't block the agent; bounded so a hung write can't wedge
  // the read — on timeout we read whatever is on disk.
  const pending = agentSidecarOps.get(path)
  if (pending) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      pending.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, WORKFLOW_AGENT_TOOLSTREAM_READ_WAIT_MS)
      })
    ])
    if (timer) clearTimeout(timer)
  }
  try {
    // Defensive size cap: a normal sidecar is bounded (~1MB content budget + JSON overhead);
    // refuse to read+parse a corrupted/externally-grown file unbounded into memory.
    if ((await stat(path)).size > WORKFLOW_AGENT_TOOLSTREAM_MAX_BYTES) return null
    const parsed = JSON.parse(await readFile(path, "utf8")) as { snapshotMessages?: unknown }
    if (!Array.isArray(parsed.snapshotMessages)) return null
    // Drop non-object elements (null / string / primitive / old-format / half-corrupt): the renderer
    // reads `message.kwargs` on each, so a bad element would throw and break the panel. A corrupted or
    // externally-edited sidecar then degrades to the valid messages (or empty), never a crash.
    return parsed.snapshotMessages.filter((m): m is object => m !== null && typeof m === "object")
  } catch {
    return null
  }
}

export function toRunSummary(run: PersistedWorkflowRun): WorkflowRunSummary {
  return {
    runId: run.runId,
    workflowName: run.workflowName,
    description: run.description,
    status: run.status,
    stats: { ...run.stats },
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    agentCount: run.agents.length,
    notificationDelivered: run.notificationDelivered === true
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

const WORKFLOW_RUN_LIST_DEFAULT_LIMIT = 50
const WORKFLOW_RUN_LIST_MAX_LIMIT = 100
const WORKFLOW_RUN_SUMMARY_BACKFILL_CONCURRENCY = 8
const WORKFLOW_RUN_INDEX_VERSION = 1

interface WorkflowRunIndexEntry {
  runId: string
  startedAt: string
  status?: WorkflowRunSummary["status"]
  notificationDelivered?: boolean
}

interface WorkflowRunIndexFile {
  version: 1
  entries: WorkflowRunIndexEntry[]
  pendingNotificationRunIds?: string[]
}

interface WorkflowRunIndexCache {
  entries: Map<string, WorkflowRunIndexEntry>
  summaries: Map<string, WorkflowRunSummary>
  sortedEntries: WorkflowRunIndexEntry[] | null
  /** null means a legacy index still needs one async summary pass. */
  pendingNotificationRunIds: Set<string> | null
  discovered: boolean
  ready: Promise<void>
  discoveryPromise: Promise<void> | null
}

export interface WorkflowRunListPage {
  runs: WorkflowRunSummary[]
  nextCursor: string | null
}

export interface WorkflowRunListOptions {
  cursor?: string | null
  limit?: number
  overlays?: readonly WorkflowRunSummary[]
}

const workflowRunIndexCaches = new Map<string, WorkflowRunIndexCache>()
const workflowRunIndexMutationChains = new Map<string, Promise<void>>()

export function workflowRunIndexFilePath(workspacePath: string, threadId: string): string {
  return join(getWorkflowRunsDir(workspacePath, threadId), "runs.index")
}

function isWorkflowRunSummary(value: unknown): value is WorkflowRunSummary {
  if (!value || typeof value !== "object") return false
  const summary = value as Partial<WorkflowRunSummary>
  return (
    typeof summary.runId === "string" &&
    isValidWorkflowRunId(summary.runId) &&
    typeof summary.workflowName === "string" &&
    typeof summary.startedAt === "string" &&
    typeof summary.status === "string" &&
    typeof summary.agentCount === "number" &&
    typeof summary.notificationDelivered === "boolean" &&
    !!summary.stats &&
    typeof summary.stats === "object"
  )
}

function decodeWorkflowRunCursor(cursor: string | null | undefined): WorkflowRunIndexEntry | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      runId?: unknown
      startedAt?: unknown
    }
    if (
      typeof parsed.runId !== "string" ||
      !isValidWorkflowRunId(parsed.runId) ||
      typeof parsed.startedAt !== "string"
    ) {
      return null
    }
    return { runId: parsed.runId, startedAt: parsed.startedAt }
  } catch {
    return null
  }
}

function encodeWorkflowRunCursor(entry: WorkflowRunIndexEntry): string {
  return Buffer.from(JSON.stringify(entry), "utf8").toString("base64url")
}

function normalizeWorkflowRunListLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return WORKFLOW_RUN_LIST_DEFAULT_LIMIT
  return Math.max(1, Math.min(WORKFLOW_RUN_LIST_MAX_LIMIT, Math.floor(limit!)))
}

export function selectWorkflowRunPage<T extends { runId: string; startedAt: string }>(
  orderedRuns: readonly T[],
  cursorValue?: string | null,
  requestedLimit?: number
): { items: T[]; nextCursor: string | null } {
  const cursor = decodeWorkflowRunCursor(cursorValue)
  let start = 0
  if (cursor) {
    // First item strictly OLDER than the stable tuple. New runs inserted before
    // the cursor therefore never duplicate or shift an already-viewed page.
    let low = 0
    let high = orderedRuns.length
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      if (byNewestRun(orderedRuns[middle], cursor) <= 0) low = middle + 1
      else high = middle
    }
    start = low
  }
  const limit = normalizeWorkflowRunListLimit(requestedLimit)
  const items = orderedRuns.slice(start, start + limit)
  const hasMore = start + items.length < orderedRuns.length
  return {
    items,
    nextCursor:
      hasMore && items.length > 0 ? encodeWorkflowRunCursor(items[items.length - 1]) : null
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(values[index])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  )
  return results
}

function getWorkflowRunIndexCache(
  workspacePath: string,
  threadId: string
): WorkflowRunIndexCache {
  const indexPath = workflowRunIndexFilePath(workspacePath, threadId)
  const existing = workflowRunIndexCaches.get(indexPath)
  if (existing) return existing

  const cache: WorkflowRunIndexCache = {
    entries: new Map(),
    summaries: new Map(),
    sortedEntries: null,
    pendingNotificationRunIds: null,
    discovered: false,
    ready: Promise.resolve(),
    discoveryPromise: null
  }
  cache.ready = (async () => {
    try {
      const parsed = JSON.parse(await readFile(indexPath, "utf8")) as Partial<WorkflowRunIndexFile>
      if (parsed.version !== WORKFLOW_RUN_INDEX_VERSION || !Array.isArray(parsed.entries)) return
      for (const entry of parsed.entries) {
        if (
          entry &&
          typeof entry.runId === "string" &&
          isValidWorkflowRunId(entry.runId) &&
          typeof entry.startedAt === "string"
        ) {
          cache.entries.set(entry.runId, {
            runId: entry.runId,
            startedAt: entry.startedAt,
            ...(typeof entry.status === "string"
              ? { status: entry.status as WorkflowRunSummary["status"] }
              : {}),
            ...(typeof entry.notificationDelivered === "boolean"
              ? { notificationDelivered: entry.notificationDelivered }
              : {})
          })
        }
      }
      if (Array.isArray(parsed.pendingNotificationRunIds)) {
        cache.pendingNotificationRunIds = new Set(
          parsed.pendingNotificationRunIds.filter(
            (runId): runId is string =>
              typeof runId === "string" && isValidWorkflowRunId(runId)
          )
        )
      }
    } catch {
      // Missing/corrupt index is rebuilt asynchronously from per-run summaries.
    }
  })()
  workflowRunIndexCaches.set(indexPath, cache)
  return cache
}

async function writeWorkflowRunIndex(
  workspacePath: string,
  threadId: string,
  cache: WorkflowRunIndexCache
): Promise<void> {
  const indexPath = workflowRunIndexFilePath(workspacePath, threadId)
  const temp = `${indexPath}.${randomUUID()}.tmp`
  const payload: WorkflowRunIndexFile = {
    version: WORKFLOW_RUN_INDEX_VERSION,
    entries: Array.from(cache.entries.values()).sort(byNewestRun),
    ...(cache.pendingNotificationRunIds
      ? { pendingNotificationRunIds: Array.from(cache.pendingNotificationRunIds) }
      : {})
  }
  try {
    await writeFile(temp, JSON.stringify(payload))
    await rename(temp, indexPath)
  } finally {
    await unlink(temp).catch(() => undefined)
  }
}

async function withWorkflowRunIndexMutation(
  workspacePath: string,
  threadId: string,
  task: (cache: WorkflowRunIndexCache) => Promise<void>
): Promise<void> {
  const indexPath = workflowRunIndexFilePath(workspacePath, threadId)
  const previous = workflowRunIndexMutationChains.get(indexPath) ?? Promise.resolve()
  const operation = previous.then(async () => {
    const cache = getWorkflowRunIndexCache(workspacePath, threadId)
    await cache.ready
    await task(cache)
  })
  const tail = operation.catch(() => undefined)
  workflowRunIndexMutationChains.set(indexPath, tail)
  try {
    await operation
  } finally {
    if (workflowRunIndexMutationChains.get(indexPath) === tail) {
      workflowRunIndexMutationChains.delete(indexPath)
    }
  }
}

async function writeWorkflowRunSummarySidecar(
  workspacePath: string,
  threadId: string,
  runId: string,
  srcMtime: number,
  summary: WorkflowRunSummary
): Promise<void> {
  const sidecarPath = summaryFilePath(workspacePath, threadId, runId)
  const temp = `${sidecarPath}.${randomUUID()}.tmp`
  try {
    await writeFile(
      temp,
      JSON.stringify({ version: 1, srcMtime, summary })
    )
    await rename(temp, sidecarPath)
  } finally {
    await unlink(temp).catch(() => undefined)
  }
}

async function persistWorkflowRunSummaryArtifacts(
  workspacePath: string,
  threadId: string,
  run: PersistedWorkflowRun
): Promise<void> {
  try {
    const summary = toRunSummary(run)
    const srcMtime = (await stat(runFilePath(workspacePath, threadId, run.runId))).mtimeMs
    await writeWorkflowRunSummarySidecar(
      workspacePath,
      threadId,
      run.runId,
      srcMtime,
      summary
    )
    await withWorkflowRunIndexMutation(workspacePath, threadId, async (cache) => {
      cache.summaries.set(run.runId, summary)
      let pendingMembershipChanged = false
      if (cache.pendingNotificationRunIds) {
        if (summary.status !== "running" && summary.notificationDelivered !== true) {
          if (!cache.pendingNotificationRunIds.has(run.runId)) {
            cache.pendingNotificationRunIds.add(run.runId)
            pendingMembershipChanged = true
          }
        } else {
          pendingMembershipChanged = cache.pendingNotificationRunIds.delete(run.runId)
        }
      }
      const current = cache.entries.get(run.runId)
      const indexMetadataChanged =
        current?.startedAt !== run.startedAt ||
        current?.status !== summary.status ||
        current?.notificationDelivered !== summary.notificationDelivered
      if (!indexMetadataChanged) {
        // The pending-notification set is persisted with the index even when the
        // stable ordering tuple did not change (for example, notification ack).
        if (pendingMembershipChanged) {
          await writeWorkflowRunIndex(workspacePath, threadId, cache)
        }
        return
      }
      cache.entries.set(run.runId, {
        runId: run.runId,
        startedAt: run.startedAt,
        status: summary.status,
        notificationDelivered: summary.notificationDelivered
      })
      if (current?.startedAt !== run.startedAt) cache.sortedEntries = null
      await writeWorkflowRunIndex(workspacePath, threadId, cache)
    })
  } catch (error) {
    console.warn(`[Workflow] Failed to update summary index for ${run.runId}:`, error)
  }
}

function removeWorkflowRunsFromSummaryIndex(
  workspacePath: string,
  threadId: string,
  runIds: readonly string[]
): void {
  if (runIds.length === 0) return
  void withWorkflowRunIndexMutation(workspacePath, threadId, async (cache) => {
    let changed = false
    for (const runId of runIds) {
      changed = cache.entries.delete(runId) || changed
      cache.summaries.delete(runId)
      cache.pendingNotificationRunIds?.delete(runId)
    }
    if (!changed) return
    cache.sortedEntries = null
    await writeWorkflowRunIndex(workspacePath, threadId, cache)
  }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[Workflow] Failed to prune workflow summary index:", error)
    }
  })
}

async function readWorkflowRunSummaryAsync(
  workspacePath: string,
  threadId: string,
  runId: string
): Promise<WorkflowRunSummary | null> {
  const runPath = runFilePath(workspacePath, threadId, runId)
  let srcMtime: number
  try {
    srcMtime = (await stat(runPath)).mtimeMs
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(
      await readFile(summaryFilePath(workspacePath, threadId, runId), "utf8")
    ) as { srcMtime?: unknown; summary?: unknown }
    if (parsed.srcMtime === srcMtime && isWorkflowRunSummary(parsed.summary)) {
      return parsed.summary
    }
  } catch {
    // Legacy run without a fresh sidecar is repaired below.
  }
  const run = await loadWorkflowRunAsync(workspacePath, threadId, runId)
  if (!run) return null
  const summary = toRunSummary(run)
  await writeWorkflowRunSummarySidecar(
    workspacePath,
    threadId,
    runId,
    srcMtime,
    summary
  ).catch(() => undefined)
  return summary
}

async function ensureWorkflowRunIndexDiscovered(
  workspacePath: string,
  threadId: string
): Promise<WorkflowRunIndexCache> {
  const cache = getWorkflowRunIndexCache(workspacePath, threadId)
  await cache.ready
  if (cache.discovered) return cache
  if (!cache.discoveryPromise) {
    cache.discoveryPromise = withWorkflowRunIndexMutation(
      workspacePath,
      threadId,
      async (mutable) => {
        if (mutable.discovered) return
        const dir = getWorkflowRunsDir(workspacePath, threadId)
        let files: string[]
        try {
          files = await readdir(dir)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          mutable.entries.clear()
          mutable.summaries.clear()
          mutable.sortedEntries = []
          mutable.pendingNotificationRunIds = new Set()
          mutable.discovered = true
          return
        }
        const runIds = files.flatMap((file) => {
          if (!file.endsWith(".json") || file.endsWith(".bak")) return []
          const runId = file.slice(0, -".json".length)
          return isValidWorkflowRunId(runId) ? [runId] : []
        })
        const runIdSet = new Set(runIds)
        let changed = false
        for (const runId of mutable.entries.keys()) {
          if (runIdSet.has(runId)) continue
          mutable.entries.delete(runId)
          mutable.summaries.delete(runId)
          mutable.pendingNotificationRunIds?.delete(runId)
          changed = true
        }
        // Legacy entries lack notification metadata. Running/pending entries are
        // also revalidated once per process so a crash between run.json and index
        // renames cannot hide a newly-terminal result or retain an already-acked one.
        const missing = runIds.filter((runId) => {
          const entry = mutable.entries.get(runId)
          return (
            !entry ||
            entry.status === undefined ||
            entry.notificationDelivered === undefined ||
            entry.status === "running" ||
            entry.notificationDelivered === false
          )
        })
        const repaired = await mapWithConcurrency(
          missing,
          WORKFLOW_RUN_SUMMARY_BACKFILL_CONCURRENCY,
          async (runId) => ({
            runId,
            summary: await readWorkflowRunSummaryAsync(workspacePath, threadId, runId)
          })
        )
        for (const { runId, summary } of repaired) {
          if (!summary) continue
          mutable.entries.set(runId, {
            runId,
            startedAt: summary.startedAt,
            status: summary.status,
            notificationDelivered: summary.notificationDelivered
          })
          mutable.summaries.set(runId, summary)
          changed = true
        }
        const pendingNotificationRunIds = new Set(
          Array.from(mutable.entries.values()).flatMap((entry) =>
            entry.status !== undefined &&
            entry.status !== "running" &&
            entry.notificationDelivered === false
              ? [entry.runId]
              : []
          )
        )
        if (
          !mutable.pendingNotificationRunIds ||
          mutable.pendingNotificationRunIds.size !== pendingNotificationRunIds.size ||
          Array.from(pendingNotificationRunIds).some(
            (runId) => !mutable.pendingNotificationRunIds?.has(runId)
          )
        ) {
          mutable.pendingNotificationRunIds = pendingNotificationRunIds
          changed = true
        }
        mutable.discovered = true
        if (changed) {
          mutable.sortedEntries = null
          await writeWorkflowRunIndex(workspacePath, threadId, mutable)
        }
      }
    ).finally(() => {
      cache.discoveryPromise = null
    })
  }
  await cache.discoveryPromise
  return cache
}

/** Async, stable-cursor history API used by IPC. It never calls synchronous fs APIs. */
export async function listWorkflowRunsPage(
  workspacePath: string,
  threadId: string,
  options: WorkflowRunListOptions = {}
): Promise<WorkflowRunListPage> {
  const cache = await ensureWorkflowRunIndexDiscovered(workspacePath, threadId)
  const overlays = new Map((options.overlays ?? []).map((summary) => [summary.runId, summary]))
  const orderedById = new Map(cache.entries)
  for (const summary of overlays.values()) {
    orderedById.set(summary.runId, { runId: summary.runId, startedAt: summary.startedAt })
  }
  const entries =
    overlays.size === 0
      ? (cache.sortedEntries ??= Array.from(orderedById.values()).sort(byNewestRun))
      : Array.from(orderedById.values()).sort(byNewestRun)
  const selectedPage = selectWorkflowRunPage(entries, options.cursor, options.limit)
  const selected = selectedPage.items
  const loaded = await mapWithConcurrency(
    selected,
    WORKFLOW_RUN_SUMMARY_BACKFILL_CONCURRENCY,
    async (entry) => {
      const overlay = overlays.get(entry.runId)
      if (overlay) return overlay
      const cached = cache.summaries.get(entry.runId)
      if (cached) return cached
      const summary = await readWorkflowRunSummaryAsync(workspacePath, threadId, entry.runId)
      if (summary) cache.summaries.set(entry.runId, summary)
      return summary
    }
  )
  const runs = loaded.filter((summary): summary is WorkflowRunSummary => summary !== null)
  return {
    runs,
    nextCursor: selectedPage.nextCursor
  }
}

/** Async preflight for hydrate. It walks compact summaries in bounded batches,
 * so the common all-delivered case never falls back to the legacy synchronous
 * full-directory notification scan. */
export async function hasUndeliveredWorkflowRunAsync(
  workspacePath: string,
  threadId: string
): Promise<boolean> {
  const cache = await ensureWorkflowRunIndexDiscovered(workspacePath, threadId)
  return (cache.pendingNotificationRunIds?.size ?? 0) > 0
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

/** Thread deletion must not erase the only UI recovery route for retained agent
 * work. Corrupt/unreadable run files fail closed by reporting an unresolved item. */
export function countUnresolvedWorkflowWorktrees(
  workspacePath: string,
  threadId: string,
  options: { failClosedOnUnreadable?: boolean } = {}
): number {
  const failClosed = options.failClosedOnUnreadable ?? true
  const dir = getWorkflowRunsDir(workspacePath, threadId)
  if (!existsSync(dir)) return 0
  let unresolved = 0
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return failClosed ? 1 : 0
  }
  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".bak")) continue
    const runId = file.slice(0, -".json".length)
    if (!isValidWorkflowRunId(runId)) continue
    const run = loadWorkflowRun(workspacePath, threadId, runId)
    if (!run) {
      if (failClosed) unresolved += 1
      continue
    }
    unresolved += (run.worktrees ?? []).filter(
      (record) =>
        (record.status !== "merged" && record.status !== "discarded") ||
        record.cleanupPending === true ||
        existsSync(record.directory)
    ).length
  }
  return unresolved
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
  threadId: string,
  // Busy-guard support: keep scanning past undelivered runs the caller deems
  // ineligible (e.g. renotify-exhausted) instead of stopping at the first —
  // a single-candidate answer has a blind spot when the newest pending is
  // exhausted but an older one is still perfectly deliverable. Receives the
  // fully-loaded run (not just the runId) so a caller can fence by instance
  // identity (runId + startedAt) — a resume REUSES the runId, so runId alone
  // cannot tell a superseded instance from the current one.
  isEligible?: (run: PersistedWorkflowRun) => boolean
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
      if (run && run.status !== "running" && !run.notificationDelivered) {
        if (isEligible && !isEligible(run)) continue
        return run
      }
    }
    return null
  } catch (error) {
    console.warn("[Workflow] Failed to scan for pending notification:", error)
    return null
  }
}

const runFileMutationChains = new Map<string, Promise<void>>()

const TERMINAL_WORKTREE_STATUSES = new Set(["merged", "discarded"])

/** Keep durable worktree state monotonic when recovery/UI/reconciliation writers
 * meet. A terminal decision is irreversible. For non-terminal records the
 * manifest timestamp is authoritative, so an older inspection cannot put a
 * worktree back into ready/running after integration or recovery advanced it. */
export function newerWorkflowWorktreeRecord(
  current: WorkflowWorktreeRecord | undefined,
  incoming: WorkflowWorktreeRecord
): WorkflowWorktreeRecord {
  if (!current) return incoming
  const currentTerminal = TERMINAL_WORKTREE_STATUSES.has(current.status)
  const incomingTerminal = TERMINAL_WORKTREE_STATUSES.has(incoming.status)
  if (currentTerminal) {
    if (incoming.status !== current.status) return current
    return incoming.updatedAt >= current.updatedAt ? incoming : current
  }
  if (incomingTerminal) return incoming
  return incoming.updatedAt >= current.updatedAt ? incoming : current
}

async function withRunFileMutation<T>(target: string, task: () => Promise<T>): Promise<T> {
  const previous = runFileMutationChains.get(target) ?? Promise.resolve()
  const operation = previous.then(task, task)
  const tail = operation.then(
    () => undefined,
    () => undefined
  )
  runFileMutationChains.set(target, tail)
  try {
    return await operation
  } finally {
    if (runFileMutationChains.get(target) === tail) runFileMutationChains.delete(target)
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
  delivered: boolean,
  expectedStartedAt?: string
): Promise<boolean> {
  // Returns whether the flag is now (durably) in the requested state. Callers use
  // this to gate follow-up work — e.g. only drain the NEXT pending notification
  // once delivered=true actually hit disk, never on a write error (otherwise the
  // still-undelivered run would be re-selected and double-reported).
  const path = runFilePath(workspacePath, threadId, runId)
  return withRunFileMutation(path, async () => {
    let temp: string | undefined
    try {
      const run = await loadWorkflowRunAsync(workspacePath, threadId, runId)
      if (!run || run.status === "running") return false
      // Instance fence. A resume REUSES the runId, and the error notification itself
      // tells the model to resume — so the resume is launched INSIDE the very turn
      // that will later ack that error notification. A sub-second resumed run reaches
      // terminal before the ack lands, so the status!=="running" guard above lets the
      // stale ack through and it marks the NEW run delivered, permanently swallowing
      // that run's own completion notification. `startedAt` is minted fresh on every
      // launch, so a mismatch proves this ack belongs to a superseded instance whose
      // record is already overwritten: no-op, and report settled (nothing to persist;
      // the new run stays undelivered and its notification still fires).
      if (expectedStartedAt !== undefined && run.startedAt !== expectedStartedAt) return true
      if (Boolean(run.notificationDelivered) === delivered) return true // already in the target state
      run.notificationDelivered = delivered
      run.updatedAt = new Date().toISOString()
      const json = JSON.stringify(run)
      temp = `${path}.notification-${randomUUID()}.tmp`
      await writeFile(temp, json)
      await rename(temp, path)
      temp = undefined
      await persistWorkflowRunSummaryArtifacts(workspacePath, threadId, run)
      return true
    } catch (error) {
      console.warn("[Workflow] Failed to set run notification flag:", error)
      return false
    } finally {
      if (temp) await unlink(temp).catch(() => undefined)
    }
  })
}

/** Marks a run's completion notification as delivered (at-most-once gate).
 * `expectedStartedAt` fences the write to the run INSTANCE the notification was
 * built from — omit only when no instance is known (cancel path: the run about to
 * be marked is the one being cancelled). */
export function markWorkflowRunNotified(
  workspacePath: string,
  threadId: string,
  runId: string,
  expectedStartedAt?: string
): Promise<boolean> {
  return setWorkflowRunNotified(workspacePath, threadId, runId, true, expectedStartedAt)
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
  const target = runFilePath(workspacePath, threadId, runId)
  return withRunFileMutation(target, async () => {
    let temp: string | undefined
    try {
      const run = await loadWorkflowRunAsync(workspacePath, threadId, runId)
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
      const json = JSON.stringify(run)
      temp = `${target}.interrupted-${randomUUID()}.tmp`
      await writeFile(temp, json)
      await rename(temp, target)
      temp = undefined
      await persistWorkflowRunSummaryArtifacts(workspacePath, threadId, run)
      return run
    } catch (error) {
      console.warn("[Workflow] Failed to reconcile interrupted run:", error)
      return loadWorkflowRunAsync(workspacePath, threadId, runId)
    } finally {
      if (temp) await unlink(temp).catch(() => undefined)
    }
  })
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
  run: PersistedWorkflowRun,
  expectedDisposalEpoch?: number
): Promise<boolean> {
  // Deletion tombstone: this writer mkdirs, so an in-flight retry that grabbed
  // its snapshot BEFORE forgetThread() cleared the table could otherwise
  // rebuild the removed `.cmbdevclaw/workflows/<threadId>` after the sweep.
  // The set tombstones alone aren't enough: reviveWorkflowThread (fixed-id
  // recreation) clears them, which must never re-arm an OLD incarnation's
  // snapshot — callers stamp the disposal epoch at capture time, and an epoch
  // mismatch means the snapshot predates a deletion. Report success either
  // way so the caller drops the snapshot — for a dead incarnation, dropping
  // IS the recovery.
  // Two tombstone tiers with different verdicts: epoch/dir mismatch means the
  // incarnation is DEAD — report success so the caller drops the snapshot.
  // A bare set-hit means a deletion attempt is merely IN PROGRESS (it may yet
  // roll back) — report failure so the caller KEEPS the snapshot for a later
  // retry instead of losing the run's terminal state on a failed delete.
  const isDeadIncarnation = (): boolean =>
    disposedRunDirs.has(getWorkflowRunsDir(workspacePath, threadId)) ||
    (expectedDisposalEpoch !== undefined &&
      expectedDisposalEpoch !== (threadDisposalEpochs.get(threadId) ?? 0))
  const isStale = (): boolean => isDeadIncarnation() || disposedThreadIds.has(threadId)
  if (isStale()) {
    return isDeadIncarnation()
  }
  const target = runFilePath(workspacePath, threadId, run.runId)
  return withRunFileMutation(target, async () => {
    if (isStale()) return isDeadIncarnation()
    let journalTemp: string | undefined
    let runTemp: string | undefined
    let backupTemp: string | undefined
    try {
      await mkdir(getWorkflowRunsDir(workspacePath, threadId), { recursive: true })
      // Post-await recheck: a deletion landing DURING the mkdir already swept the
      // dir; writing now would rebuild it as an orphan (mirrors doWrite). Remove
      // the empty dir our mkdir may have rebuilt — tombstone-active only; an
      // epoch-only mismatch means a revived incarnation may own the dir.
      if (isStale()) {
        const dir = getWorkflowRunsDir(workspacePath, threadId)
        // Dir-tombstone-only rm (see sweepRacedRunDir): a bare id-set hit is a
        // rollback-able deletion ATTEMPT — the dir may still belong to the
        // surviving thread and must not be touched.
        if (disposedRunDirs.has(dir)) sweepRacedRunDir(dir)
        return isDeadIncarnation()
      }
      const journalPath = journalFilePath(workspacePath, threadId, run.runId)
      let recoveredRun = run
      if (
        run.resultSidecarStatus === "available" &&
        !isReadableJsonFile(workflowResultFilePath(workspacePath, threadId, run.runId))
      ) {
        recoveredRun = { ...run, resultSidecarStatus: "unavailable" }
      }
      const current = await loadWorkflowRunAsync(workspacePath, threadId, run.runId)
      if (current?.startedAt === recoveredRun.startedAt) {
        // A notification ack or worktree action may have landed while this
        // flush-failed snapshot waited for recovery. Preserve those newer terminal
        // facts instead of overwriting the entire run with the stale snapshot.
        const currentById = new Map((current.worktrees ?? []).map((record) => [record.id, record]))
        const recoveredWorktrees = (recoveredRun.worktrees ?? []).map((record) =>
          newerWorkflowWorktreeRecord(currentById.get(record.id), record)
        )
        recoveredRun = {
          ...recoveredRun,
          notificationDelivered:
            Boolean(recoveredRun.notificationDelivered) || Boolean(current.notificationDelivered),
          // The terminal in-memory snapshot owns membership: an absent id may
          // have been deliberately removed after a pristine worktree cleanup.
          // Disk can contribute a newer state only for ids the snapshot retains.
          worktrees: recoveredWorktrees
        }
      }
      const json = JSON.stringify({ ...recoveredRun, journal: [] })
      // Journal first, run.json second — same crash-safe ordering as doWrite (#3): a
      // crash between the renames leaves journal>=run.json (resume re-runs nothing),
      // never run.json>journal (which would re-execute completed edit agents twice).
      journalTemp = `${journalPath}.recovered-${randomUUID()}.tmp`
      await writeFile(journalTemp, JSON.stringify(recoveredRun.journal ?? []))
      await rename(journalTemp, journalPath)
      journalTemp = undefined
      runTemp = `${target}.recovered-${randomUUID()}.tmp`
      await writeFile(runTemp, json)
      await rename(runTemp, target)
      runTemp = undefined
      // A recovered terminal snapshot is just as authoritative as a normal
      // final flush. Keep the fallback in step so a later damaged primary file
      // cannot resurrect an older worktree state.
      const backupPath = `${target}.bak`
      backupTemp = `${backupPath}.recovered-${randomUUID()}.tmp`
      await writeFile(backupTemp, json)
      await rename(backupTemp, backupPath)
      backupTemp = undefined
      await persistWorkflowRunSummaryArtifacts(workspacePath, threadId, recoveredRun)
      return true
    } catch (error) {
      console.warn(`[Workflow] Failed to write back recovered run ${run.runId}:`, error)
      return false
    } finally {
      if (journalTemp) await unlink(journalTemp).catch(() => undefined)
      if (runTemp) await unlink(runTemp).catch(() => undefined)
      if (backupTemp) await unlink(backupTemp).catch(() => undefined)
    }
  })
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
  keep: number = MAX_RUNS_PER_THREAD,
  protectedRunIds: Iterable<string> = []
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
    const manifestRunIds = new Set(protectedRunIds)
    const removedRunIds: string[] = []
    for (const stale of runs.slice(keep)) {
      // NEVER prune a still-running run, or a terminal run whose completion
      // notification was never delivered: an undelivered run keeps its original
      // (older) mtime, so it falls past the cap as newer runs arrive — and
      // findUndeliveredTerminalRun relies on it surviving. Deleting it here would
      // silently lose the run's result (no notification, no resume). If it can't
      // be loaded, keep it (fail safe). Only terminal + delivered runs are pruned.
      const run = loadWorkflowRun(workspacePath, threadId, stale.runId)
      const hasUnresolvedWorktrees =
        run?.worktrees?.some((record) => {
          if (record.status !== "merged" && record.status !== "discarded") return true
          if (existsSync(record.directory)) return true
          // A terminal manifest outlives checkout removal until run history has
          // durably observed it. Keep that run so restart reconciliation still
          // has a route to finalize a branch-only/tombstone cleanup.
          const identity = createHash("sha256").update(record.id).digest("hex").slice(0, 16)
          try {
            return readdirSync(join(dirname(record.directory), ".records")).some((file) =>
              file.endsWith(`-${identity}.json`)
            )
          } catch (error) {
            // ENOENT means the ownership store is genuinely absent. Any other
            // read failure is unknown state and must retain the run fail-closed.
            return (error as NodeJS.ErrnoException).code !== "ENOENT"
          }
        }) ?? false
      if (
        !run ||
        run.status === "running" ||
        !run.notificationDelivered ||
        hasUnresolvedWorktrees ||
        manifestRunIds.has(stale.runId)
      ) {
        continue
      }
      for (const suffix of [
        ".json",
        ".json.bak",
        ".json.tmp",
        ".workflow.js",
        ".summary",
        ".journal",
        ".journal.tmp",
        ".result",
        ".result.tmp"
      ]) {
        try {
          const path = join(dir, `${stale.runId}${suffix}`)
          if (existsSync(path)) unlinkSync(path)
        } catch {
          /* best-effort cleanup */
        }
      }
      // Per-agent tool-stream sidecars (`<runId>.<callHash>_c<callIndex>.toolstream`, plus any `.tmp` left by
      // a crash mid atomic-write) are variable in count, so glob by the runId prefix + the
      // .toolstream suffix. The trailing "." in the prefix keeps it from matching a different run
      // whose id extends this one, and the .toolstream suffix excludes .json/.journal/etc.
      try {
        const toolStreamPrefix = `${stale.runId}.`
        for (const file of readdirSync(dir)) {
          if (
            file.startsWith(toolStreamPrefix) &&
            (file.endsWith(".toolstream") || file.endsWith(".toolstream.tmp"))
          ) {
            try {
              unlinkSync(join(dir, file))
            } catch {
              /* best-effort cleanup */
            }
          }
        }
      } catch {
        /* best-effort cleanup */
      }
      if (!existsSync(runFilePath(workspacePath, threadId, stale.runId))) {
        removedRunIds.push(stale.runId)
      }
    }
    removeWorkflowRunsFromSummaryIndex(workspacePath, threadId, removedRunIds)
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

/** Async resume reader for Electron main-process call paths. It preserves the
 * fail-closed journal semantics above without synchronously parsing a potentially
 * large run or replay sidecar on the event loop. */
export async function loadWorkflowRunForResumeAsync(
  workspacePath: string,
  threadId: string,
  runId: string
): Promise<PersistedWorkflowRun | null> {
  const run = await loadWorkflowRunAsync(workspacePath, threadId, runId)
  if (!run) return null
  if (run.journal.length > 0) return run
  const journalPath = journalFilePath(workspacePath, threadId, runId)
  try {
    const parsed = JSON.parse(await readFile(journalPath, "utf8"))
    if (Array.isArray(parsed)) {
      run.journal = parsed
      return run
    }
    return run.agents.length > 0 ? null : run
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[Workflow] Failed to read journal sidecar ${journalPath}:`, error)
    }
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

/** Async run reader for renderer/IPC paths. Runtime compatibility paths retain
 * `loadWorkflowRun`, while Electron handlers avoid synchronous disk I/O. */
export async function loadWorkflowRunAsync(
  workspacePath: string,
  threadId: string,
  runId: string
): Promise<PersistedWorkflowRun | null> {
  if (!isValidWorkflowRunId(runId)) return null
  const path = runFilePath(workspacePath, threadId, runId)
  for (const candidate of [path, `${path}.bak`]) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as PersistedWorkflowRun
      if (parsed && parsed.version === 1 && parsed.runId === runId) return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[Workflow] Failed to read run file ${candidate}:`, error)
      }
    }
  }
  return null
}

/** Atomically update one durable worktree entry on a terminal run without
 * touching the split journal sidecar. IPC rejects active runs before calling
 * this, so the live WorkflowRunStore cannot race this writer. Calls from two UI
 * windows are still serialized per run file here. */
export async function updateWorkflowWorktreeRecord(
  workspacePath: string,
  threadId: string,
  runId: string,
  record: WorkflowWorktreeRecord
): Promise<PersistedWorkflowRun | null> {
  return updateWorkflowWorktreeRecords(workspacePath, threadId, runId, [record])
}

export async function updateWorkflowWorktreeRecords(
  workspacePath: string,
  threadId: string,
  runId: string,
  records: WorkflowWorktreeRecord[]
): Promise<PersistedWorkflowRun | null> {
  if (!isValidWorkflowRunId(runId) || records.some((record) => record.runId !== runId)) {
    return null
  }
  const target = runFilePath(workspacePath, threadId, runId)
  return withRunFileMutation(target, async () => {
    const run = await loadWorkflowRunAsync(workspacePath, threadId, runId)
    if (!run) return null
    const worktrees = run.worktrees ?? []
    const indexById = new Map(worktrees.map((candidate, index) => [candidate.id, index]))
    for (const record of records) {
      const index = indexById.get(record.id)
      if (index === undefined) {
        indexById.set(record.id, worktrees.length)
        worktrees.push(record)
      } else {
        worktrees[index] = newerWorkflowWorktreeRecord(worktrees[index], record)
      }
    }
    run.worktrees = worktrees
    run.updatedAt = new Date().toISOString()
    const json = JSON.stringify({ ...run, journal: [] })
    const temp = `${target}.worktree-${randomUUID()}.tmp`
    try {
      await writeFile(temp, json)
      await rename(temp, target)
      // loadWorkflowRun automatically falls back to this backup if the primary
      // file is damaged. Terminal worktree actions happen after the normal final
      // flush, so keep the fallback current with their Merge/Discard/Cleanup state.
      try {
        await writeFile(`${target}.bak`, json)
      } catch {
        // The primary terminal record is durable; preserve the existing
        // best-effort backup behavior used by the normal final flush.
      }
      return run
    } finally {
      await unlink(temp).catch(() => undefined)
    }
  })
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
   * Persist (resultJson != null) or clear (null) the COMPLETE result in the
   * `<runId>.result` sidecar, serialized through the same write chain as the run
   * file and guarded by the same stale-writer / disposed-dir checks. Returns whether
   * the write actually succeeded (false on I/O failure) so finalize can record
   * `resultSidecarStatus`. Clearing (null) is best-effort — the status, not the
   * file's presence, is the reader's source of truth.
   */
  persistFullResult(resultJson: string | null): Promise<boolean>
  /**
   * Resolves once the INITIAL snapshot has been written to disk (the eager
   * launch-time persist). Await this before reporting a run "launched" so a
   * reload or crash right after the tool returns can still find the run file.
   */
  readonly whenInitialPersisted: Promise<boolean>
  /** True only when disk contains this live store's current run incarnation.
   * A resumed run reuses runId, so existence alone is not a sufficient fence. */
  isCurrentSnapshotPersisted(): boolean
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

/** Best-effort removal of a run dir that a raced mkdir just rebuilt AFTER the
 * deletion's rmSync already ran (the post-mkdir recheck caught the writer, but
 * the empty dir would otherwise linger forever — nothing sweeps again). Callers
 * must gate on disposedRunDirs — the DIR tombstone is set exactly where the
 * real sweep ran, i.e. the deletion passed its point of no return. NEVER gate
 * on the bare id set (a deletion ATTEMPT that may roll back — rm here would
 * destroy a surviving thread's artifacts) nor on generation/epoch-only
 * staleness (a newer resume store or revived incarnation may own the dir). */
function sweepRacedRunDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

/**
 * ThreadId-keyed twin of disposedRunDirs. The dir-keyed set can only be
 * populated when thread deletion resolves a workspacePath; if the thread's
 * metadata lost it, no dir tombstone registers and a late writer would
 * recreate the run directory. Writers always know their own threadId, so this
 * set closes that gap regardless of metadata health. Same lifetime rationale:
 * threadIds are unique and never reused.
 */
const disposedThreadIds = new Set<string>()

/**
 * Incarnation fence for live store instances. reviveWorkflowThread() clears the
 * SET tombstones so a legitimately re-created id (heartbeat) can persist again
 * — but that must never un-poison a store BORN BEFORE the deletion: its
 * doWrite mkdirs, so one late flush would rebuild the swept run directory.
 * Only commitWorkflowThreadDisposal bumps the epoch — at the deletion's point
 * of no return (mark alone is a rollback-able attempt and must not silence
 * live stores). One deletion may bump more than once (threads:delete commits
 * after the DB delete AND deleteWorkflowRunsForThread commits again);
 * harmless, the fence only needs the old store's birth epoch to no longer
 * match. A store captures the epoch at creation and goes permanently silent
 * once they differ. Revive deliberately does NOT touch epochs.
 */
const threadDisposalEpochs = new Map<string, number>()

export function workflowThreadDisposalEpoch(threadId: string): number {
  return threadDisposalEpochs.get(threadId) ?? 0
}

/** Tombstone a deleted thread by id alone — callable even when its
 * workspacePath is unknown. Gates NEW work (launches, recovered write-backs,
 * toolstream enqueues) in every workspace. Deliberately does NOT bump the
 * disposal epoch: live stores keep persisting until the deletion's point of
 * no return (commitWorkflowThreadDisposal), so a deletion attempt that fails
 * pre-DB-delete never silently ate an active run's terminal flush. */
export function markWorkflowThreadDisposed(threadId: string): void {
  disposedThreadIds.add(threadId)
}

/** The deletion's point of no return (DB row removed): bump the incarnation
 * epoch so every store/snapshot born BEFORE it goes permanently silent —
 * revive-immune (revive clears the sets, never epochs). */
export function commitWorkflowThreadDisposal(threadId: string): void {
  threadDisposalEpochs.set(threadId, (threadDisposalEpochs.get(threadId) ?? 0) + 1)
}

/** Whether the id-keyed tombstone is currently set (deletion in progress or
 * completed this process). Lets a deletion attempt capture the prior state so
 * its failure rollback restores membership instead of blindly clearing it —
 * blind clearing would lift a tombstone an earlier COMPLETED deletion set. */
export function isWorkflowThreadMarkedDisposed(threadId: string): boolean {
  return disposedThreadIds.has(threadId)
}

/** Undo a markWorkflowThreadDisposed made by a deletion attempt that FAILED
 * before its point of no return (the DB row still exists): the thread
 * survives, so launches must work again. Restores the PRIOR membership rather
 * than blindly clearing — the id may have been legitimately tombstoned by an
 * earlier completed deletion. Epochs need no rollback: they only bump at the
 * point of no return, which a failed attempt never reached. */
export function rollbackWorkflowThreadDisposal(threadId: string, priorDisposed: boolean): void {
  if (!priorDisposed) disposedThreadIds.delete(threadId)
}

/** Lift the disposal tombstones for a thread id that is being legitimately
 * re-created (fixed-id service threads like heartbeat — see
 * reviveRetiredThread in runtime.ts for the contract). Clears both the
 * id-keyed entry and any dir-keyed entries (the run dir's basename IS the
 * threadId), so the new incarnation can persist workflow runs again.
 * Deliberately does NOT reset the disposal epoch: stores created before the
 * deletion stay permanently silent — revive must never re-arm an old
 * incarnation's late flush (its doWrite mkdirs the swept directory back). */
export function reviveWorkflowThread(threadId: string): void {
  disposedThreadIds.delete(threadId)
  for (const dir of Array.from(disposedRunDirs)) {
    if (basename(dir) === threadId) disposedRunDirs.delete(dir)
  }
}

/** True once a thread's run directory has been disposed (thread deleted): a late,
 * fire-and-forget write (e.g. a subagent tool-stream sidecar still settling) must check
 * this and skip, so it can't recreate the removed `.cmbdevclaw/workflows/<threadId>/`
 * as an orphan after the thread is gone. */
export function isWorkflowRunDirDisposed(workspacePath: string, threadId: string): boolean {
  return (
    disposedThreadIds.has(threadId) ||
    disposedRunDirs.has(getWorkflowRunsDir(workspacePath, threadId))
  )
}

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
  // Disposal epoch at birth: if the thread gets deleted after this store was
  // created, the epochs diverge and every later write goes silent — even if a
  // revive (fixed-id recreation) has cleared the id/dir tombstones since.
  const bornDisposalEpoch = threadDisposalEpochs.get(threadId) ?? 0

  // O(1) indexes that mirror the persisted arrays, so a large run (up to 1000
  // agents) does not pay O(n²) for the per-agent state upserts and journal
  // appends. Seeded from the initial state (non-empty on resume).
  const agentsByIndex = new Map<number, WorkflowAgentStateRecord>(
    state.agents.map((record) => [record.index, record])
  )
  let maxJournalIndex = state.journal.reduce((max, entry) => Math.max(max, entry.index), -1)
  // Bumped on EVERY journal mutation (append OR replace-by-index). doWrite skips rewriting the
  // (potentially tens-of-MB) .journal sidecar when this is unchanged since the last write — i.e.
  // when only agent state / phase / log / tokens moved — so a busy run doesn't rewrite the whole
  // journal on every throttled save (the journal-split's point is to keep that cost off the common
  // path). Replace-by-index keeps length constant, so a length check would miss it; a monotonic
  // version counter catches append AND replace.
  let journalVersion = 0
  let lastWrittenJournalVersion = -1

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
  // One predicate for both check points: at write entry, and again AFTER the
  // mkdir await below (same check-then-await shape that let a deletion slip
  // past getCheckpointerInternal's entry-only tombstone check).
  // NOTE: deliberately does NOT consult disposedThreadIds — that set flips on
  // while a deletion ATTEMPT is merely in progress and may be rolled back; a
  // live store silenced by it would eat the cancelled run's terminal flush.
  // Permanent silencing rides on the epoch (bumped at the point of no return)
  // and the dir tombstone (set where the sweep actually runs).
  const isStaleWriter = (): boolean =>
    storeGenerations.get(path) !== generation ||
    disposedRunDirs.has(runDir) ||
    (threadDisposalEpochs.get(threadId) ?? 0) !== bornDisposalEpoch

  const doWrite = async (withBak: boolean, isInitial = false): Promise<boolean> => {
    if (isStaleWriter()) {
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
      // Post-await recheck: a deletion landing DURING the mkdir has already
      // swept the dir — this mkdir may have rebuilt it, and writing now would
      // fill an orphan. Bail before any file lands; if our mkdir landed AFTER
      // the sweep, remove the empty dir it rebuilt (tombstone-active only —
      // see sweepRacedRunDir for why generation/epoch staleness must not rm).
      if (isStaleWriter()) {
        // Sweep ONLY behind the dir tombstone (deletion committed + swept):
        // a bare id-set hit is a rollback-able attempt, and rm'ing here would
        // destroy artifacts the surviving thread still owns.
        if (disposedRunDirs.has(runDir)) sweepRacedRunDir(runDir)
        return true
      }
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
      // Skip rewriting the .journal when it hasn't changed since the last successful write (only
      // agent state / phase / log / tokens moved) — avoids rewriting a tens-of-MB journal on every
      // throttled save. When it HAS changed, journal-first ordering still holds (see above).
      // Snapshot the version BEFORE the awaited write: appendJournal can fire DURING the write
      // (an agent completing mid-flush), and recording `journalVersion` AFTER the await would mark
      // that not-yet-written entry as persisted → a later save would skip it → the entry is lost on
      // resume. JSON.stringify runs synchronously with this snapshot (no await between), so the
      // bytes written and the recorded version always match; advancing only AFTER a successful
      // rename means a failed write retries the journal next save.
      const journalVersionAtWrite = journalVersion
      if (journalVersionAtWrite !== lastWrittenJournalVersion) {
        await writeFile(`${journalPath}.tmp`, JSON.stringify(state.journal))
        await rename(`${journalPath}.tmp`, journalPath)
        lastWrittenJournalVersion = journalVersionAtWrite
      }
      await writeFile(`${path}.tmp`, json)
      await rename(`${path}.tmp`, path)
      await persistWorkflowRunSummaryArtifacts(workspacePath, threadId, state)
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

  // Full-result sidecar writer. Writes a DIFFERENT file than doWrite (`<runId>.result`
  // vs `.json`/`.journal`), so its `.tmp` never collides; same stale-writer /
  // disposed-dir guard so a late write after a thread delete (or a superseded resume)
  // can't recreate the removed run directory. null = clear any stale sidecar.
  const resultSidecarPath = workflowResultFilePath(workspacePath, threadId, state.runId)
  const doPersistFullResult = async (resultJson: string | null): Promise<boolean> => {
    if (isStaleWriter()) {
      // Stale writer or disposed dir: skip silently (mirrors doWrite). The run.json
      // won't persist either, so resultSidecarStatus on a stale record is moot.
      return true
    }
    try {
      if (resultJson === null) {
        // Best-effort cleanup: resultSidecarStatus (not the file's presence) is the
        // reader's source of truth, so a failed unlink here cannot mislead.
        for (const stale of [resultSidecarPath, `${resultSidecarPath}.tmp`]) {
          if (existsSync(stale)) unlinkSync(stale)
        }
        return true
      }
      await mkdir(runDir, { recursive: true })
      // Post-await recheck — same rationale (and same dir-tombstone-only rm) as doWrite's.
      if (isStaleWriter()) {
        if (disposedRunDirs.has(runDir)) sweepRacedRunDir(runDir)
        return true
      }
      await writeFile(`${resultSidecarPath}.tmp`, resultJson)
      await rename(`${resultSidecarPath}.tmp`, resultSidecarPath)
      return true
    } catch (error) {
      console.warn(`[Workflow] Failed to persist full-result sidecar ${state.runId}:`, error)
      return false
    }
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
    isCurrentSnapshotPersisted() {
      const persisted = loadWorkflowRun(workspacePath, threadId, state.runId)
      return persisted?.threadId === threadId && persisted.startedAt === state.startedAt
    },
    update(mutator) {
      mutator(state)
      scheduleSave()
    },
    appendJournal(entry) {
      // Common case: lexical call indexes are monotonic, so an append keeps the array sorted with no
      // scan/sort (the engine replays order-independently BY HASH via availableByHash, so array order
      // is only cosmetic). Match an existing slot by index AND hash: replace ONLY when the SAME call
      // re-runs (idempotent rewrite). A DIFFERENT hash landing on an existing index — a concurrent
      // pipeline() reorder, or some agents left un-journaled (failure/fallback) shifting the live
      // callSeq onto a cached index — must NOT overwrite that index: replay is by hash, so an
      // overwrite would drop the OTHER call's cached result from availableByHash and force it to
      // re-run on the next resume (re-applying non-idempotent file edits). So APPEND it instead —
      // both hashes stay replayable; an unreferenced one just lingers harmlessly.
      if (entry.index > maxJournalIndex) {
        state.journal.push(entry)
        maxJournalIndex = entry.index
      } else {
        const existingIndex = state.journal.findIndex(
          (journalEntry) => journalEntry.index === entry.index && journalEntry.hash === entry.hash
        )
        if (existingIndex >= 0) {
          state.journal[existingIndex] = entry
        } else {
          // New index, OR a different hash at an existing index (never overwrite — see above).
          state.journal.push(entry)
          state.journal.sort((a, b) => a.index - b.index)
        }
      }
      journalVersion += 1
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
        if (record.toolStreamKey !== undefined) existing.toolStreamKey = record.toolStreamKey
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
          toolStreamKey: record.toolStreamKey,
          startedAt: new Date().toISOString(),
          endedAt: record.status !== "running" ? new Date().toISOString() : undefined
        }
        state.agents.push(created)
        agentsByIndex.set(record.index, created)
      }
      scheduleSave()
    },
    persistFullResult(resultJson) {
      // Serialize onto the same write chain as doWrite (so the sidecar lands before
      // the run.json final flush), but keep the chain a VOID promise so a failed
      // sidecar write never poisons later persists; return THIS write's success.
      const result = writeChain.then(() => doPersistFullResult(resultJson))
      writeChain = result.then(
        () => undefined,
        () => undefined
      )
      return result
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
