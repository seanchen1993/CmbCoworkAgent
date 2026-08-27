import { createHash, randomUUID } from "crypto"
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "fs"
import { mkdir, open, opendir, rename, rm, stat, unlink, writeFile } from "fs/promises"
import { dirname, join, resolve } from "path"
import { Worker, type ResourceLimits } from "worker_threads"
import { getCmbCoworkAgentDataRoot } from "../../app-data-root"
import {
  openStableFileHandle,
  readStableFileHandleBounded
} from "../../services/stable-file-handle"
import {
  dedupePathsByRealLocation,
  getProjectThreadDataDirectoryReadCandidates,
  getProjectThreadDataDirectoryReadCandidatesSync,
  getProjectThreadDataDirectorySync
} from "../context-history-path"
import { serializeWorkflowAgentSnapshotMessages } from "./agent-snapshot"
import type {
  PersistedWorkflowRun,
  WorkflowAgentStateRecord,
  WorkflowJournalEntry,
  WorkflowRunSummary,
  WorkflowWorktreeRecord
} from "./types"
import {
  WORKFLOW_MAX_AGENT_INVOCATIONS,
  WORKFLOW_MAX_TOTAL_AGENTS,
  WORKFLOW_RESULT_SIDECAR_MAX_BYTES,
  WORKFLOW_RUN_ID_PATTERN
} from "./types"

/** Fields the engine supplies for an agent upsert; timestamps are managed by the store. */
export type WorkflowAgentUpsert = Omit<WorkflowAgentStateRecord, "startedAt" | "endedAt">

/** Keep at most this many run files per thread; older ones are pruned. */
const MAX_RUNS_PER_THREAD = 30
// One retained run can own up to WORKFLOW_MAX_TOTAL_AGENTS tool-stream files.
// This budget covers the normal 30-run history (plus temporary/fixed artifacts)
// while preventing a polluted directory from materializing an unbounded array.
const WORKFLOW_RUN_DIRECTORY_MAX_ENTRIES = 65_536
const WORKFLOW_RUN_DIRECTORY_YIELD_EVERY = 128

async function readWorkflowDirectoryEntriesBounded(
  dir: string,
  maxEntries = WORKFLOW_RUN_DIRECTORY_MAX_ENTRIES
): Promise<string[]> {
  const safeLimit = Math.max(0, Math.floor(maxEntries))
  const directory = await opendir(dir)
  const entries: string[] = []
  let scanned = 0
  try {
    for await (const entry of directory) {
      scanned += 1
      if (scanned > safeLimit) {
        throw new Error(`workflow directory exceeds ${safeLimit} entries`)
      }
      entries.push(entry.name)
      if (scanned % WORKFLOW_RUN_DIRECTORY_YIELD_EVERY === 0) {
        await new Promise<void>((resolveYield) => setImmediate(resolveYield))
      }
    }
    return entries
  } finally {
    // for-await closes the handle on completion and abrupt exit. The explicit
    // close covers failures before iteration starts and tolerates double-close.
    await directory.close().catch(() => undefined)
  }
}

/** @internal Real-directory boundary seam for event-loop and overflow tests. */
export async function readWorkflowDirectoryEntriesBoundedForTest(
  dir: string,
  maxEntries: number
): Promise<string[]> {
  return await readWorkflowDirectoryEntriesBounded(dir, maxEntries)
}

/**
 * Workflow run persistence.
 *
 * New writes use CmbCowork's app-managed project/thread directory. Reads merge
 * that directory with the pre-custom-root managed location and the historical
 * `<workspace>/.cmbdevclaw/workflows/<threadId>/` location, so an upgrade neither
 * hides old history nor keeps writing new data into a workspace. Each run is
 * written atomically (tmp + rename) with a best-effort `.bak` of the previous
 * good save as corruption fallback. The journal powers `resumeFromRunId`
 * content-based replay.
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

export function getLegacyWorkflowRunsDir(workspacePath: string, threadId: string): string {
  return join(
    resolve(workspacePath),
    ".cmbdevclaw",
    "workflows",
    assertSafeSegment(threadId, "threadId")
  )
}

export function getManagedWorkflowRunsDir(workspacePath: string, threadId: string): string {
  return join(
    getProjectThreadDataDirectorySync(workspacePath, assertSafeSegment(threadId, "threadId")),
    "workflows"
  )
}

interface WorkflowRunsDirCandidates {
  managed: string
  preCustomManaged?: string
  legacy: string
  readDirs: string[]
}

const workflowRunsDirCandidateCache = new Map<string, WorkflowRunsDirCandidates>()
const workflowRunsDirCandidateAsyncCache = new Map<
  string,
  Promise<WorkflowRunsDirCandidates>
>()
const WORKFLOW_RUN_DIR_CANDIDATE_CACHE_MAX_ENTRIES = 256
let rejectedWorkflowRunDirCandidateResolutions = 0

function evictWorkflowRunsDirCandidateCache(): void {
  for (const key of workflowRunsDirCandidateCache.keys()) {
    if (workflowRunsDirCandidateCache.size <= WORKFLOW_RUN_DIR_CANDIDATE_CACHE_MAX_ENTRIES) break
    // A resolver publishes into the sync cache before its Promise settles. Do
    // not evict that just-published authority boundary until all waiters resume.
    if (workflowRunsDirCandidateAsyncCache.has(key)) continue
    workflowRunsDirCandidateCache.delete(key)
  }
}

function cacheWorkflowRunsDirCandidates(
  key: string,
  candidates: WorkflowRunsDirCandidates
): WorkflowRunsDirCandidates {
  workflowRunsDirCandidateCache.delete(key)
  workflowRunsDirCandidateCache.set(key, candidates)
  evictWorkflowRunsDirCandidateCache()
  return candidates
}

function cachedWorkflowRunsDirCandidates(key: string): WorkflowRunsDirCandidates | undefined {
  const cached = workflowRunsDirCandidateCache.get(key)
  if (!cached) return undefined
  workflowRunsDirCandidateCache.delete(key)
  workflowRunsDirCandidateCache.set(key, cached)
  return cached
}

function workflowRunsDirCandidateKey(workspacePath: string, threadId: string): string {
  return `${getCmbCoworkAgentDataRoot()}\0${resolve(workspacePath)}\0${threadId}`
}

function clearWorkflowRunsDirCandidateCache(threadId: string): void {
  const suffix = `\0${threadId}`
  for (const key of workflowRunsDirCandidateCache.keys()) {
    if (key.endsWith(suffix)) workflowRunsDirCandidateCache.delete(key)
  }
  for (const key of workflowRunsDirCandidateAsyncCache.keys()) {
    if (key.endsWith(suffix)) workflowRunsDirCandidateAsyncCache.delete(key)
  }
}

function workflowRunsDirCandidates(
  workspacePath: string,
  threadId: string
): WorkflowRunsDirCandidates {
  const key = workflowRunsDirCandidateKey(workspacePath, threadId)
  const cached = cachedWorkflowRunsDirCandidates(key)
  if (cached) return cached
  const appManagedDirs = getProjectThreadDataDirectoryReadCandidatesSync(
    workspacePath,
    assertSafeSegment(threadId, "threadId")
  ).map((directory) => join(directory, "workflows"))
  const managed = appManagedDirs[0]
  const legacy = getLegacyWorkflowRunsDir(workspacePath, threadId)
  const candidates = {
    managed,
    preCustomManaged: appManagedDirs[1],
    legacy,
    readDirs: [...new Set([managed, ...appManagedDirs.slice(1), legacy])]
  }
  return cacheWorkflowRunsDirCandidates(key, candidates)
}

async function workflowRunsDirCandidatesAsync(
  workspacePath: string,
  threadId: string
): Promise<WorkflowRunsDirCandidates> {
  const key = workflowRunsDirCandidateKey(workspacePath, threadId)
  const syncCached = cachedWorkflowRunsDirCandidates(key)
  if (syncCached) return syncCached
  const cached = workflowRunsDirCandidateAsyncCache.get(key)
  if (cached) return cached
  if (
    workflowRunsDirCandidateAsyncCache.size >=
    WORKFLOW_RUN_DIR_CANDIDATE_CACHE_MAX_ENTRIES
  ) {
    rejectedWorkflowRunDirCandidateResolutions += 1
    throw new Error("workflow storage resolver is busy; retry after current reads finish")
  }
  const resolving = (async () => {
    const appManagedDirs = (
      await getProjectThreadDataDirectoryReadCandidates(
        workspacePath,
        assertSafeSegment(threadId, "threadId")
      )
    ).map((directory) => join(directory, "workflows"))
    const managed = appManagedDirs[0]
    const legacy = getLegacyWorkflowRunsDir(workspacePath, threadId)
    const readDirs = await dedupePathsByRealLocation([
      managed,
      ...appManagedDirs.slice(1),
      legacy
    ])
    const candidates = { managed, preCustomManaged: appManagedDirs[1], legacy, readDirs }
    // Seed the compatibility cache only AFTER async canonicalization. Helpers
    // such as workflowRunIndexFilePath can then be reused deeper in the async
    // call without falling back to realpathSync.
    return cacheWorkflowRunsDirCandidates(key, candidates)
  })()
  workflowRunsDirCandidateAsyncCache.set(key, resolving)
  try {
    return await resolving
  } finally {
    if (workflowRunsDirCandidateAsyncCache.get(key) === resolving) {
      workflowRunsDirCandidateAsyncCache.delete(key)
    }
    evictWorkflowRunsDirCandidateCache()
  }
}

/**
 * Resolve and cache the authoritative write directory without blocking the
 * Electron main thread. Callers that must keep a synchronous launch/registration
 * boundary can await this once, then safely reuse the synchronous path helpers:
 * the compatibility cache has already been populated by async realpath/stat I/O.
 */
export async function prepareWorkflowRunStorage(
  workspacePath: string,
  threadId: string
): Promise<string> {
  return (await workflowRunsDirCandidatesAsync(workspacePath, threadId)).managed
}

/**
 * Resolve the only directory used for NEW writes. Compatibility locations are
 * never synchronously scanned here: the old implementation did an unbounded
 * readdir/readFile/JSON.parse pass on first access and could freeze Electron's
 * main loop on a large or remote workspace. Async discovery and point reads
 * merge every legacy candidate instead, while all new data converges here.
 */
export function getWorkflowRunsDir(workspacePath: string, threadId: string): string {
  return workflowRunsDirCandidates(workspacePath, threadId).managed
}

/**
 * Removes all persisted workflow artifacts for a thread from both the managed
 * and legacy locations during the compatibility window.
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
export async function deleteWorkflowRunsForThread(
  workspacePath: string,
  threadId: string
): Promise<void> {
  const candidates = await workflowRunsDirCandidatesAsync(workspacePath, threadId)
  const dirs = candidates.readDirs
  // Mark disposed FIRST: a background run still settling (e.g. cancelAndWait
  // timed out) must not recreate either directory via a late flush/persist.
  let threadDirs = disposedRunDirsByThread.get(threadId)
  if (!threadDirs) {
    threadDirs = new Set<string>()
    disposedRunDirsByThread.set(threadId, threadDirs)
  }
  for (const dir of dirs) {
    disposedRunDirs.add(dir)
    threadDirs.add(dir)
  }
  markWorkflowThreadDisposed(threadId)
  commitWorkflowThreadDisposal(threadId)
  const indexPath = workflowRunIndexFilePath(workspacePath, threadId)
  // Do not detach an in-flight index mutation from its serialization chain.
  // Wait until the current tail (including anything queued behind it) drains;
  // every writer observes the tombstone/epoch above and therefore fails stale.
  for (;;) {
    const pendingMutation = workflowRunIndexMutationChains.get(indexPath)
    if (!pendingMutation) break
    await pendingMutation.catch(() => undefined)
  }
  workflowRunIndexCaches.delete(indexPath)
  clearWorkflowRunsDirCandidateCache(threadId)
  await Promise.all(dirs.map((dir) => sweepRacedRunDir(dir, true)))
}

export function runFilePath(workspacePath: string, threadId: string, runId: string): string {
  return runFilePathInDir(getWorkflowRunsDir(workspacePath, threadId), runId)
}

function runFilePathInDir(dir: string, runId: string): string {
  return join(dir, `${assertSafeSegment(runId, "runId")}.json`)
}

function workflowRunReadDirs(workspacePath: string, threadId: string): string[] {
  return workflowRunsDirCandidates(workspacePath, threadId).readDirs
}

async function workflowRunReadDirsAsync(
  workspacePath: string,
  threadId: string
): Promise<string[]> {
  return (await workflowRunsDirCandidatesAsync(workspacePath, threadId)).readDirs
}

function workflowRunArtifactPathInDir(dir: string, runId: string, suffix: string): string {
  return join(dir, `${assertSafeSegment(runId, "runId")}${suffix}`)
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
    const located = locateWorkflowRunSync(workspacePath, threadId, run.runId)
    if (!located) return undefined
    const resultPath = workflowRunArtifactPathInDir(located.dir, run.runId, ".result")
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
  const located = locateWorkflowRunSync(workspacePath, threadId, run.runId)
  if (!located) return undefined
  const persisted = located.run
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
  return located.sourcePath
}

interface WorkflowRunSourceIdentity {
  dir: string
  sourcePath: string
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  startedAt: string
  status: PersistedWorkflowRun["status"]
  completedAt?: string
  scriptSha256?: string
  updatedAt: string
  resultSidecarStatus?: PersistedWorkflowRun["resultSidecarStatus"]
}

/** Provenance belongs to the exact object returned by an async point read. It
 * lets the notification path validate the already-parsed run without parsing
 * run.json (or an up-to-8 MiB result sidecar) a second time on Electron main. */
const asyncWorkflowRunSources = new WeakMap<PersistedWorkflowRun, WorkflowRunSourceIdentity>()

function sourceIdentityMatchesRun(
  source: WorkflowRunSourceIdentity,
  run: PersistedWorkflowRun
): boolean {
  return (
    source.startedAt === run.startedAt &&
    source.status === run.status &&
    source.completedAt === run.completedAt &&
    source.scriptSha256 === run.scriptSha256 &&
    source.updatedAt === run.updatedAt &&
    source.resultSidecarStatus === run.resultSidecarStatus
  )
}

/** Async production resolver for workflow-notification turns. The run must be
 * the exact current-incarnation snapshot returned by async storage discovery;
 * flush-failed memory-only snapshots therefore fail closed instead of pointing
 * at a stale file from an earlier resume that reused the same runId. */
export async function resolveWorkflowOutputFileAsync(
  run: PersistedWorkflowRun
): Promise<string | undefined> {
  const source = asyncWorkflowRunSources.get(run)
  if (!source || !sourceIdentityMatchesRun(source, run)) return undefined
  try {
    const current = await stat(source.sourcePath)
    if (
      !current.isFile() ||
      current.dev !== source.dev ||
      current.ino !== source.ino ||
      current.size !== source.size ||
      current.mtimeMs !== source.mtimeMs ||
      current.ctimeMs !== source.ctimeMs
    ) {
      return undefined
    }
  } catch {
    return undefined
  }

  if (run.resultSidecarStatus === "unavailable") return undefined
  if (run.resultSidecarStatus === "available") {
    const resultPath = workflowRunArtifactPathInDir(source.dir, run.runId, ".result")
    try {
      const resultStat = await stat(resultPath)
      return resultStat.isFile() &&
        resultStat.size > 0 &&
        resultStat.size <= WORKFLOW_RESULT_SIDECAR_MAX_BYTES
        ? resultPath
        : undefined
    } catch {
      return undefined
    }
  }
  if (typeof run.result === "string" && /\n…\[truncated \d+ chars\]$/.test(run.result)) {
    return undefined
  }
  return source.sourcePath
}

