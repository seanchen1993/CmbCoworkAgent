import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "fs/promises"
import { statSync } from "fs"
import path from "path"
import {
  coordinatorFileMatchKey,
  isCoordinatorPathWithin,
  resolveCoordinatorPath
} from "./coordinator-worker-paths"
import type { CoordinatorSelectedSkill } from "./coordinator-mode"

export type CoordinatorWorkerRole = "implementer" | "verifier"
export type CoordinatorWorkerStatus = "running" | "completed" | "failed" | "cancelled"
export type CoordinatorWorkerWorkload = "read_only" | "verify" | "write"

export interface CoordinatorWorkerTokenUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
}

export interface CoordinatorWorkerProgressEvent {
  type: "tool_call" | "activity" | "usage"
  toolName?: string
  message?: string
  usage?: CoordinatorWorkerTokenUsage
}

export interface CoordinatorWorkerUpdateEvent {
  worker: CoordinatorWorkerSnapshot
  notification?: string
  suppressNotificationAutoRun?: boolean
}

export type CoordinatorWorkerUpdateCallback = (event: CoordinatorWorkerUpdateEvent) => void

export interface CoordinatorWorkerRunInput {
  parentThreadId: string
  workerId: string
  workerThreadId: string
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
}

export interface CoordinatorWorkerResultRead {
  worker: CoordinatorWorkerSnapshot
  result_path?: string
  result_text?: string
  result_chars?: number
  result_truncated?: boolean
  transcript_path?: string
  transcript_text?: string
  transcript_chars?: number
  transcript_truncated?: boolean
  message?: string
}

interface CoordinatorWorkerRecord {
  workerId: string
  workerThreadId: string
  parentThreadId: string
  workspacePath: string
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
}

interface NotificationRef {
  workerId: string
  turn?: number
}

