import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { existsSync } from "node:fs"
import type {
  CheckpointRuntimeProjectionStats,
  LegacyCheckpointTranscriptMigrationStats
} from "./runtime-projection-protocol"
import { CHECKPOINT_RUNTIME_PROJECTION_CANCELLED } from "./runtime-projection-protocol"
import {
  getMessageProviderTupleFromMetadata,
  normalizeCompleteSnapshotMessageIds
} from "../../shared/message-role-collision"
import { isWorkflowPlumbingTranscriptContent } from "../../shared/checkpoint-transcript"
import {
  buildCheckpointRuntimeProjection,
  CHECKPOINT_RUNTIME_PROJECTION_VERSION
} from "./runtime-projection"
import type { Checkpoint } from "@langchain/langgraph-checkpoint"

const EXTERNAL_MESSAGES_MARKER = "__cmb_sqljs_external_messages_v1"
const LEGACY_TRANSCRIPT_BATCH_LIMIT = 64
const LEGACY_TRANSCRIPT_BATCH_BYTE_BUDGET = 1024 * 1024
const LEGACY_TRANSCRIPT_FRAGMENT_CHAR_LIMIT = 16 * 1024
const LEGACY_TRANSCRIPT_STRUCTURED_PROJECTION_BYTES = 512 * 1024

class CheckpointRuntimeProjectionCancelledError extends Error {
  constructor() {
    super("Checkpoint runtime projection request was superseded")
    this.name = CHECKPOINT_RUNTIME_PROJECTION_CANCELLED
  }
}

function throwIfCancelled(cancellation?: Int32Array): void {
  if (cancellation && Atomics.load(cancellation, 0) !== 0) {
    throw new CheckpointRuntimeProjectionCancelledError()
  }
}

export interface StoredCheckpointRow {
  threadId: string
  checkpointNs: string
  checkpointId: string
  parentCheckpointId: string | null
  checkpointTs: string
  type: string
  checkpoint: string | Uint8Array
  metadata?: string | Uint8Array
}

export interface PreparedRuntimeProjectionMigration {
  row: StoredCheckpointRow
  runtimeCheckpoint: Uint8Array
  compactCheckpoint: Uint8Array | null
  messages: Uint8Array | null
  messageCount: number
}

function payloadBytes(payload: string | Uint8Array): number {
  return typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.byteLength
}

function parseJsonPayload(payload: string | Uint8Array, label: string): Record<string, unknown> {
  const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload)
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`[CheckpointRuntimeWorker] Invalid ${label} JSON object`)
  }
  return parsed as Record<string, unknown>
}

