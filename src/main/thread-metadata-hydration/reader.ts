import type { DatabaseSync } from "node:sqlite"
import {
  GOAL_USER_MESSAGE_EVENT_PREFIX,
  isStaleCheckpointBoundaryNoticeMessage
} from "../../shared/goal-events"
import { GOAL_CLEAR_ALIASES } from "../../shared/goal-slash"
import type { Thread, ThreadGroupSelectionEntry } from "../types"
import type {
  ThreadGoalHydrationEvent,
  ThreadMetadataHydrationReadGroupIdsRequest,
  ThreadMetadataHydrationReadGoalEventsRequest,
  ThreadMetadataHydrationReadGitContextRequest,
  ThreadMetadataHydrationReadListPageRequest,
  ThreadMetadataHydrationReadThreadRequest,
  ThreadMetadataHydrationReadWorkspacePathRequest,
  ThreadMetadataHydrationStats
} from "./protocol"
import type { ThreadGitMetadataProjection } from "./protocol"
import { THREAD_METADATA_HYDRATION_CANCELLED } from "./protocol"

interface ThreadProjectionRow {
  thread_id?: unknown
  created_at?: unknown
  updated_at?: unknown
  metadata?: unknown
  status?: unknown
  title?: unknown
  hydration_values?: unknown
}

const THREAD_LIST_METADATA_KEY_LIMIT = 80
const THREAD_LIST_METADATA_VALUE_CHAR_BUDGET = 16_384
const THREAD_LIST_METADATA_KEY_CHAR_LIMIT = 128
const THREAD_LIST_UNKNOWN_STRING_LIMIT = 512
const THREAD_LIST_KNOWN_STRING_LIMIT = 8_192
const THREAD_LIST_KNOWN_STRING_KEYS = new Set([
  "workspacePath",
  "title",
  "model",
  "agentMode",
  "coordinatorMode",
  "outputStyle",
  "worktreeBranch",
  "worktreeBaseBranch",
  "gitRoot",
  "scheduledTaskId",
  "harnessProjectName",
  "projectName"
])
const THREAD_LIST_SMALL_OBJECT_KEYS = new Set([
  "harnessFeature",
  "harnessProjectSession",
  "routingState",
  "gitContext"
])
const THREAD_LIST_PRIORITY_KEYS = [
  "workspacePath",
  "harnessFeature",
  "harnessProjectSession",
  "harnessProjectName",
  "projectName",
  "agentMode",
  "coordinatorMode",
  "subagentsEnabled",
  "model",
  "routingState",
  "memoryEnabled",
  "outputStyle",
  "conciseModeEnabled",
  "isWorktree",
  "worktreeBranch",
  "worktreeBaseBranch",
  "gitRoot",
  "gitContext",
  "scheduledTaskId",
  "isHeartbeat",
  "title"
] as const
const MAX_GOAL_EVENT_MESSAGE_BYTES = 128 * 1024
const THREAD_LIST_PAGE_MAX_ROWS = 128
const THREAD_LIST_PAGE_MAX_BYTES = 512 * 1024
const THREAD_GROUP_ID_MAX_ROWS = 10_000
const THREAD_GROUP_ID_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const GIT_CONTEXT_TRACKED_FILE_LIMIT = 512
const GIT_CONTEXT_TRACKED_FILE_CHAR_BUDGET = 256 * 1024
const GIT_CONTEXT_PATH_CHAR_LIMIT = 4_096
const GOAL_EVENT_TRUNCATION_SUFFIX = "\n…[历史 Goal 事件已截断]"
const NON_TRANSCRIPT_GOAL_COMMANDS = new Set([
  "/goal",
  "/goal status",
  "/goal pause",
  ...GOAL_CLEAR_ALIASES.map((alias) => `/goal ${alias}`)
])

export class ThreadMetadataHydrationCancelledError extends Error {
  readonly code = THREAD_METADATA_HYDRATION_CANCELLED

  constructor() {
    super("Thread metadata hydration request was superseded")
    this.name = "ThreadMetadataHydrationCancelledError"
  }
}