interface WorkerRestoreOptions {
  cache?: boolean
  preserveWorkerId?: string
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
export const MAX_COORDINATOR_WORKERS_IN_MEMORY = 80
export const MAX_COORDINATOR_PRUNED_SNAPSHOTS_IN_MEMORY = 16
const PROGRESS_UPDATE_THROTTLE_MS = 500
const ACTIVE_RESTORE_STATUS_SCAN_CHARS = 4_096
const RECENT_RESTORE_TERMINAL_LIMIT = 40
const DEFAULT_WORKER_UPDATE_CALLBACK_KEY = "default"
const WORKER_STATE_FILENAME_PATTERN =
  /^(implementer|verifier)-(?<timestamp>\d+)-(?<sequence>\d+)\.json$/i
const TERMINAL_STATUSES = new Set<CoordinatorWorkerStatus>(["completed", "failed", "cancelled"])

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
  const root = path.resolve(
    record.workspacePath,
    COORDINATOR_BASE_DIR,
    normalizeThreadId(record.parentThreadId),
    "workers"
  )
  return path.resolve(root, `${normalizeWorkerId(record.workerId)}.json`)
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

function workerTranscriptPath(record: CoordinatorWorkerRecord): string {
  const root = path.resolve(
    record.workspacePath,
    COORDINATOR_BASE_DIR,
    normalizeThreadId(record.parentThreadId),
    "reports",
    "workers",
    normalizeWorkerId(record.workerId)
  )
  return path.resolve(root, `turn-${Math.max(1, record.turns)}.transcript.jsonl`)
}

function relativeWorkerTranscriptPath(record: CoordinatorWorkerRecord): string {
  return `${COORDINATOR_BASE_DIR}/${normalizeThreadId(record.parentThreadId)}/reports/workers/${normalizeWorkerId(record.workerId)}/turn-${Math.max(1, record.turns)}.transcript.jsonl`
}

async function writeFileAtomic(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`
  )
  try {
    await writeFile(temp, content, "utf8")
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function deleteCoordinatorWorkerArtifacts(
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

function truncateNotificationResult(value: string | undefined): {
  text: string
  truncated: boolean
} {
  const trimmed = value?.trim()
  if (!trimmed) return { text: "", truncated: false }
  if (trimmed.length <= MAX_NOTIFICATION_RESULT_CHARS) {
    return { text: trimmed, truncated: false }
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

async function readWorkerStatePrefix(filePath: string): Promise<string> {
  const handle = await open(filePath, "r")
  try {
    const buffer = Buffer.alloc(ACTIVE_RESTORE_STATUS_SCAN_CHARS)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}

function extractWorkerStatusFromJsonPrefix(prefix: string): CoordinatorWorkerStatus | undefined {
  const match = /"status"\s*:\s*"(running|completed|failed|cancelled)"/.exec(prefix)
  return match?.[1] as CoordinatorWorkerStatus | undefined
}

function extractNotificationAcknowledgedFromJsonPrefix(prefix: string): boolean | undefined {
  const match = /"notification_acknowledged"\s*:\s*(true|false)/.exec(prefix)
  if (!match) return undefined
  return match[1] === "true"
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

function parseWorkerStateFilenameRecencyKey(
  file: string
): { timestamp: number; sequence: number } | undefined {
  const match = file.match(WORKER_STATE_FILENAME_PATTERN)
  if (!match?.groups) return undefined
  const timestamp = Number(match.groups.timestamp)
  const sequence = Number(match.groups.sequence)
  if (!Number.isFinite(timestamp) || !Number.isFinite(sequence)) return undefined
  return { timestamp, sequence }
}

function compareWorkerStateFilesByRecency(left: string, right: string): number {
  const leftKey = parseWorkerStateFilenameRecencyKey(left)
  const rightKey = parseWorkerStateFilenameRecencyKey(right)
  if (leftKey && rightKey) {
    if (rightKey.timestamp !== leftKey.timestamp) {
      return rightKey.timestamp - leftKey.timestamp
    }
    if (rightKey.sequence !== leftKey.sequence) {
      return rightKey.sequence - leftKey.sequence
    }
  }
  return right.localeCompare(left)
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

  // Active restore only needs these two fields to skip acknowledged terminal history.
  // Keep them at the front so long descriptions or owned_files never force a full JSON parse.
  return {
    status,
    notification_acknowledged: notificationAcknowledged,
    ...rest
  }
}

export class CoordinatorWorkerManager {
  private readonly workersByParent = new Map<string, Map<string, CoordinatorWorkerRecord>>()
  private readonly notificationsByParent = new Map<string, string[]>()
  private readonly workspacePathByParent = new Map<string, string>()
  private readonly activeRestoreHydratedWorkspaceByParent = new Map<string, string>()
  private readonly prunedSnapshotsByParent = new Map<
    string,
    Map<string, CoordinatorWorkerSnapshot>
  >()
  private readonly preparedScratchpadDirs = new Set<string>()
  private readonly warnedScratchpadDirs = new Set<string>()
  private sequence = 0

  startWorker(options: StartWorkerOptions): CoordinatorWorkerSnapshot {
    const parentThreadId = normalizeThreadId(options.parentThreadId)
    const workspacePath = normalizeNonEmpty(
      options.workspacePath,
      "Coordinator worker workspacePath"
    )
    this.workspacePathByParent.set(parentThreadId, workspacePath)
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
    if (record.status !== "running" && record.terminalPersistPromise) {
      throw new Error(
        `Worker ${record.workerId} is still finalizing its previous result. Wait for its task-notification before continuing.`
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

  async readWorkerResult(
    parentThreadId: string,
    workerId: string,
    options: { includeTranscript?: boolean; maxChars?: number } = {}
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
      const target = path.resolve(workspaceRoot, relativePath)
      if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`)) {
        throw new Error(`Worker output path escapes workspace: ${relativePath}`)
      }
      return truncateReadText(await readFile(target, "utf8"), maxChars)
    }

    const result = await readRelativeFile(record.resultPath)
    const transcript = options.includeTranscript
      ? await readRelativeFile(record.transcriptPath)
      : undefined

    return {
      worker: toSnapshot(record),
      result_path: record.resultPath,
      result_text: result?.text,
      result_chars: result?.chars,
      result_truncated: result?.truncated,
      transcript_path: record.transcriptPath,
      transcript_text: transcript?.text,
      transcript_chars: transcript?.chars,
      transcript_truncated: transcript?.truncated,
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
            options.waitForCleanup ? record.currentRun : undefined
          ].filter((promise): promise is Promise<void> => Boolean(promise))
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
    const existing = this.notificationsByParent.get(normalized) ?? []
    const restored = notifications.filter(
      (notification) =>
        !existing.includes(notification) && this.shouldRestoreNotification(normalized, notification)
    )
    if (restored.length === 0) return
    this.notificationsByParent.set(normalized, [...existing, ...restored])
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
  }

  async acknowledgeNotificationMessages(
    parentThreadId: string,
    notifications: string[]
  ): Promise<void> {
    const refs = notifications
      .map((notification): NotificationRef | undefined => {
        const workerId = this.extractNotificationWorkerId(notification)
        if (!workerId) return undefined
        return { workerId, turn: this.extractNotificationWorkerTurn(notification) }
      })
      .filter((ref): ref is NotificationRef => Boolean(ref))
    if (refs.length === 0) return
    const normalized = normalizeThreadId(parentThreadId)
    const persistPromises: Promise<void>[] = []
    for (const ref of refs) {
      const normalizedWorkerId = normalizeWorkerId(ref.workerId)
      const record = this.getWorker(normalized, normalizedWorkerId)
      if (!record || !terminalStatus(record.status)) continue
      if (ref.turn !== undefined && record.turns !== ref.turn) continue
      this.removeQueuedNotificationsForWorker(normalized, {
        workerId: normalizedWorkerId,
        turn: ref.turn
      })
      record.notificationAcknowledged = true
      record.suppressNotificationAutoRun = false
      record.notificationEnqueued = true
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
  }

  cancelWorkersForThread(
    parentThreadId: string,
    reason = "Parent run cancelled.",
    options?: { suppressNotificationAutoRun?: boolean }
  ): CoordinatorWorkerSnapshot[] {
    const records = Array.from(this.getParentMap(parentThreadId)?.values() ?? []).filter(
      (record) => record.status === "running"
    )
    for (const record of records) {
      this.cancelRecord(record, reason, options?.suppressNotificationAutoRun)
    }
    return records.map(toSnapshot)
  }

  async cancelWorker(
    parentThreadId: string,
    workerId: string,
    reason = "Worker cancelled."
  ): Promise<CoordinatorWorkerSnapshot> {
    const record = await this.getWorkerForOperation(parentThreadId, workerId)
    if (!record) {
      throw new Error(`Unknown coordinator worker: ${workerId}`)
    }
    this.cancelRecord(record, reason)
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
    if (filteredRecords.length === 0) return
    const startedAt = Date.now()
    while (Date.now() - startedAt <= timeoutMs) {
      const pending = filteredRecords
        .map((record) => record.terminalPersistPromise)
        .filter((promise): promise is Promise<void> => Boolean(promise))
      if (pending.length === 0) return
      const remainingMs = timeoutMs - (Date.now() - startedAt)
      if (remainingMs <= 0) return
      await Promise.race([Promise.allSettled(pending), waitOrAbort(Math.min(remainingMs, 250))])
    }
  }

  async waitForWorkerCleanup(
    parentThreadId: string,
    workerIds?: string[],
    timeoutMs = 5_000
  ): Promise<void> {
    const normalizedWorkerIds = workerIds?.map(normalizeWorkerId)
    const readPendingRecords = async (): Promise<Promise<void>[]> => {
      const records = await this.readWorkerRecordsAsync(
        parentThreadId,
        normalizedWorkerIds && normalizedWorkerIds.length === 1 ? normalizedWorkerIds[0] : undefined
      )
      const filteredRecords = records.filter((record) => {
        if (!normalizedWorkerIds || normalizedWorkerIds.length === 0) return true
        return normalizedWorkerIds.includes(record.workerId)
      })
      return filteredRecords.flatMap((record) =>
        [record.currentRun, record.terminalPersistPromise, record.statePersistPromise].filter(
          (promise): promise is Promise<void> => Boolean(promise)
        )
      )
    }
    const startedAt = Date.now()
    while (Date.now() - startedAt <= timeoutMs) {
      const pending = await readPendingRecords()
      if (pending.length === 0) return
      const remainingMs = timeoutMs - (Date.now() - startedAt)
      if (remainingMs <= 0) break
      await Promise.race([Promise.allSettled(pending), waitOrAbort(Math.min(remainingMs, 250))])
    }
    if ((await readPendingRecords()).length === 0) {
      return
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
    this.workspacePathByParent.set(parentThreadId, workspacePath)
    if (
      options.mode === "active" &&
      this.activeRestoreHydratedWorkspaceByParent.get(parentThreadId) === workspacePath
    ) {
      return this.readWorkers(parentThreadId)
    }
    const workersDir = path.resolve(workspacePath, COORDINATOR_BASE_DIR, parentThreadId, "workers")
    let files: string[]

    try {
      files = await readdir(workersDir)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        this.activeRestoreHydratedWorkspaceByParent.set(parentThreadId, workspacePath)
        return this.readWorkers(parentThreadId)
      }
      throw error
    }

    const records = this.parentMap(parentThreadId)
    const restoreMode = options.mode ?? "full"
    const fullRestore = restoreMode === "full"
    const recentRestore = restoreMode === "recent"
    const sortedFiles = recentRestore ? [...files].sort(compareWorkerStateFilesByRecency) : files
    let restoredRecentTerminalCount = 0
    for (const file of sortedFiles) {
      if (!file.endsWith(".json")) continue
      const workerIdFromFile = file.slice(0, -".json".length)
      if (!WORKER_ID_PATTERN.test(workerIdFromFile)) continue
      const existing = records.get(workerIdFromFile)
      if (existing) {
        this.setUpdateCallback(existing, options.onUpdate, options.onUpdateKey)
        continue
      }

      try {
        const statePath = path.join(workersDir, file)
        let shouldHydrateRecentTerminalRecord = false
        if (!fullRestore) {
          const scan = await readWorkerStatePrefix(statePath)
          const status = extractWorkerStatusFromJsonPrefix(scan)
          const acknowledged = extractNotificationAcknowledgedFromJsonPrefix(scan)
          if (status && terminalStatus(status) && acknowledged === true) {
            if (!recentRestore || restoredRecentTerminalCount >= RECENT_RESTORE_TERMINAL_LIMIT) {
              continue
            }
            shouldHydrateRecentTerminalRecord = true
          }
        }
        const raw = await readFile(statePath, "utf8")
        const snapshot = JSON.parse(raw) as Partial<CoordinatorWorkerSnapshot>
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

        records.set(record.workerId, record)
        if (shouldHydrateRecentTerminalRecord) {
          restoredRecentTerminalCount += 1
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
          await this.persistTerminalRecord(record)
          this.emitUpdate(record, this.enqueueNotification(record))
        } else if (terminalStatus(record.status) && !record.notificationAcknowledged) {
          this.emitUpdate(record, this.enqueueNotification(record))
        }
      } catch (error) {
        console.warn("[CoordinatorWorker] Failed to restore worker state:", error)
      }
    }

    this.activeRestoreHydratedWorkspaceByParent.set(parentThreadId, workspacePath)
    return this.readWorkers(parentThreadId)
  }

  forgetThread(parentThreadId: string): void {
    const normalized = normalizeThreadId(parentThreadId)
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
  }

  clear(): void {
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
    return records
  }

  private getParentMap(parentThreadId: string): Map<string, CoordinatorWorkerRecord> | undefined {
    return this.workersByParent.get(normalizeThreadId(parentThreadId))
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

  private assertCanRunWorker(input: {
    parentThreadId: string
    workspacePath: string
    role: CoordinatorWorkerRole
    workload: CoordinatorWorkerWorkload
    ownedFiles: string[]
    workerIdToIgnore?: string
  }): void {
    if (input.workload === "read_only") return
    const records = Array.from(this.getParentMap(input.parentThreadId)?.values() ?? [])
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
    if (!workerThreadId.startsWith(`${normalizedParentThreadId}${WORKER_THREAD_DELIMITER}`)) {
      return undefined
    }
    const normalizedRole = normalizeWorkerRole(role)
    const normalizedWorkload = normalizeWorkerWorkload(normalizedRole, workload)

    const record: CoordinatorWorkerRecord = {
      workerId: normalizedWorkerId,
      workerThreadId,
      parentThreadId: normalizedParentThreadId,
      workspacePath,
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
      reportPath: optionalString(snapshot.report_path),
      resultPath: optionalString(snapshot.result_path),
      transcriptPath: optionalString(snapshot.transcript_path),
      selectedSkill: parseSelectedSkill(snapshot.selected_skill),
      tokenUsage: parseTokenUsage(snapshot.token_usage),
      toolCallCount: numericValue(snapshot.tool_call_count, 0),
      lastToolName: optionalString(snapshot.last_tool_name),
      lastEvent,
      notificationEnqueued: terminalStatus(status) && notificationAcknowledged,
      notificationAcknowledged,
      suppressNotificationAutoRun,
      runVersion: 0
    }
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
    suppressNotificationAutoRun = false
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
    void this.persistTerminalAndNotify(record)
  }

  private launch(
    record: CoordinatorWorkerRecord,
    prompt: string,
    runner: CoordinatorWorkerRunner,
    parentSignal?: AbortSignal
  ): void {
    const abortController = new AbortController()
    record.abortController = abortController
    record.runVersion += 1
    const runVersion = record.runVersion

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
          record.reportPath = result.reportPath
          record.rawText = truncateWorkerRawText(result.rawText)
          record.transcriptText = result.transcriptText
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
        if (record.status === "completed") {
          record.status = "failed"
          if (record.summary) {
            record.summary = `${record.summary}\n\nWorker result persistence failed: ${message}`
          }
          record.error = `Worker result persistence failed: ${message}`
        } else if (!record.error) {
          record.error = message
        }
        record.resultPath = undefined
        record.updatedAt = timestamp
        record.finishedAt = record.finishedAt ?? timestamp
        record.lastActivityAt = timestamp
        record.lastEvent = `Worker result persistence failed: ${message}`
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
      this.emitUpdate(record, this.enqueueNotification(record))
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

  private enqueueNotification(record: CoordinatorWorkerRecord): string | undefined {
    if (record.notificationEnqueued) return undefined
    record.notificationEnqueued = true
    record.notificationAcknowledged = false
    const notification = this.formatNotification(record)
    const notifications = this.notificationsByParent.get(record.parentThreadId) ?? []
    notifications.push(notification)
    this.notificationsByParent.set(record.parentThreadId, notifications)
    return notification
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
      return
    }
    this.notificationsByParent.set(parentThreadId, remaining)
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

  private extractNotificationWorkerId(notification: string): string | undefined {
    const match = notification.match(/<task-id>([^<]+)<\/task-id>/)
    if (!match) return undefined
    return match[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&")
  }

  private extractNotificationWorkerTurn(notification: string): number | undefined {
    const match = notification.match(/<turn>(\d+)<\/turn>/)
    if (!match) return undefined
    const turn = Number(match[1])
    return Number.isFinite(turn) ? turn : undefined
  }

  private formatNotification(record: CoordinatorWorkerRecord): string {
    const snapshot = toSnapshot(record)
    const status = snapshot.status === "cancelled" ? "killed" : snapshot.status
    const summary =
      snapshot.summary ??
      snapshot.error ??
      (snapshot.status === "completed" ? "Worker completed." : snapshot.last_event)
    const reportPath = snapshot.report_path
      ? `\n<report-path>${escapeXml(snapshot.report_path)}</report-path>`
      : ""
    const resultPath = snapshot.result_path
      ? `\n<output-file>${escapeXml(snapshot.result_path)}</output-file>\n<result-path>${escapeXml(snapshot.result_path)}</result-path>`
      : ""
    const transcriptPath = snapshot.transcript_path
      ? `\n<transcript-path>${escapeXml(snapshot.transcript_path)}</transcript-path>`
      : ""
    const resultSource = record.rawText?.trim() ? record.rawText : summary
    const result = truncateNotificationResult(resultSource)
    const renderNotification = (
      resultText: string,
      resultTruncated: boolean,
      includeDebugPaths = true
    ): string => {
      const resultBlock = resultText
        ? `\n<result>${escapeXml(resultText)}</result>\n<result-truncated>${String(resultTruncated)}</result-truncated>`
        : ""
      const debugPaths = includeDebugPaths ? `${reportPath}${resultPath}${transcriptPath}` : ""
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
<summary>${escapeXml(truncateNotificationSummary(summary))}</summary>${resultBlock}${debugPaths}${usage}
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

  private async persistTerminalRecord(record: CoordinatorWorkerRecord): Promise<void> {
    const target = workerResultPath(record)
    const resultPath = relativeWorkerResultPath(record)
    const transcriptPath = relativeWorkerTranscriptPath(record)
    await mkdir(path.dirname(target), { recursive: true })
    if (record.transcriptText?.trim()) {
      await writeFileAtomic(workerTranscriptPath(record), record.transcriptText)
      record.transcriptPath = transcriptPath
    }
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
          transcript_path: record.transcriptPath,
          token_usage: record.tokenUsage,
          raw_text: truncateWorkerRawText(record.rawText)
        },
        null,
        2
      )
    )
    record.resultPath = resultPath
    await this.persistWorkerState(record)
  }

  private emitUpdate(record: CoordinatorWorkerRecord, notification?: string): void {
    if (record.discarded) return
    const callbacks = Array.from(record.onUpdateCallbacks?.values() ?? [])
    for (const callback of callbacks) {
      try {
        callback({
          worker: toSnapshot(record),
          notification,
          suppressNotificationAutoRun: notification ? record.suppressNotificationAutoRun : undefined
        })
      } catch (error) {
        console.warn("[CoordinatorWorker] Worker update callback failed:", error)
      }
    }
  }

  private async persistWorkerState(record: CoordinatorWorkerRecord): Promise<void> {
    const target = workerStatePath(record)
    await this.ensureScratchpadDirBestEffort(record)
    await writeFileAtomic(target, JSON.stringify(toPersistedWorkerState(record), null, 2))
  }

  private async ensureScratchpadDirBestEffort(record: CoordinatorWorkerRecord): Promise<void> {
    const scratchpadPath = workerScratchpadPath(record)
    if (this.preparedScratchpadDirs.has(scratchpadPath)) return
    try {
      await mkdir(scratchpadPath, { recursive: true })
      this.preparedScratchpadDirs.add(scratchpadPath)
    } catch (error) {
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

export const coordinatorWorkerManager = new CoordinatorWorkerManager()
