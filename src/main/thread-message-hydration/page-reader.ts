import { DatabaseSync } from "node:sqlite"
import type { ContentBlock, Message, ToolCall } from "../types"
import type {
  ThreadMessageHydrationWorkerStats,
  ThreadMessageHydrationReadRequest
} from "./protocol"
import { THREAD_MESSAGE_HYDRATION_CANCELLED } from "./protocol"
import { isRestorableConversationTranscriptMessage } from "../../shared/checkpoint-transcript"
import {
  GOAL_USER_MESSAGE_EVENT_PREFIX,
  isVisibleGoalUserEventMessage
} from "../../shared/goal-events"

const THREAD_MESSAGE_TEXT_LIMIT = 120_000
const THREAD_MESSAGE_BLOCK_LIMIT = 80
const THREAD_MESSAGE_BLOCK_TEXT_LIMIT = 60_000
const THREAD_MESSAGE_JSON_STRING_LIMIT = 20_000
const THREAD_MESSAGE_JSON_ARRAY_LIMIT = 100
const THREAD_MESSAGE_JSON_OBJECT_KEY_LIMIT = 80
const THREAD_MESSAGE_JSON_DEPTH_LIMIT = 6
const THREAD_MESSAGE_TOOL_CALL_LIMIT = 50
const DEFAULT_THREAD_MESSAGES_PAGE_LIMIT = 500
const MAX_THREAD_MESSAGES_PAGE_LIMIT = 1_000
export const THREAD_MESSAGE_HYDRATION_MAX_BYTE_BUDGET = 4 * 1024 * 1024
export const THREAD_CONVERSATION_PRESENCE_SCAN_LIMIT = 4_096
export const THREAD_CONVERSATION_PRESENCE_ROW_BYTE_LIMIT = 1024 * 1024
export const THREAD_CONVERSATION_PRESENCE_SCAN_BYTE_BUDGET = 8 * 1024 * 1024
const THREAD_MESSAGE_HYDRATION_MIN_BYTE_BUDGET = 64 * 1024
const THREAD_MESSAGE_HYDRATION_RESPONSE_OVERHEAD = 1024
const OVERSIZED_MESSAGE_MARKER = "\n[完整消息过大，当前仅显示有界预览]"

interface ThreadMessageRow {
  thread_id: string
  message_id: string
  provider_source_id: string | null
  provider_occurrence: number | null
  role: Message["role"]
  content_json: string
  tool_calls_json: string | null
  tool_call_id: string | null
  name: string | null
  status: string | null
  is_error: number | null
  content_priority: number | null
  goal_id: string | null
  active_window_id: string | null
  created_at: number
  start_at: number | null
  end_at: number | null
  ordinal: number
}

interface CandidateRow {
  message_id: string
  ordinal: number
  estimated_bytes: number
}

interface FragmentSummary {
  prefix: string
  length: number
}

interface LegacyCheckpointMigrationBoundary {
  checkpointId: string
  totalMessages: number
  status: "migrating" | "complete"
}

export class ThreadMessageHydrationCancelledError extends Error {
  readonly code = THREAD_MESSAGE_HYDRATION_CANCELLED

  constructor() {
    super("Thread message hydration request was superseded")
    this.name = "ThreadMessageHydrationCancelledError"
  }
}

function throwIfCancelled(cancellation: Int32Array): void {
  if (Atomics.load(cancellation, 0) !== 0) {
    throw new ThreadMessageHydrationCancelledError()
  }
}

function normalizePageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined || limit <= 0) {
    return DEFAULT_THREAD_MESSAGES_PAGE_LIMIT
  }
  return Math.min(MAX_THREAD_MESSAGES_PAGE_LIMIT, Math.max(1, Math.floor(limit)))
}

function normalizeByteBudget(byteBudget: number | undefined): number {
  if (!Number.isFinite(byteBudget) || byteBudget === undefined || byteBudget <= 0) {
    return THREAD_MESSAGE_HYDRATION_MAX_BYTE_BUDGET
  }
  return Math.min(
    THREAD_MESSAGE_HYDRATION_MAX_BYTE_BUDGET,
    Math.max(THREAD_MESSAGE_HYDRATION_MIN_BYTE_BUDGET, Math.floor(byteBudget))
  )
}

function normalizeTimestamp(value: unknown, fallback: number | null = null): number | null {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : fallback
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value).getTime()
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

function dateFromTimestamp(value: unknown): Date | undefined {
  const millis = normalizeTimestamp(value)
  if (millis === null) return undefined
  const date = new Date(millis)
  return Number.isFinite(date.getTime()) ? date : undefined
}

