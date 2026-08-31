import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "fs/promises"
import { statSync } from "fs"
import path from "path"
import {
  coordinatorFileMatchKey,
  isCoordinatorPathWithin,
  resolveCoordinatorPath
} from "./coordinator-worker-paths"
import {
  CoordinatorWorkerRestoreIndexStore,
  type CoordinatorWorkerRestoreDirectoryIncarnation
} from "./coordinator-worker-restore-index"
import { BoundedWorkerAdmission } from "../services/bounded-worker-admission"
import type { CoordinatorSelectedSkill } from "./coordinator-mode"
import { emitAppAttention } from "../app-attention-events"
import { getWorkflowRunWallClockMs } from "./workflow/types"

export type CoordinatorWorkerRole = "implementer" | "verifier"
export type CoordinatorWorkerStatus = "running" | "completed" | "failed" | "cancelled"
export type CoordinatorWorkerWorkload = "read_only" | "verify" | "write"
export type CoordinatorWorkerContinuationIntent =
  | "follow_up_after_notification"
  | "redirect_running_worker"

export interface CoordinatorWorkerTokenUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
}

export interface CoordinatorWorkerProgressEvent {
  type: "tool_call" | "activity" | "usage" | "stream"
  toolName?: string
  message?: string
  usage?: CoordinatorWorkerTokenUsage
  stream?: {
    mode: "messages" | "values"
    data: unknown
  }
}

export interface CoordinatorWorkerUpdateEvent {
  worker: CoordinatorWorkerSnapshot
  notification?: string
  suppressNotificationAutoRun?: boolean
  stream?: {
    mode: "messages" | "values"
    data: unknown
  }
}

export type CoordinatorWorkerUpdateCallback = (event: CoordinatorWorkerUpdateEvent) => void

export interface CoordinatorWorkerRunInput {
  parentThreadId: string
  workerId: string
  workerThreadId: string
  workerTurn: number
  role: CoordinatorWorkerRole
  workload: CoordinatorWorkerWorkload
  // Compatibility path for pre-V2 scoped writer records and direct manager callers.
  // Coordinator tools no longer expose owned_files to the model.
  ownedFiles: string[]
  description: string
  prompt: string
  workspacePath: string
  abortSignal: AbortSignal
  onProgress: (event: CoordinatorWorkerProgressEvent) => void
}

export interface CoordinatorWorkerRunResult {
  summary: string
  rawText?: string
  reportPath?: string
  transcriptText?: string
  tokenUsage?: CoordinatorWorkerTokenUsage
}

export type CoordinatorWorkerRunner = (
  input: CoordinatorWorkerRunInput
) => Promise<CoordinatorWorkerRunResult>

export interface CoordinatorWorkerSnapshot {
  worker_id: string
  worker_thread_id: string
  parent_thread_id: string
  role: CoordinatorWorkerRole
  workload: CoordinatorWorkerWorkload
  base_workload?: CoordinatorWorkerWorkload
  // Persisted for old worker state compatibility; stripped from coordinator-facing tool results.
  owned_files: string[]
  description: string
  status: CoordinatorWorkerStatus
  turns: number
  created_at: string
  updated_at: string
  last_started_at?: string
  last_activity_at?: string
  finished_at?: string
  summary?: string
  error?: string
  report_path?: string
  result_path?: string
  transcript_path?: string
  token_usage?: CoordinatorWorkerTokenUsage
  tool_call_count: number
  last_tool_name?: string
  duration_ms?: number
  last_event: string
  notification_acknowledged?: boolean
  suppress_notification_auto_run?: boolean
  selected_skill?: CoordinatorSelectedSkill
  notification_raw_text?: string
  notification_message?: string
}

export interface CoordinatorWorkerResultRead {
  worker: CoordinatorWorkerSnapshot
  result_path?: string
  result_text?: string
  result_chars?: number
  result_truncated?: boolean
  message?: string
}

interface CoordinatorWorkerRecord {
  workerId: string
  workerThreadId: string
  parentThreadId: string
  workspacePath: string
  restoreDirectoryIncarnation: CoordinatorWorkerRestoreDirectoryIncarnation
  role: CoordinatorWorkerRole
  workload: CoordinatorWorkerWorkload
  baseWorkload: CoordinatorWorkerWorkload
  // Internal compatibility guard for restored scoped writers. New coordinator prompts treat
  // write workers as whole-workspace implementers and do not ask the model for owned_files.
  ownedFiles: string[]
  description: string
  status: CoordinatorWorkerStatus
  turns: number
  createdAt: string
  updatedAt: string
  lastStartedAt?: string
  lastActivityAt?: string
  finishedAt?: string
  summary?: string
  error?: string
  reportPath?: string
  resultPath?: string
  transcriptPath?: string
  rawText?: string
  transcriptText?: string
  tokenUsage?: CoordinatorWorkerTokenUsage
  toolCallCount: number
  lastToolName?: string
  lastEvent: string
  abortController?: AbortController
  currentRun?: Promise<void>
  statePersistPromise?: Promise<void>
  terminalPersistPromise?: Promise<void>
  notificationEnqueuePromise?: Promise<string | undefined>
  onUpdateCallbacks?: Map<string, CoordinatorWorkerUpdateCallback>
  notificationEnqueued?: boolean
  notificationAcknowledged?: boolean
  discarded?: boolean
  selectedSkill?: CoordinatorSelectedSkill
  previousTokenUsage?: CoordinatorWorkerTokenUsage
  currentRunTokenUsage?: CoordinatorWorkerTokenUsage
  progressUpdateTimer?: ReturnType<typeof setTimeout>
  lastProgressUpdateAt?: number
  runVersion: number
  suppressNotificationAutoRun?: boolean
  dismissNotificationOnTerminalPersist?: boolean
  notificationMessage?: string
}

interface NotificationRef {
  workerId: string
  turn?: number
}

interface WorkerRestoreOptions {
  cache?: boolean
  preserveWorkerId?: string
}

interface TerminalPersistFailureMetadata {
  persistedResultPath?: string
}

interface CoordinatorWorkerManagerOptions {
  onTerminalNotification?: (worker: CoordinatorWorkerSnapshot) => void
  restoreIndexStore?: CoordinatorWorkerRestoreIndexStore
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const cleanup = (): void => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }
    const onAbort = (): void => cleanup()
    const timeout = setTimeout(cleanup, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

async function settleInBatches<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<unknown>
): Promise<void> {
  const batchSize = Math.max(1, concurrency)
  for (let index = 0; index < items.length; index += batchSize) {
    await Promise.allSettled(items.slice(index, index + batchSize).map((item) => fn(item)))
  }
}

function withPersistedResultPath(error: unknown, resultPath: string): unknown {
  if (!resultPath) return error
  if (error && typeof error === "object") {
    ;(error as TerminalPersistFailureMetadata).persistedResultPath = resultPath
    return error
  }
  return Object.assign(new Error(describeError(error)), {
    persistedResultPath: resultPath
  } satisfies TerminalPersistFailureMetadata)
}

function persistedResultPathFromError(error: unknown): string | undefined {
  return typeof error === "object" && error
    ? (error as TerminalPersistFailureMetadata).persistedResultPath
    : undefined
}

interface StartWorkerOptions {
  parentThreadId: string
  workspacePath: string
  role: CoordinatorWorkerRole
  workload?: CoordinatorWorkerWorkload
  ownedFiles?: string[]
  description: string
  prompt: string
  selectedSkill?: CoordinatorSelectedSkill
  runner: CoordinatorWorkerRunner
  parentSignal?: AbortSignal
  onUpdate?: CoordinatorWorkerUpdateCallback
  onUpdateKey?: string
}

interface ContinueWorkerOptions {
  parentThreadId: string
  workerId: string
  prompt: string
  continuationIntent?: CoordinatorWorkerContinuationIntent
  workload?: CoordinatorWorkerWorkload
  ownedFiles?: string[]
  selectedSkill?: CoordinatorSelectedSkill
  runner: CoordinatorWorkerRunner
  parentSignal?: AbortSignal
  onUpdate?: CoordinatorWorkerUpdateCallback
  onUpdateKey?: string
}

interface WaitWorkersOptions {
  workerId?: string
  block?: boolean
  timeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
  waitForCleanup?: boolean
}

interface RestoreWorkersOptions {
  parentThreadId: string
  workspacePath: string
  onUpdate?: CoordinatorWorkerUpdateCallback
  onUpdateKey?: string
  mode?: "full" | "active" | "recent"
  signal?: AbortSignal
}

function throwIfRestoreAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException("Coordinator worker restore was superseded.", "AbortError")
}

const COORDINATOR_BASE_DIR = ".cmbdevclaw/coordinator"
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const WORKER_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const WORKER_THREAD_DELIMITER = "__worker__"
const DEFAULT_WAIT_TIMEOUT_MS = 30_000
const DEFAULT_WAIT_POLL_MS = 1_000
const MAX_NOTIFICATION_SUMMARY_CHARS = 500
const MAX_NOTIFICATION_RESULT_CHARS = 32_000
const MAX_NOTIFICATION_XML_CHARS = 120_000
const DEFAULT_RESULT_READ_CHARS = 20_000
const MAX_RESULT_READ_CHARS = 80_000
const MAX_WORKER_RAW_TEXT_CHARS = 200_000
const WORKER_RESULT_PERSISTENCE_FAILED_PREFIX = "Worker result persistence failed:"
const PERSISTED_NOTIFICATION_TOP_LEVEL_TAGS = new Set([
  "task-id",
  "worker-thread-id",
  "worker-role",
  "turn",
  "status",
  "summary",
  "result",
  "result-truncated",
  "report-path",
  "output-file",
  "result-path",
  "usage"
])
export const MAX_COORDINATOR_WORKERS_IN_MEMORY = 80
export const MAX_COORDINATOR_PRUNED_SNAPSHOTS_IN_MEMORY = 16
export const MAX_COORDINATOR_UNRESOLVED_WORKERS = 40
export const MAX_COORDINATOR_IDLE_PARENTS_IN_MEMORY = 24
export const MAX_COORDINATOR_ACTIVE_RESTORES = 4
export const MAX_COORDINATOR_RESTORE_WAITERS = 60
export const MAX_COORDINATOR_RESTORES_PER_PARENT = 8
// Stream-only workers can emit frequent text/value chunks without new tool calls.
// A 2s throttle keeps the right-panel activity timestamp reasonably fresh
// while reducing steady-state state.json writes for long-running workers.
const PROGRESS_UPDATE_THROTTLE_MS = 2_000
const RESTORE_STATE_FILE_MAX_BYTES = 2 * 1024 * 1024
const RESTORE_STATE_TOTAL_MAX_BYTES = 4 * 1024 * 1024
const RESTORED_RAW_TEXT_HYDRATE_CONCURRENCY = 4
const DEFAULT_WORKER_UPDATE_CALLBACK_KEY = "default"
const TERMINAL_STATUSES = new Set<CoordinatorWorkerStatus>(["completed", "failed", "cancelled"])

// Inactivity watchdog: a worker whose model call stalls mid-stream has NO other
// exit — the fetch per-attempt timeout covers only up to the first byte
// (runtime.ts createRetryingFetch), and a stalled run never reaches its
// finally/persistTerminalAndNotify, so the record stays "running" forever and
// everything waiting on worker terminality (the coordinator notification turn,
// the goal defer guard, the busy guards) waits forever with it. The watchdog
// mirrors the workflow engine's inactivity backstop: sweep running workers on a
// coarse tick and cancel any with no recorded activity inside the window.
const WORKER_WATCHDOG_TICK_MS = 60_000

/** Inactivity window for the worker watchdog. Own env knob first; otherwise
 * follows the workflow run window (CMB_WORKFLOW_RUN_TIMEOUT_MS, default 2h) so
 * the two background-work subsystems share one timeout policy by default.
 *
 * FOOT-GUN: unlike the workflow window (which floors itself above the per-subagent
 * timeout so a slow-but-alive agent can't be reaped mid-flight), this knob honors
 * any value >= 60s as-is. A worker doing a genuinely long, event-quiet operation
 * (e.g. a multi-minute build/test with no interim tool output) writes no progress
 * event, so lastActivityAt stays put; set the window near that op's duration and a
 * HEALTHY worker can be cancelled. The 2h default is safe; only override it low if
 * you know your workers emit activity within the chosen window. */
export function getCoordinatorWorkerInactivityMs(): number {
  const raw = process.env.CMB_COORDINATOR_WORKER_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  if (Number.isFinite(parsed) && parsed >= 60_000) return parsed
  return getWorkflowRunWallClockMs()
}

/** Pure decision for the goal-defer "terminal-but-not-yet-enqueued" gap,
 * exported for unit tests. True when a worker has produced its terminal result
 * (terminalPersistPromise is in flight) but its notification has NOT been
 * published yet — the span while persistTerminalAndNotify and enqueueNotification
 * durably write the terminal/notification state and secondary index. Only after
 * those writes settle does enqueueNotification set notificationEnqueued, so a
 * notification visible to a delivery turn returns false → no self-defer/deadlock.
 * suppress/dismiss workers are excluded — their results are not auto-delivered,
 * so the goal must not defer forever waiting for them. */
export function isWorkerAwaitingTerminalNotification(worker: {
  terminalPersistPromise?: unknown
  notificationEnqueued?: boolean
  suppressNotificationAutoRun?: boolean
  dismissNotificationOnTerminalPersist?: boolean
  discarded?: boolean
}): boolean {
  if (worker.discarded === true) return false
  return (
    worker.terminalPersistPromise !== undefined &&
    worker.notificationEnqueued !== true &&
    worker.suppressNotificationAutoRun !== true &&
    worker.dismissNotificationOnTerminalPersist !== true
  )
}

/** Pure watchdog decision, exported for unit tests. True only for a RUNNING
 * worker whose FRESHEST parseable timestamp is older than the window. Takes the
 * MAX over all parseable stamps (lastActivityAt / lastStartedAt / updatedAt /
 * createdAt), NOT the first present one: a corrupt or stale lastActivityAt must
 * not mask a fresh updatedAt and get a still-active worker killed. A genuinely
 * hung worker has every stamp stale, so max is still stale → terminated. Only
 * when EVERY stamp is missing or unparseable do we decline to terminate (never
 * kill on data we cannot read at all). */
export function isWorkerInactiveForWatchdog(
  worker: {
    status: CoordinatorWorkerStatus
    lastActivityAt?: string
    lastStartedAt?: string
    updatedAt: string
    createdAt: string
  },
  nowMs: number,
  windowMs: number
): boolean {
  if (worker.status !== "running") return false
  let freshestMs = Number.NEGATIVE_INFINITY
  for (const stamp of [
    worker.lastActivityAt,
    worker.lastStartedAt,
    worker.updatedAt,
    worker.createdAt
  ]) {
    if (stamp === undefined) continue
    const parsedMs = Date.parse(stamp)
    if (Number.isFinite(parsedMs)) freshestMs = Math.max(freshestMs, parsedMs)
  }
  if (!Number.isFinite(freshestMs)) return false
  return nowMs - freshestMs > windowMs
}

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeThreadId(threadId: string): string {
  const normalized = threadId.trim()
  if (!THREAD_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid coordinator worker parent threadId: ${threadId}`)
  }
  if (normalized.includes(WORKER_THREAD_DELIMITER)) {
    throw new Error(
      `Invalid coordinator worker parent threadId: ${threadId}. Thread ids may not contain the reserved ${WORKER_THREAD_DELIMITER} delimiter.`
    )
  }
  return normalized
}

function normalizeWorkerId(workerId: string): string {
  const normalized = workerId.trim()
  if (!WORKER_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid coordinator worker id: ${workerId}`)
  }
  return normalized
}

function normalizeWorkerRole(role: CoordinatorWorkerRole): CoordinatorWorkerRole {
  if (role !== "implementer" && role !== "verifier") {
    throw new Error(`Invalid coordinator worker role: ${String(role)}`)
  }
  return role
}

function normalizeWorkerWorkload(
  role: CoordinatorWorkerRole,
  workload?: CoordinatorWorkerWorkload
): CoordinatorWorkerWorkload {
  if (role !== "verifier" && workload === "verify") {
    throw new Error(
      'Only verifier workers can use workload="verify". Spawn a fresh verifier instead of turning an implementer into a self-verifying worker.'
    )
  }
  if (role === "verifier" && workload === "write") {
    throw new Error(
      'Verifier workers cannot use workload="write"; use workload="verify" or "read_only".'
    )
  }
  if (workload === "read_only" || workload === "verify" || workload === "write") return workload
  return role === "verifier" ? "verify" : "write"
}

function normalizeOwnedFiles(files?: string[], workspacePath?: string): string[] {
  if (!Array.isArray(files)) return []
  const workspaceRoot = path.resolve(workspacePath ?? process.cwd())
  const normalized: string[] = []
  const invalid: string[] = []
  for (const rawFile of files) {
    const slashNormalizedFile = rawFile.trim().replace(/\\/g, "/")
    if (!slashNormalizedFile) continue
    if (
      slashNormalizedFile.startsWith("/") ||
      path.win32.isAbsolute(rawFile.trim()) ||
      /^[A-Za-z]:\//.test(slashNormalizedFile) ||
      slashNormalizedFile.split("/").includes("..")
    ) {
      invalid.push(rawFile)
      continue
    }
    const explicitDirectory = /\/+$/.test(slashNormalizedFile)
    const normalizedFile = path.posix.normalize(slashNormalizedFile).replace(/^\.\/+/, "")
    const canonicalFile = normalizedFile.replace(/\/+$/, "")
    if (
      !canonicalFile ||
      canonicalFile === "." ||
      canonicalFile.startsWith("/") ||
      canonicalFile.split("/").includes("..")
    ) {
      invalid.push(rawFile)
      continue
    }
    const resolvedOwnedFile = path.resolve(workspaceRoot, canonicalFile)
    if (!isCoordinatorPathWithin(resolvedOwnedFile, workspaceRoot)) {
      invalid.push(rawFile)
      continue
    }

    let normalizedOwnedFile = canonicalFile
    try {
      if (statSync(resolveCoordinatorPath(resolvedOwnedFile)).isDirectory()) {
        normalizedOwnedFile = `${canonicalFile}/`
      }
    } catch {
      if (explicitDirectory) {
        normalizedOwnedFile = `${canonicalFile}/`
      }
    }

    normalized.push(normalizedOwnedFile)
  }
  if (invalid.length > 0) {
    throw new Error(
      `Invalid owned_files path${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}. Use workspace-relative paths without absolute paths or '..'.`
    )
  }
  const deduped = new Map<string, string>()
  for (const file of normalized) {
    const key = coordinatorFileMatchKey(resolveCoordinatorPath(path.resolve(workspaceRoot, file)))
    if (!deduped.has(key)) deduped.set(key, file)
  }
  return Array.from(deduped.values()).sort()
}

function normalizeNonEmpty(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`${label} must not be empty.`)
  }
  return normalized
}