function locateWorkflowRunSync(
  workspacePath: string,
  threadId: string,
  runId: string
): LocatedWorkflowRun | null {
  if (!isValidWorkflowRunId(runId)) return null
  for (const dir of workflowRunReadDirs(workspacePath, threadId)) {
    const located = loadWorkflowRunFromDir(dir, runId, threadId)
    if (located) return located
  }
  return null
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
function summaryFilePath(
  workspacePath: string,
  threadId: string,
  runId: string,
  sourceDir = getWorkflowRunsDir(workspacePath, threadId)
): string {
  return workflowRunArtifactPathInDir(sourceDir, runId, ".summary")
}

const WORKFLOW_RESULT_JSON_VALIDATOR_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads")
try {
  const bytes = workerData.bytes
  JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"))
  parentPort.postMessage(true)
} catch {
  parentPort.postMessage(false)
}
`

async function validateWorkflowResultJsonInWorker(bytes: Buffer): Promise<boolean> {
  const transferBuffer = bytes.buffer as ArrayBuffer
  const worker = new Worker(WORKFLOW_RESULT_JSON_VALIDATOR_SOURCE, {
    eval: true,
    name: "workflow-result-json-validator",
    workerData: { bytes },
    transferList: [transferBuffer],
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 2
    }
  })
  return await new Promise<boolean>((resolveValidation) => {
    let settled = false
    const finish = (valid: boolean): void => {
      if (settled) return
      settled = true
      void worker.terminate().catch(() => undefined)
      resolveValidation(valid)
    }
    worker.once("message", (valid: unknown) => finish(valid === true))
    worker.once("error", () => finish(false))
    worker.once("exit", () => finish(false))
  })
}

/** Recovery needs stronger evidence than the notification path: if a snapshot
 * advertises `available`, the sidecar must still be valid JSON. Read from one
 * stable bounded capability and validate in a constrained Worker so an 8 MiB
 * result cannot parse or inflate on Electron main. */
async function isValidWorkflowResultFileAsync(path: string): Promise<boolean> {
  let opened: Awaited<ReturnType<typeof openStableFileHandle>> | undefined
  try {
    opened = await openStableFileHandle(dirname(path), path)
    if (opened.size <= 0 || opened.size > WORKFLOW_RESULT_SIDECAR_MAX_BYTES) return false
    return await withLargeWorkflowRunParsePermit(async () =>
      validateWorkflowResultJsonInWorker(
        await readStableFileHandleBounded(opened!, WORKFLOW_RESULT_SIDECAR_MAX_BYTES)
      )
    )
  } catch {
    return false
  } finally {
    await opened?.handle.close().catch(() => undefined)
  }
}

/** Journal sidecar (`<runId>.journal`, no `.json` so it's skipped by the run-file
 * scans): the replay journal lives HERE, not inside run.json, so get-run / hydrate
 * / history scan / mark-delivered parse a small run.json and never pay for a
 * (potentially tens-of-MB) journal they don't use. Only resume reads it back, via
 * loadWorkflowRunForResume. */
function journalFilePath(
  workspacePath: string,
  threadId: string,
  runId: string,
  sourceDir = getWorkflowRunsDir(workspacePath, threadId)
): string {
  return workflowRunArtifactPathInDir(sourceDir, runId, ".journal")
}

const WORKFLOW_JOURNAL_MAX_BYTES = 128 * 1024 * 1024
const WORKFLOW_JOURNAL_ENTRY_MAX_CHARS = 1024 * 1024
// One execution cannot legitimately create more than WORKFLOW_MAX_AGENT_INVOCATIONS
// entries. Allow several resumes under the same run id, but fail closed before a
// corrupt `[{}, {}, ...]` sidecar can materialize millions of tiny JS objects.
const WORKFLOW_JOURNAL_MAX_ENTRIES = WORKFLOW_MAX_AGENT_INVOCATIONS * 4
const WORKFLOW_JOURNAL_READ_CHUNK_BYTES = 64 * 1024
const WORKFLOW_JOURNAL_WRITE_BATCH_CHARS = 256 * 1024
const WORKFLOW_RUN_MAIN_THREAD_PARSE_MAX_BYTES = 256 * 1024
const WORKFLOW_RUN_FILE_MAX_BYTES = 128 * 1024 * 1024
const WORKFLOW_RUN_PROJECTED_MAX_BYTES = 32 * 1024 * 1024
const WORKFLOW_RUN_WORKER_MESSAGE_MAX_BYTES = 256 * 1024
const WORKFLOW_RUN_MAX_PHASES = 10_000
const WORKFLOW_RUN_MAX_LOGS = 10_000
const WORKFLOW_RUN_NAME_MAX_CHARS = 4 * 1024
const WORKFLOW_RUN_DESCRIPTION_MAX_CHARS = 64 * 1024
const WORKFLOW_RUN_SCALAR_TEXT_MAX_CHARS = 64 * 1024
const WORKFLOW_RUN_TIMESTAMP_MAX_CHARS = 128
const WORKFLOW_RUN_JSON_PARSE_CONCURRENCY = 1
const WORKFLOW_RUN_JSON_PARSE_MAX_WAITERS = 8
const WORKFLOW_RUN_JSON_WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4
}

type WorkflowRunJsonWorkerMessage =
  | { type: "array-start"; key: string }
  | {
      type: "value-chunk"
      key: string
      mode: "assign" | "append-one" | "append-many"
      chunk: Uint8Array
      final: boolean
      valueBytes: number
    }
  | { type: "done" }
  | { type: "error"; error: string }

interface WorkflowRunFileStat {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
  isFile(): boolean
}

interface ParsedWorkflowRunFile {
  parsed: PersistedWorkflowRun
  after: WorkflowRunFileStat
}

let activeLargeWorkflowRunParses = 0
let peakLargeWorkflowRunParses = 0
let largeWorkflowRunWorkersStarted = 0
let largeWorkflowRunJournalBatches = 0
let peakLargeWorkflowRunJournalBatchBytes = 0
let largeWorkflowRunMessages = 0
let peakLargeWorkflowRunMessageBytes = 0
let rejectedLargeWorkflowRunParseWaiters = 0
const largeWorkflowRunParseWaiters: Array<() => void> = []
const largeWorkflowRunParseFlights = new Map<string, Promise<ParsedWorkflowRunFile>>()
let beforeLargeWorkflowRunParseForTest:
  | ((path: string) => void | Promise<void>)
  | undefined

/** @internal Deterministic admission-pressure seam. */
export function setBeforeLargeWorkflowRunParseForTest(
  hook?: (path: string) => void | Promise<void>
): void {
  beforeLargeWorkflowRunParseForTest = hook
}

async function acquireLargeWorkflowRunParsePermit(): Promise<() => void> {
  if (activeLargeWorkflowRunParses < WORKFLOW_RUN_JSON_PARSE_CONCURRENCY) {
    activeLargeWorkflowRunParses += 1
  } else {
    if (largeWorkflowRunParseWaiters.length >= WORKFLOW_RUN_JSON_PARSE_MAX_WAITERS) {
      rejectedLargeWorkflowRunParseWaiters += 1
      throw new Error("workflow run parser is busy; retry after current history reads finish")
    }
    await new Promise<void>((resolvePermit) => {
      largeWorkflowRunParseWaiters.push(resolvePermit)
    })
  }
  peakLargeWorkflowRunParses = Math.max(
    peakLargeWorkflowRunParses,
    activeLargeWorkflowRunParses
  )
  return () => {
    const next = largeWorkflowRunParseWaiters.shift()
    if (next) next()
    else activeLargeWorkflowRunParses -= 1
  }
}

async function withLargeWorkflowRunParsePermit<T>(work: () => Promise<T>): Promise<T> {
  const release = await acquireLargeWorkflowRunParsePermit()
  try {
    return await work()
  } finally {
    release()
  }
}

function sameWorkflowRunFileIdentity(
  left: WorkflowRunFileStat,
  right: WorkflowRunFileStat
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function workflowRunFileFlightKey(
  path: string,
  identity: {
    device: bigint
    inode: bigint
    size: bigint
    modifiedNs: bigint
    changedNs: bigint
  }
): string {
  const normalizedPath = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path)
  return [
    normalizedPath,
    identity.device,
    identity.inode,
    identity.size,
    identity.modifiedNs,
    identity.changedNs
  ].join("\0")
}

async function finalWorkflowRunFileStat(
  opened: Awaited<ReturnType<typeof openStableFileHandle>>
): Promise<WorkflowRunFileStat> {
  const final = await opened.handle.stat({ bigint: true })
  if (
    !final.isFile() ||
    final.dev !== opened.identity.device ||
    final.ino !== opened.identity.inode ||
    final.size !== opened.identity.size ||
    final.mtimeNs !== opened.identity.modifiedNs ||
    final.ctimeNs !== opened.identity.changedNs
  ) {
    throw new Error("workflow run file changed while it was being parsed")
  }
  await opened.assertPathIdentity()
  const numeric = await opened.handle.stat()
  return {
    dev: numeric.dev,
    ino: numeric.ino,
    size: numeric.size,
    mtimeMs: numeric.mtimeMs,
    ctimeMs: numeric.ctimeMs,
    isFile: () => true
  }
}

/** Observable seam for bounded-concurrency/single-flight regressions. */
export function getWorkflowRunLargeParseDiagnosticsForTest(): {
  active: number
  peak: number
  waiters: number
  maxWaiters: number
  rejectedWaiters: number
  workersStarted: number
  journalBatches: number
  peakJournalBatchBytes: number
  messages: number
  peakMessageBytes: number
  maxMessageBytes: number
} {
  return {
    active: activeLargeWorkflowRunParses,
    peak: peakLargeWorkflowRunParses,
    waiters: largeWorkflowRunParseWaiters.length,
    maxWaiters: WORKFLOW_RUN_JSON_PARSE_MAX_WAITERS,
    rejectedWaiters: rejectedLargeWorkflowRunParseWaiters,
    workersStarted: largeWorkflowRunWorkersStarted,
    journalBatches: largeWorkflowRunJournalBatches,
    peakJournalBatchBytes: peakLargeWorkflowRunJournalBatchBytes,
    messages: largeWorkflowRunMessages,
    peakMessageBytes: peakLargeWorkflowRunMessageBytes,
    maxMessageBytes: WORKFLOW_RUN_WORKER_MESSAGE_MAX_BYTES
  }
}

// Keep large legacy run.json parsing off Electron's main thread. The journal is
// returned in small batches so structured-clone deserialization does not replace
// one giant JSON.parse pause with one giant cross-thread message pause.
const WORKFLOW_RUN_JSON_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads")
try {
  const bytes = workerData.bytes
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8")
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("workflow run JSON must be an object")
  }
  const knownKeys = new Set([
    "version", "runId", "threadId", "workflowName", "description", "script",
    "scriptSha256", "args", "status", "phases", "currentPhase", "agents",
    "worktrees", "logs", "journal", "result", "resultSidecarStatus", "error",
    "warning", "stats", "startedAt", "updatedAt", "completedAt",
    "notificationDelivered", "resumed", "endedAt"
  ])
  for (const key of Object.keys(parsed)) {
    if (!knownKeys.has(key)) throw new Error("workflow run JSON contains an unknown field")
  }
  if (!Array.isArray(parsed.phases) || parsed.phases.length > workerData.maxPhases) {
    throw new Error("workflow phase count exceeds safe limit")
  }
  if (!Array.isArray(parsed.agents) || parsed.agents.length > workerData.maxAgents) {
    throw new Error("workflow agent count exceeds safe limit")
  }
  if (parsed.worktrees !== undefined &&
      (!Array.isArray(parsed.worktrees) || parsed.worktrees.length > workerData.maxAgents)) {
    throw new Error("workflow worktree count exceeds safe limit")
  }
  if (!Array.isArray(parsed.logs) || parsed.logs.length > workerData.maxLogs) {
    throw new Error("workflow log count exceeds safe limit")
  }
  if (parsed.phases.some((value) => typeof value !== "string" || value.length > 65536) ||
      parsed.logs.some((value) => typeof value !== "string" || value.length > 65536)) {
    throw new Error("workflow phase/log entry exceeds safe limit")
  }
  if (typeof parsed.script !== "string" || parsed.script.length > workerData.maxScriptChars) {
    throw new Error("workflow script exceeds safe limit")
  }
  const requireString = (key, maxChars) => {
    if (typeof parsed[key] !== "string" || parsed[key].length > maxChars) {
      throw new Error("workflow " + key + " exceeds safe limit or is missing")
    }
  }
  const optionalString = (key, maxChars) => {
    if (parsed[key] !== undefined &&
        (typeof parsed[key] !== "string" || parsed[key].length > maxChars)) {
      throw new Error("workflow " + key + " exceeds safe limit")
    }
  }
  requireString("runId", 64)
  requireString("threadId", 256)
  requireString("workflowName", workerData.maxNameChars)
  requireString("scriptSha256", 256)
  requireString("startedAt", workerData.maxTimestampChars)
  requireString("updatedAt", workerData.maxTimestampChars)
  optionalString("description", workerData.maxDescriptionChars)
  optionalString("error", workerData.maxScalarTextChars)
  optionalString("warning", workerData.maxScalarTextChars)
  optionalString("completedAt", workerData.maxTimestampChars)
  optionalString("endedAt", workerData.maxTimestampChars)
  if (parsed.currentPhase !== null &&
      (typeof parsed.currentPhase !== "string" ||
       parsed.currentPhase.length > workerData.maxScalarTextChars)) {
    throw new Error("workflow currentPhase exceeds safe limit")
  }
  if (parsed.status === "failed") parsed.status = "error"
  if (parsed.status === "cancelled" || parsed.status === "canceled") parsed.status = "aborted"
  if (!["running", "completed", "error", "aborted"].includes(parsed.status)) {
    throw new Error("workflow status is invalid")
  }
  if (!parsed.stats || typeof parsed.stats !== "object" || Array.isArray(parsed.stats) ||
      !["agentsTotal", "agentsCached", "agentsFailed", "outputTokens", "durationMs"]
        .every((key) => Number.isFinite(parsed.stats[key]))) {
    throw new Error("workflow stats are invalid")
  }
  const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8")
  if (parsed.agents.some((value) => jsonBytes(value) > workerData.maxRecordBytes) ||
      (parsed.worktrees && parsed.worktrees.some(
        (value) => jsonBytes(value) > workerData.maxRecordBytes
      ))) {
    throw new Error("workflow agent/worktree record exceeds safe limit")
  }
  if ((parsed.args !== undefined && jsonBytes(parsed.args) > workerData.maxValueBytes) ||
      (parsed.result !== undefined && jsonBytes(parsed.result) > workerData.maxValueBytes)) {
    throw new Error("workflow args/result exceeds safe limit")
  }
  const projected = {}
  for (const key of knownKeys) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) projected[key] = parsed[key]
  }
  if (projected.journal !== undefined && !Array.isArray(projected.journal)) {
    throw new Error("workflow journal must be an array")
  }
  const journal = Array.isArray(projected.journal) ? projected.journal : []
  if (journal.length > workerData.maxJournalEntries) {
    throw new Error("workflow journal entry count exceeds safe limit")
  }
  const journalEntryBytes = []
  let journalBytes = 2
  for (let index = 0; index < journal.length; index += 1) {
    const entryBytes = jsonBytes(journal[index])
    if (entryBytes > workerData.maxJournalEntryBytes) {
      throw new Error("workflow journal entry exceeds safe limit")
    }
    journalEntryBytes.push(entryBytes)
    journalBytes += entryBytes + (index === 0 ? 0 : 1)
    if (journalBytes > workerData.maxJournalBytes) {
      throw new Error("workflow journal exceeds safe limit")
    }
  }
  // Inline journals from older releases may legitimately be much larger than
  // the ordinary run metadata. Validate their own 128 MiB contract separately,
  // then exclude them from the 32 MiB main-isolate projection budget.
  projected.journal = []
  const projectedBytes = Buffer.byteLength(JSON.stringify(projected), "utf8")
  if (projectedBytes > workerData.maxProjectedBytes) {
    throw new Error("workflow run projected payload exceeds safe limit")
  }

  const postEncoded = (key, mode, serialized) => {
    const bytes = Buffer.from(serialized, "utf8")
    for (let offset = 0; offset < bytes.length; offset += workerData.maxMessageBytes) {
      const length = Math.min(workerData.maxMessageBytes, bytes.length - offset)
      // allocUnsafeSlow gives every chunk an independently transferable backing
      // store. Transferring a pooled Buffer would detach unrelated chunks.
      const chunk = Buffer.allocUnsafeSlow(length)
      bytes.copy(chunk, 0, offset, offset + length)
      parentPort.postMessage(
        {
          type: "value-chunk",
          key,
          mode,
          chunk,
          final: offset + length === bytes.length,
          valueBytes: bytes.length
        },
        [chunk.buffer]
      )
    }
  }

  const postValue = (key, mode, value) => postEncoded(key, mode, JSON.stringify(value))
  const postArray = (key, values) => {
    parentPort.postMessage({ type: "array-start", key })
    let batch = []
    let batchBytes = 2
    const flushBatch = () => {
      if (batch.length === 0) return
      postEncoded(key, "append-many", "[" + batch.join(",") + "]")
      batch = []
      batchBytes = 2
    }
    for (const value of values) {
      const serialized = JSON.stringify(value)
      const valueBytes = Buffer.byteLength(serialized, "utf8")
      if (valueBytes + 2 > workerData.maxMessageBytes) {
        flushBatch()
        postEncoded(key, "append-one", serialized)
        continue
      }
      const nextBytes = batchBytes + valueBytes + (batch.length === 0 ? 0 : 1)
      if (batch.length > 0 && nextBytes > workerData.maxMessageBytes) flushBatch()
      batch.push(serialized)
      batchBytes += valueBytes + (batch.length === 1 ? 0 : 1)
    }
    flushBatch()
  }

  const streamedArrays = new Set(["phases", "agents", "worktrees", "logs"])
  for (const key of knownKeys) {
    if (key === "journal" || !Object.prototype.hasOwnProperty.call(projected, key)) continue
    if (streamedArrays.has(key)) postArray(key, projected[key])
    else postValue(key, "assign", projected[key])
  }
  if (workerData.includeJournal) postArray("journal", journal)
  else parentPort.postMessage({ type: "array-start", key: "journal" })
  parentPort.postMessage({ type: "done" })
} catch (error) {
  parentPort.postMessage({
    type: "error",
    error: error instanceof Error ? error.message : String(error)
  })
}
`

async function parseLargeWorkflowRunJson(
  bytes: Buffer,
  resourceLimits: ResourceLimits = WORKFLOW_RUN_JSON_WORKER_RESOURCE_LIMITS,
  includeJournal = false
): Promise<PersistedWorkflowRun> {
  largeWorkflowRunWorkersStarted += 1
  const transferBuffer = bytes.buffer as ArrayBuffer
  const worker = new Worker(WORKFLOW_RUN_JSON_WORKER_SOURCE, {
    eval: true,
    name: "workflow-run-json-reader",
    workerData: {
      bytes,
      includeJournal,
      maxJournalEntries: WORKFLOW_JOURNAL_MAX_ENTRIES,
      maxJournalBytes: WORKFLOW_JOURNAL_MAX_BYTES,
      maxProjectedBytes: WORKFLOW_RUN_PROJECTED_MAX_BYTES,
      maxMessageBytes: WORKFLOW_RUN_WORKER_MESSAGE_MAX_BYTES,
      maxPhases: WORKFLOW_RUN_MAX_PHASES,
      maxAgents: WORKFLOW_MAX_TOTAL_AGENTS,
      maxLogs: WORKFLOW_RUN_MAX_LOGS,
      maxScriptChars: 512 * 1024,
      maxNameChars: WORKFLOW_RUN_NAME_MAX_CHARS,
      maxDescriptionChars: WORKFLOW_RUN_DESCRIPTION_MAX_CHARS,
      maxScalarTextChars: WORKFLOW_RUN_SCALAR_TEXT_MAX_CHARS,
      maxTimestampChars: WORKFLOW_RUN_TIMESTAMP_MAX_CHARS,
      maxRecordBytes: 256 * 1024,
      maxValueBytes: 2 * 1024 * 1024,
      maxJournalEntryBytes: WORKFLOW_JOURNAL_ENTRY_MAX_CHARS
    },
    transferList: [transferBuffer],
    resourceLimits
  })
  return await new Promise<PersistedWorkflowRun>((resolveParse, rejectParse) => {
    let settled = false
    const run = {} as PersistedWorkflowRun
    const runRecord = run as unknown as Record<string, unknown>
    let reconstructedBytes = 0
    let activeValue:
      | {
          key: string
          mode: "assign" | "append-one" | "append-many"
          valueBytes: number
          bytes: number
          chunks: Buffer[]
        }
      | undefined
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      void worker.terminate().catch(() => undefined)
      if (error) rejectParse(error)
      else if (activeValue) rejectParse(new Error("workflow run parser returned a partial value"))
      else resolveParse(run)
    }
    worker.on("message", (message: WorkflowRunJsonWorkerMessage) => {
      if (message.type === "array-start") {
        if (activeValue) {
          finish(new Error("workflow run parser interleaved streamed values"))
          return
        }
        runRecord[message.key] = []
      } else if (message.type === "value-chunk") {
        const chunk = Buffer.from(
          message.chunk.buffer,
          message.chunk.byteOffset,
          message.chunk.byteLength
        )
        if (chunk.byteLength > WORKFLOW_RUN_WORKER_MESSAGE_MAX_BYTES) {
          finish(new Error("workflow run parser message exceeds safe limit"))
          return
        }
        largeWorkflowRunMessages += 1
        peakLargeWorkflowRunMessageBytes = Math.max(
          peakLargeWorkflowRunMessageBytes,
          chunk.byteLength
        )
        if (message.key === "journal") {
          peakLargeWorkflowRunJournalBatchBytes = Math.max(
            peakLargeWorkflowRunJournalBatchBytes,
            chunk.byteLength
          )
        }
        reconstructedBytes += chunk.byteLength
        if (
          reconstructedBytes >
          WORKFLOW_RUN_PROJECTED_MAX_BYTES + (includeJournal ? WORKFLOW_JOURNAL_MAX_BYTES : 0)
        ) {
          finish(new Error("workflow run parser streamed payload exceeds safe limit"))
          return
        }
        if (!activeValue) {
          activeValue = {
            key: message.key,
            mode: message.mode,
            valueBytes: message.valueBytes,
            bytes: 0,
            chunks: []
          }
        }
        if (
          activeValue.key !== message.key ||
          activeValue.mode !== message.mode ||
          activeValue.valueBytes !== message.valueBytes
        ) {
          finish(new Error("workflow run parser interleaved streamed values"))
          return
        }
        activeValue.bytes += chunk.byteLength
        activeValue.chunks.push(chunk)
        if (activeValue.bytes > activeValue.valueBytes) {
          finish(new Error("workflow run parser streamed value exceeds declared size"))
          return
        }
        if (message.final) {
          const completed = activeValue
          activeValue = undefined
          if (completed.bytes !== completed.valueBytes) {
            finish(new Error("workflow run parser streamed value is incomplete"))
            return
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(Buffer.concat(completed.chunks, completed.bytes).toString("utf8"))
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
            return
          }
          if (completed.mode === "assign") {
            runRecord[completed.key] = parsed
          } else {
            const target = runRecord[completed.key]
            if (!Array.isArray(target)) {
              finish(new Error("workflow run parser appended before array initialization"))
              return
            }
            if (completed.mode === "append-many") {
              if (!Array.isArray(parsed)) {
                finish(new Error("workflow run parser batch must be an array"))
                return
              }
              target.push(...parsed)
            } else {
              target.push(parsed)
            }
            if (completed.key === "journal") largeWorkflowRunJournalBatches += 1
          }
        }
      }
      else if (message.type === "done") finish()
      else finish(new Error(message.error))
    })
    worker.once("error", (error) => finish(error))
    worker.once("exit", (code) => {
      if (!settled) finish(new Error(`workflow run parser exited with code ${code}`))
    })
  })
}

