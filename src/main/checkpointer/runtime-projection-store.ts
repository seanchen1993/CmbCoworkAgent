import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import type {
  CheckpointRuntimeProjectionStats,
  LegacyCheckpointTranscriptMigrationStats
} from "./runtime-projection-protocol"
import {
  CHECKPOINT_RUNTIME_PROJECTION_CANCELLED,
  CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY
} from "./runtime-projection-protocol"
import {
  getMessageProviderTupleFromMetadata,
  normalizeCompleteSnapshotMessageIds
} from "../../shared/message-role-collision"
import {
  isRestorableConversationTranscriptMessage,
  isWorkflowPlumbingTranscriptContent
} from "../../shared/checkpoint-transcript"
import { isSerializedSummarizationMessage } from "../../shared/context-compaction-messages"
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
const CHECKPOINT_TRANSCRIPT_PRESENCE_BYTE_BUDGET = 8 * 1024 * 1024
const CHECKPOINT_TRANSCRIPT_PRESENCE_CHAIN_LIMIT = 4_096
const CHECKPOINT_RUNTIME_SOURCE_FIELDS_CHAR_LIMIT = 4 * 1024 * 1024
const CHECKPOINT_RUNTIME_PROJECTION_BYTE_LIMIT = 512 * 1024
// checkpoint_ts was added after the original base table. Worker reads preserve
// that deployed layout by using checkpoint_id, exactly as the later saver migration does.
const CHECKPOINT_REQUIRED_COLUMNS = [
  "thread_id",
  "checkpoint_ns",
  "checkpoint_id",
  "parent_checkpoint_id",
  "type",
  "checkpoint",
  "metadata"
] as const
const MESSAGE_SNAPSHOT_COLUMNS = [
  "thread_id",
  "checkpoint_ns",
  "checkpoint_id",
  "parent_checkpoint_id",
  "prefix_length",
  "message_count",
  "type",
  "suffix"
] as const
const RUNTIME_PROJECTION_COLUMNS = [
  "thread_id",
  "checkpoint_ns",
  "checkpoint_id",
  "parent_checkpoint_id",
  "checkpoint_ts",
  "projection_version",
  "type",
  "runtime_checkpoint"
] as const
const WRITES_COLUMNS = [
  "thread_id",
  "checkpoint_ns",
  "checkpoint_id",
  "task_id",
  "idx",
  "channel",
  "type",
  "value"
] as const

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

class CheckpointRuntimeProjectionSchemaNotReadyError extends Error {
  constructor() {
    super("Checkpoint database schema is not fully published yet")
    this.name = CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY
  }
}

interface CheckpointSchemaLayout {
  hasCheckpointTs: boolean
}

function sqliteTableColumns(database: DatabaseSync, tableName: string): Set<string> {
  const columns = database.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
    name?: unknown
  }>
  return new Set(columns.map((column) => String(column.name ?? "")))
}

function sqliteTableHasColumns(
  database: DatabaseSync,
  tableName: string,
  requiredColumns: readonly string[]
): boolean {
  const columns = sqliteTableColumns(database, tableName)
  return columns.size > 0 && requiredColumns.every((column) => columns.has(column))
}

function checkpointSchemaLayout(database: DatabaseSync): CheckpointSchemaLayout | null {
  const columns = sqliteTableColumns(database, "checkpoints")
  if (
    columns.size === 0 ||
    !CHECKPOINT_REQUIRED_COLUMNS.every((column) => columns.has(column))
  ) {
    return null
  }
  return { hasCheckpointTs: columns.has("checkpoint_ts") }
}

function messageSnapshotSchemaIsPublished(database: DatabaseSync): boolean {
  return sqliteTableHasColumns(database, "checkpoint_message_snapshots", MESSAGE_SNAPSHOT_COLUMNS)
}

function runtimeProjectionSchemaIsPublished(database: DatabaseSync): boolean {
  return sqliteTableHasColumns(
    database,
    "checkpoint_runtime_projections",
    RUNTIME_PROJECTION_COLUMNS
  )
}

function writesSchemaIsPublished(database: DatabaseSync): boolean {
  return sqliteTableHasColumns(database, "writes", WRITES_COLUMNS)
}

function assertSchemaLayerIsPublished(published: boolean): void {
  if (!published) throw new CheckpointRuntimeProjectionSchemaNotReadyError()
}

function assertCheckpointSchemaIsPublished(database: DatabaseSync): CheckpointSchemaLayout {
  const layout = checkpointSchemaLayout(database)
  if (!layout) throw new CheckpointRuntimeProjectionSchemaNotReadyError()
  return layout
}

function assertMessageSnapshotSchemaIsPublished(database: DatabaseSync): void {
  assertSchemaLayerIsPublished(messageSnapshotSchemaIsPublished(database))
}

