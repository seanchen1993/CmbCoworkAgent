import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { decodeTranscriptRecoveryIntegrity } from "../../shared/transcript-recovery-integrity"
import { hasPendingLegacyMessageTimes } from "../checkpointer/legacy-message-times"
import {
  beginLegacyCheckpointRecoveryHash, legacyCheckpointReplayRowSql, NATIVE_DURABLE_CHECKPOINT_ID
} from "../checkpointer/legacy-checkpoint-source"
import { EMPTY_SQLITE_RECOVERY_FAMILY_KEY, sqliteRecoveryFamilyKey } from "../db/sqlite-recovery-family"
import { hasThreadMessageFragmentGenerations, publishedThreadMessageFragmentsSql } from "../db/thread-message-fragment-storage"
import {
  clampToolCalls,
  messageContentNeedsTranscriptClamp,
  normalizeMessageContent,
  THREAD_MESSAGE_TEXT_LIMIT,
  toolCallsNeedTranscriptClamp
} from "../../shared/thread-message-content"
import type { Message, ToolCall } from "../types"
import type {
  ThreadMessageHydrationWorkerStats,
  ThreadMessageHydrationReadRequest
} from "./protocol"
import { THREAD_MESSAGE_HYDRATION_CANCELLED } from "./protocol"
import { THREAD_MESSAGE_BEFORE_CURSOR_SQL, threadMessageBeforeCursorBindings } from "./order-sql"
import { isRestorableConversationTranscriptMessage } from "../../shared/checkpoint-transcript"
import { normalizeTranscriptReasoning, normalizeVisibleReasoningText } from "../../shared/transcript-reasoning"
import {
  GOAL_USER_MESSAGE_EVENT_PREFIX,
  GOAL_USER_EVENT_MESSAGE_ID_PREFIX,
  isVisibleGoalUserEventMessage
} from "../../shared/goal-events"
import { THREAD_SEARCH_GOAL_EVENT_SQL } from "../thread-search/goal-event"

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
  reasoning: string | null
  tool_calls_json: string | null
  tool_call_id: string | null
  name: string | null
  status: string | null
  is_error: number | null
  content_priority: number | null
  recovery_integrity?: number | null
  goal_id: string | null
  active_window_id: string | null
  created_at: number
  start_at: number | null
  end_at: number | null
  ordinal: number
}

interface CandidateRow {
  message_id: string
  missingSourceRow?: boolean
  sourceLogicalId?: string
  sourceContentKey?: string
  ordinal: number
  estimated_bytes: number
}

interface FragmentSummary {
  prefix: string
  length: number
}

interface LegacyCheckpointMigrationBoundary {
  checkpointId: string
  sourceKey: string | null
  totalMessages: number
  hasSourceIds: boolean
  usesPhysicalSourceIds: boolean
  requiresContentProof: boolean
  recoveryRevisionMismatch: boolean
  unverifiedRecoveryRevision: boolean
  nativeTranscript: boolean
  status: "migrating" | "complete"
}