function truncateTranscriptString(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`
}

function summarizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateTranscriptString(value, THREAD_MESSAGE_JSON_STRING_LIMIT)
  }
  if (Array.isArray(value)) return `[Array ${value.length}]`
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === "object") return "[Object]"
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
  if (typeof value === "symbol") return value.toString()
  return value
}

function clampJsonForTranscript(
  value: unknown,
  options: {
    stringLimit: number
    arrayLimit: number
    objectKeyLimit: number
    depthLimit: number
  },
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  if (typeof value === "string") return truncateTranscriptString(value, options.stringLimit)
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
  if (typeof value === "symbol") return value.toString()
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"
  if (depth >= options.depthLimit) return summarizeJsonValue(value)

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const values = value
        .slice(0, options.arrayLimit)
        .map((item) => clampJsonForTranscript(item, options, depth + 1, seen))
      if (value.length > options.arrayLimit) {
        values.push(`[truncated ${value.length - options.arrayLimit} items]`)
      }
      return values
    }

    const output: Record<string, unknown> = {}
    const entries = Object.entries(value).slice(0, options.objectKeyLimit)
    for (const [key, nested] of entries) {
      output[key] = clampJsonForTranscript(nested, options, depth + 1, seen)
    }
    const keyCount = Object.keys(value).length
    if (keyCount > options.objectKeyLimit) {
      output.__truncated_keys = keyCount - options.objectKeyLimit
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function parseJsonValue(raw: unknown, cancellation: Int32Array): unknown {
  if (typeof raw !== "string" || raw.trim() === "") return undefined
  throwIfCancelled(cancellation)
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  } finally {
    throwIfCancelled(cancellation)
  }
}

function normalizeMessageContent(content: unknown): Message["content"] {
  if (typeof content === "string") {
    return truncateTranscriptString(content, THREAD_MESSAGE_TEXT_LIMIT)
  }
  if (Array.isArray(content)) {
    return content
      .slice(0, THREAD_MESSAGE_BLOCK_LIMIT)
      .map((block) =>
        clampJsonForTranscript(block, {
          stringLimit: THREAD_MESSAGE_BLOCK_TEXT_LIMIT,
          arrayLimit: THREAD_MESSAGE_JSON_ARRAY_LIMIT,
          objectKeyLimit: THREAD_MESSAGE_JSON_OBJECT_KEY_LIMIT,
          depthLimit: THREAD_MESSAGE_JSON_DEPTH_LIMIT
        })
      ) as ContentBlock[]
  }
  return ""
}

function parsedToolCalls(parsed: unknown): ToolCall[] | undefined {
  if (!Array.isArray(parsed)) return undefined
  return parsed
    .slice(0, THREAD_MESSAGE_TOOL_CALL_LIMIT)
    .map((toolCall) =>
      clampJsonForTranscript(toolCall, {
        stringLimit: THREAD_MESSAGE_JSON_STRING_LIMIT,
        arrayLimit: THREAD_MESSAGE_JSON_ARRAY_LIMIT,
        objectKeyLimit: THREAD_MESSAGE_JSON_OBJECT_KEY_LIMIT,
        depthLimit: THREAD_MESSAGE_JSON_DEPTH_LIMIT
      })
    ) as ToolCall[]
}

function jsonValueNeedsTranscriptClamp(
  value: unknown,
  options: {
    stringLimit: number
    arrayLimit: number
    objectKeyLimit: number
    depthLimit: number
  },
  depth = 0
): boolean {
  if (typeof value === "string") return value.length > options.stringLimit
  if (!value || typeof value !== "object") return false
  if (depth >= options.depthLimit) return true
  if (Array.isArray(value)) {
    return (
      value.length > options.arrayLimit ||
      value
        .slice(0, options.arrayLimit)
        .some((nested) => jsonValueNeedsTranscriptClamp(nested, options, depth + 1))
    )
  }
  const entries = Object.entries(value)
  return (
    entries.length > options.objectKeyLimit ||
    entries
      .slice(0, options.objectKeyLimit)
      .some(([, nested]) => jsonValueNeedsTranscriptClamp(nested, options, depth + 1))
  )
}

function messageContentNeedsTranscriptClamp(content: unknown): boolean {
  if (typeof content === "string") return content.length > THREAD_MESSAGE_TEXT_LIMIT
  if (!Array.isArray(content)) return content !== undefined && content !== null
  if (content.length > THREAD_MESSAGE_BLOCK_LIMIT) return true
  return content.some((block) =>
    jsonValueNeedsTranscriptClamp(block, {
      stringLimit: THREAD_MESSAGE_BLOCK_TEXT_LIMIT,
      arrayLimit: THREAD_MESSAGE_JSON_ARRAY_LIMIT,
      objectKeyLimit: THREAD_MESSAGE_JSON_OBJECT_KEY_LIMIT,
      depthLimit: THREAD_MESSAGE_JSON_DEPTH_LIMIT
    })
  )
}

function toolCallsNeedTranscriptClamp(toolCalls: unknown): boolean {
  if (!Array.isArray(toolCalls)) return toolCalls !== undefined && toolCalls !== null
  if (toolCalls.length > THREAD_MESSAGE_TOOL_CALL_LIMIT) return true
  return toolCalls.some((toolCall) =>
    jsonValueNeedsTranscriptClamp(toolCall, {
      stringLimit: THREAD_MESSAGE_JSON_STRING_LIMIT,
      arrayLimit: THREAD_MESSAGE_JSON_ARRAY_LIMIT,
      objectKeyLimit: THREAD_MESSAGE_JSON_OBJECT_KEY_LIMIT,
      depthLimit: THREAD_MESSAGE_JSON_DEPTH_LIMIT
    })
  )
}

function messageBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  return undefined
}

function appendFragmentSummary(
  storedContent: Message["content"],
  fragment: FragmentSummary | undefined
): Message["content"] {
  if (!fragment || fragment.length === 0 || typeof storedContent !== "string") {
    return storedContent
  }
  const combinedLength = storedContent.length + fragment.length
  if (combinedLength <= THREAD_MESSAGE_TEXT_LIMIT) {
    return `${storedContent}${fragment.prefix}`
  }
  const retained = `${storedContent}${fragment.prefix}`.slice(0, THREAD_MESSAGE_TEXT_LIMIT)
  return `${retained}\n[truncated ${combinedLength - THREAD_MESSAGE_TEXT_LIMIT} chars]`
}

function rowToMessage(
  row: ThreadMessageRow,
  fragment: FragmentSummary | undefined,
  cancellation: Int32Array
): { message: Message; truncated: boolean } {
  throwIfCancelled(cancellation)
  const createdAt = dateFromTimestamp(row.created_at) ?? new Date()
  const startAt = dateFromTimestamp(row.start_at)
  const endAt = dateFromTimestamp(row.end_at)
  const isError = messageBoolean(row.is_error)
  const parsedToolCallValues = parseJsonValue(row.tool_calls_json, cancellation)
  const toolCalls = parsedToolCalls(parsedToolCallValues)
  const parsedContent = parseJsonValue(row.content_json, cancellation)
  const storedContent = normalizeMessageContent(parsedContent)
  const content = appendFragmentSummary(storedContent, fragment)

  return {
    message: {
      id: row.message_id,
      ...(row.provider_source_id ? { provider_source_id: row.provider_source_id } : {}),
      ...(typeof row.provider_occurrence === "number" && row.provider_occurrence >= 1
        ? { provider_occurrence: row.provider_occurrence }
        : {}),
      role: row.role,
      content,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
      ...(row.tool_call_id ? { tool_call_id: row.tool_call_id } : {}),
      ...(row.name ? { name: row.name } : {}),
      ...(row.status ? { status: row.status } : {}),
      ...(isError !== undefined ? { is_error: isError } : {}),
      ...(typeof row.content_priority === "number" && row.content_priority > 0
        ? { content_priority: row.content_priority }
        : {}),
      ...(row.goal_id ? { goal_id: row.goal_id } : {}),
      ...(row.active_window_id ? { active_window_id: row.active_window_id } : {}),
      created_at: createdAt,
      ...(startAt ? { start_at: startAt } : {}),
      ...(endAt ? { end_at: endAt } : {})
    },
    truncated:
      messageContentNeedsTranscriptClamp(parsedContent) ||
      toolCallsNeedTranscriptClamp(parsedToolCallValues) ||
      Boolean(
        fragment &&
          typeof storedContent === "string" &&
          storedContent.length + fragment.length > THREAD_MESSAGE_TEXT_LIMIT
      )
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

function safeSliceEnd(value: string, end: number): number {
  if (end <= 0 || end >= value.length) return Math.max(0, Math.min(value.length, end))
  const previous = value.charCodeAt(end - 1)
  const next = value.charCodeAt(end)
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? end - 1
    : end
}

function boundedMessagePreviewText(content: Message["content"]): string {
  if (typeof content === "string") return content
  try {
    return JSON.stringify(content)
  } catch {
    return "[无法序列化的结构化消息]"
  }
}

function summarizeOversizedToolCalls(toolCalls: ToolCall[] | undefined): ToolCall[] | undefined {
  if (!toolCalls?.length) return undefined
  return toolCalls.slice(0, 20).map((toolCall) => ({
    id: toolCall.id.slice(0, 512),
    name: toolCall.name.slice(0, 512),
    args: { __hydration_truncated: true }
  }))
}

/**
 * Preserve transcript identity and useful tool names while ensuring one legal
 * structured row cannot create an unbounded worker -> main structured clone.
 */
function projectMessageToByteBudget(
  message: Message,
  byteBudget: number
): { message: Message; truncated: boolean; bytes: number } {
  const fullBytes = jsonBytes(message)
  if (fullBytes <= byteBudget) return { message, truncated: false, bytes: fullBytes }

  const summarizedToolCalls = summarizeOversizedToolCalls(message.tool_calls)
  const previewSource = boundedMessagePreviewText(message.content)
  const base: Message = {
    ...message,
    content: OVERSIZED_MESSAGE_MARKER,
    ...(summarizedToolCalls ? { tool_calls: summarizedToolCalls } : { tool_calls: undefined })
  }
  let low = 0
  let high = previewSource.length
  let projected = base
  let projectedBytes = jsonBytes(projected)
  while (low <= high) {
    const rawMiddle = Math.floor((low + high) / 2)
    const middle = safeSliceEnd(previewSource, rawMiddle)
    const candidate: Message = {
      ...base,
      content: `${previewSource.slice(0, middle)}${OVERSIZED_MESSAGE_MARKER}`
    }
    const candidateBytes = jsonBytes(candidate)
    if (candidateBytes <= byteBudget) {
      projected = candidate
      projectedBytes = candidateBytes
      low = rawMiddle + 1
    } else {
      high = rawMiddle - 1
    }
  }

  if (projectedBytes > byteBudget && summarizedToolCalls) {
    projected = { ...base, tool_calls: undefined }
    projectedBytes = jsonBytes(projected)
  }
  return { message: projected, truncated: true, bytes: projectedBytes }
}

function readCandidates(
  database: DatabaseSync,
  request: ThreadMessageHydrationReadRequest,
  limit: number,
  cancellation: Int32Array,
  legacyMigration: LegacyCheckpointMigrationBoundary | null
): CandidateRow[] {
  const beforeOrdinal = request.options.beforeOrdinal
  const beforeMessageId = request.options.beforeMessageId?.trim() ?? ""
  const targetMessageId = request.options.targetMessageId?.trim() ?? ""
  const anchorMessageId = request.options.anchorMessageId?.trim() ?? ""
  const hasBeforeOrdinal = Number.isSafeInteger(beforeOrdinal) && (beforeOrdinal ?? -1) >= 0
  const hasBeforeMessageId = beforeMessageId.length > 0
  const hasTargetMessageId = targetMessageId.length > 0
  const hasAnchorMessageId = anchorMessageId.length > 0
  const notAfterCreatedAt = normalizeTimestamp(request.options.notAfterCreatedAt)
  const recoveryCheckpointId = request.options.recoveryCheckpointId?.trim() ?? ""
  const legacyMessageCount = Math.max(0, legacyMigration?.totalMessages ?? 0)
  const completedLegacyMigration = legacyMigration?.status === "complete"
  const recoveryTargetsMigratedCheckpoint =
    completedLegacyMigration &&
    Boolean(recoveryCheckpointId) &&
    legacyMigration.checkpointId === recoveryCheckpointId
  const createdAtBoundarySql =
    notAfterCreatedAt === null
      ? ""
      : recoveryTargetsMigratedCheckpoint
        ? "\n           AND m.ordinal < ?"
        : completedLegacyMigration
          ? "\n           AND (m.ordinal < ? OR m.created_at <= ?)"
          : "\n           AND m.created_at <= ?"
  const boundaryBindings: number[] =
    notAfterCreatedAt === null
      ? []
      : recoveryTargetsMigratedCheckpoint
        ? [legacyMessageCount]
        : completedLegacyMigration
          ? [legacyMessageCount, notAfterCreatedAt]
          : [notAfterCreatedAt]
  if (hasBeforeOrdinal !== hasBeforeMessageId) {
    throw new Error(
      "Thread message page cursor requires beforeOrdinal and beforeMessageId together"
    )
  }
  if (hasAnchorMessageId && hasBeforeOrdinal) {
    throw new Error(
      "Thread message page anchorMessageId is mutually exclusive with the backward cursor"
    )
  }
  if (hasTargetMessageId && hasBeforeOrdinal) {
    throw new Error(
      "Thread message page targetMessageId is mutually exclusive with the backward cursor"
    )
  }
  if (hasTargetMessageId && hasAnchorMessageId) {
    throw new Error(
      "Thread message page targetMessageId is mutually exclusive with anchorMessageId"
    )
  }

  // Resolve exact ids separately. Forward reads exclude the anchor body, while targeted reads
  // use the resolved composite tuple to make the target the first candidate regardless of how
  // many legacy rows share its ordinal.
  const exactMessageId = hasTargetMessageId ? targetMessageId : anchorMessageId
  const exactMessage = hasTargetMessageId || hasAnchorMessageId
    ? database
        .prepare(
          `SELECT m.ordinal
           FROM thread_messages AS m
           WHERE m.thread_id = ? AND m.message_id = ?${createdAtBoundarySql}`
        )
        .get(
          request.threadId,
          exactMessageId,
          ...boundaryBindings
        )
    : undefined
  if ((hasTargetMessageId || hasAnchorMessageId) && !exactMessage) {
    throw new Error(
      hasTargetMessageId
        ? "Thread message target-window message was not found"
        : "Thread message forward-page anchor was not found"
    )
  }
  const exactMessageOrdinal =
    hasTargetMessageId || hasAnchorMessageId ? Number(exactMessage?.ordinal) : null
  if (
    (hasTargetMessageId || hasAnchorMessageId) &&
    (!Number.isSafeInteger(exactMessageOrdinal) || (exactMessageOrdinal ?? -1) < 0)
  ) {
    throw new Error(
      hasTargetMessageId
        ? "Thread message target-window message has an invalid ordinal"
        : "Thread message forward-page anchor has an invalid ordinal"
    )
  }

  const statement = database.prepare(
    hasAnchorMessageId
      ? `SELECT m.message_id, m.ordinal,
                1024 +
                CASE
                  WHEN fragments.total_chars IS NOT NULL THEN fragments.total_chars * 4
                  ELSE length(CAST(m.content_json AS BLOB))
                END +
                length(CAST(COALESCE(m.tool_calls_json, '') AS BLOB)) AS estimated_bytes
         FROM thread_messages AS m
         LEFT JOIN thread_message_fragment_states AS fragments
           ON fragments.thread_id = m.thread_id AND fragments.message_id = m.message_id
         WHERE m.thread_id = ?
           AND (m.ordinal > ? OR (m.ordinal = ? AND m.message_id > ?))
           ${createdAtBoundarySql}
         ORDER BY m.ordinal ASC, m.message_id ASC
         LIMIT ?`
      : hasTargetMessageId
        ? `SELECT m.message_id, m.ordinal,
                1024 +
                CASE
                  WHEN fragments.total_chars IS NOT NULL THEN fragments.total_chars * 4
                  ELSE length(CAST(m.content_json AS BLOB))
                END +
                length(CAST(COALESCE(m.tool_calls_json, '') AS BLOB)) AS estimated_bytes
         FROM thread_messages AS m
         LEFT JOIN thread_message_fragment_states AS fragments
           ON fragments.thread_id = m.thread_id AND fragments.message_id = m.message_id
         WHERE m.thread_id = ?
           AND (m.ordinal < ? OR (m.ordinal = ? AND m.message_id <= ?))
           ${createdAtBoundarySql}
         ORDER BY m.ordinal DESC, m.message_id DESC
         LIMIT ?`
        : hasBeforeOrdinal
      ? `SELECT m.message_id, m.ordinal,
                1024 +
                CASE
                  WHEN fragments.total_chars IS NOT NULL THEN fragments.total_chars * 4
                  ELSE length(CAST(m.content_json AS BLOB))
                END +
                length(CAST(COALESCE(m.tool_calls_json, '') AS BLOB)) AS estimated_bytes
         FROM thread_messages AS m
         LEFT JOIN thread_message_fragment_states AS fragments
           ON fragments.thread_id = m.thread_id AND fragments.message_id = m.message_id
         WHERE m.thread_id = ?
           AND (m.ordinal < ? OR (m.ordinal = ? AND m.message_id < ?))
           ${createdAtBoundarySql}
         ORDER BY m.ordinal DESC, m.message_id DESC
         LIMIT ?`
      : `SELECT m.message_id, m.ordinal,
                1024 +
                CASE
                  WHEN fragments.total_chars IS NOT NULL THEN fragments.total_chars * 4
                  ELSE length(CAST(m.content_json AS BLOB))
                END +
                length(CAST(COALESCE(m.tool_calls_json, '') AS BLOB)) AS estimated_bytes
         FROM thread_messages AS m
         LEFT JOIN thread_message_fragment_states AS fragments
           ON fragments.thread_id = m.thread_id AND fragments.message_id = m.message_id
         WHERE m.thread_id = ?
           ${createdAtBoundarySql}
         ORDER BY m.ordinal DESC, m.message_id DESC
         LIMIT ?`
  )
  const bindings: Array<string | number> = hasAnchorMessageId
      ? [
          request.threadId,
          exactMessageOrdinal as number,
          exactMessageOrdinal as number,
          anchorMessageId,
          ...boundaryBindings,
          limit + 1
        ]
      : hasTargetMessageId
        ? [
            request.threadId,
            exactMessageOrdinal as number,
            exactMessageOrdinal as number,
            targetMessageId,
            ...boundaryBindings,
            limit + 1
          ]
      : hasBeforeOrdinal
        ? [
            request.threadId,
            beforeOrdinal as number,
            beforeOrdinal as number,
            beforeMessageId,
            ...boundaryBindings,
            limit + 1
          ]
      : [request.threadId, ...boundaryBindings, limit + 1]
  const rows: CandidateRow[] = []
  for (const raw of statement.iterate(...bindings)) {
    throwIfCancelled(cancellation)
    if (typeof raw.message_id !== "string") continue
    rows.push({
      message_id: raw.message_id,
      ordinal: Number(raw.ordinal) || 0,
      estimated_bytes: Math.max(0, Number(raw.estimated_bytes) || 0)
    })
  }
  return rows
}

function selectCandidates(candidates: CandidateRow[], limit: number, byteBudget: number): {
  selected: CandidateRow[]
  estimatedBytes: number
} {
  const selected: CandidateRow[] = []
  let estimatedBytes = 0
  for (const candidate of candidates) {
    if (selected.length >= limit) break
    if (selected.length > 0 && estimatedBytes + candidate.estimated_bytes > byteBudget) break
    selected.push(candidate)
    estimatedBytes += candidate.estimated_bytes
  }
  return { selected, estimatedBytes }
}

function readRowsById(
  database: DatabaseSync,
  threadId: string,
  messageIds: readonly string[],
  cancellation: Int32Array
): Map<string, ThreadMessageRow> {
  const rows = new Map<string, ThreadMessageRow>()
  const uniqueIds = [...new Set(messageIds.filter(Boolean))]
  for (let offset = 0; offset < uniqueIds.length; offset += 500) {
    const batch = uniqueIds.slice(offset, offset + 500)
    const placeholders = batch.map(() => "?").join(", ")
    const statement = database.prepare(
      `SELECT * FROM thread_messages WHERE thread_id = ? AND message_id IN (${placeholders})`
    )
    for (const raw of statement.iterate(threadId, ...batch)) {
      throwIfCancelled(cancellation)
      if (typeof raw.message_id === "string") {
        rows.set(raw.message_id, raw as unknown as ThreadMessageRow)
      }
    }
  }
  return rows
}

function readFragmentSummaries(
  database: DatabaseSync,
  threadId: string,
  messageIds: readonly string[],
  cancellation: Int32Array
): Map<string, FragmentSummary> {
  const fragments = new Map<string, FragmentSummary>()
  const uniqueIds = [...new Set(messageIds.filter(Boolean))]
  for (let offset = 0; offset < uniqueIds.length; offset += 500) {
    const batch = uniqueIds.slice(offset, offset + 500)
    const placeholders = batch.map(() => "?").join(", ")
    const statement = database.prepare(
      `SELECT message_id, content_text
       FROM thread_message_fragments
       WHERE thread_id = ? AND message_id IN (${placeholders})
       ORDER BY message_id ASC, fragment_id ASC`
    )
    for (const raw of statement.iterate(threadId, ...batch)) {
      throwIfCancelled(cancellation)
      if (typeof raw.message_id !== "string" || typeof raw.content_text !== "string") continue
      const existing = fragments.get(raw.message_id) ?? { prefix: "", length: 0 }
      const remainingPrefix = Math.max(0, THREAD_MESSAGE_TEXT_LIMIT - existing.prefix.length)
      fragments.set(raw.message_id, {
        prefix:
          remainingPrefix > 0
            ? `${existing.prefix}${raw.content_text.slice(0, remainingPrefix)}`
            : existing.prefix,
        length: existing.length + raw.content_text.length
      })
    }
  }
  return fragments
}

function hasVisibleThreadConversation(
  database: DatabaseSync,
  threadId: string,
  cancellation: Int32Array
): boolean {
  const statement = database.prepare(
    `SELECT role,
            length(CAST(content_json AS BLOB)) AS content_bytes,
            CASE WHEN length(CAST(content_json AS BLOB)) <= ? THEN content_json ELSE NULL END AS content_json
     FROM thread_messages
     WHERE thread_id = ?
     LIMIT ?`
  )
  let scannedRows = 0
  let scannedBytes = 0
  for (const raw of statement.iterate(
    THREAD_CONVERSATION_PRESENCE_ROW_BYTE_LIMIT,
    threadId,
    THREAD_CONVERSATION_PRESENCE_SCAN_LIMIT + 1
  )) {
    throwIfCancelled(cancellation)
    if (scannedRows >= THREAD_CONVERSATION_PRESENCE_SCAN_LIMIT) return true
    scannedRows += 1
    const contentBytes = Number(raw.content_bytes)
    if (
      !Number.isFinite(contentBytes) ||
      contentBytes < 0 ||
      contentBytes > THREAD_CONVERSATION_PRESENCE_ROW_BYTE_LIMIT ||
      scannedBytes + contentBytes > THREAD_CONVERSATION_PRESENCE_SCAN_BYTE_BUDGET ||
      typeof raw.content_json !== "string"
    ) {
      return true
    }
    scannedBytes += contentBytes
    if (
      typeof raw.role === "string" &&
      isRestorableConversationTranscriptMessage(
        raw.role,
        parseJsonValue(raw.content_json, cancellation)
      )
    ) {
      return true
    }
  }

  const hasGoalEventTable = database
    .prepare(
      `SELECT 1
       FROM sqlite_master
       WHERE type = 'table' AND name = 'thread_goal_events'
       LIMIT 1`
    )
    .get()
  if (!hasGoalEventTable) return false
  const goalEventStatement = database.prepare(
    `SELECT length(CAST(message AS BLOB)) AS message_bytes,
            CASE WHEN length(CAST(message AS BLOB)) <= ? THEN message ELSE NULL END AS message
     FROM thread_goal_events
     WHERE thread_id = ?
       AND substr(trim(message), 1, length(?)) = ?
     LIMIT ?`
  )
  scannedRows = 0
  for (const raw of goalEventStatement.iterate(
    THREAD_CONVERSATION_PRESENCE_ROW_BYTE_LIMIT,
    threadId,
    GOAL_USER_MESSAGE_EVENT_PREFIX,
    GOAL_USER_MESSAGE_EVENT_PREFIX,
    THREAD_CONVERSATION_PRESENCE_SCAN_LIMIT + 1
  )) {
    throwIfCancelled(cancellation)
    if (scannedRows >= THREAD_CONVERSATION_PRESENCE_SCAN_LIMIT) return true
    scannedRows += 1
    const messageBytes = Number(raw.message_bytes)
    if (
      !Number.isFinite(messageBytes) ||
      messageBytes < 0 ||
      messageBytes > THREAD_CONVERSATION_PRESENCE_ROW_BYTE_LIMIT ||
      scannedBytes + messageBytes > THREAD_CONVERSATION_PRESENCE_SCAN_BYTE_BUDGET ||
      typeof raw.message !== "string"
    ) {
      return true
    }
    scannedBytes += messageBytes
    if (isVisibleGoalUserEventMessage(raw.message)) return true
  }
  return false
}

function getLegacyCheckpointMigration(
  database: DatabaseSync,
  threadId: string
): LegacyCheckpointMigrationBoundary | null {
  const hasMigrationTable = database
    .prepare(
      `SELECT 1
       FROM sqlite_master
       WHERE type = 'table' AND name = 'legacy_checkpoint_transcript_migrations'
       LIMIT 1`
    )
    .get()
  if (!hasMigrationTable) return null
  const row = database
    .prepare(
      `SELECT checkpoint_id, total_messages, status
       FROM legacy_checkpoint_transcript_migrations
       WHERE thread_id = ?
       LIMIT 1`
    )
    .get(threadId) as
    | { checkpoint_id?: unknown; total_messages?: unknown; status?: unknown }
    | undefined
  if (!row || typeof row.checkpoint_id !== "string") return null
  return {
    checkpointId: row.checkpoint_id,
    totalMessages: Math.max(0, Number(row.total_messages) || 0),
    status: row.status === "complete" ? "complete" : "migrating"
  }
}

export function openThreadMessageHydrationDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    enableForeignKeyConstraints: false,
    timeout: 1_000
  })
  database.exec("PRAGMA query_only = ON")
  return database
}

export function readThreadMessagesPage(
  database: DatabaseSync,
  request: ThreadMessageHydrationReadRequest
): { page: import("../types").ThreadMessagesPage; stats: ThreadMessageHydrationWorkerStats } {
  const startedAt = performance.now()
  const cancellation = new Int32Array(request.cancellationBuffer)
  const limit = normalizePageLimit(request.options.limit)
  const byteBudget = normalizeByteBudget(request.options.byteBudget)
  const isForwardPage = Boolean(request.options.anchorMessageId?.trim())
  throwIfCancelled(cancellation)

  database.exec("BEGIN")
  try {
    const bucket = database
      .prepare(
        `SELECT message_count
         FROM thread_message_buckets
         WHERE thread_id = ?`
      )
      .get(request.threadId)
    const total = Math.max(0, Number(bucket?.message_count) || 0)
    const hasVisibleMessages = request.options.includeVisibleMessagePresence
      ? hasVisibleThreadConversation(database, request.threadId, cancellation)
      : undefined
    const legacyCheckpointMigration = request.options.includeVisibleMessagePresence
      ? getLegacyCheckpointMigration(database, request.threadId)
      : null
    const legacyCheckpointMigrationStatus = request.options.includeVisibleMessagePresence
      ? (legacyCheckpointMigration?.status ?? null)
      : undefined
    const candidates = readCandidates(
      database,
      request,
      limit,
      cancellation,
      legacyCheckpointMigration
    )
    const { selected, estimatedBytes } = selectCandidates(candidates, limit, byteBudget)
    const rowsById = readRowsById(
      database,
      request.threadId,
      selected.map((candidate) => candidate.message_id),
      cancellation
    )
    const fragments = readFragmentSummaries(
      database,
      request.threadId,
      selected.map((candidate) => candidate.message_id),
      cancellation
    )
    const orderedMessages: Message[] = []
    const returnedCandidates: CandidateRow[] = []
    const truncatedMessageIds: string[] = []
    let responseBytes = THREAD_MESSAGE_HYDRATION_RESPONSE_OVERHEAD
    for (const candidate of selected) {
      throwIfCancelled(cancellation)
      const row = rowsById.get(candidate.message_id)
      if (!row) continue
      const hydrated = rowToMessage(row, fragments.get(candidate.message_id), cancellation)
      const remaining = Math.max(1, byteBudget - responseBytes)
      const projected = projectMessageToByteBudget(hydrated.message, remaining)
      if (orderedMessages.length > 0 && projected.truncated) break
      orderedMessages.push(projected.message)
      returnedCandidates.push(candidate)
      responseBytes += projected.bytes + 1
      if (projected.truncated || hydrated.truncated) {
        truncatedMessageIds.push(candidate.message_id)
      }
    }
    throwIfCancelled(cancellation)
    database.exec("COMMIT")
    const oldest = returnedCandidates.at(-1)
    const hasMore = returnedCandidates.length < candidates.length
    return {
      page: {
        messages: isForwardPage ? orderedMessages : orderedMessages.reverse(),
        beforeOrdinal: !isForwardPage && hasMore && oldest ? oldest.ordinal : null,
        beforeMessageId:
          !isForwardPage && hasMore && oldest ? oldest.message_id : null,
        hasMore,
        total,
        ...(hasVisibleMessages !== undefined ? { hasVisibleMessages } : {}),
        ...(legacyCheckpointMigrationStatus !== undefined
          ? { legacyCheckpointMigrationStatus }
          : {}),
        ...(isForwardPage
          ? { verifiedAnchorMessageId: request.options.anchorMessageId?.trim() }
          : {}),
        ...(truncatedMessageIds.length > 0 ? { truncatedMessageIds } : {})
      },
      stats: {
        durationMs: performance.now() - startedAt,
        scannedCandidates: candidates.length,
        selectedMessages: orderedMessages.length,
        estimatedBytes
      }
    }
  } catch (error) {
    try {
      database.exec("ROLLBACK")
    } catch {
      // Preserve the read/cancellation failure.
    }
    throw error
  }
}