function throwIfCancelled(cancellation: Int32Array): void {
  if (Atomics.load(cancellation, 0) !== 0) {
    throw new ThreadMetadataHydrationCancelledError()
  }
}

function parseObject(raw: unknown, cancellation: Int32Array): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined
  throwIfCancelled(cancellation)
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  } finally {
    throwIfCancelled(cancellation)
  }
}

function projectSmallObject(
  value: unknown,
  charBudget: number
): { value: Record<string, unknown>; chars: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const projected: Record<string, unknown> = {}
  let chars = 0
  for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
    if (key.length > THREAD_LIST_METADATA_KEY_CHAR_LIMIT || chars >= charBudget) continue
    if (
      nested === null ||
      typeof nested === "boolean" ||
      (typeof nested === "number" && Number.isFinite(nested))
    ) {
      projected[key] = nested
      chars += 16
    } else if (typeof nested === "string") {
      const selected = nested.slice(0, Math.min(512, Math.max(0, charBudget - chars)))
      projected[key] = selected
      chars += selected.length
    }
  }
  return { value: projected, chars }
}

/** Keep list rows semantically useful while imposing a hard per-row payload bound. */
function projectThreadListMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) return undefined
  const projected: Record<string, unknown> = {}
  let valueChars = 0
  const priorityKeys = new Set<string>(THREAD_LIST_PRIORITY_KEYS)
  const entries = [
    ...THREAD_LIST_PRIORITY_KEYS.flatMap((key) =>
      Object.prototype.hasOwnProperty.call(metadata, key) ? [[key, metadata[key]] as const] : []
    ),
    ...Object.entries(metadata).filter(([key]) => !priorityKeys.has(key))
  ].slice(0, THREAD_LIST_METADATA_KEY_LIMIT)
  for (const [key, value] of entries) {
    if (
      key.length > THREAD_LIST_METADATA_KEY_CHAR_LIMIT ||
      valueChars >= THREAD_LIST_METADATA_VALUE_CHAR_BUDGET
    ) {
      continue
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      projected[key] = value
      valueChars += 16
      continue
    }
    if (typeof value === "string") {
      const limit = THREAD_LIST_KNOWN_STRING_KEYS.has(key)
        ? THREAD_LIST_KNOWN_STRING_LIMIT
        : THREAD_LIST_UNKNOWN_STRING_LIMIT
      const selected = value.slice(
        0,
        Math.min(limit, THREAD_LIST_METADATA_VALUE_CHAR_BUDGET - valueChars)
      )
      projected[key] = selected
      valueChars += selected.length
      continue
    }
    if (THREAD_LIST_SMALL_OBJECT_KEYS.has(key)) {
      const smallObject = projectSmallObject(
        value,
        THREAD_LIST_METADATA_VALUE_CHAR_BUDGET - valueChars
      )
      if (smallObject) {
        projected[key] = smallObject.value
        valueChars += smallObject.chars
      }
    }
  }
  return projected
}

function toTimestamp(value: unknown): Date {
  const numeric = typeof value === "number" ? value : Number(value)
  const date = new Date(Number.isFinite(numeric) ? numeric : 0)
  return Number.isFinite(date.getTime()) ? date : new Date(0)
}

function rowSourceBytes(row: ThreadProjectionRow): number {
  return (
    (typeof row.metadata === "string" ? Buffer.byteLength(row.metadata) : 0) +
    (typeof row.hydration_values === "string" ? Buffer.byteLength(row.hydration_values) : 0)
  )
}

function rowToThread(
  row: ThreadProjectionRow,
  cancellation: Int32Array,
  includeValues: boolean
): Thread | null {
  if (typeof row.thread_id !== "string" || !row.thread_id) return null
  const parsedMetadata = parseObject(row.metadata, cancellation)
  const metadata = includeValues ? parsedMetadata : projectThreadListMetadata(parsedMetadata)
  const threadValues = includeValues ? parseObject(row.hydration_values, cancellation) : undefined
  return {
    thread_id: row.thread_id,
    created_at: toTimestamp(row.created_at),
    updated_at: toTimestamp(row.updated_at),
    metadata,
    status:
      row.status === "busy" || row.status === "interrupted" || row.status === "error"
        ? row.status
        : "idle",
    ...(includeValues && threadValues ? { thread_values: threadValues } : {}),
    ...(typeof row.title === "string" ? { title: row.title.slice(0, 512) } : {})
  }
}