function serializeJsonPayload(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function normalizePayload(value: unknown, label: string): string | Uint8Array {
  if (typeof value === "string" || value instanceof Uint8Array) return value
  if (Buffer.isBuffer(value)) return value
  throw new Error(`[CheckpointRuntimeWorker] Invalid ${label} payload`)
}

function readLatestCheckpointRow(
  database: DatabaseSync,
  threadId: string,
  checkpointNs: string,
  includeMetadata: boolean
): StoredCheckpointRow | null {
  const row = database
    .prepare(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
              COALESCE(checkpoint_ts, checkpoint_id) AS checkpoint_ts,
              type, checkpoint${includeMetadata ? ", metadata" : ""}
       FROM checkpoints
       WHERE thread_id = ? AND checkpoint_ns = ?
       ORDER BY COALESCE(checkpoint_ts, checkpoint_id) DESC, checkpoint_id DESC
       LIMIT 1`
    )
    .get(threadId, checkpointNs) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    threadId: String(row.thread_id ?? ""),
    checkpointNs: String(row.checkpoint_ns ?? ""),
    checkpointId: String(row.checkpoint_id ?? ""),
    parentCheckpointId:
      row.parent_checkpoint_id === null || row.parent_checkpoint_id === undefined
        ? null
        : String(row.parent_checkpoint_id),
    checkpointTs: String(row.checkpoint_ts ?? row.checkpoint_id ?? ""),
    type: typeof row.type === "string" ? row.type : "json",
    checkpoint: normalizePayload(row.checkpoint, "checkpoint"),
    ...(includeMetadata
      ? { metadata: normalizePayload(row.metadata, "checkpoint metadata") }
      : {})
  }
}

function hasCurrentRuntimeProjection(
  database: DatabaseSync,
  threadId: string,
  checkpointNs: string
): boolean {
  const row = database
    .prepare(
      `SELECT 1
       FROM checkpoint_runtime_projections AS projection
       JOIN checkpoints AS checkpoint
         ON checkpoint.thread_id = projection.thread_id
        AND checkpoint.checkpoint_ns = projection.checkpoint_ns
        AND checkpoint.checkpoint_id = projection.checkpoint_id
       WHERE projection.thread_id = ? AND projection.checkpoint_ns = ?
         AND projection.projection_version = ?
         AND NOT EXISTS (
           SELECT 1 FROM checkpoints AS newer
           WHERE newer.thread_id = checkpoint.thread_id
             AND newer.checkpoint_ns = checkpoint.checkpoint_ns
             AND (
               COALESCE(newer.checkpoint_ts, newer.checkpoint_id) >
                 COALESCE(checkpoint.checkpoint_ts, checkpoint.checkpoint_id)
               OR (
                 COALESCE(newer.checkpoint_ts, newer.checkpoint_id) =
                   COALESCE(checkpoint.checkpoint_ts, checkpoint.checkpoint_id)
                 AND newer.checkpoint_id > checkpoint.checkpoint_id
               )
             )
         )
       LIMIT 1`
    )
    .get(threadId, checkpointNs, CHECKPOINT_RUNTIME_PROJECTION_VERSION)
  return Boolean(row)
}

function prepareRuntimeProjectionMigrationFromCheckpoint(
  row: StoredCheckpointRow,
  checkpoint: Record<string, unknown>
): PreparedRuntimeProjectionMigration {
  const rawChannelValues = checkpoint.channel_values
  const channelValues =
    rawChannelValues && typeof rawChannelValues === "object" && !Array.isArray(rawChannelValues)
      ? { ...(rawChannelValues as Record<string, unknown>) }
      : {}
  const storedMessages = channelValues.messages
  delete channelValues.messages
  const runtimeCheckpoint = serializeJsonPayload(
    buildCheckpointRuntimeProjection(checkpoint as unknown as Checkpoint)
  )

  if (!Array.isArray(storedMessages)) {
    return {
      row,
      runtimeCheckpoint,
      compactCheckpoint: null,
      messages: null,
      messageCount: 0
    }
  }

  return {
    row,
    runtimeCheckpoint,
    compactCheckpoint: serializeJsonPayload({
      ...checkpoint,
      channel_values: {
        ...(rawChannelValues as Record<string, unknown>),
        messages: {
          [EXTERNAL_MESSAGES_MARKER]: true,
          messageCount: storedMessages.length
        }
      }
    }),
    messages: serializeJsonPayload(storedMessages),
    messageCount: storedMessages.length
  }
}

export function prepareRuntimeProjectionMigration(
  row: StoredCheckpointRow
): PreparedRuntimeProjectionMigration {
  if (row.type !== "json") {
    throw new Error(
      `[CheckpointRuntimeWorker] Unsupported legacy checkpoint serialization: ${row.type}`
    )
  }
  return prepareRuntimeProjectionMigrationFromCheckpoint(
    row,
    parseJsonPayload(row.checkpoint, "checkpoint")
  )
}

export function prepareLatestRuntimeProjectionMigration(
  database: DatabaseSync,
  threadId: string,
  checkpointNs = ""
): PreparedRuntimeProjectionMigration | null {
  const row = readLatestCheckpointRow(database, threadId, checkpointNs, false)
  return row ? prepareRuntimeProjectionMigration(row) : null
}

/**
 * Lightweight compatibility guard for pre-durable-message tasks. The checkpoint
 * payload is inspected only inside the worker and only a boolean crosses back to
 * Electron main. Incremental checkpoints use their embedded message count and do
 * not hydrate message snapshots; legacy inline JSON is parsed off the main loop.
 */
export function hasCheckpointTranscript(
  checkpointDatabasePath: string,
  threadId: string,
  checkpointNs = "",
  cancellationBuffer?: SharedArrayBuffer
): boolean {
  const cancellation = cancellationBuffer ? new Int32Array(cancellationBuffer) : undefined
  throwIfCancelled(cancellation)
  if (!existsSync(checkpointDatabasePath)) return false
  const database = new DatabaseSync(checkpointDatabasePath, { timeout: 5_000 })
  try {
    database.exec("PRAGMA busy_timeout = 5000")
    throwIfCancelled(cancellation)
    const row = readLatestCheckpointRow(database, threadId, checkpointNs, true)
    if (!row || row.metadata === undefined) return false
    throwIfCancelled(cancellation)
    const parsed = parseTypedJson(row.type, row.checkpoint, "checkpoint")
    throwIfCancelled(cancellation)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
    const channelValues = objectRecord((parsed as Record<string, unknown>).channel_values)
    const messages = channelValues?.messages
    if (Array.isArray(messages)) return messages.length > 0
    const reference = objectRecord(messages)
    if (reference?.[EXTERNAL_MESSAGES_MARKER] !== true) return false
    const messageCount = Number(reference.messageCount)
    if (Number.isSafeInteger(messageCount) && messageCount > 0) return true
    const snapshot = database
      .prepare(
        `SELECT message_count
         FROM checkpoint_message_snapshots
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
         LIMIT 1`
      )
      .get(row.threadId, row.checkpointNs, row.checkpointId) as
      | { message_count?: unknown }
      | undefined
    return Number(snapshot?.message_count) > 0
  } finally {
    database.close()
  }
}

function exactSourceIsStillLatest(
  database: DatabaseSync,
  prepared: PreparedRuntimeProjectionMigration
): boolean {
  const { row } = prepared
  const current = database
    .prepare(
      `SELECT 1
       FROM checkpoints AS checkpoint
       WHERE checkpoint.thread_id = ? AND checkpoint.checkpoint_ns = ?
         AND checkpoint.checkpoint_id = ? AND checkpoint.type IS ?
         AND checkpoint.checkpoint = ?
         AND NOT EXISTS (
           SELECT 1 FROM checkpoints AS newer
           WHERE newer.thread_id = checkpoint.thread_id
             AND newer.checkpoint_ns = checkpoint.checkpoint_ns
             AND (
               COALESCE(newer.checkpoint_ts, newer.checkpoint_id) >
                 COALESCE(checkpoint.checkpoint_ts, checkpoint.checkpoint_id)
               OR (
                 COALESCE(newer.checkpoint_ts, newer.checkpoint_id) =
                   COALESCE(checkpoint.checkpoint_ts, checkpoint.checkpoint_id)
                 AND newer.checkpoint_id > checkpoint.checkpoint_id
               )
             )
         )
       LIMIT 1`
    )
    .get(
      row.threadId,
      row.checkpointNs,
      row.checkpointId,
      row.type,
      row.checkpoint as SQLInputValue
    )
  return Boolean(current)
}

/**
 * Install a worker-prepared projection only while the exact source row is
 * still authoritative. The write transaction begins after the expensive JSON
 * parse, so active graph writes are blocked only for the small CAS/insert.
 */
export function commitPreparedRuntimeProjection(
  database: DatabaseSync,
  prepared: PreparedRuntimeProjectionMigration
): boolean {
  const { row } = prepared
  database.exec("BEGIN IMMEDIATE")
  try {
    if (!exactSourceIsStillLatest(database, prepared)) {
      database.exec("ROLLBACK")
      return false
    }

    if (prepared.messages && prepared.compactCheckpoint) {
      database
        .prepare(
          `INSERT OR REPLACE INTO checkpoint_message_snapshots
           (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, prefix_length,
            message_count, type, suffix)
           VALUES (?, ?, ?, NULL, 0, ?, 'json', ?)`
        )
        .run(
          row.threadId,
          row.checkpointNs,
          row.checkpointId,
          prepared.messageCount,
          prepared.messages
        )
      database
        .prepare(
          `UPDATE checkpoints
           SET type = 'json', checkpoint = ?
           WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
             AND type IS ? AND checkpoint = ?`
        )
        .run(
          prepared.compactCheckpoint,
          row.threadId,
          row.checkpointNs,
          row.checkpointId,
          row.type,
          row.checkpoint as SQLInputValue
        )
    }

    database
      .prepare(
        `INSERT INTO checkpoint_runtime_projections
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
          checkpoint_ts, projection_version, type, runtime_checkpoint)
         VALUES (?, ?, ?, ?, ?, ?, 'json', ?)
         ON CONFLICT(thread_id, checkpoint_ns) DO UPDATE SET
           checkpoint_id = excluded.checkpoint_id,
           parent_checkpoint_id = excluded.parent_checkpoint_id,
           checkpoint_ts = excluded.checkpoint_ts,
           projection_version = excluded.projection_version,
           type = excluded.type,
           runtime_checkpoint = excluded.runtime_checkpoint
         WHERE excluded.checkpoint_ts > checkpoint_runtime_projections.checkpoint_ts
            OR (
              excluded.checkpoint_ts = checkpoint_runtime_projections.checkpoint_ts
              AND excluded.checkpoint_id >= checkpoint_runtime_projections.checkpoint_id
            )`
      )
      .run(
        row.threadId,
        row.checkpointNs,
        row.checkpointId,
        row.parentCheckpointId,
        row.checkpointTs,
        CHECKPOINT_RUNTIME_PROJECTION_VERSION,
        prepared.runtimeCheckpoint
      )
    database.exec("COMMIT")
    return true
  } catch (error) {
    try {
      database.exec("ROLLBACK")
    } catch {
      // Preserve the original migration error.
    }
    throw error
  }
}

export function ensureCheckpointRuntimeProjection(
  databasePath: string,
  threadId: string,
  checkpointNs: string
): CheckpointRuntimeProjectionStats {
  const database = new DatabaseSync(databasePath, { timeout: 5_000 })
  try {
    database.exec("PRAGMA busy_timeout = 5000")
    if (hasCurrentRuntimeProjection(database, threadId, checkpointNs)) {
      return {
        sourceBytes: 0,
        projectionBytes: 0,
        inlineMessageCount: 0,
        migrated: false,
        stale: false
      }
    }
    const prepared = prepareLatestRuntimeProjectionMigration(database, threadId, checkpointNs)
    if (!prepared) {
      return {
        sourceBytes: 0,
        projectionBytes: 0,
        inlineMessageCount: 0,
        migrated: false,
        stale: false
      }
    }
    const migrated = commitPreparedRuntimeProjection(database, prepared)
    return {
      sourceBytes: payloadBytes(prepared.row.checkpoint),
      projectionBytes: prepared.runtimeCheckpoint.byteLength,
      inlineMessageCount: prepared.messageCount,
      migrated,
      stale: !migrated
    }
  } finally {
    database.close()
  }
}

function parseTypedJson(type: string, payload: string | Uint8Array, label: string): unknown {
  if (type === "bytes") {
    return typeof payload === "string" ? new TextEncoder().encode(payload) : payload
  }
  if (type !== "json") {
    throw new Error(`[CheckpointRuntimeWorker] Unsupported ${label} serialization: ${type}`)
  }
  const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload)
  return JSON.parse(text)
}

function hydrateRawCheckpointMessages(
  database: DatabaseSync,
  row: StoredCheckpointRow,
  checkpoint: Record<string, unknown>,
  cancellation?: Int32Array
): Record<string, unknown> {
  throwIfCancelled(cancellation)
  const rawChannelValues = checkpoint.channel_values
  if (!rawChannelValues || typeof rawChannelValues !== "object" || Array.isArray(rawChannelValues)) {
    return checkpoint
  }
  const channelValues = rawChannelValues as Record<string, unknown>
  const reference = channelValues.messages
  if (
    !reference ||
    typeof reference !== "object" ||
    Array.isArray(reference) ||
    (reference as Record<string, unknown>)[EXTERNAL_MESSAGES_MARKER] !== true
  ) {
    return checkpoint
  }

  const chain: Array<{
    checkpointId: string
    parentCheckpointId: string | null
    prefixLength: number
    messageCount: number
    type: string
    suffix: string | Uint8Array
  }> = []
  const visited = new Set<string>()
  let cursor: string | null = row.checkpointId
  while (cursor) {
    throwIfCancelled(cancellation)
    if (visited.has(cursor)) {
      throw new Error(`[CheckpointRuntimeWorker] Cyclic message snapshot: ${cursor}`)
    }
    visited.add(cursor)
    const snapshot = database
      .prepare(
        `SELECT checkpoint_id, parent_checkpoint_id, prefix_length, message_count, type, suffix
         FROM checkpoint_message_snapshots
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
      )
      .get(row.threadId, row.checkpointNs, cursor) as Record<string, unknown> | undefined
    if (!snapshot) {
      throw new Error(`[CheckpointRuntimeWorker] Missing message snapshot: ${cursor}`)
    }
    chain.push({
      checkpointId: String(snapshot.checkpoint_id ?? ""),
      parentCheckpointId:
        snapshot.parent_checkpoint_id === null || snapshot.parent_checkpoint_id === undefined
          ? null
          : String(snapshot.parent_checkpoint_id),
      prefixLength: Number(snapshot.prefix_length),
      messageCount: Number(snapshot.message_count),
      type: typeof snapshot.type === "string" ? snapshot.type : "json",
      suffix: normalizePayload(snapshot.suffix, "message snapshot")
    })
    cursor = chain.at(-1)?.parentCheckpointId ?? null
  }

  const messages: unknown[] = []
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    throwIfCancelled(cancellation)
    const snapshot = chain[index]
    if (
      !Number.isSafeInteger(snapshot.prefixLength) ||
      snapshot.prefixLength < 0 ||
      snapshot.prefixLength > messages.length ||
      !Number.isSafeInteger(snapshot.messageCount) ||
      snapshot.messageCount < snapshot.prefixLength
    ) {
      throw new Error(`[CheckpointRuntimeWorker] Invalid message snapshot: ${snapshot.checkpointId}`)
    }
    const suffix = parseTypedJson(snapshot.type, snapshot.suffix, "message snapshot")
    if (!Array.isArray(suffix)) {
      throw new Error(`[CheckpointRuntimeWorker] Invalid message suffix: ${snapshot.checkpointId}`)
    }
    messages.length = snapshot.prefixLength
    for (let suffixIndex = 0; suffixIndex < suffix.length; suffixIndex += 1) {
      if (suffixIndex % LEGACY_TRANSCRIPT_BATCH_LIMIT === 0) throwIfCancelled(cancellation)
      messages.push(suffix[suffixIndex])
    }
    if (messages.length !== snapshot.messageCount) {
      throw new Error(`[CheckpointRuntimeWorker] Message count mismatch: ${snapshot.checkpointId}`)
    }
  }

  return {
    ...checkpoint,
    channel_values: {
      ...channelValues,
      messages
    }
  }
}