function assertWritesSchemaIsPublished(database: DatabaseSync): void {
  assertSchemaLayerIsPublished(writesSchemaIsPublished(database))
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

interface StoredRuntimeProjectionRow {
  threadId: string
  checkpointNs: string
  checkpointId: string
  parentCheckpointId: string | null
  checkpointTs: string
  type: string
  runtimeCheckpoint: string | Uint8Array
}

interface PreparedRuntimeProjectionOnly {
  row: Omit<StoredRuntimeProjectionRow, "type" | "runtimeCheckpoint">
  runtimeCheckpoint: Uint8Array
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

function checkpointTimestampExpression(
  layout: CheckpointSchemaLayout,
  tableAlias?: "checkpoint" | "newer"
): string {
  const prefix = tableAlias ? `${tableAlias}.` : ""
  return layout.hasCheckpointTs
    ? `COALESCE(${prefix}checkpoint_ts, ${prefix}checkpoint_id)`
    : `${prefix}checkpoint_id`
}

function readLatestCheckpointRow(
  database: DatabaseSync,
  threadId: string,
  checkpointNs: string,
  includeMetadata: boolean,
  layout: CheckpointSchemaLayout = assertCheckpointSchemaIsPublished(database)
): StoredCheckpointRow | null {
  const checkpointTimestamp = checkpointTimestampExpression(layout)
  const row = database
    .prepare(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
              ${checkpointTimestamp} AS checkpoint_ts,
              type, checkpoint${includeMetadata ? ", metadata" : ""}
       FROM checkpoints
       WHERE thread_id = ? AND checkpoint_ns = ?
       ORDER BY ${checkpointTimestamp} DESC, checkpoint_id DESC
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
    ...(includeMetadata ? { metadata: normalizePayload(row.metadata, "checkpoint metadata") } : {})
  }
}

function hasCurrentRuntimeProjection(
  database: DatabaseSync,
  threadId: string,
  checkpointNs: string,
  layout: CheckpointSchemaLayout = assertCheckpointSchemaIsPublished(database)
): boolean {
  const newerTimestamp = checkpointTimestampExpression(layout, "newer")
  const checkpointTimestamp = checkpointTimestampExpression(layout, "checkpoint")
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
               ${newerTimestamp} > ${checkpointTimestamp}
               OR (
                 ${newerTimestamp} = ${checkpointTimestamp}
                 AND newer.checkpoint_id > checkpoint.checkpoint_id
               )
             )
         )
       LIMIT 1`
    )
    .get(threadId, checkpointNs, CHECKPOINT_RUNTIME_PROJECTION_VERSION)
  return Boolean(row)
}

function sanitizeRuntimeCheckpoint(
  value: unknown,
  row: Pick<StoredRuntimeProjectionRow, "checkpointId" | "checkpointTs">
): Checkpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[CheckpointRuntimeWorker] Invalid runtime checkpoint object")
  }
  const bounded = buildCheckpointRuntimeProjection(value as Checkpoint)
  const channelValues =
    bounded.channel_values &&
    typeof bounded.channel_values === "object" &&
    !Array.isArray(bounded.channel_values)
      ? bounded.channel_values
      : {}
  return {
    ...bounded,
    id: row.checkpointId,
    ts: typeof bounded.ts === "string" ? bounded.ts : row.checkpointTs,
    channel_values: {
      ...channelValues,
      // Runtime hydration has a strict no-transcript contract. An explicit
      // empty array preserves the renderer's legacy shape without allowing a
      // forged or stale projection to smuggle checkpoint history over IPC.
      messages: []
    }
  }
}

function runtimeTupleFromProjectionRow(row: StoredRuntimeProjectionRow): unknown {
  const runtimeCheckpoint = parseTypedJson(
    row.type,
    row.runtimeCheckpoint,
    "runtime checkpoint"
  )
  return {
    config: {
      configurable: {
        thread_id: row.threadId,
        checkpoint_ns: row.checkpointNs,
        checkpoint_id: row.checkpointId
      }
    },
    checkpoint: sanitizeRuntimeCheckpoint(runtimeCheckpoint, row),
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
      : {})
  }
}

function readCurrentRuntimeProjectionRow(
  database: DatabaseSync,
  threadId: string,
  checkpointNs: string,
  layout: CheckpointSchemaLayout
): StoredRuntimeProjectionRow | null {
  if (!runtimeProjectionSchemaIsPublished(database)) return null
  const newerTimestamp = checkpointTimestampExpression(layout, "newer")
  const checkpointTimestamp = checkpointTimestampExpression(layout, "checkpoint")
  const row = database
    .prepare(
      `SELECT projection.thread_id, projection.checkpoint_ns, projection.checkpoint_id,
              projection.parent_checkpoint_id, projection.checkpoint_ts,
              projection.type, projection.runtime_checkpoint
       FROM checkpoint_runtime_projections AS projection
       JOIN checkpoints AS checkpoint
         ON checkpoint.thread_id = projection.thread_id
        AND checkpoint.checkpoint_ns = projection.checkpoint_ns
        AND checkpoint.checkpoint_id = projection.checkpoint_id
       WHERE projection.thread_id = ? AND projection.checkpoint_ns = ?
         AND projection.projection_version = ?
         AND length(projection.runtime_checkpoint) <= ?
         AND NOT EXISTS (
           SELECT 1 FROM checkpoints AS newer
           WHERE newer.thread_id = checkpoint.thread_id
             AND newer.checkpoint_ns = checkpoint.checkpoint_ns
             AND (
               ${newerTimestamp} > ${checkpointTimestamp}
               OR (
                 ${newerTimestamp} = ${checkpointTimestamp}
                 AND newer.checkpoint_id > checkpoint.checkpoint_id
               )
             )
         )
       LIMIT 1`
    )
    .get(
      threadId,
      checkpointNs,
      CHECKPOINT_RUNTIME_PROJECTION_VERSION,
      CHECKPOINT_RUNTIME_PROJECTION_BYTE_LIMIT
    ) as Record<string, unknown> | undefined
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
    runtimeCheckpoint: normalizePayload(row.runtime_checkpoint, "runtime checkpoint")
  }
}

function prepareLatestRuntimeProjectionOnly(
  database: DatabaseSync,
  threadId: string,
  checkpointNs: string,
  layout: CheckpointSchemaLayout,
  cancellation?: Int32Array
): PreparedRuntimeProjectionOnly | null {
  throwIfCancelled(cancellation)
  const checkpointTimestamp = checkpointTimestampExpression(layout)
  // A multi-path json_extract scans the legacy document in SQLite and returns
  // only the five small runtime fields. In particular, channel_values.messages
  // is never materialized in JavaScript, serialized again, or sent over IPC.
  const row = database
    .prepare(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
              ${checkpointTimestamp} AS checkpoint_ts, type,
              substr(
                json_extract(
                  CAST(checkpoint AS TEXT),
                  '$.v',
                  '$.id',
                  '$.ts',
                  '$.channel_values.todos',
                  '$.channel_values.__interrupt__'
                ),
                1,
                ?
              ) AS runtime_fields
       FROM checkpoints
       WHERE thread_id = ? AND checkpoint_ns = ?
       ORDER BY ${checkpointTimestamp} DESC, checkpoint_id DESC
       LIMIT 1`
    )
    .get(CHECKPOINT_RUNTIME_SOURCE_FIELDS_CHAR_LIMIT + 1, threadId, checkpointNs) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  throwIfCancelled(cancellation)
  const sourceType = typeof row.type === "string" ? row.type : "json"
  if (sourceType !== "json") {
    throw new Error(
      `[CheckpointRuntimeWorker] Unsupported runtime checkpoint serialization: ${sourceType}`
    )
  }
  const runtimeFields = row.runtime_fields
  if (typeof runtimeFields !== "string") {
    throw new Error("[CheckpointRuntimeWorker] Invalid runtime checkpoint JSON fields")
  }
  if (runtimeFields.length > CHECKPOINT_RUNTIME_SOURCE_FIELDS_CHAR_LIMIT) {
    throw new Error("[CheckpointRuntimeWorker] Runtime checkpoint fields exceed safety limit")
  }
  const fields = JSON.parse(runtimeFields) as unknown
  if (!Array.isArray(fields) || fields.length !== 5) {
    throw new Error("[CheckpointRuntimeWorker] Invalid runtime checkpoint field projection")
  }
  const checkpointId = String(row.checkpoint_id ?? "")
  const checkpointTs = String(row.checkpoint_ts ?? checkpointId)
  const projected = buildCheckpointRuntimeProjection({
    v: typeof fields[0] === "number" ? fields[0] : 1,
    id: checkpointId,
    ts: typeof fields[2] === "string" ? fields[2] : checkpointTs,
    channel_values: {
      ...(Array.isArray(fields[3]) ? { todos: fields[3] } : {}),
      ...(Array.isArray(fields[4]) ? { __interrupt__: fields[4] } : {})
    },
    channel_versions: {},
    versions_seen: {}
  } as Checkpoint)
  const runtimeCheckpoint = serializeJsonPayload(projected)
  if (runtimeCheckpoint.byteLength > CHECKPOINT_RUNTIME_PROJECTION_BYTE_LIMIT) {
    throw new Error("[CheckpointRuntimeWorker] Runtime projection exceeds safety limit")
  }
  return {
    row: {
      threadId: String(row.thread_id ?? ""),
      checkpointNs: String(row.checkpoint_ns ?? ""),
      checkpointId,
      parentCheckpointId:
        row.parent_checkpoint_id === null || row.parent_checkpoint_id === undefined
          ? null
          : String(row.parent_checkpoint_id),
      checkpointTs
    },
    runtimeCheckpoint
  }
}