function stats(
  startedAt: number,
  rowCount: number,
  sourceBytes: number
): ThreadMetadataHydrationStats {
  return { durationMs: performance.now() - startedAt, rowCount, sourceBytes }
}

function isRestorableGoalUserEventMessage(message: string): boolean {
  const trimmed = message.trim()
  if (!trimmed.startsWith(GOAL_USER_MESSAGE_EVENT_PREFIX)) return false
  const command = trimmed.slice(GOAL_USER_MESSAGE_EVENT_PREFIX.length).trim().toLowerCase()
  return !NON_TRANSCRIPT_GOAL_COMMANDS.has(command)
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const suffixBytes = Buffer.byteLength(GOAL_EVENT_TRUNCATION_SUFFIX)
  const contentBudget = Math.max(0, maxBytes - suffixBytes)
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, middle)) <= contentBudget) low = middle
    else high = middle - 1
  }
  let end = low
  if (end > 0) {
    const lastCodeUnit = text.charCodeAt(end - 1)
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1
  }
  return `${text.slice(0, end)}${GOAL_EVENT_TRUNCATION_SUFFIX}`
}

interface GoalEventProjectionRow {
  event_id?: unknown
  thread_id?: unknown
  goal_id?: unknown
  active_window_id?: unknown
  message?: unknown
  created_at?: unknown
}

function goalEventFromRow(row: GoalEventProjectionRow): ThreadGoalHydrationEvent | null {
  if (typeof row.thread_id !== "string" || typeof row.message !== "string") return null
  const eventId = Number(row.event_id)
  const createdAt = Number(row.created_at)
  if (!Number.isFinite(eventId) || !Number.isFinite(createdAt)) return null
  return {
    event_id: eventId,
    thread_id: row.thread_id,
    goal_id: typeof row.goal_id === "string" ? row.goal_id : null,
    active_window_id: typeof row.active_window_id === "string" ? row.active_window_id : null,
    message: row.message,
    created_at: createdAt
  }
}

export function readThreadGoalEventsProjection(
  database: DatabaseSync,
  request: ThreadMetadataHydrationReadGoalEventsRequest
): {
  events: ThreadGoalHydrationEvent[]
  truncated: boolean
  stats: ThreadMetadataHydrationStats
} {
  const startedAt = performance.now()
  const cancellation = new Int32Array(request.cancellationBuffer)
  const scanLimit = Math.max(1, Math.min(1_000, Math.floor(request.scanLimit)))
  const recentLimit = Math.max(1, Math.min(scanLimit, Math.floor(request.recentLimit)))
  const byteBudget = Math.max(
    MAX_GOAL_EVENT_MESSAGE_BYTES,
    Math.min(4 * 1024 * 1024, Math.floor(request.byteBudget))
  )
  const statement = database.prepare(
    `SELECT * FROM (
       SELECT event_id, thread_id, goal_id, active_window_id, message, created_at
       FROM thread_goal_events
       WHERE thread_id = ?
       ORDER BY created_at DESC, event_id DESC
       LIMIT ?
     ) ORDER BY created_at ASC, event_id ASC`
  )
  const scanned: ThreadGoalHydrationEvent[] = []
  let sourceBytes = 0
  for (const row of statement.iterate(
    request.threadId,
    scanLimit
  ) as Iterable<GoalEventProjectionRow>) {
    throwIfCancelled(cancellation)
    const event = goalEventFromRow(row)
    if (!event) continue
    sourceBytes += Buffer.byteLength(event.message)
    scanned.push(event)
  }
  const recentStart = Math.max(0, scanned.length - recentLimit)
  const candidates = request.restore
    ? scanned.filter(
        (event, index) =>
          index >= recentStart ||
          isRestorableGoalUserEventMessage(event.message) ||
          isStaleCheckpointBoundaryNoticeMessage(event.message)
      )
    : scanned.slice(-recentLimit)
  const selectedNewestFirst: ThreadGoalHydrationEvent[] = []
  let selectedBytes = 0
  let truncated = false
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    throwIfCancelled(cancellation)
    const candidate = candidates[index]
    const message = truncateUtf8(candidate.message, MAX_GOAL_EVENT_MESSAGE_BYTES)
    if (message !== candidate.message) truncated = true
    const eventBytes = Buffer.byteLength(message) + 160
    if (selectedNewestFirst.length > 0 && selectedBytes + eventBytes > byteBudget) {
      truncated = true
      continue
    }
    selectedNewestFirst.push(message === candidate.message ? candidate : { ...candidate, message })
    selectedBytes += eventBytes
  }
  throwIfCancelled(cancellation)
  return {
    events: selectedNewestFirst.reverse(),
    truncated,
    stats: stats(startedAt, scanned.length, sourceBytes)
  }
}