interface DurableLegacyCheckpointMessage {
  messageId: string
  providerSourceId: string | null
  providerOccurrence: number | null
  role: "user" | "assistant" | "system" | "tool"
  contentJson: string
  toolCallsJson: string | null
  toolCallId: string | null
  name: string | null
  status: string | null
  isError: number | null
  createdAt: number
  estimatedBytes: number
  contentFragments: string[] | null
}

export interface LegacyCheckpointTranscriptBootstrapResult {
  runtimeTuple: unknown | null
  stats: LegacyCheckpointTranscriptMigrationStats
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function serializedMessageRole(
  message: Record<string, unknown>,
  kwargs: Record<string, unknown>
): DurableLegacyCheckpointMessage["role"] {
  const classId = Array.isArray(message.id) ? message.id : []
  const className = String(classId.at(-1) ?? "")
  if (className.includes("HumanMessage")) return "user"
  if (className.includes("ToolMessage")) return "tool"
  if (className.includes("SystemMessage")) return "system"
  if (className.includes("AIMessage")) return "assistant"
  const type = message.type ?? kwargs.type ?? message.role ?? kwargs.role
  if (type === "human" || type === "user") return "user"
  if (type === "tool") return "tool"
  if (type === "system") return "system"
  return "assistant"
}

function splitLegacyTranscriptText(value: string): string[] {
  const fragments: string[] = []
  for (let start = 0; start < value.length; ) {
    let end = Math.min(value.length, start + LEGACY_TRANSCRIPT_FRAGMENT_CHAR_LIMIT)
    if (
      end < value.length &&
      end > start &&
      /[\uD800-\uDBFF]/.test(value[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(value[end])
    ) {
      end -= 1
    }
    fragments.push(value.slice(start, end))
    start = end
  }
  return fragments
}

function boundedLegacyStructuredContent(value: unknown): unknown {
  const projected = boundedTransferContent(value)
  if (!Array.isArray(projected)) return projected
  return [
    ...projected,
    { type: "text", text: "[旧检查点结构化正文过大，已显示有界投影]" }
  ]
}

function buildDurableLegacyCheckpointMessages(
  rawMessages: readonly unknown[],
  checkpointTs: string,
  cancellation?: Int32Array
): DurableLegacyCheckpointMessage[] {
  const checkpointTime = Date.parse(checkpointTs)
  const baseTime = Number.isFinite(checkpointTime) ? checkpointTime : Date.now()
  const candidates: Array<
    Omit<DurableLegacyCheckpointMessage, "messageId" | "providerSourceId" | "providerOccurrence"> & {
      id: string
      content: unknown
      provider_source_id?: string
      provider_occurrence?: number
    }
  > = []

  for (let index = 0; index < rawMessages.length; index += 1) {
    if (index % LEGACY_TRANSCRIPT_BATCH_LIMIT === 0) throwIfCancelled(cancellation)
    const message = objectRecord(rawMessages[index])
    if (!message) continue
    const kwargs = objectRecord(message.kwargs) ?? {}
    const additionalKwargs =
      objectRecord(message.additional_kwargs) ?? objectRecord(kwargs.additional_kwargs) ?? {}
    if (additionalKwargs.cmb_internal_coordinator_notification === true) continue

    const role = serializedMessageRole(message, kwargs)
    const rawIdValue = kwargs.id ?? (typeof message.id === "string" ? message.id : undefined)
    const sourceId =
      typeof rawIdValue === "string" && rawIdValue.trim()
        ? rawIdValue.trim()
        : `checkpoint-${index}`
    const rawContent = message.content ?? kwargs.content
    const content = typeof rawContent === "string" || Array.isArray(rawContent) ? rawContent : ""
    if (isWorkflowPlumbingTranscriptContent(content)) continue
    const rawToolCalls = message.tool_calls ?? kwargs.tool_calls
    const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : null
    const rawContentJson = JSON.stringify(content)
    const contentFragments =
      typeof content === "string" &&
      Buffer.byteLength(rawContentJson, "utf8") > LEGACY_TRANSCRIPT_BATCH_BYTE_BUDGET
        ? splitLegacyTranscriptText(content)
        : null
    const contentJson = contentFragments
      ? JSON.stringify("")
      : Buffer.byteLength(rawContentJson, "utf8") >
          LEGACY_TRANSCRIPT_STRUCTURED_PROJECTION_BYTES
        ? JSON.stringify(boundedLegacyStructuredContent(content))
        : rawContentJson
    const rawToolCallsJson = toolCalls ? JSON.stringify(toolCalls) : null
    const toolCallsJson =
      rawToolCallsJson &&
      Buffer.byteLength(rawToolCallsJson, "utf8") >
        LEGACY_TRANSCRIPT_STRUCTURED_PROJECTION_BYTES
        ? JSON.stringify(boundedTransferToolCalls(toolCalls) ?? [])
        : rawToolCallsJson
    const toolCallId = message.tool_call_id ?? kwargs.tool_call_id
    const name = message.name ?? kwargs.name
    const status = message.status ?? kwargs.status
    const isError =
      message.is_error === true || kwargs.is_error === true || additionalKwargs.is_error === true
        ? 1
        : null
    const providerTuple =
      role === "assistant" ? getMessageProviderTupleFromMetadata(additionalKwargs) : undefined
    candidates.push({
      id: sourceId,
      content,
      ...providerTuple,
      role,
      contentJson,
      toolCallsJson,
      toolCallId: typeof toolCallId === "string" ? toolCallId : null,
      name: typeof name === "string" ? name : null,
      status: typeof status === "string" ? status : null,
      isError,
      createdAt: baseTime + index,
      estimatedBytes:
        Buffer.byteLength(contentJson, "utf8") +
        Buffer.byteLength(toolCallsJson ?? "", "utf8") +
        1024,
      contentFragments
    })
  }
  return normalizeCompleteSnapshotMessageIds([], candidates).map((message) => ({
    messageId: message.id,
    providerSourceId: message.provider_source_id ?? null,
    providerOccurrence: message.provider_occurrence ?? null,
    role: message.role,
    contentJson: message.contentJson,
    toolCallsJson: message.toolCallsJson,
    toolCallId: message.toolCallId,
    name: message.name,
    status: message.status,
    isError: message.isError,
    createdAt: message.createdAt,
    estimatedBytes: message.estimatedBytes,
    contentFragments: message.contentFragments
  }))
}

function ensureLegacyTranscriptMigrationSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS legacy_checkpoint_transcript_migrations (
      thread_id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL,
      total_messages INTEGER NOT NULL,
      next_index INTEGER NOT NULL,
      current_fragment_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  const columns = database
    .prepare("PRAGMA table_info(legacy_checkpoint_transcript_migrations)")
    .all() as Array<{ name?: unknown }>
  if (!columns.some((column) => column.name === "current_fragment_index")) {
    database.exec(
      "ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN current_fragment_index INTEGER NOT NULL DEFAULT 0"
    )
  }
}

function migrateLegacyMessagesIntoDurableRows(input: {
  databasePath: string
  threadId: string
  checkpointId: string
  messages: readonly DurableLegacyCheckpointMessage[]
  payloadBytes: number
  cancellation?: Int32Array
}): LegacyCheckpointTranscriptMigrationStats {
  const database = new DatabaseSync(input.databasePath, { timeout: 5_000 })
  let migratedMessages = 0
  let batches = 0
  try {
    throwIfCancelled(input.cancellation)
    database.exec("PRAGMA busy_timeout = 5000")
    ensureLegacyTranscriptMigrationSchema(database)
    const threadExists = database
      .prepare("SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1")
      .get(input.threadId)
    if (!threadExists) {
      return {
        checkpointId: input.checkpointId,
        totalMessages: input.messages.length,
        migratedMessages: 0,
        batches: 0,
        payloadBytes: input.payloadBytes
      }
    }

    const existingState = database
      .prepare(
        `SELECT checkpoint_id, total_messages, next_index, current_fragment_index, status
         FROM legacy_checkpoint_transcript_migrations
         WHERE thread_id = ?`
      )
      .get(input.threadId) as Record<string, unknown> | undefined
    const sameMigration = existingState?.checkpoint_id === input.checkpointId
    if (sameMigration && existingState?.status === "complete") {
      return {
        checkpointId: input.checkpointId,
        totalMessages: input.messages.length,
        migratedMessages: 0,
        batches: 0,
        payloadBytes: input.payloadBytes
      }
    }

    if (!sameMigration) {
      throwIfCancelled(input.cancellation)
      database.exec("BEGIN IMMEDIATE")
      try {
        const stillExists = database
          .prepare("SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1")
          .get(input.threadId)
        if (!stillExists) {
          database.exec("ROLLBACK")
          return {
            checkpointId: input.checkpointId,
            totalMessages: input.messages.length,
            migratedMessages: 0,
            batches: 0,
            payloadBytes: input.payloadBytes
          }
        }
        const summary = database
          .prepare(
            `SELECT COUNT(*) AS message_count,
                    COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
             FROM thread_messages WHERE thread_id = ?`
          )
          .get(input.threadId) as { message_count: number; next_ordinal: number }
        if (input.messages.length > 0 && Number(summary.message_count) > 0) {
          database
            .prepare(
              `UPDATE thread_messages
               SET ordinal = ordinal + ?
               WHERE thread_id = ?`
            )
            .run(input.messages.length, input.threadId)
        }
        database
          .prepare(
            `INSERT INTO thread_message_buckets
             (thread_id, message_count, next_ordinal, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(thread_id) DO UPDATE SET
               message_count = excluded.message_count,
               next_ordinal = excluded.next_ordinal,
               updated_at = excluded.updated_at`
          )
          .run(
            input.threadId,
            Number(summary.message_count),
            Number(summary.next_ordinal) + input.messages.length,
            Date.now()
          )
        database
          .prepare(
            `INSERT OR REPLACE INTO legacy_checkpoint_transcript_migrations
             (thread_id, checkpoint_id, total_messages, next_index,
              current_fragment_index, status, updated_at)
             VALUES (?, ?, ?, 0, 0, 'migrating', ?)`
          )
          .run(input.threadId, input.checkpointId, input.messages.length, Date.now())
        database.exec("COMMIT")
      } catch (error) {
        try {
          database.exec("ROLLBACK")
        } catch {
          // Preserve the reservation error.
        }
        throw error
      }
    }

    const state = database
      .prepare(
        `SELECT next_index, current_fragment_index
         FROM legacy_checkpoint_transcript_migrations
         WHERE thread_id = ? AND checkpoint_id = ?`
      )
      .get(input.threadId, input.checkpointId) as
      | { next_index?: number; current_fragment_index?: number }
      | undefined
    let offset = Math.max(0, Number(state?.next_index) || 0)
    let fragmentOffset = Math.max(0, Number(state?.current_fragment_index) || 0)
    const insert = database.prepare(
      `INSERT OR IGNORE INTO thread_messages (
         thread_id, message_id, provider_source_id, provider_occurrence, role,
         content_json, tool_calls_json, tool_call_id, name, status, is_error,
         content_priority, goal_id, active_window_id, created_at, start_at, end_at, ordinal
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, ?)`
    )
    const moveReservedDuplicate = database.prepare(
      `UPDATE thread_messages
       SET ordinal = ?
       WHERE thread_id = ? AND message_id = ? AND ordinal >= ?`
    )
    const insertFragment = database.prepare(
      `INSERT INTO thread_message_fragments
       (thread_id, message_id, content_text, created_at) VALUES (?, ?, ?, ?)`
    )
    const updateFragmentState = database.prepare(
      `INSERT INTO thread_message_fragment_states
       (thread_id, message_id, total_chars, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id, message_id) DO UPDATE SET
         total_chars = thread_message_fragment_states.total_chars + excluded.total_chars,
         updated_at = excluded.updated_at`
    )
    const insertedFragmentMessages = new Set<number>()

    while (offset < input.messages.length) {
      throwIfCancelled(input.cancellation)
      const fragmentMessage = input.messages[offset]
      if (fragmentMessage.contentFragments) {
        database.exec("BEGIN IMMEDIATE")
        try {
          const currentState = database
            .prepare(
              `SELECT next_index, current_fragment_index
               FROM legacy_checkpoint_transcript_migrations
               WHERE thread_id = ? AND checkpoint_id = ? AND status = 'migrating'`
            )
            .get(input.threadId, input.checkpointId) as
            | { next_index?: number; current_fragment_index?: number }
            | undefined
          if (
            !currentState ||
            Number(currentState.next_index) !== offset ||
            Number(currentState.current_fragment_index) !== fragmentOffset
          ) {
            database.exec("ROLLBACK")
            break
          }
          if (
            !database.prepare("SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1").get(input.threadId)
          ) {
            database
              .prepare("DELETE FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?")
              .run(input.threadId)
            database.exec("COMMIT")
            break
          }

          let insertedMessage = 0
          if (fragmentOffset === 0) {
            const inserted = insert.run(
              input.threadId,
              fragmentMessage.messageId,
              fragmentMessage.providerSourceId,
              fragmentMessage.providerOccurrence,
              fragmentMessage.role,
              fragmentMessage.contentJson,
              fragmentMessage.toolCallsJson,
              fragmentMessage.toolCallId,
              fragmentMessage.name,
              fragmentMessage.status,
              fragmentMessage.isError,
              fragmentMessage.createdAt,
              offset
            )
            insertedMessage = Number(inserted.changes)
            if (insertedMessage === 0) {
              moveReservedDuplicate.run(
                offset,
                input.threadId,
                fragmentMessage.messageId,
                input.messages.length
              )
            } else {
              insertedFragmentMessages.add(offset)
            }
          }

          let nextFragmentOffset = fragmentOffset
          let fragmentBatchBytes = fragmentMessage.estimatedBytes
          let fragmentChars = 0
          if (fragmentOffset > 0 || insertedMessage > 0) {
            while (nextFragmentOffset < fragmentMessage.contentFragments.length) {
              const fragment = fragmentMessage.contentFragments[nextFragmentOffset]
              const fragmentBytes = Buffer.byteLength(fragment, "utf8") + 256
              if (
                nextFragmentOffset > fragmentOffset &&
                fragmentBatchBytes + fragmentBytes > LEGACY_TRANSCRIPT_BATCH_BYTE_BUDGET
              ) {
                break
              }
              insertFragment.run(
                input.threadId,
                fragmentMessage.messageId,
                fragment,
                fragmentMessage.createdAt + nextFragmentOffset
              )
              fragmentBatchBytes += fragmentBytes
              fragmentChars += fragment.length
              nextFragmentOffset += 1
            }
            if (fragmentChars > 0) {
              updateFragmentState.run(
                input.threadId,
                fragmentMessage.messageId,
                fragmentChars,
                Date.now()
              )
            }
          } else {
            // A live row with the same identity wins. Do not attach legacy
            // fragments to it; simply advance the compatibility cursor.
            nextFragmentOffset = fragmentMessage.contentFragments.length
          }

          const messageComplete =
            nextFragmentOffset >= fragmentMessage.contentFragments.length
          database
            .prepare(
              `UPDATE legacy_checkpoint_transcript_migrations
               SET next_index = ?, current_fragment_index = ?, updated_at = ?
               WHERE thread_id = ? AND checkpoint_id = ?`
            )
            .run(
              messageComplete ? offset + 1 : offset,
              messageComplete ? 0 : nextFragmentOffset,
              Date.now(),
              input.threadId,
              input.checkpointId
            )
          database
            .prepare(
              `UPDATE thread_message_buckets
               SET message_count = message_count + ?, updated_at = ?
               WHERE thread_id = ?`
            )
            .run(insertedMessage, Date.now(), input.threadId)
          database.exec("COMMIT")
          batches += 1
          if (messageComplete) {
            if (insertedFragmentMessages.delete(offset)) migratedMessages += 1
            offset += 1
            fragmentOffset = 0
          } else {
            fragmentOffset = nextFragmentOffset
          }
          continue
        } catch (error) {
          try {
            database.exec("ROLLBACK")
          } catch {
            // Preserve the fragment migration error.
          }
          throw error
        }
      }

      let end = offset
      let batchBytes = 0
      while (end < input.messages.length && end - offset < LEGACY_TRANSCRIPT_BATCH_LIMIT) {
        if (input.messages[end].contentFragments) break
        const nextBytes = input.messages[end].estimatedBytes
        if (end > offset && batchBytes + nextBytes > LEGACY_TRANSCRIPT_BATCH_BYTE_BUDGET) break
        batchBytes += nextBytes
        end += 1
      }
      if (end === offset) end += 1

      database.exec("BEGIN IMMEDIATE")
      try {
        const currentState = database
          .prepare(
            `SELECT next_index, current_fragment_index
             FROM legacy_checkpoint_transcript_migrations
             WHERE thread_id = ? AND checkpoint_id = ? AND status = 'migrating'`
          )
          .get(input.threadId, input.checkpointId) as
          | { next_index?: number; current_fragment_index?: number }
          | undefined
        if (
          !currentState ||
          Number(currentState.next_index) !== offset ||
          Number(currentState.current_fragment_index) !== 0
        ) {
          database.exec("ROLLBACK")
          break
        }
        if (
          !database.prepare("SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1").get(input.threadId)
        ) {
          database
            .prepare("DELETE FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?")
            .run(input.threadId)
          database.exec("COMMIT")
          break
        }

        let insertedInBatch = 0
        for (let index = offset; index < end; index += 1) {
          throwIfCancelled(input.cancellation)
          const message = input.messages[index]
          const inserted = insert.run(
            input.threadId,
            message.messageId,
            message.providerSourceId,
            message.providerOccurrence,
            message.role,
            message.contentJson,
            message.toolCallsJson,
            message.toolCallId,
            message.name,
            message.status,
            message.isError,
            message.createdAt,
            index
          )
          insertedInBatch += Number(inserted.changes)
          if (Number(inserted.changes) === 0) {
            moveReservedDuplicate.run(index, input.threadId, message.messageId, input.messages.length)
          }
        }
        database
          .prepare(
            `UPDATE thread_message_buckets
             SET message_count = message_count + ?, updated_at = ?
             WHERE thread_id = ?`
          )
          .run(insertedInBatch, Date.now(), input.threadId)
        database
          .prepare(
            `UPDATE legacy_checkpoint_transcript_migrations
             SET next_index = ?, current_fragment_index = 0, updated_at = ?
             WHERE thread_id = ? AND checkpoint_id = ?`
          )
          .run(end, Date.now(), input.threadId, input.checkpointId)
        database.exec("COMMIT")
        migratedMessages += insertedInBatch
        batches += 1
        offset = end
      } catch (error) {
        try {
          database.exec("ROLLBACK")
        } catch {
          // Preserve the batch error.
        }
        throw error
      }
    }

    if (offset >= input.messages.length) {
      throwIfCancelled(input.cancellation)
      database.exec("BEGIN IMMEDIATE")
      try {
        if (
          !database.prepare("SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1").get(input.threadId)
        ) {
          database
            .prepare("DELETE FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?")
            .run(input.threadId)
          database.exec("COMMIT")
          return {
            checkpointId: input.checkpointId,
            totalMessages: input.messages.length,
            migratedMessages,
            batches,
            payloadBytes: input.payloadBytes
          }
        }
        const summary = database
          .prepare(
            `SELECT COUNT(*) AS message_count,
                    COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
             FROM thread_messages WHERE thread_id = ?`
          )
          .get(input.threadId) as { message_count: number; next_ordinal: number }
        database
          .prepare(
            `UPDATE thread_message_buckets
             SET message_count = ?, next_ordinal = ?, updated_at = ?
             WHERE thread_id = ?`
          )
          .run(
            Number(summary.message_count),
            Number(summary.next_ordinal),
            Date.now(),
            input.threadId
          )
        database
          .prepare(
            `UPDATE legacy_checkpoint_transcript_migrations
             SET next_index = total_messages, status = 'complete', updated_at = ?
             WHERE thread_id = ? AND checkpoint_id = ?`
          )
          .run(Date.now(), input.threadId, input.checkpointId)
        database.exec("COMMIT")
      } catch (error) {
        try {
          database.exec("ROLLBACK")
        } catch {
          // Preserve the completion error.
        }
        throw error
      }
    }

    return {
      checkpointId: input.checkpointId,
      totalMessages: input.messages.length,
      migratedMessages,
      batches,
      payloadBytes: input.payloadBytes
    }
  } finally {
    database.close()
  }
}

function checkpointTupleFromRaw(input: {
  row: StoredCheckpointRow
  checkpoint: Record<string, unknown>
}): unknown {
  return {
    config: {
      configurable: {
        thread_id: input.row.threadId,
        checkpoint_ns: input.row.checkpointNs,
        checkpoint_id: input.row.checkpointId
      }
    },
    checkpoint: input.checkpoint,
    ...(input.row.parentCheckpointId
      ? {
          parentConfig: {
            configurable: {
              thread_id: input.row.threadId,
              checkpoint_ns: input.row.checkpointNs,
              checkpoint_id: input.row.parentCheckpointId
            }
          }
        }
      : {})
  }
}

/**
 * One-time compatibility bridge for databases whose checkpoint transcript was
 * never copied into the durable message table. The worker keeps the full array
 * local, persists it in bounded transactions, and returns only runtime state.
 */
export function bootstrapLegacyCheckpointTranscript(
  checkpointDatabasePath: string,
  messageDatabasePath: string,
  threadId: string,
  checkpointNs: string,
  cancellationBuffer: SharedArrayBuffer
): LegacyCheckpointTranscriptBootstrapResult {
  const cancellation = new Int32Array(cancellationBuffer)
  throwIfCancelled(cancellation)
  const checkpointDatabase = new DatabaseSync(checkpointDatabasePath, { timeout: 5_000 })
  try {
    checkpointDatabase.exec("PRAGMA busy_timeout = 5000")
    checkpointDatabase.exec("BEGIN")
    let row: StoredCheckpointRow | null = null
    let rawCheckpoint: Record<string, unknown> | null = null
    let hydratedCheckpoint: Record<string, unknown> | null = null
    try {
      throwIfCancelled(cancellation)
      row = readLatestCheckpointRow(checkpointDatabase, threadId, checkpointNs, true)
      if (!row || row.metadata === undefined) {
        checkpointDatabase.exec("COMMIT")
        return {
          runtimeTuple: null,
          stats: {
            checkpointId: null,
            totalMessages: 0,
            migratedMessages: 0,
            batches: 0,
            payloadBytes: 0
          }
        }
      }
      const parsed = parseTypedJson(row.type, row.checkpoint, "checkpoint")
      throwIfCancelled(cancellation)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("[CheckpointRuntimeWorker] Invalid checkpoint object")
      }
      rawCheckpoint = parsed as Record<string, unknown>
      hydratedCheckpoint = hydrateRawCheckpointMessages(
        checkpointDatabase,
        row,
        rawCheckpoint,
        cancellation
      )
      throwIfCancelled(cancellation)
      checkpointDatabase.exec("COMMIT")
    } catch (error) {
      try {
        checkpointDatabase.exec("ROLLBACK")
      } catch {
        // Preserve the checkpoint read error.
      }
      throw error
    }

    throwIfCancelled(cancellation)
    const prepared = prepareRuntimeProjectionMigrationFromCheckpoint(row, rawCheckpoint)
    const projectionInstalled = commitPreparedRuntimeProjection(checkpointDatabase, prepared)
    if (!projectionInstalled) {
      throw new Error("[CheckpointRuntimeWorker] Checkpoint changed during legacy bootstrap")
    }
    throwIfCancelled(cancellation)
    const channelValues = objectRecord(hydratedCheckpoint.channel_values) ?? {}
    const messages = Array.isArray(channelValues.messages) ? channelValues.messages : []
    const runtimeCheckpoint = buildCheckpointRuntimeProjection(
      hydratedCheckpoint as unknown as Checkpoint
    ) as unknown as Record<string, unknown>
    const sourceBytes = Math.max(
      payloadBytes(row.checkpoint),
      prepared.messages?.byteLength ?? serializeJsonPayload(messages).byteLength
    )
    const durableMessages = buildDurableLegacyCheckpointMessages(
      messages,
      row.checkpointTs,
      cancellation
    )
    const stats = migrateLegacyMessagesIntoDurableRows({
      databasePath: messageDatabasePath,
      threadId,
      checkpointId: row.checkpointId,
      messages: durableMessages,
      payloadBytes: sourceBytes,
      cancellation
    })
    throwIfCancelled(cancellation)
    return {
      runtimeTuple: checkpointTupleFromRaw({
        row,
        checkpoint: runtimeCheckpoint
      }),
      stats
    }
  } finally {
    checkpointDatabase.close()
  }
}

const CHECKPOINT_TRANSFER_DEFAULT_MESSAGE_LIMIT = 500
const CHECKPOINT_TRANSFER_MAX_MESSAGE_LIMIT = 1_000
const CHECKPOINT_TRANSFER_DEFAULT_BYTE_BUDGET = 1024 * 1024
const CHECKPOINT_TRANSFER_MAX_BYTE_BUDGET = 4 * 1024 * 1024
const CHECKPOINT_TRANSFER_CONTENT_TEXT_LIMIT = 120_000
const CHECKPOINT_TRANSFER_CONTENT_BLOCK_LIMIT = 80
const CHECKPOINT_TRANSFER_BLOCK_TEXT_LIMIT = 20_000
const CHECKPOINT_TRANSFER_TOOL_CALL_LIMIT = 50

function boundedTransferContent(value: unknown): unknown {
  if (typeof value === "string") {
    return value.slice(0, CHECKPOINT_TRANSFER_CONTENT_TEXT_LIMIT)
  }
  if (!Array.isArray(value)) return ""
  let remainingText = CHECKPOINT_TRANSFER_CONTENT_TEXT_LIMIT
  const blocks: unknown[] = []
  for (const rawBlock of value.slice(0, CHECKPOINT_TRANSFER_CONTENT_BLOCK_LIMIT)) {
    if (remainingText <= 0) break
    if (typeof rawBlock === "string") {
      const text = rawBlock.slice(0, remainingText)
      remainingText -= text.length
      blocks.push(text)
      continue
    }
    const block = objectRecord(rawBlock)
    if (!block) continue
    const bounded: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(block).slice(0, 20)) {
      if (typeof nested === "string") {
        const text = nested.slice(
          0,
          Math.min(remainingText, CHECKPOINT_TRANSFER_BLOCK_TEXT_LIMIT)
        )
        remainingText -= text.length
        bounded[key] = text
      } else if (
        nested === null ||
        typeof nested === "number" ||
        typeof nested === "boolean"
      ) {
        bounded[key] = nested
      } else if (Array.isArray(nested)) {
        bounded[key] = `[Array ${nested.length}]`
      } else if (nested && typeof nested === "object") {
        bounded[key] = "[Object]"
      }
    }
    blocks.push(bounded)
  }
  return blocks
}

function boundedTransferToolArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const args: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value).slice(0, 8)) {
    args[key.slice(0, 128)] =
      typeof nested === "string"
        ? nested.slice(0, 256)
        : nested === null || typeof nested === "number" || typeof nested === "boolean"
          ? nested
          : Array.isArray(nested)
            ? `[Array ${nested.length}]`
            : nested && typeof nested === "object"
              ? "[Object]"
              : String(nested ?? "")
  }
  return args
}