function exactRuntimeProjectionSourceIsStillLatest(
  database: DatabaseSync,
  prepared: PreparedRuntimeProjectionOnly,
  layout: CheckpointSchemaLayout
): boolean {
  const { row } = prepared
  const newerTimestamp = checkpointTimestampExpression(layout, "newer")
  const checkpointTimestamp = checkpointTimestampExpression(layout, "checkpoint")
  return Boolean(
    database
      .prepare(
        `SELECT 1
         FROM checkpoints AS checkpoint
         WHERE checkpoint.thread_id = ? AND checkpoint.checkpoint_ns = ?
           AND checkpoint.checkpoint_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM checkpoints AS newer
             WHERE newer.thread_id = checkpoint.thread_id
               AND newer.checkpoint_ns = checkpoint.checkpoint_ns
               AND (
                 ${newerTimestamp} > ${checkpointTimestamp}
                 OR (
                   ${newerTimestamp} = ${checkpointTimestamp}
                   AND newer.checkpoint_id > checkpoint.checkpoint_id
                 )
               )
           )
         LIMIT 1`
      )
      .get(row.threadId, row.checkpointNs, row.checkpointId)
  )
}

function commitRuntimeProjectionOnly(
  database: DatabaseSync,
  prepared: PreparedRuntimeProjectionOnly,
  layout: CheckpointSchemaLayout
): boolean {
  const canPersistProjection = runtimeProjectionSchemaIsPublished(database)
  database.exec("BEGIN IMMEDIATE")
  try {
    if (!exactRuntimeProjectionSourceIsStillLatest(database, prepared, layout)) {
      database.exec("ROLLBACK")
      return false
    }
    if (canPersistProjection) {
      const { row } = prepared
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
    }
    database.exec("COMMIT")
    return true
  } catch (error) {
    try {
      database.exec("ROLLBACK")
    } catch {
      // Preserve the projection write failure.
    }
    throw error
  }
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
  const layout = assertCheckpointSchemaIsPublished(database)
  return prepareLatestRuntimeProjectionMigrationWithLayout(
    database,
    threadId,
    checkpointNs,
    layout
  )
}

function prepareLatestRuntimeProjectionMigrationWithLayout(
  database: DatabaseSync,
  threadId: string,
  checkpointNs: string,
  layout: CheckpointSchemaLayout
): PreparedRuntimeProjectionMigration | null {
  const row = readLatestCheckpointRow(database, threadId, checkpointNs, false, layout)
  return row ? prepareRuntimeProjectionMigration(row) : null
}

function checkpointSnapshotChainFitsPresenceBudget(
  database: DatabaseSync,
  row: StoredCheckpointRow,
  cancellation?: Int32Array
): boolean {
  const visited = new Set<string>()
  let cursor: string | null = row.checkpointId
  let totalBytes = 0
  while (cursor) {
    throwIfCancelled(cancellation)
    if (visited.has(cursor) || visited.size >= CHECKPOINT_TRANSCRIPT_PRESENCE_CHAIN_LIMIT) {
      return false
    }
    visited.add(cursor)
    const snapshot = database
      .prepare(
        `SELECT parent_checkpoint_id, suffix
         FROM checkpoint_message_snapshots
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
         LIMIT 1`
      )
      .get(row.threadId, row.checkpointNs, cursor) as Record<string, unknown> | undefined
    if (!snapshot) return false
    totalBytes += payloadBytes(normalizePayload(snapshot.suffix, "message snapshot"))
    if (totalBytes > CHECKPOINT_TRANSCRIPT_PRESENCE_BYTE_BUDGET) return false
    cursor =
      snapshot.parent_checkpoint_id === null || snapshot.parent_checkpoint_id === undefined
        ? null
        : String(snapshot.parent_checkpoint_id)
  }
  return true
}

function isVisibleSerializedCheckpointMessage(raw: unknown): boolean {
  if (isSerializedSummarizationMessage(raw)) return false
  const message = objectRecord(raw)
  if (!message) return false
  const kwargs = objectRecord(message.kwargs) ?? {}
  const additionalKwargs =
    objectRecord(message.additional_kwargs) ?? objectRecord(kwargs.additional_kwargs) ?? {}
  if (additionalKwargs.cmb_internal_coordinator_notification === true) return false
  const role = serializedMessageRole(message, kwargs)
  const rawContent = message.content ?? kwargs.content
  const visibleUserMessage = additionalKwargs.cmb_visible_user_message
  const effectiveContent =
    role === "user" && typeof visibleUserMessage === "string" && visibleUserMessage.length > 0
      ? visibleUserMessage
      : rawContent
  const content =
    typeof effectiveContent === "string" || Array.isArray(effectiveContent)
      ? effectiveContent
      : ""
  return isRestorableConversationTranscriptMessage(role, content)
}

/**
 * Compatibility guard for tasks whose durable transcript is not authoritative
 * yet. Small internal-only checkpoints are distinguished from real conversation
 * rows inside the isolated worker. Oversized/cyclic snapshots return true so a
 * mutation fails closed without hydrating unbounded history.
 */
export function hasVisibleCheckpointTranscript(
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
    // Old inline-checkpoint databases predate the auxiliary snapshot,
    // projection and writes tables. Only the authoritative checkpoint table is
    // required until the payload proves that it references external messages.
    const checkpointSchema = assertCheckpointSchemaIsPublished(database)
    const row = readLatestCheckpointRow(
      database,
      threadId,
      checkpointNs,
      true,
      checkpointSchema
    )
    if (!row || row.metadata === undefined) return false
    throwIfCancelled(cancellation)
    if (payloadBytes(row.checkpoint) > CHECKPOINT_TRANSCRIPT_PRESENCE_BYTE_BUDGET) return true
    const parsed = parseTypedJson(row.type, row.checkpoint, "checkpoint")
    throwIfCancelled(cancellation)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
    const channelValues = objectRecord((parsed as Record<string, unknown>).channel_values)
    const messages = channelValues?.messages
    if (Array.isArray(messages)) return messages.some(isVisibleSerializedCheckpointMessage)
    const reference = objectRecord(messages)
    if (reference?.[EXTERNAL_MESSAGES_MARKER] !== true) return false
    // An external marker without its snapshot schema is a publication race or
    // an incomplete legacy upgrade. Surface a transient result instead of a
    // raw SQLite "no such table" error or an authoritative empty answer.
    assertMessageSnapshotSchemaIsPublished(database)
    const messageCount = Number(reference.messageCount)
    if (Number.isSafeInteger(messageCount) && messageCount === 0) return false
    // A missing/cyclic/oversized chain cannot prove the transcript empty, so
    // preserve the mutation guard's fail-closed result.
    if (!checkpointSnapshotChainFitsPresenceBudget(database, row, cancellation)) return true
    const hydrated = hydrateRawCheckpointMessages(
      database,
      row,
      parsed as Record<string, unknown>,
      cancellation
    )
    const hydratedMessages = objectRecord(hydrated.channel_values)?.messages
    return Array.isArray(hydratedMessages)
      ? hydratedMessages.some(isVisibleSerializedCheckpointMessage)
      : true
  } finally {
    database.close()
  }
}