export function readThreadHydrationProjection(
  database: DatabaseSync,
  request: ThreadMetadataHydrationReadThreadRequest
): { thread: Thread | null; stats: ThreadMetadataHydrationStats } {
  const startedAt = performance.now()
  const cancellation = new Int32Array(request.cancellationBuffer)
  throwIfCancelled(cancellation)
  const row = database
    .prepare(
      `SELECT thread_id, created_at, updated_at,
              CASE
                WHEN metadata IS NULL THEN NULL
                WHEN json_valid(metadata) THEN json_remove(
                  metadata,
                  '$.llmFileHistory',
                  '$.llmModifiedFiles',
                  '$.llmRecentlyRevertedFiles'
                )
                ELSE '{}'
              END AS metadata,
              status, title,
              '{}' AS hydration_values
       FROM threads
       WHERE thread_id = ?`
    )
    .get(request.threadId) as ThreadProjectionRow | undefined
  throwIfCancelled(cancellation)
  if (!row) return { thread: null, stats: stats(startedAt, 0, 0) }
  const thread = rowToThread(row, cancellation, true)
  return { thread, stats: stats(startedAt, thread ? 1 : 0, rowSourceBytes(row)) }
}

export function readThreadWorkspacePathProjection(
  database: DatabaseSync,
  request: ThreadMetadataHydrationReadWorkspacePathRequest
): { workspacePath: string | null; stats: ThreadMetadataHydrationStats } {
  const startedAt = performance.now()
  const cancellation = new Int32Array(request.cancellationBuffer)
  throwIfCancelled(cancellation)
  const row = database
    .prepare(
      `SELECT CASE
         WHEN metadata IS NOT NULL AND json_valid(metadata)
         THEN json_extract(metadata, '$.workspacePath')
         ELSE NULL
       END AS workspace_path
       FROM threads
       WHERE thread_id = ?`
    )
    .get(request.threadId) as { workspace_path?: unknown } | undefined
  throwIfCancelled(cancellation)
  const workspacePath =
    typeof row?.workspace_path === "string" && row.workspace_path.trim() ? row.workspace_path : null
  return {
    workspacePath,
    stats: stats(
      startedAt,
      row ? 1 : 0,
      workspacePath === null ? 0 : Buffer.byteLength(workspacePath)
    )
  }
}

/**
 * Parse legacy-heavy thread metadata in the worker and return only the fields
 * needed by Git panel reads. llmFileHistory can grow to many MiB and must never
 * cross into Electron's main event loop merely because the panel was opened.
 */