/** Test-only seam proving a Worker heap limit fails the parse in the Worker,
 * rather than exhausting Electron's main isolate. Production always uses the
 * fixed limits above. */
export async function parseLargeWorkflowRunJsonForTest(
  bytes: Buffer,
  resourceLimits: ResourceLimits
): Promise<PersistedWorkflowRun> {
  return await parseLargeWorkflowRunJson(bytes, resourceLimits)
}

async function readAndParseLargeWorkflowRunFile(
  path: string,
  opened: Awaited<ReturnType<typeof openStableFileHandle>>,
  includeJournal: boolean
): Promise<ParsedWorkflowRunFile> {
  const key = `${workflowRunFileFlightKey(path, opened.identity)}\0journal:${includeJournal}`
  const existing = largeWorkflowRunParseFlights.get(key)
  if (existing) return await existing

  const flight = withLargeWorkflowRunParsePermit(async () => {
    await beforeLargeWorkflowRunParseForTest?.(path)
    // Queued callers hold only a small OS handle. The bounded Buffer and Worker
    // heap are admitted together, and the shared helper revalidates inode,
    // ctime/mtime, size and pathname after the read.
    const bytes = await readStableFileHandleBounded(opened, WORKFLOW_RUN_FILE_MAX_BYTES)
    const parsed = await parseLargeWorkflowRunJson(
      bytes,
      WORKFLOW_RUN_JSON_WORKER_RESOURCE_LIMITS,
      includeJournal
    )
    const after = await finalWorkflowRunFileStat(opened)
    return { parsed, after }
  })
  largeWorkflowRunParseFlights.set(key, flight)
  try {
    return await flight
  } finally {
    if (largeWorkflowRunParseFlights.get(key) === flight) {
      largeWorkflowRunParseFlights.delete(key)
    }
  }
}

async function parseWorkflowRunJsonAsync(
  bytes: Buffer,
  includeJournal: boolean
): Promise<PersistedWorkflowRun> {
  if (bytes.byteLength > WORKFLOW_RUN_FILE_MAX_BYTES) {
    throw new Error(`run file exceeds ${WORKFLOW_RUN_FILE_MAX_BYTES} bytes`)
  }
  if (bytes.byteLength <= WORKFLOW_RUN_MAIN_THREAD_PARSE_MAX_BYTES) {
    const parsed = JSON.parse(bytes.toString("utf8")) as PersistedWorkflowRun
    if (!includeJournal && Array.isArray(parsed.journal)) parsed.journal = []
    return parsed
  }
  return await withLargeWorkflowRunParsePermit(() =>
    parseLargeWorkflowRunJson(
      bytes,
      WORKFLOW_RUN_JSON_WORKER_RESOURCE_LIMITS,
      includeJournal
    )
  )
}

function isPersistedWorkflowRunShape(value: unknown): value is PersistedWorkflowRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const mutable = value as Record<string, unknown>
  if (mutable.status === "failed") mutable.status = "error"
  if (mutable.status === "cancelled" || mutable.status === "canceled") {
    mutable.status = "aborted"
  }
  const run = value as Partial<PersistedWorkflowRun>
  if (
    run.version !== 1 ||
    typeof run.runId !== "string" ||
    run.runId.length > 64 ||
    typeof run.threadId !== "string" ||
    run.threadId.length > 256 ||
    typeof run.workflowName !== "string" ||
    run.workflowName.length > WORKFLOW_RUN_NAME_MAX_CHARS ||
    typeof run.script !== "string" ||
    run.script.length > 512 * 1024 ||
    typeof run.scriptSha256 !== "string" ||
    run.scriptSha256.length > 256 ||
    !["running", "completed", "error", "aborted"].includes(String(run.status)) ||
    typeof run.startedAt !== "string" ||
    run.startedAt.length > WORKFLOW_RUN_TIMESTAMP_MAX_CHARS ||
    typeof run.updatedAt !== "string" ||
    run.updatedAt.length > WORKFLOW_RUN_TIMESTAMP_MAX_CHARS ||
    !Array.isArray(run.phases) ||
    run.phases.length > WORKFLOW_RUN_MAX_PHASES ||
    !Array.isArray(run.agents) ||
    run.agents.length > WORKFLOW_MAX_TOTAL_AGENTS ||
    (run.worktrees !== undefined &&
      (!Array.isArray(run.worktrees) || run.worktrees.length > WORKFLOW_MAX_TOTAL_AGENTS)) ||
    !Array.isArray(run.logs) ||
    run.logs.length > WORKFLOW_RUN_MAX_LOGS ||
    !Array.isArray(run.journal) ||
    run.journal.length > WORKFLOW_JOURNAL_MAX_ENTRIES
  ) {
    return false
  }
  if (
    run.phases.some(
      (entry) =>
        typeof entry !== "string" || entry.length > WORKFLOW_RUN_SCALAR_TEXT_MAX_CHARS
    ) ||
    run.logs.some(
      (entry) =>
        typeof entry !== "string" || entry.length > WORKFLOW_RUN_SCALAR_TEXT_MAX_CHARS
    ) ||
    run.agents.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry)) ||
    run.worktrees?.some(
      (entry) => !entry || typeof entry !== "object" || Array.isArray(entry)
    )
  ) {
    return false
  }
  if (
    (run.description !== undefined &&
      (typeof run.description !== "string" ||
        run.description.length > WORKFLOW_RUN_DESCRIPTION_MAX_CHARS)) ||
    (run.currentPhase !== null &&
      (typeof run.currentPhase !== "string" ||
        run.currentPhase.length > WORKFLOW_RUN_SCALAR_TEXT_MAX_CHARS)) ||
    (run.error !== undefined &&
      (typeof run.error !== "string" ||
        run.error.length > WORKFLOW_RUN_SCALAR_TEXT_MAX_CHARS)) ||
    (run.warning !== undefined &&
      (typeof run.warning !== "string" ||
        run.warning.length > WORKFLOW_RUN_SCALAR_TEXT_MAX_CHARS)) ||
    (run.completedAt !== undefined &&
      (typeof run.completedAt !== "string" ||
        run.completedAt.length > WORKFLOW_RUN_TIMESTAMP_MAX_CHARS))
  ) {
    return false
  }
  const stats = run.stats as Partial<PersistedWorkflowRun["stats"]> | undefined
  return Boolean(
    stats &&
      typeof stats === "object" &&
      Number.isFinite(stats.agentsTotal) &&
      Number.isFinite(stats.agentsCached) &&
      Number.isFinite(stats.agentsFailed) &&
      Number.isFinite(stats.outputTokens) &&
      Number.isFinite(stats.durationMs)
  )
}

/** Parse the top-level journal array incrementally. Each JSON.parse is bounded
 * to one capped agent result, and the scanner yields every 512 KiB, so a large
 * explicit resume cannot monopolize Electron's main event loop. */
let beforeWorkflowJournalReadForTest: ((path: string) => void | Promise<void>) | undefined

/** @internal Stable journal capability race seam. */
export function setBeforeWorkflowJournalReadForTest(
  hook?: (path: string) => void | Promise<void>
): void {
  beforeWorkflowJournalReadForTest = hook
}