function describeError(error: unknown): string {
  if (error == null) return ""
  if (error instanceof Error) return error.message || error.name
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

function isAbortLike(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.toLowerCase().includes("abort"))
  )
}

function abortReason(signal: AbortSignal): string {
  return describeError(signal.reason) || "Worker aborted."
}

function workerStatePath(record: CoordinatorWorkerRecord): string {
  const root = workerStateDirectory(
    record.workspacePath,
    record.parentThreadId
  )
  return path.resolve(root, `${normalizeWorkerId(record.workerId)}.json`)
}

function workerStateDirectory(workspacePath: string, parentThreadId: string): string {
  return path.resolve(
    workspacePath,
    COORDINATOR_BASE_DIR,
    normalizeThreadId(parentThreadId),
    "workers"
  )
}

function coordinatorScratchpadPath(workspacePath: string, parentThreadId: string): string {
  return path.resolve(
    workspacePath,
    COORDINATOR_BASE_DIR,
    normalizeThreadId(parentThreadId),
    "scratchpad"
  )
}

function workerScratchpadPath(record: CoordinatorWorkerRecord): string {
  return coordinatorScratchpadPath(record.workspacePath, record.parentThreadId)
}

function workerResultPath(record: CoordinatorWorkerRecord): string {
  const root = path.resolve(
    record.workspacePath,
    COORDINATOR_BASE_DIR,
    normalizeThreadId(record.parentThreadId),
    "reports",
    "workers",
    normalizeWorkerId(record.workerId)
  )
  return path.resolve(root, `turn-${Math.max(1, record.turns)}.json`)
}

function relativeWorkerResultPath(record: CoordinatorWorkerRecord): string {
  return `${COORDINATOR_BASE_DIR}/${normalizeThreadId(record.parentThreadId)}/reports/workers/${normalizeWorkerId(record.workerId)}/turn-${Math.max(1, record.turns)}.json`
}

function normalizeWorkerArtifactPath(value: unknown, parentThreadId: string): string | undefined {
  const rawPath = optionalString(value)
  if (!rawPath) return undefined

  const slashNormalized = rawPath.trim().replace(/\\/g, "/")
  if (
    !slashNormalized ||
    slashNormalized.startsWith("/") ||
    path.win32.isAbsolute(rawPath.trim()) ||
    /^[A-Za-z]:\//.test(slashNormalized)
  ) {
    return undefined
  }

  const normalizedPath = path.posix.normalize(slashNormalized).replace(/^\.\/+/, "")
  if (
    !normalizedPath ||
    normalizedPath === "." ||
    normalizedPath.startsWith("../") ||
    normalizedPath.includes("/../")
  ) {
    return undefined
  }

  const normalizedParentThreadId = normalizeThreadId(parentThreadId)
  const coordinatorReportsPrefix = `${COORDINATOR_BASE_DIR}/${normalizedParentThreadId}/reports/`
  if (normalizedPath.startsWith(coordinatorReportsPrefix)) return normalizedPath
  if (normalizedPath.startsWith("reports/")) return normalizedPath
  return undefined
}

function resolveWorkerResultReadRelativePath(parentThreadId: string, relativePath: string): string {
  const normalizedParentThreadId = normalizeThreadId(parentThreadId)
  const slashNormalized = relativePath.trim().replace(/\\/g, "/")
  if (slashNormalized.startsWith(".cmbdevclaw/")) return slashNormalized
  // Historical/sanitized result_path values may still use bare reports/... paths.
  // Keep read semantics aligned with the renderer preview path resolver by
  // treating those as coordinator report artifacts scoped to this thread.
  if (slashNormalized.startsWith("reports/") || slashNormalized === "state.json") {
    return `${COORDINATOR_BASE_DIR}/${normalizedParentThreadId}/${slashNormalized}`
  }
  return slashNormalized
}

async function writeFileAtomic(
  target: string,
  content: string,
  assertCurrent: () => void = () => undefined
): Promise<void> {
  assertCurrent()
  await mkdir(path.dirname(target), { recursive: true })
  assertCurrent()
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`
  )
  try {
    await writeFile(temp, content, "utf8")
    assertCurrent()
    await rename(temp, target)
    assertCurrent()
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function removeCoordinatorWorkerArtifacts(
  parentThreadId: string,
  workspacePath: string
): Promise<void> {
  const normalizedThreadId = normalizeThreadId(parentThreadId)
  const root = path.resolve(normalizeNonEmpty(workspacePath, "Coordinator worker workspacePath"))
  const coordinatorRoot = path.resolve(root, COORDINATOR_BASE_DIR)
  const target = path.resolve(coordinatorRoot, normalizedThreadId)
  if (target !== coordinatorRoot && target.startsWith(`${coordinatorRoot}${path.sep}`)) {
    await rm(target, { recursive: true, force: true })
  }
}

function durationMs(record: CoordinatorWorkerRecord): number | undefined {
  const startedAt = Date.parse(record.lastStartedAt ?? record.createdAt)
  if (!Number.isFinite(startedAt)) return undefined
  const endedAt = record.finishedAt ? Date.parse(record.finishedAt) : Date.now()
  if (!Number.isFinite(endedAt)) return undefined
  return Math.max(0, endedAt - startedAt)
}

function safeTimestamp(value: string | undefined): number {
  if (!value) return 0
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

function stripInvalidXmlControlChars(value: string): string {
  let result = ""
  for (const char of value) {
    const code = char.charCodeAt(0)
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
      continue
    }
    result += char
  }
  return result
}

function escapeXml(value: string): string {
  return stripInvalidXmlControlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function truncateNotificationSummary(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= MAX_NOTIFICATION_SUMMARY_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_NOTIFICATION_SUMMARY_CHARS)}\n...(truncated; continue the worker for a concise handoff if more detail is needed)`
}

function compactNotificationDescription(value: string, maxChars = 160): string {
  const compacted = value.replace(/\s+/g, " ").trim()
  if (compacted.length <= maxChars) return compacted
  return `${compacted.slice(0, maxChars)}...`
}

function formatWorkerResultPersistenceFailure(message: string): string {
  return `${WORKER_RESULT_PERSISTENCE_FAILED_PREFIX} ${message}`
}

function isWorkerResultPersistenceFailureEvent(value: string | undefined): boolean {
  return value?.startsWith(WORKER_RESULT_PERSISTENCE_FAILED_PREFIX) ?? false
}

function pickNonEmptyNotificationDetail(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value
  }
  return ""
}

function buildNotificationDetailedSummary(snapshot: CoordinatorWorkerSnapshot): string {
  return pickNonEmptyNotificationDetail(
    snapshot.summary,
    snapshot.error,
    snapshot.status === "completed"
      ? "Worker completed."
      : snapshot.status === "cancelled"
        ? "Worker was stopped."
        : snapshot.last_event,
    snapshot.last_event
  )
}

function buildNotificationResultContext(
  snapshot: CoordinatorWorkerSnapshot,
  hasRawText: boolean
): string {
  if (!hasRawText) return buildNotificationDetailedSummary(snapshot)
  return pickNonEmptyNotificationDetail(
    snapshot.summary,
    snapshot.error,
    snapshot.status === "completed" ? undefined : snapshot.last_event
  )
}

function prioritizePersistenceFailureDetail(detail: string, persistenceFailure: string): string {
  const trimmedDetail = detail.trim()
  const trimmedFailure = persistenceFailure.trim()
  if (!trimmedFailure) return trimmedDetail
  if (!trimmedDetail) return trimmedFailure
  if (trimmedDetail.startsWith(trimmedFailure)) return trimmedDetail
  const remainder = trimmedDetail.replace(trimmedFailure, "").trim()
  return remainder ? `${trimmedFailure}\n\n${remainder}` : trimmedFailure
}

function buildNotificationSummary(
  snapshot: CoordinatorWorkerSnapshot,
  status: "completed" | "failed" | "killed",
  detailedSummary: string
): string {
  const description = compactNotificationDescription(snapshot.description) || snapshot.worker_id
  if (status === "failed") {
    const detail = (() => {
      const baseDetail = pickNonEmptyNotificationDetail(snapshot.error, detailedSummary)
      if (!isWorkerResultPersistenceFailureEvent(snapshot.last_event)) return baseDetail.trim()
      return prioritizePersistenceFailureDetail(baseDetail, snapshot.last_event)
    })()
    return detail ? `Worker "${description}" failed: ${detail}` : `Worker "${description}" failed.`
  }
  if (status === "killed") {
    return `Worker "${description}" was stopped.`
  }
  return `Worker "${description}" completed.`
}

function normalizeNotificationStatus(
  status: CoordinatorWorkerSnapshot["status"]
): "completed" | "failed" | "killed" {
  switch (status) {
    case "completed":
      return "completed"
    case "failed":
      return "failed"
    case "cancelled":
      return "killed"
    case "running":
      // Notification formatting is only expected for terminal workers.
      // Fallback to failed semantics so unexpected states never read as completed.
      return "failed"
  }
}

type NotificationResultSource = {
  text: string
  truncated?: boolean
}

function prependContextToRawText(
  context: string,
  rawText: string,
  truncated = false
): NotificationResultSource {
  const trimmedContext = context.trim()
  const trimmedRawText = rawText.trim()
  if (!trimmedContext) return { text: trimmedRawText, truncated }
  if (!trimmedRawText) return { text: trimmedContext, truncated }
  const combined = `${trimmedContext}\n\n${trimmedRawText}`
  if (combined.length <= MAX_NOTIFICATION_RESULT_CHARS) {
    return { text: combined, truncated }
  }
  if (trimmedContext.length >= MAX_NOTIFICATION_RESULT_CHARS) {
    return {
      text: trimmedContext.slice(0, MAX_NOTIFICATION_RESULT_CHARS).trimEnd(),
      truncated: true
    }
  }
  const rawBudget = Math.max(0, MAX_NOTIFICATION_RESULT_CHARS - trimmedContext.length - 2)
  if (rawBudget === 0) return { text: trimmedContext, truncated: true }
  return {
    text: `${trimmedContext}\n\n${trimmedRawText.slice(-rawBudget)}`,
    truncated: true
  }
}

function buildTerminalPersistenceFailureResultSource(
  detailedSummary: string,
  rawText?: string
): NotificationResultSource {
  const trimmedSummary = detailedSummary.trim()
  const trimmedRawText = rawText?.trim() ?? ""
  const summaryTruncationMarker = "\n...(summary truncated)"
  if (!trimmedSummary) return { text: trimmedRawText }
  if (!trimmedRawText) {
    if (trimmedSummary.length <= MAX_NOTIFICATION_RESULT_CHARS) return { text: trimmedSummary }
    const failureIndex = trimmedSummary.lastIndexOf(WORKER_RESULT_PERSISTENCE_FAILED_PREFIX)
    const failureSuffix = failureIndex >= 0 ? trimmedSummary.slice(failureIndex).trim() : ""
    if (!failureSuffix) return { text: trimmedSummary }
    if (failureSuffix.length >= MAX_NOTIFICATION_RESULT_CHARS) {
      return {
        text: `${failureSuffix.slice(0, MAX_NOTIFICATION_RESULT_CHARS).trimEnd()}\n...(summary truncated)`,
        truncated: true
      }
    }
    const headBudget = Math.max(0, MAX_NOTIFICATION_RESULT_CHARS - failureSuffix.length - 2)
    const summaryPrefix = trimmedSummary.slice(0, headBudget).trimEnd()
    return {
      text: summaryPrefix ? `${summaryPrefix}\n\n${failureSuffix}` : failureSuffix,
      truncated: true
    }
  }
  const failureIndex = trimmedSummary.lastIndexOf(WORKER_RESULT_PERSISTENCE_FAILED_PREFIX)
  const failureSuffix = failureIndex >= 0 ? trimmedSummary.slice(failureIndex).trim() : ""
  const summaryPrefix = failureIndex >= 0 ? trimmedSummary.slice(0, failureIndex).trimEnd() : ""
  const contextBudget = MAX_NOTIFICATION_RESULT_CHARS - trimmedRawText.length - 2
  if (
    failureSuffix &&
    summaryPrefix &&
    rawTextContainsNotificationSummary(summaryPrefix, trimmedRawText)
  ) {
    if (failureSuffix.length <= contextBudget) {
      return { text: `${failureSuffix}\n\n${trimmedRawText}` }
    }
    if (contextBudget <= summaryTruncationMarker.length) {
      return prependContextToRawText(failureSuffix, trimmedRawText, true)
    }
    const sliceBudget = Math.max(0, contextBudget - summaryTruncationMarker.length)
    const boundedFailure = `${failureSuffix.slice(0, sliceBudget).trimEnd()}${summaryTruncationMarker}`
    return prependContextToRawText(boundedFailure, trimmedRawText, true)
  }
  if (trimmedRawText && rawTextContainsNotificationSummary(trimmedSummary, trimmedRawText)) {
    return { text: trimmedRawText }
  }
  if (trimmedSummary.length <= contextBudget) {
    return { text: trimmedRawText ? `${trimmedSummary}\n\n${trimmedRawText}` : trimmedSummary }
  }
  if (contextBudget <= 0) {
    if (failureSuffix) {
      return prependContextToRawText(failureSuffix, trimmedRawText, true)
    }
    return { text: trimmedRawText, truncated: true }
  }
  if (!failureSuffix) {
    if (contextBudget <= summaryTruncationMarker.length)
      return { text: trimmedRawText, truncated: true }
    const sliceBudget = Math.max(0, contextBudget - summaryTruncationMarker.length)
    const boundedSummary = `${trimmedSummary.slice(0, sliceBudget).trimEnd()}${summaryTruncationMarker}`
    return {
      text: trimmedRawText ? `${boundedSummary}\n\n${trimmedRawText}` : boundedSummary,
      truncated: true
    }
  }
  if (failureSuffix.length >= contextBudget) {
    if (contextBudget <= summaryTruncationMarker.length) {
      return prependContextToRawText(failureSuffix, trimmedRawText, true)
    }
    const sliceBudget = Math.max(0, contextBudget - summaryTruncationMarker.length)
    const boundedFailure = `${failureSuffix.slice(0, sliceBudget).trimEnd()}${summaryTruncationMarker}`
    return prependContextToRawText(boundedFailure, trimmedRawText, true)
  }
  const headBudget = Math.max(0, contextBudget - failureSuffix.length - 2)
  const boundedSummaryPrefix = trimmedSummary.slice(0, headBudget).trimEnd()
  const boundedSummary = boundedSummaryPrefix
    ? `${boundedSummaryPrefix}\n\n${failureSuffix}`
    : failureSuffix
  return {
    text: trimmedRawText ? `${boundedSummary}\n\n${trimmedRawText}` : boundedSummary,
    truncated: true
  }
}

function rawTextContainsNotificationSummary(summary: string, rawText: string): boolean {
  const trimmedSummary = summary.trim()
  const trimmedRawText = rawText.trim()
  if (!trimmedSummary || !trimmedRawText) return false
  if (trimmedRawText === trimmedSummary) return true
  const truncatedMarker = "\n...(truncated)"
  if (trimmedSummary.endsWith(truncatedMarker)) {
    const summaryPrefix = trimmedSummary.slice(0, -truncatedMarker.length).trimEnd()
    return Boolean(summaryPrefix) && trimmedRawText.startsWith(summaryPrefix)
  }
  if (!trimmedRawText.startsWith(trimmedSummary)) return false
  const nextChar = trimmedRawText.charAt(trimmedSummary.length)
  return !nextChar || /[\s\p{P}\p{S}]/u.test(nextChar)
}

function buildNotificationResultSource(
  detailedSummary: string,
  rawText: string
): NotificationResultSource {
  const trimmedSummary = detailedSummary.trim()
  const summaryTruncationMarker = "\n...(summary truncated)"
  if (!trimmedSummary || rawTextContainsNotificationSummary(trimmedSummary, rawText)) {
    return { text: rawText }
  }
  const contextBudget = MAX_NOTIFICATION_RESULT_CHARS - rawText.length - 2
  if (trimmedSummary.length <= contextBudget) {
    return { text: `${trimmedSummary}\n\n${rawText}` }
  }
  if (contextBudget <= summaryTruncationMarker.length) return { text: rawText, truncated: true }
  const sliceBudget = Math.max(0, contextBudget - summaryTruncationMarker.length)
  return {
    text: `${trimmedSummary.slice(0, sliceBudget).trimEnd()}${summaryTruncationMarker}\n\n${rawText}`,
    truncated: true
  }
}

function truncateNotificationResult(
  value: string | undefined,
  forceTruncated = false
): {
  text: string
  truncated: boolean
} {
  const trimmed = value?.trim()
  if (!trimmed) return { text: "", truncated: forceTruncated }
  if (trimmed.length <= MAX_NOTIFICATION_RESULT_CHARS) {
    return { text: trimmed, truncated: forceTruncated }
  }
  return {
    text: `${trimmed.slice(0, MAX_NOTIFICATION_RESULT_CHARS)}\n...(result truncated; coordinator should continue this worker for a concise handoff if more detail is needed; output-file is archived for UI/debug)`,
    truncated: true
  }
}

function truncateNotificationXml(
  render: (resultText: string, resultTruncated: boolean) => string,
  resultText: string,
  resultTruncated: boolean,
  fallbackXml: string,
  emergencyFallbackXml: string
): string {
  let notification = render(resultText, resultTruncated)
  if (notification.length <= MAX_NOTIFICATION_XML_CHARS) return notification

  const note =
    "\n...(notification truncated after XML escaping; continue this worker for a concise handoff if more detail is needed)"
  let nextResultText = resultText
  for (let attempt = 0; attempt < 8 && nextResultText.length > 500; attempt += 1) {
    const previousLength = nextResultText.length
    const nextLimit = Math.max(100, Math.floor((previousLength - note.length) / 2))
    nextResultText = `${nextResultText.slice(0, nextLimit)}${note}`
    notification = render(nextResultText, true)
    if (notification.length <= MAX_NOTIFICATION_XML_CHARS) return notification
    if (nextResultText.length >= previousLength) break
  }

  return fallbackXml.length <= MAX_NOTIFICATION_XML_CHARS ? fallbackXml : emergencyFallbackXml
}

function truncateWorkerRawText(value: string | undefined): string | undefined {
  if (!value) return value
  if (value.length <= MAX_WORKER_RAW_TEXT_CHARS) return value
  return `${value.slice(0, MAX_WORKER_RAW_TEXT_CHARS)}\n...(raw worker output truncated)`
}

function truncateReadText(
  value: string,
  maxChars: number
): {
  text: string
  chars: number
  truncated: boolean
} {
  if (value.length <= maxChars) {
    return { text: value, chars: value.length, truncated: false }
  }
  return {
    text: `${value.slice(0, maxChars)}\n...(truncated)`,
    chars: value.length,
    truncated: true
  }
}