function boundedTransferToolCalls(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.slice(0, CHECKPOINT_TRANSFER_TOOL_CALL_LIMIT).flatMap((rawToolCall) => {
    const toolCall = objectRecord(rawToolCall)
    if (!toolCall) return []
    return [
      {
        ...(typeof toolCall.id === "string" ? { id: toolCall.id.slice(0, 256) } : {}),
        ...(typeof toolCall.name === "string" ? { name: toolCall.name.slice(0, 256) } : {}),
        args: boundedTransferToolArgs(toolCall.args)
      }
    ]
  })
}

function boundedTransferCheckpointMessage(raw: unknown, index: number): unknown | null {
  const message = objectRecord(raw)
  if (!message) return null
  const kwargs = objectRecord(message.kwargs) ?? {}
  const additionalKwargs =
    objectRecord(message.additional_kwargs) ?? objectRecord(kwargs.additional_kwargs) ?? {}
  const role = serializedMessageRole(message, kwargs)
  const rawId = kwargs.id ?? (typeof message.id === "string" ? message.id : undefined)
  const toolCalls = boundedTransferToolCalls(message.tool_calls ?? kwargs.tool_calls)
  const toolCallId = message.tool_call_id ?? kwargs.tool_call_id
  const name = message.name ?? kwargs.name
  const status = message.status ?? kwargs.status
  const selectedAdditionalKwargs = {
    ...(additionalKwargs.cmb_internal_coordinator_notification === true
      ? { cmb_internal_coordinator_notification: true }
      : {}),
    ...(additionalKwargs.is_error === true ? { is_error: true } : {}),
    ...(typeof additionalKwargs.cmb_internal_provider_source_id === "string"
      ? {
          cmb_internal_provider_source_id:
            additionalKwargs.cmb_internal_provider_source_id.slice(0, 256)
        }
      : {}),
    ...(typeof additionalKwargs.cmb_internal_provider_occurrence === "number"
      ? { cmb_internal_provider_occurrence: additionalKwargs.cmb_internal_provider_occurrence }
      : {})
  }
  return {
    id: typeof rawId === "string" && rawId ? rawId : `worker-snapshot-${index}`,
    type: role === "user" ? "human" : role === "assistant" ? "ai" : role,
    content: boundedTransferContent(message.content ?? kwargs.content),
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    ...(typeof toolCallId === "string" ? { tool_call_id: toolCallId.slice(0, 256) } : {}),
    ...(typeof name === "string" ? { name: name.slice(0, 256) } : {}),
    ...(typeof status === "string" ? { status: status.slice(0, 128) } : {}),
    ...(message.is_error === true || kwargs.is_error === true ? { is_error: true } : {}),
    ...(Object.keys(selectedAdditionalKwargs).length > 0
      ? { additional_kwargs: selectedAdditionalKwargs }
      : {})
  }
}