function exactSourceIsStillLatest(
  database: DatabaseSync,
  prepared: PreparedRuntimeProjectionMigration,
  layout: CheckpointSchemaLayout = assertCheckpointSchemaIsPublished(database)
): boolean {
  const { row } = prepared
  const newerTimestamp = checkpointTimestampExpression(layout, "newer")
  const checkpointTimestamp = checkpointTimestampExpression(layout, "checkpoint")
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
               ${newerTimestamp} > ${checkpointTimestamp}
               OR (
                 ${newerTimestamp} = ${checkpointTimestamp}
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

function ensureMessageSnapshotGeneration(database: DatabaseSync): void {
  let transactionStarted = false
  try {
    database.exec("BEGIN IMMEDIATE")
    transactionStarted = true
    const columns = database
      .prepare("PRAGMA table_info(checkpoint_message_snapshots)")
      .all() as Array<{ name?: unknown }>
    if (!columns.some((column) => column.name === "generation")) {
      database.exec(
        `ALTER TABLE checkpoint_message_snapshots
         ADD COLUMN generation TEXT NOT NULL DEFAULT ''`
      )
    }
    database.exec(
      `UPDATE checkpoint_message_snapshots
       SET generation = lower(hex(randomblob(16)))
       WHERE generation IS NULL OR typeof(generation) != 'text' OR length(generation) = 0`
    )
    database.exec("COMMIT")
    transactionStarted = false
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK")
      } catch {
        // Keep the original migration failure.
      }
    }
    throw error
  }
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
  if (prepared.messages && prepared.compactCheckpoint) {
    ensureMessageSnapshotGeneration(database)
  }
  database.exec("BEGIN IMMEDIATE")
  try {
    if (!exactSourceIsStillLatest(database, prepared)) {
      database.exec("ROLLBACK")
      return false
    }

    if (prepared.messages && prepared.compactCheckpoint) {
      database
        .prepare(
          `INSERT INTO checkpoint_message_snapshots
           (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, prefix_length,
            message_count, generation, type, suffix)
           VALUES (?, ?, ?, NULL, 0, ?, ?, 'json', ?)
           ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET
             parent_checkpoint_id = excluded.parent_checkpoint_id,
             prefix_length = excluded.prefix_length,
             message_count = excluded.message_count,
             generation = excluded.generation,
             type = excluded.type,
             suffix = excluded.suffix`
        )
        .run(
          row.threadId,
          row.checkpointNs,
          row.checkpointId,
          prepared.messageCount,
          randomUUID(),
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
  const emptyStats = (): CheckpointRuntimeProjectionStats => ({
    sourceBytes: 0,
    projectionBytes: 0,
    inlineMessageCount: 0,
    migrated: false,
    stale: false
  })
  if (!existsSync(databasePath)) return emptyStats()
  const database = new DatabaseSync(databasePath, { timeout: 5_000 })
  try {
    database.exec("PRAGMA busy_timeout = 5000")
    // Projection persistence always needs its source and destination tables.
    // Snapshot storage is asserted later only when this particular checkpoint
    // still contains inline messages. Pending writes are unrelated.
    const checkpointSchema = checkpointSchemaLayout(database)
    if (!checkpointSchema || !runtimeProjectionSchemaIsPublished(database)) {
      return emptyStats()
    }
    if (hasCurrentRuntimeProjection(database, threadId, checkpointNs, checkpointSchema)) {
      return emptyStats()
    }
    const prepared = prepareLatestRuntimeProjectionMigrationWithLayout(
      database,
      threadId,
      checkpointNs,
      checkpointSchema
    )
    if (!prepared) {
      return emptyStats()
    }
    if (prepared.messages && !messageSnapshotSchemaIsPublished(database)) return emptyStats()
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

/**
 * Read renderer/runtime affordances without reconstructing checkpoint history.
 * A current v1 projection is preferred. Legacy inline checkpoints are scanned
 * inside SQLite for only the bounded runtime fields; external snapshot chains
 * are never opened by this path.
 */
export function readLatestCheckpointRuntimeTuple(
  databasePath: string,
  threadId: string,
  checkpointNs: string,
  cancellationBuffer?: SharedArrayBuffer
): unknown | null {
  const cancellation = cancellationBuffer ? new Int32Array(cancellationBuffer) : undefined
  throwIfCancelled(cancellation)
  if (!existsSync(databasePath)) return null
  const database = new DatabaseSync(databasePath, { timeout: 5_000 })
  try {
    database.exec("PRAGMA busy_timeout = 5000")
    const layout = assertCheckpointSchemaIsPublished(database)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      throwIfCancelled(cancellation)
      const current = readCurrentRuntimeProjectionRow(
        database,
        threadId,
        checkpointNs,
        layout
      )
      if (current) {
        try {
          return runtimeTupleFromProjectionRow(current)
        } catch {
          // A version-labelled row can still be corrupt or left by a broken
          // pre-release build. Rebuild from the authoritative checkpoint.
        }
      }

      const prepared = prepareLatestRuntimeProjectionOnly(
        database,
        threadId,
        checkpointNs,
        layout,
        cancellation
      )
      if (!prepared) return null
      throwIfCancelled(cancellation)
      if (!commitRuntimeProjectionOnly(database, prepared, layout)) continue
      return runtimeTupleFromProjectionRow({
        ...prepared.row,
        type: "json",
        runtimeCheckpoint: prepared.runtimeCheckpoint
      })
    }
    throw new Error("[CheckpointRuntimeWorker] Checkpoint changed during runtime projection read")
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

  assertMessageSnapshotSchemaIsPublished(database)

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
    if (isSerializedSummarizationMessage(rawMessages[index])) continue
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
    const visibleUserMessage = additionalKwargs.cmb_visible_user_message
    const effectiveContent =
      role === "user" && typeof visibleUserMessage === "string" && visibleUserMessage.length > 0
        ? visibleUserMessage
        : rawContent
    const content =
      typeof effectiveContent === "string" || Array.isArray(effectiveContent)
        ? effectiveContent
        : ""
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
  row: Pick<
    StoredCheckpointRow,
    "threadId" | "checkpointNs" | "checkpointId" | "parentCheckpointId"
  >
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
  const emptyResult = (): LegacyCheckpointTranscriptBootstrapResult => ({
    runtimeTuple: null,
    stats: {
      checkpointId: null,
      totalMessages: 0,
      migratedMessages: 0,
      batches: 0,
      payloadBytes: 0
    }
  })
  if (!existsSync(checkpointDatabasePath)) return emptyResult()
  const checkpointDatabase = new DatabaseSync(checkpointDatabasePath, { timeout: 5_000 })
  try {
    checkpointDatabase.exec("PRAGMA busy_timeout = 5000")
    // Bootstrap can recover an inline legacy transcript using only the base
    // checkpoint table. Auxiliary tables are optional optimizations unless the
    // checkpoint itself contains an external-message marker.
    const checkpointSchema = assertCheckpointSchemaIsPublished(checkpointDatabase)
    checkpointDatabase.exec("BEGIN")
    let row: StoredCheckpointRow | null = null
    let rawCheckpoint: Record<string, unknown> | null = null
    let hydratedCheckpoint: Record<string, unknown> | null = null
    try {
      throwIfCancelled(cancellation)
      row = readLatestCheckpointRow(
        checkpointDatabase,
        threadId,
        checkpointNs,
        true,
        checkpointSchema
      )
      if (!row || row.metadata === undefined) {
        checkpointDatabase.exec("COMMIT")
        return emptyResult()
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
    const canPersistProjection =
      runtimeProjectionSchemaIsPublished(checkpointDatabase) &&
      (!prepared.messages || messageSnapshotSchemaIsPublished(checkpointDatabase))
    // A base-only legacy database can still return an in-memory projection and
    // migrate its transcript. Keep the stale-source CAS even when auxiliary
    // projection persistence is unavailable.
    const sourceStillCurrent = canPersistProjection
      ? commitPreparedRuntimeProjection(checkpointDatabase, prepared)
      : exactSourceIsStillLatest(checkpointDatabase, prepared, checkpointSchema)
    if (!sourceStillCurrent) {
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
// The SQLite tail reader never lets an individual serialized message enter V8
// above this size. Oversized rows are projected to bounded scalar fields in SQL.
const CHECKPOINT_TRANSFER_RAW_MESSAGE_BYTE_LIMIT = 64 * 1024
// Invalid/non-object tail entries are skipped by the legacy transfer contract.
// Scan a bounded cushion so malformed history cannot turn a UI read into a full
// transcript walk while normal histories can still fill the requested window.
const CHECKPOINT_TRANSFER_MAX_SCAN_MESSAGES = 4_096

interface BoundedCheckpointTransferOptions {
  messageLimit: number
  messageByteBudget: number
}

interface BoundedCheckpointMessageRow {
  messageIndex: number
  rawMessage: string | null
  fallbackMessage: string | null
}

interface ExternalMessageSnapshotSegment {
  checkpointId: string
  localStart: number
  localEnd: number
  globalOffset: number
}

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

function normalizeBoundedCheckpointTransferOptions(options: {
  messageLimit?: number
  messageByteBudget?: number
}): BoundedCheckpointTransferOptions {
  return {
    messageLimit: Math.min(
      CHECKPOINT_TRANSFER_MAX_MESSAGE_LIMIT,
      Math.max(0, Math.floor(options.messageLimit ?? CHECKPOINT_TRANSFER_DEFAULT_MESSAGE_LIMIT))
    ),
    messageByteBudget: Math.min(
      CHECKPOINT_TRANSFER_MAX_BYTE_BUDGET,
      Math.max(
        0,
        Math.floor(options.messageByteBudget ?? CHECKPOINT_TRANSFER_DEFAULT_BYTE_BUDGET)
      )
    )
  }
}

function boundedTransferCheckpointMessageFromRow(
  row: BoundedCheckpointMessageRow
): unknown | null {
  const serialized = row.rawMessage ?? row.fallbackMessage
  if (serialized === null) return null
  return boundedTransferCheckpointMessage(
    JSON.parse(serialized) as unknown,
    row.messageIndex
  )
}

class BoundedCheckpointMessageWindow {
  readonly messages: unknown[] = []
  private messageBytes: number[] = []
  private selectedBytes = 0

  constructor(private readonly options: BoundedCheckpointTransferOptions) {}

  get isDisabled(): boolean {
    return this.options.messageLimit === 0 || this.options.messageByteBudget === 0
  }

  get scanMessageLimit(): number {
    if (this.isDisabled) return 0
    return Math.min(
      CHECKPOINT_TRANSFER_MAX_SCAN_MESSAGES,
      this.options.messageLimit + Math.min(64, this.options.messageLimit)
    )
  }

  pushChronological(row: BoundedCheckpointMessageRow): void {
    if (this.isDisabled) return
    const message = boundedTransferCheckpointMessageFromRow(row)
    if (!message) return
    const messageBytes = payloadBytes(JSON.stringify(message))
    if (messageBytes > this.options.messageByteBudget) {
      this.messages.length = 0
      this.messageBytes.length = 0
      this.selectedBytes = 0
      return
    }
    this.messages.push(message)
    this.messageBytes.push(messageBytes)
    this.selectedBytes += messageBytes
    while (
      this.messages.length > this.options.messageLimit ||
      this.selectedBytes > this.options.messageByteBudget
    ) {
      this.messages.shift()
      this.selectedBytes -= this.messageBytes.shift() ?? 0
    }
  }
}

const BOUNDED_CHECKPOINT_MESSAGE_SELECT = `
  CAST(message.key AS INTEGER) AS message_index,
  CASE
    WHEN length(CAST(message.value AS BLOB)) <= ? THEN CAST(message.value AS TEXT)
    ELSE NULL
  END AS raw_message,
  CASE
    WHEN length(CAST(message.value AS BLOB)) > ? THEN
      json_object(
        'id', CASE
          WHEN json_type(message.value, '$.id') = 'array'
           AND json_type(message.value, '$.id[#-1]') = 'text'
            THEN json_array(substr(json_extract(message.value, '$.id[#-1]'), 1, 256))
          ELSE NULL
        END,
        'type', substr(
          COALESCE(
            CASE WHEN json_type(message.value, '$.type') = 'text'
              THEN json_extract(message.value, '$.type') END,
            CASE WHEN json_type(message.value, '$.kwargs.type') = 'text'
              THEN json_extract(message.value, '$.kwargs.type') END,
            CASE WHEN json_type(message.value, '$.role') = 'text'
              THEN json_extract(message.value, '$.role') END,
            CASE WHEN json_type(message.value, '$.kwargs.role') = 'text'
              THEN json_extract(message.value, '$.kwargs.role') END,
            'assistant'
          ),
          1,
          128
        ),
        'content', CASE
          WHEN json_type(message.value, '$.content') = 'text'
            THEN substr(json_extract(message.value, '$.content'), 1, ${CHECKPOINT_TRANSFER_CONTENT_TEXT_LIMIT})
          WHEN json_type(message.value, '$.content') = 'array'
            THEN '[Oversized structured checkpoint content omitted]'
          WHEN json_type(message.value, '$.content') IS NOT NULL
            AND json_type(message.value, '$.content') <> 'null'
            THEN ''
          WHEN json_type(message.value, '$.kwargs.content') = 'text'
            THEN substr(json_extract(message.value, '$.kwargs.content'), 1, ${CHECKPOINT_TRANSFER_CONTENT_TEXT_LIMIT})
          WHEN json_type(message.value, '$.kwargs.content') = 'array'
            THEN '[Oversized structured checkpoint content omitted]'
          ELSE ''
        END,
        'tool_calls', json(
          COALESCE(
            (
              SELECT json_group_array(
                json_object(
                  'id', substr(
                    CASE WHEN json_type(bounded_tool.tool_value, '$.id') = 'text'
                      THEN json_extract(bounded_tool.tool_value, '$.id') END,
                    1,
                    256
                  ),
                  'name', substr(
                    CASE WHEN json_type(bounded_tool.tool_value, '$.name') = 'text'
                      THEN json_extract(bounded_tool.tool_value, '$.name') END,
                    1,
                    256
                  ),
                  'args', json_object()
                )
              )
              FROM (
                SELECT tool.value AS tool_value
                FROM json_each(
                  CASE
                    WHEN json_type(message.value, '$.tool_calls') = 'array'
                      THEN json_extract(message.value, '$.tool_calls')
                    WHEN json_type(message.value, '$.tool_calls') IS NOT NULL
                      AND json_type(message.value, '$.tool_calls') <> 'null'
                      THEN json('[]')
                    WHEN json_type(message.value, '$.kwargs.tool_calls') = 'array'
                      THEN json_extract(message.value, '$.kwargs.tool_calls')
                    ELSE json('[]')
                  END
                ) AS tool
                WHERE tool.type = 'object'
                LIMIT ${CHECKPOINT_TRANSFER_TOOL_CALL_LIMIT}
              ) AS bounded_tool
            ),
            '[]'
          )
        ),
        'is_error', CASE
          WHEN json_extract(message.value, '$.is_error') = 1
            OR json_extract(message.value, '$.kwargs.is_error') = 1
            THEN json('true')
          ELSE json('false')
        END,
        'kwargs', json_object(
          'id', substr(
            COALESCE(
              CASE WHEN json_type(message.value, '$.kwargs.id') = 'text'
                THEN json_extract(message.value, '$.kwargs.id') END,
              CASE WHEN json_type(message.value, '$.id') = 'text'
                THEN json_extract(message.value, '$.id') END
            ),
            1,
            256
          ),
          'tool_call_id', substr(
            COALESCE(
              CASE WHEN json_type(message.value, '$.tool_call_id') = 'text'
                THEN json_extract(message.value, '$.tool_call_id') END,
              CASE WHEN json_type(message.value, '$.kwargs.tool_call_id') = 'text'
                THEN json_extract(message.value, '$.kwargs.tool_call_id') END
            ),
            1,
            256
          ),
          'name', substr(
            COALESCE(
              CASE WHEN json_type(message.value, '$.name') = 'text'
                THEN json_extract(message.value, '$.name') END,
              CASE WHEN json_type(message.value, '$.kwargs.name') = 'text'
                THEN json_extract(message.value, '$.kwargs.name') END
            ),
            1,
            256
          ),
          'status', substr(
            COALESCE(
              CASE WHEN json_type(message.value, '$.status') = 'text'
                THEN json_extract(message.value, '$.status') END,
              CASE WHEN json_type(message.value, '$.kwargs.status') = 'text'
                THEN json_extract(message.value, '$.kwargs.status') END
            ),
            1,
            128
          ),
          'is_error', CASE
            WHEN json_extract(message.value, '$.is_error') = 1
              OR json_extract(message.value, '$.kwargs.is_error') = 1
              THEN json('true')
            ELSE json('false')
          END,
          'additional_kwargs', json_object(
            'cmb_internal_coordinator_notification', CASE
              WHEN (
                CASE
                  WHEN json_type(message.value, '$.additional_kwargs') = 'object'
                    THEN json_extract(message.value, '$.additional_kwargs.cmb_internal_coordinator_notification')
                  ELSE json_extract(message.value, '$.kwargs.additional_kwargs.cmb_internal_coordinator_notification')
                END
              ) = 1
                THEN json('true')
              ELSE json('false')
            END,
            'is_error', CASE
              WHEN (
                CASE
                  WHEN json_type(message.value, '$.additional_kwargs') = 'object'
                    THEN json_extract(message.value, '$.additional_kwargs.is_error')
                  ELSE json_extract(message.value, '$.kwargs.additional_kwargs.is_error')
                END
              ) = 1
                THEN json('true')
              ELSE json('false')
            END,
            'cmb_internal_provider_source_id', substr(
              CASE
                WHEN json_type(message.value, '$.additional_kwargs') = 'object'
                  THEN CASE
                    WHEN json_type(message.value, '$.additional_kwargs.cmb_internal_provider_source_id') = 'text'
                      THEN json_extract(message.value, '$.additional_kwargs.cmb_internal_provider_source_id')
                  END
                ELSE CASE
                  WHEN json_type(message.value, '$.kwargs.additional_kwargs.cmb_internal_provider_source_id') = 'text'
                    THEN json_extract(message.value, '$.kwargs.additional_kwargs.cmb_internal_provider_source_id')
                END
              END,
              1,
              256
            ),
            'cmb_internal_provider_occurrence', CASE
              WHEN json_type(message.value, '$.additional_kwargs') = 'object'
                THEN CASE
                  WHEN json_type(message.value, '$.additional_kwargs.cmb_internal_provider_occurrence') IN ('integer', 'real')
                    THEN json_extract(message.value, '$.additional_kwargs.cmb_internal_provider_occurrence')
                END
              ELSE CASE
                WHEN json_type(message.value, '$.kwargs.additional_kwargs.cmb_internal_provider_occurrence') IN ('integer', 'real')
                  THEN json_extract(message.value, '$.kwargs.additional_kwargs.cmb_internal_provider_occurrence')
              END
            END
          )
        )
      )
    ELSE NULL
  END AS fallback_message`

function boundedCheckpointMessageRow(raw: Record<string, unknown>): BoundedCheckpointMessageRow {
  const messageIndex = Number(raw.message_index)
  if (!Number.isSafeInteger(messageIndex) || messageIndex < 0) {
    throw new Error("[CheckpointRuntimeWorker] Invalid checkpoint message index")
  }
  return {
    messageIndex,
    rawMessage: typeof raw.raw_message === "string" ? raw.raw_message : null,
    fallbackMessage: typeof raw.fallback_message === "string" ? raw.fallback_message : null
  }
}

function boundedCheckpointTransferFromRuntime(input: {
  runtimeCheckpoint: Record<string, unknown>
  messages: unknown[]
  originalMessageCount: number
}): Record<string, unknown> {
  const runtimeChannelValues = objectRecord(input.runtimeCheckpoint.channel_values) ?? {}
  return {
    v: input.runtimeCheckpoint.v,
    id: input.runtimeCheckpoint.id,
    ts: input.runtimeCheckpoint.ts,
    channel_values: {
      ...runtimeChannelValues,
      messages: input.messages,
      __cmb_original_message_count: input.originalMessageCount
    },
    channel_versions: {},
    versions_seen: {}
  }
}

function readBoundedRuntimeCheckpoint(
  database: DatabaseSync,
  threadId: string,
  checkpointNs: string,
  layout: CheckpointSchemaLayout,
  cancellation?: Int32Array
): {
  row: StoredRuntimeProjectionRow
  runtimeCheckpoint: Record<string, unknown>
} | null {
  throwIfCancelled(cancellation)
  const current = readCurrentRuntimeProjectionRow(database, threadId, checkpointNs, layout)
  if (current) {
    try {
      return {
        row: current,
        runtimeCheckpoint: sanitizeRuntimeCheckpoint(
          parseTypedJson(current.type, current.runtimeCheckpoint, "runtime checkpoint"),
          current
        ) as unknown as Record<string, unknown>
      }
    } catch {
      // Rebuild a corrupt pre-release projection from bounded SQLite fields.
    }
  }
  const prepared = prepareLatestRuntimeProjectionOnly(
    database,
    threadId,
    checkpointNs,
    layout,
    cancellation
  )
  if (!prepared) return null
  const row: StoredRuntimeProjectionRow = {
    ...prepared.row,
    type: "json",
    runtimeCheckpoint: prepared.runtimeCheckpoint
  }
  return {
    row,
    runtimeCheckpoint: sanitizeRuntimeCheckpoint(
      parseTypedJson(row.type, row.runtimeCheckpoint, "runtime checkpoint"),
      row
    ) as unknown as Record<string, unknown>
  }
}

type BoundedCheckpointMessageSource =
  | { kind: "empty"; messageCount: 0 }
  | { kind: "inline"; messageCount: number }
  | { kind: "external"; markerMessageCount: number | null }

function inspectBoundedCheckpointMessageSource(
  database: DatabaseSync,
  row: StoredRuntimeProjectionRow
): BoundedCheckpointMessageSource {
  const source = database
    .prepare(
      `SELECT type,
              json_type(CAST(checkpoint AS TEXT), '$.channel_values.messages') AS message_type,
              json_array_length(CAST(checkpoint AS TEXT), '$.channel_values.messages') AS inline_count,
              json_extract(
                CAST(checkpoint AS TEXT),
                '$.channel_values.messages.${EXTERNAL_MESSAGES_MARKER}'
              ) AS external_marker,
              json_extract(
                CAST(checkpoint AS TEXT),
                '$.channel_values.messages.messageCount'
              ) AS marker_message_count
       FROM checkpoints
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
       LIMIT 1`
    )
    .get(row.threadId, row.checkpointNs, row.checkpointId) as
    | Record<string, unknown>
    | undefined
  if (!source) {
    throw new Error("[CheckpointRuntimeWorker] Checkpoint changed during bounded read")
  }
  const sourceType = typeof source.type === "string" ? source.type : "json"
  if (sourceType !== "json") {
    throw new Error(
      `[CheckpointRuntimeWorker] Unsupported checkpoint serialization: ${sourceType}`
    )
  }
  if (source.message_type === "array") {
    const messageCount = Number(source.inline_count)
    if (!Number.isSafeInteger(messageCount) || messageCount < 0) {
      throw new Error("[CheckpointRuntimeWorker] Invalid inline checkpoint message count")
    }
    return { kind: "inline", messageCount }
  }
  if (source.message_type === "object" && Number(source.external_marker) === 1) {
    const markerMessageCount = Number(source.marker_message_count)
    return {
      kind: "external",
      markerMessageCount:
        Number.isSafeInteger(markerMessageCount) && markerMessageCount >= 0
          ? markerMessageCount
          : null
    }
  }
  return { kind: "empty", messageCount: 0 }
}

function readInlineBoundedCheckpointMessages(input: {
  database: DatabaseSync
  row: StoredRuntimeProjectionRow
  messageCount: number
  window: BoundedCheckpointMessageWindow
  cancellation?: Int32Array
}): void {
  if (input.window.isDisabled || input.messageCount === 0) return
  const scanStart = Math.max(0, input.messageCount - input.window.scanMessageLimit)
  let previousIndex = scanStart - 1
  let visited = 0
  const rows = input.database
    .prepare(
      `SELECT ${BOUNDED_CHECKPOINT_MESSAGE_SELECT}
       FROM checkpoints AS checkpoint,
            json_each(
              CAST(checkpoint.checkpoint AS TEXT),
              '$.channel_values.messages'
            ) AS message
       WHERE checkpoint.thread_id = ? AND checkpoint.checkpoint_ns = ?
         AND checkpoint.checkpoint_id = ?
         AND CAST(message.key AS INTEGER) >= ?
         AND CAST(message.key AS INTEGER) < ?
         AND message.type = 'object'
       ORDER BY CAST(message.key AS INTEGER)`
    )
    .iterate(
      CHECKPOINT_TRANSFER_RAW_MESSAGE_BYTE_LIMIT,
      CHECKPOINT_TRANSFER_RAW_MESSAGE_BYTE_LIMIT,
      input.row.threadId,
      input.row.checkpointNs,
      input.row.checkpointId,
      scanStart,
      input.messageCount
    )
  for (const raw of rows) {
    if (visited % LEGACY_TRANSCRIPT_BATCH_LIMIT === 0) {
      throwIfCancelled(input.cancellation)
    }
    const row = boundedCheckpointMessageRow(raw)
    if (row.messageIndex <= previousIndex || row.messageIndex >= input.messageCount) {
      throw new Error("[CheckpointRuntimeWorker] Unordered inline checkpoint messages")
    }
    previousIndex = row.messageIndex
    visited += 1
    input.window.pushChronological(row)
  }
}

function readExternalMessageSnapshotSegments(input: {
  database: DatabaseSync
  row: StoredRuntimeProjectionRow
  markerMessageCount: number | null
  scanMessageLimit: number
  cancellation?: Int32Array
}): { messageCount: number; segments: ExternalMessageSnapshotSegment[] } {
  assertMessageSnapshotSchemaIsPublished(input.database)
  if (input.scanMessageLimit === 0) {
    const snapshot = input.database
      .prepare(
        `SELECT message_count
         FROM checkpoint_message_snapshots
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
         LIMIT 1`
      )
      .get(input.row.threadId, input.row.checkpointNs, input.row.checkpointId) as
      | Record<string, unknown>
      | undefined
    const messageCount = Number(snapshot?.message_count)
    if (!snapshot || !Number.isSafeInteger(messageCount) || messageCount < 0) {
      throw new Error(
        `[CheckpointRuntimeWorker] Missing message snapshot: ${input.row.checkpointId}`
      )
    }
    if (input.markerMessageCount !== null && input.markerMessageCount !== messageCount) {
      throw new Error(
        `[CheckpointRuntimeWorker] Message count mismatch: ${input.row.checkpointId}`
      )
    }
    return { messageCount, segments: [] }
  }
  const segments: ExternalMessageSnapshotSegment[] = []
  const visited = new Set<string>()
  let cursor: string | null = input.row.checkpointId
  let messageCount: number | null = null
  let visibleStart = 0
  let visibleEnd = 0
  while (cursor) {
    throwIfCancelled(input.cancellation)
    if (visited.has(cursor) || visited.size >= CHECKPOINT_TRANSCRIPT_PRESENCE_CHAIN_LIMIT) {
      throw new Error(`[CheckpointRuntimeWorker] Cyclic message snapshot: ${cursor}`)
    }
    visited.add(cursor)
    const snapshot = input.database
      .prepare(
        `SELECT checkpoint_id, parent_checkpoint_id, prefix_length, message_count, type,
                json_array_length(CAST(suffix AS TEXT)) AS suffix_count
         FROM checkpoint_message_snapshots
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
         LIMIT 1`
      )
      .get(input.row.threadId, input.row.checkpointNs, cursor) as
      | Record<string, unknown>
      | undefined
    if (!snapshot) {
      throw new Error(`[CheckpointRuntimeWorker] Missing message snapshot: ${cursor}`)
    }
    const checkpointId = String(snapshot.checkpoint_id ?? "")
    const prefixLength = Number(snapshot.prefix_length)
    const snapshotMessageCount = Number(snapshot.message_count)
    const suffixCount = Number(snapshot.suffix_count)
    const type = typeof snapshot.type === "string" ? snapshot.type : "json"
    if (
      type !== "json" ||
      !Number.isSafeInteger(prefixLength) ||
      prefixLength < 0 ||
      !Number.isSafeInteger(snapshotMessageCount) ||
      snapshotMessageCount < prefixLength ||
      !Number.isSafeInteger(suffixCount) ||
      suffixCount !== snapshotMessageCount - prefixLength
    ) {
      throw new Error(`[CheckpointRuntimeWorker] Invalid message snapshot: ${checkpointId}`)
    }
    if (messageCount === null) {
      messageCount = snapshotMessageCount
      if (
        input.markerMessageCount !== null &&
        input.markerMessageCount !== snapshotMessageCount
      ) {
        throw new Error(`[CheckpointRuntimeWorker] Message count mismatch: ${checkpointId}`)
      }
      visibleStart = Math.max(0, messageCount - input.scanMessageLimit)
      visibleEnd = messageCount
    } else if (visibleEnd > snapshotMessageCount) {
      throw new Error(`[CheckpointRuntimeWorker] Invalid message snapshot prefix: ${checkpointId}`)
    }

    const segmentStart = Math.max(prefixLength, visibleStart)
    const segmentEnd = Math.min(snapshotMessageCount, visibleEnd)
    if (segmentStart < segmentEnd) {
      segments.push({
        checkpointId,
        localStart: segmentStart - prefixLength,
        localEnd: segmentEnd - prefixLength,
        globalOffset: prefixLength
      })
    }
    visibleEnd = Math.min(visibleEnd, prefixLength)
    if (visibleEnd <= visibleStart) break
    cursor =
      snapshot.parent_checkpoint_id === null || snapshot.parent_checkpoint_id === undefined
        ? null
        : String(snapshot.parent_checkpoint_id)
  }
  if (messageCount === null) {
    throw new Error(`[CheckpointRuntimeWorker] Missing message snapshot: ${input.row.checkpointId}`)
  }
  if (visibleEnd > visibleStart) {
    throw new Error(`[CheckpointRuntimeWorker] Missing message snapshot prefix: ${input.row.checkpointId}`)
  }
  return { messageCount, segments: segments.reverse() }
}

function readExternalBoundedCheckpointMessages(input: {
  database: DatabaseSync
  row: StoredRuntimeProjectionRow
  segments: ExternalMessageSnapshotSegment[]
  window: BoundedCheckpointMessageWindow
  cancellation?: Int32Array
}): void {
  if (input.window.isDisabled) return
  let previousGlobalIndex = -1
  let visited = 0
  const statement = input.database.prepare(
    `SELECT ${BOUNDED_CHECKPOINT_MESSAGE_SELECT}
     FROM checkpoint_message_snapshots AS snapshot,
          json_each(CAST(snapshot.suffix AS TEXT)) AS message
     WHERE snapshot.thread_id = ? AND snapshot.checkpoint_ns = ?
       AND snapshot.checkpoint_id = ?
       AND CAST(message.key AS INTEGER) >= ?
       AND CAST(message.key AS INTEGER) < ?
       AND message.type = 'object'
     ORDER BY CAST(message.key AS INTEGER)`
  )
  for (const segment of input.segments) {
    const rows = statement.iterate(
      CHECKPOINT_TRANSFER_RAW_MESSAGE_BYTE_LIMIT,
      CHECKPOINT_TRANSFER_RAW_MESSAGE_BYTE_LIMIT,
      input.row.threadId,
      input.row.checkpointNs,
      segment.checkpointId,
      segment.localStart,
      segment.localEnd
    )
    for (const raw of rows) {
      if (visited % LEGACY_TRANSCRIPT_BATCH_LIMIT === 0) {
        throwIfCancelled(input.cancellation)
      }
      const localRow = boundedCheckpointMessageRow(raw)
      const globalIndex = segment.globalOffset + localRow.messageIndex
      if (globalIndex <= previousGlobalIndex) {
        throw new Error("[CheckpointRuntimeWorker] Unordered external checkpoint messages")
      }
      previousGlobalIndex = globalIndex
      visited += 1
      input.window.pushChronological({ ...localRow, messageIndex: globalIndex })
    }
  }
}

function readLatestBoundedCheckpointTuple(input: {
  database: DatabaseSync
  threadId: string
  checkpointNs: string
  layout: CheckpointSchemaLayout
  options: { messageLimit?: number; messageByteBudget?: number }
  cancellation?: Int32Array
}): unknown | null {
  const runtime = readBoundedRuntimeCheckpoint(
    input.database,
    input.threadId,
    input.checkpointNs,
    input.layout,
    input.cancellation
  )
  if (!runtime) return null
  throwIfCancelled(input.cancellation)
  const source = inspectBoundedCheckpointMessageSource(input.database, runtime.row)
  const window = new BoundedCheckpointMessageWindow(
    normalizeBoundedCheckpointTransferOptions(input.options)
  )
  let originalMessageCount = source.kind === "external" ? 0 : source.messageCount
  if (source.kind === "inline") {
    readInlineBoundedCheckpointMessages({
      database: input.database,
      row: runtime.row,
      messageCount: source.messageCount,
      window,
      cancellation: input.cancellation
    })
  } else if (source.kind === "external") {
    if (window.isDisabled && source.markerMessageCount !== null) {
      originalMessageCount = source.markerMessageCount
    } else {
      const external = readExternalMessageSnapshotSegments({
        database: input.database,
        row: runtime.row,
        markerMessageCount: source.markerMessageCount,
        scanMessageLimit: window.scanMessageLimit,
        cancellation: input.cancellation
      })
      originalMessageCount = external.messageCount
      readExternalBoundedCheckpointMessages({
        database: input.database,
        row: runtime.row,
        segments: external.segments,
        window,
        cancellation: input.cancellation
      })
    }
  }
  return checkpointTupleFromRaw({
    row: runtime.row,
    checkpoint: boundedCheckpointTransferFromRuntime({
      runtimeCheckpoint: runtime.runtimeCheckpoint,
      messages: window.messages,
      originalMessageCount
    })
  })
}

/**
 * Renderer callers pass a message window, so the worker reads a bounded SQLite
 * tail without reconstructing the complete transcript. Cold internal callers
 * may still omit options when they explicitly need the full checkpoint tuple.
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
  if (!existsSync(databasePath)) return null
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    timeout: 5_000
  })
  database.exec("PRAGMA query_only = ON")
  let checkpointSchema: CheckpointSchemaLayout
  try {
    // Bounded renderer hydration only needs the authoritative checkpoint row.
    // Snapshot and writes tables are asserted lazily when the payload/operation
    // actually uses them, preserving compatibility with base-only inline
    // checkpoint databases.
    checkpointSchema = assertCheckpointSchemaIsPublished(database)
  } catch (error) {
    database.close()
    throw error
  }
  database.exec("BEGIN")
  try {
    const boundedTransfer =
      options.messageLimit !== undefined || options.messageByteBudget !== undefined
    if (boundedTransfer) {
      const tuple = readLatestBoundedCheckpointTuple({
        database,
        threadId,
        checkpointNs,
        layout: checkpointSchema,
        options,
        cancellation
      })
      database.exec("COMMIT")
      return tuple
    }
    const row = readLatestCheckpointRow(
      database,
      threadId,
      checkpointNs,
      true,
      checkpointSchema
    )
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
    // Full internal tuple reads include pending writes. Keep that stronger
    // contract local to the unbounded branch instead of blocking bounded UI
    // hydration on a table it never queries.
    assertWritesSchemaIsPublished(database)
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