export function readThreadGitMetadataProjection(
  database: DatabaseSync,
  request: ThreadMetadataHydrationReadGitContextRequest
): {
  projection: ThreadGitMetadataProjection
  stats: ThreadMetadataHydrationStats
} {
  const startedAt = performance.now()
  const cancellation = new Int32Array(request.cancellationBuffer)
  throwIfCancelled(cancellation)
  const row = database
    .prepare("SELECT metadata FROM threads WHERE thread_id = ?")
    .get(request.threadId) as { metadata?: unknown } | undefined
  throwIfCancelled(cancellation)
  const sourceBytes = typeof row?.metadata === "string" ? Buffer.byteLength(row.metadata) : 0
  const source = parseObject(row?.metadata, cancellation) ?? {}
  const metadata: Record<string, unknown> = {}
  for (const key of [
    "workspacePath",
    "gitRoot",
    "worktreeBranch",
    "worktreeBaseBranch",
    "worktreeBaseCommit",
    "cachedGitRoot",
    "cachedGitContextWorkspacePath",
    "cachedGitContextAt"
  ]) {
    const value = source[key]
    if (typeof value === "string") metadata[key] = value.slice(0, GIT_CONTEXT_PATH_CHAR_LIMIT)
  }
  for (const key of ["isWorktree", "cachedIsGitRepo", "cachedIsWorktreePath"]) {
    if (typeof source[key] === "boolean") metadata[key] = source[key]
  }
  const gitContext = projectSmallObject(source.gitContext, 16_384)
  if (gitContext) metadata.gitContext = gitContext.value

  const trackedFiles: string[] = []
  let trackedFileChars = 0
  let trackedFilesTruncated = false
  const rawTrackedFiles = Array.isArray(source.llmModifiedFiles) ? source.llmModifiedFiles : []
  for (const value of rawTrackedFiles) {
    throwIfCancelled(cancellation)
    if (typeof value !== "string") continue
    const selected = value.slice(0, GIT_CONTEXT_PATH_CHAR_LIMIT)
    if (
      trackedFiles.length >= GIT_CONTEXT_TRACKED_FILE_LIMIT ||
      trackedFileChars + selected.length > GIT_CONTEXT_TRACKED_FILE_CHAR_BUDGET
    ) {
      trackedFilesTruncated = true
      break
    }
    trackedFiles.push(selected)
    trackedFileChars += selected.length
  }
  if (trackedFiles.length > 0) metadata.llmModifiedFiles = trackedFiles
  if (trackedFiles.length < rawTrackedFiles.length) trackedFilesTruncated = true
  throwIfCancelled(cancellation)
  return {
    projection: { metadata, trackedFilesTruncated },
    stats: stats(startedAt, row ? 1 : 0, sourceBytes)
  }
}