function buildBoundedCheckpointTransfer(
  checkpoint: Record<string, unknown>,
  options: { messageLimit?: number; messageByteBudget?: number },
  cancellation?: Int32Array
): Record<string, unknown> {
  const channelValues = objectRecord(checkpoint.channel_values) ?? {}
  const rawMessages = Array.isArray(channelValues.messages) ? channelValues.messages : []
  const messageLimit = Math.min(
    CHECKPOINT_TRANSFER_MAX_MESSAGE_LIMIT,
    Math.max(1, Math.floor(options.messageLimit ?? CHECKPOINT_TRANSFER_DEFAULT_MESSAGE_LIMIT))
  )
  const byteBudget = Math.min(
    CHECKPOINT_TRANSFER_MAX_BYTE_BUDGET,
    Math.max(
      1,
      Math.floor(options.messageByteBudget ?? CHECKPOINT_TRANSFER_DEFAULT_BYTE_BUDGET)
    )
  )
  const messages: unknown[] = []
  let selectedBytes = 0
  for (let index = rawMessages.length - 1; index >= 0 && messages.length < messageLimit; index -= 1) {
    if (messages.length % LEGACY_TRANSCRIPT_BATCH_LIMIT === 0) throwIfCancelled(cancellation)
    const message = boundedTransferCheckpointMessage(rawMessages[index], index)
    if (!message) continue
    const messageBytes = payloadBytes(JSON.stringify(message))
    if (messages.length > 0 && selectedBytes + messageBytes > byteBudget) break
    messages.unshift(message)
    selectedBytes += messageBytes
  }
  return {
    v: checkpoint.v,
    id: checkpoint.id,
    ts: checkpoint.ts,
    channel_values: {
      messages,
      __cmb_original_message_count: rawMessages.length
    },
    channel_versions: {},
    versions_seen: {}
  }
}