async function readWorkflowJournalSidecar(path: string): Promise<WorkflowJournalEntry[]> {
  const opened = await openStableFileHandle(dirname(path), path)
  const handle = opened.handle
  try {
    await beforeWorkflowJournalReadForTest?.(path)
    const initial = await handle.stat()
    if (!initial.isFile()) throw new Error("journal sidecar is not a regular file")
    if (initial.size > WORKFLOW_JOURNAL_MAX_BYTES) {
      throw new Error(`journal sidecar exceeds ${WORKFLOW_JOURNAL_MAX_BYTES} bytes`)
    }

    const entries: WorkflowJournalEntry[] = []
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const buffer = Buffer.allocUnsafe(WORKFLOW_JOURNAL_READ_CHUNK_BYTES)
    let rootStarted = false
    let ended = false
    let elementActive = false
    let elementParts: string[] = []
    let elementChars = 0
    let nestedDepth = 0
    let inString = false
    let escaped = false
    let afterComma = false

    const appendElementPart = (part: string): void => {
      if (!part) return
      elementChars += part.length
      if (elementChars > WORKFLOW_JOURNAL_ENTRY_MAX_CHARS) {
        throw new Error(
          `journal entry exceeds ${WORKFLOW_JOURNAL_ENTRY_MAX_CHARS} characters`
        )
      }
      elementParts.push(part)
    }
    const finishElement = (): void => {
      const payload = elementParts.join("").trim()
      if (!payload) throw new Error("journal sidecar contains an empty entry")
      entries.push(JSON.parse(payload) as WorkflowJournalEntry)
      if (entries.length > WORKFLOW_JOURNAL_MAX_ENTRIES) {
        throw new Error(
          `journal sidecar exceeds ${WORKFLOW_JOURNAL_MAX_ENTRIES} entries`
        )
      }
      elementParts = []
      elementChars = 0
      elementActive = false
      nestedDepth = 0
      inString = false
      escaped = false
    }
    const consume = (text: string): void => {
      let partStart = 0
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        if (ended) {
          if (!/\s/.test(char)) throw new Error("journal sidecar has trailing JSON data")
          continue
        }
        if (!rootStarted) {
          if (/\s/.test(char)) continue
          if (char !== "[") throw new Error("journal sidecar must contain a JSON array")
          rootStarted = true
          partStart = index + 1
          continue
        }
        if (!elementActive) {
          if (/\s/.test(char)) {
            partStart = index + 1
            continue
          }
          if (char === "]") {
            if (afterComma) throw new Error("journal sidecar contains a trailing comma")
            ended = true
            partStart = index + 1
            continue
          }
          if (char === ",") throw new Error("journal sidecar contains an empty entry")
          elementActive = true
          afterComma = false
          partStart = index
        }

        if (inString) {
          if (escaped) escaped = false
          else if (char === "\\") escaped = true
          else if (char === '"') inString = false
          continue
        }
        if (char === '"') {
          inString = true
          continue
        }
        if (char === "{" || char === "[") {
          nestedDepth += 1
          continue
        }
        if (char === "}" || (char === "]" && nestedDepth > 0)) {
          nestedDepth -= 1
          if (nestedDepth < 0) throw new Error("journal sidecar nesting is malformed")
          continue
        }
        if (nestedDepth === 0 && (char === "," || char === "]")) {
          appendElementPart(text.slice(partStart, index))
          finishElement()
          afterComma = char === ","
          if (char === "]") ended = true
          partStart = index + 1
        }
      }
      if (elementActive) appendElementPart(text.slice(partStart))
    }

    let totalBytes = 0
    let position = 0
    let chunks = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      position += bytesRead
      totalBytes += bytesRead
      if (totalBytes > WORKFLOW_JOURNAL_MAX_BYTES) {
        throw new Error(`journal sidecar exceeds ${WORKFLOW_JOURNAL_MAX_BYTES} bytes`)
      }
      consume(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }))
      chunks += 1
      if (chunks % 8 === 0) await new Promise<void>((resolveYield) => setImmediate(resolveYield))
    }
    consume(decoder.decode())
    if (!rootStarted || !ended || elementActive || inString || nestedDepth !== 0) {
      throw new Error("journal sidecar JSON is incomplete")
    }

    const final = await handle.stat()
    if (
      final.dev !== initial.dev ||
      final.ino !== initial.ino ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs
    ) {
      throw new Error("journal sidecar changed while it was being read")
    }
    await opened.assertPathIdentity()
    return entries
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Serialize a potentially tens-of-megabytes journal in bounded batches. Each
 * JSON.stringify handles one capped entry, and every batch write yields through
 * async I/O, avoiding one monolithic main-thread stringify/allocation. */