export function readThreadSummaryPage(
  database: DatabaseSync,
  request: ThreadMetadataHydrationReadListPageRequest
): {
  threads: Thread[]
  beforeUpdatedAt: number | null
  beforeThreadId: string | null
  hasMore: boolean
  stats: ThreadMetadataHydrationStats
} {
  const startedAt = performance.now()
  const cancellation = new Int32Array(request.cancellationBuffer)
  const limit = Math.max(1, Math.min(THREAD_LIST_PAGE_MAX_ROWS, Math.floor(request.limit)))
  const byteBudget = Math.max(
    64 * 1024,
    Math.min(THREAD_LIST_PAGE_MAX_BYTES, Math.floor(request.byteBudget))
  )
  const hasUpdatedCursor = Number.isFinite(request.beforeUpdatedAt)
  const hasIdCursor =
    typeof request.beforeThreadId === "string" && request.beforeThreadId.length > 0
  if (hasUpdatedCursor !== hasIdCursor) {
    throw new Error("Thread summary page cursor requires updated time and thread id together")
  }
  const metadataProjection = `CASE
    WHEN metadata IS NULL THEN NULL
    WHEN json_valid(metadata) THEN json_remove(
      metadata,
      '$.llmFileHistory',
      '$.llmModifiedFiles',
      '$.llmRecentlyRevertedFiles'
    )
    ELSE '{}'
  END`
  const statement = database.prepare(
    hasUpdatedCursor
      ? `SELECT thread_id, created_at, updated_at, ${metadataProjection} AS metadata,
                status, title
         FROM threads
         WHERE updated_at < ? OR (updated_at = ? AND thread_id < ?)
         ORDER BY updated_at DESC, thread_id DESC
         LIMIT ?`
      : `SELECT thread_id, created_at, updated_at, ${metadataProjection} AS metadata,
                status, title
         FROM threads
         ORDER BY updated_at DESC, thread_id DESC
         LIMIT ?`
  )
  const rows = (
    hasUpdatedCursor
      ? statement.all(
          request.beforeUpdatedAt as number,
          request.beforeUpdatedAt as number,
          request.beforeThreadId as string,
          limit + 1
        )
      : statement.all(limit + 1)
  ) as ThreadProjectionRow[]
  const threads: Thread[] = []
  let responseBytes = 2
  let sourceBytes = 0
  for (const row of rows) {
    throwIfCancelled(cancellation)
    const thread = rowToThread(row, cancellation, false)
    if (!thread) continue
    const threadBytes = Buffer.byteLength(JSON.stringify(thread)) + 1
    if (
      threads.length >= limit ||
      (threads.length > 0 && responseBytes + threadBytes > byteBudget)
    ) {
      break
    }
    threads.push(thread)
    responseBytes += threadBytes
    sourceBytes += rowSourceBytes(row)
  }
  throwIfCancelled(cancellation)
  const oldest = threads.at(-1)
  const hasMore = threads.length < rows.length
  return {
    threads,
    beforeUpdatedAt: hasMore && oldest ? oldest.updated_at.getTime() : null,
    beforeThreadId: hasMore && oldest ? oldest.thread_id : null,
    hasMore,
    stats: stats(startedAt, threads.length, sourceBytes)
  }
}

interface ThreadGroupIdRow {
  thread_id?: unknown
  created_at?: unknown
  incarnation_token?: unknown
}

/**
 * Read only the durable ids needed by a destructive group action. Filtering in
 * the metadata worker avoids hydrating an unbounded directory in the renderer.
 */