/**
 * Full snapshot reconstruction stays in the worker. Callers serving renderer
 * UI pass a message window so Electron main receives only a bounded tail;
 * cold internal callers may still omit options when they explicitly need the
 * complete tuple.
 */
export function readLatestCheckpointTuple(
  databasePath: string,
  threadId: string,
  checkpointNs: string,
  options: {
    messageLimit?: number
    messageByteBudget?: number
    cancellationBuffer?: SharedArrayBuffer
  } = {}
): unknown | null {
  const cancellation = options.cancellationBuffer
    ? new Int32Array(options.cancellationBuffer)
    : undefined
  throwIfCancelled(cancellation)
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    timeout: 5_000
  })
  database.exec("PRAGMA query_only = ON")
  database.exec("BEGIN")
  try {
    const row = readLatestCheckpointRow(database, threadId, checkpointNs, true)
    if (!row || row.metadata === undefined) {
      database.exec("COMMIT")
      return null
    }
    const rawCheckpoint = parseTypedJson(row.type, row.checkpoint, "checkpoint")
    throwIfCancelled(cancellation)
    if (!rawCheckpoint || typeof rawCheckpoint !== "object" || Array.isArray(rawCheckpoint)) {
      throw new Error("[CheckpointRuntimeWorker] Invalid checkpoint object")
    }
    const checkpoint = hydrateRawCheckpointMessages(
      database,
      row,
      rawCheckpoint as Record<string, unknown>,
      cancellation
    )
    const boundedTransfer =
      options.messageLimit !== undefined || options.messageByteBudget !== undefined
    if (boundedTransfer) {
      database.exec("COMMIT")
      return checkpointTupleFromRaw({
        row,
        checkpoint: buildBoundedCheckpointTransfer(checkpoint, options, cancellation)
      })
    }
    const metadata = parseTypedJson(row.type, row.metadata, "checkpoint metadata")
    const pendingWrites = Array.from(
      database
        .prepare(
          `SELECT task_id, channel, type, value
           FROM writes
           WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
        )
        .iterate(row.threadId, row.checkpointNs, row.checkpointId)
    ).map((write) => [
      String(write.task_id ?? ""),
      String(write.channel ?? ""),
      parseTypedJson(
        typeof write.type === "string" ? write.type : "json",
        normalizePayload(write.value, "pending write"),
        "pending write"
      )
    ])
    database.exec("COMMIT")
    return {
      config: {
        configurable: {
          thread_id: row.threadId,
          checkpoint_ns: row.checkpointNs,
          checkpoint_id: row.checkpointId
        }
      },
      checkpoint,
      metadata,
      ...(row.parentCheckpointId
        ? {
            parentConfig: {
              configurable: {
                thread_id: row.threadId,
                checkpoint_ns: row.checkpointNs,
                checkpoint_id: row.parentCheckpointId
              }
            }
          }
        : {}),
      pendingWrites
    }
  } catch (error) {
    try {
      database.exec("ROLLBACK")
    } catch {
      // Preserve the original read error.
    }
    throw error
  } finally {
    database.close()
  }
}