async function writeWorkflowJournalSidecar(
  tempPath: string,
  targetPath: string,
  entries: readonly WorkflowJournalEntry[]
): Promise<void> {
  if (entries.length > WORKFLOW_JOURNAL_MAX_ENTRIES) {
    throw new Error(`workflow journal exceeds ${WORKFLOW_JOURNAL_MAX_ENTRIES} entries`)
  }
  const handle = await open(tempPath, "w")
  let writeComplete = false
  let position = 0
  const writeChunk = async (text: string): Promise<void> => {
    const bytes = Buffer.from(text, "utf8")
    if (position + bytes.length > WORKFLOW_JOURNAL_MAX_BYTES) {
      throw new Error(`workflow journal exceeds ${WORKFLOW_JOURNAL_MAX_BYTES} bytes`)
    }
    let offset = 0
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
        position
      )
      if (bytesWritten === 0) throw new Error("workflow journal write made no progress")
      offset += bytesWritten
      position += bytesWritten
    }
  }
  try {
    let batch = "["
    for (let index = 0; index < entries.length; index += 1) {
      const serialized = JSON.stringify(entries[index])
      if (serialized.length > WORKFLOW_JOURNAL_ENTRY_MAX_CHARS) {
        throw new Error(
          `workflow journal entry exceeds ${WORKFLOW_JOURNAL_ENTRY_MAX_CHARS} characters`
        )
      }
      const fragment = `${index === 0 ? "" : ","}${serialized}`
      if (
        batch.length > 0 &&
        batch.length + fragment.length > WORKFLOW_JOURNAL_WRITE_BATCH_CHARS
      ) {
        await writeChunk(batch)
        batch = ""
      }
      batch += fragment
    }
    batch += "]"
    await writeChunk(batch)
    writeComplete = true
  } finally {
    await handle.close().catch(() => undefined)
    if (!writeComplete) await unlink(tempPath).catch(() => undefined)
  }
  try {
    await rename(tempPath, targetPath)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
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
let beforeAgentToolStreamReadForTest: ((path: string) => void | Promise<void>) | undefined

/** @internal Stable-read race seam used only by regression tests. */
export function setBeforeAgentToolStreamReadForTest(
  hook?: (path: string) => void | Promise<void>
): void {
  beforeAgentToolStreamReadForTest = hook
}

function enqueueAgentSidecarOp(path: string, op: () => Promise<void>): Promise<void> {
  const prev = agentSidecarOps.get(path) ?? Promise.resolve()
  const next = prev.then(op, op) // run op regardless of the previous op's outcome
  agentSidecarOps.set(path, next)
  void next.finally(() => {
    if (agentSidecarOps.get(path) === next) agentSidecarOps.delete(path)
  })
  return next
}

function enqueuePendingAgentToolStreamDeletes(dirs: readonly string[], runId: string): void {
  const pathPrefixes = dirs.map((dir) => join(dir, `${runId}.`))
  for (const opPath of agentSidecarOps.keys()) {
    if (!pathPrefixes.some((pathPrefix) => opPath.startsWith(pathPrefix))) continue
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
    // If an async prune currently owns this run's mutation lock, this is a NEW
    // incarnation that must write only after the old artifacts are gone. Capture
    // the current tail now; a prune that begins later sees this sidecar op and
    // queues its ordered delete instead.
    const pendingRunMutation = runFileMutationChains.get(
      runFilePath(workspacePath, threadId, runId)
    )
    // Atomic write (tmp + rename, like run.json/journal): a crash mid-write leaves a stray
    // .tmp (swept by prune/thread-delete), never a half-written .toolstream the reader chokes
    // on; rename is atomic on one filesystem, so a concurrent read sees old-or-new, never torn.
    // Enqueued on the per-path op chain so a re-run's clear is ordered BEFORE this write (clear
    // can't delete it) and any prior write is ordered before that clear (no late-rename resurrect).
    // Fire-and-forget — never blocks the event loop or the run's settle. No mkdir: an active run
    // already created the dir, so a late write after thread-delete just ENOENTs.
    void enqueueAgentSidecarOp(path, async () => {
      try {
        await pendingRunMutation
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
 * repeated edit-and-resume. Settled files are removed with async filesystem calls and the caller
 * awaits that finite sweep before launching the replacement run. An in-flight display write is
 * deliberately NOT awaited: its ordered delete remains on that path's operation chain, so a hung
 * display-only write cannot wedge launch and a late rename cannot revive the old sidecar. An
 * in-flight write of this run could rename a file AFTER a bare sync sweep and revive the orphan, so
 * instead of AWAITING those writes (which would put hung display I/O on the launch path) we enqueue
 * an ordered delete on each pending path's OWN op chain — it runs AFTER that write's rename (no
 * revival) and BEFORE the fresh run's writes (this runs first, pre-launch). Everything already on
 * disk is swept synchronously (fast metadata ops, never waits). Globs by the runId prefix +
 * .toolstream suffix, same as pruneWorkflowRuns. */
export async function clearAllAgentToolStreams(
  workspacePath: string,
  threadId: string,
  runId: string
): Promise<void> {
  if (!isValidWorkflowRunId(runId)) return
  const prefix = `${runId}.`
  const dirs = await workflowRunReadDirsAsync(workspacePath, threadId)
  // In-flight writes for THIS run (op map keyed by full path): enqueue an ordered delete on each so
  // it runs after the write's rename. Do not collect/await these promises: a hung display write
  // must not stall the replacement launch. Any new write is queued behind this delete.
  enqueuePendingAgentToolStreamDeletes(dirs, runId)
  // Sweep everything ALREADY on disk (settled writes / paths with no pending op) without blocking
  // Electron's event loop. Compatibility roots are included so an edit-and-resume also removes
  // orphaned streams belonging to a run that was first persisted before managed storage existed.
  await Promise.all(
    dirs.map(async (dir) => {
      let files: string[]
      try {
        files = await readWorkflowDirectoryEntriesBounded(dir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn("[Workflow] Failed to enumerate old agent tool streams:", error)
        }
        return
      }
      const stale = files.filter(
        (file) =>
          file.startsWith(prefix) &&
          (file.endsWith(".toolstream") || file.endsWith(".toolstream.tmp"))
      )
      await mapWithConcurrency(stale, WORKFLOW_RUN_SUMMARY_BACKFILL_CONCURRENCY, async (file) => {
        try {
          await unlink(join(dir, file))
        } catch {
          /* best-effort cleanup */
        }
      })
    })
  )
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
  const located = await loadWorkflowRunWithLocationAsync(workspacePath, threadId, runId)
  const path = located
    ? join(located.dir, `${assertSafeSegment(runId, "runId")}${agentToolStreamSuffix(toolStreamKey)}`)
    : agentToolStreamPath(workspacePath, threadId, runId, toolStreamKey)
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
  let opened: Awaited<ReturnType<typeof openStableFileHandle>> | undefined
  try {
    // One stable regular-file capability closes stat→read growth/path-replacement
    // races (including Windows, where O_NOFOLLOW is unavailable). max+1 reads
    // bound memory even if a workspace-side legacy file grows after open.
    opened = await openStableFileHandle(dirname(path), path)
    await beforeAgentToolStreamReadForTest?.(path)
    const parsed = JSON.parse(
      (await readStableFileHandleBounded(opened, WORKFLOW_AGENT_TOOLSTREAM_MAX_BYTES)).toString(
        "utf8"
      )
    ) as { snapshotMessages?: unknown }
    if (!Array.isArray(parsed.snapshotMessages)) return null
    // Drop non-object elements (null / string / primitive / old-format / half-corrupt): the renderer
    // reads `message.kwargs` on each, so a bad element would throw and break the panel. A corrupted or
    // externally-edited sidecar then degrades to the valid messages (or empty), never a crash.
    return parsed.snapshotMessages.filter((m): m is object => m !== null && typeof m === "object")
  } catch {
    return null
  } finally {
    await opened?.handle.close().catch(() => undefined)
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
const WORKFLOW_RUN_INDEX_MAX_BYTES = 1024 * 1024
const WORKFLOW_RUN_INDEX_MAX_ENTRIES = 4_096
const WORKFLOW_RUN_SUMMARY_MAX_BYTES = 256 * 1024
const WORKFLOW_RUN_SUMMARY_CACHE_MAX_ENTRIES = 128
const WORKFLOW_RUN_SUMMARY_CACHE_MAX_BYTES = 1024 * 1024

async function readStableBoundedPath(
  path: string,
  maxBytes: number
): Promise<{ bytes: Buffer; mtimeMs: number }> {
  const opened = await openStableFileHandle(dirname(path), path)
  try {
    const bytes = await readStableFileHandleBounded(opened, maxBytes)
    const fileStat = await opened.handle.stat()
    return {
      bytes,
      mtimeMs: fileStat.mtimeMs
    }
  } finally {
    await opened.handle.close().catch(() => undefined)
  }
}

interface WorkflowRunIndexEntry {
  runId: string
  startedAt: string
  status?: WorkflowRunSummary["status"]
  notificationDelivered?: boolean
  /** In-memory only; refreshed by async discovery and omitted from runs.index. */
  sourceDir?: string
  /** Portable durable hint; absolute directories remain process-local. */
  sourceAuthority?: "managed" | "pre-custom-managed" | "workspace-legacy"
}

interface WorkflowRunIndexFile {
  version: 1
  entries: WorkflowRunIndexEntry[]
  pendingNotificationRunIds?: string[]
}

function workflowRunSourceAuthority(
  workspacePath: string,
  threadId: string,
  sourceDir: string
): WorkflowRunIndexEntry["sourceAuthority"] {
  const candidates = workflowRunsDirCandidates(workspacePath, threadId)
  if (sourceDir === candidates.managed) return "managed"
  if (sourceDir === candidates.legacy) return "workspace-legacy"
  if (sourceDir === candidates.preCustomManaged) return "pre-custom-managed"
  return undefined
}

function workflowRunDirForAuthority(
  workspacePath: string,
  threadId: string,
  authority: WorkflowRunIndexEntry["sourceAuthority"]
): string | undefined {
  const candidates = workflowRunsDirCandidates(workspacePath, threadId)
  if (authority === "managed") return candidates.managed
  if (authority === "workspace-legacy") return candidates.legacy
  if (authority === "pre-custom-managed") return candidates.preCustomManaged
  return undefined
}

interface WorkflowRunIndexCache {
  entries: Map<string, WorkflowRunIndexEntry>
  summaries: Map<string, WorkflowRunSummary>
  summarySizes: Map<string, number>
  summaryBytes: number
  sortedEntries: WorkflowRunIndexEntry[] | null
  /** null means a legacy index still needs one async summary pass. */
  pendingNotificationRunIds: Set<string> | null
  /** mtime of the durable index snapshot. Run artifacts at-or-after this
   * boundary are revalidated with a point read to close crash-before-index gaps. */
  indexMtimeMs: number
  discovered: boolean
  ready: Promise<void>
  readyPending: boolean
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
const WORKFLOW_RUN_INDEX_CACHE_MAX_ENTRIES = 32
let rejectedWorkflowRunIndexCaches = 0
let beforeWorkflowRunIndexReadForTest:
  | ((indexPath: string) => void | Promise<void>)
  | undefined
let beforeWorkflowRunIndexPublishForTest:
  | ((indexPath: string) => void | Promise<void>)
  | undefined

function evictWorkflowRunIndexCaches(
  targetSize = WORKFLOW_RUN_INDEX_CACHE_MAX_ENTRIES
): void {
  for (const [indexPath, cache] of workflowRunIndexCaches) {
    if (workflowRunIndexCaches.size <= targetSize) break
    if (
      cache.readyPending ||
      cache.discoveryPromise !== null ||
      workflowRunIndexMutationChains.has(indexPath)
    ) {
      continue
    }
    workflowRunIndexCaches.delete(indexPath)
  }
}

/** @internal Deterministic cold-cache admission seam. */
export function setBeforeWorkflowRunIndexReadForTest(
  hook?: (indexPath: string) => void | Promise<void>
): void {
  beforeWorkflowRunIndexReadForTest = hook
}

/** @internal Deterministic deletion-vs-index-publication seam. */
export function setBeforeWorkflowRunIndexPublishForTest(
  hook?: (indexPath: string) => void | Promise<void>
): void {
  beforeWorkflowRunIndexPublishForTest = hook
}

function deleteCachedWorkflowRunSummary(
  cache: WorkflowRunIndexCache,
  runId: string
): void {
  cache.summaries.delete(runId)
  cache.summaryBytes -= cache.summarySizes.get(runId) ?? 0
  cache.summarySizes.delete(runId)
  if (cache.summaryBytes < 0) cache.summaryBytes = 0
}

function clearCachedWorkflowRunSummaries(cache: WorkflowRunIndexCache): void {
  cache.summaries.clear()
  cache.summarySizes.clear()
  cache.summaryBytes = 0
}

function cacheWorkflowRunSummary(
  cache: WorkflowRunIndexCache,
  runId: string,
  summary: WorkflowRunSummary
): void {
  let bytes: number
  try {
    bytes = Buffer.byteLength(JSON.stringify(summary), "utf8")
  } catch {
    return
  }
  deleteCachedWorkflowRunSummary(cache, runId)
  if (bytes > WORKFLOW_RUN_SUMMARY_CACHE_MAX_BYTES) return
  cache.summaries.set(runId, summary)
  cache.summarySizes.set(runId, bytes)
  cache.summaryBytes += bytes
  while (
    cache.summaries.size > WORKFLOW_RUN_SUMMARY_CACHE_MAX_ENTRIES ||
    cache.summaryBytes > WORKFLOW_RUN_SUMMARY_CACHE_MAX_BYTES
  ) {
    const oldest = cache.summaries.keys().next().value as string | undefined
    if (oldest === undefined) break
    deleteCachedWorkflowRunSummary(cache, oldest)
  }
}

function cachedWorkflowRunSummary(
  cache: WorkflowRunIndexCache,
  runId: string
): WorkflowRunSummary | undefined {
  const summary = cache.summaries.get(runId)
  if (!summary) return undefined
  const bytes = cache.summarySizes.get(runId) ?? 0
  cache.summaries.delete(runId)
  cache.summarySizes.delete(runId)
  cache.summaries.set(runId, summary)
  cache.summarySizes.set(runId, bytes)
  return summary
}

function touchWorkflowRunIndexCache(
  indexPath: string,
  cache: WorkflowRunIndexCache
): WorkflowRunIndexCache {
  workflowRunIndexCaches.delete(indexPath)
  workflowRunIndexCaches.set(indexPath, cache)
  return cache
}

/** @internal Hard-bound diagnostics for long-lived thread-switch regressions. */
export function getWorkflowStorageCacheDiagnosticsForTest(): {
  candidateEntries: number
  candidateMaxEntries: number
  candidateInFlight: number
  candidateAdmissionRejected: number
  indexEntries: number
  indexMaxEntries: number
  indexMutationsInFlight: number
  indexAdmissionRejected: number
  summaryEntries: number
  summaryBytes: number
  summaryMaxEntriesPerIndex: number
  summaryMaxBytesPerIndex: number
} {
  let summaryEntries = 0
  let summaryBytes = 0
  for (const cache of workflowRunIndexCaches.values()) {
    summaryEntries += cache.summaries.size
    summaryBytes += cache.summaryBytes
  }
  return {
    candidateEntries: workflowRunsDirCandidateCache.size,
    candidateMaxEntries: WORKFLOW_RUN_DIR_CANDIDATE_CACHE_MAX_ENTRIES,
    candidateInFlight: workflowRunsDirCandidateAsyncCache.size,
    candidateAdmissionRejected: rejectedWorkflowRunDirCandidateResolutions,
    indexEntries: workflowRunIndexCaches.size,
    indexMaxEntries: WORKFLOW_RUN_INDEX_CACHE_MAX_ENTRIES,
    indexMutationsInFlight: workflowRunIndexMutationChains.size,
    indexAdmissionRejected: rejectedWorkflowRunIndexCaches,
    summaryEntries,
    summaryBytes,
    summaryMaxEntriesPerIndex: WORKFLOW_RUN_SUMMARY_CACHE_MAX_ENTRIES,
    summaryMaxBytesPerIndex: WORKFLOW_RUN_SUMMARY_CACHE_MAX_BYTES
  }
}

/** Test-only process-lifecycle seam for cold-index regressions. */
export function resetWorkflowRunIndexCacheForTest(
  workspacePath: string,
  threadId: string
): void {
  const indexPath = workflowRunIndexFilePath(workspacePath, threadId)
  workflowRunIndexCaches.delete(indexPath)
  workflowRunIndexMutationChains.delete(indexPath)
}

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
  if (existing) return touchWorkflowRunIndexCache(indexPath, existing)

  // Idle entries are ordinary LRU. If every slot is actively reading,
  // discovering, or mutating, reject excess cold keys instead of letting a
  // burst of distinct thread requests grow an unbounded pending-cache map.
  evictWorkflowRunIndexCaches(WORKFLOW_RUN_INDEX_CACHE_MAX_ENTRIES - 1)
  if (workflowRunIndexCaches.size >= WORKFLOW_RUN_INDEX_CACHE_MAX_ENTRIES) {
    rejectedWorkflowRunIndexCaches += 1
    throw new Error("workflow run index cache is busy; retry after current reads finish")
  }

  const cache: WorkflowRunIndexCache = {
    entries: new Map(),
    summaries: new Map(),
    summarySizes: new Map(),
    summaryBytes: 0,
    sortedEntries: null,
    pendingNotificationRunIds: null,
    indexMtimeMs: 0,
    discovered: false,
    ready: Promise.resolve(),
    readyPending: true,
    discoveryPromise: null
  }
  workflowRunIndexCaches.set(indexPath, cache)
  cache.ready = (async () => {
    try {
      await beforeWorkflowRunIndexReadForTest?.(indexPath)
      const loadedIndex = await readStableBoundedPath(indexPath, WORKFLOW_RUN_INDEX_MAX_BYTES)
      const parsed = JSON.parse(
        loadedIndex.bytes.toString("utf8")
      ) as Partial<WorkflowRunIndexFile>
      if (
        parsed.version !== WORKFLOW_RUN_INDEX_VERSION ||
        !Array.isArray(parsed.entries) ||
        parsed.entries.length > WORKFLOW_RUN_INDEX_MAX_ENTRIES ||
        (Array.isArray(parsed.pendingNotificationRunIds) &&
          parsed.pendingNotificationRunIds.length > WORKFLOW_RUN_INDEX_MAX_ENTRIES)
      ) {
        return
      }
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
              : {}),
            ...(entry.sourceAuthority === "managed" ||
            entry.sourceAuthority === "pre-custom-managed" ||
            entry.sourceAuthority === "workspace-legacy"
              ? { sourceAuthority: entry.sourceAuthority }
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
      cache.indexMtimeMs = loadedIndex.mtimeMs
    } catch {
      // Missing/corrupt index is rebuilt asynchronously from per-run summaries.
    } finally {
      cache.readyPending = false
      evictWorkflowRunIndexCaches()
    }
  })()
  evictWorkflowRunIndexCaches()
  return cache
}

async function writeWorkflowRunIndex(
  workspacePath: string,
  threadId: string,
  cache: WorkflowRunIndexCache
): Promise<void> {
  const indexPath = workflowRunIndexFilePath(workspacePath, threadId)
  const indexDir = dirname(indexPath)
  const bornDisposalEpoch = threadDisposalEpochs.get(threadId) ?? 0
  const isStale = (): boolean =>
    disposedThreadIds.has(threadId) ||
    disposedRunDirs.has(indexDir) ||
    (threadDisposalEpochs.get(threadId) ?? 0) !== bornDisposalEpoch
  if (isStale()) return
  if (
    cache.entries.size > WORKFLOW_RUN_INDEX_MAX_ENTRIES ||
    (cache.pendingNotificationRunIds?.size ?? 0) > WORKFLOW_RUN_INDEX_MAX_ENTRIES
  ) {
    throw new Error(`workflow run index exceeds ${WORKFLOW_RUN_INDEX_MAX_ENTRIES} entries`)
  }
  const temp = `${indexPath}.${randomUUID()}.tmp`
  const payload: WorkflowRunIndexFile = {
    version: WORKFLOW_RUN_INDEX_VERSION,
    entries: Array.from(cache.entries.values())
      .sort(byNewestRun)
      .map(({ runId, startedAt, status, notificationDelivered, sourceAuthority }) => ({
        runId,
        startedAt,
        ...(status === undefined ? {} : { status }),
        ...(notificationDelivered === undefined ? {} : { notificationDelivered }),
        ...(sourceAuthority === undefined ? {} : { sourceAuthority })
      })),
    ...(cache.pendingNotificationRunIds
      ? { pendingNotificationRunIds: Array.from(cache.pendingNotificationRunIds) }
      : {})
  }
  try {
    await waitForPendingRunDirSweep(indexDir)
    await mkdir(indexDir, { recursive: true })
    if (isStale()) {
      if (disposedRunDirs.has(indexDir)) await sweepRacedRunDir(indexDir)
      return
    }
    await writeFile(temp, JSON.stringify(payload))
    await beforeWorkflowRunIndexPublishForTest?.(indexPath)
    if (isStale()) return
    await rename(temp, indexPath)
    try {
      cache.indexMtimeMs = (await stat(indexPath)).mtimeMs
    } catch {
      // The rename is already durable. Zero makes the next discovery
      // conservatively revalidate rather than treating this as a failed write.
      cache.indexMtimeMs = 0
    }
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
  if (disposedThreadIds.has(threadId) || disposedRunDirs.has(dirname(indexPath))) return
  const bornDisposalEpoch = threadDisposalEpochs.get(threadId) ?? 0
  const previous = workflowRunIndexMutationChains.get(indexPath) ?? Promise.resolve()
  const operation = previous.then(async () => {
    if (
      disposedThreadIds.has(threadId) ||
      disposedRunDirs.has(dirname(indexPath)) ||
      (threadDisposalEpochs.get(threadId) ?? 0) !== bornDisposalEpoch
    ) {
      return
    }
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
    evictWorkflowRunIndexCaches()
  }
}

async function writeWorkflowRunSummarySidecar(
  workspacePath: string,
  threadId: string,
  runId: string,
  srcMtime: number,
  summary: WorkflowRunSummary,
  sourceDir = getWorkflowRunsDir(workspacePath, threadId)
): Promise<void> {
  const sidecarPath = summaryFilePath(workspacePath, threadId, runId, sourceDir)
  const temp = `${sidecarPath}.${randomUUID()}.tmp`
  try {
    const serialized = JSON.stringify({ version: 1, srcMtime, summary })
    if (Buffer.byteLength(serialized, "utf8") > WORKFLOW_RUN_SUMMARY_MAX_BYTES) {
      throw new Error(`workflow run summary exceeds ${WORKFLOW_RUN_SUMMARY_MAX_BYTES} bytes`)
    }
    await writeFile(temp, serialized)
    await rename(temp, sidecarPath)
  } finally {
    await unlink(temp).catch(() => undefined)
  }
}

async function persistWorkflowRunSummaryArtifacts(
  workspacePath: string,
  threadId: string,
  run: PersistedWorkflowRun,
  sourceDir = getWorkflowRunsDir(workspacePath, threadId),
  updateSharedIndex = true
): Promise<void> {
  try {
    const summary = toRunSummary(run)
    const srcMtime = (await stat(runFilePathInDir(sourceDir, run.runId))).mtimeMs
    await writeWorkflowRunSummarySidecar(
      workspacePath,
      threadId,
      run.runId,
      srcMtime,
      summary,
      sourceDir
    )
    if (!updateSharedIndex) return
    await withWorkflowRunIndexMutation(workspacePath, threadId, async (cache) => {
      cacheWorkflowRunSummary(cache, run.runId, summary)
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
      const sourceAuthority = workflowRunSourceAuthority(workspacePath, threadId, sourceDir)
      const indexMetadataChanged =
        current?.startedAt !== run.startedAt ||
        current?.status !== summary.status ||
        current?.notificationDelivered !== summary.notificationDelivered ||
        current?.sourceAuthority !== sourceAuthority
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
        notificationDelivered: summary.notificationDelivered,
        sourceDir,
        sourceAuthority
      })
      if (current?.startedAt !== run.startedAt) cache.sortedEntries = null
      await writeWorkflowRunIndex(workspacePath, threadId, cache)
    })
  } catch (error) {
    console.warn(`[Workflow] Failed to update summary index for ${run.runId}:`, error)
  }
}

async function removeWorkflowRunsFromSummaryIndex(
  workspacePath: string,
  threadId: string,
  runIds: readonly string[]
): Promise<void> {
  if (runIds.length === 0) return
  try {
    await withWorkflowRunIndexMutation(workspacePath, threadId, async (cache) => {
      let changed = false
      for (const runId of runIds) {
        changed = cache.entries.delete(runId) || changed
        deleteCachedWorkflowRunSummary(cache, runId)
        cache.pendingNotificationRunIds?.delete(runId)
      }
      if (!changed) return
      cache.sortedEntries = null
      await writeWorkflowRunIndex(workspacePath, threadId, cache)
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[Workflow] Failed to prune workflow summary index:", error)
    }
  }
}

async function readWorkflowRunSummaryAsync(
  workspacePath: string,
  threadId: string,
  runId: string,
  sourceDir?: string,
  onLocated?: (sourceDir: string) => void
): Promise<WorkflowRunSummary | null> {
  let located = sourceDir
    ? await loadWorkflowRunFromDirAsync(sourceDir, runId, threadId)
    : await loadWorkflowRunWithLocationAsync(workspacePath, threadId, runId)
  // A durable source hint can become unreadable after runs.index was written.
  // Fall through the remaining authority roots instead of permanently hiding a
  // still-valid compatibility copy.
  if (!located && sourceDir) {
    located = await loadWorkflowRunWithLocationAsync(workspacePath, threadId, runId, sourceDir)
  }
  if (!located) return null
  onLocated?.(located.dir)
  let srcMtime: number
  try {
    srcMtime =
      asyncWorkflowRunSources.get(located.run)?.mtimeMs ??
      (await stat(located.sourcePath)).mtimeMs
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(
      (
        await readStableBoundedPath(
          summaryFilePath(workspacePath, threadId, runId, located.dir),
          WORKFLOW_RUN_SUMMARY_MAX_BYTES
        )
      ).bytes.toString("utf8")
    ) as { srcMtime?: unknown; summary?: unknown }
    if (parsed.srcMtime === srcMtime && isWorkflowRunSummary(parsed.summary)) {
      return parsed.summary
    }
  } catch {
    // Legacy run without a fresh sidecar is repaired below.
  }
  const summary = toRunSummary(located.run)
  await writeWorkflowRunSummarySidecar(
    workspacePath,
    threadId,
    runId,
    srcMtime,
    summary,
    located.dir
  ).catch(() => undefined)
  return summary
}

async function ensureWorkflowRunIndexDiscovered(
  workspacePath: string,
  threadId: string
): Promise<WorkflowRunIndexCache> {
  // Resolve/canonical-dedupe candidates asynchronously before the index helper
  // derives its managed path through the synchronous compatibility cache.
  await workflowRunsDirCandidatesAsync(workspacePath, threadId)
  const cache = getWorkflowRunIndexCache(workspacePath, threadId)
  await cache.ready
  if (cache.discovered) return cache
  if (!cache.discoveryPromise) {
    cache.discoveryPromise = withWorkflowRunIndexMutation(
      workspacePath,
      threadId,
      async (mutable) => {
        if (mutable.discovered) return
        const discoveredRunDirs = new Map<string, string>()
        for (const dir of await workflowRunReadDirsAsync(workspacePath, threadId)) {
          let files: string[]
          try {
            files = await readWorkflowDirectoryEntriesBounded(dir)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
            throw error
          }
          for (const file of files) {
            const runId = file.endsWith(".json.bak")
              ? file.slice(0, -".json.bak".length)
              : file.endsWith(".json")
                ? file.slice(0, -".json".length)
                : ""
            if (isValidWorkflowRunId(runId) && !discoveredRunDirs.has(runId)) {
              if (discoveredRunDirs.size >= WORKFLOW_RUN_INDEX_MAX_ENTRIES) {
                throw new Error(
                  `workflow run history exceeds ${WORKFLOW_RUN_INDEX_MAX_ENTRIES} runs`
                )
              }
              // readDirs is authority ordered: configured managed storage wins,
              // then the pre-custom-root managed directory, then workspace legacy.
              discoveredRunDirs.set(runId, dir)
            }
          }
        }
        if (discoveredRunDirs.size === 0) {
          mutable.entries.clear()
          clearCachedWorkflowRunSummaries(mutable)
          mutable.sortedEntries = []
          mutable.pendingNotificationRunIds = new Set()
          mutable.discovered = true
          return
        }
        const runIds = Array.from(discoveredRunDirs.keys())
        const runIdSet = new Set(runIds)
        // Rehydrate the portable source hint only after the async candidate
        // resolver has populated the canonical cache. This avoids realpathSync
        // on Electron main while retaining the prior process's valid fallback.
        for (const entry of mutable.entries.values()) {
          if (entry.sourceDir || !entry.sourceAuthority) continue
          entry.sourceDir = workflowRunDirForAuthority(
            workspacePath,
            threadId,
            entry.sourceAuthority
          )
        }
        // A durable index is the crash boundary: normal writers rename run.json
        // (and its backup) before runs.index. Stat every authority-selected run
        // asynchronously, then point-read only files that are at-or-newer than
        // the index snapshot. This catches a crash between those renames without
        // JSON.parse-ing thousands of unchanged delivered runs on first hydrate.
        const sourceMtimes = new Map(
          await mapWithConcurrency(
            runIds,
            WORKFLOW_RUN_SUMMARY_BACKFILL_CONCURRENCY,
            async (runId): Promise<[string, number | null]> => {
              const dir = discoveredRunDirs.get(runId)!
              const values = await Promise.all(
                [runFilePathInDir(dir, runId), `${runFilePathInDir(dir, runId)}.bak`].map(
                  async (path): Promise<number | null> => {
                    try {
                      return (await stat(path)).mtimeMs
                    } catch (error) {
                      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Number.NaN
                    }
                  }
                )
              )
              if (values.some((value) => Number.isNaN(value))) return [runId, null]
              const present = values.filter((value): value is number => value !== null)
              return [runId, present.length > 0 ? Math.max(...present) : null]
            }
          )
        )
        let changed = false
        for (const runId of mutable.entries.keys()) {
          if (runIdSet.has(runId)) continue
          mutable.entries.delete(runId)
          deleteCachedWorkflowRunSummary(mutable, runId)
          mutable.pendingNotificationRunIds?.delete(runId)
          changed = true
        }
        // Legacy entries lack notification metadata. Running/pending entries and
        // artifacts at the index crash boundary are revalidated once per process.
        const missing = runIds.filter((runId) => {
          const entry = mutable.entries.get(runId)
          return (
            !entry ||
            // sourceDir is intentionally in-memory-only and therefore absent
            // after loading runs.index in a new process. Undefined is not a
            // source change: treating it as one reparsed EVERY delivered run at
            // first hydrate and defeated the compact index. A concrete mismatch
            // within this process still triggers authority revalidation.
            (entry.sourceDir !== undefined && entry.sourceDir !== discoveredRunDirs.get(runId)) ||
            entry.status === undefined ||
            entry.notificationDelivered === undefined ||
            entry.status === "running" ||
            entry.notificationDelivered === false ||
            sourceMtimes.get(runId) === null ||
            (sourceMtimes.get(runId) ?? Number.POSITIVE_INFINITY) >= mutable.indexMtimeMs
          )
        })
        const repaired = await mapWithConcurrency(
          missing,
          WORKFLOW_RUN_SUMMARY_BACKFILL_CONCURRENCY,
          async (runId) => {
            let sourceDir = discoveredRunDirs.get(runId)!
            let summary = await readWorkflowRunSummaryAsync(
              workspacePath,
              threadId,
              runId,
              sourceDir,
              (locatedDir) => {
                sourceDir = locatedDir
              }
            )
            if (!summary) {
              const fallback = await loadWorkflowRunWithLocationAsync(
                workspacePath,
                threadId,
                runId,
                sourceDir
              )
              if (fallback) {
                sourceDir = fallback.dir
                summary = await readWorkflowRunSummaryAsync(
                  workspacePath,
                  threadId,
                  runId,
                  sourceDir,
                  (locatedDir) => {
                    sourceDir = locatedDir
                  }
                )
              }
            }
            return { runId, sourceDir, summary }
          }
        )
        for (const { runId, sourceDir, summary } of repaired) {
          if (!summary) {
            changed = mutable.entries.delete(runId) || changed
            deleteCachedWorkflowRunSummary(mutable, runId)
            mutable.pendingNotificationRunIds?.delete(runId)
            continue
          }
            mutable.entries.set(runId, {
            runId,
            startedAt: summary.startedAt,
            status: summary.status,
              notificationDelivered: summary.notificationDelivered,
              sourceDir,
              sourceAuthority: workflowRunSourceAuthority(
                workspacePath,
                threadId,
                sourceDir
              )
          })
          cacheWorkflowRunSummary(mutable, runId, summary)
          changed = true
        }
        // Reattach the authority-ordered source location without persisting
        // machine-specific absolute paths. This makes subsequent point reads in
        // the process direct while keeping runs.index portable.
        for (const [runId, sourceDir] of discoveredRunDirs) {
          const entry = mutable.entries.get(runId)
          if (entry && entry.sourceDir === undefined) entry.sourceDir = sourceDir
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
      evictWorkflowRunIndexCaches()
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
      const cached = cachedWorkflowRunSummary(cache, entry.runId)
      if (cached) return cached
      let locatedSourceDir = entry.sourceDir
      const summary = await readWorkflowRunSummaryAsync(
        workspacePath,
        threadId,
        entry.runId,
        entry.sourceDir,
        (sourceDir) => {
          locatedSourceDir = sourceDir
        }
      )
      if (summary) {
        cacheWorkflowRunSummary(cache, entry.runId, summary)
        if (locatedSourceDir && locatedSourceDir !== entry.sourceDir) {
          await withWorkflowRunIndexMutation(workspacePath, threadId, async (mutable) => {
            const current = mutable.entries.get(entry.runId)
            if (!current) return
            current.sourceDir = locatedSourceDir
            current.sourceAuthority = workflowRunSourceAuthority(
              workspacePath,
              threadId,
              locatedSourceDir!
            )
            cacheWorkflowRunSummary(mutable, entry.runId, summary)
            await writeWorkflowRunIndex(workspacePath, threadId, mutable)
          })
        }
      }
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
    const discovered = new Map<string, string>()
    for (const dir of workflowRunReadDirs(workspacePath, threadId)) {
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir)) {
        const runId = file.endsWith(".json.bak")
          ? file.slice(0, -".json.bak".length)
          : file.endsWith(".json")
            ? file.slice(0, -".json".length)
            : ""
        if (isValidWorkflowRunId(runId) && !discovered.has(runId)) discovered.set(runId, dir)
      }
    }
    const summaries: WorkflowRunSummary[] = []
    for (const [runId, dir] of discovered) {
      const located =
        loadWorkflowRunFromDir(dir, runId, threadId) ??
        locateWorkflowRunSync(workspacePath, threadId, runId)
      if (!located) continue
      let srcMtime: number
      try {
        srcMtime = statSync(located.sourcePath).mtimeMs
      } catch {
        continue // vanished between read and stat
      }
      // Fast path: a sidecar tagged with the run file's CURRENT mtime lets us skip
      // parsing the (possibly huge) journal. Stale/missing → full parse, then
      // (re)write the sidecar so the next listing is cheap.
      const sidecarPath = summaryFilePath(workspacePath, threadId, runId, located.dir)
      const cached = readFreshSidecar(sidecarPath, srcMtime)
      if (cached) {
        summaries.push(cached)
        continue
      }
      const summary = toRunSummary(located.run)
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
  let unresolved = 0
  for (const dir of workflowRunReadDirs(workspacePath, threadId)) {
    if (!existsSync(dir)) continue
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      if (failClosed) unresolved += 1
      continue
    }
    const runIds = new Set<string>()
    for (const file of files) {
      const runId = file.endsWith(".json.bak")
        ? file.slice(0, -".json.bak".length)
        : file.endsWith(".json")
          ? file.slice(0, -".json".length)
          : ""
      if (isValidWorkflowRunId(runId)) runIds.add(runId)
    }
    for (const runId of runIds) {
      const run = loadWorkflowRunFromPath(join(dir, `${runId}.json`), runId, threadId)
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
  }
  return unresolved
}

/** Async main-process variant of the deletion/workspace-switch guard. It keeps
 * directory traversal, run parsing, and checkout existence checks off Electron's
 * event loop while preserving the synchronous helper's fail-closed contract. */
export async function countUnresolvedWorkflowWorktreesAsync(
  workspacePath: string,
  threadId: string,
  options: { failClosedOnUnreadable?: boolean } = {}
): Promise<number> {
  const failClosed = options.failClosedOnUnreadable ?? true
  let unresolved = 0
  for (const dir of await workflowRunReadDirsAsync(workspacePath, threadId)) {
    let files: string[]
    try {
      files = await readWorkflowDirectoryEntriesBounded(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      if (failClosed) unresolved += 1
      continue
    }
    const runIds = new Set<string>()
    for (const file of files) {
      const runId = file.endsWith(".json.bak")
        ? file.slice(0, -".json.bak".length)
        : file.endsWith(".json")
          ? file.slice(0, -".json".length)
          : ""
      if (isValidWorkflowRunId(runId)) runIds.add(runId)
    }
    const counts = await mapWithConcurrency(
      Array.from(runIds),
      WORKFLOW_RUN_SUMMARY_BACKFILL_CONCURRENCY,
      async (runId) => {
        const located = await loadWorkflowRunFromDirAsync(dir, runId, threadId)
        if (!located) return failClosed ? 1 : 0
        const worktreeStates = await mapWithConcurrency(
          located.run.worktrees ?? [],
          WORKFLOW_RUN_SUMMARY_BACKFILL_CONCURRENCY,
          async (record) => {
            if (
              (record.status !== "merged" && record.status !== "discarded") ||
              record.cleanupPending === true
            ) {
              return 1
            }
            try {
              await stat(record.directory)
              return 1
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : 1
            }
          }
        )
        return worktreeStates.reduce<number>((sum, value) => sum + value, 0)
      }
    )
    unresolved += counts.reduce<number>((sum, value) => sum + value, 0)
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
    const readDirs = workflowRunReadDirs(workspacePath, threadId)
    const discovered = new Map<string, { runId: string; mtimeMs: number; dirs: Set<string> }>()
    for (const dir of readDirs) {
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir)) {
        const runId = file.endsWith(".json.bak")
          ? file.slice(0, -".json.bak".length)
          : file.endsWith(".json")
            ? file.slice(0, -".json".length)
            : ""
        if (!isValidWorkflowRunId(runId)) continue
        let mtimeMs: number
        try {
          mtimeMs = statSync(join(dir, file)).mtimeMs
        } catch {
          continue
        }
        const existing = discovered.get(runId)
        if (existing) {
          existing.mtimeMs = Math.max(existing.mtimeMs, mtimeMs)
          existing.dirs.add(dir)
        } else {
          discovered.set(runId, { runId, mtimeMs, dirs: new Set([dir]) })
        }
      }
    }
    const candidates = Array.from(discovered.values())
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
      // Parse lazily only after stat ordering. Within one run id, preserve the
      // read-root authority order and fall through a corrupt higher-priority
      // copy to the next compatibility source.
      let run: PersistedWorkflowRun | null = null
      for (const dir of readDirs) {
        if (!candidate.dirs.has(dir)) continue
        const located = loadWorkflowRunFromDir(dir, candidate.runId, threadId)
        if (located) {
          run = located.run
          break
        }
      }
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

/** Async main-process notification lookup. Discovery/revalidation is shared with
 * the compact runs.index cache; after that, only ids in its pending set are
 * point-read, newest first. Delivered history therefore never gets JSON-parsed
 * by the per-turn lookup, while a corrupt/stale candidate safely falls through
 * to the next pending id. The synchronous API above remains for compatibility
 * callers that cannot await. */
export async function findUndeliveredTerminalRunAsync(
  workspacePath: string,
  threadId: string,
  isEligible?: (run: PersistedWorkflowRun) => boolean
): Promise<PersistedWorkflowRun | null> {
  try {
    const cache = await ensureWorkflowRunIndexDiscovered(workspacePath, threadId)
    const pending = cache.pendingNotificationRunIds
    if (!pending || pending.size === 0) return null
    const ordered = (cache.sortedEntries ??= Array.from(cache.entries.values()).sort(byNewestRun))
    for (const entry of ordered) {
      if (!pending.has(entry.runId)) continue
      const run = await loadWorkflowRunAsync(workspacePath, threadId, entry.runId)
      if (!run || run.status === "running" || run.notificationDelivered) continue
      if (isEligible && !isEligible(run)) continue
      return run
    }
    return null
  } catch (error) {
    console.warn("[Workflow] Failed to scan asynchronously for pending notification:", error)
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

/** Convert a pre-journal-split run into the current sidecar layout before a
 * metadata-only mutation writes a small run.json. Journal-first ordering means a
 * sidecar failure leaves the original inline run untouched; a crash after the
 * sidecar rename still leaves two equivalent replay sources. */
async function externalizeInlineJournalForMutation(
  dir: string,
  runId: string,
  run: PersistedWorkflowRun
): Promise<PersistedWorkflowRun> {
  if (run.journal.length === 0) return run
  const target = workflowRunArtifactPathInDir(dir, runId, ".journal")
  const temp = `${target}.mutation-${randomUUID()}.tmp`
  await writeWorkflowJournalSidecar(temp, target, run.journal)
  return { ...run, journal: [] }
}

/** Publish one metadata mutation to the primary file and then advance its
 * fallback monotonically. Backup failure is deliberately best-effort: the
 * already-renamed primary remains authoritative and must not be rolled back. */
async function persistWorkflowRunMutationSnapshot(
  target: string,
  run: PersistedWorkflowRun,
  label: string
): Promise<void> {
  const json = JSON.stringify({ ...run, journal: [] })
  let primaryTemp: string | undefined = `${target}.${label}-${randomUUID()}.tmp`
  try {
    await writeFile(primaryTemp, json)
    await rename(primaryTemp, target)
    primaryTemp = undefined
  } finally {
    if (primaryTemp) await unlink(primaryTemp).catch(() => undefined)
  }

  const backup = `${target}.bak`
  let backupTemp: string | undefined = `${backup}.${label}-${randomUUID()}.tmp`
  try {
    await writeFile(backupTemp, json)
    await rename(backupTemp, backup)
    backupTemp = undefined
  } catch (error) {
    console.warn(`[Workflow] Failed to advance ${label} run backup:`, error)
  } finally {
    if (backupTemp) await unlink(backupTemp).catch(() => undefined)
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
  const located = await loadWorkflowRunWithLocationAsync(workspacePath, threadId, runId)
  if (!located) return false
  const path = runFilePathInDir(located.dir, runId)
  return withRunFileMutation(path, async () => {
    try {
      const current = await loadWorkflowRunFromDirAsync(located.dir, runId, threadId, true)
      let run = current?.run
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
      run = await externalizeInlineJournalForMutation(located.dir, runId, run)
      await persistWorkflowRunMutationSnapshot(path, run, "notification")
      await persistWorkflowRunSummaryArtifacts(workspacePath, threadId, run, located.dir)
      return true
    } catch (error) {
      console.warn("[Workflow] Failed to set run notification flag:", error)
      return false
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
  const located = await loadWorkflowRunWithLocationAsync(workspacePath, threadId, runId)
  if (!located) return null
  const target = runFilePathInDir(located.dir, runId)
  return withRunFileMutation(target, async () => {
    try {
      const current = await loadWorkflowRunFromDirAsync(located.dir, runId, threadId, true)
      let run = current?.run
      if (!run || run.status !== "running") return run ?? null
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
      run = await externalizeInlineJournalForMutation(located.dir, runId, run)
      await persistWorkflowRunMutationSnapshot(target, run, "interrupted")
      await persistWorkflowRunSummaryArtifacts(workspacePath, threadId, run, located.dir)
      return run
    } catch (error) {
      console.warn("[Workflow] Failed to reconcile interrupted run:", error)
      return (await loadWorkflowRunFromDirAsync(located.dir, runId, threadId))?.run ?? null
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
  expectedDisposalEpoch?: number,
  options: { preserveJournalSidecar?: boolean } = {}
): Promise<boolean> {
  // Deletion tombstone: this writer mkdirs, so an in-flight retry that grabbed
  // its snapshot BEFORE forgetThread() cleared the table could otherwise
  // rebuild a removed managed or legacy run directory after the sweep.
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
      const runDir = getWorkflowRunsDir(workspacePath, threadId)
      await waitForPendingRunDirSweep(runDir)
      await mkdir(runDir, { recursive: true })
      // Post-await recheck: a deletion landing DURING the mkdir already swept the
      // dir; writing now would rebuild it as an orphan (mirrors doWrite). Remove
      // the empty dir our mkdir may have rebuilt — tombstone-active only; an
      // epoch-only mismatch means a revived incarnation may own the dir.
      if (isStale()) {
        const dir = runDir
        // Dir-tombstone-only rm (see sweepRacedRunDir): a bare id-set hit is a
        // rollback-able deletion ATTEMPT — the dir may still belong to the
        // surviving thread and must not be touched.
        if (disposedRunDirs.has(dir)) await sweepRacedRunDir(dir)
        return isDeadIncarnation()
      }
      const journalPath = journalFilePath(workspacePath, threadId, run.runId)
      let recoveredRun = run
      if (
        run.resultSidecarStatus === "available" &&
        !(await isValidWorkflowResultFileAsync(
          workflowResultFilePath(workspacePath, threadId, run.runId)
        ))
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
      if (Buffer.byteLength(json, "utf8") > WORKFLOW_RUN_PROJECTED_MAX_BYTES) {
        throw new Error(
          `workflow recovered run metadata exceeds ${WORKFLOW_RUN_PROJECTED_MAX_BYTES} bytes`
        )
      }
      // Journal first, run.json second — same crash-safe ordering as doWrite (#3): a
      // crash between the renames leaves journal>=run.json (resume re-runs nothing),
      // never run.json>journal (which would re-execute completed edit agents twice).
      if (options.preserveJournalSidecar) {
        const journalStat = await stat(journalPath)
        if (!journalStat.isFile() || journalStat.size > WORKFLOW_JOURNAL_MAX_BYTES) {
          throw new Error("workflow recovery journal sidecar is missing or exceeds its limit")
        }
      } else {
        journalTemp = `${journalPath}.recovered-${randomUUID()}.tmp`
        await writeWorkflowJournalSidecar(
          journalTemp,
          journalPath,
          recoveredRun.journal ?? []
        )
        journalTemp = undefined
      }
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

async function workflowRunHasUnresolvedWorktrees(run: PersistedWorkflowRun): Promise<boolean> {
  const states = await mapWithConcurrency(
    run.worktrees ?? [],
    WORKFLOW_RUN_SUMMARY_BACKFILL_CONCURRENCY,
    async (record) => {
      if (
        (record.status !== "merged" && record.status !== "discarded") ||
        record.cleanupPending === true
      ) {
        return true
      }
      try {
        await stat(record.directory)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true
      }
      // A terminal manifest outlives checkout removal until run history has
      // durably observed it. Keep that run so restart reconciliation still has
      // a route to finalize a branch-only/tombstone cleanup.
      const identity = createHash("sha256").update(record.id).digest("hex").slice(0, 16)
      try {
        return (
          await readWorkflowDirectoryEntriesBounded(
            join(dirname(record.directory), ".records")
          )
        ).some((file) => file.endsWith(`-${identity}.json`))
      } catch (error) {
        // ENOENT means the ownership store is genuinely absent. Any other read
        // failure is unknown state and must retain the run fail-closed.
        return (error as NodeJS.ErrnoException).code !== "ENOENT"
      }
    }
  )
  return states.some(Boolean)
}

/**
 * Caps accumulated run artifacts per thread by deleting old terminal+delivered
 * runs beyond the newest `keep` ids. Every directory/stat/read/unlink is async,
 * keeping a large history or slow compatibility root off Electron's event loop.
 * Running, undelivered, unresolved-worktree, protected, and unreadable runs are
 * retained even when they exceed the cap; preserving recovery wins over a hard
 * file-count limit. Best-effort; never rejects.
 */
let beforeWorkflowPruneMutationForTest:
  | ((run: PersistedWorkflowRun) => void | Promise<void>)
  | undefined

/** @internal Deterministic seam between prune eligibility and its final locked recheck. */
export function setBeforeWorkflowPruneMutationForTest(
  hook?: (run: PersistedWorkflowRun) => void | Promise<void>
): void {
  beforeWorkflowPruneMutationForTest = hook
}

export async function pruneWorkflowRuns(
  workspacePath: string,
  threadId: string,
  keep: number = MAX_RUNS_PER_THREAD,
  protectedRunIds: Iterable<string> = []
): Promise<void> {
  try {
    const dirs = await workflowRunReadDirsAsync(workspacePath, threadId)
    let listingsReliable = true
    const listings = await Promise.all(
      dirs.map(async (dir) => {
        try {
          return { dir, files: await readWorkflowDirectoryEntriesBounded(dir) }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return { dir, files: [] }
          listingsReliable = false
          console.warn(`[Workflow] Run prune could not enumerate ${dir}:`, error)
          return { dir, files: [] }
        }
      })
    )
    // An unreadable compatibility root may contain the authoritative copy or a
    // retained worktree. Do not partially prune another root when that state is unknown.
    if (!listingsReliable) return

    const artifacts = listings.flatMap(({ dir, files }) =>
      files.flatMap((file) => {
        const runId = file.endsWith(".json.bak")
          ? file.slice(0, -".json.bak".length)
          : file.endsWith(".json")
            ? file.slice(0, -".json".length)
            : ""
        return isValidWorkflowRunId(runId) ? [{ dir, file, runId }] : []
      })
    )
    if (artifacts.length === 0) return
    const dated = await mapWithConcurrency(
      artifacts,
      WORKFLOW_RUN_SUMMARY_BACKFILL_CONCURRENCY,
      async (artifact) => {
        try {
          return { ...artifact, mtimeMs: (await stat(join(artifact.dir, artifact.file))).mtimeMs }
        } catch {
          // Keep unreadable entries in the candidate set. Their point-read below
          // fails closed, so a stat failure can never turn into deletion.
          return { ...artifact, mtimeMs: 0 }
        }
      }
    )
    const discovered = new Map<string, { runId: string; mtimeMs: number }>()
    for (const artifact of dated) {
      const current = discovered.get(artifact.runId)
      if (!current || artifact.mtimeMs > current.mtimeMs) {
        discovered.set(artifact.runId, {
          runId: artifact.runId,
          mtimeMs: artifact.mtimeMs
        })
      }
    }
    const runs = Array.from(discovered.values()).sort(
      (a, b) => b.mtimeMs - a.mtimeMs || b.runId.localeCompare(a.runId)
    )
    const retainedCount = Number.isFinite(keep)
      ? Math.max(0, Math.floor(keep))
      : runs.length
    const manifestRunIds = new Set(protectedRunIds)
    const removed = await mapWithConcurrency(
      runs.slice(retainedCount),
      WORKFLOW_RUN_SUMMARY_BACKFILL_CONCURRENCY,
      async (stale): Promise<string | null> => {
        // NEVER prune a still-running run, or a terminal run whose completion
        // notification was never delivered: an undelivered run keeps its older
        // mtime and can fall past the cap. If it cannot be loaded, retain it.
        const observedRun = await loadWorkflowRunAsync(workspacePath, threadId, stale.runId)
        if (
          !observedRun ||
          observedRun.status === "running" ||
          !observedRun.notificationDelivered ||
          manifestRunIds.has(stale.runId) ||
          (await workflowRunHasUnresolvedWorktrees(observedRun))
        ) {
          return null
        }
        await beforeWorkflowPruneMutationForTest?.(observedRun)
        const runPaths = dirs.map((dir) => runFilePathInDir(dir, stale.runId))
        return withRunFileMutationLocks(runPaths, async () => {
          // A replacement store registers its managed generation synchronously,
          // before its initial async write. If it appeared while pruning selected
          // candidates, it owns this runId now and the old artifact set is no
          // longer safe to delete.
          if (storeGenerations.has(runFilePath(workspacePath, threadId, stale.runId))) {
            return null
          }
          // Final fresh read INSIDE all source mutation chains. A notification
          // ack, worktree action, or a very fast resume may have changed the run
          // while the async directory/stat phase yielded to the event loop.
          const run = await loadWorkflowRunAsync(workspacePath, threadId, stale.runId)
          if (
            !run ||
            run.startedAt !== observedRun.startedAt ||
            run.status === "running" ||
            !run.notificationDelivered ||
            manifestRunIds.has(stale.runId) ||
            (await workflowRunHasUnresolvedWorktrees(run))
          ) {
            return null
          }

          // An old display write uses a separate per-sidecar chain. Queue its
          // delete now (without awaiting a possibly hung display op); a new
          // incarnation's persist waits for this run mutation lock and then
          // queues behind that delete on the sidecar chain.
          enqueuePendingAgentToolStreamDeletes(dirs, stale.runId)
          const fixedSuffixes = [
            ".json",
            ".json.bak",
            ".json.tmp",
            ".workflow.js",
            ".summary",
            ".journal",
            ".journal.tmp",
            ".result",
            ".result.tmp"
          ]
          const paths = dirs.flatMap((dir) =>
            fixedSuffixes.map((suffix) => join(dir, `${stale.runId}${suffix}`))
          )
          const toolStreamPrefix = `${stale.runId}.`
          for (const { dir, files } of listings) {
            for (const file of files) {
              if (
                file.startsWith(toolStreamPrefix) &&
                (file.endsWith(".toolstream") || file.endsWith(".toolstream.tmp"))
              ) {
                paths.push(join(dir, file))
              }
            }
          }
          await mapWithConcurrency(
            paths,
            WORKFLOW_RUN_SUMMARY_BACKFILL_CONCURRENCY,
            async (path) => {
              try {
                await unlink(path)
              } catch {
                // Best effort: existence verification below keeps a failed
                // run-file deletion indexed and recovery-visible.
              }
            }
          )
          const remaining = await mapWithConcurrency(
            runPaths.flatMap((path) => [path, `${path}.bak`]),
            WORKFLOW_RUN_SUMMARY_BACKFILL_CONCURRENCY,
            async (path) => {
              try {
                await stat(path)
                return true
              } catch (error) {
                return (error as NodeJS.ErrnoException).code !== "ENOENT"
              }
            }
          )
          return remaining.some(Boolean) ? null : stale.runId
        })
      }
    )
    await removeWorkflowRunsFromSummaryIndex(
      workspacePath,
      threadId,
      removed.filter((runId): runId is string => runId !== null)
    )
  } catch (error) {
    console.warn("[Workflow] Run prune failed:", error)
  }
}

/** Acquire several per-run-file mutation chains in a stable order. New managed
 * writes use the same chain, while legacy terminal actions use their source
 * chain, so a multi-root prune can make its final eligibility check and delete
 * the complete artifact set as one logical critical section. */
async function withRunFileMutationLocks<T>(
  targets: readonly string[],
  task: () => Promise<T>
): Promise<T> {
  const ordered = Array.from(new Set(targets)).sort((a, b) => a.localeCompare(b))
  const acquire = (index: number): Promise<T> =>
    index >= ordered.length
      ? task()
      : withRunFileMutation(ordered[index], () => acquire(index + 1))
  return acquire(0)
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
  if (!isValidWorkflowRunId(runId)) return null
  const located = workflowRunReadDirs(workspacePath, threadId)
    .map((dir) => loadWorkflowRunFromDir(dir, runId, threadId))
    .find((candidate): candidate is LocatedWorkflowRun => candidate !== null)
  if (!located) return null
  const run = located.run
  // Legacy run persisted with an inline journal (pre-split) — already populated.
  if (run.journal.length > 0) return run
  const journalPath = journalFilePath(workspacePath, threadId, runId, located.dir)
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
  if (!isValidWorkflowRunId(runId)) return null
  const located = (
    await Promise.all(
      (await workflowRunReadDirsAsync(workspacePath, threadId)).map((dir) =>
        loadWorkflowRunFromDirAsync(dir, runId, threadId)
      )
    )
  ).filter((candidate): candidate is LocatedWorkflowRun => candidate !== null)
  if (located.length === 0) return null

  // A reused runId may represent a later resume incarnation in the managed
  // root and an older incarnation in a compatibility root. Only candidates
  // with the authoritative startedAt may contribute a journal/worktree; this
  // prevents replaying old agent results into a different execution.
  const authoritativeStartedAt = located[0].run.startedAt
  const authoritativeScriptSha = located[0].run.scriptSha256
  const compatible = located.filter(
    (candidate) =>
      candidate.run.startedAt === authoritativeStartedAt &&
      candidate.run.scriptSha256 === authoritativeScriptSha
  )
  const merged = mergeLocatedWorkflowRuns(compatible)!

  for (const candidate of compatible) {
    // Ordinary discovery above intentionally omits inline journals. Point-read
    // one compatible root at a time so two 128 MiB legacy copies can never both
    // accumulate in main; return as soon as one complete incarnation is found.
    const inlineCandidate = await loadWorkflowRunFromDirAsync(
      candidate.dir,
      runId,
      threadId,
      true
    )
    if (
      !inlineCandidate ||
      inlineCandidate.run.startedAt !== authoritativeStartedAt ||
      inlineCandidate.run.scriptSha256 !== authoritativeScriptSha
    ) {
      continue
    }
    if (inlineCandidate.run.journal.length > 0) {
      return { ...merged, journal: inlineCandidate.run.journal }
    }
    const journalPath = journalFilePath(workspacePath, threadId, runId, candidate.dir)
    try {
      const parsed = await readWorkflowJournalSidecar(journalPath)
      return { ...merged, journal: parsed }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[Workflow] Failed to read journal sidecar ${journalPath}:`, error)
      }
    }
  }

  return compatible.some((candidate) => candidate.run.agents.length > 0) ? null : merged
}

export function loadWorkflowRun(
  workspacePath: string,
  threadId: string,
  runId: string
): PersistedWorkflowRun | null {
  if (!isValidWorkflowRunId(runId)) return null
  const located = workflowRunReadDirs(workspacePath, threadId).flatMap((dir) => {
    const candidate = loadWorkflowRunFromDir(dir, runId, threadId)
    return candidate ? [candidate] : []
  })
  return mergeLocatedWorkflowRuns(located)
}

interface LocatedWorkflowRun {
  run: PersistedWorkflowRun
  dir: string
  /** The actual readable source: primary `.json` or backup `.json.bak`. */
  sourcePath: string
}

function loadWorkflowRunFromDir(
  dir: string,
  runId: string,
  threadId?: string
): LocatedWorkflowRun | null {
  const path = runFilePathInDir(dir, runId)
  for (const candidate of [path, `${path}.bak`]) {
    try {
      if (!existsSync(candidate)) continue
      const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as unknown
      if (
        isPersistedWorkflowRunShape(parsed) &&
        parsed.runId === runId &&
        (threadId === undefined || parsed.threadId === threadId)
      ) {
        return { run: parsed, dir, sourcePath: candidate }
      }
    } catch (error) {
      console.warn(`[Workflow] Failed to read run file ${candidate}:`, error)
    }
  }
  return null
}

function loadWorkflowRunFromPath(
  path: string,
  runId: string,
  threadId?: string
): PersistedWorkflowRun | null {
  return loadWorkflowRunFromDir(dirname(path), runId, threadId)?.run ?? null
}

function mergeLocatedWorkflowRuns(located: readonly LocatedWorkflowRun[]): PersistedWorkflowRun | null {
  if (located.length === 0) return null
  const authoritative = located[0].run
  if (located.length === 1) return authoritative

  // A briefly split store can contain the same run id in more than one root.
  // Keep the authority-ordered run body, but surface every durable worktree so
  // the UI retains an action route and thread deletion can never deadlock on a
  // hidden legacy checkout.
  const worktrees = new Map((authoritative.worktrees ?? []).map((record) => [record.id, record]))
  for (const { run } of located.slice(1)) {
    for (const record of run.worktrees ?? []) {
      worktrees.set(record.id, newerWorkflowWorktreeRecord(worktrees.get(record.id), record))
    }
  }
  const merged = { ...authoritative, worktrees: Array.from(worktrees.values()) }
  const provenance = asyncWorkflowRunSources.get(authoritative)
  if (provenance) asyncWorkflowRunSources.set(merged, provenance)
  return merged
}

async function loadWorkflowRunFromDirAsync(
  dir: string,
  runId: string,
  threadId?: string,
  includeInlineJournal = false
): Promise<LocatedWorkflowRun | null> {
  const path = runFilePathInDir(dir, runId)
  for (const candidate of [path, `${path}.bak`]) {
    let opened: Awaited<ReturnType<typeof openStableFileHandle>> | undefined
    try {
      opened = await openStableFileHandle(dirname(candidate), candidate)
      await beforeWorkflowRunPointReadForTest?.(candidate)
      if (opened.size > WORKFLOW_RUN_FILE_MAX_BYTES) continue
      const initialStat = await opened.handle.stat()
      const before: WorkflowRunFileStat = {
        dev: initialStat.dev,
        ino: initialStat.ino,
        size: initialStat.size,
        mtimeMs: initialStat.mtimeMs,
        ctimeMs: initialStat.ctimeMs,
        isFile: () => true
      }
      const { parsed, after } =
        before.size > WORKFLOW_RUN_MAIN_THREAD_PARSE_MAX_BYTES
          ? await readAndParseLargeWorkflowRunFile(candidate, opened, includeInlineJournal)
          : await (async (): Promise<ParsedWorkflowRunFile> => {
              const parsed = await parseWorkflowRunJsonAsync(
                await readStableFileHandleBounded(opened!, WORKFLOW_RUN_FILE_MAX_BYTES),
                includeInlineJournal
              )
              return { parsed, after: await finalWorkflowRunFileStat(opened!) }
            })()
      if (
        isPersistedWorkflowRunShape(parsed) &&
        parsed.runId === runId &&
        (threadId === undefined || parsed.threadId === threadId) &&
        sameWorkflowRunFileIdentity(before, after)
      ) {
        asyncWorkflowRunSources.set(parsed, {
          dir,
          sourcePath: candidate,
          dev: after.dev,
          ino: after.ino,
          size: after.size,
          mtimeMs: after.mtimeMs,
          ctimeMs: after.ctimeMs,
          startedAt: parsed.startedAt,
          status: parsed.status,
          completedAt: parsed.completedAt,
          scriptSha256: parsed.scriptSha256,
          updatedAt: parsed.updatedAt,
          resultSidecarStatus: parsed.resultSidecarStatus
        })
        return { run: parsed, dir, sourcePath: candidate }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[Workflow] Failed to read run file ${candidate}:`, error)
      }
    } finally {
      await opened?.handle.close().catch(() => undefined)
    }
  }
  return null
}

let beforeWorkflowRunPointReadForTest: ((path: string) => void | Promise<void>) | undefined

/** @internal Point-read observation seam; never used by production. */
export function setBeforeWorkflowRunPointReadForTest(
  hook?: (path: string) => void | Promise<void>
): void {
  beforeWorkflowRunPointReadForTest = hook
}

async function loadWorkflowRunWithLocationAsync(
  workspacePath: string,
  threadId: string,
  runId: string,
  excludedDir?: string
): Promise<LocatedWorkflowRun | null> {
  for (const dir of await workflowRunReadDirsAsync(workspacePath, threadId)) {
    if (dir === excludedDir) continue
    const located = await loadWorkflowRunFromDirAsync(dir, runId, threadId)
    if (located) return located
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
  const located = (
    await Promise.all(
      (await workflowRunReadDirsAsync(workspacePath, threadId)).map((dir) =>
        loadWorkflowRunFromDirAsync(dir, runId, threadId)
      )
    )
  ).filter((candidate): candidate is LocatedWorkflowRun => candidate !== null)
  return mergeLocatedWorkflowRuns(located)
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
  const located = (
    await Promise.all(
      (await workflowRunReadDirsAsync(workspacePath, threadId)).map((dir) =>
        loadWorkflowRunFromDirAsync(dir, runId, threadId)
      )
    )
  ).filter((candidate): candidate is LocatedWorkflowRun => candidate !== null)
  if (located.length === 0) return null

  const recordsByDir = new Map<string, WorkflowWorktreeRecord[]>()
  for (const record of records) {
    const owners = located.filter(({ run }) =>
      (run.worktrees ?? []).some((candidate) => candidate.id === record.id)
    )
    // A newly-created record belongs to the authoritative copy. An existing
    // record is updated in EVERY split copy that owns it, so a stale legacy
    // checkout cannot remain unresolved after the visible action succeeded.
    for (const owner of owners.length > 0 ? owners : [located[0]]) {
      const values = recordsByDir.get(owner.dir) ?? []
      values.push(record)
      recordsByDir.set(owner.dir, values)
    }
  }

  await Promise.all(
    Array.from(recordsByDir, ([dir, dirRecords]) =>
      updateWorkflowWorktreeRecordsInDir(
        workspacePath,
        dir,
        threadId,
        runId,
        dirRecords,
        dir === located[0].dir
      )
    )
  )
  return loadWorkflowRunAsync(workspacePath, threadId, runId)
}

async function updateWorkflowWorktreeRecordsInDir(
  workspacePath: string,
  dir: string,
  threadId: string,
  runId: string,
  records: WorkflowWorktreeRecord[],
  updateSharedIndex: boolean
): Promise<PersistedWorkflowRun | null> {
  const target = runFilePathInDir(dir, runId)
  return withRunFileMutation(target, async () => {
    const located = await loadWorkflowRunFromDirAsync(dir, runId, threadId, true)
    if (!located) return null
    let run = located.run
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
    run = await externalizeInlineJournalForMutation(dir, runId, run)
    await persistWorkflowRunMutationSnapshot(target, run, "worktree")
    await persistWorkflowRunSummaryArtifacts(
      workspacePath,
      threadId,
      run,
      dir,
      updateSharedIndex
    )
    return run
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
  /** Capture the terminal fallback without a deep JSON round-trip. When the
   * journal sidecar already contains the current version, the returned run is
   * compact and recovery must preserve that sidecar instead of rewriting it. */
  captureFlushFailureSnapshot(): WorkflowFlushFailureSnapshot
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
  /** Async production twin; avoids synchronous directory/file reads on Electron's main loop. */
  isCurrentSnapshotPersistedAsync(): Promise<boolean>
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
 * deleted cannot recreate its removed managed or legacy run directory as an
 * orphan (the thread is gone from the DB, so nothing would ever
 * reconcile it). Keyed by the resolved run directory. ThreadIds are unique and
 * never reused, so entries can stay for the process lifetime (tiny, bounded).
 */
const disposedRunDirs = new Set<string>()
// Exact reverse index avoids scanning every historical tombstone whenever a
// fixed-id service thread is revived.
const disposedRunDirsByThread = new Map<string, Set<string>>()

/** Best-effort removal of a run dir that a raced mkdir rebuilt after deletion.
 * Sweeps are serialized per directory, and every new writer awaits the current
 * chain before mkdir. A fixed-id revival therefore cannot create its new
 * incarnation until an already-started recursive delete has finished.
 * the empty dir would otherwise linger forever — nothing sweeps again). Callers
 * must gate on disposedRunDirs — the DIR tombstone is set exactly where the
 * real sweep ran, i.e. the deletion passed its point of no return. NEVER gate
 * on the bare id set (a deletion ATTEMPT that may roll back — rm here would
 * destroy a surviving thread's artifacts) nor on generation/epoch-only
 * staleness (a newer resume store or revived incarnation may own the dir). */
const runDirSweepChains = new Map<string, Promise<void>>()
let beforeRunDirSweepForTest: ((dir: string) => void | Promise<void>) | undefined

/** @internal Deterministic seam for delete/revive ordering regressions. */
export function setBeforeWorkflowRunDirSweepForTest(
  hook?: (dir: string) => void | Promise<void>
): void {
  beforeRunDirSweepForTest = hook
}

export interface WorkflowFlushFailureSnapshot {
  run: PersistedWorkflowRun
  journalSource: "memory" | "sidecar"
  /** Conservative retained-memory estimate exposed by the manager's degraded
   * storage diagnostics. It follows the persisted metadata/journal contracts. */
  reservedBytes: number
}

export const WORKFLOW_FLUSH_FAILURE_METADATA_RESERVATION_BYTES =
  WORKFLOW_RUN_PROJECTED_MAX_BYTES
export const WORKFLOW_FLUSH_FAILURE_JOURNAL_RESERVATION_BYTES = WORKFLOW_JOURNAL_MAX_BYTES

async function sweepRacedRunDir(dir: string, committedDeletion = false): Promise<void> {
  const previous = runDirSweepChains.get(dir) ?? Promise.resolve()
  const sweep = previous
    .catch(() => undefined)
    .then(async () => {
      // Revival before this queued sweep starts transfers authority to the new
      // incarnation. The earlier in-flight sweep (if any) is still awaited by
      // writers through this same chain; this queued one must no longer delete.
      if (!committedDeletion && !disposedRunDirs.has(dir)) return
      try {
        await beforeRunDirSweepForTest?.(dir)
        await rm(dir, { recursive: true, force: true })
      } catch (error) {
        console.warn("[Workflow] Failed to delete run artifacts for thread:", error)
      }
    })
  runDirSweepChains.set(dir, sweep)
  try {
    await sweep
  } finally {
    if (runDirSweepChains.get(dir) === sweep) runDirSweepChains.delete(dir)
  }
}

async function waitForPendingRunDirSweep(dir: string): Promise<void> {
  await runDirSweepChains.get(dir)?.catch(() => undefined)
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
 * id-keyed entry and any legacy (`.../workflows/<threadId>`) or managed
 * (`.../<threadId>/workflows`) dir-keyed entries, so the new incarnation can
 * persist workflow runs again.
 * Deliberately does NOT reset the disposal epoch: stores created before the
 * deletion stay permanently silent — revive must never re-arm an old
 * incarnation's late flush (its doWrite mkdirs the swept directory back). */
export function reviveWorkflowThread(threadId: string): void {
  disposedThreadIds.delete(threadId)
  const dirs = disposedRunDirsByThread.get(threadId)
  if (dirs) {
    for (const dir of dirs) disposedRunDirs.delete(dir)
    disposedRunDirsByThread.delete(threadId)
  }
  clearWorkflowRunsDirCandidateCache(threadId)
}

/** True once a thread's run directory has been disposed (thread deleted): a late,
 * fire-and-forget write (e.g. a subagent tool-stream sidecar still settling) must check
 * this and skip, so it can't recreate either removed run directory as an
 * orphan after the thread is gone. */
export function isWorkflowRunDirDisposed(workspacePath: string, threadId: string): boolean {
  return (
    disposedThreadIds.has(threadId) ||
    disposedRunDirs.has(getWorkflowRunsDir(workspacePath, threadId))
  )
}

/** Async production twin. Candidate canonicalization may touch a network
 * workspace/root, so Electron main-process gates must not call the sync helper. */
export async function isWorkflowRunDirDisposedAsync(
  workspacePath: string,
  threadId: string
): Promise<boolean> {
  if (disposedThreadIds.has(threadId)) return true
  const candidates = await workflowRunsDirCandidatesAsync(workspacePath, threadId)
  return candidates.readDirs.some((dir) => disposedRunDirs.has(dir))
}

export function createWorkflowRunStore(options: {
  workspacePath: string
  threadId: string
  initial: PersistedWorkflowRun
}): WorkflowRunStore {
  const { workspacePath, threadId, initial } = options
  const path = runFilePath(workspacePath, threadId, initial.runId)
  const journalPath = journalFilePath(workspacePath, threadId, initial.runId)
  // Copy every container/record that the store mutates. Avoid a JSON round-trip:
  // a compatible legacy resume can carry up to 128 MiB of inline journal data,
  // and stringify+parse here would synchronously duplicate it on Electron main.
  // Nested args/result/structured values are execution payloads and are treated
  // as immutable; store mutations replace their owning record instead of editing
  // those values in place.
  const state: PersistedWorkflowRun = {
    ...initial,
    phases: [...initial.phases],
    agents: initial.agents.map((record) => ({ ...record })),
    worktrees: initial.worktrees?.map((record) => ({ ...record })),
    logs: [...initial.logs],
    journal: initial.journal.map((entry) => ({ ...entry })),
    stats: { ...initial.stats }
  }
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

  const doWriteUnlocked = async (withBak: boolean, isInitial = false): Promise<boolean> => {
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
      await waitForPendingRunDirSweep(runDir)
      await mkdir(runDir, { recursive: true })
      // Post-await recheck: a deletion landing DURING the mkdir has already
      // swept the dir — this mkdir may have rebuilt it, and writing now would
      // fill an orphan. Bail before any file lands; if our mkdir landed AFTER
      // the sweep, remove the empty dir it rebuilt (tombstone-active only —
      // see sweepRacedRunDir for why generation/epoch staleness must not rm).
      if (isStaleWriter()) {
        // Sweep ONLY behind the dir tombstone (deletion committed + swept):
        // a bare id-set hit is a rollback-able attempt, and rm'ing here would
        // destroy artifacts the surviving thread still owns.
        if (disposedRunDirs.has(runDir)) await sweepRacedRunDir(runDir)
        return true
      }
      // Journal lives in a SEPARATE sidecar so run.json stays small: get-run /
      // hydrate / history scan / mark-delivered parse run.json without paying for a
      // (potentially tens-of-MB) journal they never use. Only resume reads it back
      // (loadWorkflowRunForResume).
      const json = JSON.stringify({ ...state, journal: [] })
      if (Buffer.byteLength(json, "utf8") > WORKFLOW_RUN_PROJECTED_MAX_BYTES) {
        throw new Error(
          `workflow run metadata exceeds ${WORKFLOW_RUN_PROJECTED_MAX_BYTES} bytes`
        )
      }
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
      // resume. The shallow array snapshot is captured synchronously with this
      // version before the helper's first await; appendJournal replaces entries
      // rather than mutating them, so streamed bytes and version still match.
      // Advancing only after rename means a failed write retries next save.
      const journalVersionAtWrite = journalVersion
      if (journalVersionAtWrite !== lastWrittenJournalVersion) {
        await writeWorkflowJournalSidecar(
          `${journalPath}.tmp`,
          journalPath,
          state.journal.slice()
        )
        lastWrittenJournalVersion = journalVersionAtWrite
      }
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
      // runs.index is the final crash-boundary rename. Both primary and backup
      // must precede it; otherwise the backup's newer mtime would make every
      // clean terminal run look index-stale on the next process discovery.
      await persistWorkflowRunSummaryArtifacts(workspacePath, threadId, state)
      return true
    } catch (error) {
      console.warn(`[Workflow] Failed to persist run ${state.runId}:`, error)
      if (isInitial) initialPersistOk = false
      return false
    }
  }
  const doWrite = (withBak: boolean, isInitial = false): Promise<boolean> =>
    withRunFileMutation(path, () => doWriteUnlocked(withBak, isInitial))

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
  const doPersistFullResultUnlocked = async (resultJson: string | null): Promise<boolean> => {
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
          try {
            await unlink(stale)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }
        }
        return true
      }
      await waitForPendingRunDirSweep(runDir)
      await mkdir(runDir, { recursive: true })
      // Post-await recheck — same rationale (and same dir-tombstone-only rm) as doWrite's.
      if (isStaleWriter()) {
        if (disposedRunDirs.has(runDir)) await sweepRacedRunDir(runDir)
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
  const doPersistFullResult = (resultJson: string | null): Promise<boolean> =>
    withRunFileMutation(path, () => doPersistFullResultUnlocked(resultJson))

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
    captureFlushFailureSnapshot() {
      // The run is terminal and all engine writers have settled before this is
      // called. Copy only mutable containers/records; journal result strings and
      // structured values are immutable, so retaining their references avoids a
      // 128 MiB stringify+parse pause and duplicate allocation on Electron main.
      const journalCurrentOnDisk =
        state.journal.length === 0 || lastWrittenJournalVersion === journalVersion
      const run: PersistedWorkflowRun = {
        ...state,
        phases: [...state.phases],
        agents: state.agents.map((record) => ({ ...record })),
        worktrees: state.worktrees?.map((record) => ({ ...record })),
        logs: [...state.logs],
        journal: journalCurrentOnDisk ? [] : state.journal.slice(),
        stats: { ...state.stats }
      }
      return {
        run,
        journalSource: journalCurrentOnDisk ? "sidecar" : "memory",
        reservedBytes:
          WORKFLOW_FLUSH_FAILURE_METADATA_RESERVATION_BYTES +
          (journalCurrentOnDisk ? 0 : WORKFLOW_FLUSH_FAILURE_JOURNAL_RESERVATION_BYTES)
      }
    },
    whenInitialPersisted,
    isCurrentSnapshotPersisted() {
      const persisted = loadWorkflowRun(workspacePath, threadId, state.runId)
      return (
        persisted?.threadId === threadId &&
        persisted.startedAt === state.startedAt &&
        persisted.scriptSha256 === state.scriptSha256
      )
    },
    async isCurrentSnapshotPersistedAsync() {
      const persisted = await loadWorkflowRunAsync(workspacePath, threadId, state.runId)
      return (
        persisted?.threadId === threadId &&
        persisted.startedAt === state.startedAt &&
        persisted.scriptSha256 === state.scriptSha256
      )
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