export function readThreadGroupIds(
  database: DatabaseSync,
  request: ThreadMetadataHydrationReadGroupIdsRequest
): {
  entries: ThreadGroupSelectionEntry[]
  stats: ThreadMetadataHydrationStats
} {
  const startedAt = performance.now()
  const cancellation = new Int32Array(request.cancellationBuffer)

  // json_extract throws for malformed legacy metadata. Every selector goes
  // through this valid-object expression so a bad row can never abort or widen
  // a destructive selection.
  const metadata = "CASE WHEN metadata IS NOT NULL AND json_valid(metadata) THEN metadata ELSE '{}' END"
  const featureProject = `trim(CASE WHEN json_type(${metadata}, '$.harnessFeature.projectId') = 'text' THEN json_extract(${metadata}, '$.harnessFeature.projectId') ELSE '' END)`
  const featureSlug = `trim(CASE WHEN json_type(${metadata}, '$.harnessFeature.slug') = 'text' THEN json_extract(${metadata}, '$.harnessFeature.slug') ELSE '' END)`
  const projectSessionProject = `trim(CASE WHEN json_type(${metadata}, '$.harnessProjectSession.projectId') = 'text' THEN json_extract(${metadata}, '$.harnessProjectSession.projectId') ELSE '' END)`
  const projectSessionKind = `trim(CASE WHEN json_type(${metadata}, '$.harnessProjectSession.kind') = 'text' THEN json_extract(${metadata}, '$.harnessProjectSession.kind') ELSE '' END)`
  const isValidFeature = `${featureProject} <> '' AND ${featureSlug} <> ''`
  const isValidProjectSession = `${projectSessionProject} <> '' AND ${projectSessionKind} <> ''`

  let selectorSql: string
  let selectorParams: Array<string> = []
  if (request.selector.type === "workspace") {
    const isFeatureThread = `COALESCE(json_type(${metadata}, '$.harnessFeature.projectId'), '') = 'text' AND COALESCE(json_type(${metadata}, '$.harnessFeature.slug'), '') = 'text'`
    const isProjectSessionThread = `COALESCE(json_type(${metadata}, '$.harnessProjectSession.projectId'), '') = 'text' AND COALESCE(json_type(${metadata}, '$.harnessProjectSession.kind'), '') = 'text'`
    const workspacePath = `json_extract(${metadata}, '$.workspacePath')`
    const workspacePredicate =
      request.selector.workspacePath === null
        ? `(COALESCE(json_type(${metadata}, '$.workspacePath'), '') <> 'text' OR trim(${workspacePath}) = '')`
        : `json_type(${metadata}, '$.workspacePath') = 'text' AND ${workspacePath} = ?`
    selectorSql = `NOT (${isFeatureThread}) AND NOT (${isProjectSessionThread}) AND (${workspacePredicate})`
    if (request.selector.workspacePath !== null) {
      selectorParams = [request.selector.workspacePath]
    }
  } else if (request.selector.type === "harness-feature") {
    // The renderer classifies a valid project-session first and never also
    // exposes that row under its compatibility feature metadata.
    selectorSql = `NOT (${isValidProjectSession}) AND ${featureProject} = ? AND ${featureSlug} = ?`
    selectorParams = [request.selector.projectId, request.selector.slug]
  } else if (request.selector.type === "harness-project") {
    selectorSql = `((${isValidProjectSession}) AND ${projectSessionProject} = ?) OR (NOT (${isValidProjectSession}) AND (${isValidFeature}) AND ${featureProject} = ?)`
    selectorParams = [request.selector.projectId, request.selector.projectId]
  } else {
    throw new Error("Unsupported thread group selector")
  }

  const statement = database.prepare(
    `SELECT thread_id,
            created_at,
            CASE
              WHEN json_type(${metadata}, '$.cmb_thread_incarnation') = 'text'
              THEN json_extract(${metadata}, '$.cmb_thread_incarnation')
              ELSE NULL
            END AS incarnation_token
     FROM threads
     WHERE (${selectorSql})
     ORDER BY thread_id
     LIMIT ?`
  )
  // One statement gives the confirmation flow a coherent SQLite read snapshot.
  // Pagination by updated_at could silently miss a row that moves between pages.
  const rows = statement.all(...selectorParams, THREAD_GROUP_ID_MAX_ROWS + 1) as ThreadGroupIdRow[]
  throwIfCancelled(cancellation)
  if (rows.length > THREAD_GROUP_ID_MAX_ROWS) {
    throw new Error(
      `Thread group selection exceeds the ${THREAD_GROUP_ID_MAX_ROWS} row safety ceiling`
    )
  }

  const entries: ThreadGroupSelectionEntry[] = []
  let responseBytes = 2
  for (const row of rows) {
    throwIfCancelled(cancellation)
    if (typeof row.thread_id !== "string" || !row.thread_id) {
      throw new Error("Thread group selector returned an invalid thread id")
    }
    const legacyCreatedAt = Number(row.created_at)
    if (!Number.isFinite(legacyCreatedAt)) {
      throw new Error("Thread group selector returned an invalid creation timestamp")
    }
    const token = row.incarnation_token
    if (token !== null && token !== undefined && typeof token !== "string") {
      throw new Error("Thread group selector returned an invalid incarnation token")
    }
    if (typeof token === "string" && (token.length === 0 || token.length > 4_096)) {
      throw new Error("Thread group selector returned an unsafe incarnation token")
    }
    responseBytes +=
      Buffer.byteLength(row.thread_id, "utf8") +
      (typeof token === "string" ? Buffer.byteLength(token, "utf8") : 0) +
      32
    if (responseBytes > THREAD_GROUP_ID_MAX_RESPONSE_BYTES) {
      throw new Error("Thread group id selection exceeded its hard byte ceiling")
    }
    entries.push({
      threadId: row.thread_id,
      incarnation: { token: token ?? null, legacyCreatedAt }
    })
  }
  return {
    entries,
    stats: stats(startedAt, entries.length, responseBytes)
  }
}