function terminalStatus(status: CoordinatorWorkerStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

async function readBoundedWorkerState(
  filePath: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ raw: string; bytes: number } | undefined> {
  throwIfRestoreAborted(signal)
  const handle = await open(filePath, "r")
  try {
    throwIfRestoreAborted(signal)
    const limit = Math.max(0, Math.min(RESTORE_STATE_FILE_MAX_BYTES, maxBytes))
    if (limit === 0) return undefined
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    throwIfRestoreAborted(signal)
    if (bytesRead > limit) return undefined
    return {
      raw: buffer.subarray(0, bytesRead).toString("utf8"),
      bytes: bytesRead
    }
  } finally {
    await handle.close()
  }
}

function normalizeWorkerStatus(value: unknown): CoordinatorWorkerStatus | undefined {
  if (value === "running" || value === "completed" || value === "failed" || value === "cancelled") {
    return value
  }
  return undefined
}

function normalizeWorkload(value: unknown): CoordinatorWorkerWorkload | undefined {
  if (value === "read_only" || value === "verify" || value === "write") return value
  return undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function decodeNotificationXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

function numericValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function parseTokenUsage(value: unknown): CoordinatorWorkerTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const usage: CoordinatorWorkerTokenUsage = {}
  for (const key of [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_read_tokens",
    "cache_creation_tokens"
  ] as const) {
    const item = raw[key]
    if (typeof item === "number" && Number.isFinite(item) && item >= 0) {
      usage[key] = item
    }
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

function parseSelectedSkill(value: unknown): CoordinatorSelectedSkill | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const skillName = optionalString(raw.skillName)
  const skillPath = optionalString(raw.skillPath)
  if (!skillName || !skillPath) return undefined
  return {
    skillName,
    skillPath,
    description: optionalString(raw.description),
    whenToUse: optionalString(raw.whenToUse),
    allowedTools: optionalString(raw.allowedTools)
  }
}

function mergeTokenUsage(
  previous: CoordinatorWorkerTokenUsage | undefined,
  next: CoordinatorWorkerTokenUsage | undefined
): CoordinatorWorkerTokenUsage | undefined {
  if (!next) return previous
  const merged: CoordinatorWorkerTokenUsage = { ...(previous ?? {}) }
  for (const key of [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_read_tokens",
    "cache_creation_tokens"
  ] as const) {
    const value = next[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      merged[key] = Math.max(merged[key] ?? 0, value)
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function addTokenUsage(
  previous: CoordinatorWorkerTokenUsage | undefined,
  next: CoordinatorWorkerTokenUsage | undefined
): CoordinatorWorkerTokenUsage | undefined {
  if (!next) return previous
  const merged: CoordinatorWorkerTokenUsage = { ...(previous ?? {}) }
  for (const key of [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_read_tokens",
    "cache_creation_tokens"
  ] as const) {
    const value = next[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      merged[key] = (merged[key] ?? 0) + value
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function tokenUsageEquals(
  left: CoordinatorWorkerTokenUsage | undefined,
  right: CoordinatorWorkerTokenUsage | undefined
): boolean {
  const keys = [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_read_tokens",
    "cache_creation_tokens"
  ] as const
  return keys.every((key) => (left?.[key] ?? 0) === (right?.[key] ?? 0))
}

function ownedFilesOverlap(left: string[], right: string[], workspacePath: string): boolean {
  if (left.length === 0 || right.length === 0) return true
  const workspaceRoot = path.resolve(workspacePath)
  const normalizedLeft = left.map((file) =>
    coordinatorFileMatchKey(resolveCoordinatorPath(path.resolve(workspaceRoot, file)))
  )
  const normalizedRight = right.map((file) =>
    coordinatorFileMatchKey(resolveCoordinatorPath(path.resolve(workspaceRoot, file)))
  )
  return normalizedLeft.some((leftFile) =>
    normalizedRight.some(
      (rightFile) =>
        leftFile === rightFile ||
        leftFile.startsWith(`${rightFile}/`) ||
        rightFile.startsWith(`${leftFile}/`)
    )
  )
}

function toSnapshot(record: CoordinatorWorkerRecord): CoordinatorWorkerSnapshot {
  return {
    worker_id: record.workerId,
    worker_thread_id: record.workerThreadId,
    parent_thread_id: record.parentThreadId,
    role: record.role,
    workload: record.workload,
    base_workload: record.baseWorkload,
    owned_files: record.ownedFiles,
    description: record.description,
    status: record.status,
    turns: record.turns,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    last_started_at: record.lastStartedAt,
    last_activity_at: record.lastActivityAt,
    finished_at: record.finishedAt,
    summary: record.summary,
    error: record.error,
    report_path: record.reportPath,
    result_path: record.resultPath,
    transcript_path: record.transcriptPath,
    token_usage: record.tokenUsage,
    tool_call_count: record.toolCallCount,
    last_tool_name: record.lastToolName,
    duration_ms: durationMs(record),
    last_event: record.lastEvent,
    notification_acknowledged: record.notificationAcknowledged,
    suppress_notification_auto_run: record.suppressNotificationAutoRun,
    selected_skill: record.selectedSkill
  }
}

function toPersistedWorkerState(record: CoordinatorWorkerRecord): CoordinatorWorkerSnapshot {
  const snapshot = toSnapshot(record)
  const { status, notification_acknowledged: notificationAcknowledged, ...rest } = snapshot
  const notificationRawText =
    terminalStatus(record.status) && notificationAcknowledged === false
      ? truncateWorkerRawText(record.rawText)
      : undefined
  const notificationMessage =
    terminalStatus(record.status) && notificationAcknowledged === false
      ? record.notificationMessage
      : undefined

  // Active restore only needs these two fields to skip acknowledged terminal history.
  // Keep them at the front so long descriptions or owned_files never force a full JSON parse.
  return {
    status,
    notification_acknowledged: notificationAcknowledged,
    ...rest,
    notification_raw_text: notificationRawText,
    notification_message: notificationMessage
  }
}

function truncateUtf8Bytes(value: string | undefined, maxBytes: number): string | undefined {
  if (!value) return value
  const encoded = Buffer.from(value, "utf8")
  if (encoded.byteLength <= maxBytes) return value
  return `${encoded.subarray(0, maxBytes).toString("utf8")}\n...(truncated)`
}

function serializePersistedWorkerState(snapshot: CoordinatorWorkerSnapshot): string {
  let serialized = JSON.stringify(snapshot, null, 2)
  if (Buffer.byteLength(serialized, "utf8") <= RESTORE_STATE_FILE_MAX_BYTES) return serialized

  const selectedSkill = snapshot.selected_skill
    ? {
        skillName: truncateUtf8Bytes(snapshot.selected_skill.skillName, 4 * 1024) ?? "",
        skillPath: truncateUtf8Bytes(snapshot.selected_skill.skillPath, 16 * 1024) ?? "",
        description: truncateUtf8Bytes(snapshot.selected_skill.description, 16 * 1024),
        whenToUse: truncateUtf8Bytes(snapshot.selected_skill.whenToUse, 16 * 1024),
        allowedTools: truncateUtf8Bytes(snapshot.selected_skill.allowedTools, 16 * 1024)
      }
    : undefined
  const compact: CoordinatorWorkerSnapshot = {
    ...snapshot,
    owned_files: snapshot.owned_files.slice(0, 256),
    description: truncateUtf8Bytes(snapshot.description, 32 * 1024) ?? snapshot.worker_id,
    summary: truncateUtf8Bytes(snapshot.summary, 128 * 1024),
    error: truncateUtf8Bytes(snapshot.error, 64 * 1024),
    last_event: truncateUtf8Bytes(snapshot.last_event, 32 * 1024) ?? "Worker state compacted.",
    notification_raw_text: truncateUtf8Bytes(snapshot.notification_raw_text, 512 * 1024),
    notification_message: undefined,
    selected_skill: selectedSkill
  }
  serialized = JSON.stringify(compact, null, 2)
  if (Buffer.byteLength(serialized, "utf8") <= RESTORE_STATE_FILE_MAX_BYTES) return serialized

  const minimal: CoordinatorWorkerSnapshot = {
    ...compact,
    owned_files: compact.owned_files.slice(0, 64),
    description: truncateUtf8Bytes(compact.description, 8 * 1024) ?? compact.worker_id,
    summary: truncateUtf8Bytes(compact.summary, 64 * 1024),
    error: truncateUtf8Bytes(compact.error, 32 * 1024),
    last_event: truncateUtf8Bytes(compact.last_event, 8 * 1024) ?? "Worker state compacted.",
    notification_raw_text: undefined,
    selected_skill: undefined
  }
  serialized = JSON.stringify(minimal, null, 2)
  if (Buffer.byteLength(serialized, "utf8") <= RESTORE_STATE_FILE_MAX_BYTES) return serialized
  throw new Error("Coordinator worker state exceeds its hard persistence byte budget")
}

export class CoordinatorWorkerManager {
  private readonly workersByParent = new Map<string, Map<string, CoordinatorWorkerRecord>>()
  private readonly notificationsByParent = new Map<string, string[]>()
  private readonly workspacePathByParent = new Map<string, string>()
  private readonly activeRestoreHydratedWorkspaceByParent = new Map<string, string>()
  private readonly recentRestoreHydratedWorkspaceByParent = new Map<string, string>()
  private readonly restoreOverflowWorkspaceByParent = new Map<string, string>()
  private readonly restoreQueueByParent = new Map<string, Promise<void>>()
  private readonly restoreQueueDepthByParent = new Map<string, number>()
  private restoreOperationCount = 0
  private readonly restoreAdmission = new BoundedWorkerAdmission(
    MAX_COORDINATOR_ACTIVE_RESTORES,
    MAX_COORDINATOR_RESTORE_WAITERS,
    "Coordinator worker restore"
  )
  private readonly restoreGenerationByParent = new Map<string, number>()
  private readonly restoreDirectoryIncarnationByParent = new Map<
    string,
    CoordinatorWorkerRestoreDirectoryIncarnation
  >()
  private readonly parentCacheLru = new Map<string, true>()
  private readonly prunedSnapshotsByParent = new Map<
    string,
    Map<string, CoordinatorWorkerSnapshot>
  >()
  private readonly preparedScratchpadDirs = new Set<string>()
  private readonly warnedScratchpadDirs = new Set<string>()
  private readonly onTerminalNotification?: (worker: CoordinatorWorkerSnapshot) => void
  private readonly restoreIndexStore: CoordinatorWorkerRestoreIndexStore
  private sequence = 0
  private restoreEpoch = 0
  private shuttingDown = false
  private workerWatchdogTimer?: ReturnType<typeof setInterval>
  /** Injected by runtime.ts (which owns pendingApprovals; the manager must not
   * import runtime — runtime already imports this module). True when the given
   * worker runtime thread is blocked on a pending user approval. */
  private workerApprovalProbe?: (workerThreadId: string) => boolean

  constructor(options: CoordinatorWorkerManagerOptions = {}) {
    this.onTerminalNotification = options.onTerminalNotification
    this.restoreIndexStore = options.restoreIndexStore ?? new CoordinatorWorkerRestoreIndexStore()
  }

  startWorker(options: StartWorkerOptions): CoordinatorWorkerSnapshot {
    const parentThreadId = normalizeThreadId(options.parentThreadId)
    const workspacePath = normalizeNonEmpty(
      options.workspacePath,
      "Coordinator worker workspacePath"
    )
    this.workspacePathByParent.set(parentThreadId, workspacePath)
    const restoreDirectoryIncarnation = this.getOrCreateRestoreDirectoryIncarnation(
      parentThreadId,
      workspacePath
    )
    const role = normalizeWorkerRole(options.role)
    const workload = normalizeWorkerWorkload(role, options.workload)
    const ownedFiles = normalizeOwnedFiles(options.ownedFiles, workspacePath)
    const description = normalizeNonEmpty(options.description, "Coordinator worker description")
    const prompt = normalizeNonEmpty(options.prompt, "Coordinator worker prompt")
    const records = this.parentMap(parentThreadId)
    this.pruneInMemoryWorkerHistory(parentThreadId)
    this.assertCanRunWorker({
      parentThreadId,
      workspacePath: options.workspacePath,
      role,
      workload,
      ownedFiles
    })
    let workerId = this.nextWorkerId(role)
    while (records.has(workerId)) {
      workerId = this.nextWorkerId(role)
    }
    const workerThreadId = `${parentThreadId}${WORKER_THREAD_DELIMITER}${workerId}`
    const timestamp = nowIso()
    const record: CoordinatorWorkerRecord = {
      workerId,
      workerThreadId,
      parentThreadId,
      workspacePath,
      restoreDirectoryIncarnation,
      role,
      workload,
      baseWorkload: workload,
      ownedFiles,
      description,
      status: "running",
      selectedSkill: options.selectedSkill,
      turns: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastStartedAt: timestamp,
      lastActivityAt: timestamp,
      toolCallCount: 0,
      lastEvent: "Worker started.",
      runVersion: 0
    }
    this.setUpdateCallback(record, options.onUpdate, options.onUpdateKey)

    records.set(workerId, record)
    this.emitUpdate(record)
    this.launch(record, prompt, options.runner, options.parentSignal)
    return toSnapshot(record)
  }

  async startWorkerAndPersist(options: StartWorkerOptions): Promise<CoordinatorWorkerSnapshot> {
    const snapshot = this.startWorker(options)
    const record = this.getWorker(snapshot.parent_thread_id, snapshot.worker_id)
    if (record) {
      const initialRun = record.currentRun
      try {
        await record.statePersistPromise
      } catch (error) {
        await initialRun?.catch(() => undefined)
        await record.terminalPersistPromise?.catch(() => undefined)
        throw error
      }
      return toSnapshot(record)
    }
    return snapshot
  }

  async continueWorker(options: ContinueWorkerOptions): Promise<CoordinatorWorkerSnapshot> {
    const record = await this.getWorkerForOperation(options.parentThreadId, options.workerId)
    const prompt = normalizeNonEmpty(options.prompt, "Coordinator worker continuation prompt")
    if (!record) {
      throw new Error(`Unknown coordinator worker: ${options.workerId}`)
    }
    if (record.status === "cancelled") {
      throw new Error(`Worker ${record.workerId} was cancelled and cannot be continued.`)
    }
    if (
      record.status !== "running" &&
      record.terminalPersistPromise &&
      !record.notificationEnqueued
    ) {
      throw new Error(
        `Worker ${record.workerId} is still finalizing its previous result. Wait for its task-notification before continuing.`
      )
    }
    if (record.status === "running" && options.continuationIntent !== "redirect_running_worker") {
      throw new Error(
        `Worker ${record.workerId} is still running. Do not use continue_worker to check status or results; wait for its task-notification. If you need to redirect active work, call continue_worker with continuation_intent="redirect_running_worker" and a concrete replacement instruction.`
      )
    }
    const workload = normalizeWorkerWorkload(record.role, options.workload ?? record.baseWorkload)
    if (
      record.status === "running" &&
      (record.workload === "write" || record.workload === "verify") &&
      workload !== record.workload
    ) {
      throw new Error(
        `Worker ${record.workerId} is still running with ${record.workload} access. Wait for its task-notification before changing workload for a handoff continuation.`
      )
    }
    const ownedFiles =
      options.ownedFiles !== undefined
        ? normalizeOwnedFiles(options.ownedFiles, record.workspacePath)
        : record.ownedFiles
    const selectedSkill = options.selectedSkill ?? record.selectedSkill
    this.assertCanRunWorker({
      parentThreadId: record.parentThreadId,
      workspacePath: record.workspacePath,
      role: record.role,
      workload,
      ownedFiles,
      workerIdToIgnore: record.workerId
    })

    const wasRunning = record.status === "running"
    const previousRun = record.currentRun
    if (wasRunning) {
      // Invalidate the old run before aborting. The follow-up run reuses the
      // same worker thread, so we start it only after the old runner finishes
      // its sandbox cleanup to avoid killing the new run's resources.
      record.runVersion += 1
      record.abortController?.abort(
        new DOMException("Worker interrupted by continue_worker update.", "AbortError")
      )
    }

    const timestamp = nowIso()
    record.status = "running"
    record.workload = workload
    record.ownedFiles = ownedFiles
    record.selectedSkill = selectedSkill
    record.turns += 1
    record.updatedAt = timestamp
    record.lastStartedAt = timestamp
    record.lastActivityAt = timestamp
    record.finishedAt = undefined
    record.summary = undefined
    record.error = undefined
    record.reportPath = undefined
    record.resultPath = undefined
    record.transcriptPath = undefined
    record.rawText = undefined
    record.transcriptText = undefined
    record.previousTokenUsage = record.tokenUsage
    record.currentRunTokenUsage = undefined
    record.tokenUsage = undefined
    this.clearProgressUpdateTimer(record)
    record.lastProgressUpdateAt = undefined
    record.lastToolName = undefined
    record.lastEvent = wasRunning
      ? "Worker interrupted and continued with a new instruction."
      : "Worker continued with a new instruction."
    record.notificationEnqueued = false
    record.notificationMessage = undefined
    this.removeQueuedNotificationsForWorker(record.parentThreadId, {
      workerId: record.workerId
    })
    this.setUpdateCallback(record, options.onUpdate, options.onUpdateKey)
    this.emitUpdate(record)
    this.queuePersistWorkerState(record).catch((error) => {
      console.warn("[CoordinatorWorker] Failed to persist continuation state:", error)
    })
    if (wasRunning && previousRun) {
      const restartPromise = previousRun
        .catch(() => undefined)
        .then(() => {
          if (record.currentRun !== restartPromise) return
          if (record.discarded || record.status !== "running") {
            record.currentRun = undefined
            return
          }
          this.launch(record, prompt, options.runner, options.parentSignal)
        })
      record.currentRun = restartPromise
    } else {
      this.launch(record, prompt, options.runner, options.parentSignal)
    }
    return toSnapshot(record)
  }

  async continueWorkerAndPersist(
    options: ContinueWorkerOptions
  ): Promise<CoordinatorWorkerSnapshot> {
    const snapshot = await this.continueWorker(options)
    const record = await this.getWorkerForOperation(snapshot.parent_thread_id, snapshot.worker_id)
    if (record) {
      const currentRun = record.currentRun
      try {
        await record.statePersistPromise
      } catch (error) {
        await currentRun?.catch(() => undefined)
        await record.terminalPersistPromise?.catch(() => undefined)
        throw error
      }
      return toSnapshot(record)
    }
    return snapshot
  }

  readWorkers(parentThreadId: string, workerId?: string): CoordinatorWorkerSnapshot[] {
    if (workerId) {
      const record = this.getWorker(parentThreadId, workerId, { cache: false })
      return record ? [toSnapshot(record)] : []
    }
    const normalized = normalizeThreadId(parentThreadId)
    this.pruneInMemoryWorkerHistory(normalized)
    return Array.from(this.getParentMap(normalized)?.values() ?? []).map(toSnapshot)
  }

  hasRunningWorkers(): boolean {
    for (const records of this.workersByParent.values()) {
      for (const record of records.values()) {
        if (record.status === "running") return true
      }
    }
    return false
  }

  /** Thread-scoped variant of hasRunningWorkers: whether THIS parent thread has
   * any worker still running. The goal continuation loop uses it to defer
   * evaluation while the coordinator's workers are in flight — the global
   * predicate would wrongly defer a thread's goal because an unrelated thread
   * has workers running. Workers reach a terminal status BEFORE their
   * notification is enqueued (see the run promise's finally →
   * persistTerminalAndNotify), so by the time a coordinator notification turn
   * evaluates the goal, the finished worker no longer counts as running. */
  hasRunningWorkersForThread(parentThreadId: string): boolean {
    const records = this.getParentMap(parentThreadId)
    if (!records) return false
    for (const record of records.values()) {
      if (record.status === "running") return true
    }
    return false
  }

  /** A worker that is terminal (so hasRunningWorkersForThread is already false —
   * it checks status) but whose notification has NOT yet been enqueued: the brief
   * terminalPersistPromise span between the run's finally clearing currentRun and
   * enqueueNotification publishing its durably persisted result. In that gap neither
   * hasRunningWorkersForThread NOR hasAutoRunnableNotifications catches the
   * worker, so a goal on another notification turn could evaluate on evidence
   * that is missing this worker's result. The goal defer guard ORs this to close
   * that gap. Deadlock-safe: enqueueNotification sets notificationEnqueued before
   * adding the notification to the visible queue, so the notification a delivery
   * turn is currently handling never matches here. Excludes suppress_notification_auto_run and
   * dismissNotificationOnTerminalPersist workers — their results are not
   * auto-delivered, so the goal must not defer forever waiting for them. The
   * span always ends (persist success OR failure both fall through to enqueue,
   * which flips notificationEnqueued), so this can never be permanently true. */
  hasTerminalWorkerAwaitingNotificationForThread(parentThreadId: string): boolean {
    const records = this.getParentMap(parentThreadId)
    if (!records) return false
    for (const record of records.values()) {
      if (isWorkerAwaitingTerminalNotification(record)) return true
    }
    return false
  }

  /** Workspace-scoped (across ALL parent threads): is any RUNNING worker bound to
   * a workspace that overlaps `workspacePath`? auto-commit uses this — a running
   * worker on ANOTHER task/thread pointing at the same repo may be mutating this
   * tree, so a dirty-diff commit here could sweep its in-progress writes. Mirrors
   * workflowRunManager.activeRunForWorkspace: matched by canonical path with
   * either-way nesting (a worker on /repo and a commit on /repo/pkg overlap, and
   * vice versa), NOT raw string — symlink / case / trailing-slash variants of one
   * dir must still match. Counts EVERY running worker regardless of workload
   * (incl. read_only research fan-outs that never write) — deliberately
   * conservative: the cost is at most one extra auto-commit skip while a read-only
   * worker runs, versus the correctness risk of guessing a worker won't write.
   * Only RUNNING workers count: a terminal worker's runner has already returned,
   * so its writes are done and the tree is stable. */
  hasRunningWorkersForWorkspace(workspacePath: string): boolean {
    for (const records of this.workersByParent.values()) {
      for (const record of records.values()) {
        if (record.status !== "running") continue
        if (
          isCoordinatorPathWithin(record.workspacePath, workspacePath) ||
          isCoordinatorPathWithin(workspacePath, record.workspacePath)
        ) {
          return true
        }
      }
    }
    return false
  }

  /** Cancel all live workers and wait, within a shared deadline, for their run
   * and terminal-state persistence promises to settle during application exit. */
  async cancelAllWorkersAndWait(timeoutMs = 5_000): Promise<void> {
    this.shuttingDown = true
    const startedAt = Date.now()
    const records = Array.from(this.workersByParent.values()).flatMap((workers) =>
        Array.from(workers.values()).filter(
          (record) =>
            record.status === "running" ||
            (terminalStatus(record.status) && record.notificationEnqueued !== true) ||
            Boolean(
            record.currentRun ||
              record.terminalPersistPromise ||
              record.statePersistPromise ||
              record.notificationEnqueuePromise
          )
      )
    )
    for (const record of records) {
      if (record.status === "running") {
        this.cancelRecord(record, "Application is quitting.", true, true)
      } else {
        // A parent abort may have synchronously transitioned the worker before
        // this global drain took its snapshot. Still suppress and await the
        // cancellation persistence that is already in flight.
        record.suppressNotificationAutoRun = true
        record.dismissNotificationOnTerminalPersist = true
      }
    }
    if (records.length === 0 && this.restoreIndexStore.isIdle()) return

    let timedOut = false

    const waitWithinDeadline = async (promise: Promise<unknown>): Promise<boolean> => {
      const remainingMs = timeoutMs - (Date.now() - startedAt)
      if (remainingMs <= 0) return false
      let settled = false
      await Promise.race([
        promise.finally(() => {
          settled = true
        }),
        waitOrAbort(remainingMs)
      ])
      return settled
    }

    const readPending = (): Promise<unknown>[] =>
      Array.from(this.workersByParent.values()).flatMap((workers) =>
        Array.from(workers.values()).flatMap((record) =>
          [
            record.currentRun,
            record.terminalPersistPromise,
            record.statePersistPromise,
            record.notificationEnqueuePromise
          ].filter(isDefined)
        )
      )

    while (!timedOut) {
      const pending = readPending()
      if (pending.length > 0) {
        timedOut = !(await waitWithinDeadline(Promise.allSettled(pending)))
        continue
      }

      // A record continuation can enqueue its restore-index update after an earlier snapshot.
      // Drain, yield once for those continuations, then resample both sources before declaring
      // shutdown quiescent.
      timedOut = !(await waitWithinDeadline(this.restoreIndexStore.waitForIdle()))
      if (timedOut) break
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (readPending().length > 0) continue
      timedOut = !(await waitWithinDeadline(this.restoreIndexStore.waitForIdle()))
      break
    }
    if (timedOut) {
      console.warn("[CoordinatorWorker] Timed out waiting for workers to settle during shutdown")
    }
  }

  bindWorkerUpdates(
    parentThreadId: string,
    onUpdate?: CoordinatorWorkerUpdateCallback,
    onUpdateKey?: string
  ): void {
    if (!onUpdate) return
    const records = this.getParentMap(parentThreadId)
    if (!records) return
    for (const record of records.values()) {
      this.setUpdateCallback(record, onUpdate, onUpdateKey)
    }
  }

  unbindWorkerUpdates(parentThreadId: string, onUpdateKey?: string): void {
    const key = onUpdateKey ?? DEFAULT_WORKER_UPDATE_CALLBACK_KEY
    const records = this.getParentMap(parentThreadId)
    if (!records) return
    for (const record of records.values()) {
      record.onUpdateCallbacks?.delete(key)
      if (record.onUpdateCallbacks?.size === 0) {
        record.onUpdateCallbacks = undefined
      }
    }
  }

  async readWorkerResult(
    parentThreadId: string,
    workerId: string,
    options: { maxChars?: number } = {}
  ): Promise<CoordinatorWorkerResultRead> {
    const record = await this.getWorkerForOperation(parentThreadId, workerId, {
      cache: false
    })
    if (!record) {
      throw new Error(`Unknown coordinator worker: ${workerId}`)
    }
    const maxChars = Math.min(
      MAX_RESULT_READ_CHARS,
      Math.max(1_000, options.maxChars ?? DEFAULT_RESULT_READ_CHARS)
    )
    const workspaceRoot = path.resolve(record.workspacePath)
    const readRelativeFile = async (
      relativePath: string | undefined
    ): Promise<ReturnType<typeof truncateReadText> | undefined> => {
      if (!relativePath) return undefined
      const resolvedRelativePath = resolveWorkerResultReadRelativePath(
        record.parentThreadId,
        relativePath
      )
      const target = path.resolve(workspaceRoot, resolvedRelativePath)
      if (!isCoordinatorPathWithin(target, workspaceRoot)) {
        throw new Error(`Worker output path escapes workspace: ${relativePath}`)
      }
      return truncateReadText(await readFile(target, "utf8"), maxChars)
    }

    const result = await readRelativeFile(record.resultPath)

    return {
      worker: toSnapshot(record),
      result_path: record.resultPath,
      result_text: result?.text,
      result_chars: result?.chars,
      result_truncated: result?.truncated,
      message: record.resultPath
        ? undefined
        : "No result file is available yet. Wait for the worker's task-notification."
    }
  }

  async getWorkerSelectedSkill(
    parentThreadId: string,
    workerId: string
  ): Promise<CoordinatorSelectedSkill | undefined> {
    const record = await this.getWorkerForOperation(parentThreadId, workerId, { cache: false })
    return record?.selectedSkill
  }

  async waitForWorkers(
    parentThreadId: string,
    options: WaitWorkersOptions = {}
  ): Promise<CoordinatorWorkerSnapshot[]> {
    const block = options.block !== false
    const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
    const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_WAIT_POLL_MS)

    if (!block) {
      if (options.workerId) {
        const record = await this.getWorkerForOperation(parentThreadId, options.workerId, {
          cache: false
        })
        return record ? [toSnapshot(record)] : []
      }
      return this.readWorkers(parentThreadId)
    }

    const startedAt = Date.now()
    while (Date.now() - startedAt <= timeoutMs) {
      if (options.signal?.aborted) break
      const records = await this.readWorkerRecordsAsync(parentThreadId, options.workerId)
      const workers = records.map(toSnapshot)
      if (workers.length === 0 || workers.every((worker) => terminalStatus(worker.status))) {
        const pendingTerminalWork = records.flatMap((record) =>
          [
            record.terminalPersistPromise,
            record.notificationEnqueuePromise,
            // Status becomes terminal just before the runner's finally block starts durable
            // terminal persistence. Waiting for currentRun closes that handoff gap; otherwise a
            // caller can delete the workspace while result/state/index writes are still starting.
            record.currentRun
          ].filter(isDefined)
        )
        if (pendingTerminalWork.length > 0) {
          const remainingMs = timeoutMs - (Date.now() - startedAt)
          if (remainingMs > 0) {
            await Promise.race([
              Promise.allSettled(pendingTerminalWork),
              waitOrAbort(remainingMs, options.signal)
            ])
            continue
          }
        }
        return workers
      }
      const remainingMs = timeoutMs - (Date.now() - startedAt)
      if (remainingMs <= 0) break
      await waitOrAbort(Math.min(pollIntervalMs, remainingMs), options.signal)
    }

    if (options.workerId) {
      const record = await this.getWorkerForOperation(parentThreadId, options.workerId, {
        cache: false
      })
      return record ? [toSnapshot(record)] : []
    }
    return this.readWorkers(parentThreadId)
  }

  drainNotifications(parentThreadId: string): string[] {
    const normalized = normalizeThreadId(parentThreadId)
    const notifications = this.notificationsByParent.get(normalized) ?? []
    this.notificationsByParent.delete(normalized)
    this.touchParentCache(normalized)
    return [...notifications]
  }

  peekNotifications(parentThreadId: string): string[] {
    const normalized = normalizeThreadId(parentThreadId)
    return [...(this.notificationsByParent.get(normalized) ?? [])]
  }

  hasNotifications(parentThreadId: string): boolean {
    const normalized = normalizeThreadId(parentThreadId)
    return (this.notificationsByParent.get(normalized)?.length ?? 0) > 0
  }

  hasAutoRunnableNotifications(parentThreadId: string): boolean {
    const normalized = normalizeThreadId(parentThreadId)
    const notifications = this.notificationsByParent.get(normalized) ?? []
    return notifications.some((notification) => {
      const workerId = this.extractNotificationWorkerId(notification)
      if (!workerId) return true
      const record = this.getParentMap(normalized)?.get(workerId)
      if (!record) return true
      return record.suppressNotificationAutoRun !== true
    })
  }

  restoreNotifications(parentThreadId: string, notifications: string[]): void {
    if (notifications.length === 0) return
    const normalized = normalizeThreadId(parentThreadId)
    const merged = [...(this.notificationsByParent.get(normalized) ?? [])]
    let changed = false
    for (const notification of notifications) {
      if (!this.shouldRestoreNotification(normalized, notification)) continue
      const workerId = this.extractNotificationWorkerId(notification)
      const turn = this.extractNotificationWorkerTurn(notification)
      if (workerId && turn !== undefined) {
        const existingIndex = merged.findIndex(
          (candidate) =>
            this.extractNotificationWorkerId(candidate) === workerId &&
            this.extractNotificationWorkerTurn(candidate) === turn
        )
        if (existingIndex >= 0) {
          if (merged[existingIndex] !== notification) {
            merged[existingIndex] = notification
            changed = true
          }
          continue
        }
      } else if (merged.includes(notification)) {
        continue
      }
      merged.push(notification)
      changed = true
    }
    if (!changed) return
    this.notificationsByParent.set(normalized, merged)
    this.touchParentCache(normalized)
  }

  async restoreNotificationMessages(
    parentThreadId: string,
    notifications: string[]
  ): Promise<void> {
    if (notifications.length === 0) return
    const normalized = normalizeThreadId(parentThreadId)
    const validNotifications: string[] = []
    const refs = notifications
      .map((notification): NotificationRef | undefined => {
        const routingFields = this.extractXmlDirectFields(notification, "task-notification")
        const workerId = routingFields?.get("task-id")
        if (!workerId) return undefined
        const turnValue = routingFields?.get("turn")
        const turn = turnValue ? Number(turnValue) : undefined
        return {
          workerId,
          turn: Number.isFinite(turn) ? turn : undefined,
          notification
        } as NotificationRef & { notification: string }
      })
      .filter((ref): ref is NotificationRef & { notification: string } => Boolean(ref))
    const persistPromises: Promise<void>[] = []
    for (const ref of refs) {
      const normalizedWorkerId = normalizeWorkerId(ref.workerId)
      const record = this.getWorker(normalized, normalizedWorkerId)
      if (!record || !terminalStatus(record.status)) continue
      const persistedNotification = this.validatePersistedNotificationMessage(
        record,
        ref.notification
      )
      const canFallbackToCurrentTurn =
        ref.turn !== undefined &&
        ref.turn === record.turns &&
        record.notificationAcknowledged === false
      const notificationToRestore = (() => {
        if (persistedNotification) return persistedNotification
        if (!canFallbackToCurrentTurn) {
          console.warn(
            `[CoordinatorWorker] Ignoring invalid restored notification for ${record.workerId} because it does not match the current unacknowledged worker turn.`
          )
          return undefined
        }
        console.warn(
          `[CoordinatorWorker] Restoring notification for ${record.workerId} by rebuilding from current worker state because the persisted notification payload did not validate.`
        )
        return this.formatNotification(record)
      })()
      if (!notificationToRestore) continue
      record.notificationAcknowledged = false
      record.notificationEnqueued = true
      record.notificationMessage = notificationToRestore
      validNotifications.push(notificationToRestore)
      persistPromises.push(this.queuePersistWorkerState(record))
    }
    this.restoreNotifications(normalized, validNotifications)
    const results = await Promise.allSettled(persistPromises)
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("[CoordinatorWorker] Failed to persist notification restore:", result.reason)
      }
    }
  }

  async acknowledgeNotifications(parentThreadId: string, workerIds: string[]): Promise<void> {
    if (workerIds.length === 0) return
    const normalized = normalizeThreadId(parentThreadId)
    const persistPromises: Promise<void>[] = []
    for (const workerId of workerIds) {
      const normalizedWorkerId = normalizeWorkerId(workerId)
      const record = this.getWorker(normalized, normalizedWorkerId)
      if (!record || !terminalStatus(record.status)) continue
      this.removeQueuedNotificationsForWorker(normalized, { workerId: normalizedWorkerId })
      record.notificationAcknowledged = true
      record.suppressNotificationAutoRun = false
      record.notificationEnqueued = true
      record.notificationMessage = undefined
      persistPromises.push(this.queuePersistWorkerState(record))
    }
    const results = await Promise.allSettled(persistPromises)
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn(
          "[CoordinatorWorker] Failed to persist notification acknowledgement:",
          result.reason
        )
      }
    }
    this.pruneInMemoryWorkerHistory(normalized)
    await this.restoreNextOverflowPageAfterAcknowledgement(normalized)
  }

  async acknowledgeNotificationMessages(
    parentThreadId: string,
    notifications: string[]
  ): Promise<void> {
    const normalized = normalizeThreadId(parentThreadId)
    const persistPromises: Promise<void>[] = []
    for (const notification of notifications) {
      const workerId = this.extractNotificationWorkerId(notification)
      if (!workerId) continue
      const normalizedWorkerId = normalizeWorkerId(workerId)
      const record = this.getWorker(normalized, normalizedWorkerId)
      if (!record || !terminalStatus(record.status)) continue
      const acknowledgedNotification = this.validatePersistedNotificationMessage(
        record,
        notification
      )
      if (!acknowledgedNotification) continue
      const turn = this.extractNotificationWorkerTurn(acknowledgedNotification)
      if (turn === undefined) continue
      this.removeQueuedNotificationsForWorker(normalized, {
        workerId: normalizedWorkerId,
        turn
      })
      record.notificationAcknowledged = true
      record.suppressNotificationAutoRun = false
      record.notificationEnqueued = true
      record.notificationMessage = undefined
      persistPromises.push(this.queuePersistWorkerState(record))
    }
    const results = await Promise.allSettled(persistPromises)
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn(
          "[CoordinatorWorker] Failed to persist notification acknowledgement:",
          result.reason
        )
      }
    }
    this.pruneInMemoryWorkerHistory(normalized)
    await this.restoreNextOverflowPageAfterAcknowledgement(normalized)
  }

  cancelWorkersForThread(
    parentThreadId: string,
    reason = "Parent run cancelled.",
    options?: {
      suppressNotificationAutoRun?: boolean
      dismissNotificationOnTerminalPersist?: boolean
    }
  ): CoordinatorWorkerSnapshot[] {
    const records = Array.from(this.getParentMap(parentThreadId)?.values() ?? []).filter(
      (record) => record.status === "running"
    )
    for (const record of records) {
      this.cancelRecord(
        record,
        reason,
        options?.suppressNotificationAutoRun,
        options?.dismissNotificationOnTerminalPersist
      )
    }
    return records.map(toSnapshot)
  }

  async cancelWorker(
    parentThreadId: string,
    workerId: string,
    reason = "Worker cancelled.",
    options?: {
      suppressNotificationAutoRun?: boolean
      dismissNotificationOnTerminalPersist?: boolean
    }
  ): Promise<CoordinatorWorkerSnapshot> {
    const record = await this.getWorkerForOperation(parentThreadId, workerId)
    if (!record) {
      throw new Error(`Unknown coordinator worker: ${workerId}`)
    }
    this.cancelRecord(
      record,
      reason,
      options?.suppressNotificationAutoRun,
      options?.dismissNotificationOnTerminalPersist
    )
    return toSnapshot(record)
  }

  async waitForTerminalPersistence(
    parentThreadId: string,
    workerIds?: string[],
    timeoutMs = 5_000
  ): Promise<void> {
    const normalizedWorkerIds = workerIds?.map(normalizeWorkerId)
    const records = await this.readWorkerRecordsAsync(
      parentThreadId,
      normalizedWorkerIds && normalizedWorkerIds.length === 1 ? normalizedWorkerIds[0] : undefined
    )
    const filteredRecords = records.filter((record) => {
      if (!normalizedWorkerIds || normalizedWorkerIds.length === 0)
        return terminalStatus(record.status)
      return normalizedWorkerIds.includes(record.workerId) && terminalStatus(record.status)
    })
    const startedAt = Date.now()
    if (filteredRecords.length > 0) {
      while (Date.now() - startedAt <= timeoutMs) {
        const pending = filteredRecords.flatMap((record) =>
          [
            record.currentRun,
            record.terminalPersistPromise,
            record.statePersistPromise,
            record.notificationEnqueuePromise
          ].filter(isDefined)
        )
        if (pending.length === 0) break
        const remainingMs = timeoutMs - (Date.now() - startedAt)
        if (remainingMs <= 0) return
        await Promise.race([Promise.allSettled(pending), waitOrAbort(Math.min(remainingMs, 250))])
      }
    }

    const workspacePath =
      filteredRecords[0]?.workspacePath ??
      this.workspacePathByParent.get(normalizeThreadId(parentThreadId))
    if (!workspacePath) return
    const remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) return
    await Promise.race([
      this.restoreIndexStore.waitForIdle(workerStateDirectory(workspacePath, parentThreadId)),
      waitOrAbort(remainingMs)
    ])
  }

  async waitForWorkerCleanup(
    parentThreadId: string,
    workerIds?: string[],
    timeoutMs = 5_000
  ): Promise<void> {
    const normalizedWorkerIds = workerIds?.map(normalizeWorkerId)
    const readPendingRecords = async (): Promise<Promise<unknown>[]> => {
      const records = await this.readWorkerRecordsAsync(
        parentThreadId,
        normalizedWorkerIds && normalizedWorkerIds.length === 1 ? normalizedWorkerIds[0] : undefined
      )
      const filteredRecords = records.filter((record) => {
        if (!normalizedWorkerIds || normalizedWorkerIds.length === 0) return true
        return normalizedWorkerIds.includes(record.workerId)
      })
      return filteredRecords.flatMap((record) =>
        [
          record.currentRun,
          record.terminalPersistPromise,
          record.statePersistPromise,
          record.notificationEnqueuePromise
        ].filter(isDefined)
      )
    }
    const startedAt = Date.now()
    const workspacePath = this.workspacePathByParent.get(normalizeThreadId(parentThreadId))
    const waitForIndexIdle = async (): Promise<boolean> => {
      if (!workspacePath) return true
      const remainingMs = timeoutMs - (Date.now() - startedAt)
      if (remainingMs <= 0) return false
      let indexIdle = false
      await Promise.race([
        this.restoreIndexStore
          .waitForIdle(workerStateDirectory(workspacePath, parentThreadId))
          .then(() => {
            indexIdle = true
          }),
        waitOrAbort(remainingMs)
      ])
      return indexIdle
    }
    while (Date.now() - startedAt <= timeoutMs) {
      const pending = await readPendingRecords()
      if (pending.length > 0) {
        const remainingMs = timeoutMs - (Date.now() - startedAt)
        if (remainingMs <= 0) break
        await Promise.race([Promise.allSettled(pending), waitOrAbort(Math.min(remainingMs, 250))])
        continue
      }

      if (!(await waitForIndexIdle())) break
      await new Promise<void>((resolve) => setImmediate(resolve))
      if ((await readPendingRecords()).length > 0) continue
      if (await waitForIndexIdle()) return
      break
    }
    if ((await readPendingRecords()).length === 0) {
      if (!workspacePath) return
      if (
        this.restoreIndexStore.isIdle(workerStateDirectory(workspacePath, parentThreadId))
      ) {
        return
      }
    }
    const workerLabel =
      workerIds && workerIds.length > 0 ? ` (${workerIds.map(normalizeWorkerId).join(", ")})` : ""
    throw new Error(
      `Timed out waiting for coordinator worker cleanup${workerLabel} in thread ${normalizeThreadId(parentThreadId)}.`
    )
  }

  async restoreWorkersForThread(
    options: RestoreWorkersOptions
  ): Promise<CoordinatorWorkerSnapshot[]> {
    const parentThreadId = normalizeThreadId(options.parentThreadId)
    const workspacePath = normalizeNonEmpty(
      options.workspacePath,
      "Coordinator worker workspacePath"
    )
    const restoreEpoch = this.restoreEpoch
    const restoreGeneration = this.restoreGenerationByParent.get(parentThreadId) ?? 0
    return this.enqueueWorkerRestore(
      parentThreadId,
      () =>
        this.restoreWorkersForThreadSerialized(
          options,
          parentThreadId,
          workspacePath,
          restoreEpoch,
          restoreGeneration
        ),
      options.signal
    )
  }

  private enqueueWorkerRestore<T>(
    parentThreadId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const parentDepth = this.restoreQueueDepthByParent.get(parentThreadId) ?? 0
    if (
      this.restoreOperationCount >=
        MAX_COORDINATOR_ACTIVE_RESTORES + MAX_COORDINATOR_RESTORE_WAITERS ||
      parentDepth >= MAX_COORDINATOR_RESTORES_PER_PARENT
    ) {
      return Promise.reject(new Error("Coordinator worker restore capacity exceeded"))
    }
    this.restoreOperationCount += 1
    this.restoreQueueDepthByParent.set(parentThreadId, parentDepth + 1)
    this.touchParentCache(parentThreadId)
    const previous = this.restoreQueueByParent.get(parentThreadId) ?? Promise.resolve()
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        throwIfRestoreAborted(signal)
        const release = await this.restoreAdmission.acquire(signal, () => {
          if (signal?.reason instanceof Error) return signal.reason
          return new DOMException("Coordinator worker restore was superseded.", "AbortError")
        })
        try {
          return await operation()
        } finally {
          release()
        }
      })
    const tail = task.then(
      () => undefined,
      () => undefined
    )
    this.restoreQueueByParent.set(parentThreadId, tail)
    void tail.finally(() => {
      if (this.restoreQueueByParent.get(parentThreadId) === tail) {
        this.restoreQueueByParent.delete(parentThreadId)
        if (
          !this.workersByParent.has(parentThreadId) &&
          !this.workspacePathByParent.has(parentThreadId)
        ) {
          this.restoreGenerationByParent.delete(parentThreadId)
        }
        this.touchParentCache(parentThreadId)
      }
      this.restoreOperationCount = Math.max(0, this.restoreOperationCount - 1)
      const nextDepth = (this.restoreQueueDepthByParent.get(parentThreadId) ?? 1) - 1
      if (nextDepth <= 0) this.restoreQueueDepthByParent.delete(parentThreadId)
      else this.restoreQueueDepthByParent.set(parentThreadId, nextDepth)
    })
    return task
  }

  private async restoreWorkersForThreadSerialized(
    options: RestoreWorkersOptions,
    parentThreadId: string,
    workspacePath: string,
    restoreEpoch: number,
    restoreGeneration: number
  ): Promise<CoordinatorWorkerSnapshot[]> {
    throwIfRestoreAborted(options.signal)
    if (
      restoreEpoch !== this.restoreEpoch ||
      restoreGeneration !== (this.restoreGenerationByParent.get(parentThreadId) ?? 0)
    ) {
      throw new DOMException("Coordinator worker restore was invalidated.", "AbortError")
    }
    const restoreMode = options.mode ?? "full"
    const hydratedWorkspace =
      restoreMode === "active"
        ? this.activeRestoreHydratedWorkspaceByParent.get(parentThreadId)
        : restoreMode === "recent"
          ? this.recentRestoreHydratedWorkspaceByParent.get(parentThreadId)
          : undefined
    if (hydratedWorkspace === workspacePath) {
      const existingRecords = Array.from(this.getParentMap(parentThreadId)?.values() ?? [])
      for (const record of existingRecords) {
        this.setUpdateCallback(record, options.onUpdate, options.onUpdateKey)
      }
      await this.publishRepairableRestoredNotifications(existingRecords)
      return this.readWorkers(parentThreadId)
    }

    const workersDir = workerStateDirectory(workspacePath, parentThreadId)
    const restoreDirectoryIncarnation = this.getOrCreateRestoreDirectoryIncarnation(
      parentThreadId,
      workspacePath
    )
    const fullRestore = restoreMode === "full"
    const recentRestore = restoreMode === "recent"
    let files: string[] = []
    let candidateOverflow = false
    let missingWorkersDirectory = false
    let indexedCandidates = new Map<
      string,
      { status: CoordinatorWorkerStatus; notificationAcknowledged: boolean }
    >()
    if (fullRestore) {
      try {
        files = await readdir(workersDir)
        throwIfRestoreAborted(options.signal)
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          missingWorkersDirectory = true
          files = []
        } else {
          throw error
        }
      }
    } else {
      const candidatePage = await this.restoreIndexStore.loadCandidates(
        workersDir,
        restoreMode,
        options.signal,
        restoreDirectoryIncarnation
      )
      throwIfRestoreAborted(options.signal)
      candidateOverflow = candidatePage.overflow
      indexedCandidates = new Map(
        candidatePage.entries.map((entry) => [
          entry.worker_id,
          {
            status: entry.status,
            notificationAcknowledged: entry.notification_acknowledged
          }
        ])
      )
      files = candidatePage.entries.map((entry) => `${entry.worker_id}.json`)
    }

    const stagedRecords: CoordinatorWorkerRecord[] = []
    const stagedStaleWorkerIds = new Set<string>()
    const stagedPendingTerminal: CoordinatorWorkerRecord[] = []
    let restoredStateBytes = 0
    let deferredUnresolvedState = false
    let truncatedCandidateState = false
    for (const file of files) {
      throwIfRestoreAborted(options.signal)
      if (!file.endsWith(".json")) continue
      const workerIdFromFile = file.slice(0, -".json".length)
      if (!WORKER_ID_PATTERN.test(workerIdFromFile)) continue

      try {
        const statePath = path.join(workersDir, file)
        const indexedCandidate = indexedCandidates.get(workerIdFromFile)
        const unresolvedIndexedCandidate =
          indexedCandidate?.status === "running" ||
          indexedCandidate?.notificationAcknowledged === false
        if (!fullRestore && restoredStateBytes >= RESTORE_STATE_TOTAL_MAX_BYTES) {
          deferredUnresolvedState ||= unresolvedIndexedCandidate
          truncatedCandidateState = true
          break
        }
        throwIfRestoreAborted(options.signal)
        const remainingStateBytes = RESTORE_STATE_TOTAL_MAX_BYTES - restoredStateBytes
        const boundedState = fullRestore
          ? {
              raw: await readFile(statePath, { encoding: "utf8", signal: options.signal }),
              bytes: 0
            }
          : await readBoundedWorkerState(
              statePath,
              remainingStateBytes,
              options.signal
            )
        if (!boundedState) {
          if (unresolvedIndexedCandidate && remainingStateBytes < RESTORE_STATE_FILE_MAX_BYTES) {
            deferredUnresolvedState = true
            truncatedCandidateState = true
            break
          }
          console.warn(
            `[CoordinatorWorker] Skipping oversized indexed restore state: ${workerIdFromFile}`
          )
          deferredUnresolvedState ||= unresolvedIndexedCandidate
          truncatedCandidateState = true
          continue
        }
        if (!fullRestore) restoredStateBytes += boundedState.bytes
        throwIfRestoreAborted(options.signal)
        const snapshot = JSON.parse(boundedState.raw) as Partial<CoordinatorWorkerSnapshot>
        const record = this.recordFromSnapshot(
          snapshot,
          workspacePath,
          options.onUpdate,
          options.onUpdateKey
        )
        if (!record) continue
        if (record.parentThreadId !== parentThreadId || record.workerId !== workerIdFromFile) {
          continue
        }

        if (record.status === "running") {
          const timestamp = nowIso()
          record.status = "failed"
          record.updatedAt = timestamp
          record.finishedAt = timestamp
          record.lastActivityAt = timestamp
          record.error =
            "Worker was interrupted because CmbCowork restarted before it finished. Use continue_worker to resume with the same worker checkpoint."
          record.lastEvent = "Worker restored as stale after app restart."
          record.summary = record.error
          record.rawText = record.error
          stagedStaleWorkerIds.add(record.workerId)
          stagedPendingTerminal.push(record)
        } else if (terminalStatus(record.status) && record.notificationAcknowledged === false) {
          stagedPendingTerminal.push(record)
        } else if (!fullRestore && !recentRestore) {
          continue
        }
        stagedRecords.push(record)
      } catch (error) {
        if (options.signal?.aborted) throwIfRestoreAborted(options.signal)
        console.warn("[CoordinatorWorker] Failed to restore worker state:", error)
      }
    }

    if (stagedPendingTerminal.length > 0) {
      throwIfRestoreAborted(options.signal)
      await settleInBatches(
        stagedPendingTerminal,
        RESTORED_RAW_TEXT_HYDRATE_CONCURRENCY,
        (record) => {
          throwIfRestoreAborted(options.signal)
          return this.hydrateRestoredRawText(record, options.signal, false)
        }
      )
    }

    throwIfRestoreAborted(options.signal)
    if (
      restoreEpoch !== this.restoreEpoch ||
      restoreGeneration !== (this.restoreGenerationByParent.get(parentThreadId) ?? 0)
    ) {
      throw new DOMException("Coordinator worker restore was invalidated.", "AbortError")
    }

    // Commit is deliberately synchronous: cancellation and concurrent callers cannot observe a
    // partially populated worker map. A live in-memory record always wins over a staged snapshot.
    this.workspacePathByParent.set(parentThreadId, workspacePath)
    const records = this.parentMap(parentThreadId)
    for (const record of records.values()) {
      this.setUpdateCallback(record, options.onUpdate, options.onUpdateKey)
    }
    const committedRecords: CoordinatorWorkerRecord[] = []
    for (const stagedRecord of stagedRecords) {
      const existing = records.get(stagedRecord.workerId)
      if (existing) {
        this.setUpdateCallback(existing, options.onUpdate, options.onUpdateKey)
        continue
      }
      records.set(stagedRecord.workerId, stagedRecord)
      committedRecords.push(stagedRecord)
    }

    const unresolvedRestoreIncomplete = candidateOverflow || deferredUnresolvedState
    const recentRestoreIncomplete = candidateOverflow || truncatedCandidateState
    if (unresolvedRestoreIncomplete) {
      this.restoreOverflowWorkspaceByParent.set(parentThreadId, workspacePath)
      this.activeRestoreHydratedWorkspaceByParent.delete(parentThreadId)
    } else {
      this.restoreOverflowWorkspaceByParent.delete(parentThreadId)
      this.activeRestoreHydratedWorkspaceByParent.set(parentThreadId, workspacePath)
    }
    if (fullRestore || (recentRestore && !recentRestoreIncomplete)) {
      this.recentRestoreHydratedWorkspaceByParent.set(parentThreadId, workspacePath)
    } else if (recentRestore) {
      this.recentRestoreHydratedWorkspaceByParent.delete(parentThreadId)
    }
    if (missingWorkersDirectory) {
      this.activeRestoreHydratedWorkspaceByParent.set(parentThreadId, workspacePath)
      this.recentRestoreHydratedWorkspaceByParent.set(parentThreadId, workspacePath)
    }

    const committedStaleRecords = committedRecords.filter((record) =>
      stagedStaleWorkerIds.has(record.workerId)
    )
    await settleInBatches(
      committedStaleRecords,
      RESTORED_RAW_TEXT_HYDRATE_CONCURRENCY,
      (record) => this.persistTerminalAndNotify(record)
    )

    const staleIds = new Set(committedStaleRecords.map((record) => record.workerId))
    const committedPendingRecords = committedRecords.filter(
      (record) =>
        terminalStatus(record.status) &&
        record.notificationAcknowledged === false &&
        !staleIds.has(record.workerId)
    )
    const repairableExistingRecords = Array.from(records.values()).filter(
      (record) =>
        !committedRecords.includes(record) && this.isRepairableRestoredNotification(record)
    )
    await this.publishRepairableRestoredNotifications([
      ...committedPendingRecords,
      ...repairableExistingRecords
    ])

    return this.readWorkers(parentThreadId)
  }

  forgetThread(parentThreadId: string): void {
    const normalized = normalizeThreadId(parentThreadId)
    this.restoreGenerationByParent.set(
      normalized,
      (this.restoreGenerationByParent.get(normalized) ?? 0) + 1
    )
    const records = this.workersByParent.get(normalized)
    if (records) {
      for (const record of records.values()) {
        record.discarded = true
        this.clearUpdateCallbacks(record)
        record.notificationEnqueued = true
        this.clearProgressUpdateTimer(record)
        if (record.status === "running") {
          record.abortController?.abort(
            new DOMException("Coordinator worker thread forgotten.", "AbortError")
          )
        }
      }
    }
    const restoreDirectoryIncarnation = this.restoreDirectoryIncarnationByParent.get(normalized)
    if (restoreDirectoryIncarnation) {
      this.restoreIndexStore.tombstoneDirectoryIncarnation(restoreDirectoryIncarnation)
      this.restoreDirectoryIncarnationByParent.delete(normalized)
    }
    this.workersByParent.delete(normalized)
    this.notificationsByParent.delete(normalized)
    this.prunedSnapshotsByParent.delete(normalized)
    const workspacePath = this.workspacePathByParent.get(normalized)
    if (workspacePath) {
      const scratchpadPath = coordinatorScratchpadPath(workspacePath, normalized)
      this.preparedScratchpadDirs.delete(scratchpadPath)
      this.warnedScratchpadDirs.delete(scratchpadPath)
    }
    this.workspacePathByParent.delete(normalized)
    this.activeRestoreHydratedWorkspaceByParent.delete(normalized)
    this.recentRestoreHydratedWorkspaceByParent.delete(normalized)
    this.restoreOverflowWorkspaceByParent.delete(normalized)
    this.parentCacheLru.delete(normalized)
  }

  async forgetThreadAndDeleteArtifacts(
    parentThreadId: string,
    workspacePath?: string,
    timeoutMs = 5_000
  ): Promise<void> {
    const normalized = normalizeThreadId(parentThreadId)
    const knownWorkspacePath = this.workspacePathByParent.get(normalized)
    const normalizedWorkspacePath = optionalString(workspacePath) ?? knownWorkspacePath
    if (!normalizedWorkspacePath) {
      this.forgetThread(normalized)
      return
    }
    const incarnation =
      this.restoreDirectoryIncarnationByParent.get(normalized) ??
      this.restoreIndexStore.createDirectoryIncarnation(
        workerStateDirectory(normalizedWorkspacePath, normalized)
      )
    const cleanup = this.restoreIndexStore.deleteDirectoryIncarnation(incarnation, () =>
      removeCoordinatorWorkerArtifacts(normalized, normalizedWorkspacePath)
    )
    this.forgetThread(normalized)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        cleanup,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Timed out deleting coordinator worker artifacts safely")),
            Math.max(1, timeoutMs)
          )
        })
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
      // Cleanup deliberately continues behind the directory barrier after a timeout. A revived
      // same-ID thread stays queued instead of racing a late old-generation mkdir or rename.
      void cleanup.catch(() => undefined)
    }
  }

  clear(): void {
    this.restoreEpoch += 1
    for (const incarnation of this.restoreDirectoryIncarnationByParent.values()) {
      this.restoreIndexStore.tombstoneDirectoryIncarnation(incarnation)
    }
    this.restoreDirectoryIncarnationByParent.clear()
    for (const records of this.workersByParent.values()) {
      for (const record of records.values()) {
        record.discarded = true
        this.clearUpdateCallbacks(record)
        record.notificationEnqueued = true
        this.clearProgressUpdateTimer(record)
        if (record.status === "running") {
          record.abortController?.abort(
            new DOMException("Coordinator worker manager cleared.", "AbortError")
          )
        }
      }
    }
    this.notificationsByParent.clear()
    this.workersByParent.clear()
    this.prunedSnapshotsByParent.clear()
    this.workspacePathByParent.clear()
    this.activeRestoreHydratedWorkspaceByParent.clear()
    this.recentRestoreHydratedWorkspaceByParent.clear()
    this.restoreOverflowWorkspaceByParent.clear()
    this.restoreGenerationByParent.clear()
    this.parentCacheLru.clear()
    this.preparedScratchpadDirs.clear()
    this.warnedScratchpadDirs.clear()
  }

  private nextWorkerId(role: CoordinatorWorkerRole): string {
    this.sequence += 1
    return `${role}-${Date.now()}-${this.sequence}`
  }

  private parentMap(parentThreadId: string): Map<string, CoordinatorWorkerRecord> {
    const normalized = normalizeThreadId(parentThreadId)
    let records = this.workersByParent.get(normalized)
    if (!records) {
      records = new Map()
      this.workersByParent.set(normalized, records)
    }
    this.touchParentCache(normalized)
    return records
  }

  private getOrCreateRestoreDirectoryIncarnation(
    parentThreadId: string,
    workspacePath: string
  ): CoordinatorWorkerRestoreDirectoryIncarnation {
    const normalized = normalizeThreadId(parentThreadId)
    const workersDir = workerStateDirectory(workspacePath, normalized)
    const existing = this.restoreDirectoryIncarnationByParent.get(normalized)
    if (existing?.valid && existing.workersDir === workersDir) return existing
    if (existing?.valid) this.restoreIndexStore.tombstoneDirectoryIncarnation(existing)
    const incarnation = this.restoreIndexStore.createDirectoryIncarnation(workersDir)
    this.restoreDirectoryIncarnationByParent.set(normalized, incarnation)
    return incarnation
  }

  private assertCurrentRestoreDirectoryIncarnation(record: CoordinatorWorkerRecord): void {
    if (
      !record.restoreDirectoryIncarnation.valid ||
      this.restoreDirectoryIncarnationByParent.get(record.parentThreadId) !==
        record.restoreDirectoryIncarnation
    ) {
      throw new DOMException("Coordinator worker directory incarnation is stale.", "AbortError")
    }
  }

  private getParentMap(parentThreadId: string): Map<string, CoordinatorWorkerRecord> | undefined {
    const normalized = normalizeThreadId(parentThreadId)
    const records = this.workersByParent.get(normalized)
    if (records) this.touchParentCache(normalized)
    return records
  }

  private touchParentCache(parentThreadId: string): void {
    const normalized = normalizeThreadId(parentThreadId)
    this.parentCacheLru.delete(normalized)
    this.parentCacheLru.set(normalized, true)
    this.pruneIdleParentCaches(normalized)
  }

  private canEvictParentCache(parentThreadId: string): boolean {
    if (this.restoreQueueByParent.has(parentThreadId)) return false
    if ((this.notificationsByParent.get(parentThreadId)?.length ?? 0) > 0) return false
    const records = this.workersByParent.get(parentThreadId)
    if (records && Array.from(records.values()).some((record) => !this.canPruneWorkerRecord(record))) {
      return false
    }
    return true
  }

  private pruneIdleParentCaches(preserveParentThreadId?: string): void {
    const idleParents = Array.from(this.parentCacheLru.keys()).filter((parentThreadId) =>
      this.canEvictParentCache(parentThreadId)
    )
    let removeCount = idleParents.length - MAX_COORDINATOR_IDLE_PARENTS_IN_MEMORY
    if (removeCount <= 0) return
    for (const parentThreadId of idleParents) {
      if (removeCount <= 0) break
      if (parentThreadId === preserveParentThreadId) continue
      this.evictIdleParentCache(parentThreadId)
      removeCount -= 1
    }
  }

  private evictIdleParentCache(parentThreadId: string): void {
    if (!this.canEvictParentCache(parentThreadId)) return
    const records = this.workersByParent.get(parentThreadId)
    if (records) {
      for (const record of records.values()) {
        record.discarded = true
        this.clearUpdateCallbacks(record)
        this.clearProgressUpdateTimer(record)
      }
    }
    const workspacePath = this.workspacePathByParent.get(parentThreadId)
    if (workspacePath) {
      const scratchpadPath = coordinatorScratchpadPath(workspacePath, parentThreadId)
      this.preparedScratchpadDirs.delete(scratchpadPath)
      this.warnedScratchpadDirs.delete(scratchpadPath)
    }
    this.workersByParent.delete(parentThreadId)
    this.notificationsByParent.delete(parentThreadId)
    this.prunedSnapshotsByParent.delete(parentThreadId)
    this.workspacePathByParent.delete(parentThreadId)
    this.activeRestoreHydratedWorkspaceByParent.delete(parentThreadId)
    this.recentRestoreHydratedWorkspaceByParent.delete(parentThreadId)
    this.restoreOverflowWorkspaceByParent.delete(parentThreadId)
    this.restoreGenerationByParent.delete(parentThreadId)
    const restoreDirectoryIncarnation =
      this.restoreDirectoryIncarnationByParent.get(parentThreadId)
    if (restoreDirectoryIncarnation) {
      this.restoreIndexStore.tombstoneDirectoryIncarnation(restoreDirectoryIncarnation)
      this.restoreDirectoryIncarnationByParent.delete(parentThreadId)
    }
    this.parentCacheLru.delete(parentThreadId)
  }

  private getWorker(
    parentThreadId: string,
    workerId: string,
    options: WorkerRestoreOptions = {}
  ): CoordinatorWorkerRecord | undefined {
    const normalizedParentThreadId = normalizeThreadId(parentThreadId)
    const normalizedWorkerId = normalizeWorkerId(workerId)
    const existing = this.getParentMap(normalizedParentThreadId)?.get(normalizedWorkerId)
    if (existing) return existing
    return this.restorePrunedWorkerFromSnapshot(
      normalizedParentThreadId,
      normalizedWorkerId,
      options
    )
  }

  private restorePrunedWorkerFromSnapshot(
    parentThreadId: string,
    workerId: string,
    options: WorkerRestoreOptions = {}
  ): CoordinatorWorkerRecord | undefined {
    const snapshot = this.getPrunedSnapshotMap(parentThreadId)?.get(workerId)
    if (!snapshot) return undefined
    const workspacePath = this.workspacePathByParent.get(parentThreadId)
    if (!workspacePath) return undefined
    const record = this.recordFromSnapshot(snapshot, workspacePath)
    if (!record || record.parentThreadId !== parentThreadId || record.workerId !== workerId) {
      return undefined
    }
    if (options.cache === false) {
      return record
    }
    this.getPrunedSnapshotMap(parentThreadId)?.delete(workerId)
    this.parentMap(parentThreadId).set(workerId, record)
    this.pruneInMemoryWorkerHistory(parentThreadId, {
      preserveWorkerId: options.preserveWorkerId ?? workerId
    })
    return record
  }

  private async restoreWorkerFromDisk(
    parentThreadId: string,
    workerId: string,
    options: WorkerRestoreOptions = {}
  ): Promise<CoordinatorWorkerRecord | undefined> {
    const workspacePath = this.workspacePathByParent.get(parentThreadId)
    if (!workspacePath) return undefined
    const statePath = path.resolve(
      workspacePath,
      COORDINATOR_BASE_DIR,
      parentThreadId,
      "workers",
      `${workerId}.json`
    )
    try {
      const snapshot = JSON.parse(
        await readFile(statePath, "utf8")
      ) as Partial<CoordinatorWorkerSnapshot>
      const record = this.recordFromSnapshot(snapshot, workspacePath)
      if (!record || record.parentThreadId !== parentThreadId || record.workerId !== workerId) {
        return undefined
      }
      if (options.cache === false) {
        return record
      }
      this.parentMap(parentThreadId).set(workerId, record)
      this.pruneInMemoryWorkerHistory(parentThreadId, {
        preserveWorkerId: options.preserveWorkerId ?? workerId
      })
      return record
    } catch {
      return undefined
    }
  }

  private async hydrateRestoredRawText(
    record: CoordinatorWorkerRecord,
    signal?: AbortSignal,
    persistChanges = true
  ): Promise<void> {
    if (record.rawText?.trim() || !record.resultPath || !terminalStatus(record.status)) return
    const workspaceRoot = path.resolve(record.workspacePath)
    try {
      throwIfRestoreAborted(signal)
      const resolvedRelativePath = resolveWorkerResultReadRelativePath(
        record.parentThreadId,
        record.resultPath
      )
      const target = path.resolve(workspaceRoot, resolvedRelativePath)
      if (!isCoordinatorPathWithin(target, workspaceRoot)) return
      const boundedResult = await readBoundedWorkerState(
        target,
        RESTORE_STATE_FILE_MAX_BYTES,
        signal
      )
      if (!boundedResult) return
      const persisted = JSON.parse(boundedResult.raw) as { raw_text?: unknown }
      const rawText = optionalString(persisted.raw_text)
      if (rawText) {
        record.rawText = truncateWorkerRawText(rawText)
        if (persistChanges && record.notificationAcknowledged === false) {
          await this.queuePersistWorkerState(record)
        }
      }
    } catch {
      if (signal?.aborted) throwIfRestoreAborted(signal)
      // Best-effort restore only. If archived raw handoff content is unavailable, notification
      // rebuilding still falls back to summary/error.
    }
  }

  private async getWorkerForOperation(
    parentThreadId: string,
    workerId: string,
    options: WorkerRestoreOptions = {}
  ): Promise<CoordinatorWorkerRecord | undefined> {
    const normalizedParentThreadId = normalizeThreadId(parentThreadId)
    const normalizedWorkerId = normalizeWorkerId(workerId)
    const existing = this.getWorker(normalizedParentThreadId, normalizedWorkerId, options)
    if (existing) return existing
    return this.restoreWorkerFromDisk(normalizedParentThreadId, normalizedWorkerId, options)
  }

  private async restoreNextOverflowPageAfterAcknowledgement(
    parentThreadId: string
  ): Promise<void> {
    const workspacePath = this.restoreOverflowWorkspaceByParent.get(parentThreadId)
    if (!workspacePath) return
    const bufferedUnresolved = Array.from(this.getParentMap(parentThreadId)?.values() ?? []).some(
      (record) => record.status === "running" || record.notificationAcknowledged === false
    )
    if (bufferedUnresolved) return
    try {
      await this.restoreWorkersForThread({
        parentThreadId,
        workspacePath,
        mode: "active"
      })
    } catch (error) {
      console.warn("[CoordinatorWorker] Failed to restore the next overflow page:", error)
    }
  }

  private isRepairableRestoredNotification(record: CoordinatorWorkerRecord): boolean {
    return (
      terminalStatus(record.status) &&
      record.notificationAcknowledged === false &&
      record.notificationEnqueued !== true &&
      !record.notificationEnqueuePromise &&
      !record.currentRun &&
      !record.terminalPersistPromise &&
      !record.statePersistPromise &&
      !record.discarded
    )
  }

  private async publishRepairableRestoredNotifications(
    records: readonly CoordinatorWorkerRecord[]
  ): Promise<void> {
    const deduped = new Map<string, CoordinatorWorkerRecord>()
    for (const record of records) {
      if (this.isRepairableRestoredNotification(record)) {
        deduped.set(record.workerId, record)
      }
    }
    await settleInBatches(
      Array.from(deduped.values()),
      RESTORED_RAW_TEXT_HYDRATE_CONCURRENCY,
      async (record) => {
        await this.hydrateRestoredRawText(record)
        if (!this.isRepairableRestoredNotification(record)) return
        this.emitUpdate(record, await this.enqueueNotification(record))
      }
    )
  }

  private assertCanRunWorker(input: {
    parentThreadId: string
    workspacePath: string
    role: CoordinatorWorkerRole
    workload: CoordinatorWorkerWorkload
    ownedFiles: string[]
    workerIdToIgnore?: string
  }): void {
    if (this.shuttingDown) {
      throw new Error("The application is quitting; a coordinator worker can no longer be started.")
    }
    const records = Array.from(this.getParentMap(input.parentThreadId)?.values() ?? [])
    const unresolvedCount = records.filter((record) => {
      if (record.workerId === input.workerIdToIgnore) return false
      return record.status === "running" || record.notificationAcknowledged === false
    }).length
    if (
      this.restoreOverflowWorkspaceByParent.has(input.parentThreadId) ||
      unresolvedCount >= MAX_COORDINATOR_UNRESOLVED_WORKERS
    ) {
      throw new Error(
        `Cannot start another coordinator worker while ${MAX_COORDINATOR_UNRESOLVED_WORKERS} worker results are still running or awaiting acknowledgement. Wait for their task-notifications first.`
      )
    }
    if (input.workload === "read_only") return
    if (input.workload === "verify") {
      const writer = records.find((record) => {
        if (record.workerId === input.workerIdToIgnore) return false
        return this.occupiesWorkerConcurrencySlot(record) && record.workload === "write"
      })
      if (!writer) return
      const writerScope =
        writer.ownedFiles.length > 0
          ? `owned_files=${writer.ownedFiles.join(", ")}`
          : "unspecified files"
      throw new Error(
        `Cannot start verify worker yet: running write worker ${writer.workerId} already owns ${writerScope}. Wait for its task-notification before independent verification.`
      )
    }

    const conflicting = records.find((record) => {
      if (record.workerId === input.workerIdToIgnore) return false
      if (!this.occupiesWorkerConcurrencySlot(record)) return false
      if (record.workload === "verify") return true
      if (record.workload !== "write") return false
      return ownedFilesOverlap(record.ownedFiles, input.ownedFiles, input.workspacePath)
    })
    if (!conflicting) return

    const scope =
      input.ownedFiles.length > 0
        ? `owned_files=${input.ownedFiles.join(", ")}`
        : "unspecified files"
    const otherScope =
      conflicting.ownedFiles.length > 0
        ? `owned_files=${conflicting.ownedFiles.join(", ")}`
        : "unspecified files"
    if (conflicting.workload === "verify") {
      throw new Error(
        `Cannot start write worker yet: running verifier worker ${conflicting.workerId} is validating the current workspace. Wait for its task-notification before starting file-changing work.`
      )
    }
    throw new Error(
      `Cannot start write worker yet: running worker ${conflicting.workerId} already owns ${otherScope}. Requested ${scope}. Wait for its task-notification or use continue_worker on that worker.`
    )
  }

  private recordFromSnapshot(
    snapshot: Partial<CoordinatorWorkerSnapshot>,
    workspacePath: string,
    onUpdate?: CoordinatorWorkerUpdateCallback,
    onUpdateKey?: string
  ): CoordinatorWorkerRecord | undefined {
    const workerId = optionalString(snapshot.worker_id)
    const workerThreadId = optionalString(snapshot.worker_thread_id)
    const parentThreadId = optionalString(snapshot.parent_thread_id)
    const role = snapshot.role
    const status = normalizeWorkerStatus(snapshot.status)
    const workload = normalizeWorkload(snapshot.workload)
    const baseWorkload = normalizeWorkload(snapshot.base_workload)
    const description = optionalString(snapshot.description)
    const createdAt = optionalString(snapshot.created_at)
    const updatedAt = optionalString(snapshot.updated_at)
    const lastEvent = optionalString(snapshot.last_event)
    const notificationAcknowledged =
      typeof snapshot.notification_acknowledged === "boolean"
        ? snapshot.notification_acknowledged
        : status
          ? terminalStatus(status)
          : false
    const suppressNotificationAutoRun = snapshot.suppress_notification_auto_run === true

    if (
      !workerId ||
      !workerThreadId ||
      !parentThreadId ||
      !role ||
      !status ||
      !description ||
      !createdAt ||
      !updatedAt ||
      !lastEvent
    ) {
      return undefined
    }

    const normalizedWorkerId = normalizeWorkerId(workerId)
    const normalizedParentThreadId = normalizeThreadId(parentThreadId)
    if (
      workerThreadId !==
      `${normalizedParentThreadId}${WORKER_THREAD_DELIMITER}${normalizedWorkerId}`
    ) {
      return undefined
    }
    const normalizedRole = normalizeWorkerRole(role)
    const normalizedWorkload = normalizeWorkerWorkload(normalizedRole, workload)

    const record: CoordinatorWorkerRecord = {
      workerId: normalizedWorkerId,
      workerThreadId,
      parentThreadId: normalizedParentThreadId,
      workspacePath,
      restoreDirectoryIncarnation: this.getOrCreateRestoreDirectoryIncarnation(
        normalizedParentThreadId,
        workspacePath
      ),
      role: normalizedRole,
      workload: normalizedWorkload,
      baseWorkload: normalizeWorkerWorkload(normalizedRole, baseWorkload ?? normalizedWorkload),
      ownedFiles: normalizeOwnedFiles(snapshot.owned_files, workspacePath),
      description,
      status,
      turns: Math.max(1, numericValue(snapshot.turns, 1)),
      createdAt,
      updatedAt,
      lastStartedAt: optionalString(snapshot.last_started_at),
      lastActivityAt: optionalString(snapshot.last_activity_at),
      finishedAt: optionalString(snapshot.finished_at),
      summary: optionalString(snapshot.summary),
      error: optionalString(snapshot.error),
      reportPath: normalizeWorkerArtifactPath(snapshot.report_path, normalizedParentThreadId),
      resultPath: normalizeWorkerArtifactPath(snapshot.result_path, normalizedParentThreadId),
      transcriptPath: normalizeWorkerArtifactPath(
        snapshot.transcript_path,
        normalizedParentThreadId
      ),
      selectedSkill: parseSelectedSkill(snapshot.selected_skill),
      tokenUsage: parseTokenUsage(snapshot.token_usage),
      toolCallCount: numericValue(snapshot.tool_call_count, 0),
      lastToolName: optionalString(snapshot.last_tool_name),
      lastEvent,
      rawText: truncateWorkerRawText(optionalString(snapshot.notification_raw_text)),
      notificationMessage: undefined,
      notificationEnqueued: terminalStatus(status) && notificationAcknowledged,
      notificationAcknowledged,
      suppressNotificationAutoRun,
      runVersion: 0
    }
    record.notificationMessage = this.validatePersistedNotificationMessage(
      record,
      optionalString(snapshot.notification_message)
    )
    this.setUpdateCallback(record, onUpdate, onUpdateKey)
    return record
  }

  private setUpdateCallback(
    record: CoordinatorWorkerRecord,
    onUpdate?: CoordinatorWorkerUpdateCallback,
    onUpdateKey = DEFAULT_WORKER_UPDATE_CALLBACK_KEY
  ): void {
    if (!onUpdate) return
    if (!record.onUpdateCallbacks) {
      record.onUpdateCallbacks = new Map()
    }
    record.onUpdateCallbacks.set(onUpdateKey, onUpdate)
  }

  private clearUpdateCallbacks(record: CoordinatorWorkerRecord): void {
    record.onUpdateCallbacks?.clear()
    record.onUpdateCallbacks = undefined
  }

  private readWorkerRecords(parentThreadId: string, workerId?: string): CoordinatorWorkerRecord[] {
    if (workerId) {
      const record = this.getWorker(parentThreadId, workerId, { cache: false })
      return record ? [record] : []
    }
    return Array.from(this.getParentMap(parentThreadId)?.values() ?? [])
  }

  private async readWorkerRecordsAsync(
    parentThreadId: string,
    workerId?: string
  ): Promise<CoordinatorWorkerRecord[]> {
    if (workerId) {
      const record = await this.getWorkerForOperation(parentThreadId, workerId, { cache: false })
      return record ? [record] : []
    }
    return this.readWorkerRecords(parentThreadId)
  }

  private pruneInMemoryWorkerHistory(
    parentThreadId: string,
    options: { preserveWorkerId?: string } = {}
  ): void {
    const normalized = normalizeThreadId(parentThreadId)
    const records = this.getParentMap(normalized)
    if (!records || records.size <= MAX_COORDINATOR_WORKERS_IN_MEMORY) return

    const prunable = Array.from(records.values())
      .filter((record) => this.canPruneWorkerRecord(record))
      .sort((a, b) => safeTimestamp(b.updatedAt) - safeTimestamp(a.updatedAt))
    const removeCount = records.size - MAX_COORDINATOR_WORKERS_IN_MEMORY
    if (removeCount <= 0 || prunable.length === 0) return

    const normalizedPreserveWorkerId = options.preserveWorkerId
      ? normalizeWorkerId(options.preserveWorkerId)
      : undefined
    const removable = normalizedPreserveWorkerId
      ? prunable.filter((record) => record.workerId !== normalizedPreserveWorkerId)
      : prunable

    for (const record of removable.slice(-removeCount)) {
      records.delete(record.workerId)
      this.prunedSnapshotMap(normalized).set(record.workerId, toPersistedWorkerState(record))
      record.discarded = true
      this.clearUpdateCallbacks(record)
      this.clearProgressUpdateTimer(record)
    }
    this.prunePrunedSnapshotHistory(normalized)
  }

  private canPruneWorkerRecord(record: CoordinatorWorkerRecord): boolean {
    return (
      terminalStatus(record.status) &&
      record.notificationAcknowledged === true &&
      !record.currentRun &&
      !record.terminalPersistPromise &&
      !record.statePersistPromise &&
      !record.notificationEnqueuePromise &&
      !record.progressUpdateTimer
    )
  }

  private occupiesWorkerConcurrencySlot(record: CoordinatorWorkerRecord): boolean {
    return record.status === "running" || Boolean(record.currentRun)
  }

  private prunedSnapshotMap(parentThreadId: string): Map<string, CoordinatorWorkerSnapshot> {
    const normalized = normalizeThreadId(parentThreadId)
    let snapshots = this.prunedSnapshotsByParent.get(normalized)
    if (!snapshots) {
      snapshots = new Map()
      this.prunedSnapshotsByParent.set(normalized, snapshots)
    }
    return snapshots
  }

  private getPrunedSnapshotMap(
    parentThreadId: string
  ): Map<string, CoordinatorWorkerSnapshot> | undefined {
    return this.prunedSnapshotsByParent.get(normalizeThreadId(parentThreadId))
  }

  private prunePrunedSnapshotHistory(parentThreadId: string): void {
    const normalized = normalizeThreadId(parentThreadId)
    const snapshots = this.prunedSnapshotsByParent.get(normalized)
    if (!snapshots || snapshots.size <= MAX_COORDINATOR_PRUNED_SNAPSHOTS_IN_MEMORY) return

    const entriesByRecency = Array.from(snapshots.entries()).sort(
      (left, right) => safeTimestamp(right[1].updated_at) - safeTimestamp(left[1].updated_at)
    )
    for (const [workerId] of entriesByRecency.slice(MAX_COORDINATOR_PRUNED_SNAPSHOTS_IN_MEMORY)) {
      snapshots.delete(workerId)
    }
    if (snapshots.size === 0) {
      this.prunedSnapshotsByParent.delete(normalized)
    }
  }

  private cancelRecord(
    record: CoordinatorWorkerRecord,
    reason: string,
    suppressNotificationAutoRun = false,
    dismissNotificationOnTerminalPersist = false
  ): void {
    if (record.status !== "running") return
    record.abortController?.abort(new DOMException(reason, "AbortError"))
    const timestamp = nowIso()
    record.status = "cancelled"
    record.notificationAcknowledged = false
    record.suppressNotificationAutoRun = suppressNotificationAutoRun
    record.updatedAt = timestamp
    record.finishedAt = timestamp
    record.error = reason
    record.lastEvent = reason
    record.lastActivityAt = timestamp
    record.dismissNotificationOnTerminalPersist = dismissNotificationOnTerminalPersist
    void this.persistTerminalAndNotify(record)
  }

  setWorkerApprovalProbe(probe: (workerThreadId: string) => boolean): void {
    this.workerApprovalProbe = probe
  }

  private ensureWorkerWatchdog(): void {
    if (this.workerWatchdogTimer || this.shuttingDown) return
    const timer = setInterval(() => this.sweepInactiveWorkers(), WORKER_WATCHDOG_TICK_MS)
    // Never keep the process alive for the watchdog alone.
    timer.unref?.()
    this.workerWatchdogTimer = timer
  }

  private stopWorkerWatchdog(): void {
    if (!this.workerWatchdogTimer) return
    clearInterval(this.workerWatchdogTimer)
    this.workerWatchdogTimer = undefined
  }

  /** One watchdog pass: cancel running workers with no activity inside the
   * inactivity window. A worker blocked on a pending user approval is WAITING,
   * not hung — its idle clock is reset instead (mirrors the workflow engine's
   * isAwaitingApproval exemption, so an absent user's approval prompt can sit
   * for hours without the watchdog killing the worker). Termination reuses
   * cancelRecord — the exact terminal path the parent-abort case already
   * exercises: best-effort abort, terminal status, persistTerminalAndNotify —
   * so the notification turn fires and everything downstream (coordinator
   * report, goal defer guard) unblocks through the existing machinery.
   * Public with an injectable clock so tests can drive a pass directly. */
  sweepInactiveWorkers(nowMs: number = Date.now()): void {
    if (this.shuttingDown) {
      this.stopWorkerWatchdog()
      return
    }
    const windowMs = getCoordinatorWorkerInactivityMs()
    let hasRunning = false
    for (const records of this.workersByParent.values()) {
      for (const record of records.values()) {
        if (record.discarded || record.status !== "running") continue
        hasRunning = true
        if (this.workerApprovalProbe?.(record.workerThreadId)) {
          record.lastActivityAt = nowIso()
          continue
        }
        if (isWorkerInactiveForWatchdog(record, nowMs, windowMs)) {
          const idleMinutes = Math.round(windowMs / 60_000)
          console.warn(
            `[CoordinatorWorker] Inactivity watchdog terminating worker ${record.workerId} (parent ${record.parentThreadId}): no activity for over ${idleMinutes} minutes.`
          )
          this.cancelRecord(
            record,
            `Worker terminated by inactivity watchdog: no activity for over ${idleMinutes} minutes (likely hung).`
          )
          // A watchdog-targeted run may NEVER settle (that is the scenario the
          // watchdog exists for), so the run promise's own finally cannot be
          // relied on to clear ownership. Release it here: a later-waking zombie
          // sees isCurrentRun() false (its currentRun identity is gone) and
          // returns without touching the record, and occupiesWorkerConcurrencySlot
          // stops counting the corpse — otherwise a hung write/verify worker
          // would block that concurrency lane forever even after cancellation.
          // cancelRecord already aborted the controller before this clear.
          // TRADEOFF (intentional): if the aborted runner IGNORES the signal (e.g.
          // an unkillable child process still writing files), releasing the lane
          // here lets a new write/verify worker or auto-commit run alongside that
          // zombie. We accept it: the alternative — hold the lane until the runner
          // truly settles — reintroduces the exact permanent-block this watchdog
          // exists to break (a runner that never settles never frees the lane). A
          // grace period would only shift, not remove, the overlap; the real cure
          // is forceful child-process termination on abort, which is out of scope
          // here. A worker only reaches the watchdog after the full inactivity
          // window with NO progress event, so an ACTIVELY-writing worker (its tool
          // calls emit events → lastActivityAt refreshes) is not a candidate; the
          // residual is a silent-for-hours-then-writes runner, which is rare.
          record.currentRun = undefined
          record.abortController = undefined
        }
      }
    }
    if (!hasRunning) this.stopWorkerWatchdog()
  }

  private launch(
    record: CoordinatorWorkerRecord,
    prompt: string,
    runner: CoordinatorWorkerRunner,
    parentSignal?: AbortSignal
  ): void {
    this.ensureWorkerWatchdog()
    const abortController = new AbortController()
    record.abortController = abortController
    record.runVersion += 1
    const runVersion = record.runVersion
    const workerTurn = record.turns

    if (parentSignal?.aborted) {
      const timestamp = nowIso()
      record.status = "cancelled"
      record.notificationAcknowledged = false
      record.updatedAt = timestamp
      record.lastActivityAt = timestamp
      record.finishedAt = timestamp
      record.error = abortReason(parentSignal)
      record.lastEvent = "Worker cancelled before start because parent run was aborted."
      void this.persistTerminalAndNotify(record)
      return
    }
    const onParentAbort = (): void => {
      this.cancelRecord(record, parentSignal ? abortReason(parentSignal) : "Parent run aborted")
    }
    parentSignal?.addEventListener("abort", onParentAbort, { once: true })

    const runPromise = (async () => {
      const isCurrentRun = (): boolean =>
        record.runVersion === runVersion && record.currentRun === runPromise
      try {
        await this.queuePersistWorkerState(record)
        if (!isCurrentRun()) return
        if (abortController.signal.aborted || record.status !== "running") {
          throw abortController.signal.reason ?? new DOMException("Worker cancelled.", "AbortError")
        }
        const result = await runner({
          parentThreadId: record.parentThreadId,
          workerId: record.workerId,
          workerThreadId: record.workerThreadId,
          workerTurn,
          role: record.role,
          workload: record.workload,
          ownedFiles: record.ownedFiles,
          description: record.description,
          prompt,
          workspacePath: record.workspacePath,
          abortSignal: abortController.signal,
          onProgress: (event) => {
            if (!isCurrentRun()) return
            this.recordProgress(record, event)
          }
        })

        if (!isCurrentRun()) return
        const timestamp = nowIso()
        if (abortController.signal.aborted) {
          record.status = "cancelled"
          record.notificationAcknowledged = false
          record.error = record.error ?? abortReason(abortController.signal)
          record.lastEvent = record.error
        } else {
          record.status = "completed"
          record.notificationAcknowledged = false
          record.summary = result.summary
          record.reportPath = normalizeWorkerArtifactPath(result.reportPath, record.parentThreadId)
          record.rawText = truncateWorkerRawText(result.rawText)
          const currentRunUsage = mergeTokenUsage(record.currentRunTokenUsage, result.tokenUsage)
          record.tokenUsage = record.previousTokenUsage
            ? addTokenUsage(record.previousTokenUsage, currentRunUsage)
            : mergeTokenUsage(record.tokenUsage, currentRunUsage)
          record.previousTokenUsage = record.tokenUsage
          record.currentRunTokenUsage = undefined
          record.error = undefined
          record.lastEvent = "Worker completed."
        }
        record.updatedAt = timestamp
        record.lastActivityAt = timestamp
        record.finishedAt = timestamp
      } catch (error) {
        if (!isCurrentRun()) return
        const timestamp = nowIso()
        const message = describeError(error)
        const shouldCancel = abortController.signal.aborted || isAbortLike(error)
        if (record.status !== "cancelled") {
          record.status = shouldCancel ? "cancelled" : "failed"
          record.notificationAcknowledged = false
          record.error = shouldCancel ? abortReason(abortController.signal) : message
        }
        record.updatedAt = timestamp
        record.lastActivityAt = timestamp
        record.finishedAt = timestamp
        record.lastEvent =
          record.status === "cancelled" ? (record.error ?? "Worker cancelled.") : "Worker failed."
      } finally {
        parentSignal?.removeEventListener("abort", onParentAbort)
        if (isCurrentRun()) {
          record.abortController = undefined
          record.currentRun = undefined
          if (!record.discarded) {
            if (record.terminalPersistPromise || record.notificationEnqueued) {
              this.emitUpdate(record)
            } else {
              await this.persistTerminalAndNotify(record)
            }
          }
        }
      }
    })()
    record.currentRun = runPromise
  }

  private persistTerminalAndNotify(record: CoordinatorWorkerRecord): Promise<void> {
    if (record.discarded) return Promise.resolve()
    if (record.terminalPersistPromise) return record.terminalPersistPromise
    const persistPromise = (async () => {
      try {
        await this.waitForStatePersist(record)
        record.notificationAcknowledged = false
        await this.persistTerminalRecord(record)
      } catch (persistError) {
        const timestamp = nowIso()
        const message = describeError(persistError)
        const persistenceFailure = formatWorkerResultPersistenceFailure(message)
        const persistedResultPath = persistedResultPathFromError(persistError)
        if (record.status === "completed") {
          record.status = "failed"
          if (record.summary) {
            record.summary = `${record.summary}\n\n${persistenceFailure}`
          }
          record.error = persistenceFailure
        } else if (record.error) {
          if (!record.error.includes(persistenceFailure)) {
            record.error = `${record.error}\n\n${persistenceFailure}`
          }
        } else {
          record.error = persistenceFailure
        }
        record.resultPath = persistedResultPath
        record.updatedAt = timestamp
        record.finishedAt = record.finishedAt ?? timestamp
        record.lastActivityAt = timestamp
        record.lastEvent = persistenceFailure
        console.warn("[CoordinatorWorker] Failed to persist terminal state:", persistError)
        try {
          await this.persistWorkerState(record)
        } catch (statePersistError) {
          console.warn(
            "[CoordinatorWorker] Failed to persist terminal failure state:",
            statePersistError
          )
        }
      }
      if (record.dismissNotificationOnTerminalPersist && terminalStatus(record.status)) {
        // Explicit background-worker stop is a user dismissal signal, not normal
        // notification-first coordinator work. Persist the terminal worker state,
        // then settle the notification immediately so the thread is not left in a
        // suppressed-but-unacknowledged coordinator limbo.
        record.dismissNotificationOnTerminalPersist = false
        record.notificationAcknowledged = true
        record.notificationEnqueued = true
        record.suppressNotificationAutoRun = false
        record.notificationMessage = undefined
        this.removeQueuedNotificationsForWorker(record.parentThreadId, {
          workerId: record.workerId,
          turn: record.turns
        })
        try {
          await this.persistWorkerState(record)
        } catch (statePersistError) {
          console.warn(
            "[CoordinatorWorker] Failed to persist dismissed terminal notification state:",
            statePersistError
          )
        }
        this.emitUpdate(record)
        return
      }
      const notificationTurn = record.turns
      const notificationStatus = record.status
      const notification = await this.enqueueNotification(record)
      if (record.turns !== notificationTurn || record.status !== notificationStatus) {
        return
      }
      this.emitUpdate(record, notification)
    })().finally(() => {
      if (record.terminalPersistPromise === persistPromise) {
        record.terminalPersistPromise = undefined
      }
    })
    record.terminalPersistPromise = persistPromise
    return persistPromise
  }

  private recordProgress(
    record: CoordinatorWorkerRecord,
    event: CoordinatorWorkerProgressEvent
  ): void {
    if (record.discarded || record.status !== "running") return
    if (event.type === "stream") {
      const timestamp = nowIso()
      record.updatedAt = timestamp
      record.lastActivityAt = timestamp
      this.emitUpdate(record, undefined, event.stream)
      this.scheduleProgressUpdate(record)
      return
    }
    if (event.type === "usage") {
      record.currentRunTokenUsage = mergeTokenUsage(record.currentRunTokenUsage, event.usage)
      const nextUsage = record.previousTokenUsage
        ? addTokenUsage(record.previousTokenUsage, record.currentRunTokenUsage)
        : mergeTokenUsage(record.tokenUsage, event.usage)
      if (tokenUsageEquals(record.tokenUsage, nextUsage)) return
      record.tokenUsage = nextUsage
      const timestamp = nowIso()
      record.updatedAt = timestamp
      record.lastActivityAt = timestamp
      this.scheduleProgressUpdate(record)
      return
    }
    const timestamp = nowIso()
    record.updatedAt = timestamp
    record.lastActivityAt = timestamp
    if (event.type === "tool_call") {
      record.toolCallCount += 1
      record.lastToolName = event.toolName ?? record.lastToolName
      record.lastEvent = event.toolName
        ? `Worker called tool: ${event.toolName}`
        : "Worker called a tool."
    } else if (event.message) {
      record.lastEvent = event.message
    }
    this.scheduleProgressUpdate(record)
  }

  private clearProgressUpdateTimer(record: CoordinatorWorkerRecord): void {
    if (!record.progressUpdateTimer) return
    clearTimeout(record.progressUpdateTimer)
    record.progressUpdateTimer = undefined
  }

  private scheduleProgressUpdate(record: CoordinatorWorkerRecord): void {
    const now = Date.now()
    const elapsedMs = now - (record.lastProgressUpdateAt ?? 0)
    if (!record.progressUpdateTimer && elapsedMs >= PROGRESS_UPDATE_THROTTLE_MS) {
      this.flushProgressUpdate(record).catch((error) => {
        console.warn("[CoordinatorWorker] Failed to persist progress state:", error)
      })
      return
    }
    if (record.progressUpdateTimer) return
    const delayMs = Math.max(1, PROGRESS_UPDATE_THROTTLE_MS - elapsedMs)
    record.progressUpdateTimer = setTimeout(() => {
      record.progressUpdateTimer = undefined
      this.flushProgressUpdate(record).catch((error) => {
        console.warn("[CoordinatorWorker] Failed to persist throttled progress state:", error)
      })
    }, delayMs)
  }

  private async flushProgressUpdate(record: CoordinatorWorkerRecord): Promise<void> {
    this.clearProgressUpdateTimer(record)
    if (record.discarded || record.status !== "running") return
    record.lastProgressUpdateAt = Date.now()
    this.emitUpdate(record)
    await this.queuePersistWorkerState(record)
  }

  private queuePersistWorkerState(record: CoordinatorWorkerRecord): Promise<void> {
    const previous = record.statePersistPromise?.catch(() => undefined) ?? Promise.resolve()
    const next = previous
      .then(() => {
        if (record.discarded) return
        return this.persistWorkerState(record)
      })
      .finally(() => {
        if (record.statePersistPromise === next) {
          record.statePersistPromise = undefined
        }
      })
    record.statePersistPromise = next
    return next
  }

  private async waitForStatePersist(record: CoordinatorWorkerRecord): Promise<void> {
    try {
      await this.flushProgressUpdate(record)
      await record.statePersistPromise
    } catch {
      // Progress persistence is best-effort; terminal state persistence below is authoritative.
    }
  }

  private enqueueNotification(record: CoordinatorWorkerRecord): Promise<string | undefined> {
    if (record.notificationEnqueued) return Promise.resolve(undefined)
    if (record.notificationEnqueuePromise) return record.notificationEnqueuePromise

    const enqueuePromise = (async () => {
      record.notificationAcknowledged = false
      const notification =
        this.validatePersistedNotificationMessage(record, record.notificationMessage) ??
        this.formatNotification(record)
      record.notificationMessage = notification
      try {
        await this.queuePersistWorkerState(record)
      } catch (error) {
        console.warn("[CoordinatorWorker] Failed to persist queued notification state:", error)
      }
      if (record.discarded) return undefined

      // Do not publish a notification before its state/index write has settled. Consumers may
      // immediately delete or switch the task after observing it; publishing first allowed the
      // queued restore-index atomic write to recreate the just-removed worker directory.
      record.notificationEnqueued = true
      const notifications = this.notificationsByParent.get(record.parentThreadId) ?? []
      notifications.push(notification)
      this.notificationsByParent.set(record.parentThreadId, notifications)
      this.touchParentCache(record.parentThreadId)
      this.onTerminalNotification?.(toSnapshot(record))
      return notification
    })().finally(() => {
      if (record.notificationEnqueuePromise === enqueuePromise) {
        record.notificationEnqueuePromise = undefined
      }
    })
    record.notificationEnqueuePromise = enqueuePromise
    return enqueuePromise
  }

  private removeQueuedNotificationsForWorker(parentThreadId: string, ref: NotificationRef): void {
    const notifications = this.notificationsByParent.get(parentThreadId)
    if (!notifications?.length) return
    const remaining = notifications.filter((notification) => {
      const workerId = this.extractNotificationWorkerId(notification)
      if (workerId !== ref.workerId) return true
      const turn = this.extractNotificationWorkerTurn(notification)
      if (ref.turn === undefined) return false
      return turn !== ref.turn
    })
    if (remaining.length === 0) {
      this.notificationsByParent.delete(parentThreadId)
      this.touchParentCache(parentThreadId)
      return
    }
    this.notificationsByParent.set(parentThreadId, remaining)
    this.touchParentCache(parentThreadId)
  }

  private shouldRestoreNotification(parentThreadId: string, notification: string): boolean {
    const workerId = this.extractNotificationWorkerId(notification)
    if (!workerId) return true
    const record = this.getParentMap(parentThreadId)?.get(workerId)
    if (!record) return true
    const notificationTurn = this.extractNotificationWorkerTurn(notification)
    // If the worker has been continued, an older terminal notification is stale even when
    // the newer run has already completed and queued its own notification.
    if (notificationTurn !== undefined && notificationTurn !== record.turns) return false
    return record.status !== "running"
  }

  private validatePersistedNotificationMessage(
    record: CoordinatorWorkerRecord,
    notification: string | undefined
  ): string | undefined {
    const normalized = notification?.trim()
    if (!normalized) return undefined
    if (normalized.length > MAX_NOTIFICATION_XML_CHARS) return undefined
    const fields = this.extractNotificationTopLevelFields(normalized)
    if (!fields || !fields.has("status") || !fields.has("summary")) return undefined
    const workerId = fields.get("task-id")
    const turnValue = fields.get("turn")
    const turn = turnValue ? Number(turnValue) : undefined
    const status = fields.get("status")
    const role = fields.get("worker-role")
    const workerThreadId = fields.get("worker-thread-id")
    if (workerId !== record.workerId) return undefined
    if (!Number.isFinite(turn) || turn !== record.turns) return undefined
    if (status !== normalizeNotificationStatus(record.status)) return undefined
    if (role !== record.role) return undefined
    if (workerThreadId !== record.workerThreadId) return undefined
    return this.serializeValidatedPersistedNotification(record, fields)
  }

  private extractNotificationWorkerId(notification: string): string | undefined {
    return this.extractNotificationTagValue(notification, "task-id")
  }

  private extractNotificationWorkerTurn(notification: string): number | undefined {
    const value = this.extractNotificationTagValue(notification, "turn")
    if (!value) return undefined
    const turn = Number(value)
    return Number.isFinite(turn) ? turn : undefined
  }

  private extractNotificationTagValue(notification: string, tag: string): string | undefined {
    return this.extractNotificationTopLevelFields(notification)?.get(tag)
  }

  private extractNotificationTopLevelFields(notification: string): Map<string, string> | undefined {
    return this.extractXmlDirectFields(
      notification,
      "task-notification",
      PERSISTED_NOTIFICATION_TOP_LEVEL_TAGS
    )
  }

  private extractXmlDirectFields(
    xml: string,
    rootTag: string,
    allowedTags?: ReadonlySet<string>
  ): Map<string, string> | undefined {
    const normalized = xml.trim()
    const rootOpen = `<${rootTag}>`
    const rootClose = `</${rootTag}>`
    if (!normalized.startsWith(rootOpen) || !normalized.endsWith(rootClose)) {
      return undefined
    }

    const inner = normalized.slice(rootOpen.length, -rootClose.length)
    const fields = new Map<string, string>()
    let index = 0

    while (index < inner.length) {
      while (index < inner.length && /\s/u.test(inner[index])) index += 1
      if (index >= inner.length) break

      const opening = /^<([A-Za-z0-9_-]+)>/.exec(inner.slice(index))
      if (!opening) return undefined
      const tag = opening[1]
      if (allowedTags && !allowedTags.has(tag)) return undefined
      index += opening[0].length
      const valueStart = index
      let depth = 1

      while (index < inner.length) {
        const nextLt = inner.indexOf("<", index)
        if (nextLt === -1) return undefined

        const sameOpen = `<${tag}>`
        const sameClose = `</${tag}>`
        if (inner.startsWith(sameOpen, nextLt)) {
          depth += 1
          index = nextLt + sameOpen.length
          continue
        }
        if (inner.startsWith(sameClose, nextLt)) {
          depth -= 1
          if (depth === 0) {
            if (fields.has(tag)) return undefined
            fields.set(tag, decodeNotificationXmlText(inner.slice(valueStart, nextLt)))
            index = nextLt + sameClose.length
            break
          }
          index = nextLt + sameClose.length
          continue
        }
        index = nextLt + 1
      }

      if (depth !== 0) return undefined
    }

    return fields
  }

  private serializeValidatedPersistedNotification(
    record: CoordinatorWorkerRecord,
    fields: Map<string, string>
  ): string | undefined {
    const workerId = fields.get("task-id")
    const workerThreadId = fields.get("worker-thread-id")
    const workerRole = fields.get("worker-role")
    const turn = fields.get("turn")
    const status = fields.get("status")
    const summary = fields.get("summary")
    if (!workerId || !workerThreadId || !workerRole || !turn || !status || summary === undefined) {
      return undefined
    }

    const result = fields.get("result")
    const resultTruncated = fields.get("result-truncated")
    if (
      resultTruncated !== undefined &&
      resultTruncated !== "true" &&
      resultTruncated !== "false"
    ) {
      return undefined
    }
    const persistedResult = truncateNotificationResult(result, resultTruncated === "true")
    const summaryText = truncateNotificationSummary(summary)

    const snapshot = toSnapshot(record)
    const reportPath = snapshot.report_path
      ? `\n<report-path>${escapeXml(snapshot.report_path)}</report-path>`
      : ""
    const resultPath = snapshot.result_path
      ? `\n<output-file>${escapeXml(snapshot.result_path)}</output-file>\n<result-path>${escapeXml(snapshot.result_path)}</result-path>`
      : ""
    const usage = `
<usage>
  <tool_uses>${snapshot.tool_call_count}</tool_uses>
  <duration_ms>${snapshot.duration_ms ?? 0}</duration_ms>
  <input_tokens>${snapshot.token_usage?.input_tokens ?? 0}</input_tokens>
  <output_tokens>${snapshot.token_usage?.output_tokens ?? 0}</output_tokens>
  <total_tokens>${snapshot.token_usage?.total_tokens ?? 0}</total_tokens>
</usage>`

    const notification = `<task-notification>
<task-id>${escapeXml(workerId)}</task-id>
<worker-thread-id>${escapeXml(workerThreadId)}</worker-thread-id>
<worker-role>${escapeXml(workerRole)}</worker-role>
<turn>${escapeXml(turn)}</turn>
<status>${escapeXml(status)}</status>
<summary>${escapeXml(summaryText)}</summary>${
      persistedResult.text
        ? `\n<result>${escapeXml(persistedResult.text)}</result>\n<result-truncated>${String(persistedResult.truncated)}</result-truncated>`
        : resultTruncated !== undefined
          ? `\n<result-truncated>${String(persistedResult.truncated)}</result-truncated>`
          : ""
    }${reportPath}${resultPath}${usage}
</task-notification>`
    return notification.length <= MAX_NOTIFICATION_XML_CHARS ? notification : undefined
  }

  private formatNotification(record: CoordinatorWorkerRecord): string {
    const snapshot = toSnapshot(record)
    const status = normalizeNotificationStatus(snapshot.status)
    const rawText = record.rawText?.trim()
    const detailedSummary = buildNotificationDetailedSummary(snapshot)
    const resultContext = buildNotificationResultContext(snapshot, Boolean(rawText))
    const notificationSummary = buildNotificationSummary(snapshot, status, detailedSummary)
    const reportPath = snapshot.report_path
      ? `\n<report-path>${escapeXml(snapshot.report_path)}</report-path>`
      : ""
    const resultPath = snapshot.result_path
      ? `\n<output-file>${escapeXml(snapshot.result_path)}</output-file>\n<result-path>${escapeXml(snapshot.result_path)}</result-path>`
      : ""
    const isTerminalPersistenceFailure =
      status === "failed" && isWorkerResultPersistenceFailureEvent(snapshot.last_event)
    const terminalPersistenceFailureResult = isTerminalPersistenceFailure
      ? buildTerminalPersistenceFailureResultSource(resultContext, rawText)
      : undefined
    const notificationResult = terminalPersistenceFailureResult
      ? terminalPersistenceFailureResult
      : rawText
        ? buildNotificationResultSource(resultContext, rawText)
        : { text: detailedSummary }
    const result = truncateNotificationResult(
      notificationResult.text,
      notificationResult.truncated ?? false
    )
    const renderNotification = (
      resultText: string,
      resultTruncated: boolean,
      includeDebugPaths = true
    ): string => {
      const resultBlock = resultText
        ? `\n<result>${escapeXml(resultText)}</result>\n<result-truncated>${String(resultTruncated)}</result-truncated>`
        : ""
      const debugPaths = includeDebugPaths ? `${reportPath}${resultPath}` : ""
      const usage = includeDebugPaths
        ? `
<usage>
  <tool_uses>${snapshot.tool_call_count}</tool_uses>
  <duration_ms>${snapshot.duration_ms ?? 0}</duration_ms>
  <input_tokens>${snapshot.token_usage?.input_tokens ?? 0}</input_tokens>
  <output_tokens>${snapshot.token_usage?.output_tokens ?? 0}</output_tokens>
  <total_tokens>${snapshot.token_usage?.total_tokens ?? 0}</total_tokens>
</usage>`
        : ""
      return `<task-notification>
<task-id>${escapeXml(snapshot.worker_id)}</task-id>
<worker-thread-id>${escapeXml(snapshot.worker_thread_id)}</worker-thread-id>
<worker-role>${escapeXml(snapshot.role)}</worker-role>
<turn>${snapshot.turns}</turn>
<status>${escapeXml(status)}</status>
<summary>${escapeXml(truncateNotificationSummary(notificationSummary))}</summary>${resultBlock}${debugPaths}${usage}
</task-notification>`
    }
    return truncateNotificationXml(
      renderNotification,
      result.text,
      result.truncated,
      renderNotification(
        "Notification was too large to deliver inline. Continue this worker for a concise handoff if more detail is needed.",
        true,
        false
      ),
      `<task-notification>
<task-id>${escapeXml(snapshot.worker_id)}</task-id>
<worker-thread-id>${escapeXml(snapshot.worker_thread_id)}</worker-thread-id>
<worker-role>${escapeXml(snapshot.role)}</worker-role>
<turn>${snapshot.turns}</turn>
<status>${escapeXml(status)}</status>
<summary>Notification was too large to deliver inline. Continue this worker for a concise handoff if more detail is needed.</summary>
<result-truncated>true</result-truncated>
</task-notification>`
    )
  }

  private persistTerminalRecord(record: CoordinatorWorkerRecord): Promise<void> {
    return this.restoreIndexStore.runDirectoryArtifactOperation(
      record.restoreDirectoryIncarnation,
      () => this.persistTerminalRecordCurrent(record)
    )
  }

  private async persistTerminalRecordCurrent(record: CoordinatorWorkerRecord): Promise<void> {
    const assertCurrent = (): void => this.assertCurrentRestoreDirectoryIncarnation(record)
    assertCurrent()
    const target = workerResultPath(record)
    const resultPath = relativeWorkerResultPath(record)
    await mkdir(path.dirname(target), { recursive: true })
    assertCurrent()
    record.transcriptPath = undefined
    record.transcriptText = undefined
    await writeFileAtomic(
      target,
      JSON.stringify(
        {
          worker_id: record.workerId,
          worker_thread_id: record.workerThreadId,
          parent_thread_id: record.parentThreadId,
          role: record.role,
          workload: record.workload,
          base_workload: record.baseWorkload,
          owned_files: record.ownedFiles,
          description: record.description,
          status: record.status,
          turns: record.turns,
          created_at: record.createdAt,
          updated_at: record.updatedAt,
          last_started_at: record.lastStartedAt,
          last_activity_at: record.lastActivityAt,
          finished_at: record.finishedAt,
          duration_ms: durationMs(record),
          tool_call_count: record.toolCallCount,
          last_tool_name: record.lastToolName,
          last_event: record.lastEvent,
          summary: record.summary,
          error: record.error,
          report_path: record.reportPath,
          result_path: resultPath,
          token_usage: record.tokenUsage,
          raw_text: truncateWorkerRawText(record.rawText)
        },
        null,
        2
      ),
      assertCurrent
    )
    assertCurrent()
    record.resultPath = resultPath
    try {
      await this.persistWorkerState(record)
    } catch (error) {
      throw withPersistedResultPath(error, resultPath)
    }
  }

  private emitUpdate(
    record: CoordinatorWorkerRecord,
    notification?: string,
    stream?: CoordinatorWorkerUpdateEvent["stream"]
  ): void {
    if (record.discarded) return
    const callbacks = Array.from(record.onUpdateCallbacks?.values() ?? [])
    for (const callback of callbacks) {
      try {
        callback({
          worker: toSnapshot(record),
          notification,
          suppressNotificationAutoRun: notification
            ? record.suppressNotificationAutoRun
            : undefined,
          stream
        })
      } catch (error) {
        console.warn("[CoordinatorWorker] Worker update callback failed:", error)
      }
    }
  }

  private persistWorkerState(record: CoordinatorWorkerRecord): Promise<void> {
    return this.restoreIndexStore.runDirectoryArtifactOperation(
      record.restoreDirectoryIncarnation,
      () => this.persistWorkerStateCurrent(record)
    )
  }

  private async persistWorkerStateCurrent(record: CoordinatorWorkerRecord): Promise<void> {
    this.assertCurrentRestoreDirectoryIncarnation(record)
    const target = workerStatePath(record)
    await this.ensureScratchpadDirBestEffort(record)
    this.assertCurrentRestoreDirectoryIncarnation(record)
    const snapshot = toPersistedWorkerState(record)
    const indexUpdated = await this.restoreIndexStore.writeWorkerState(
      target,
      serializePersistedWorkerState(snapshot),
      snapshot,
      record.restoreDirectoryIncarnation
    )
    if (!indexUpdated) {
      // The state file is authoritative. A missing secondary index forces a cancellable worker
      // rebuild next time instead of turning a successful worker run into a failure.
      console.warn("[CoordinatorWorker] Failed to update restore index; it will be rebuilt.")
    }
  }

  private async ensureScratchpadDirBestEffort(record: CoordinatorWorkerRecord): Promise<void> {
    this.assertCurrentRestoreDirectoryIncarnation(record)
    const scratchpadPath = workerScratchpadPath(record)
    if (this.preparedScratchpadDirs.has(scratchpadPath)) return
    try {
      await mkdir(scratchpadPath, { recursive: true })
      this.assertCurrentRestoreDirectoryIncarnation(record)
      this.preparedScratchpadDirs.add(scratchpadPath)
    } catch (error) {
      this.assertCurrentRestoreDirectoryIncarnation(record)
      if (!this.warnedScratchpadDirs.has(scratchpadPath)) {
        this.warnedScratchpadDirs.add(scratchpadPath)
        console.warn(
          `[CoordinatorWorker] Failed to prepare scratchpad directory; continuing without scratchpad: ${scratchpadPath}`,
          error
        )
      }
    }
  }
}

export const coordinatorWorkerManager = new CoordinatorWorkerManager({
  onTerminalNotification: (worker) => {
    if (worker.status !== "completed" && worker.status !== "failed") return
    emitAppAttention({
      kind: worker.status === "failed" ? "task-error" : "task-complete",
      threadId: worker.parent_thread_id,
      key: `coordinator-worker:${worker.parent_thread_id}:${worker.worker_id}:${worker.turns}`
    })
  }
})

export async function deleteCoordinatorWorkerArtifacts(
  parentThreadId: string,
  workspacePath: string
): Promise<void> {
  await coordinatorWorkerManager.forgetThreadAndDeleteArtifacts(parentThreadId, workspacePath)
}