function cannotProveRecoverySource(
  migration: LegacyCheckpointMigrationBoundary | null,
  checkpointId: string | undefined
): boolean {
  return Boolean(checkpointId && migration && !migration.hasSourceIds &&
    (migration.recoveryRevisionMismatch || (!migration.nativeTranscript &&
      (migration.unverifiedRecoveryRevision || migration.checkpointId !== checkpointId))))
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

function messageBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  return undefined
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
  const toolCalls = clampToolCalls(parsedToolCallValues)
  const parsedContent = parseJsonValue(row.content_json, cancellation)
  let omittedChars = 0
  let content: Message["content"]
  if (typeof parsedContent === "string") {
    const head = parsedContent.slice(0, THREAD_MESSAGE_TEXT_LIMIT)
    content = head + (fragment?.prefix.slice(0, THREAD_MESSAGE_TEXT_LIMIT - head.length) ?? "")
    omittedChars = Math.max(0, parsedContent.length + (fragment?.length ?? 0) - THREAD_MESSAGE_TEXT_LIMIT)
  } else {
    content = normalizeMessageContent(parsedContent)
  }

  return {
    message: {
      id: row.message_id,
      ordinal: row.ordinal,
      recovery_integrity: decodeTranscriptRecoveryIntegrity(row.recovery_integrity),
      ...(row.provider_source_id ? { provider_source_id: row.provider_source_id } : {}),
      ...(typeof row.provider_occurrence === "number" && row.provider_occurrence >= 1
        ? { provider_occurrence: row.provider_occurrence }
        : {}),
      role: row.role,
      content,
      ...(omittedChars > 0 ? { content_preview_notice: `[truncated ${omittedChars} chars]` } : {}),
      ...(row.reasoning ? { reasoning: normalizeTranscriptReasoning(row.reasoning) } : {}),
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
      omittedChars > 0
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
  const summaries = toolCalls.filter((toolCall) =>
    typeof toolCall.id === "string" && Boolean(toolCall.id.trim()) &&
    typeof toolCall.name === "string" && Boolean(toolCall.name.trim())
  ).slice(0, 20).map((toolCall) => ({
    id: toolCall.id.slice(0, 512),
    name: toolCall.name.slice(0, 512),
    args: { __hydration_truncated: true }
  }))
  return summaries.length ? summaries : undefined
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
  if (jsonBytes(message.content) < byteBudget) {
    // Preserve the original body and its block coordinates when only another
    // field makes the row too large for this page.
    const structured = { ...message, tool_calls: summarizedToolCalls }
    const withoutTools = { ...message, tool_calls: undefined }
    for (const candidate of [structured, withoutTools]) {
      const bytes = jsonBytes(candidate)
      if (bytes <= byteBudget) return { message: candidate, truncated: true, bytes }
    }
    const shortenedReasoning = normalizeVisibleReasoningText(message.reasoning)
      ? OVERSIZED_MESSAGE_MARKER : undefined
    for (const base of [structured, withoutTools]) {
      const candidate = { ...base, reasoning: shortenedReasoning }
      const bytes = jsonBytes(candidate)
      if (bytes <= byteBudget) return { message: candidate, truncated: true, bytes }
    }
  }

  const previewSource = boundedMessagePreviewText(message.content)
  const reasoningSource = normalizeVisibleReasoningText(message.reasoning)
  const base: Message = {
    ...message,
    content: OVERSIZED_MESSAGE_MARKER,
    content_preview_notice: undefined,
    reasoning: reasoningSource ? OVERSIZED_MESSAGE_MARKER : undefined,
    ...(summarizedToolCalls ? { tool_calls: summarizedToolCalls } : { tool_calls: undefined })
  }
  let low = 0
  let high = Math.max(previewSource.length, reasoningSource.length)
  let projected = base
  let projectedBytes = jsonBytes(projected)
  while (low <= high) {
    const rawMiddle = Math.floor((low + high) / 2)
    const middle = safeSliceEnd(previewSource, rawMiddle)
    const candidate: Message = {
      ...base,
      content: `${previewSource.slice(0, middle)}${OVERSIZED_MESSAGE_MARKER}`,
      ...(reasoningSource
        ? {
            reasoning: `${reasoningSource.slice(0, safeSliceEnd(reasoningSource, rawMiddle))}${OVERSIZED_MESSAGE_MARKER}`
          }
        : {})
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
): { rows: CandidateRow[]; verifiedAnchor?: import("../types").ThreadMessagesPage["verifiedAnchor"] } {
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
  if (cannotProveRecoverySource(legacyMigration, recoveryCheckpointId)) return { rows: [] }
  const legacyMessageCount = Math.max(0, legacyMigration?.totalMessages ?? 0)
  const completedLegacyMigration = legacyMigration?.status === "complete"
  const recoveryTargetsMigratedCheckpoint =
    completedLegacyMigration &&
    Boolean(recoveryCheckpointId) &&
    legacyMigration.checkpointId === recoveryCheckpointId
  const recoveryUsesSourceIds = Boolean(recoveryCheckpointId && legacyMigration?.hasSourceIds)
  const matchesSourceRow = (source: string, message: string) => legacyMigration?.usesPhysicalSourceIds
    ? `((${source}.physical_replay_key IS NULL AND ${source}.message_id = ${message}.message_id)
      OR ${message}.rowid = ${legacyCheckpointReplayRowSql(`${source}.thread_id`, `${source}.physical_replay_key`)})`
    : `${source}.message_id = ${message}.message_id`
  const createdAtBoundarySql =
    notAfterCreatedAt === null
      ? ""
      : recoveryUsesSourceIds
        ? `\n           AND EXISTS (SELECT 1 FROM legacy_checkpoint_transcript_source_ids AS source
          WHERE source.thread_id = m.thread_id AND source.checkpoint_id = ?
            AND ${matchesSourceRow("source", "m")})`
      : recoveryTargetsMigratedCheckpoint
        ? "\n           AND m.ordinal < ?"
        : completedLegacyMigration && !legacyMigration.hasSourceIds && !legacyMigration.nativeTranscript
          ? "\n           AND (m.ordinal < ? OR m.created_at <= ?)"
          : "\n           AND m.created_at <= ?"
  const boundaryBindings: Array<string | number> =
    notAfterCreatedAt === null
      ? []
      : recoveryUsesSourceIds
        ? [recoveryCheckpointId]
      : recoveryTargetsMigratedCheckpoint
        ? [legacyMessageCount]
        : completedLegacyMigration && !legacyMigration.hasSourceIds && !legacyMigration.nativeTranscript
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
  if (recoveryUsesSourceIds && !hasBeforeOrdinal && !hasTargetMessageId && !hasAnchorMessageId) {
    const source = database.prepare(`
      SELECT COALESCE(m.message_id, original.message_id) AS message_id, m.ordinal,
        m.message_id IS NULL AS missing_source_row,
        original.message_id AS source_logical_id, original.content_key AS source_content_key,
        1024 + CASE WHEN fragments.total_chars IS NOT NULL THEN fragments.total_chars * 4
          ELSE octet_length(m.content_json) END
          + COALESCE(octet_length(m.reasoning), 0)
          + COALESCE(octet_length(m.tool_calls_json), 0) AS estimated_bytes
      FROM legacy_checkpoint_transcript_source_ids AS original
      LEFT JOIN thread_messages AS m ON m.thread_id = original.thread_id
        AND ${matchesSourceRow("original", "m")}
      LEFT JOIN thread_message_fragment_states AS fragments
        ON fragments.thread_id = m.thread_id AND fragments.message_id = m.message_id
      WHERE original.thread_id = ? AND original.checkpoint_id = ?
      ORDER BY original.source_index DESC LIMIT ?`)
    const rows: CandidateRow[] = []
    for (const row of source.iterate(request.threadId, recoveryCheckpointId, limit + 1)) {
      throwIfCancelled(cancellation)
      if (typeof row.message_id !== "string") continue
      rows.push({
        message_id: row.message_id,
        ...(row.missing_source_row === 1 && { missingSourceRow: true }),
        ...(typeof row.source_logical_id === "string" && { sourceLogicalId: row.source_logical_id }),
        ...(typeof row.source_content_key === "string" && { sourceContentKey: row.source_content_key }),
        ordinal: Number(row.ordinal) || 0,
        estimated_bytes: Math.max(0, Number(row.estimated_bytes) || 0)
      })
    }
    return { rows }
  }

  // Resolve exact ids separately. Forward reads exclude the anchor body, while targeted reads
  // use the resolved composite tuple to make the target the first candidate regardless of how
  // many legacy rows share its ordinal.
  const exactMessageId = hasTargetMessageId ? targetMessageId : anchorMessageId
  const exactMessage = hasTargetMessageId || hasAnchorMessageId
    ? database
        .prepare(
          `SELECT m.ordinal, m.created_at
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
                length(CAST(COALESCE(m.reasoning, '') AS BLOB)) +
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
                length(CAST(COALESCE(m.reasoning, '') AS BLOB)) +
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
                length(CAST(COALESCE(m.reasoning, '') AS BLOB)) +
                length(CAST(COALESCE(m.tool_calls_json, '') AS BLOB)) AS estimated_bytes
         FROM thread_messages AS m
         LEFT JOIN thread_message_fragment_states AS fragments
           ON fragments.thread_id = m.thread_id AND fragments.message_id = m.message_id
         WHERE m.thread_id = ?
           ${THREAD_MESSAGE_BEFORE_CURSOR_SQL}
           ${createdAtBoundarySql}
         ORDER BY m.ordinal DESC, m.message_id DESC
         LIMIT ?`
      : `SELECT m.message_id, m.ordinal,
                1024 +
                CASE
                  WHEN fragments.total_chars IS NOT NULL THEN fragments.total_chars * 4
                  ELSE length(CAST(m.content_json AS BLOB))
                END +
                length(CAST(COALESCE(m.reasoning, '') AS BLOB)) +
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
            ...threadMessageBeforeCursorBindings(request.threadId, beforeMessageId, beforeOrdinal as number),
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
  return {
    rows,
    ...(hasAnchorMessageId && exactMessageOrdinal !== null && {
      verifiedAnchor: {
        messageId: anchorMessageId,
        ordinal: exactMessageOrdinal,
        ...(typeof exactMessage?.created_at === "number" && { createdAt: exactMessage.created_at })
      }
    })
  }
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
  cancellation: Int32Array,
  onFragment?: (messageId: string, text: string) => void
): Map<string, FragmentSummary> {
  const fragments = new Map<string, FragmentSummary>()
  const uniqueIds = [...new Set(messageIds.filter(Boolean))]
  for (let offset = 0; offset < uniqueIds.length; offset += 500) {
    const batch = uniqueIds.slice(offset, offset + 500)
    const placeholders = batch.map(() => "?").join(", ")
    const statement = database.prepare(
      `SELECT f.message_id, f.content_text
       FROM thread_message_fragments AS f
       WHERE f.thread_id = ? AND f.message_id IN (${placeholders})
         ${hasThreadMessageFragmentGenerations(database) ? `AND ${publishedThreadMessageFragmentsSql("f")}` : ""}
       ORDER BY f.message_id ASC, f.fragment_id ASC`
    )
    for (const raw of statement.iterate(threadId, ...batch)) {
      throwIfCancelled(cancellation)
      if (typeof raw.message_id !== "string" || typeof raw.content_text !== "string") continue
      onFragment?.(raw.message_id, raw.content_text)
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
  threadId: string,
  options: ThreadMessageHydrationReadRequest["options"]
): LegacyCheckpointMigrationBoundary | null {
  const recoveryCheckpointId = options.recoveryCheckpointId?.trim()
  const hasMigrationTable = database
    .prepare(
      `SELECT 1
       FROM sqlite_master
       WHERE type = 'table' AND name = 'legacy_checkpoint_transcript_migrations'
       LIMIT 1`
    )
    .get()
  if (!hasMigrationTable) return null
  const hasTimingSource = database.prepare("PRAGMA table_info(legacy_checkpoint_transcript_migrations)").all()
    .some((column) => column.name === "timing_checkpoint_id")
  const row = database
    .prepare(
      `SELECT checkpoint_id, total_messages, status, source_key,
         ${hasTimingSource ? "timing_checkpoint_id" : "NULL"} AS timing_checkpoint_id
       FROM legacy_checkpoint_transcript_migrations
       WHERE thread_id = ?
       LIMIT 1`
    )
    .get(threadId)
  if (!row || typeof row.checkpoint_id !== "string") return null
  const hasTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
  const verifiedSource = recoveryCheckpointId && hasTable.get("legacy_checkpoint_transcript_sources")
    ? database.prepare(`SELECT transcript_revision FROM legacy_checkpoint_transcript_sources
        WHERE thread_id = ? AND checkpoint_id = ?`).get(threadId, recoveryCheckpointId)
    : undefined
  const recoveryRevisionMismatch = Boolean(verifiedSource &&
    (verifiedSource.transcript_revision ?? null) !== (options.recoveryTranscriptRevision ?? null))
  const unverifiedRecoveryRevision = Boolean(options.recoveryTranscriptRevision && !verifiedSource)
  const hasSourceIds = Boolean(recoveryCheckpointId && !recoveryRevisionMismatch && !unverifiedRecoveryRevision && (verifiedSource ||
    (row.status === "complete" && row.checkpoint_id === recoveryCheckpointId &&
      hasTable.get("legacy_checkpoint_transcript_source_ids") &&
      database.prepare(`SELECT 1 FROM legacy_checkpoint_transcript_source_ids
        WHERE thread_id = ? AND checkpoint_id = ? LIMIT 1`).get(threadId, recoveryCheckpointId))
  ))
  return {
    checkpointId: row.checkpoint_id,
    sourceKey: typeof row.source_key === "string" ? row.source_key : null,
    totalMessages: Math.max(0, Number(row.total_messages) || 0),
    hasSourceIds,
    usesPhysicalSourceIds: hasSourceIds &&
      Boolean(database.prepare(`SELECT 1 FROM pragma_table_info('legacy_checkpoint_transcript_source_ids')
        WHERE name = 'physical_replay_key'`).get()),
    requiresContentProof: Boolean(verifiedSource && hasSourceIds),
    recoveryRevisionMismatch,
    unverifiedRecoveryRevision,
    nativeTranscript: row.checkpoint_id === NATIVE_DURABLE_CHECKPOINT_ID ||
      row.timing_checkpoint_id === NATIVE_DURABLE_CHECKPOINT_ID,
    status: row.status === "complete" ? "complete" : "migrating"
  }
}

function legacySourceNeedsVerification(
  migration: LegacyCheckpointMigrationBoundary | null,
  { threadId, checkpointDirectory, options }: ThreadMessageHydrationReadRequest
): boolean {
  // Snapshot repair uses the copied checkpoint's exact durable membership and
  // integrity. A broken source file must still be repairable from that copy.
  if (migration?.status !== "complete" || options.recoveryCheckpointId ||
      !checkpointDirectory || !/^[a-zA-Z0-9_-]+$/.test(threadId))
    return false
  try {
    const source = sqliteRecoveryFamilyKey(join(checkpointDirectory, `${threadId}.sqlite`))
    return source !== EMPTY_SQLITE_RECOVERY_FAMILY_KEY && source !== migration.sourceKey
  } catch {
    return true
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

function readResidentOrdinals(
  database: DatabaseSync, threadId: string, ids: readonly string[], byteBudget: number
): NonNullable<import("../types").ThreadMessagesPage["residentOrdinals"]> {
  if (!ids.length) return []
  const anchors = database.prepare(`SELECT message_id, ordinal FROM thread_messages
    WHERE thread_id = ? AND message_id IN (${ids.map(() => "?").join(", ")})`)
  const byId = new Map(anchors.all(threadId, ...ids).map((row) => [String(row.message_id), Number(row.ordinal)]))
  const result: NonNullable<import("../types").ThreadMessagesPage["residentOrdinals"]> = []
  let goalEvent: ReturnType<DatabaseSync["prepare"]> | undefined
  let bytes = 1
  for (const id of ids) {
    let ordinal = byId.get(id) ?? null
    let goalAnchorId: string | undefined
    if (ordinal === null && id.startsWith(GOAL_USER_EVENT_MESSAGE_ID_PREFIX)) {
      const suffix = id.slice(GOAL_USER_EVENT_MESSAGE_ID_PREFIX.length)
      const eventId = Number(suffix)
      if (/^\d{1,16}$/.test(suffix) && Number.isSafeInteger(eventId)) {
        goalEvent ??= database.prepare(THREAD_SEARCH_GOAL_EVENT_SQL)
        const event = goalEvent.get(threadId, eventId)
        if (typeof event?.message === "string" && event.oversized_scope !== 1 &&
            isVisibleGoalUserEventMessage(event.message) && typeof event.transcript_ordinal === "number" &&
            typeof event.transcript_message_id === "string") {
          ordinal = event.transcript_ordinal
          goalAnchorId = event.transcript_message_id
        }
      }
    }
    const entry: (typeof result)[number] = goalAnchorId ? [id, ordinal, goalAnchorId] : [id, ordinal]
    const size = jsonBytes(entry) + 1
    if (bytes + size > byteBudget) continue
    result.push(entry)
    bytes += size
  }
  return result
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
    const legacyCheckpointMigration = request.options.includeVisibleMessagePresence || request.options.recoveryCheckpointId
      ? getLegacyCheckpointMigration(database, request.threadId, request.options)
      : null
    const legacyCheckpointMigrationStatus = request.options.includeVisibleMessagePresence
      ? (request.options.recoveryCheckpointId && legacyCheckpointMigration?.hasSourceIds
        ? "complete" : legacyCheckpointMigration?.status ?? null)
      : undefined
    const sourceNeedsVerification = legacySourceNeedsVerification(legacyCheckpointMigration, request)
    const legacyMessageTimesPending =
      legacyCheckpointMigration?.status === "complete" &&
      hasPendingLegacyMessageTimes(
        database,
        request.threadId,
        legacyCheckpointMigration.checkpointId
      )
    const { rows: candidates, verifiedAnchor } = readCandidates(
      database,
      request,
      limit,
      cancellation,
      legacyCheckpointMigration
    )
    const residentOrdinals = request.options.targetMessageId && request.options.residentMessageIds
      ? readResidentOrdinals(database, request.threadId, request.options.residentMessageIds, Math.floor(byteBudget / 4))
      : undefined
    const residentBytes = residentOrdinals ? jsonBytes(residentOrdinals) : 0
    const { selected, estimatedBytes } = selectCandidates(candidates, limit, byteBudget - residentBytes)
    const physicalIds = selected.filter((candidate) => !candidate.missingSourceRow).map((candidate) => candidate.message_id)
    const rowsById = readRowsById(
      database,
      request.threadId,
      physicalIds,
      cancellation
    )
    const expectedHashes = new Map<string, string>()
    const logicalIds = new Map<string, string>()
    const contentHashes = new Map<string, NonNullable<ReturnType<typeof beginLegacyCheckpointRecoveryHash>>>()
    if (legacyCheckpointMigration?.requiresContentProof && request.options.recoveryCheckpointId) {
      const aliases = legacyCheckpointMigration.usesPhysicalSourceIds
      const verifiedCandidates = new Map<string, CandidateRow | null>()
      for (const candidate of selected) {
        if (candidate.sourceLogicalId && !candidate.missingSourceRow) {
          verifiedCandidates.set(candidate.message_id, verifiedCandidates.has(candidate.message_id) ? null : candidate)
        }
      }
      const expected = database.prepare(`SELECT message_id, content_key FROM legacy_checkpoint_transcript_source_ids
        WHERE thread_id = $threadId AND checkpoint_id = $checkpointId AND message_id = $messageId
          ${aliases ? "AND physical_replay_key IS NULL" : ""}
        ${aliases ? `UNION ALL SELECT message_id, content_key FROM legacy_checkpoint_transcript_source_ids
          WHERE thread_id = $threadId AND checkpoint_id = $checkpointId AND physical_replay_key IS NOT NULL
            AND ${legacyCheckpointReplayRowSql("$threadId", "physical_replay_key")} = (
              SELECT rowid FROM thread_messages WHERE thread_id = $threadId AND message_id = $messageId
            )` : ""}
        LIMIT 2`)
      for (const row of rowsById.values()) {
        throwIfCancelled(cancellation)
        let source = verifiedCandidates.get(row.message_id)
        if (!verifiedCandidates.size) {
          const bindings = { threadId: request.threadId, checkpointId: request.options.recoveryCheckpointId,
            messageId: row.message_id }
          const records = expected.all(bindings)
          const record = records[0]
          if (records.length === 1 && typeof record?.message_id === "string" && typeof record.content_key === "string") {
            source = { message_id: row.message_id, ordinal: row.ordinal, estimated_bytes: 0,
              sourceLogicalId: record.message_id, sourceContentKey: record.content_key }
          }
        }
        if (typeof source?.sourceContentKey !== "string" || typeof source.sourceLogicalId !== "string") continue
        const hash = beginLegacyCheckpointRecoveryHash({
          messageId: source.sourceLogicalId, providerSourceId: row.provider_source_id,
          providerOccurrence: row.provider_occurrence, role: row.role, contentJson: row.content_json,
          reasoning: row.reasoning, toolCallsJson: row.tool_calls_json, toolCallId: row.tool_call_id,
          name: row.name, status: row.status, isError: row.is_error
        })
        if (!hash) continue
        expectedHashes.set(row.message_id, source.sourceContentKey)
        logicalIds.set(row.message_id, source.sourceLogicalId)
        contentHashes.set(row.message_id, hash)
      }
    }
    const fragments = readFragmentSummaries(
      database,
      request.threadId,
      physicalIds,
      cancellation,
      contentHashes.size ? (id, fragment) => contentHashes.get(id)?.update(fragment, "utf16le") : undefined
    )
    const matchesCheckpointContent = !legacyCheckpointMigration?.requiresContentProof ||
      (selected.length === rowsById.size && rowsById.size === contentHashes.size &&
        Array.from(contentHashes).every(([id, hash]) =>
        hash.digest("hex") === expectedHashes.get(id)))
    const orderedMessages: Message[] = []
    const returnedCandidates: CandidateRow[] = []
    const truncatedMessageIds: string[] = []
    let responseBytes = THREAD_MESSAGE_HYDRATION_RESPONSE_OVERHEAD + residentBytes
    for (const candidate of selected) {
      throwIfCancelled(cancellation)
      if (candidate.missingSourceRow) continue
      const row = rowsById.get(candidate.message_id)
      if (!row) continue
      const hydrated = rowToMessage(row, fragments.get(candidate.message_id), cancellation)
      const logicalId = logicalIds.get(candidate.message_id)
      if (logicalId !== undefined && logicalId !== hydrated.message.id) hydrated.message.id = logicalId
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
    const head = request.options.targetMessageId ? returnedCandidates[0] : undefined
    const hasNewerMessages = head && Boolean(database.prepare(`SELECT 1 FROM thread_messages
      WHERE thread_id = ? AND (ordinal, message_id) > (?, ?) LIMIT 1`)
      .get(request.threadId, head.ordinal, head.message_id))
    throwIfCancelled(cancellation)
    database.exec("COMMIT")
    const oldest = returnedCandidates.at(-1)
    const hasMore = returnedCandidates.length < candidates.length
    return {
      page: {
        messages: isForwardPage ? orderedMessages : orderedMessages.reverse(),
        ...(residentOrdinals ? { residentOrdinals } : {}),
        ...(hasNewerMessages !== undefined ? { hasNewerMessages } : {}),
        beforeOrdinal: !isForwardPage && hasMore && oldest ? oldest.ordinal : null,
        beforeMessageId: !isForwardPage && hasMore && oldest ? oldest.message_id : null,
        hasMore,
        total,
        ...(legacyMessageTimesPending ? { legacyMessageTimesPending: true } : {}),
        ...(hasVisibleMessages !== undefined ? { hasVisibleMessages } : {}),
        ...(legacyCheckpointMigrationStatus !== undefined
          ? { legacyCheckpointMigrationStatus }
          : {}),
        ...(sourceNeedsVerification ? { legacyCheckpointSourceNeedsVerification: true } : {}),
        ...(verifiedAnchor ? { verifiedAnchorMessageId: verifiedAnchor.messageId, verifiedAnchor } : {}),
        ...(truncatedMessageIds.length > 0 ? { truncatedMessageIds } : {}),
        ...(request.options.recoveryCheckpointId
          ? {
              recoveryIntegrity:
                !cannotProveRecoverySource(legacyCheckpointMigration, request.options.recoveryCheckpointId) &&
                matchesCheckpointContent &&
                truncatedMessageIds.length === 0 &&
                orderedMessages.every((message) => message.recovery_integrity === "verified")
                  ? ("verified" as const)
                  : ("unverified" as const)
            }
          : {})
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
