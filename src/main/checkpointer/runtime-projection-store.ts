import { matchesThreadIncarnationSnapshot, THREAD_INCARNATION_METADATA_KEY } from "../../shared/thread-incarnation"
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite"
import { existsSync, statSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"
import { findNativeSqliteRecoverySource, NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { ensureThreadMessageFragmentStorage, hasThreadMessageFragmentGenerations,
  publishedThreadMessageFragmentsSql } from "../db/thread-message-fragment-storage"
import { hasSqliteRecoverySidecar, sqliteRecoveryFamilyKey } from "../db/sqlite-recovery-family"
import { ensureMessageSnapshotGeneration as migrateMessageSnapshotGeneration } from "./message-snapshot-schema"
import { hasScopedGraphTranscriptBoundary } from "../../shared/graph-transcript-boundary"
import { migrateLegacyMessageTimes } from "./legacy-message-times"
import { applyLegacyOrdinalReservationBatch, planLegacyOrdinalReservation, reserveLegacyOrdinalRanges,
  type LegacyOrdinalMove, type LegacyOrdinalRange, type LegacyOrdinalReservation } from "./legacy-ordinal-reservation"
import { createLegacyWriterTurn, LEGACY_WRITER_BATCH_BYTES, LEGACY_WRITER_BATCH_MS } from "./legacy-write-budget"
import {
  beginLegacyCheckpointContentHash,
  beginLegacyCheckpointRecoveryHash,
  decodeLegacyOverlapProofs,
  ensureLegacyCheckpointSourceIds,
  legacyCheckpointReplayRowSql,
  legacyCheckpointProviderIdentity,
  legacyPublicationSources,
  MAX_LEGACY_OVERLAP_PROOFS,
  NATIVE_DURABLE_CHECKPOINT_ID,
  prepareLegacyOverlap,
  type LegacyOverlapPayload,
  type LegacyOverlapProof,
  type PreparedLegacyOverlap
} from "./legacy-checkpoint-source"
import { isLosslessTranscriptPayload } from "../../shared/transcript-recovery-integrity"
import { LEGACY_STRUCTURED_TRANSCRIPT_NOTICE, normalizeFragmentedThreadMessageContent, normalizeMessageContent,
  parseJsonValue } from "../../shared/thread-message-content"
import { isCompletedRouteValuePrefix } from "../../shared/message-role-collision"
import { createHash, randomUUID, type Hash } from "node:crypto"
import {
  formatDisplayMessageIdHash,
  MAX_BOUNDED_TRANSCRIPT_ID_LENGTH,
  projectDisplayMessageId,
  type DisplayMessageIdKind
} from "../display-message-identity"
import { ensureLegacyTranscriptSlots, ensureThreadGraphTranscriptBoundaries } from "../db/legacy-transcript-slots"
import { GOAL_CONTINUATION_BOUNDARY_METADATA_KEY } from "../agent/goals/internal-prompt"
import type {
  CheckpointRuntimeProjectionStats,
  LegacyCheckpointTranscriptMigrationStats,
  LegacySearchBootstrapGuard,
  LegacySearchProjectionState
} from "./runtime-projection-protocol"
import {
  CHECKPOINT_RUNTIME_PROJECTION_CANCELLED,
  CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED,
  CHECKPOINT_RUNTIME_PROJECTION_RESUME_REQUIRED,
  SEARCH_BACKFILL_METADATA_BYTE_LIMIT,
  CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY
} from "./runtime-projection-protocol"
import {
  buildAvailableProviderOccurrenceId,
  buildMessageSameRoleDuplicateId,
  getMessageProviderOccurrence,
  getMessageProviderSourceId,
  getMessageProviderTupleFromMetadata,
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY,
  normalizeCompleteMessageIds
} from "../../shared/message-role-collision"
import {
  isInternalNotificationMessage,
  isRestorableConversationTranscriptMessage,
  isWorkflowPlumbingTranscriptContent,
  mergeCheckpointAuthorityTranscriptMessage
} from "../../shared/checkpoint-transcript"
import { isSerializedSummarizationMessage } from "../../shared/context-compaction-messages"
import { extractVisibleReasoning } from "../../shared/model-reasoning"
import {
  normalizeTranscriptReasoning,
  normalizeVisibleReasoningText,
  TRANSCRIPT_REASONING_MAX_CHARS
} from "../../shared/transcript-reasoning"
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
const SEARCH_LEGACY_MAX_PUBLISH_ROWS = 2048
const SEARCH_LEGACY_MAX_SOURCE_BYTES = 8 * 1024 * 1024
const MAX_PENDING_OCCURRENCE_PROOFS = 16
const MAX_PENDING_OCCURRENCE_PROJECTION_BYTES = 256 * 1024
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

function readStoredCheckpointRow(
  database: DatabaseSync,
  threadId: string,
  checkpointNs: string,
  includeMetadata: boolean,
  layout: CheckpointSchemaLayout = assertCheckpointSchemaIsPublished(database),
  exactCheckpointId?: string
): StoredCheckpointRow | null {
  const checkpointTimestamp = checkpointTimestampExpression(layout)
  const row = database
    .prepare(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
              ${checkpointTimestamp} AS checkpoint_ts,
              type, checkpoint${includeMetadata ? ", metadata" : ""}
       FROM checkpoints
       WHERE thread_id = ? AND checkpoint_ns = ?${exactCheckpointId ? " AND checkpoint_id = ?" : ""}
       ORDER BY ${checkpointTimestamp} DESC, checkpoint_id DESC
       LIMIT 1`
    )
    .get(threadId, checkpointNs, ...(exactCheckpointId ? [exactCheckpointId] : [])) as
    | Record<string, unknown>
    | undefined
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
  const row = readStoredCheckpointRow(database, threadId, checkpointNs, false, layout)
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
  if (isInternalNotificationMessage(raw)) return false
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
    const row = readStoredCheckpointRow(
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
  row: StoredCheckpointRow,
  layout: CheckpointSchemaLayout = assertCheckpointSchemaIsPublished(database)
): boolean {
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
  database.exec(`CREATE TABLE IF NOT EXISTS checkpoint_schema_migrations (
    migration_id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`)
  // The adapter borrows this connection; the worker retains its ownership.
  migrateMessageSnapshotGeneration(new NativeSqliteAdapter(database))
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
    if (!exactSourceIsStillLatest(database, row)) {
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
  const sourcePath = resolveForegroundCheckpointReadPath(databasePath)
  if (!existsSync(sourcePath)) return null
  const usingSidecar = sourcePath !== databasePath
  const database = new DatabaseSync(sourcePath, { readOnly: usingSidecar, timeout: 5_000 })
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
      if (!usingSidecar && !commitRuntimeProjectionOnly(database, prepared, layout)) continue
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
  checkpointIndex: number
  graphUserCommand?: boolean
  recoveryIntegrity: number
  searchProjectionTruncated: boolean
  legacyReasoning: string | null
  messageId: string
  providerSourceId: string | null
  providerOccurrence: number | null
  providerIdentityDeclared: boolean
  sourceDeclaredOccurrence?: number
  sourceMessageId?: string
  sourceIndex?: number
  stableSourceId: boolean
  physicalOccurrenceBound?: boolean
  revisionOrderConflict?: boolean
  inferredSourceTurn?: string | null
  sourceOccurrenceUncertain?: boolean
  exactInsertionFence?: number
  role: "user" | "assistant" | "system" | "tool"
  contentJson: string
  reasoning: string | null
  toolCallsJson: string | null
  toolCallId: string | null
  name: string | null
  status: string | null
  isError: number | null
  createdAt: number
  estimatedBytes: number
  contentFragments: string[] | null
  shadowSlot?: boolean
  previousCopies?: Array<{ beforeIndex: number; payload: DurableLegacyCheckpointMessage }>
}

function legacyFieldContentHasher(message: DurableLegacyCheckpointMessage) {
  const hash = (value: string | null) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const head = parseJsonValue(message.contentJson)
  const body = createHash("sha256").update(typeof head === "string" ? "text" : "structured")
    .update(typeof head === "string" ? head : message.contentJson, "utf16le")
  const identity = beginLegacyCheckpointContentHash({ ...message, messageId: legacyCheckpointProviderIdentity(message),
    providerSourceId: null, providerOccurrence: null, contentJson: "", reasoning: null, toolCallsJson: null }).digest("hex")
  return {
    add: (fragment: string) => body.update(fragment, "utf16le"),
    finish: () => JSON.stringify([identity, body.digest("hex"), hash(message.reasoning),
      hash(message.toolCallsJson === "[]" ? null : message.toolCallsJson)])
  }
}

function matchesUnmodifiedLegacyFields(current: string, previous: unknown, protectedFields: number): boolean {
  const actual = parseJsonValue(current)
  const expected = parseJsonValue(previous)
  return Array.isArray(actual) && Array.isArray(expected) && expected.length === 4 && actual[0] === expected[0] &&
    actual.slice(1).every((key, index) => (protectedFields & (1 << index)) !== 0 || key === expected[index + 1])
}

function legacyMessageContentKeys(message: DurableLegacyCheckpointMessage) {
  const raw = beginLegacyCheckpointContentHash(message)
  const normalized = beginLegacyCheckpointContentHash({
    ...message, messageId: legacyCheckpointProviderIdentity(message),
    providerSourceId: null, providerOccurrence: null
  })
  const payload = beginLegacyCheckpointContentHash({
    ...message, messageId: "", providerSourceId: null, providerOccurrence: null,
    toolCallsJson: message.toolCallsJson === "[]" ? null : message.toolCallsJson
  })
  const fields = legacyFieldContentHasher(message)
  for (const fragment of message.contentFragments ?? []) {
    const serialized = JSON.stringify(fragment)
    raw.update(serialized)
    normalized.update(serialized)
    payload.update(serialized)
    fields.add(fragment)
  }
  return { raw: raw.digest("hex"), normalized: normalized.digest("hex"), payload: payload.digest("hex"), fields: fields.finish() }
}

function legacyMessageRecoveryKey(message: DurableLegacyCheckpointMessage): string | null {
  const hash = message.recoveryIntegrity === 1 ? beginLegacyCheckpointRecoveryHash(message) : null
  if (!hash) return null
  for (const fragment of message.contentFragments ?? []) hash.update(fragment, "utf16le")
  return hash.digest("hex")
}

interface LegacySourceClaim {
  key: string
  identity: string
  message: DurableLegacyCheckpointMessage
}

interface PendingOccurrenceClaim {
  key: string
  identity: string
  projection?: LegacyOverlapProof
  excludedOwners?: string[]
}

interface PendingOccurrenceCoverage {
  checkpointId: string
  count: number
  key: string
  pendingCount?: number
  claims?: PendingOccurrenceClaim[]
}

function buildLegacySourceClaim(message: DurableLegacyCheckpointMessage): LegacySourceClaim {
  const identity = beginLegacyCheckpointContentHash({
    ...message, contentJson: "", reasoning: null, toolCallsJson: null
  }).digest("hex")
  const hash = beginLegacyCheckpointContentHash(message)
  for (const fragment of message.contentFragments ?? []) hash.update(JSON.stringify(fragment))
  return { key: hash.digest("hex"), identity, message }
}

function readPendingOccurrenceCoverage(state: Record<string, unknown>): PendingOccurrenceCoverage[] | null {
  if (typeof state.occurrence_source_key !== "string") return null
  const parsed = parseJsonValue(state.occurrence_source_key)
  if (Array.isArray(parsed)) {
    if (!parsed.length || parsed.length > MAX_PENDING_OCCURRENCE_PROOFS || parsed.some((value) =>
      !value || typeof value.checkpointId !== "string" || typeof value.key !== "string" ||
      !Number.isSafeInteger(value.count) || value.count <= 0)) return null
    return parsed as PendingOccurrenceCoverage[]
  }
  const count = Number(state.occurrence_source_count)
  return typeof state.checkpoint_id === "string" && Number.isSafeInteger(count) && count > 0
    ? [{ checkpointId: state.checkpoint_id, count, key: state.occurrence_source_key }] : null
}

function resolvedLegacySourceSlots(messages: readonly DurableLegacyCheckpointMessage[]) {
  const slots = new Map<number, DurableLegacyCheckpointMessage>()
  for (const message of messages) {
    if (message.shadowSlot || message.sourceOccurrenceUncertain || message.revisionOrderConflict) continue
    if (message.sourceIndex !== undefined) slots.set(message.sourceIndex, message)
    for (const { payload } of message.previousCopies ?? []) {
      if (payload.sourceIndex !== undefined) slots.set(payload.sourceIndex, message)
    }
  }
  return slots
}

function coversPendingOccurrence(source: LegacyTranscriptCopyInput, proof: PendingOccurrenceCoverage,
  audit: LegacyOverlapAudit, check: () => void): boolean {
  if (!inheritsLegacyPublication(source, proof.checkpointId) || !Number.isSafeInteger(proof.count) || proof.count <= 0) return false
  if (source.sourcePrefixKeys[proof.count - 1] === proof.key) return true
  if (!Array.isArray(proof.claims) || !proof.claims.length ||
      proof.claims.length !== (proof.pendingCount ?? proof.count)) return false
  const orderedClaims = proof.claims
  const physicalSlots = resolvedLegacySourceSlots(source.messages)
  const compatible = (previous: PendingOccurrenceClaim, index: number) => {
    const current = source.sourceClaims[index]
    if (previous?.identity !== current.identity) return false
    const physical = physicalSlots.get(index)
    if (physical && previous.excludedOwners?.includes(legacyCheckpointProviderIdentity(physical))) return false
    if (previous.key === current.key) return true
    const { projection } = previous
    const { message } = current
    return !!projection && typeof projection.digest === "string" && Array.isArray(projection.body) &&
      Array.isArray(projection.summaries) && audit.covers(message, message.contentFragments ?? [], projection, index)
  }
  const first: number[] = []
  let candidate = 0
  for (const previous of orderedClaims) {
    while (candidate < source.sourceClaims.length && !compatible(previous, candidate)) {
      check()
      candidate += 1
    }
    if (candidate === source.sourceClaims.length) return false
    first.push(candidate++)
  }
  // Ordered positions must be unique unless the occurrence binder already
  // proved that both source snapshots belong to the same physical message.
  candidate = source.sourceClaims.length - 1
  for (let index = orderedClaims.length - 1; index >= 0; index -= 1) {
    while (candidate >= first[index] && !compatible(orderedClaims[index], candidate)) {
      check()
      candidate -= 1
    }
    if (candidate < first[index]) return false
    const earliest = physicalSlots.get(first[index])?.messageId
    if (candidate !== first[index] && (earliest === undefined || earliest !== physicalSlots.get(candidate)?.messageId)) return false
    candidate -= 1
  }
  return true
}

function matchesCheckpointProvider(
  row: Record<string, unknown>, message: DurableLegacyCheckpointMessage
): boolean {
  return legacyCheckpointProviderIdentity({
    messageId: typeof row.message_id === "string" ? row.message_id : message.messageId, role: message.role,
    providerSourceId: typeof row.provider_source_id === "string" ? row.provider_source_id : null,
    providerOccurrence: typeof row.provider_occurrence === "number" ? row.provider_occurrence : null
  }) === legacyCheckpointProviderIdentity(message)
}

interface LegacyGraphBoundary {
  checkpointIndex: number
  messageId: string
}

function readLegacyGraphFences(database: DatabaseSync, input: LegacyTranscriptCopyInput) {
  if (!input.graphBoundaries.length || !hasLegacyGraphBoundaryTable(database)) return []
  const read = database.prepare(`SELECT ordinal FROM thread_graph_transcript_boundaries
    WHERE thread_id = ? AND graph_user_id = ?`)
  let index = 0
  return input.graphBoundaries.flatMap((graph) => {
    throwIfCancelled(input.cancellation)
    while (index < input.messages.length && input.messages[index].checkpointIndex < graph.checkpointIndex) index += 1
    const ordinal = read.get(input.threadId, graph.messageId)?.ordinal
    return typeof ordinal === "number" ? [{ index, ordinal, turn: legacyGraphUserTurn(graph.messageId) }] : []
  })
}

function hasLegacyGraphBoundaryTable(database: DatabaseSync): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'thread_graph_transcript_boundaries'`).get())
}

function legacyGraphUserTurn(id: string): string {
  return JSON.stringify(["graph", id])
}

function legacyPhysicalUserSql(hasGraph: boolean, direction: "<" | ">" | "<="): string {
  const order = direction === ">" ? "ASC" : "DESC"
  const visible = `SELECT message_id, provider_source_id, provider_occurrence, ordinal, 0 AS hidden
    FROM thread_messages WHERE thread_id = $threadId AND role = 'user' AND ordinal ${direction} $ordinal
    ORDER BY ordinal ${order}, message_id LIMIT 1`
  if (!hasGraph) return visible
  return `SELECT * FROM (${visible})
    UNION ALL SELECT * FROM (
      SELECT graph_user_id, NULL, NULL, ordinal, 1
      FROM thread_graph_transcript_boundaries WHERE thread_id = $threadId AND ordinal ${direction} $ordinal
      ORDER BY ordinal ${order}, graph_user_id LIMIT 1
    ) ORDER BY ordinal ${order}, hidden ASC, message_id LIMIT 1`
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
    { type: "text", text: LEGACY_STRUCTURED_TRANSCRIPT_NOTICE }
  ]
}

function separatePublishedLegacyDrafts(
  messages: DurableLegacyCheckpointMessage[], databasePath: string, threadId: string,
  cancellation: Int32Array | undefined, contentAt: (index: number) => unknown
): LegacyOccurrenceSnapshot | undefined {
  const indices = new Map<string, number[]>()
  for (const [index, message] of messages.entries()) {
    if (!message.providerIdentityDeclared || message.role === "user") continue
    const slots = indices.get(message.messageId)
    if (slots) slots.push(index)
    else indices.set(message.messageId, [index])
  }
  const groups = [...indices.values()].filter((slots) => slots.length > 1)
  if (!groups.length || !existsSync(databasePath)) return
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 100 })
  try {
    database.exec("BEGIN")
    const snapshot = readLegacyOccurrenceSnapshot(database, threadId)
    if (!database.prepare("PRAGMA table_info(thread_messages)").all().length) return
    const ledger = database.prepare("PRAGMA table_info(legacy_checkpoint_transcript_imports)").all()
      .some((column) => column.name === "source_declared_occurrence")
    const read = (where: string) => `SELECT m.message_id, m.provider_source_id, m.provider_occurrence, m.ordinal
      FROM thread_messages AS m ${ledger ? "LEFT JOIN legacy_checkpoint_transcript_imports AS i USING (thread_id, message_id)" : ""}
      WHERE m.thread_id = ? AND m.role = ? AND ${where}
        AND (COALESCE(${ledger ? "i.source_declared_occurrence," : ""} m.provider_occurrence, 1) = ?
          OR (m.message_id = ? AND COALESCE(m.provider_occurrence, 1) = ?))`
    const physical = database.prepare(`${read("m.provider_source_id = ?")} UNION ALL
      ${read("m.message_id = ? AND m.provider_source_id IS NULL")} LIMIT ${LEGACY_TRANSCRIPT_BATCH_LIMIT + 1}`)
    const verify = createLegacyPayloadVerifier(database, threadId)
    const check = () => throwIfCancelled(cancellation)
    const claimed = new Set(messages.map((message) => message.messageId))
    for (const slots of groups) {
      check()
      const first = messages[slots[0]]
      const provider = first.providerSourceId ?? first.messageId
      const occurrence = first.sourceDeclaredOccurrence ?? first.providerOccurrence ?? 1
      const scope = [threadId, first.role, provider, occurrence, first.sourceMessageId ?? null, occurrence] as const
      const rows = physical.all(...scope, ...scope)
      if (rows.length < 2 || rows.length > LEGACY_TRANSCRIPT_BATCH_LIMIT) continue
      const assigned = slots.map((index) => {
        const message = messages[index]
        const matching = rows.flatMap((row) => {
          const bound: DurableLegacyCheckpointMessage = {
            ...message, messageId: String(row.message_id), providerSourceId: row.provider_source_id as string | null,
            providerOccurrence: row.provider_occurrence as number | null
          }
          return verify(bound, Number(row.ordinal), bound.contentFragments?.length ?? 0, check, false, bound.messageId, true)
            ? [{ bound, ordinal: Number(row.ordinal), index }] : []
        })
        return matching.length === 1 ? matching[0] : undefined
      })
      if (!assigned.some(Boolean)) continue
      const extendsDraft = (next: number, earlier: number) =>
        isCompletedRouteValuePrefix(contentAt(next), contentAt(earlier))
      type DraftWitness = NonNullable<typeof assigned[number]>
      const attach = (message: DurableLegacyCheckpointMessage, index: number, witness: DraftWitness): DraftWitness => {
        const { messageId, providerSourceId, providerOccurrence } = witness.bound
        return { bound: { ...message, messageId, providerSourceId, providerOccurrence }, ordinal: witness.ordinal, index }
      }
      // A reopened transcript now holds the final draft. Exact successor
      // bytes can still identify a preceding compatible snapshot of that row.
      for (let offset = slots.length - 2; offset >= 0; offset -= 1) {
        if (assigned[offset]) continue
        const next = assigned[offset + 1]
        const prior = assigned[offset - 1]
        const index = slots[offset]
        if (next && extendsDraft(next.index, index) &&
            (!prior || prior.ordinal === next.ordinal || !extendsDraft(index, prior.index)))
          assigned[offset] = attach(messages[index], index, next)
      }
      const occupied = new Set(rows.map((row) => String(row.message_id)))
      let previous: DraftWitness | undefined
      for (const [offset, index] of slots.entries()) {
        const message = messages[index]
        let match = assigned[offset]
        if (!match && previous && extendsDraft(index, previous.index)) match = attach(message, index, previous)
        if (match && (!previous || match.ordinal >= previous.ordinal) &&
            (match.bound.messageId === first.messageId || !claimed.has(match.bound.messageId) ||
              previous?.bound.messageId === match.bound.messageId)) {
          previous = match
          messages[index] = match.bound
          claimed.add(match.bound.messageId)
          continue
        }
        // Exact observations may have different physical owners. Leave an
        // unproven slot separate rather than folding it into either owner's body.
        let occurrence = Math.max(1, message.providerOccurrence ?? 1)
        let id: string
        do {
          occurrence += 1
          id = buildMessageSameRoleDuplicateId(provider, message.role, occurrence)
        } while (claimed.has(id) || occupied.has(id))
        claimed.add(id)
        messages[index] = { ...message, messageId: id, providerSourceId: provider, providerOccurrence: occurrence,
          shadowSlot: true, sourceOccurrenceUncertain: true, revisionOrderConflict: true }
        previous = undefined
      }
    }
    return snapshot
  } finally {
    if (database.isTransaction) database.exec("ROLLBACK")
    database.close()
  }
}

function buildDurableLegacyCheckpointMessages(
  rawMessages: readonly unknown[],
  checkpointTs: string,
  cancellation: Int32Array | undefined,
  databasePath: string,
  threadId: string
): { messages: DurableLegacyCheckpointMessage[]; sourceClaims: LegacySourceClaim[]; sourcePrefixKeys: string[];
  occurrenceSnapshot?: LegacyOccurrenceSnapshot; graphBoundaries: LegacyGraphBoundary[] } {
  const checkpointTime = Date.parse(checkpointTs)
  const baseTime = Number.isFinite(checkpointTime) ? checkpointTime : Date.now()
  const graphBoundaries: LegacyGraphBoundary[] = []
  const candidates: Array<
    Omit<DurableLegacyCheckpointMessage, "messageId" | "providerSourceId" | "providerOccurrence"> & {
      id: string
      content: unknown
      provider_source_id?: string
      provider_occurrence?: number
      tool_call_id?: string
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

    const role = serializedMessageRole(message, kwargs)
    // The source is already decoded in this worker. Determine visibility before
    // bounding its text, since a cut through a closing tag can look like reasoning.
    const sourceReasoning =
      role === "assistant"
        ? extractVisibleReasoning(message)
        : ""
    const reasoningTruncated = sourceReasoning.length > TRANSCRIPT_REASONING_MAX_CHARS
    const legacyReasoning = sourceReasoning.slice(0, TRANSCRIPT_REASONING_MAX_CHARS) || null
    const reasoning = !reasoningTruncated
      ? legacyReasoning
      : normalizeVisibleReasoningText(sourceReasoning)
        ? (normalizeTranscriptReasoning(sourceReasoning) ?? null)
        : null
    // Runtime reconstruction writes only this canonical provider field.
    const canRecoverReasoning = !reasoningTruncated && !message.reasoning && !kwargs.reasoning &&
      (sourceReasoning ? additionalKwargs.reasoning === sourceReasoning : !additionalKwargs.reasoning)
    const rawIdValue = kwargs.id ?? (typeof message.id === "string" ? message.id : undefined)
    const stableSourceId = typeof rawIdValue === "string" && rawIdValue.trim().length > 0
    const sourceId = stableSourceId ? rawIdValue.trim() : `checkpoint-${index}`
    const rawContent = message.content ?? kwargs.content
    const visibleUserMessage = additionalKwargs.cmb_visible_user_message
    if (
      role === "user" &&
      hasScopedGraphTranscriptBoundary(additionalKwargs) &&
      !(typeof visibleUserMessage === "string" && visibleUserMessage.trim())
    ) {
      graphBoundaries.push({ checkpointIndex: index, messageId: sourceId })
      continue
    }
    if (isInternalNotificationMessage(message)) continue
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
    const providerTuple = getMessageProviderTupleFromMetadata(additionalKwargs)
    candidates.push({
      id: sourceId,
      checkpointIndex: index,
      graphUserCommand: role === "user" && additionalKwargs[GOAL_CONTINUATION_BOUNDARY_METADATA_KEY] === true &&
        typeof visibleUserMessage === "string" && !!visibleUserMessage.trim(),
      searchProjectionTruncated: role !== "tool" &&
        ((!contentFragments && contentJson !== rawContentJson) || toolCallsJson !== rawToolCallsJson),
      recoveryIntegrity:
        content === rawContent &&
        canRecoverReasoning &&
        isLosslessTranscriptPayload(content, toolCalls) &&
        contentJson === rawContentJson &&
        toolCallsJson === rawToolCallsJson
          ? 1
          : 0,
      content,
      ...providerTuple,
      sourceDeclaredOccurrence: providerTuple?.provider_occurrence,
      sourceMessageId: stableSourceId ? sourceId : undefined,
      providerIdentityDeclared: providerTuple !== undefined,
      stableSourceId,
      role,
      contentJson,
      reasoning,
      legacyReasoning,
      toolCallsJson,
      toolCallId: typeof toolCallId === "string" ? toolCallId : null,
      ...(typeof toolCallId === "string" ? { tool_call_id: toolCallId } : {}),
      name: typeof name === "string" ? name : null,
      status: typeof status === "string" ? status : null,
      isError,
      createdAt: baseTime + index,
      estimatedBytes:
        Buffer.byteLength(contentJson, "utf8") +
        Buffer.byteLength(reasoning ?? "", "utf8") +
        Buffer.byteLength(toolCallsJson ?? "", "utf8") +
        1024,
      contentFragments
    })
  }
  let graphIndex = 0
  const normalized = normalizeCompleteMessageIds(candidates, true, ({ checkpointIndex }) => {
    const previous = graphIndex
    while (graphIndex < graphBoundaries.length && graphBoundaries[graphIndex].checkpointIndex < checkpointIndex)
      graphIndex += 1
    return graphIndex !== previous
  })
  const messages: DurableLegacyCheckpointMessage[] = normalized.map((message, sourceIndex) => ({
    checkpointIndex: message.checkpointIndex,
    graphUserCommand: message.graphUserCommand,
    recoveryIntegrity: message.recoveryIntegrity,
    searchProjectionTruncated: message.searchProjectionTruncated,
    messageId: message.id,
    providerSourceId: message.provider_source_id ?? null,
    providerOccurrence: message.provider_occurrence ?? null,
    providerIdentityDeclared: message.providerIdentityDeclared,
    sourceDeclaredOccurrence: message.sourceDeclaredOccurrence,
    sourceMessageId: message.sourceMessageId,
    sourceIndex,
    stableSourceId: message.stableSourceId,
    role: message.role,
    contentJson: message.contentJson,
    reasoning: message.reasoning,
    legacyReasoning: message.legacyReasoning,
    toolCallsJson: message.toolCallsJson,
    toolCallId: message.toolCallId,
    name: message.name,
    status: message.status,
    isError: message.isError,
    createdAt: message.createdAt,
    estimatedBytes: message.estimatedBytes,
    contentFragments: message.contentFragments
  }))
  const sourceClaims = messages.map((message, index) => {
    throwIfCancelled(cancellation)
    const source = candidates[index]
    return buildLegacySourceClaim({ ...message, messageId: source.id,
      providerSourceId: source.provider_source_id ?? null, providerOccurrence: source.sourceDeclaredOccurrence ?? null })
  })
  const prefix = createHash("sha256")
  const sourcePrefixKeys = sourceClaims.map(({ key }) => {
    prefix.update(key)
    return prefix.copy().digest("hex")
  })
  const occurrenceSnapshot = separatePublishedLegacyDrafts(messages, databasePath, threadId, cancellation,
    (index) => normalized[index].content)
  const firstSlot = new Map<string, number>()
  const readTools = (message: DurableLegacyCheckpointMessage) => {
    const value = parseJsonValue(message.toolCallsJson)
    return Array.isArray(value) ? value : undefined
  }
  const selectedBodies = new Map<number, unknown>()
  const selectedTools = new Map<number, unknown[] | undefined>()
  for (const [index, message] of messages.entries()) {
    const first = firstSlot.get(message.messageId)
    if (first === undefined) {
      firstSlot.set(message.messageId, index)
      continue
    }
    const prior = messages[first]
    const { previousCopies = [], ...previousPayload } = prior
    previousCopies.push({ beforeIndex: index, payload: previousPayload })
    const priorBody = selectedBodies.get(first) ?? normalized[first].content
    const priorTools = selectedTools.has(first) ? selectedTools.get(first) : readTools(prior)
    const incomingTools = readTools(message)
    const incomingBody = normalized[index].content
    const merged = mergeCheckpointAuthorityTranscriptMessage({
      id: message.messageId, role: message.role, content: incomingBody,
      reasoning: message.reasoning ?? undefined, tool_calls: incomingTools
    }, {
      id: prior.messageId, role: prior.role, content: priorBody,
      reasoning: prior.reasoning ?? undefined, tool_calls: priorTools
    })
    const body = merged.content === incomingBody ? message : prior
    const toolCallsJson = merged.tool_calls === incomingTools ? message.toolCallsJson : prior.toolCallsJson
    selectedBodies.set(first, merged.content)
    selectedTools.set(first, merged.tool_calls)
    messages[first] = {
      ...prior,
      contentJson: body.contentJson, contentFragments: body.contentFragments, toolCallsJson,
      reasoning: merged.reasoning ?? null, legacyReasoning: merged.reasoning ?? null,
      toolCallId: message.toolCallId ?? prior.toolCallId, name: message.name ?? prior.name,
      status: message.status ?? prior.status, isError: message.isError ?? prior.isError,
      recoveryIntegrity: 0,
      searchProjectionTruncated: prior.searchProjectionTruncated || message.searchProjectionTruncated ||
        !isCompletedRouteValuePrefix(merged.content, priorBody) ||
        !isCompletedRouteValuePrefix(merged.content, incomingBody) ||
        (priorTools !== undefined && !isCompletedRouteValuePrefix(merged.tool_calls, priorTools)) ||
        (incomingTools !== undefined && !isCompletedRouteValuePrefix(merged.tool_calls, incomingTools)) ||
        (Boolean(prior.reasoning && message.reasoning) && prior.reasoning !== message.reasoning),
      estimatedBytes: Math.max(body.estimatedBytes, prior.estimatedBytes, message.estimatedBytes),
      sourceIndex: index,
      previousCopies
    }
    // Keep previously published ordinal/timing slots stable. Only the first
    // slot owns this provider occurrence and may publish its durable row.
    messages[index] = { ...message, shadowSlot: true }
  }
  return { messages, sourceClaims, sourcePrefixKeys, occurrenceSnapshot, graphBoundaries }
}

function ensureLegacyTranscriptMigrationSchema(database: DatabaseSync): void {
  const hasColumn = (table: string, name: string) => database.prepare(`PRAGMA table_info(${table})`).all()
    .some((row) => row.name === name)
  ensureThreadMessageFragmentStorage((sql) => database.exec(sql), hasColumn)
  database.exec(`
    CREATE TABLE IF NOT EXISTS legacy_checkpoint_transcript_migrations (
      thread_id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL,
      total_messages INTEGER NOT NULL,
      next_index INTEGER NOT NULL,
      current_fragment_index INTEGER NOT NULL DEFAULT 0,
      active_fragment_revision TEXT,
      append_ordinal_base INTEGER,
      source_ordinal_gap TEXT,
      continuation_verified INTEGER NOT NULL DEFAULT 0,
      continuation_ancestor TEXT,
      ordinal_reservation TEXT,
      source_key TEXT,
      search_projection_state TEXT,
      occurrence_unverified_version INTEGER,
      occurrence_only INTEGER NOT NULL DEFAULT 0,
      occurrence_source_count INTEGER,
      occurrence_source_key TEXT,
      timing_checkpoint_id TEXT,
      timing_source_prefix TEXT,
      adopted_source_start INTEGER,
      progress_key TEXT,
      provider_progress_key TEXT,
      source_layout_key TEXT,
      copied_layout_key TEXT,
      source_lane_key TEXT,
      source_lane_count INTEGER,
      shadow_slots TEXT,
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
  const adapter = new NativeSqliteAdapter(database)
  ensureThreadGraphTranscriptBoundaries(adapter)
  ensureLegacyTranscriptSlots(adapter)
  if (!columns.some((column) => column.name === "active_fragment_revision"))
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN active_fragment_revision TEXT")
  if (!columns.some((column) => column.name === "append_ordinal_base")) {
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN append_ordinal_base INTEGER")
  }
  if (!columns.some((column) => column.name === "source_ordinal_gap")) {
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN source_ordinal_gap TEXT")
  }
  if (!columns.some((column) => column.name === "continuation_verified")) {
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN continuation_verified INTEGER NOT NULL DEFAULT 0")
  }
  if (!columns.some((column) => column.name === "continuation_ancestor")) {
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN continuation_ancestor TEXT")
  }
  if (!columns.some((column) => column.name === "ordinal_reservation")) {
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN ordinal_reservation TEXT")
  }
  if (!columns.some((column) => column.name === "source_key")) {
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN source_key TEXT")
  }
  if (!columns.some((column) => column.name === "search_projection_state")) {
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN search_projection_state TEXT")
  }
  if (!columns.some((column) => column.name === "occurrence_unverified_version"))
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN occurrence_unverified_version INTEGER")
  if (!columns.some((column) => column.name === "occurrence_only"))
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN occurrence_only INTEGER NOT NULL DEFAULT 0")
  if (!columns.some((column) => column.name === "occurrence_source_count"))
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN occurrence_source_count INTEGER")
  if (!columns.some((column) => column.name === "occurrence_source_key"))
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN occurrence_source_key TEXT")
  if (!columns.some((column) => column.name === "timing_checkpoint_id")) {
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN timing_checkpoint_id TEXT")
  }
  if (!columns.some((column) => column.name === "timing_source_prefix")) {
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN timing_source_prefix TEXT")
  }
  if (!columns.some((column) => column.name === "adopted_source_start")) {
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN adopted_source_start INTEGER")
  }
  if (!columns.some((column) => column.name === "progress_key")) {
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN progress_key TEXT")
  }
  if (!columns.some((column) => column.name === "provider_progress_key")) {
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN provider_progress_key TEXT")
  }
  if (!columns.some((column) => column.name === "source_layout_key")) {
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN source_layout_key TEXT")
  }
  if (!columns.some((column) => column.name === "copied_layout_key")) {
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN copied_layout_key TEXT")
  }
  if (!columns.some((column) => column.name === "source_lane_key"))
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN source_lane_key TEXT")
  if (!columns.some((column) => column.name === "source_lane_count"))
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN source_lane_count INTEGER")
  if (!columns.some((column) => column.name === "shadow_slots")) {
    database.exec("ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN shadow_slots TEXT")
  }
  ensureLegacyCheckpointSourceIds((sql) => database.exec(sql), hasColumn)
  for (const event of ["UPDATE OF active_fragment_revision", "DELETE"] as const) {
    const replaced = event === "DELETE" ? "1" : `json_extract(OLD.active_fragment_revision, '$[7].generation')
      IS NOT CASE WHEN json_valid(NEW.active_fragment_revision) THEN json_extract(NEW.active_fragment_revision, '$[7].generation') END`
    database.exec(`CREATE TRIGGER IF NOT EXISTS legacy_retire_active_fragment_stage_${event === "DELETE" ? "delete" : "update"}
      AFTER ${event} ON legacy_checkpoint_transcript_migrations
      WHEN CASE WHEN json_valid(OLD.active_fragment_revision) THEN
        json_type(OLD.active_fragment_revision, '$[7].generation') = 'text' AND ${replaced} END
      BEGIN
        INSERT OR IGNORE INTO legacy_checkpoint_retired_fragments VALUES
          (OLD.thread_id, json_extract(OLD.active_fragment_revision, '$[0]'), json_extract(OLD.active_fragment_revision, '$[7].generation'));
      END`)
  }
  // A row version can repeat after deletion and reinsertion. Retire the
  // active copy's ownership before the same raw ID can be used by a new row.
  for (const [trigger, event, row] of [
    ["insert", "INSERT", "NEW"],
    ["delete", "DELETE", "OLD"],
    ["rename", "UPDATE OF message_id", "OLD"]
  ]) {
    database.exec(`CREATE TRIGGER IF NOT EXISTS legacy_active_fragment_${trigger}
      AFTER ${event} ON thread_messages ${trigger === "rename" ? "WHEN OLD.message_id IS NOT NEW.message_id" : ""}
      BEGIN
        UPDATE legacy_checkpoint_transcript_migrations SET active_fragment_revision = NULL
        WHERE thread_id = ${row}.thread_id AND
          CASE WHEN json_valid(active_fragment_revision) THEN json_extract(active_fragment_revision, '$[0]') END
          IS ${row}.message_id;
      END`)
    database.exec(`CREATE TRIGGER IF NOT EXISTS legacy_fragment_provenance_v2_${trigger}
      AFTER ${event} ON thread_messages ${trigger === "rename" ? "WHEN OLD.message_id IS NOT NEW.message_id" : ""}
      BEGIN
        ${trigger === "rename" ? "" : `INSERT OR IGNORE INTO legacy_checkpoint_retired_fragments (thread_id, message_id, generation)
          SELECT thread_id, message_id, json_extract(rewrite_progress, '$.generation')
          FROM legacy_checkpoint_transcript_imports WHERE thread_id = ${row}.thread_id AND message_id = ${row}.message_id
            AND CASE WHEN json_valid(rewrite_progress) THEN json_type(rewrite_progress, '$.generation') = 'text' END;`}
        UPDATE legacy_checkpoint_transcript_imports SET rewrite_progress = NULL, partial_version = NULL
        WHERE thread_id = ${row}.thread_id AND message_id = ${row}.message_id
          AND (rewrite_progress IS NOT NULL OR partial_version IS NOT NULL);
      END`)
  }
}

function legacyToolCallsEqual(stored: string | null, selected: string | null): boolean {
  if (stored === selected) return true
  const left = stored === null ? [] : parseJsonValue(stored)
  const right = selected === null ? [] : parseJsonValue(selected)
  return Array.isArray(left) && Array.isArray(right) && isDeepStrictEqual(left, right)
}

function createLegacyPayloadVerifier(database: DatabaseSync, threadId: string) {
  const existing = database.prepare(`
    SELECT message_id, provider_source_id, provider_occurrence,
      CASE WHEN octet_length(content_json) <= ? THEN content_json END AS stored_body,
      CASE WHEN octet_length(tool_calls_json) <= ? THEN tool_calls_json END AS stored_tools,
      octet_length(tool_calls_json) AS stored_tool_bytes
    FROM thread_messages
    WHERE thread_id = ? AND message_id = ?
      AND (? IS NULL OR ordinal = ?) AND role = ? AND (? = 1 OR content_json IS ?)
      AND (? = 1 OR (reasoning IS ? OR (? = 1 AND reasoning IS ?) OR
        (? = 1 AND NULLIF(reasoning, '') IS NULL AND NULLIF(?, '') IS NULL))
      AND (? = 1 OR tool_calls_json IS ?))
      AND tool_call_id IS ? AND name IS ?
      AND status IS ? AND is_error IS ?
  `)
  const generation = hasThreadMessageFragmentGenerations(database) ? publishedThreadMessageFragmentsSql("f") : "1"
  const fragments = database.prepare(`
    SELECT CASE WHEN octet_length(content_text) <= ${LEGACY_TRANSCRIPT_FRAGMENT_CHAR_LIMIT * 4}
      THEN content_text END AS content_text FROM thread_message_fragments AS f
    WHERE f.thread_id = ? AND f.message_id = ? AND ${generation}
    ORDER BY f.fragment_id LIMIT ?
  `)
  const readLogicalFragments = createLegacyBodyFragmentsReader(database, threadId, generation)
  return (message: DurableLegacyCheckpointMessage, ordinal: number | null, count: number,
    check: () => void, allowLegacyReasoning = false, physicalId = message.messageId,
    allowNativeDefaults = false, bodyOnly = false) => {
    const expected = message.contentFragments ?? []
    // Live streaming and checkpoint recovery cut the same text at different
    // offsets. Only the migration cursor requires identical physical cuts.
    const bodyLimit = allowNativeDefaults
      ? 2 + 6 * (message.contentJson.length + expected.reduce((chars, part) => chars + part.length, 0)) : 0
    const toolLimit = allowNativeDefaults && !bodyOnly ? 6 * (message.toolCallsJson?.length ?? 2) + 32 : 0
    const row = existing.get(bodyLimit, toolLimit, threadId, physicalId, ordinal, ordinal, message.role,
      Number(allowNativeDefaults), message.contentJson,
      Number(bodyOnly),
      message.reasoning, Number(allowLegacyReasoning), allowLegacyReasoning ? message.legacyReasoning : null,
      Number(allowNativeDefaults), message.reasoning,
      Number(allowNativeDefaults), message.toolCallsJson,
      message.toolCallId, message.name, message.status,
      message.isError)
    if (!row || !matchesCheckpointProvider(row, message)) return false
    if (allowNativeDefaults) {
      if (!bodyOnly && (Number(row.stored_tool_bytes ?? 0) > toolLimit ||
          !legacyToolCallsEqual(row.stored_tools as string | null, message.toolCallsJson))) return false
      if (typeof row.stored_body !== "string") return false
      const selected = parseJsonValue(message.contentJson)
      const stored = parseJsonValue(row.stored_body)
      if (typeof selected !== "string")
        return selected !== undefined && isDeepStrictEqual(stored, selected) && fragments.get(threadId, physicalId, 1) === undefined
      if (typeof stored !== "string") return false
      const body = selected + expected.join("")
      if (!body.startsWith(stored)) return false
      const parts = readLogicalFragments(physicalId, stored, 4 * body.length, check)
      return parts !== null && body === stored + parts.join("")
    }
    let seen = 0
    for (const row of fragments.iterate(threadId, physicalId, count + 1)) {
      check()
      if (seen >= count || row.content_text !== expected[seen++]) return false
    }
    return seen === count
  }
}

function matchesPublishedFragmentReplacement(message: DurableLegacyCheckpointMessage, physicalId: string,
  ordinal: number, verify: ReturnType<typeof createLegacyPayloadVerifier>, check: () => void,
  allowLegacyReasoning: boolean): boolean {
  if (!message.contentFragments) return false
  let preview = normalizeFragmentedThreadMessageContent(message.contentFragments)
  for (;;) {
    if (verify({ ...message, contentJson: JSON.stringify(preview), contentFragments: null },
      ordinal, 0, check, allowLegacyReasoning, physicalId)) return true
    // Upsert and ID merge can each apply the same durable cap.
    const normalized = normalizeMessageContent(preview)
    if (typeof normalized !== "string" || normalized === preview) return false
    preview = normalized
  }
}

type VerifyLegacyCopy = (
  message: DurableLegacyCheckpointMessage, ordinal: number | null, count: number,
  check: () => void, allowLegacyReasoning?: boolean, allowNativeDefaults?: boolean, bodyOnly?: boolean,
  proofEpoch?: number
) => boolean | null
const LEGACY_ADOPTED_MEMBER = "legacy-adopted"
const LEGACY_RETIRED_MEMBER_PREFIX = "legacy-retired:"

function isRetiredLegacyMember(value: unknown): value is `${typeof LEGACY_RETIRED_MEMBER_PREFIX}${string}` {
  return typeof value === "string" && value.startsWith(LEGACY_RETIRED_MEMBER_PREFIX)
}

const LEGACY_ALIAS_SQL = `SELECT message_id, ordinal, role, provider_source_id, provider_occurrence
  FROM thread_messages WHERE thread_id = ? AND role = ? AND provider_source_id = ?
    AND COALESCE(provider_occurrence, 1) = ?
  UNION ALL
  SELECT message_id, ordinal, role, provider_source_id, provider_occurrence FROM thread_messages
  WHERE thread_id = ? AND message_id = ? AND role = ? AND provider_source_id IS NULL
    AND COALESCE(provider_occurrence, 1) = 1 AND ? = 1
  LIMIT 2`

interface RetiredLegacyMember {
  id: string
  index: number
  aliasId: string | null
}

interface LegacyCopyProgress {
  coverage: "exact" | "durable-overlap"
  retired: RetiredLegacyMember[]
  verifiedAliases: Array<{ index: number; messageId: string }>
  rebound: Array<{ oldId: string; index: number; key: string | null; physicalId: string | null }>
  activeMessageId: string | null
  activeReplacement: boolean
  nativeActive: "replay" | "verified" | "unverified" | null
  restartActive: boolean
  activeImport?: { id: string; key: string; providerKey: string; payloadKey: string; fieldKeys: string }
  activeRevision?: LegacyStreamRevision
  structureEpoch?: number
}

function readLegacyMemberAlias(
  lookup: StatementSync, threadId: string, message: DurableLegacyCheckpointMessage
) {
  const identity = { id: message.messageId, role: message.role,
    provider_source_id: message.providerSourceId ?? undefined,
    provider_occurrence: message.providerOccurrence ?? undefined }
  const providerId = getMessageProviderSourceId(identity)
  const occurrence = getMessageProviderOccurrence(identity) ?? 1
  const rows = lookup.all(threadId, message.role, providerId, occurrence,
    threadId, providerId, message.role, occurrence)
  if (rows.length > 1 || (rows[0] && !matchesCheckpointProvider(rows[0], message))) return false
  return rows[0] ?? null
}

function legacySlotIdentity(message: DurableLegacyCheckpointMessage) {
  const identity = { id: message.messageId, role: message.role,
    provider_source_id: message.providerSourceId ?? undefined,
    provider_occurrence: message.providerOccurrence ?? undefined }
  return [getMessageProviderSourceId(identity), message.role, getMessageProviderOccurrence(identity) ?? 1] as const
}

function resolveRetiredLegacyMember(
  aliases: StatementSync, threadId: string, message: DurableLegacyCheckpointMessage,
  receipt: unknown, direct?: Record<string, unknown>
) {
  if (!direct && receipt === LEGACY_RETIRED_MEMBER_PREFIX + "null") return null
  const alias = readLegacyMemberAlias(aliases, threadId, message)
  if (alias === false || !direct) return alias
  if (direct.role !== message.role && alias &&
      receipt === LEGACY_RETIRED_MEMBER_PREFIX + JSON.stringify(alias.message_id)) return alias
  if (direct.role !== message.role || !matchesCheckpointProvider(direct, message) ||
      (alias && alias.message_id !== message.messageId)) return false
  return { ...direct, message_id: message.messageId }
}

interface LegacySourceLayout {
  checkpointId?: string
  offset: number
  first: number
  end: number
  rebinding?: boolean
  previousSource?: boolean
  activeFragment?: number
  discoverAliases?: boolean
}

function inspectLegacySourceMembers(
  database: DatabaseSync, threadId: string, messages: readonly DurableLegacyCheckpointMessage[],
  layout: LegacySourceLayout, check: () => void, observe: (id: string) => void
) {
  const direct = database.prepare(`SELECT message_id, role, ordinal, provider_source_id, provider_occurrence
    FROM thread_messages WHERE thread_id = ? AND message_id = ?`)
  const byReplayKey = database.prepare(`SELECT message_id, role, ordinal, provider_source_id, provider_occurrence
    FROM thread_messages WHERE rowid = ${legacyCheckpointReplayRowSql("$threadId", "$key")}`)
  const findAlias = database.prepare(LEGACY_ALIAS_SQL)
  let readMergedBody: ReturnType<typeof createLegacyStreamReader> | undefined
  const readReceipt = layout.checkpointId ? database.prepare(layout.rebinding
    ? `SELECT message_id, content_key, physical_replay_key FROM legacy_checkpoint_transcript_source_ids
       WHERE thread_id = ? AND checkpoint_id = ? AND source_index = ? LIMIT 2`
    : `SELECT message_id, content_key, physical_replay_key FROM legacy_checkpoint_transcript_source_ids
       WHERE thread_id = ? AND checkpoint_id = ? AND message_id = ?${layout.previousSource ? "" : " AND source_index = ?"}`) : null
  type Row = NonNullable<ReturnType<typeof direct.get>>
  const sourceIndexes = new Map<string, number>()
  for (const [index, message] of messages.entries()) {
    if (!message.shadowSlot) sourceIndexes.set(message.messageId, index)
  }
  const aliasIds = new Set<string>()
  const retired: RetiredLegacyMember[] = []
  const rebound: LegacyCopyProgress["rebound"] = []
  const mergedInto = new Map<number, number>()
  const mergeTargets = new Map<number, number>()
  const members: Array<{
    index: number; row: Row | undefined; receipt: Row | undefined; owned: boolean
    conflict: boolean; retired: boolean; sourceId: string; aliasId: string | null
  }> = []
  const receipts = (index: number) => readReceipt?.all(threadId, layout.checkpointId!,
    ...(layout.rebinding ? [index] : layout.previousSource ? [messages[index].messageId] :
      [messages[index].messageId, index])) ?? []
  const owned = (index: number, receipt?: Row) => Boolean(receipt &&
    (index < layout.offset || receipt.content_key === LEGACY_ADOPTED_MEMBER || isRetiredLegacyMember(receipt.content_key)))
  for (let index = layout.first; index < layout.end; index += 1) {
    check()
    const message = messages[index]
    if (message.shadowSlot) {
      members.push({ index, row: undefined, receipt: undefined, sourceId: message.messageId,
        owned: false, conflict: false, retired: false, aliasId: null })
      continue
    }
    observe(message.messageId)
    const records = receipts(index)
    if (records.length > 1) return null
    const receipt = records[0]
    const replayKey = typeof receipt?.physical_replay_key === "string" ? receipt.physical_replay_key : null
    let row = replayKey ? byReplayKey.get({ threadId, key: replayKey }) : direct.get(threadId, message.messageId)
    let physicalId: string | null = null
    if (replayKey) {
      if (typeof row?.message_id !== "string" || row.role !== message.role || !matchesCheckpointProvider(row, message) ||
          aliasIds.has(row.message_id))
        return null
      physicalId = row.message_id
      aliasIds.add(physicalId)
      observe(physicalId)
    }
    const sourceId = typeof receipt?.message_id === "string" ? receipt.message_id : message.messageId
    const changedId = sourceId !== message.messageId
    const ownedAtIndex = owned(index, receipt)
    const wasRetired = isRetiredLegacyMember(receipt?.content_key)
    const activeFragment = index === layout.activeFragment
    let conflict = changedId && Boolean(row && !matchesCheckpointProvider(row, message))
    let isRetired = false
    let aliasId: string | null = physicalId
    if (physicalId === null && (wasRetired || !row) && (ownedAtIndex || activeFragment || layout.discoverAliases)) {
      let alias = resolveRetiredLegacyMember(findAlias, threadId, message, receipt?.content_key, row)
      if (alias === false) conflict = true
      if (alias === null && changedId && !wasRetired) {
        observe(sourceId)
        const prior = direct.get(threadId, sourceId)
        if (prior?.role === message.role && matchesCheckpointProvider(prior, message)) alias = prior
      }
      if (!conflict) {
        row = alias || undefined
        aliasId = typeof row?.message_id === "string" ? row.message_id : null
        if (aliasId !== null && aliasId !== message.messageId) {
          if (aliasIds.has(aliasId)) return null
          aliasIds.add(aliasId)
          observe(aliasId)
          const target = sourceIndexes.get(aliasId)
          if (target !== undefined) {
            const targetRecords = receipts(target)
            if (activeFragment || target === layout.activeFragment || targetRecords.length > 1 ||
                messages[target].role !== message.role || matchesCheckpointProvider(row!, messages[target])) return null
            if (!owned(target, targetRecords[0])) {
              if (!layout.discoverAliases || targetRecords.length) return null
              // Before a receipt exists, both source payloads must be present
              // in the one real canonical row before either slot can share it.
              readMergedBody ??= createLegacyStreamReader(database, threadId, check)
              for (const source of [message, messages[target]]) {
                const stored = readMergedBody({ ...source, messageId: aliasId })
                if (!stored) return null
                const relations = compareLegacyStream(source, stored)
                const reasoning = normalizeVisibleReasoningText(source.reasoning ?? undefined)
                if (relations.body === "different" || relations.body === "checkpoint-extends" ||
                    (reasoning && !normalizeVisibleReasoningText(stored.reasoning)?.startsWith(reasoning)) ||
                    relations.tools === "different" ||
                    relations.tools === "checkpoint-extends") return null
              }
            }
            mergedInto.set(target, index)
            mergeTargets.set(index, target)
          }
        }
        isRetired = !activeFragment && (ownedAtIndex || row !== undefined)
      }
    }
    if (changedId) rebound.push({ oldId: sourceId, index, physicalId: typeof row?.message_id === "string" ? row.message_id : null,
      key: receipt?.content_key === LEGACY_ADOPTED_MEMBER ? LEGACY_ADOPTED_MEMBER : null })
    members.push({ index, row, receipt, sourceId, owned: ownedAtIndex, conflict, retired: isRetired, aliasId })
  }
  for (const member of members) {
    const { index, receipt } = member
    if (mergedInto.has(index)) {
      if (mergeTargets.has(index)) return null
      member.row = undefined
      member.retired = true
      member.aliasId = null
    } else if (member.conflict) return null
    if (member.retired && (member.sourceId !== messages[index].messageId ||
        receipt?.content_key !== LEGACY_RETIRED_MEMBER_PREFIX + JSON.stringify(member.aliasId))) {
      retired.push({ id: messages[index].messageId, index, aliasId: member.aliasId })
    }
  }
  for (const target of mergedInto.keys()) {
    if (target >= layout.first && target < layout.end) continue
    const [receipt] = receipts(target)
    if (receipt?.content_key !== LEGACY_RETIRED_MEMBER_PREFIX + "null") {
      retired.push({ id: messages[target].messageId, index: target, aliasId: null })
    }
  }
  for (const member of rebound) {
    if (mergedInto.has(member.index)) member.physicalId = null
  }
  return { members, retired, rebound, sourceIndexes, aliasIds, mergedInto, mergeTargets }
}

interface LegacyInitialOptions {
  checkpointId?: string
  classifyStreams: boolean
  inferNative: boolean
  allowPendingImplicit?: boolean
}

interface LegacyInitialLayout {
  ordinals: Array<number | null>
  durableIds: Map<number, string>
  sourceAliases: Map<number, { id: string; key: string; complete: boolean }>
  retired: RetiredLegacyMember[]
  recover: number[]
  overlap: number[]
  providerConflicts: Set<number>
  allVerifiedDurable: boolean
}

function inspectInitialLegacyLayout(
  database: DatabaseSync, threadId: string, messages: readonly DurableLegacyCheckpointMessage[],
  contentKeys: readonly string[], options: LegacyInitialOptions,
  check: () => void, observe: (id: string) => void
): LegacyInitialLayout | null {
  const layout = inspectLegacySourceMembers(database, threadId, messages, {
    checkpointId: options.checkpointId, offset: messages.length, first: 0, end: messages.length,
    previousSource: true, discoverAliases: true
  }, check, observe)
  if (!layout) return null
  const result: LegacyInitialLayout = {
    ordinals: Array.from({ length: messages.length }, () => null),
    durableIds: new Map(), sourceAliases: new Map(), retired: [], recover: [], overlap: [], providerConflicts: new Set(),
    allVerifiedDurable: options.inferNative && !database.prepare(
      "SELECT 1 FROM legacy_checkpoint_transcript_imports WHERE thread_id = ? AND owned_by_migration = 1 LIMIT 1"
    ).get(threadId)
  }
  const imported = database.prepare(`SELECT content_key FROM legacy_checkpoint_transcript_imports
    WHERE thread_id = ? AND message_id = ? AND owned_by_migration = 1`)
  const verify = createLegacyPayloadVerifier(database, threadId)
  const integrity = result.allVerifiedDurable ? database.prepare(`SELECT recovery_integrity FROM thread_messages
    WHERE thread_id = ? AND message_id = ?`) : null
  for (const { index, row, receipt, retired, aliasId } of layout.members) {
    check()
    const message = messages[index]
    if (message.shadowSlot) continue
    const position = Math.min(index, layout.mergeTargets.get(index) ?? index)
    if (retired) {
      result.retired.push({ id: message.messageId, index, aliasId })
      result.allVerifiedDurable = false
    }
    if (aliasId !== null) result.durableIds.set(position, aliasId)
    if (!row) {
      result.allVerifiedDurable = false
      continue
    }
    const ordinal = Number(row.ordinal)
    if (row.role !== message.role || !Number.isSafeInteger(ordinal) || ordinal < 0) return null
    result.ordinals[position] = ordinal
    if (retired) continue
    if (aliasId !== null && typeof receipt?.physical_replay_key === "string") {
      result.sourceAliases.set(index, { id: aliasId, key: receipt.physical_replay_key, complete: Boolean(verify(
        message, ordinal, message.contentFragments?.length ?? 0, check, false, aliasId, true
      )) })
    }
    const importKey = imported.get(threadId, String(row.message_id))?.content_key
    const sameProvider = matchesCheckpointProvider(row, message)
    if (typeof importKey === "string" && importKey !== contentKeys[index] &&
        !verify(message, ordinal, message.contentFragments?.length ?? 0, check, false, String(row.message_id), true)) {
      if (!sameProvider || (!message.providerIdentityDeclared && !(options.allowPendingImplicit && message.physicalOccurrenceBound) &&
          !message.previousCopies?.length)) return null
      result.providerConflicts.add(index)
    }
    if (!sameProvider && (message.role !== "assistant" || !options.classifyStreams)) result.providerConflicts.add(index)
    result.allVerifiedDurable &&= sameProvider && typeof importKey !== "string" &&
      integrity?.get(threadId, message.messageId)?.recovery_integrity === 1
    if (options.classifyStreams && typeof importKey !== "string" &&
        !message.sourceOccurrenceUncertain && !message.revisionOrderConflict) {
      if (message.role === "assistant" && sameProvider) result.recover.push(index)
      else if (!sameProvider || !verify(message, ordinal, message.contentFragments?.length ?? 0, check,
        false, String(row.message_id), true)) result.overlap.push(index)
    }
  }
  return result
}

interface LegacySourceOrdinalGap {
  from: number
  size: number
}

function legacySourceOrdinalGaps(raw: unknown): LegacySourceOrdinalGap[] {
  const value = parseJsonValue(raw)
  const gaps = (Array.isArray(value) ? value : [value]) as Array<LegacySourceOrdinalGap | undefined>
  let from = 0
  let size = 0
  for (const gap of gaps) {
    if (!gap || !Number.isSafeInteger(gap.from) || gap.from <= from || !Number.isSafeInteger(gap.size) || gap.size <= size)
      return []
    from = gap.from
    size = gap.size
  }
  return gaps as LegacySourceOrdinalGap[]
}

function legacySourceOrdinal(base: number, gaps: readonly LegacySourceOrdinalGap[], index: number): number {
  let lower = 0
  let upper = gaps.length
  while (lower < upper) {
    const middle = (lower + upper) >>> 1
    if (gaps[middle].from <= index) lower = middle + 1
    else upper = middle
  }
  return base + index + (gaps[lower - 1]?.size ?? 0)
}

function *legacySourceOrdinalRanges(base: number, gaps: readonly LegacySourceOrdinalGap[], from: number, through: number) {
  let start = from
  for (const gap of gaps) {
    if (gap.from <= start) continue
    if (gap.from >= through) break
    const ordinal = legacySourceOrdinal(base, gaps, start)
    yield [ordinal, ordinal + gap.from - start] as const
    start = gap.from
  }
  if (start < through) {
    const ordinal = legacySourceOrdinal(base, gaps, start)
    yield [ordinal, ordinal + through - start] as const
  }
}

function planLegacyContinuation(database: DatabaseSync, threadId: string, sourceOrdinals: readonly (number | null)[],
  lastDurable: number, check: () => void, graphFences: readonly { index: number; ordinal: number }[] = []) {
  const neighbor = (direction: "<" | ">", aggregate: "MAX" | "MIN") =>
    database.prepare(`SELECT ${aggregate}(ordinal) AS ordinal FROM (
      SELECT ${aggregate}(ordinal) AS ordinal FROM thread_messages
      WHERE thread_id = $threadId AND ordinal ${direction} $ordinal
      UNION ALL SELECT ${aggregate}(ordinal) FROM thread_graph_transcript_boundaries
      WHERE thread_id = $threadId AND ordinal ${direction} $ordinal
    )`)
  const previousRow = neighbor("<", "MAX")
  const reserved: number[] = []
  const breaks: Array<{ first: number; shift: number }> = []
  let shift = 0
  let lastFence = -1
  const fence = (index: number, ordinal: number, visible: boolean) => {
    check()
    if (ordinal <= lastFence) throw searchBootstrapNeedsForeground()
    lastFence = ordinal
    const missing = index - reserved.length
    if (missing) {
      const extra = graphFences.length ? missing :
        Math.max(0, missing - (ordinal - Number(previousRow.get({ threadId, ordinal })?.ordinal ?? -1) - 1))
      if (extra) {
        shift += extra
        breaks.push({ first: ordinal, shift })
      }
      while (reserved.length < index) reserved.push(ordinal + shift - (index - reserved.length))
    }
    if (visible) reserved.push(ordinal + shift)
  }
  let graphIndex = 0
  for (const [index, ordinal] of sourceOrdinals.entries()) {
    check()
    while (graphFences[graphIndex]?.index === index)
      fence(index, graphFences[graphIndex++].ordinal, false)
    if (ordinal !== null) fence(index, ordinal, true)
  }
  while (graphIndex < graphFences.length)
    fence(sourceOrdinals.length, graphFences[graphIndex++].ordinal, false)
  if (graphFences.length && reserved.length < sourceOrdinals.length)
    fence(sourceOrdinals.length, lastFence + 1, false)
  let next = lastDurable + shift + 1
  while (reserved.length < sourceOrdinals.length) reserved.push(next++)
  const base = reserved[0]
  const gaps: LegacySourceOrdinalGap[] = []
  for (const [index, ordinal] of reserved.entries()) {
    const size = ordinal - base - index
    if (size > (gaps.at(-1)?.size ?? 0)) gaps.push({ from: index, size })
  }
  // A newer interval moves first so an interrupted reservation preserves the
  // order of every committed row.
  const ranges: LegacyOrdinalRange[] = breaks.map(({ first, shift }, index) => ({
    after: first - 1, through: (breaks[index + 1]?.first ?? lastDurable + 1) - 1,
    shift, cursor: null
  })).reverse()
  return { base, gaps, ranges, shift, reserved }
}

function legacyTranscriptProgressMatches(
  database: DatabaseSync,
  threadId: string,
  checkpointId: string,
  state: Record<string, unknown>,
  messages: readonly DurableLegacyCheckpointMessage[],
  checkCurrent: () => void,
  foreground: boolean,
  rebinding: boolean,
  offerRestart: boolean,
  observe: (messageId: string) => void = () => {},
  verifyPublishedPrefix = false,
  verify = createLegacyPayloadVerifier(database, threadId)
): LegacyCopyProgress | null {
  const offset = Number(state.next_index)
  const fragmentOffset = Number(state.current_fragment_index)
  const scoped = usesLegacyTranscriptSlots(state)
  const preservedBase = state.append_ordinal_base == null ? null : Number(state.append_ordinal_base)
  const gaps = legacySourceOrdinalGaps(state.source_ordinal_gap)
  const slot = scoped ? database.prepare(`SELECT ordinal FROM legacy_checkpoint_transcript_slots
    WHERE thread_id = ? AND checkpoint_id = ? AND message_index = ?`) : null
  if (
    (state.status !== "migrating" && state.status !== "complete") || state.checkpoint_id !== checkpointId ||
    (state.status === "complete" && (offset !== messages.length || fragmentOffset !== 0)) ||
    (preservedBase !== null && (!Number.isSafeInteger(preservedBase) || preservedBase < 0)) ||
    (Number(state.total_messages) !== messages.length &&
      !(offerRestart && messages.length === offset + Number(fragmentOffset > 0))) ||
    !Number.isSafeInteger(offset) || offset < 0 || offset > messages.length ||
    !Number.isSafeInteger(fragmentOffset) || fragmentOffset < 0 ||
    (fragmentOffset > 0 && (offset >= messages.length || messages[offset].shadowSlot))
  ) return null
  const layoutCount = !scoped && (preservedBase !== null || rebinding || typeof state.adopted_source_start === "number")
    ? messages.length : offset + Number(fragmentOffset > 0)
  const layout = inspectLegacySourceMembers(database, threadId, messages, {
    checkpointId, offset, first: 0, end: layoutCount, rebinding,
    activeFragment: fragmentOffset > 0 ? offset : undefined, discoverAliases: scoped
  }, checkCurrent, observe)
  if (!layout) return null
  const reservedOrdinal = (index: number) => scoped
    ? Number(index === offset && fragmentOffset > 0
      ? slot?.get(threadId, checkpointId, index)?.ordinal : layout.members[index]?.row?.ordinal)
    : legacySourceOrdinal(preservedBase ?? 0, gaps, index)
  const retiredIndexes = new Set<number>()
  const exactAliasIndexes = new Map<number, string>()
  const provedIndexes = new Set<number>()
  const checkBorrowedPrefix = rebinding && state.status === "complete"
  const migrated = checkBorrowedPrefix ? database.prepare(`SELECT 1 FROM legacy_checkpoint_transcript_imports
    WHERE thread_id = ? AND message_id = ? AND owned_by_migration = 1`) : null
  const physicalExists = checkBorrowedPrefix ? database.prepare(`SELECT 1 FROM thread_messages
    WHERE thread_id = ? AND message_id = ?`) : null
  let borrowedOverlap = false
  let previous = -1
  for (const { index, row, receipt, retired, sourceId, aliasId } of layout.members) {
    checkCurrent()
    if (retired) {
      if (verifyPublishedPrefix && row && aliasId && !layout.mergeTargets.has(index) &&
          matchesCheckpointProvider(row, messages[index])) exactAliasIndexes.set(index, aliasId)
      else if (verifyPublishedPrefix) return null
      else retiredIndexes.add(index)
    }
    if (layout.mergedInto.has(index)) continue
    const message = messages[index]
    if (message.shadowSlot) continue
    if (scoped && retired && !row) continue
    const reserved = reservedOrdinal(index)
    const ordinal = row ? Number(row.ordinal) : reserved
    const mergedTarget = layout.mergeTargets.get(index)
    if (mergedTarget !== undefined) {
      if (ordinal !== reservedOrdinal(Math.min(index, mergedTarget))) return null
      if (mergedTarget < index) continue
    }
    if (!Number.isSafeInteger(ordinal) || ordinal <= previous || ordinal > reserved ||
        (preservedBase === null && ordinal !== reserved) ||
        (row && row.role !== message.role) ||
        (preservedBase !== null && index < offset && (!receipt || (!row && !retired)))) return null
    if (row && receipt && ordinal === reserved && typeof state.progress_key === "string" &&
        matchesCheckpointProvider(row, message)) provedIndexes.add(index)
    if (migrated && index < offset && !retired && row &&
        !migrated.get(threadId, String(row.message_id)) &&
        !(sourceId !== row.message_id && !physicalExists?.get(threadId, sourceId) && migrated.get(threadId, sourceId)) &&
        !verify(message, ordinal, message.contentFragments?.length ?? 0, checkCurrent, false,
          String(row.message_id), true)) {
      if (message.role === "assistant" || (sourceId === row.message_id && state.search_projection_state === "complete"))
        return null
      borrowedOverlap = true
    }
    previous = ordinal
  }
  if (!scoped && preservedBase !== null) {
    const occupants = database.prepare(`SELECT message_id FROM thread_messages
      WHERE thread_id = ? AND ordinal >= ? AND ordinal < ? LIMIT ?`)
    for (const [first, end] of legacySourceOrdinalRanges(preservedBase, gaps, offset, messages.length)) {
      for (const row of occupants.iterate(threadId, first, end, end - first + 1)) {
        checkCurrent()
        if (typeof row.message_id !== "string" ||
            (!layout.sourceIndexes.has(row.message_id) && !layout.aliasIds.has(row.message_id))) return null
      }
    }
  }
  // Older copies wrote the raw, capped provider field. Permit that exact value
  // when validating already-published progress before this projection was recorded.
  const allowLegacyReasoning = state.search_projection_state == null
  const originalCopy = allowLegacyReasoning && state.progress_key == null && preservedBase === null
  const durableOverlap = foreground && originalCopy
    ? database.prepare(`SELECT 1 FROM thread_messages
         WHERE thread_id = ? AND message_id = ? AND ordinal = ? AND role = ?
           AND provider_source_id IS ? AND provider_occurrence IS ?
           AND (start_at IS NOT NULL OR end_at IS NOT NULL OR content_priority IS NOT NULL OR created_at IS NOT ?)`)
    : null
  let coverage: LegacyCopyProgress["coverage"] = retiredIndexes.size || borrowedOverlap ? "durable-overlap" : "exact"
  let activeMessageId: string | null = null
  let activeReplacement = false
  let nativeActive: LegacyCopyProgress["nativeActive"] = null
  let restartActive = false
  let activeImport: LegacyCopyProgress["activeImport"]
  const published = parseJsonValue(state.active_fragment_revision)
  const rowVersion = (id: string) => Number(database.prepare(LEGACY_VERSION_SQL).get(threadId, id)?.version ?? 0)
  const ownsActiveCopy = (id: string, count: number) => Array.isArray(published) && published[0] === id &&
    published[3] === count && published[2] === rowVersion(id) &&
    database.prepare(`SELECT 1 FROM legacy_checkpoint_transcript_imports
      WHERE thread_id = ? AND message_id = ? AND owned_by_migration = 1 AND partial_version = ?`)
      .get(threadId, id, published[2]) !== undefined
  const aliasImport = (message: DurableLegacyCheckpointMessage, id: string,
    providerSourceId: string | null, providerOccurrence: number | null) => {
    if (id === message.messageId && providerSourceId === message.providerSourceId &&
        providerOccurrence === message.providerOccurrence) return
    const { raw, normalized, payload, fields } = legacyMessageContentKeys({ ...message, messageId: id, providerSourceId, providerOccurrence })
    activeImport = { id, key: raw, providerKey: normalized, payloadKey: payload, fieldKeys: fields }
  }
  for (let index = preservedBase === null || verifyPublishedPrefix || (scoped && state.progress_key == null) ? 0 : offset;
    index < offset + Number(fragmentOffset > 0); index += 1) {
    checkCurrent()
    const message = messages[index]
    if (message.shadowSlot) continue
    const count = index === offset ? fragmentOffset : message.contentFragments?.length ?? 0
    const ordinal = reservedOrdinal(index)
    if (retiredIndexes.has(index)) continue
    observe(message.messageId)
    const row = layout.members[index]?.row
    const physicalId = row?.message_id
    if (index === offset && count > 0 && typeof physicalId === "string" && row &&
        Array.isArray(published) && published[0] === physicalId && published[3] === count &&
        typeof published[8] === "string" && matchesCheckpointProvider(row, message)) {
      const merged = database.prepare(`SELECT stream_authority, content_priority, recovery_integrity
        FROM thread_messages WHERE thread_id = ? AND message_id = ? AND fork_replay_key = ?`)
        .get(threadId, physicalId, published[8])
      if (!merged) return null
      activeMessageId = physicalId
      if (published[2] === rowVersion(physicalId) && !merged.stream_authority &&
          !merged.content_priority && merged.recovery_integrity === 0 &&
          matchesPublishedFragmentReplacement(message, physicalId, ordinal, verify, checkCurrent, allowLegacyReasoning)) {
        nativeActive = "replay"
        restartActive = true
        aliasImport(message, physicalId, row.provider_source_id as string | null,
          row.provider_occurrence as number | null)
      } else {
        activeReplacement = true
        if (verify(message, ordinal, message.contentFragments?.length ?? 0, checkCurrent,
          allowLegacyReasoning, physicalId, true)) {
          nativeActive = "verified"
          aliasImport(message, physicalId, row.provider_source_id as string | null,
            row.provider_occurrence as number | null)
        } else {
          nativeActive = "unverified"
          coverage = "durable-overlap"
        }
      }
      continue
    }
    if ((index !== offset || count < (message.contentFragments?.length ?? 0)) &&
        verify(message, ordinal, count, checkCurrent, allowLegacyReasoning,
      typeof physicalId === "string" ? physicalId : message.messageId, index < offset)) {
      if (index === offset && count > 0) {
        activeMessageId = String(physicalId ?? message.messageId)
        if (row && ownsActiveCopy(activeMessageId, count)) aliasImport(message, activeMessageId,
          row.provider_source_id as string | null, row.provider_occurrence as number | null)
      }
      continue
    }
    if (verifyPublishedPrefix && index < offset) return null
    const member = layout.members[index]
    if (index === offset && count > 0 && typeof physicalId === "string" &&
        typeof member?.row?.provider_source_id === "string" && member.row.provider_source_id !== physicalId &&
        matchesPublishedFragmentReplacement(message, physicalId, ordinal, verify, checkCurrent, allowLegacyReasoning)) {
      // The application can merge a completed canonical message over a
      // partially copied alias. Its normal durable text cap loses coverage.
      activeMessageId = physicalId
      activeReplacement = true
      coverage = "durable-overlap"
      continue
    }
    if (index === offset && count > 0 && (message.providerIdentityDeclared || message.stableSourceId) &&
        typeof physicalId === "string" && member?.row && matchesCheckpointProvider(member.row, message)) {
      if (ownsActiveCopy(physicalId, count) && Array.isArray(published) &&
          (offerRestart || published[5] === legacyMessageContentKeys(message).raw)) {
        activeMessageId = physicalId
        restartActive = true
        aliasImport(message, physicalId, member.row.provider_source_id as string | null,
          member.row.provider_occurrence as number | null)
        continue
      }
    }
    if (verifyPublishedPrefix) return null
    // Old copies preserved a live row at the reserved ordinal. They did not
    // retain its provenance, so accept only positive durable metadata and keep
    // search coverage unverified. A partially copied fragment row needs exact bytes.
    const matchesOriginal = index < offset && message.previousCopies?.some(({ payload }) =>
      verify(payload, ordinal, payload.contentFragments?.length ?? 0, checkCurrent, allowLegacyReasoning))
    if (index >= offset || (!matchesOriginal && !provedIndexes.has(index) &&
      !(scoped && originalCopy && member?.row && matchesCheckpointProvider(member.row, message)) &&
      !durableOverlap?.get(threadId, message.messageId, ordinal, message.role,
        message.providerSourceId, message.providerOccurrence, message.createdAt))) return null
    coverage = "durable-overlap"
  }
  return {
    coverage,
    retired: layout.retired.filter(({ index }) => !exactAliasIndexes.has(index)),
    verifiedAliases: [...exactAliasIndexes].map(([index, messageId]) => ({ index, messageId })),
    rebound: layout.rebound,
    activeMessageId,
    activeReplacement,
    nativeActive,
    restartActive,
    activeImport
  }
}

interface LegacyAppendPlacement {
  reservation: LegacyOrdinalReservation | null
  nextOrdinal: number
  adopted: Array<{ id: string; index: number }>
  retired: RetiredLegacyMember[]
}

type LegacyAppendJournal = Pick<LegacySourceLayout, "checkpointId" | "offset" | "rebinding" | "activeFragment">

interface LegacyDurableProbe<T> {
  result: T
  versions: Map<string, number>
}

const LEGACY_COPY_STATE_SQL = `SELECT checkpoint_id, total_messages, next_index, current_fragment_index, active_fragment_revision,
  append_ordinal_base, source_ordinal_gap, continuation_verified, continuation_ancestor,
  status, source_key, timing_checkpoint_id, timing_source_prefix,
  adopted_source_start, progress_key,
  provider_progress_key, source_layout_key, copied_layout_key, source_lane_key, source_lane_count, shadow_slots,
  search_projection_state, occurrence_unverified_version, occurrence_only, occurrence_source_count,
  occurrence_source_key, scoped_order, updated_at
  FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?`
const LEGACY_TAIL_SQL = `SELECT MAX(ordinal) AS last FROM (
  SELECT MAX(ordinal) AS ordinal FROM thread_messages WHERE thread_id = $threadId
  UNION ALL SELECT MAX(ordinal) FROM thread_graph_transcript_boundaries WHERE thread_id = $threadId
)`
const LEGACY_VERSION_SQL = "SELECT version FROM thread_search_message_versions WHERE thread_id = ? AND message_id = ?"
const LEGACY_EPOCH_SQL = "SELECT epoch FROM thread_search_structure_versions WHERE thread_id = ?"
const LEGACY_OCCURRENCE_VERSION_SQL = "SELECT version FROM thread_search_occurrence_versions WHERE thread_id = ?"

function usesLegacyTranscriptSlots(state: Record<string, unknown> | undefined): boolean {
  return state?.scoped_order === 1 || (state?.scoped_order === 0 && state.progress_key == null && state.status === "migrating")
}

interface LegacyOccurrenceSnapshot {
  epoch: number
  version: number
}

function readLegacyOccurrenceSnapshot(database: DatabaseSync, threadId: string): LegacyOccurrenceSnapshot | undefined {
  if (!database.prepare(`SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'thread_search_occurrence_versions'`).get()) return undefined
  return { epoch: Number(database.prepare(LEGACY_EPOCH_SQL).get(threadId)?.epoch ?? 0),
    version: Number(database.prepare(LEGACY_OCCURRENCE_VERSION_SQL).get(threadId)?.version ?? 0) }
}

function planLegacyAppend(
  database: DatabaseSync, threadId: string, messages: readonly DurableLegacyCheckpointMessage[],
  base: number, previousCount: number, gaps: readonly LegacySourceOrdinalGap[], check: () => void,
  journal: LegacyAppendJournal | null, observe: (messageId: string) => void = () => {}
): LegacyAppendPlacement | null {
  const first = legacySourceOrdinal(base, gaps, previousCount)
  const nextOrdinal = legacySourceOrdinal(base, gaps, messages.length)
  const layout = inspectLegacySourceMembers(database, threadId, messages, {
    offset: 0, ...journal, first: journal ? 0 : previousCount, end: messages.length, discoverAliases: true
  }, check, observe)
  if (!layout) return null
  const verify = createLegacyPayloadVerifier(database, threadId)
  const accepted: LegacyAppendPlacement["adopted"] = []
  const formerIds = new Map(layout.rebound.map(({ index, oldId }) => [index, oldId]))
  const retired = layout.retired.map((member) => ({ ...member, id: formerIds.get(member.index) ?? member.id }))
  const anchors: LegacyOrdinalMove[] = []
  let lastAnchor = first - 1
  let anchoredCount = 0
  const position = (index: number) => Math.min(index, layout.mergeTargets.get(index) ?? index)
  const ordered = layout.members.sort((a, b) => position(a.index) - position(b.index))
  for (const { index, row, sourceId, owned, retired: alias } of ordered) {
    check()
    if (!row || typeof row.message_id !== "string") continue
    const message = messages[index]
    const ordinal = Number(row.ordinal)
    const after = legacySourceOrdinal(base, gaps, position(index))
    if (after < first) {
      if (layout.mergeTargets.has(index) && ordinal !== after) return null
      continue
    }
    if (!Number.isSafeInteger(ordinal) || ordinal <= lastAnchor || row.role !== message.role ||
        !matchesCheckpointProvider(row, message) ||
        (!owned && !alias &&
          !verify(message, ordinal, message.contentFragments?.length ?? 0, check, false, String(row.message_id), true))) return null
    accepted.push({ id: sourceId, index })
    lastAnchor = ordinal
    anchoredCount += 1
    if (ordinal !== after) anchors.push({ messageId: row.message_id, before: ordinal, after })
  }
  const countInRange = database.prepare(`SELECT COUNT(*) AS count FROM (
    SELECT 1 FROM thread_messages WHERE thread_id = ? AND ordinal >= ? AND ordinal < ? LIMIT ?)`)
  let physicalCount = 0
  for (const [start, end] of legacySourceOrdinalRanges(base, gaps, previousCount, messages.length)) {
    if (start > lastAnchor) break
    physicalCount += Number(countInRange.get(threadId, start, Math.min(end, lastAnchor + 1), anchoredCount + 1)?.count)
  }
  // Live rows can sit beyond the planned end after a temporary alias occupied
  // an ordinal. Check the whole physical interval before moving these anchors.
  if (lastAnchor >= nextOrdinal) {
    physicalCount += Number(countInRange.get(threadId, nextOrdinal, lastAnchor + 1, anchoredCount + 1)?.count)
  }
  if (physicalCount !== anchoredCount) return null
  const finalGap = gaps.at(-1)
  const lastOwnedOrReserved = Math.max(lastAnchor, finalGap ? base + finalGap.from + finalGap.size - 1 : -1)
  const tail = database.prepare(`SELECT MIN(ordinal) AS first, MAX(ordinal) AS last
    FROM thread_messages WHERE thread_id = ? AND ordinal > ?`).get(threadId, lastOwnedOrReserved)
  const shift = tail?.first == null ? 0 : Math.max(0, nextOrdinal - Number(tail.first))
  const range = shift > 0
    ? { after: lastOwnedOrReserved, through: Number(tail?.last), shift, cursor: null } : null
  const reservation = planLegacyOrdinalReservation(database, threadId, range, anchors, previousCount)
  if (reservation) reservation.adoptedAnchors = accepted.map(({ id }) => id)
  return {
    nextOrdinal: Math.max(nextOrdinal, Number(tail?.last ?? -1) + shift + 1),
    reservation, adopted: accepted, retired
  }
}

function legacyPrefixDigest(keys: readonly string[], count: number, check: () => void, first = 0): string {
  const hash = createHash("sha256")
  for (let relative = 0; relative < count; relative += 1) {
    if (relative % LEGACY_TRANSCRIPT_BATCH_LIMIT === 0) check()
    hash.update(keys[first + relative])
  }
  return hash.digest("hex")
}

interface LegacyTranscriptCopyInput {
  databasePath: string
  threadId: string
  checkpointId: string
  messages: readonly DurableLegacyCheckpointMessage[]
  graphBoundaries: readonly LegacyGraphBoundary[]
  prefixCopy?: boolean
  pendingScopedPrefix?: { count: number; key: string; hasActiveCopy: boolean }
  sourceClaims: readonly LegacySourceClaim[]
  sourcePrefixKeys: readonly string[]
  payloadBytes: number
  cancellation?: Int32Array
  searchGuard?: LegacySearchBootstrapGuard
  reservationDeadline?: number
  sourceStillCurrent?: () => boolean
  sourceFamilyStillCurrent: () => boolean
  sourceKey: string
  transcriptRevision: string | null
  parentCheckpointId: string | null
  laterImplicitTurn?: boolean
  occurrenceSnapshot?: LegacyOccurrenceSnapshot
  descendsFrom?: (checkpointId: string) => boolean
  publishedAncestor?: string
}

function recordLegacyCheckpointParent(database: DatabaseSync, input: LegacyTranscriptCopyInput): void {
  database.prepare(`INSERT OR IGNORE INTO legacy_checkpoint_transcript_parents
    (thread_id, checkpoint_id, parent_checkpoint_id) VALUES (?, ?, ?)`)
    .run(input.threadId, input.checkpointId, input.parentCheckpointId)
  if (!database.prepare(`SELECT 1 FROM legacy_checkpoint_transcript_parents
    WHERE thread_id = ? AND checkpoint_id = ? AND parent_checkpoint_id IS ?`)
    .get(input.threadId, input.checkpointId, input.parentCheckpointId)) throw searchBootstrapNeedsForeground()
}

function inheritsLegacyPublication(input: LegacyTranscriptCopyInput, checkpointId: unknown): boolean {
  return typeof checkpointId === "string" &&
    (checkpointId === input.checkpointId || input.descendsFrom?.(checkpointId) === true)
}

function legacyLayoutSlotKey(message: DurableLegacyCheckpointMessage, normalized?: string): string {
  if (message.shadowSlot || message.providerIdentityDeclared || message.previousCopies?.length) {
    return createHash("sha256").update(JSON.stringify([
      message.shadowSlot ? "shadow" : "provider", legacyCheckpointProviderIdentity(message)
    ])).digest("hex")
  }
  return normalized ?? legacyMessageContentKeys(message).normalized
}

function legacyActiveLayoutDigest(messages: readonly DurableLegacyCheckpointMessage[], keys: readonly string[],
  count: number, active: number, check: () => void): string | null {
  const message = messages[active]
  if (!message || message.shadowSlot || (!message.stableSourceId && !message.providerIdentityDeclared) ||
      active >= count || active < 0 || count > messages.length) return null
  const hash = createHash("sha256")
  const identity = createHash("sha256").update(JSON.stringify(["active", legacyCheckpointProviderIdentity(message)])).digest("hex")
  // Reserved but unpublished positions belong to the new source. Only the
  // prefix through the active row can establish continuity of a copy.
  for (let index = 0; index <= active; index += 1) {
    if (index % LEGACY_TRANSCRIPT_BATCH_LIMIT === 0) check()
    hash.update(index === active ? identity : keys[index])
  }
  return hash.digest("hex")
}

function legacyUserTurnKey(message: Parameters<typeof legacyCheckpointProviderIdentity>[0]): string {
  return createHash("sha256").update(legacyCheckpointProviderIdentity(message)).digest("hex")
}

function legacyPhysicalUserTurn(row: Record<string, SQLOutputValue> | undefined): string {
  if (row?.hidden === 1) return legacyGraphUserTurn(String(row.message_id))
  return row ? legacyUserTurnKey({ messageId: String(row.message_id), role: "user",
    providerSourceId: row.provider_source_id as string | null,
    providerOccurrence: row.provider_occurrence as number | null }) : ""
}

function legacySourceTurns(messages: readonly DurableLegacyCheckpointMessage[]): Array<string | null> {
  // The blank key identifies the open prefix before the first known user turn.
  // Null means the source has a user boundary without a usable identity.
  let turn: string | null = ""
  return messages.map((message) => {
    if (message.role === "user" && !message.shadowSlot) {
      turn = message.inferredSourceTurn !== undefined ? message.inferredSourceTurn :
        message.stableSourceId || message.providerIdentityDeclared ? legacyUserTurnKey(message) : null
    }
    return message.inferredSourceTurn === undefined ? turn : message.inferredSourceTurn
  })
}

function bindLegacyImplicitOccurrences(input: LegacyTranscriptCopyInput): LegacyTranscriptCopyInput {
  if (!existsSync(input.databasePath)) return input
  const database = new DatabaseSync(input.databasePath, { readOnly: true, timeout: input.searchGuard ? 100 : 5_000 })
  try {
    database.exec("BEGIN")
    const migrationColumns = database.prepare("PRAGMA table_info(legacy_checkpoint_transcript_migrations)").all()
    const migrationField = (name: string) => migrationColumns.some((column) => column.name === name) ? name : "NULL"
    const marker = migrationColumns.length ? database.prepare(`
      SELECT checkpoint_id, status, next_index, total_messages,
        ${migrationField("current_fragment_index")} AS current_fragment_index,
        ${migrationField("active_fragment_revision")} AS active_fragment_revision,
        ${migrationField("scoped_order")} AS scoped_order, ${migrationField("progress_key")} AS progress_key
      FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?
    `).get(input.threadId) : undefined
    const published = marker?.checkpoint_id
    const inheritsPublished = inheritsLegacyPublication(input, published)
    const pendingScopedPrefix = marker?.status === "migrating" && marker.scoped_order === 1 &&
      inheritsPublished && typeof marker.progress_key === "string" &&
      Number(marker.next_index) < Number(marker.total_messages)
      ? { count: Number(marker.total_messages), key: marker.progress_key, hasActiveCopy: Number(marker.current_fragment_index) > 0 }
      : undefined
    const publishedAncestor = typeof published === "string" && input.descendsFrom?.(published) ? published : undefined
    const occurrenceSnapshot = readLegacyOccurrenceSnapshot(database, input.threadId)
    const draftSnapshot = input.occurrenceSnapshot
    if (draftSnapshot && (!occurrenceSnapshot || draftSnapshot.epoch !== occurrenceSnapshot.epoch ||
        draftSnapshot.version !== occurrenceSnapshot.version))
      throw searchBootstrapSuperseded()
    const importColumns = database.prepare("PRAGMA table_info(legacy_checkpoint_transcript_imports)").all()
    const importField = (name: string, fallback = "NULL") =>
      importColumns.some((column) => column.name === name) ? `i.${name}` : fallback
    const importJoin = importColumns.length ? "LEFT JOIN legacy_checkpoint_transcript_imports AS i USING (thread_id, message_id)" : ""
    const importOwnership = importField("owned_by_migration", importJoin ? "CASE WHEN i.message_id IS NOT NULL THEN 1 END" : "NULL")
    const completedAncestor = publishedAncestor && marker?.status === "complete"
    const followsPublishedTail = marker?.status === "complete" &&
      (completedAncestor || published === input.checkpointId)
    const active = marker?.status === "migrating" && inheritsPublished
      ? parseJsonValue(marker.active_fragment_revision) : null
    const activeId = Array.isArray(active) && typeof active[0] === "string" ? active[0] : undefined
    if (!completedAncestor && !database.prepare(`SELECT 1 FROM thread_messages
      WHERE thread_id = ? LIMIT 1`).get(input.threadId))
      return { ...input, publishedAncestor, occurrenceSnapshot, pendingScopedPrefix }
    const hasGraph = hasLegacyGraphBoundaryTable(database)
    const graphFences = readLegacyGraphFences(database, input)
    const graphAt = new Map<number, typeof graphFences>()
    for (const fence of graphFences) {
      const at = graphAt.get(fence.index) ?? []
      at.push(fence)
      graphAt.set(fence.index, at)
    }
    const precedingUser = database.prepare(legacyPhysicalUserSql(hasGraph, "<"))
    const followingUser = database.prepare(legacyPhysicalUserSql(hasGraph, ">"))
    const followingBoundary = (ordinal: SQLOutputValue) =>
      Number(followingUser.get({ threadId: input.threadId, ordinal })?.ordinal ?? lastOrdinal)
    const maximumOccurrence = database.prepare(`SELECT MAX(provider_occurrence) AS value FROM thread_messages
      WHERE thread_id = ? AND role = ? AND provider_source_id = ?`)
    const hasReceipt = importJoin ? database.prepare(`SELECT 1 FROM legacy_checkpoint_transcript_imports
      WHERE thread_id = ? AND message_id = ?`) : null
    const sourceDeclaration = importField("source_declared_occurrence")
    const readClaim = database.prepare(`SELECT m.tool_call_id, m.provider_occurrence, ${sourceDeclaration} AS source_declared_occurrence
      FROM thread_messages AS m ${importJoin}
      WHERE m.thread_id = ? AND m.message_id = ?`)
    const intervalSize = database.prepare(`SELECT COUNT(*) AS size FROM (
      SELECT 1 FROM thread_messages WHERE thread_id = ? AND ordinal > ? AND ordinal < ?
      LIMIT ${LEGACY_TRANSCRIPT_BATCH_LIMIT + 1})`)
    const direct = database.prepare(`SELECT message_id, role, provider_source_id, provider_occurrence, ordinal
      FROM thread_messages WHERE thread_id = ? AND message_id = ?`)
    const activeSlot = marker?.status === "migrating" && Number(marker.current_fragment_index) > 0 &&
      inheritsPublished &&
      database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'legacy_checkpoint_transcript_slots'").get()
      ? database.prepare(`SELECT ordinal FROM legacy_checkpoint_transcript_slots
          WHERE thread_id = ? AND checkpoint_id = ? AND message_index = ?`)
        .get(input.threadId, published as string, Number(marker?.next_index))
      : null
    const readPublishedAlias = inheritsPublished &&
      database.prepare("PRAGMA table_info(legacy_checkpoint_transcript_source_ids)").all()
        .some(({ name }) => name === "physical_replay_key")
      ? database.prepare(`SELECT m.message_id, m.role, m.provider_source_id, m.provider_occurrence, m.ordinal
        FROM legacy_checkpoint_transcript_source_ids AS source
        LEFT JOIN thread_messages AS m ON m.rowid = ${legacyCheckpointReplayRowSql("source.thread_id", "source.physical_replay_key")}
        WHERE source.thread_id = ? AND source.checkpoint_id = ? AND source.message_id = ? AND source.source_index = ?
          AND source.physical_replay_key IS NOT NULL`)
      : null
    const aliases = database.prepare(LEGACY_ALIAS_SQL)
    const lastDurable = Number(database.prepare(hasGraph ? LEGACY_TAIL_SQL :
      "SELECT MAX(ordinal) AS last FROM thread_messages WHERE thread_id = $threadId")
      .get({ threadId: input.threadId })?.last ?? -1)
    const readPhysical = (identity: string) => `SELECT m.message_id, m.provider_source_id, m.provider_occurrence,
      m.ordinal, ${importField("source_turn_key")} AS source_turn_key,
      ${importField("partial_version")} AS partial_version, ${importOwnership} AS owned_by_migration,
      ${sourceDeclaration} AS source_declared_occurrence
      FROM thread_messages AS m ${importJoin}
      WHERE m.thread_id = ? AND m.role = ? AND ${identity} AND m.ordinal > ? AND m.ordinal < ?
        AND (? = 0 OR COALESCE(${sourceDeclaration}, m.provider_occurrence, 1) = ?
          OR (m.message_id = ? AND COALESCE(m.provider_occurrence, 1) = ?)
          OR (? = 1 AND ${importOwnership} IS NOT 1 AND ${sourceDeclaration} IS NULL
            AND COALESCE(m.provider_occurrence, 1) >= ?))
        AND (? IS NULL OR m.tool_call_id = ?)`
    const physical = database.prepare(`${readPhysical("m.provider_source_id = ?")} UNION ALL
      ${readPhysical("m.message_id = ? AND m.provider_source_id IS NULL")}
      LIMIT ${LEGACY_TRANSCRIPT_BATCH_LIMIT + 1}`)
    const check = () => throwIfCancelled(input.cancellation)
    type PhysicalRow = Record<string, SQLOutputValue>
    const identity = (row: PhysicalRow) => ({
      messageId: String(row.message_id), providerSourceId: row.provider_source_id as string | null,
      providerOccurrence: row.provider_occurrence as number | null
    })
    const provider = (message: DurableLegacyCheckpointMessage) => getMessageProviderSourceId({
      id: message.messageId, role: message.role, provider_source_id: message.providerSourceId ?? undefined
    })
    const bare = (message: DurableLegacyCheckpointMessage) => !message.shadowSlot &&
      !message.previousCopies?.length && !message.providerIdentityDeclared && message.stableSourceId
    const stableUser = (message: DurableLegacyCheckpointMessage) =>
      message.role === "user" && (message.stableSourceId || message.providerIdentityDeclared)
    const explicitOccurrence = (message: DurableLegacyCheckpointMessage) =>
      message.role !== "user" && message.providerIdentityDeclared && !message.previousCopies?.length
    const scopedOccurrence = (message: DurableLegacyCheckpointMessage) =>
      message.role !== "user" && (bare(message) || explicitOccurrence(message))
    const originalSlots = new Map(input.messages.flatMap((message, index) =>
      message.shadowSlot ? [] : [[message.messageId, index] as const]))
    const reservedIds = new Set(input.messages.filter((message) =>
      !message.shadowSlot && !bare(message) && !stableUser(message) && !explicitOccurrence(message))
      .map((message) => message.messageId))
    const claimedIds = new Set<string>()
    const lastOrdinal = Number.MAX_SAFE_INTEGER
    const turnCache = new Map<number, string>()
    const turnStarts = new Map<string, number>([["", -1]])
    const graphTurns = new Set(graphFences.map(({ turn, ordinal }) => {
      turnStarts.set(turn, ordinal)
      return turn
    }))
    const turnEnds = new Map<number, number>()
    const physicalTurn = (row: PhysicalRow) => {
      const ordinal = Number(row.ordinal)
      let turn = turnCache.get(ordinal)
      if (turn === undefined) {
        const user = precedingUser.get({ threadId: input.threadId, ordinal })
        turn = legacyPhysicalUserTurn(user)
        if (user) turnStarts.set(turn, Number(user.ordinal))
        turnCache.set(ordinal, turn)
      }
      return turn
    }
    const occurrenceCache = new Map<string, PhysicalRow[]>()
    const occurrences = (message: DurableLegacyCheckpointMessage, after = -1, before = lastOrdinal, includeNative = false) => {
      const source = provider(message)
      const declared = message.providerIdentityDeclared
        ? message.sourceDeclaredOccurrence ?? message.providerOccurrence ?? 1 : 0
      const claimId = declared ? message.sourceMessageId ?? null : null
      const callId = message.role === "tool" ? message.toolCallId : null
      const key = JSON.stringify([message.role, source, declared, claimId, callId, after, before, includeNative])
      let rows = occurrenceCache.get(key)
      if (!rows) {
        const scope: SQLInputValue[] = [input.threadId, message.role, source, after, before,
          declared, declared, claimId, declared, Number(includeNative), declared, callId, callId]
        rows = physical.all(...scope, ...scope)
        occurrenceCache.set(key, rows)
      }
      return rows
    }
    const inTurn = (message: DurableLegacyCheckpointMessage, after: number, before: number, turn?: string,
      includeNative = false) => {
      const start = turn === undefined ? undefined : turnStarts.get(turn)
      if (start !== undefined) {
        let end = turnEnds.get(start)
        if (end === undefined) {
          end = followingBoundary(start)
          turnEnds.set(start, end)
        }
        return occurrences(message, Math.max(after, start), Math.min(before, end), includeNative)
      }
      const rows = occurrences(message, after, before, includeNative)
      return turn === undefined || rows.length > LEGACY_TRANSCRIPT_BATCH_LIMIT
        ? rows : rows.filter((row) => physicalTurn(row) === turn)
    }
    const exactCandidates = (message: DurableLegacyCheckpointMessage, after: number, before: number,
      turn?: string, verifiedAfter = after) => {
      if (turn && graphTurns.has(turn)) return inTurn(message, after, before, turn)
      const rows = occurrences(message, after, before)
      if (turn === undefined || !turnStarts.has(turn)) return rows
      // A cross-turn witness must be unique across the entire authorized
      // interval, including turns the source omitted between exact anchors.
      const rivals = occurrences(message, verifiedAfter, before, message.providerIdentityDeclared === true)
      if (rivals.length <= 1) return rows
      return rows.filter((row) => physicalTurn(row) === turn ||
        (message.providerIdentityDeclared && message.sourceMessageId !== provider(message) &&
          message.sourceMessageId === row.message_id && message.sourceDeclaredOccurrence === row.provider_occurrence))
    }
    let verify: ReturnType<typeof createLegacyPayloadVerifier> | undefined
    const exactCache = new WeakMap<DurableLegacyCheckpointMessage, Map<string, boolean>>()
    const exact = (message: DurableLegacyCheckpointMessage, rows: readonly PhysicalRow[]) => {
      let match: PhysicalRow | undefined
      let inspected = exactCache.get(message)
      if (!inspected) exactCache.set(message, inspected = new Map())
      for (const row of rows) {
        check()
        if (row.partial_version != null) continue
        const bound = { ...message, ...identity(row) }
        let matches = inspected.get(bound.messageId)
        if (matches === undefined) {
          verify ??= createLegacyPayloadVerifier(database, input.threadId)
          matches = verify(bound, Number(row.ordinal), bound.contentFragments?.length ?? 0, check, false,
            bound.messageId, true)
          inspected.set(bound.messageId, matches)
        }
        if (!matches) continue
        if (match) return null
        match = row
      }
      return match
    }
    const uniqueExact = (message: DurableLegacyCheckpointMessage, turn?: string) => {
      const rows = inTurn(message, -1, lastOrdinal, turn)
      if (rows.length > LEGACY_TRANSCRIPT_BATCH_LIMIT) return null
      return exact(message, rows)
    }
    const exactDraft = (message: DurableLegacyCheckpointMessage, rows: readonly PhysicalRow[]) => {
      if (rows.length > LEGACY_TRANSCRIPT_BATCH_LIMIT) return null
      let match = exact(message, rows)
      for (const { payload } of message.previousCopies ?? []) {
        const earlier = exact(payload, rows)
        if (earlier && match && earlier !== match) return null
        if (earlier) match = earlier
      }
      return match
    }
    const directMatch = (message: DurableLegacyCheckpointMessage) => {
      const row = direct.get(input.threadId, message.messageId)
      return row?.role === message.role && matchesCheckpointProvider(row, message)
        ? row : readLegacyMemberAlias(aliases, input.threadId, message) || undefined
    }
    const directGraphUser = (message: DurableLegacyCheckpointMessage) => {
      if (!message.graphUserCommand || !message.stableSourceId) return undefined
      const row = direct.get(input.threadId, message.messageId)
      return row?.role === "user" && matchesCheckpointProvider(row, message) ? row : undefined
    }
    const firstUser = input.messages.findIndex((message) => message.role === "user" && !message.shadowSlot)
    const leadingCount = Math.min(firstUser < 0 ? input.messages.length : firstUser,
      graphFences[0]?.index ?? input.messages.length)
    const userAnchors = input.messages.map((message) => {
      check()
      if (!stableUser(message) || message.shadowSlot) return undefined
      const exact = uniqueExact(message)
      return exact === undefined ? directGraphUser(message) : exact ?? undefined
    })
    // Resolve an exact native alias with the same bounded witnesses before
    // either adjacent turn uses this user row as its boundary.
    let lowerUser = -1
    const earlierUsers = userAnchors.map((row) => {
      const earlier = lowerUser
      if (row) lowerUser = Number(row.ordinal)
      return earlier
    })
    let upperUser = lastOrdinal
    for (let index = input.messages.length - 1; index >= 0; index -= 1) {
      check()
      const message = input.messages[index]
      if (!stableUser(message) || message.shadowSlot) continue
      let row = userAnchors[index]
      if (!row && message.providerIdentityDeclared && upperUser !== lastOrdinal) {
        const candidates = occurrences(message, earlierUsers[index], upperUser, true)
        if (candidates.length <= LEGACY_TRANSCRIPT_BATCH_LIMIT) row = exact(message, candidates) ?? undefined
      }
      if (row) {
        userAnchors[index] = row
        upperUser = Number(row.ordinal)
      }
    }
    const turns = legacySourceTurns(input.messages.map((message, index) => {
      if (!stableUser(message) || message.shadowSlot) return message
      const anchor = userAnchors[index]
      if (anchor) {
        const bound = { ...message, ...identity(anchor) }
        turnStarts.set(legacyUserTurnKey(bound), Number(anchor.ordinal))
        return bound
      }
      return occurrences(message).length ? { ...message, inferredSourceTurn: null } : message
    }))
    let graphTurn: string | undefined
    for (const [index, message] of input.messages.entries()) {
      graphTurn = graphAt.get(index)?.at(-1)?.turn ?? graphTurn
      if (message.role === "user" && !message.shadowSlot) graphTurn = undefined
      if (graphTurn) turns[index] = graphTurn
    }
    const nextOrdinals = new Array<number>(input.messages.length)
    const anchors = new Array<PhysicalRow | undefined>(input.messages.length)
    const exactFences = new Set<number>()
    let next = graphAt.get(input.messages.length)?.[0].ordinal ?? lastOrdinal
    for (const { ordinal } of graphFences) exactFences.add(ordinal)
    for (let index = input.messages.length - 1; index >= 0; index -= 1) {
      check()
      nextOrdinals[index] = next
      const message = input.messages[index]
      const nextGraph = graphAt.get(index)?.[0]?.ordinal
      if (message.shadowSlot) {
        if (nextGraph !== undefined) next = nextGraph
        continue
      }
      const sourceTurn = index < leadingCount ? undefined : turns[index] ?? undefined
      const boundary = sourceTurn === undefined ? undefined : turnStarts.get(sourceTurn)
      let row: PhysicalRow | null | undefined
      if (stableUser(message)) row = userAnchors[index]
      else if (message.previousCopies?.length && message.providerIdentityDeclared) {
        let rows = exactCandidates(message, boundary ?? -1, next, sourceTurn)
        if (!rows.length && boundary !== undefined && message.role === "assistant")
          rows = inTurn(message, boundary, next, sourceTurn, true)
        row = exactDraft(message, rows)
      }
      else if (scopedOccurrence(message) || (index < leadingCount && (message.stableSourceId || message.providerIdentityDeclared))) {
        const rows = boundary === undefined && sourceTurn !== undefined
          ? inTurn(message, -1, next, sourceTurn) : exactCandidates(message, boundary ?? -1, next, sourceTurn)
        row = rows.length <= LEGACY_TRANSCRIPT_BATCH_LIMIT ? exact(message, rows) : null
      } else row = directMatch(message)
      if (!row) {
        if (nextGraph !== undefined) next = nextGraph
        continue
      }
      const earlierSlot = originalSlots.get(String(row.message_id))
      if (earlierSlot !== undefined && earlierSlot < index &&
          exact(input.messages[earlierSlot], [row])) {
        if (nextGraph !== undefined) next = nextGraph
        continue
      }
      anchors[index] = row
      next = Number(row.ordinal)
      if (exactDraft(message, [row])) exactFences.add(next)
      if (nextGraph !== undefined) next = nextGraph
    }

    let laterImplicitTurn = false
    let previous = -1
    let exactPrevious = -1
    let turn: string | null | undefined
    const canClaim = (message: DurableLegacyCheckpointMessage, row: PhysicalRow) => {
      const id = String(row.message_id)
      return !claimedIds.has(id) && (!reservedIds.has(id) || id === message.messageId)
    }
    const bind = (message: DurableLegacyCheckpointMessage, row: PhysicalRow) => {
      previous = Number(row.ordinal)
      return { ...message, ...identity(row) }
    }
    const inOrder = (row: PhysicalRow, before: number) =>
      Number(row.ordinal) > previous && Number(row.ordinal) < before
    const closesInsertion = (row: PhysicalRow, before: number) => inOrder(row, before) && exactFences.has(before) &&
      Number(intervalSize.get(input.threadId, row.ordinal, before)?.size) === 0
    const hasExactGap = (before: number) => previous >= 0 && previous === exactPrevious && exactFences.has(before) &&
      Number(intervalSize.get(input.threadId, previous, before)?.size) === 0
    const uncertain = (message: DurableLegacyCheckpointMessage, excludePlacement = false) => ({
      ...message, shadowSlot: message.shadowSlot || excludePlacement || !directMatch(message), inferredSourceTurn: null,
      sourceOccurrenceUncertain: true, revisionOrderConflict: true
    })
    const allocate = (message: DurableLegacyCheckpointMessage): DurableLegacyCheckpointMessage => {
      const source = provider(message)
      let occurrence = Math.max(1, (message.sourceDeclaredOccurrence ?? 1) - 1,
        Number(maximumOccurrence.get(input.threadId, message.role, source)?.value) || 0)
      let id: string
      do {
        occurrence += 1
        id = buildMessageSameRoleDuplicateId(source, message.role, occurrence)
      } while ((id !== message.messageId && originalSlots.has(id)) || claimedIds.has(id) ||
        direct.get(input.threadId, id))
      laterImplicitTurn = true
      return { ...message, messageId: id, providerSourceId: source, providerOccurrence: occurrence }
    }
    const closedAssignments = new Map<number, PhysicalRow>()
    const alignClosedRun = (message: DurableLegacyCheckpointMessage, index: number, before: number,
      candidates: PhysicalRow[], knownTurn: string) => {
      if (exactPrevious < 0 || previous !== exactPrevious || before === lastOrdinal ||
          Number(intervalSize.get(input.threadId, previous, before)?.size) !== candidates.length) return
      const end = index + candidates.length
      if (Number(anchors[end]?.ordinal) !== before) return
      const ordered = candidates.toSorted((a, b) => Number(a.ordinal) - Number(b.ordinal))
      for (const [offset, row] of ordered.entries()) {
        const source = input.messages[index + offset]
        if (!source || source.role !== message.role || !bare(source) || provider(source) !== provider(message) ||
            nextOrdinals[index + offset] !== before || !canClaim(source, row) ||
            row.owned_by_migration !== 1 || row.source_turn_key !== knownTurn) return
        const match = exact(source, ordered)
        if (match === null ? !exact(source, [row]) : match !== undefined && match !== row) return
      }
      ordered.forEach((row, offset) => closedAssignments.set(index + offset, row))
    }
    const resolve = (message: DurableLegacyCheckpointMessage, index: number): DurableLegacyCheckpointMessage => {
      if (message.shadowSlot) return message
      if (message.sourceOccurrenceUncertain) return uncertain(message)
      const before = nextOrdinals[index]
      const leading = index < leadingCount
      const anchor = anchors[index]
      const foundAlias = readPublishedAlias?.get(input.threadId, published as string, message.messageId, index)
      if (foundAlias) {
        const row = foundAlias
        if (typeof row.message_id !== "string" || row.role !== message.role || !matchesCheckpointProvider(row, message) ||
            !canClaim(message, row) || !inOrder(row, before) ||
            (activeSlot && index === Number(marker?.next_index) && row.ordinal !== activeSlot.ordinal))
          throw searchBootstrapNeedsForeground()
        previous = Number(row.ordinal)
        if (row.message_id !== message.messageId) claimedIds.add(row.message_id)
        return { ...message, inferredSourceTurn: physicalTurn(row), physicalOccurrenceBound: true }
      }
      if (activeSlot && index === Number(marker?.next_index)) {
        const row = direct.get(input.threadId, activeId ?? message.messageId) ||
          readLegacyMemberAlias(aliases, input.threadId, message)
        if (row && row.role === message.role && row.ordinal === activeSlot.ordinal &&
            matchesCheckpointProvider(row, message) && canClaim(message, row) && inOrder(row, before)) {
          return { ...bind(message, row), inferredSourceTurn: physicalTurn(row), physicalOccurrenceBound: true }
        }
      }
      if (stableUser(message)) {
        let candidates = occurrences(message, previous, before)
        if (!candidates.length && message.providerIdentityDeclared &&
            (exactPrevious === previous && previous >= 0 || exactFences.has(before)))
          candidates = occurrences(message, previous, before, true)
        let user = candidates.length <= LEGACY_TRANSCRIPT_BATCH_LIMIT ? exact(message, candidates) : null
        const graphUser = directGraphUser(message)
        if (user === undefined && graphUser && inOrder(graphUser, before)) user = graphUser
        if (!candidates.length && !occurrences(message).length) {
          const occupied = message.providerIdentityDeclared && direct.get(input.threadId, message.messageId)
          const newUser = occupied && occupied.role === message.role ? allocate(message) : message
          turn = legacyUserTurnKey(newUser)
          const closesTurn = occupied && occupied.role === "user" && inOrder(occupied, before) && exactFences.has(before) &&
            followingBoundary(occupied.ordinal) === before
          return hasExactGap(before) || (newUser !== message && closesTurn)
            ? { ...newUser, exactInsertionFence: before } : newUser
        }
        if (!user || !canClaim(message, user)) {
          const closedGap = previous >= 0 && previous === exactPrevious && exactFences.has(before) &&
            Number(intervalSize.get(input.threadId, previous, before)?.size) === 0
          if (candidates.length === 0 && followsPublishedTail &&
              (closedGap || (previous >= 0 && previous === lastDurable && before === lastOrdinal))) {
            const newUser = allocate(message)
            turn = legacyUserTurnKey(newUser)
            return newUser
          }
          turn = null
          return uncertain(message)
        }
        const bound = bind(message, user)
        exactPrevious = previous
        turn = legacyUserTurnKey(bound)
        turnStarts.set(turn, Number(user.ordinal))
        return { ...bound, inferredSourceTurn: turn }
      }

      if (!scopedOccurrence(message)) {
        if (turn === null && message.providerIdentityDeclared && message.role !== "user")
          return uncertain(message)
        if (message.role !== "user" && message.providerIdentityDeclared && message.previousCopies?.length) {
          const physicalScope = turn != null && turnStarts.has(turn) ? turn : undefined
          let competing = exactCandidates(message, previous, before, physicalScope, exactPrevious)
          if (!competing.length && physicalScope !== undefined) {
            competing = inTurn(message, previous, before, physicalScope, true)
          }
          const witness = exactDraft(message, competing)
          if (witness === null || (!witness && competing.length > 1) ||
              (!witness && physicalScope !== undefined && !competing.length && directMatch(message)))
            return uncertain(message, physicalScope !== undefined)
          const row = witness ?? competing[0]
          if (row) {
            if (!canClaim(message, row)) return uncertain(message)
            const later = followingBoundary(row.ordinal)
            if (later < before && !exact(message, [row])) return uncertain(message)
            const durableTurn = physicalTurn(row)
            if (!witness && physicalScope !== undefined && physicalScope !== durableTurn) return uncertain(message)
            const bound = bind(message, row)
            if (witness) {
              exactPrevious = previous
              if (leading || physicalScope !== undefined) turn = durableTurn
            }
            return { ...bound, inferredSourceTurn: durableTurn,
              physicalOccurrenceBound: row.owned_by_migration !== 1 || row.source_turn_key === durableTurn }
          }
        }
        if (message.role === "user") {
          turn = message.stableSourceId || message.providerIdentityDeclared ? legacyUserTurnKey(message) : null
          if (turn && anchor && inOrder(anchor, before)) turnStarts.set(turn, Number(anchor.ordinal))
        } else if (leading && anchor && inOrder(anchor, before)) {
          turn = physicalTurn(anchor)
        }
        const atTurn = leading ? { ...message, inferredSourceTurn: turn } : message
        if (!anchor) return atTurn
        const ordered = inOrder(anchor, before)
        previous = Math.max(previous, Number(anchor.ordinal))
        if (ordered && exact(message, [anchor])) exactPrevious = previous
        return ordered ? atTurn : { ...atTurn, revisionOrderConflict: true }
      }

      const assigned = closedAssignments.get(index)
      if (assigned) return { ...bind(message, assigned), inferredSourceTurn: turn, physicalOccurrenceBound: true }
      let candidates = inTurn(message, previous, before, turn ?? undefined)
      const prospectiveTurn = turn != null && !turnStarts.has(turn) && before !== lastOrdinal
      const physicalScope = turn != null && turnStarts.has(turn)
      let possibleExact = leading || physicalScope
        ? exactCandidates(message, previous, before, physicalScope ? turn ?? undefined : undefined, exactPrevious) : candidates
      if (prospectiveTurn)
        possibleExact = occurrences(message, previous, before).filter((row) => physicalTurn(row) === "")
      if (!leading && physicalScope && !candidates.length && message.providerIdentityDeclared) {
        candidates = inTurn(message, previous, before, turn ?? undefined, true)
        possibleExact = [...new Map([...possibleExact, ...candidates].map((row) => [row.message_id, row])).values()]
      }
      if (possibleExact.length > LEGACY_TRANSCRIPT_BATCH_LIMIT) {
        if (leading) turn = null
        return uncertain(message)
      }
      const matching = exact(message, possibleExact)
      if (matching == null && candidates.length > 1 && turn != null)
        alignClosedRun(message, index, before, candidates, turn)
      const first = closedAssignments.get(index)
      if (first) return { ...bind(message, first), inferredSourceTurn: turn, physicalOccurrenceBound: true }
      if (matching === null || (matching && !canClaim(message, matching))) {
        if (leading) turn = null
        return uncertain(message)
      }
      if (matching) {
        if (leading || physicalScope) turn = physicalTurn(matching)
        const bound = bind(message, matching)
        exactPrevious = previous
        return { ...bound, inferredSourceTurn: turn,
          physicalOccurrenceBound: matching.owned_by_migration !== 1 || (turn != null && matching.source_turn_key === turn) }
      }
      if (turn === null) return uncertain(message)
      const sole = candidates.length === 1 ? candidates[0] : undefined
      if (sole?.partial_version != null && sole.message_id === activeId && canClaim(message, sole)) {
        const bound = bind(message, sole)
        return { ...bound, inferredSourceTurn: physicalTurn(sole), physicalOccurrenceBound: true }
      }
      const laterUser = sole
        ? followingBoundary(sole.ordinal) < before : false
      if (turn === undefined) {
        if (candidates.length > 1 || (sole && (laterUser ||
            (sole.owned_by_migration === 1 && !explicitOccurrence(message) && physicalTurn(sole) !== "")))) {
          turn = null
          return uncertain(message)
        }
        if (sole) turn = physicalTurn(sole)
      }
      if (candidates.length > 1) return uncertain(message)
      if (sole) {
        const native = sole.owned_by_migration !== 1
        if (laterUser || !canClaim(message, sole) || (native ? physicalTurn(sole) !== turn : sole.source_turn_key !== turn))
          return uncertain(message)
        return { ...bind(message, sole), inferredSourceTurn: turn, physicalOccurrenceBound: true }
      }
      const allowedLaterRivals = leading && followsPublishedTail ? 1 : 0
      if (physicalScope) {
        const rivals = turn && graphTurns.has(turn)
          ? inTurn(message, exactPrevious, before, turn, message.providerIdentityDeclared === true)
          : occurrences(message, exactPrevious, before, message.providerIdentityDeclared === true)
        if (rivals.length > allowedLaterRivals) return uncertain(message, true)
      }

      let occupied = directMatch(message)
      if (!occupied && explicitOccurrence(message)) {
        const raw = direct.get(input.threadId, message.messageId)
        if (raw?.role === message.role) occupied = raw
      }
      if (!occupied) return message
      const claim = readClaim.get(input.threadId, occupied.message_id)
      const distinctCall = message.role === "tool" && message.toolCallId !== null &&
        typeof claim?.tool_call_id === "string" && claim.tool_call_id !== message.toolCallId
      const declared = claim?.source_declared_occurrence ?? claim?.provider_occurrence ?? 1
      const distinctDeclaration = message.sourceDeclaredOccurrence !== undefined &&
        message.sourceDeclaredOccurrence !== declared
      const exactAppend = before === lastOrdinal && exactPrevious >= 0 && exactPrevious === lastDurable
      const exactInterior = hasExactGap(before) || closesInsertion(occupied, before)
      if (turn && graphTurns.has(turn) && distinctDeclaration && Number(occupied.ordinal) < turnStarts.get(turn)! &&
          (message.sourceDeclaredOccurrence ?? 0) > 1) {
        const occurrence = message.sourceDeclaredOccurrence!
        const source = provider(message)
        const id = buildMessageSameRoleDuplicateId(source, message.role, occurrence)
        if (!direct.get(input.threadId, id) && !claimedIds.has(id) && !originalSlots.has(id))
          return { ...message, messageId: id, providerSourceId: source, providerOccurrence: occurrence, inferredSourceTurn: turn }
      }
      const declaredAppend = turn != null && distinctDeclaration &&
        (exactAppend || exactInterior || (followsPublishedTail && message.sourceMessageId !== occupied.message_id))
      if (declaredAppend || (distinctCall && (followsPublishedTail || exactAppend || exactInterior)))
        return { ...allocate(message), inferredSourceTurn: turn, exactInsertionFence: exactInterior ? before : undefined }
      if (!completedAncestor && !hasReceipt?.get(input.threadId, occupied.message_id)) {
        if (turn !== undefined && (turn !== physicalTurn(occupied) || !inOrder(occupied, before))) return uncertain(message, true)
        return message
      }
      const occupiedTurn = physicalTurn(occupied)
      if (occupiedTurn === turn) {
        if (before !== lastOrdinal || previous < 0 || previous !== lastDurable) return message
      } else if (!turn || inTurn(message, -1, lastOrdinal, turn).length) {
        return message
      }
      return { ...allocate(message), inferredSourceTurn: turn }
    }
    const messages = input.messages.map((message, index) => {
      check()
      const fence = graphAt.get(index)?.at(-1)
      if (fence) {
        if (fence.ordinal <= previous) throw searchBootstrapNeedsForeground()
        previous = exactPrevious = fence.ordinal
        turn = fence.turn
      }
      const resolved = resolve(message, index)
      if (resolved.shadowSlot) return resolved
      if (claimedIds.has(resolved.messageId)) throw searchBootstrapNeedsForeground()
      claimedIds.add(resolved.messageId)
      return index < leadingCount && resolved.inferredSourceTurn === undefined
        ? { ...resolved, inferredSourceTurn: turn ?? null } : resolved
    })
    return { ...input, messages, laterImplicitTurn, occurrenceSnapshot, publishedAncestor, pendingScopedPrefix }
  } finally {
    if (database.isTransaction) database.exec("ROLLBACK")
    database.close()
  }
}

function keepPublishedShadowSlots(input: LegacyTranscriptCopyInput): LegacyTranscriptCopyInput {
  if (!existsSync(input.databasePath)) return input
  const reader = new DatabaseSync(input.databasePath, { readOnly: true, timeout: input.searchGuard ? 100 : 5_000 })
  try {
    const columns = reader.prepare("PRAGMA table_info(legacy_checkpoint_transcript_migrations)").all()
    if (!columns.some((column) => column.name === "shadow_slots")) return input
    const active = columns.some((column) => column.name === "active_fragment_revision")
      ? "active_fragment_revision" : "NULL AS active_fragment_revision"
    const state = reader.prepare(`SELECT total_messages, shadow_slots, source_layout_key, next_index, ${active}
      FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?`).get(input.threadId)
    const descriptors = parseJsonValue(state?.shadow_slots)
    if (!Array.isArray(descriptors) || !descriptors.length || typeof state?.source_layout_key !== "string") return input
    const count = Number(state.total_messages)
    if (!Number.isSafeInteger(count) || count <= descriptors.length || count > input.messages.length + descriptors.length)
      return input
    const check = () => throwIfCancelled(input.cancellation)
    const matches = (messages: readonly DurableLegacyCheckpointMessage[]) => {
      if (messages.length < count) return false
      const keys = Array.from({ length: count }, (_, index) => {
        check()
        return legacyLayoutSlotKey(messages[index])
      })
      if (legacyPrefixDigest(keys, count, check) === state.source_layout_key) return true
      const published = parseJsonValue(state.active_fragment_revision)
      return Array.isArray(published) && typeof published[6] === "string" &&
        legacyActiveLayoutDigest(messages, keys, count, Number(state.next_index), check) === published[6]
    }
    if (matches(input.messages)) return input
    const real = input.messages.filter((message) => !message.shadowSlot)
    if (real.length < count - descriptors.length) return input
    const byIdentity = new Map(real.map((message) => [legacyCheckpointProviderIdentity(message), message]))
    const slots = new Map<number, DurableLegacyCheckpointMessage>()
    for (const descriptor of descriptors) {
      check()
      if (!Array.isArray(descriptor) || !Number.isInteger(descriptor[0]) || descriptor[0] < 0 ||
          descriptor[0] >= count || typeof descriptor[1] !== "string" || slots.has(descriptor[0])) return input
      const owner = byIdentity.get(descriptor[1])
      if (!owner) return input
      slots.set(descriptor[0], { ...owner, shadowSlot: true, previousCopies: undefined })
    }
    const restored: DurableLegacyCheckpointMessage[] = []
    let next = 0
    for (let index = 0; index < count; index += 1) restored.push(slots.get(index) ?? real[next++])
    if (!matches(restored)) return input
    // The old holes are part of the published copy cursor. They can be
    // retained when removing them did not change any real source slot.
    const lastOwned = real[next - 1]
    const remaining = input.messages.slice(input.messages.lastIndexOf(lastOwned) + 1)
    restored.push(...remaining)
    return { ...input, messages: restored }
  } finally {
    reader.close()
  }
}

interface LegacyOverlapAudit {
  proof(message: LegacyOverlapPayload, fragments: readonly string[], rawSlot?: number): LegacyOverlapProof | null
  covers(message: LegacyOverlapPayload, fragments: readonly string[], proof: LegacyOverlapProof, rawSlot?: number): boolean
  coversStored(messageId: string, revision: LegacyStreamRevision, proof: LegacyOverlapProof,
    repair?: LegacyStreamRepair): boolean
  recoverStream(message: DurableLegacyCheckpointMessage, revision: LegacyStreamRevision,
    hasAuthority: boolean): LegacyStreamEvidence | null
  reviseOccurrence(index: number, revision: LegacyStreamRevision, hasAuthority: boolean): LegacyOccurrenceRevision | null
  verifiesCopy(message: DurableLegacyCheckpointMessage, revision: LegacyStreamRevision, ordinal: number | null,
    fragments: number, allowLegacyReasoning: boolean, allowNativeDefaults: boolean, bodyOnly: boolean): boolean | null
  placement(base: number, previousCount: number, total: number, gap: readonly LegacySourceOrdinalGap[], epoch: number, tail: number,
    journal: LegacyAppendJournal | null, getVersion: (id: string) => number): LegacyAppendPlacement | null
  progress(state: Record<string, unknown>, count: number, rebinding: boolean, offerRestart: boolean, epoch: number, tail: number,
    getVersion: (id: string) => number, verifyPublishedPrefix?: boolean): LegacyCopyProgress | null
  initialLayout(options: LegacyInitialOptions, state: Record<string, unknown> | undefined, epoch: number,
    tail: number, getVersion: (id: string) => number): LegacyInitialLayout | null
  flushRepairs(repairs: ReadonlyMap<string, LegacyStreamRepair>, schema: LegacyStreamSchema): never
  retryAfterDurableChange(): never
  assertPrepared(): void
}

const LEGACY_STREAM_BODY = 1
const LEGACY_STREAM_REASONING = 2
const LEGACY_STREAM_TOOLS = 4

interface LegacyStreamSchema {
  hasStreamAuthority: boolean
  hasRecoveryIntegrity: boolean
}

interface LegacyStreamRevision {
  version: number
  epoch: number
}

interface LegacyFragmentRewrite {
  version: number
  contentKey: string
  generation: string
  nextIndex: number
  totalChars: number
}

interface LegacyStreamRepair {
  message: DurableLegacyCheckpointMessage
  fields: number
  revision: LegacyStreamRevision
  writeBytes: number
  append?: { offset: number; rebaseHead?: string }
  replacementContentKey?: string
  expectedImportKey?: string
  expectedImportId?: string
  expectedPublishedCheckpoint?: string
  expectedMergedCheckpoints?: string | null
  replacementProviderKey?: string
  replacementPayloadKey?: string
  replacementFieldKeys?: string
  nativePublication?: {
    previousCheckpoint: unknown; mergedCheckpoints: unknown; contentKey: string; providerKey: string; turnKey: string
  }
  rewrite?: { resume: LegacyFragmentRewrite | null }
}

type LegacyStreamRelation = "equal" | "durable-extends" | "checkpoint-extends" | "different"

interface LegacyStreamRelations {
  body: LegacyStreamRelation
  reasoning: "equal" | "missing" | "different"
  tools: LegacyStreamRelation
  rowBytes: number
  fragmentBytes: number
  newFragmentBytes: number
  append?: LegacyStreamRepair["append"]
}

interface LegacyStreamEvidence {
  relations: LegacyStreamRelations
  authority: number
}

interface LegacyOccurrenceRevision {
  repair?: LegacyStreamRepair
  retained: boolean
  previousContentKey?: string
  physicalImport?: { id: string; key: string }
}

function compareLegacyStreamValues(durable: unknown, checkpoint: unknown): LegacyStreamRelation {
  if (isCompletedRouteValuePrefix(durable, checkpoint))
    return durable === checkpoint || JSON.stringify(durable) === JSON.stringify(checkpoint)
      ? "equal" : "durable-extends"
  return isCompletedRouteValuePrefix(checkpoint, durable) ? "checkpoint-extends" : "different"
}

function createLegacyBodyFragmentsReader(database: DatabaseSync, threadId: string,
  generation = publishedThreadMessageFragmentsSql("f")) {
  const fragments = database.prepare(`SELECT CASE WHEN octet_length(content_text) <= ?
    THEN content_text END AS content_text FROM thread_message_fragments AS f
    WHERE f.thread_id = ? AND f.message_id = ? AND ${generation} ORDER BY f.fragment_id`)
  return (messageId: string, head: string, maxBytes: number, check: () => void) => {
    const parts: string[] = []
    let bytes = Buffer.byteLength(head)
    for (const { content_text: text } of fragments.iterate(maxBytes, threadId, messageId)) {
      check()
      if (typeof text !== "string") return null
      bytes += Buffer.byteLength(text)
      if (bytes > maxBytes) return null
      parts.push(text)
    }
    return parts
  }
}

function createLegacyStreamReader(database: DatabaseSync, threadId: string, check: () => void) {
  const read = database.prepare(`SELECT
    CASE WHEN octet_length(content_json) <= ? THEN content_json END AS content_json,
    octet_length(content_json) AS body_bytes,
    CASE WHEN octet_length(reasoning) <= ${TRANSCRIPT_REASONING_MAX_CHARS * 4} THEN reasoning END AS reasoning,
    octet_length(reasoning) AS reasoning_bytes,
    CASE WHEN octet_length(tool_calls_json) <= ? THEN tool_calls_json END AS tool_calls_json,
    octet_length(tool_calls_json) AS tool_bytes
    FROM thread_messages WHERE thread_id = ? AND message_id = ?`)
  const readFragments = createLegacyBodyFragmentsReader(database, threadId)
  return (message: DurableLegacyCheckpointMessage) => {
    const maxBytes = Math.max(LEGACY_TRANSCRIPT_STRUCTURED_PROJECTION_BYTES,
      4 * Math.max(message.contentJson.length +
        (message.contentFragments ?? []).reduce((sum, fragment) => sum + fragment.length, 0),
      message.toolCallsJson?.length ?? 0))
    const current = read.get(maxBytes, message.toolCallsJson ? maxBytes : 0, threadId, message.messageId)
    if (!current || typeof current.content_json !== "string") return null
    const head = parseJsonValue(current.content_json)
    if (head === undefined) return null
    const parts = typeof head === "string" ? readFragments(message.messageId, head, maxBytes, check) : []
    return parts && {
      body: typeof head === "string" ? head + parts.join("") : head,
      rowBytes: Number(current.body_bytes) + Number(current.tool_bytes) + Number(current.reasoning_bytes),
      fragmentBytes: parts.reduce((bytes, part) => bytes + Buffer.byteLength(part), 0),
      fragmentChars: parts.reduce((chars, part) => chars + part.length, 0),
      reasoning: typeof current.reasoning === "string" ? current.reasoning : undefined,
      reasoningOversized: Number(current.reasoning_bytes) > TRANSCRIPT_REASONING_MAX_CHARS * 4,
      tools: typeof current.tool_calls_json === "string" ? current.tool_calls_json : null,
      toolsOversized: !!message.toolCallsJson && Number(current.tool_bytes) > maxBytes
    }
  }
}

function compareLegacyStream(
  message: DurableLegacyCheckpointMessage,
  durable: ReturnType<ReturnType<typeof createLegacyStreamReader>>
): LegacyStreamRelations {
  const head = parseJsonValue(message.contentJson)
  const checkpoint = typeof head === "string" ? head + (message.contentFragments ?? []).join("") : head
  const body = durable ? compareLegacyStreamValues(durable.body, checkpoint) : "different"
  if (body === "different" || !durable)
    return { body, reasoning: "equal", tools: "equal", rowBytes: 0, fragmentBytes: 0, newFragmentBytes: 0 }
  const savedReasoning = normalizeVisibleReasoningText(message.reasoning ?? undefined)
  const storedReasoning = normalizeVisibleReasoningText(durable.reasoning)
  const reasoning = durable.reasoningOversized || savedReasoning !== storedReasoning
    ? savedReasoning && !storedReasoning && !durable.reasoningOversized ? "missing" : "different"
    : "equal"
  const tools = message.toolCallsJson
    ? durable.toolsOversized ? "different"
      : compareLegacyStreamValues(durable.tools ? parseJsonValue(durable.tools) : [], parseJsonValue(message.toolCallsJson))
    : "equal"
  const newFragmentBytes = (message.contentFragments ?? []).reduce((bytes, part) => bytes + Buffer.byteLength(part), 0)
  let append: LegacyStreamRepair["append"]
  if (body === "checkpoint-extends" && typeof durable.body === "string" && typeof checkpoint === "string") {
    const offset = durable.body.length
    // The JSON head can hold half a code point during streaming. Store the
    // complete code point together in a SQLite text fragment.
    const splitCodePoint = durable.fragmentChars === 0 && /[\uD800-\uDBFF]/.test(checkpoint.charAt(offset - 1)) &&
      /[\uDC00-\uDFFF]/.test(checkpoint.charAt(offset))
    append = splitCodePoint
      ? { offset: offset - 1, rebaseHead: JSON.stringify(durable.body.slice(0, -1)) }
      : { offset }
  }
  return { body, reasoning, tools, rowBytes: durable.rowBytes, fragmentBytes: durable.fragmentBytes,
    newFragmentBytes, append }
}

function createStoredLegacyOverlapReader(database: DatabaseSync, threadId: string, check: () => void) {
  const maxBytes = LEGACY_TRANSCRIPT_STRUCTURED_PROJECTION_BYTES
  const read = database.prepare(`SELECT role, provider_source_id, provider_occurrence,
    CASE WHEN octet_length(content_json) <= ? THEN content_json END AS content_json,
    CASE WHEN octet_length(tool_calls_json) <= ? THEN tool_calls_json END AS tool_calls_json,
    octet_length(tool_calls_json) AS tool_bytes,
    CASE WHEN octet_length(reasoning) <= ? THEN reasoning END AS reasoning,
    octet_length(reasoning) AS reasoning_bytes
    FROM thread_messages WHERE thread_id = ? AND message_id = ?`)
  const readFragments = createLegacyBodyFragmentsReader(database, threadId)
  return (messageId: string, repair?: LegacyStreamRepair) => {
    const current = read.get(maxBytes, maxBytes, maxBytes, threadId, messageId)
    if (!current || typeof current.role !== "string") return null
    const fields = repair?.fields ?? 0
    const replacesBody = (fields & LEGACY_STREAM_BODY) !== 0
    const replacesTools = (fields & LEGACY_STREAM_TOOLS) !== 0
    const replacesReasoning = (fields & LEGACY_STREAM_REASONING) !== 0
    const contentJson = replacesBody ? repair?.message.contentJson : current.content_json
    const tools = replacesTools ? repair?.message.toolCallsJson : current.tool_calls_json
    const reasoning = replacesReasoning ? repair?.message.reasoning : current.reasoning
    if (typeof contentJson !== "string" || Buffer.byteLength(contentJson) > maxBytes ||
        (!replacesTools && Number(current.tool_bytes) > maxBytes) ||
        (!replacesReasoning && Number(current.reasoning_bytes) > maxBytes) ||
        (typeof tools === "string" && Buffer.byteLength(tools) > maxBytes) ||
        (typeof reasoning === "string" && Buffer.byteLength(reasoning) > maxBytes)) return null
    const parts = typeof parseJsonValue(contentJson) !== "string" ? []
      : replacesBody ? repair?.message.contentFragments ?? []
        : readFragments(messageId, contentJson, maxBytes, check)
    if (!parts || (replacesBody && parts.reduce((bytes, part) => bytes + Buffer.byteLength(part),
      Buffer.byteLength(contentJson)) > maxBytes)) return null
    const payload: LegacyOverlapPayload = {
      messageId, role: current.role, contentJson,
      providerSourceId: typeof current.provider_source_id === "string" ? current.provider_source_id : null,
      providerOccurrence: typeof current.provider_occurrence === "number" ? current.provider_occurrence : null,
      toolCallsJson: typeof tools === "string" ? tools : null,
      reasoning: typeof reasoning === "string" ? reasoning : null
    }
    return { payload, parts }
  }
}

function createLegacyStreamAuthorityReader(database: DatabaseSync, hasStreamAuthority: boolean) {
  return database.prepare(`SELECT message_id, role, provider_source_id, provider_occurrence, end_at,
    ${hasStreamAuthority ? "stream_authority" : "0"} AS authority
    FROM thread_messages WHERE thread_id = ? AND message_id = ?`)
}

function currentLegacyStreamAuthority(row: Record<string, unknown>): number {
  return Number(row.authority) | (row.end_at === null ? 0 : LEGACY_STREAM_BODY)
}

function readStoredLegacyImportKey(database: DatabaseSync, threadId: string,
  source: DurableLegacyCheckpointMessage, check: () => void) {
  const row = database.prepare(`SELECT message_id, role, provider_source_id, provider_occurrence,
    content_json, reasoning, tool_calls_json, tool_call_id, name, status, is_error
    FROM thread_messages WHERE thread_id = ? AND message_id = ?
      AND octet_length(content_json) + COALESCE(octet_length(reasoning), 0) +
        COALESCE(octet_length(tool_calls_json), 0) <= ?`)
    .get(threadId, source.messageId, LEGACY_TRANSCRIPT_BATCH_BYTE_BUDGET +
      LEGACY_TRANSCRIPT_STRUCTURED_PROJECTION_BYTES + TRANSCRIPT_REASONING_MAX_CHARS * 4)
  if (row?.role !== source.role || typeof row.content_json !== "string" || !matchesCheckpointProvider(row, source))
    return null
  const stored = {
    ...source,
    providerSourceId: row.provider_source_id as string | null,
    providerOccurrence: row.provider_occurrence as number | null,
    contentJson: row.content_json, reasoning: row.reasoning as string | null,
    toolCallsJson: row.tool_calls_json as string | null, toolCallId: row.tool_call_id as string | null,
    name: row.name as string | null, status: row.status as string | null, isError: row.is_error as number | null
  }
  const hash = beginLegacyCheckpointContentHash(stored)
  const normalized = beginLegacyCheckpointContentHash({
    ...stored, messageId: legacyCheckpointProviderIdentity(stored), providerSourceId: null, providerOccurrence: null
  })
  const payload = beginLegacyCheckpointContentHash({ ...stored, messageId: "", providerSourceId: null,
    providerOccurrence: null, toolCallsJson: stored.toolCallsJson === "[]" ? null : stored.toolCallsJson })
  const fields = legacyFieldContentHasher(stored)
  const rowBytes = Buffer.byteLength(stored.contentJson) + Buffer.byteLength(stored.reasoning ?? "") +
    Buffer.byteLength(stored.toolCallsJson ?? "") + 1024
  let fragmentBytes = 0
  const fragments = database.prepare(`SELECT CASE WHEN octet_length(content_text) <= ? THEN content_text END AS content_text
    FROM thread_message_fragments AS f WHERE f.thread_id = ? AND f.message_id = ?
      AND ${publishedThreadMessageFragmentsSql("f")} ORDER BY f.fragment_id`)
  for (const { content_text: fragment } of fragments.iterate(LEGACY_WRITER_BATCH_BYTES, threadId, source.messageId)) {
    check()
    if (typeof fragment !== "string") return null
    fragmentBytes += Buffer.byteLength(fragment) + 256
    const raw = JSON.stringify(fragment)
    hash.update(raw)
    normalized.update(raw)
    payload.update(raw)
    fields.add(fragment)
  }
  return { key: hash.digest("hex"), providerKey: normalized.digest("hex"), payloadKey: payload.digest("hex"),
    fieldKeys: fields.finish(), rowBytes, fragmentBytes }
}

function serializeActiveFragmentCursor(cursor: readonly unknown[], contentKey: unknown,
  layoutKey: unknown, stage: unknown): string {
  return JSON.stringify([...cursor.slice(0, 5), contentKey, layoutKey, stage, ...cursor.slice(8)])
}

function readLegacyFragmentRewrite(value: unknown): LegacyFragmentRewrite | null {
  const progress = (typeof value === "string" ? parseJsonValue(value) : value) as LegacyFragmentRewrite | null | undefined
  return progress && Number.isSafeInteger(progress.version) && typeof progress.contentKey === "string" &&
    typeof progress.generation === "string" && progress.generation.length > 0 &&
    Number.isSafeInteger(progress.nextIndex) && progress.nextIndex >= 0 &&
    Number.isSafeInteger(progress.totalChars) && progress.totalChars >= 0 ? progress : null
}

function inspectLegacyOccurrenceRevision(database: DatabaseSync, threadId: string,
  message: DurableLegacyCheckpointMessage, earlier: readonly string[],
  revision: LegacyStreamRevision, hasAuthority: boolean, turnKey: string | null,
  inheritsPublication: (checkpointId: string) => boolean, check: () => void
): LegacyOccurrenceRevision {
  const direct = database.prepare(`SELECT message_id, role, provider_source_id, provider_occurrence, tool_call_id
    FROM thread_messages WHERE thread_id = ? AND message_id = ?`).get(threadId, message.messageId)
  const row = direct ?? readLegacyMemberAlias(database.prepare(LEGACY_ALIAS_SQL), threadId, message)
  if (!row || row.role !== message.role || !matchesCheckpointProvider(row, message)) return { retained: false }
  const physicalId = String(row.message_id)
  const physical = {
    ...message, messageId: physicalId,
    providerSourceId: row.provider_source_id as string | null, providerOccurrence: row.provider_occurrence as number | null
  }
  const projected = legacyMessageContentKeys(physical)
  const readImport = database.prepare(`SELECT content_key, previous_content_key, provider_content_key,
    rewrite_progress, source_turn_key, partial_version, published_checkpoint_id, merged_checkpoint_ids, field_content_keys
    FROM legacy_checkpoint_transcript_imports WHERE thread_id = ? AND message_id = ? AND owned_by_migration = 1`)
  let importId = physicalId
  let published = readImport.get(threadId, importId)
  const originalId = message.sourceMessageId ?? message.messageId
  if (!published && physicalId !== originalId && !database.prepare(`SELECT 1 FROM thread_messages
    WHERE thread_id = ? AND message_id = ?`).get(threadId, originalId)) {
    importId = originalId
    published = readImport.get(threadId, originalId)
  }
  const expectedImportKey = published?.content_key
  if (typeof expectedImportKey !== "string") return { retained: false }
  if (message.revisionOrderConflict || !message.physicalOccurrenceBound ||
      (message.role === "tool" && direct?.tool_call_id !== message.toolCallId)) return { retained: true }
  if (turnKey && typeof published?.source_turn_key === "string" && published.source_turn_key &&
      turnKey !== published.source_turn_key) return { retained: true }
  if (turnKey === null || turnKey !== published?.source_turn_key) return { retained: true }
  const partialVersion = typeof published?.partial_version === "number" ? published.partial_version : null
  if (expectedImportKey === projected.raw && !published?.rewrite_progress && partialVersion === null) return { retained: false,
    physicalImport: { id: physicalId, key: projected.raw },
    previousContentKey: typeof published?.previous_content_key === "string" ? published.previous_content_key : undefined }
  const authority = createLegacyStreamAuthorityReader(database, hasAuthority).get(threadId, physicalId)
  if (!authority || authority.role !== physical.role || !matchesCheckpointProvider(authority, physical))
    return { retained: true }
  const physicalRevision = physicalId === message.messageId ? revision : {
    epoch: revision.epoch, version: Number(database.prepare(LEGACY_VERSION_SQL).get(threadId, physicalId)?.version ?? 0)
  }
  const resume = readLegacyFragmentRewrite(published?.rewrite_progress)
  const retained = { retained: true, previousContentKey:
    typeof published?.previous_content_key === "string" ? published.previous_content_key : expectedImportKey }
  const verify = createLegacyPayloadVerifier(database, threadId)
  const publishedCheckpoint = published?.published_checkpoint_id
  const mergedCheckpoints = typeof published?.merged_checkpoint_ids === "string" ? published.merged_checkpoint_ids : null
  const authorized = typeof publishedCheckpoint === "string" &&
    legacyPublicationSources(publishedCheckpoint, mergedCheckpoints).every(inheritsPublication)
  const publication = { message: physical, revision: physicalRevision, expectedImportKey, expectedImportId: importId,
    expectedPublishedCheckpoint: typeof publishedCheckpoint === "string" ? publishedCheckpoint : undefined,
    expectedMergedCheckpoints: mergedCheckpoints }
  if (!resume && partialVersion === null && verify(physical, null, physical.contentFragments?.length ?? 0,
    check, false, physicalId, true)) {
    if (!authorized) return { retained: false }
    const current = readStoredLegacyImportKey(database, threadId, physical, check)
    if (!current) return { retained: false }
    if (current.key === expectedImportKey) return { retained: false,
      physicalImport: { id: physicalId, key: current.key },
      previousContentKey: typeof published?.previous_content_key === "string" ? published.previous_content_key : undefined }
    // The app already published this exact body. Update only its receipt,
    // preserving the materialized fragment layout and native field authority.
    return { retained: false, repair: { ...publication, fields: 0, writeBytes: 256,
      replacementContentKey: current.key, replacementProviderKey: current.providerKey,
      replacementPayloadKey: current.payloadKey, replacementFieldKeys: current.fieldKeys } }
  }
  if (!authorized || (resume && resume.version !== physicalRevision.version) ||
      (partialVersion !== null && partialVersion !== physicalRevision.version)) return retained
  const protectedFields = Number(authority.authority)
  const fields = (LEGACY_STREAM_BODY | LEGACY_STREAM_REASONING | LEGACY_STREAM_TOOLS) & ~protectedFields
  if (!fields) return retained
  const next = { ...physical }
  if (protectedFields) {
    if ((protectedFields & LEGACY_STREAM_BODY) !== 0 && !verify(physical, null,
      physical.contentFragments?.length ?? 0, check, false, physicalId, false, true)) return retained
    const protectedValues = database.prepare(`SELECT reasoning, tool_calls_json FROM thread_messages
      WHERE thread_id = ? AND message_id = ? AND COALESCE(octet_length(reasoning), 0) <= ?
      AND COALESCE(octet_length(tool_calls_json), 0) <= ?`).get(threadId, physicalId,
      TRANSCRIPT_REASONING_MAX_CHARS * 4, LEGACY_TRANSCRIPT_STRUCTURED_PROJECTION_BYTES)
    if (!protectedValues) return retained
    if ((protectedFields & LEGACY_STREAM_REASONING) !== 0) {
      const reasoning = protectedValues.reasoning as string | null
      if (normalizeVisibleReasoningText(reasoning ?? undefined) !== normalizeVisibleReasoningText(physical.reasoning ?? undefined))
        return retained
      next.reasoning = reasoning
    }
    if ((protectedFields & LEGACY_STREAM_TOOLS) !== 0) {
      const tools = protectedValues.tool_calls_json as string | null
      if (!legacyToolCallsEqual(tools, physical.toolCallsJson)) return retained
      next.toolCallsJson = tools
    }
  }
  const fragmentBytes = (source: DurableLegacyCheckpointMessage) => (source.contentFragments ?? [])
    .reduce((bytes, part) => bytes + Buffer.byteLength(part) + 256, 0)
  const prior = message.previousCopies?.[earlier.indexOf(expectedImportKey)]?.payload
  let stored: { rowBytes: number; fragmentBytes: number } | null = null
  if (partialVersion === null && !resume && importId === physicalId && prior &&
      verify(prior, null, prior.contentFragments?.length ?? 0, check, false, physicalId)) {
    stored = { rowBytes: prior.estimatedBytes, fragmentBytes: fragmentBytes(prior) }
  } else if (partialVersion === null && !resume) {
    const candidate = readStoredLegacyImportKey(database, threadId, physical, check)
    if (candidate && ((importId === physicalId && candidate.key === expectedImportKey) ||
        candidate.providerKey === published?.provider_content_key ||
        matchesUnmodifiedLegacyFields(candidate.fieldKeys, published?.field_content_keys, protectedFields))) stored = candidate
  }
  if (partialVersion === null && !resume && !stored) return retained
  const writesBody = (fields & LEGACY_STREAM_BODY) !== 0
  const wide = writesBody ? (stored?.fragmentBytes ?? 0) + fragmentBytes(next) : 0
  const writeBytes = message.estimatedBytes + (stored?.rowBytes ?? 0) + wide
  const nextKeys = protectedFields ? legacyMessageContentKeys(next) : projected
  return { retained: false, repair: {
    ...publication, message: next, writeBytes,
    replacementContentKey: nextKeys.raw, replacementProviderKey: nextKeys.normalized,
    replacementPayloadKey: nextKeys.payload,
    replacementFieldKeys: nextKeys.fields,
    rewrite: writesBody && (resume || partialVersion !== null || (wide > 0 && writeBytes > LEGACY_WRITER_BATCH_BYTES)) ? { resume } : undefined,
    fields
  } }
}

function createLegacyStreamRepairWriter(
  database: DatabaseSync, threadId: string, checkpointId: string, hasRecoveryIntegrity: boolean, check: () => void
) {
  const columns = [
    [LEGACY_STREAM_BODY, "content_json", "contentJson"],
    [LEGACY_STREAM_REASONING, "reasoning", "reasoning"],
    [LEGACY_STREAM_TOOLS, "tool_calls_json", "toolCallsJson"]
  ] as const
  const updates = new Map<string, StatementSync>()
  const clearFragments = database.prepare(`DELETE FROM thread_message_fragments AS f
    WHERE f.thread_id = ? AND f.message_id = ? AND ${publishedThreadMessageFragmentsSql("f")}`)
  const clearState = database.prepare("DELETE FROM thread_message_fragment_states WHERE thread_id = ? AND message_id = ?")
  const insert = database.prepare(`INSERT INTO thread_message_fragments
    (thread_id, message_id, content_text, created_at, generation)
    SELECT thread_id, message_id, ?, ?, fragment_generation FROM thread_messages WHERE thread_id = ? AND message_id = ?`)
  const state = database.prepare(`INSERT INTO thread_message_fragment_states
    (thread_id, message_id, total_chars, updated_at) VALUES (?, ?, ?, ?)`)
  let updateImport: StatementSync | undefined
  let moveImport: StatementSync | undefined
  let forgetImport: StatementSync | undefined
  let stampNative: StatementSync | undefined
  const publishNativeImport = ({ message, nativePublication }: LegacyStreamRepair) => {
    if (!nativePublication) return
    stampNative ??= database.prepare(`INSERT INTO legacy_checkpoint_transcript_imports
      (thread_id, message_id, content_key, provider_content_key, source_turn_key, owned_by_migration,
        published_checkpoint_id, source_declared_occurrence)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(thread_id, message_id) DO UPDATE SET content_key = excluded.content_key,
        provider_content_key = excluded.provider_content_key, source_turn_key = excluded.source_turn_key,
        payload_content_key = NULL, published_checkpoint_id = excluded.published_checkpoint_id,
        merged_checkpoint_ids = NULL,
        source_declared_occurrence = COALESCE(source_declared_occurrence, excluded.source_declared_occurrence)
      WHERE owned_by_migration = 0`)
    if (Number(stampNative.run(threadId, message.messageId, nativePublication.contentKey,
      nativePublication.providerKey, nativePublication.turnKey, checkpointId, message.sourceDeclaredOccurrence ?? null).changes) !== 1)
      throw searchBootstrapSuperseded()
  }
  const publishImport = ({ message, replacementContentKey, replacementProviderKey, replacementPayloadKey,
    replacementFieldKeys, expectedImportId }: LegacyStreamRepair) => {
    if (replacementContentKey === undefined) return
    if (expectedImportId && expectedImportId !== message.messageId) {
      moveImport ??= database.prepare(`INSERT INTO legacy_checkpoint_transcript_imports
        (thread_id, message_id, content_key, previous_content_key, provider_content_key, payload_content_key,
          source_turn_key, published_checkpoint_id, source_declared_occurrence, field_content_keys)
        SELECT thread_id, ?, ?, COALESCE(previous_content_key, content_key), ?, ?, source_turn_key, ?, source_declared_occurrence, ?
        FROM legacy_checkpoint_transcript_imports WHERE thread_id = ? AND message_id = ?`)
      moveImport.run(message.messageId, replacementContentKey, replacementProviderKey ?? null,
        replacementPayloadKey ?? null, checkpointId, replacementFieldKeys ?? null, threadId, expectedImportId)
      forgetImport ??= database.prepare(`DELETE FROM legacy_checkpoint_transcript_imports WHERE thread_id = ? AND message_id = ?`)
      forgetImport.run(threadId, expectedImportId)
    } else {
      updateImport ??= database.prepare(`UPDATE legacy_checkpoint_transcript_imports
        SET previous_content_key = COALESCE(previous_content_key, content_key), content_key = ?,
          provider_content_key = ?, payload_content_key = ?, rewrite_progress = NULL, partial_version = NULL,
          published_checkpoint_id = ?, merged_checkpoint_ids = NULL, field_content_keys = ?
        WHERE thread_id = ? AND message_id = ?`)
      updateImport.run(replacementContentKey, replacementProviderKey ?? null, replacementPayloadKey ?? null,
        checkpointId, replacementFieldKeys ?? null, threadId, message.messageId)
    }
  }
  const apply = (repair: LegacyStreamRepair, deferFragments = false) => {
    const { message, fields, replacementContentKey } = repair
    if (!fields) {
      publishImport(repair)
      return
    }
    const changes = columns.filter(([flag]) => (flag & fields) !== 0)
    const replace = replacementContentKey !== undefined
    const cacheKey = `${fields}:${replace}`
    let update = updates.get(cacheKey)
    if (!update) {
      const assignments = changes.map(([, column]) => `${column} = ?`)
      if (replace) assignments.push("tool_call_id = ?", "name = ?", "status = ?", "is_error = ?")
      if (hasRecoveryIntegrity) assignments.push("recovery_integrity = CASE WHEN ? = 1 THEN recovery_integrity ELSE 0 END")
      update = database.prepare(`UPDATE thread_messages SET ${assignments.join(", ")} WHERE thread_id = ? AND message_id = ?`)
      updates.set(cacheKey, update)
    }
    update.run(...changes.map(([, , property]) => message[property]),
      ...(replace ? [message.toolCallId, message.name, message.status, message.isError] : []),
      ...(hasRecoveryIntegrity ? [message.recoveryIntegrity] : []), threadId, message.messageId)
    if (deferFragments) return
    publishImport(repair)
    publishNativeImport(repair)
    if ((fields & LEGACY_STREAM_BODY) === 0) return
    clearFragments.run(threadId, message.messageId)
    clearState.run(threadId, message.messageId)
    let units = 0
    for (const fragment of message.contentFragments ?? []) {
      check()
      insert.run(fragment, message.createdAt, threadId, message.messageId)
      units += fragment.length
    }
    if (units) state.run(threadId, message.messageId, units, Date.now())
  }
  return { apply, publishImport, publishNativeImport }
}

function stageLegacyFragmentBatch(parts: readonly string[], progress: LegacyFragmentRewrite,
  add: (part: string, index: number) => void, check: () => void): boolean {
  const started = performance.now()
  let bytes = 0
  while (progress.nextIndex < parts.length) {
    check()
    const part = parts[progress.nextIndex]
    const cost = Buffer.byteLength(part) + 256
    if (bytes && (bytes + cost > LEGACY_WRITER_BATCH_BYTES || performance.now() - started > LEGACY_WRITER_BATCH_MS)) break
    add(part, progress.nextIndex)
    progress.nextIndex += 1
    progress.totalChars += part.length
    bytes += cost
  }
  return bytes > 0
}

function configureLegacyTranscriptWriter(database: DatabaseSync): boolean {
  const wal = database.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal"
  if (wal) database.exec("PRAGMA synchronous = NORMAL")
  return wal
}

function prepareLegacySearchThreadGuard(database: DatabaseSync): StatementSync {
  return database.prepare(`SELECT created_at, status,
    COALESCE(octet_length(metadata), 0) > ${SEARCH_BACKFILL_METADATA_BYTE_LIMIT} AS oversized_metadata,
    CASE WHEN COALESCE(octet_length(metadata), 0) <= ${SEARCH_BACKFILL_METADATA_BYTE_LIMIT}
      THEN json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
        '$.${THREAD_INCARNATION_METADATA_KEY}')
    END AS token FROM threads WHERE thread_id = ?`)
}

function assertLegacySearchThread(read: StatementSync, threadId: string, guard: LegacySearchBootstrapGuard): void {
  const row = read.get(threadId)
  if (row?.oversized_metadata) throw searchBootstrapNeedsForeground()
  if (!row || row.status === "busy" || !matchesThreadIncarnationSnapshot({
    token: typeof row.token === "string" && row.token ? row.token : null,
    legacyCreatedAt: Number(row.created_at)
  }, guard.incarnation)) throw searchBootstrapSuperseded()
}
function writeLegacyStreamRepairBatches(
  input: LegacyTranscriptCopyInput, repairs: Iterable<LegacyStreamRepair>, schema: LegacyStreamSchema
) {
  const check = () => throwIfCancelled(input.cancellation)
  const assertSource = () => {
    check()
    if (!input.sourceStillCurrent?.() || !input.sourceFamilyStillCurrent()) throw searchBootstrapSuperseded()
  }
  const { databasePath, threadId } = input
  const database = new DatabaseSync(databasePath, { timeout: 5_000 })
  try {
    const wal = configureLegacyTranscriptWriter(database)
    if (wal) database.exec("PRAGMA wal_autocheckpoint = 0")
    const readAuthority = createLegacyStreamAuthorityReader(database, schema.hasStreamAuthority)
    const readEpoch = database.prepare("SELECT epoch FROM thread_search_structure_versions WHERE thread_id = ?")
    const readVersion = database.prepare("SELECT version FROM thread_search_message_versions WHERE thread_id = ? AND message_id = ?")
    const occurrenceSnapshot = input.occurrenceSnapshot
    const readOccurrenceVersion = occurrenceSnapshot ? database.prepare(LEGACY_OCCURRENCE_VERSION_SQL) : null
    const readImport = database.prepare(`SELECT content_key, rewrite_progress, published_checkpoint_id, merged_checkpoint_ids
      FROM legacy_checkpoint_transcript_imports
      WHERE thread_id = ? AND message_id = ? AND owned_by_migration = 1`)
    const physicalExists = database.prepare("SELECT 1 FROM thread_messages WHERE thread_id = ? AND message_id = ?")
    const readNative = database.prepare(`SELECT owned_by_migration, published_checkpoint_id, merged_checkpoint_ids
      FROM legacy_checkpoint_transcript_imports WHERE thread_id = ? AND message_id = ?`)
    const { apply, publishImport, publishNativeImport } = createLegacyStreamRepairWriter(
      database, threadId, input.checkpointId, schema.hasRecoveryIntegrity, check)
    const validateNative = (repair: LegacyStreamRepair) => {
      if (!repair.nativePublication) return
      const receipt = readNative.get(threadId, repair.message.messageId)
      const samePublication = (receipt?.published_checkpoint_id ?? null) === repair.nativePublication.previousCheckpoint &&
        (receipt?.merged_checkpoint_ids ?? null) === repair.nativePublication.mergedCheckpoints
      const ownPublishedBatch = receipt?.published_checkpoint_id === input.checkpointId && receipt.merged_checkpoint_ids == null
      if (receipt?.owned_by_migration === 1 || (!samePublication && !ownPublishedBatch)) throw searchBootstrapSuperseded()
    }
    const guardedThread = input.searchGuard ? prepareLegacySearchThreadGuard(database) : null
    const validate = (message: DurableLegacyCheckpointMessage, fields: number, revision: LegacyStreamRevision,
      expectedImportKey?: string, expectedImportId = message.messageId,
      expectedPublishedCheckpoint?: string, expectedMergedCheckpoints?: string | null) => {
      const row = readAuthority.get(threadId, message.messageId)
      const receipt = expectedImportKey === undefined ? undefined : readImport.get(threadId, expectedImportId)
      if (row?.role !== message.role || !matchesCheckpointProvider(row, message) ||
          ((expectedImportKey === undefined ? currentLegacyStreamAuthority(row) : Number(row.authority)) & fields) !== 0 ||
          (expectedImportKey !== undefined && (receipt?.content_key !== expectedImportKey ||
            receipt.published_checkpoint_id !== expectedPublishedCheckpoint ||
            (receipt.merged_checkpoint_ids ?? null) !== (expectedMergedCheckpoints ?? null))) ||
          (expectedImportId !== message.messageId && physicalExists.get(threadId, expectedImportId)) ||
          Number(readVersion.get(threadId, message.messageId)?.version ?? 0) !== revision.version ||
          Number(readEpoch.get(threadId)?.epoch ?? 0) !== revision.epoch) throw searchBootstrapSuperseded()
    }
    let bytes = 0
    let started = 0
    const writerTurn = createLegacyWriterTurn(input.cancellation)
    const begin = () => {
      assertSource()
      database.exec("BEGIN IMMEDIATE")
      if (occurrenceSnapshot && (Number(readEpoch.get(threadId)?.epoch ?? 0) !== occurrenceSnapshot.epoch ||
          Number(readOccurrenceVersion?.get(threadId)?.version ?? 0) !== occurrenceSnapshot.version))
        throw searchBootstrapSuperseded()
      recordLegacyCheckpointParent(database, input)
      started = performance.now()
      if (guardedThread && input.searchGuard) assertLegacySearchThread(guardedThread, threadId, input.searchGuard)
    }
    const commit = () => {
      assertSource()
      const occurrenceVersion = readOccurrenceVersion?.get(threadId)?.version
      database.exec("COMMIT")
      if (occurrenceSnapshot) occurrenceSnapshot.version = Number(occurrenceVersion ?? 0)
      bytes = 0
      writerTurn.released()
      writerTurn.wait()
    }
    const addFragment = database.prepare(`INSERT INTO thread_message_fragments
      (thread_id, message_id, content_text, created_at, generation) VALUES (?, ?, ?, ?, ?)`)
    const readGeneration = database.prepare(`SELECT fragment_generation FROM thread_messages
      WHERE thread_id = ? AND message_id = ?`)
    const saveFragmentState = database.prepare(`INSERT INTO thread_message_fragment_states
      (thread_id, message_id, total_chars, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id, message_id) DO UPDATE SET
        total_chars = excluded.total_chars, updated_at = excluded.updated_at`)
    const invalidateRecovery = schema.hasRecoveryIntegrity
      ? database.prepare("UPDATE thread_messages SET recovery_integrity = 0 WHERE thread_id = ? AND message_id = ?")
      : null
    const rebaseHead = database.prepare("UPDATE thread_messages SET content_json = ? WHERE thread_id = ? AND message_id = ?")
    const appendWideBody = (repair: LegacyStreamRepair, append: NonNullable<LegacyStreamRepair["append"]>) => {
      const { message, fields } = repair
      const head = parseJsonValue(message.contentJson)
      if (typeof head !== "string") throw searchBootstrapSuperseded()
      let remainingPrefix = append.offset
      let totalChars = append.offset
      let revision = repair.revision
      let newHead = append.rebaseHead
      let generation = ""
      for (const chunk of [head, ...(message.contentFragments ?? [])]) {
        if (remainingPrefix >= chunk.length) {
          remainingPrefix -= chunk.length
          continue
        }
        check()
        const tail = chunk.slice(remainingPrefix)
        remainingPrefix = 0
        const size = Buffer.byteLength(tail)
        if (bytes && (bytes + size > LEGACY_WRITER_BATCH_BYTES || performance.now() - started > LEGACY_WRITER_BATCH_MS)) {
          saveFragmentState.run(threadId, message.messageId, totalChars, Date.now())
          revision = { ...revision, version: Number(readVersion.get(threadId, message.messageId)?.version ?? 0) }
          commit()
        }
        if (!bytes) {
          begin()
          validate(message, fields, revision)
          validateNative(repair)
          publishNativeImport(repair)
          generation = String(readGeneration.get(threadId, message.messageId)?.fragment_generation ?? "")
          if (newHead !== undefined) {
            rebaseHead.run(newHead, threadId, message.messageId)
            newHead = undefined
          }
          if (message.recoveryIntegrity !== 1) invalidateRecovery?.run(threadId, message.messageId)
        }
        addFragment.run(threadId, message.messageId, tail, message.createdAt, generation)
        totalChars += tail.length
        bytes += size
      }
      if (!bytes) throw searchBootstrapSuperseded()
      const auxiliary = fields & ~LEGACY_STREAM_BODY
      if (auxiliary) apply({ ...repair, fields: auxiliary })
      saveFragmentState.run(threadId, message.messageId, totalChars, Date.now())
      commit()
    }
    const saveRewrite = database.prepare(`UPDATE legacy_checkpoint_transcript_imports SET rewrite_progress = ?
      WHERE thread_id = ? AND message_id = ?`)
    const moveRewriteImport = database.prepare(`UPDATE legacy_checkpoint_transcript_imports SET message_id = ?
      WHERE thread_id = ? AND message_id = ?`)
    const removeFragmentState = database.prepare("DELETE FROM thread_message_fragment_states WHERE thread_id = ? AND message_id = ?")
    const retire = database.prepare(`INSERT OR IGNORE INTO legacy_checkpoint_retired_fragments VALUES (?, ?, ?)`)
    const publishGeneration = database.prepare(`UPDATE thread_messages SET fragment_generation = ?
      WHERE thread_id = ? AND message_id = ?`)
    const replaceWideBody = (repair: LegacyStreamRepair, resume: LegacyFragmentRewrite | null) => {
      const { message, fields, replacementContentKey, expectedImportKey } = repair
      if (!replacementContentKey || !expectedImportKey) throw searchBootstrapSuperseded()
      const id = message.messageId
      const parts = message.contentFragments ?? []
      let importId = repair.expectedImportId ?? id
      const sameTarget = resume?.contentKey === replacementContentKey
      const staged = sameTarget ? { ...resume } : { contentKey: replacementContentKey,
        version: repair.revision.version, generation: randomUUID(), nextIndex: 0, totalChars: 0 }
      let expected = resume
      if (staged.nextIndex > parts.length) throw searchBootstrapSuperseded()
      for (;;) {
        begin()
        validate(message, fields, repair.revision, expectedImportKey, importId,
          repair.expectedPublishedCheckpoint, repair.expectedMergedCheckpoints)
        const recorded = readLegacyFragmentRewrite(readImport.get(threadId, importId)?.rewrite_progress)
        if (JSON.stringify(recorded) !== JSON.stringify(expected)) throw searchBootstrapSuperseded()
        if (expected && expected.generation !== staged.generation) retire.run(threadId, id, expected.generation)
        if (importId !== id) {
          moveRewriteImport.run(id, threadId, importId)
          importId = id
        }
        if (stageLegacyFragmentBatch(parts, staged, (part, index) =>
          addFragment.run(threadId, id, part, message.createdAt + index, staged.generation), check)) {
          expected = { ...staged }
          saveRewrite.run(JSON.stringify(expected), threadId, id)
          commit()
          continue
        }
        // Payload, fragment visibility and its ownership ledger change together.
        const prior = String(readGeneration.get(threadId, id)?.fragment_generation ?? "")
        if (prior === staged.generation) throw searchBootstrapSuperseded()
        apply(repair, true)
        publishGeneration.run(staged.generation, threadId, id)
        retire.run(threadId, id, prior)
        if (staged.totalChars > 0) saveFragmentState.run(threadId, id, staged.totalChars, Date.now())
        else removeFragmentState.run(threadId, id)
        publishImport({ ...repair, expectedImportId: id })
        commit()
        return
      }
    }
    for (const repair of repairs) {
      check()
      if (repair.rewrite) {
        if (bytes) commit()
        replaceWideBody(repair, repair.rewrite.resume)
        continue
      }
      if (repair.append) {
        if (bytes) commit()
        appendWideBody(repair, repair.append)
        continue
      }
      if (bytes && (bytes + repair.writeBytes > LEGACY_WRITER_BATCH_BYTES ||
          performance.now() - started > LEGACY_WRITER_BATCH_MS))
        commit()
      if (!bytes) begin()
      validate(repair.message, repair.fields, repair.revision,
        repair.expectedImportKey, repair.expectedImportId, repair.expectedPublishedCheckpoint, repair.expectedMergedCheckpoints)
      validateNative(repair)
      apply(repair)
      bytes += repair.writeBytes
    }
    if (bytes) commit()
    if (wal) database.exec("PRAGMA wal_checkpoint(PASSIVE)")
  } finally {
    if (database.isTransaction) database.exec("ROLLBACK")
    database.close()
  }
}

function collectLegacyRetiredFragments(input: LegacyTranscriptCopyInput): void {
  const { databasePath, threadId } = input
  const database = new DatabaseSync(databasePath, { timeout: 100 })
  try {
    const pending = database.prepare(`SELECT message_id, rewrite_progress FROM legacy_checkpoint_transcript_imports
      WHERE thread_id = ? AND rewrite_progress IS NOT NULL LIMIT ?`)
    const retired = database.prepare(`SELECT message_id, generation FROM legacy_checkpoint_retired_fragments
      WHERE thread_id = ? LIMIT 1`)
    if (!pending.get(threadId, 1) && !retired.get(threadId)) return
    configureLegacyTranscriptWriter(database)
    const forget = database.prepare(`UPDATE legacy_checkpoint_transcript_imports SET rewrite_progress = NULL
      WHERE thread_id = ? AND message_id = ? AND rewrite_progress = ?`)
    const retire = database.prepare("INSERT OR IGNORE INTO legacy_checkpoint_retired_fragments VALUES (?, ?, ?)")
    const clearRetired = database.prepare(`DELETE FROM legacy_checkpoint_retired_fragments
      WHERE thread_id = ? AND message_id = ? AND generation = ?`)
    const active = database.prepare(`SELECT fragment_generation FROM thread_messages WHERE thread_id = ? AND message_id = ?`)
    const list = database.prepare(`SELECT fragment_id, octet_length(content_text) AS bytes FROM thread_message_fragments
      WHERE thread_id = ? AND message_id = ? AND generation = ? ORDER BY fragment_id LIMIT ?`)
    const remove = database.prepare("DELETE FROM thread_message_fragments WHERE fragment_id = ?")
    const guard = input.searchGuard ? prepareLegacySearchThreadGuard(database) : null
    const writerTurn = createLegacyWriterTurn(input.cancellation)
    const sourceCurrent = () => input.sourceStillCurrent?.() && input.sourceFamilyStillCurrent()
    while (sourceCurrent()) {
      throwIfCancelled(input.cancellation)
      writerTurn.wait()
      database.exec("BEGIN IMMEDIATE")
      if (!sourceCurrent()) break
      if (guard && input.searchGuard) assertLegacySearchThread(guard, threadId, input.searchGuard)
      const stages = pending.all(threadId, LEGACY_TRANSCRIPT_BATCH_LIMIT)
      for (const stage of stages) {
        const progress = readLegacyFragmentRewrite(stage.rewrite_progress)
        if (progress) retire.run(threadId, stage.message_id, progress.generation)
        forget.run(threadId, stage.message_id, stage.rewrite_progress)
      }
      const bucket = retired.get(threadId)
      if (!bucket && !stages.length) break
      if (bucket) {
        const messageId = String(bucket.message_id)
        const generation = String(bucket.generation)
        const parts = active.get(threadId, messageId)?.fragment_generation === generation
          ? [] : list.all(threadId, messageId, generation, LEGACY_TRANSCRIPT_BATCH_LIMIT)
        let bytes = 0
        let removed = 0
        for (const part of parts) {
          throwIfCancelled(input.cancellation)
          const size = Number(part.bytes) + 256
          if (bytes && bytes + size > LEGACY_WRITER_BATCH_BYTES) break
          remove.run(part.fragment_id)
          bytes += size
          removed += 1
        }
        if (removed === parts.length && parts.length < LEGACY_TRANSCRIPT_BATCH_LIMIT)
          clearRetired.run(threadId, messageId, generation)
      }
      if (!sourceCurrent()) break
      database.exec("COMMIT")
      writerTurn.released()
    }
  } catch (error) {
    if (!(error instanceof Error) || !/(database is (locked|busy)|CANCELLED|SUPERSEDED)/i.test(`${error.name}: ${error.message}`))
      throw error
  } finally {
    if (database.isTransaction) database.exec("ROLLBACK")
    database.close()
  }
}

function migrateLegacyMessagesIntoDurableRows(source: LegacyTranscriptCopyInput): LegacyCheckpointTranscriptMigrationStats {
  const input = keepPublishedShadowSlots(bindLegacyImplicitOccurrences(source))
  const prepareOverlapWork = Symbol("prepare legacy overlap coverage")
  const prepareRepairBatches = Symbol("apply bounded legacy stream repairs")
  const retryDurableChange = Symbol("refresh legacy copy evidence")
  type LayoutProbe = LegacyDurableProbe<LegacyAppendPlacement | null>
  type ProgressProbe = LegacyDurableProbe<LegacyCopyProgress | null>
  type InitialProbe = LegacyDurableProbe<LegacyInitialLayout | null>
  type Result = LegacyOverlapProof | LegacyStreamEvidence | LegacyOccurrenceRevision |
    LayoutProbe | ProgressProbe | InitialProbe | boolean | null
  type Prepared = { overlap: PreparedLegacyOverlap | null } | { stream: LegacyStreamEvidence } |
    { copy: boolean } | { layout: LayoutProbe } | { progress: ProgressProbe } | { initial: InitialProbe } |
    { occurrence: LegacyOccurrenceRevision }
  type Evaluate = (prepared: Prepared) => Result
  const cache = new Map<string, Result>()
  const payloadKeys = new WeakMap<LegacyOverlapPayload, string>()
  const observations = new Map<string, { key: string; changes: number }>()
  const durableRevisions = new Map<string, number>()
  let durableChanges = 0
  const checkCancelled = () => throwIfCancelled(input.cancellation)
  const contentKeys: string[] = []
  const turnKeys = legacySourceTurns(input.messages)
  const providerContentKeys: string[] = []
  const payloadContentKeys: string[] = []
  const fieldContentKeys: string[] = []
  const layoutKeys: string[] = []
  const copiedLayoutKeys: Array<string | null> = [null]
  const shadowSlots: Array<[number, string]> = []
  const revisableSlots: number[] = []
  const earlierKeys = new Map<number, Array<{ beforeIndex: number; raw: string; normalized: string }>>()
  const recoveryKeys: Array<string | null> = []
  const progressHash = createHash("sha256")
  const providerProgressHash = createHash("sha256")
  const layoutHash = createHash("sha256")
  const laneHash = createHash("sha256")
  let laneCount = 0
  for (const [index, message] of input.messages.entries()) {
    checkCancelled()
    const { raw, normalized, payload, fields } = legacyMessageContentKeys(message)
    contentKeys.push(raw)
    providerContentKeys.push(normalized)
    payloadContentKeys.push(payload)
    fieldContentKeys.push(fields)
    recoveryKeys.push(legacyMessageRecoveryKey(message))
    progressHash.update(raw)
    providerProgressHash.update(normalized)
    const revisable = !message.shadowSlot && (message.providerIdentityDeclared ||
      (message.role === "assistant" && message.stableSourceId) || !!message.previousCopies?.length)
    if (revisable) revisableSlots.push(index)
    if (message.shadowSlot) shadowSlots.push([index, legacyCheckpointProviderIdentity(message)])
    const slotKey = legacyLayoutSlotKey(message, normalized)
    layoutKeys.push(slotKey)
    layoutHash.update(slotKey)
    copiedLayoutKeys.push(layoutHash.copy().digest("hex"))
    if (!message.shadowSlot) {
      laneHash.update(slotKey)
      laneCount += 1
    }
    if (message.previousCopies?.length) earlierKeys.set(index, message.previousCopies.map(({ beforeIndex, payload }) => ({
      beforeIndex, ...legacyMessageContentKeys(payload)
    })))
  }
  const progressDigest = progressHash.digest("hex")
  const providerProgressDigest = providerProgressHash.digest("hex")
  const layoutDigest = layoutHash.digest("hex")
  const laneDigest = laneHash.digest("hex")
  const storedShadowSlots = shadowSlots.length ? JSON.stringify(shadowSlots) : null
  // An existing scoped copy must finish its authenticated slots before a
  // rewrite of the same checkpoint can reserve positions for a new suffix.
  if (!source.prefixCopy && !source.searchGuard && input.pendingScopedPrefix) {
    const { count, key, hasActiveCopy } = input.pendingScopedPrefix
    if (Number.isSafeInteger(count) && count > 0 && count < input.messages.length &&
        (hasActiveCopy || key === legacyPrefixDigest(contentKeys, count, checkCancelled))) {
      const prefix = migrateLegacyMessagesIntoDurableRows({
        ...source, messages: source.messages.slice(0, count), prefixCopy: true
      })
      const rest = migrateLegacyMessagesIntoDurableRows({ ...source, occurrenceSnapshot: undefined })
      return { ...rest, migratedMessages: prefix.migratedMessages + rest.migratedMessages, batches: prefix.batches + rest.batches }
    }
  }
  const copied = { migratedMessages: 0, batches: 0 }
  for (;;) {
    const queued = new Map<string, {
      prepare: () => Prepared
      work: Map<string, Evaluate>
    }>()
    let queuedUnits = 0
    let reader: DatabaseSync | undefined
    let readStored: ReturnType<typeof createStoredLegacyOverlapReader> | undefined
    let readStream: ReturnType<typeof createLegacyStreamReader> | undefined
    let readAuthority: StatementSync | undefined
    let verifyCopy: ReturnType<typeof createLegacyPayloadVerifier> | undefined
    let readVersion: StatementSync | undefined
    let repairBatches: { repairs: ReadonlyMap<string, LegacyStreamRepair>; schema: LegacyStreamSchema } | undefined
    function readSnapshot<T>(read: (db: DatabaseSync) => T): T {
      reader ??= new DatabaseSync(input.databasePath, { readOnly: true, timeout: input.searchGuard ? 100 : 5_000 })
      reader.exec("BEGIN")
      try {
        return read(reader)
      } finally {
        reader.exec("ROLLBACK")
      }
    }
    function readVersioned<T>(messageId: string, revision: LegacyStreamRevision, read: (db: DatabaseSync) => T): T {
      return readSnapshot((db) => {
        readVersion ??= db.prepare(`SELECT
          COALESCE((SELECT version FROM thread_search_message_versions WHERE thread_id = ? AND message_id = ?), 0) AS version,
          COALESCE((SELECT epoch FROM thread_search_structure_versions WHERE thread_id = ?), 0) AS epoch`)
        const current = readVersion.get(input.threadId, messageId, input.threadId)
        if (current?.version !== revision.version || current.epoch !== revision.epoch) throw searchBootstrapSuperseded()
        return read(db)
      })
    }
    function stage<T extends Result>(
      logicalSource: string, payload: string, operation: string, units: number,
      prepare: () => Prepared, evaluate: (prepared: Prepared) => T, pending: T
    ): T {
      if (units > SEARCH_LEGACY_MAX_SOURCE_BYTES) return pending
      const previous = observations.get(logicalSource)
      if (previous?.key !== payload) {
        const changes = previous ? previous.changes + 1 : 0
        if (changes > 3) throw searchBootstrapSuperseded()
        observations.set(logicalSource, { key: payload, changes })
      }
      const key = `${operation}:${payload}`
      if (cache.has(key)) return cache.get(key) as T
      let group = queued.get(payload)
      if (!group && queuedUnits + units <= SEARCH_LEGACY_MAX_SOURCE_BYTES) {
        group = { prepare, work: new Map() }
        queued.set(payload, group)
        queuedUnits += units
      }
      group?.work.set(key, evaluate)
      return pending
    }
    function stagePayload<T extends Result>(
      source: string, operation: string, message: LegacyOverlapPayload, fragments: readonly string[],
      evaluate: (projection: PreparedLegacyOverlap | null) => T, pending: T
    ) {
      const units = message.contentJson.length + (message.reasoning?.length ?? 0) +
        (message.toolCallsJson?.length ?? 0) + fragments.reduce((sum, part) => sum + part.length, 0)
      if (units > SEARCH_LEGACY_MAX_SOURCE_BYTES) return pending
      let payload = payloadKeys.get(message)
      if (!payload) {
        const hash = createHash("sha256")
        for (const field of [legacyCheckpointProviderIdentity(message), message.contentJson, message.reasoning ?? "",
          message.toolCallsJson ?? "", ...fragments]) hash.update(`${field.length}:`).update(field, "utf16le")
        payload = hash.digest("hex")
        payloadKeys.set(message, payload)
      }
      return stage(`${source}:${message.messageId}`, payload, operation, units,
        () => ({ overlap: prepareLegacyOverlap(message, fragments) }),
        (prepared) => evaluate("overlap" in prepared ? prepared.overlap : null), pending)
    }
    function readDurableProbe<T>(epoch: number, tail: number,
      inspect: (db: DatabaseSync, observe: (id: string) => void) => T): LegacyDurableProbe<T> {
      return readSnapshot((db) => {
        const currentEpoch = Number(db.prepare(LEGACY_EPOCH_SQL).get(input.threadId)?.epoch ?? 0)
        const currentTail = Number(db.prepare(LEGACY_TAIL_SQL).get({ threadId: input.threadId })?.last ?? -1)
        if (currentEpoch !== epoch || currentTail !== tail) throw searchBootstrapSuperseded()
        const stamp = db.prepare(LEGACY_VERSION_SQL)
        const versions = new Map<string, number>()
        const result = inspect(db, (id) => {
          if (!versions.has(id)) versions.set(id, Number(stamp.get(input.threadId, id)?.version ?? 0))
        })
        return { result, versions }
      })
    }
    function resolveProbe<T>(operation: string, payload: string, key: string,
      staged: () => LegacyDurableProbe<T> | null, getVersion: (id: string) => number): T | null {
      const known = staged()
      if (!known) return null
      for (const [id, version] of known.versions) {
        checkCancelled()
        if (getVersion(id) === version) continue
        const changes = (durableRevisions.get(key) ?? 0) + 1
        if (changes > 3) throw searchBootstrapSuperseded()
        durableRevisions.set(key, changes)
        cache.delete(`${operation}:${payload}`)
        staged()
        return null
      }
      return known.result
    }
    try {
      checkCancelled()
      const result = writeLegacyMessagesIntoDurableRows(input, {
        contentKeys, providerContentKeys, payloadContentKeys, fieldContentKeys, layoutKeys, copiedLayoutKeys, storedShadowSlots,
        revisableSlots, earlierKeys, recoveryKeys, progressDigest,
        providerProgressDigest, layoutDigest, laneDigest, laneCount
      }, {
        proof: (message, fragments, rawSlot) => stagePayload(rawSlot === undefined ? "source" : `source-claim:${rawSlot}`,
          "proof", message, fragments,
          (projection) => projection?.proof() ?? null, null),
        covers: (message, fragments, proof, rawSlot) => stagePayload(rawSlot === undefined ? "durable" : `source-claim:${rawSlot}`,
          `covers:${proof.digest}`, message, fragments,
          (projection) => projection?.covers(proof) ?? false, false),
        coversStored: (messageId, revision, proof, repair) => stage(`durable:${messageId}`,
          JSON.stringify([messageId, revision.version, revision.epoch, repair?.fields ?? 0]), `covers:${proof.digest}`, 0,
          () => {
            const stored = readVersioned(messageId, revision, (db) => {
              readStored ??= createStoredLegacyOverlapReader(db, input.threadId, checkCancelled)
              return readStored(messageId, repair)
            })
            return { overlap: stored ? prepareLegacyOverlap(stored.payload, stored.parts) : null }
          }, (prepared) => "overlap" in prepared && (prepared.overlap?.covers(proof) ?? false), false),
        recoverStream: (message, revision, hasAuthority) => stage(`stream:${message.messageId}`,
          JSON.stringify(["stream", message.messageId, revision.version, revision.epoch, hasAuthority]), "recover", 0,
          () => ({
            stream: readVersioned(message.messageId, revision, (db) => {
              readStream ??= createLegacyStreamReader(db, input.threadId, checkCancelled)
              readAuthority ??= createLegacyStreamAuthorityReader(db, hasAuthority)
              const row = readAuthority.get(input.threadId, message.messageId)
              if (row?.role !== "assistant" || !matchesCheckpointProvider(row, message))
                throw searchBootstrapSuperseded()
              return { relations: compareLegacyStream(message, readStream(message)),
                authority: currentLegacyStreamAuthority(row) }
            })
          }), (prepared) => "stream" in prepared ? prepared.stream : null, null),
        reviseOccurrence: (index, revision, hasAuthority) => {
          const message = input.messages[index]
          const key = JSON.stringify(["occurrence", index, revision.version, revision.epoch])
          const earlier = earlierKeys.get(index)?.map(({ raw }) => raw) ?? []
          return stage(`occurrence:${index}`, key, "revise", 0, () => ({
            occurrence: readVersioned(message.messageId, revision, (db) => inspectLegacyOccurrenceRevision(
              db, input.threadId, message, earlier, revision, hasAuthority, turnKeys[index],
              (checkpointId) => inheritsLegacyPublication(input, checkpointId),
              checkCancelled
            ))
          }), (prepared) => "occurrence" in prepared ? prepared.occurrence : null, null)
        },
        verifiesCopy: (message, revision, ordinal, fragments, allowLegacyReasoning, allowNativeDefaults, bodyOnly) => {
          const operation = JSON.stringify(["copy", message.messageId, ordinal, fragments, allowLegacyReasoning, allowNativeDefaults, bodyOnly])
          return stage(operation, JSON.stringify([operation, revision.version, revision.epoch]), "verify", 0,
            () => ({ copy: readVersioned(message.messageId, revision, (db) => {
              verifyCopy ??= createLegacyPayloadVerifier(db, input.threadId)
              return verifyCopy(message, ordinal, fragments, checkCancelled, allowLegacyReasoning,
                message.messageId, allowNativeDefaults, bodyOnly) === true
            }) }), (prepared) => "copy" in prepared ? prepared.copy : null, null)
        },
        placement: (base, previousCount, total, gap, epoch, tail, journal, getVersion) => {
          const payload = JSON.stringify(["layout", base, previousCount, total, gap, epoch, tail, journal])
          const key = `layout:${base}:${previousCount}:${total}`
          const staged = () => stage(key, payload, "append", 0,
            () => ({ layout: readDurableProbe(epoch, tail, (db, observe) => planLegacyAppend(
              db, input.threadId, input.messages.slice(0, total), base, previousCount, gap, checkCancelled, journal, observe
            )) }), (prepared) => "layout" in prepared ? prepared.layout : null, null)
          return resolveProbe("append", payload, key, staged, getVersion)
        },
        progress: (state, count, rebinding, offerRestart, epoch, tail, getVersion, verifyPublishedPrefix = false) => {
          const stateKey = JSON.stringify(state)
          const payload = JSON.stringify(["progress", stateKey, count, rebinding, offerRestart, epoch, tail, verifyPublishedPrefix])
          const key = `progress:${String(state.checkpoint_id)}:${count}`
          const staged = () => stage(key, payload, "progress", 0, () => {
            const progress = readDurableProbe(epoch, tail, (db, observe) => {
              if (JSON.stringify(db.prepare(LEGACY_COPY_STATE_SQL).get(input.threadId)) !== stateKey)
                throw searchBootstrapSuperseded()
              return legacyTranscriptProgressMatches(db, input.threadId, String(state.checkpoint_id),
                state, input.messages.slice(0, count), checkCancelled, !input.searchGuard, rebinding, offerRestart,
                observe, verifyPublishedPrefix)
            })
            if (progress.result) {
              progress.result.structureEpoch = epoch
              if (progress.result.activeMessageId) progress.result.activeRevision = {
                epoch, version: progress.versions.get(progress.result.activeMessageId) ?? 0
              }
            }
            return { progress }
          }, (prepared) => "progress" in prepared ? prepared.progress : null, null)
          return resolveProbe("progress", payload, key, staged, getVersion)
        },
        initialLayout: (options, state, epoch, tail, getVersion) => {
          const stateKey = JSON.stringify(state)
          const payload = JSON.stringify(["initial", options, stateKey, epoch, tail])
          const staged = () => stage("initial", payload, "classify", 0, () => ({
            initial: readDurableProbe(epoch, tail, (db, observe) => {
              if (JSON.stringify(db.prepare(LEGACY_COPY_STATE_SQL).get(input.threadId)) !== stateKey)
                throw searchBootstrapSuperseded()
              return inspectInitialLegacyLayout(db, input.threadId, input.messages, contentKeys, options,
                checkCancelled, observe)
            })
          }), (prepared) => "initial" in prepared ? prepared.initial : null, null)
          return resolveProbe("classify", payload, "initial", staged, getVersion)
        },
        flushRepairs: (repairs, schema) => {
          repairBatches = { repairs, schema }
          throw prepareRepairBatches
        },
        retryAfterDurableChange: () => { throw retryDurableChange },
        assertPrepared: () => {
          if (queued.size) throw prepareOverlapWork
        }
      }, copied)
      if (result.searchProjectionState) collectLegacyRetiredFragments(input)
      return input.searchGuard ? result : { ...result, ...copied }
    } catch (error) {
      if (error === prepareRepairBatches && repairBatches) {
        writeLegacyStreamRepairBatches(input, repairBatches.repairs.values(), repairBatches.schema)
        // A logical source alias can resolve to another physical row whose
        // version changed even though the logical ID's version stayed at zero.
        for (const key of cache.keys()) {
          if (key.startsWith("revise:")) cache.delete(key)
        }
        continue
      }
      if (error === retryDurableChange) {
        if (++durableChanges > 3) throw searchBootstrapSuperseded()
        continue
      }
      if (error !== prepareOverlapWork) throw error
      // The attempt rolled back and closed its durable writer. Full Markdown
      // projection and comparisons now run without holding its SQLite lock.
      // The next attempt only uses these results for identical raw inputs.
      try {
        for (const { prepare, work } of queued.values()) {
          checkCancelled()
          const prepared = prepare()
          for (const [key, evaluate] of work) cache.set(key, evaluate(prepared))
        }
      } finally {
        reader?.close()
      }
    }
  }
}

interface LegacyTranscriptHashes {
  copiedLayoutKeys: Array<string | null>
  payloadContentKeys: readonly string[]
  fieldContentKeys: readonly string[]
  contentKeys: readonly string[]
  providerContentKeys: readonly string[]
  layoutKeys: readonly string[]
  storedShadowSlots: string | null
  revisableSlots: readonly number[]
  earlierKeys: ReadonlyMap<number, Array<{ beforeIndex: number; raw: string; normalized: string }>>
  recoveryKeys: readonly (string | null)[]
  progressDigest: string
  providerProgressDigest: string
  layoutDigest: string
  laneDigest: string
  laneCount: number
}

function writeLegacyMessagesIntoDurableRows(
  input: LegacyTranscriptCopyInput, hashes: LegacyTranscriptHashes, overlapAudit: LegacyOverlapAudit,
  copied: { migratedMessages: number; batches: number }
): LegacyCheckpointTranscriptMigrationStats {
  const scope = input.searchGuard
  const database = new DatabaseSync(input.databasePath, { timeout: scope ? 100 : 5_000 })
  const writerTurn = createLegacyWriterTurn(input.cancellation)
  const assertSourceFamily = () => {
    if (!input.sourceFamilyStillCurrent()) throw searchBootstrapSuperseded()
  }
  const beginBatch = () => {
    if (!scope) {
      writerTurn.wait()
      throwIfCancelled(input.cancellation)
      if (!input.sourceStillCurrent?.()) throw searchBootstrapSuperseded()
      assertSourceFamily()
    }
    database.exec(scope ? "SAVEPOINT legacy_search_batch" : "BEGIN IMMEDIATE")
    recordLegacyCheckpointParent(database, input)
  }
  const commitBatch = () => {
    if (!scope) assertSourceFamily()
    database.exec(scope ? "RELEASE legacy_search_batch" : "COMMIT")
    if (!scope) writerTurn.released()
  }
  const rollbackBatch = () => database.exec(
    scope ? "ROLLBACK TO legacy_search_batch; RELEASE legacy_search_batch" : "ROLLBACK"
  )
  let publishStarted: number | undefined
  let guardedCommittedEpoch: number | undefined
  let messageVersions = false
  let readEpoch: StatementSync | null = null
  let readVersion: StatementSync | null = null
  const currentEpoch = () => Number(readEpoch?.get(input.threadId)?.epoch ?? 0)
  let placementEpoch: number | undefined
  const currentRevision = (messageId: string, epoch: number): LegacyStreamRevision => ({
    epoch, version: Number(readVersion?.get(input.threadId, messageId)?.version ?? 0)
  })
  const messageVersion = (id: string) => Number(readVersion?.get(input.threadId, id)?.version ?? 0)
  const currentTail = () => Number(database.prepare(LEGACY_TAIL_SQL).get({ threadId: input.threadId })?.last ?? -1)
  let verifyPhysicalCopy: ReturnType<typeof createLegacyPayloadVerifier> | undefined
  const verifyCopy: VerifyLegacyCopy = (message, ordinal, fragments, check,
    allowLegacyReasoning = false, allowNativeDefaults = false, bodyOnly = false, proofEpoch) => {
    if (!readVersion) {
      verifyPhysicalCopy ??= createLegacyPayloadVerifier(database, input.threadId)
      return verifyPhysicalCopy(message, ordinal, fragments, check, allowLegacyReasoning,
        message.messageId, allowNativeDefaults, bodyOnly)
    }
    return overlapAudit.verifiesCopy(message,
      currentRevision(message.messageId, proofEpoch ?? guardedCommittedEpoch ?? currentEpoch()), ordinal, fragments,
      allowLegacyReasoning, allowNativeDefaults, bodyOnly)
  }
  const prepareAppendPlacement = (base: number, previousCount: number, total: number, gap: readonly LegacySourceOrdinalGap[],
    journal: LegacyAppendJournal | null = null) => {
    if (!readVersion) return planLegacyAppend(database, input.threadId, input.messages.slice(0, total),
      base, previousCount, gap, assertSearchGuard, journal)
    return overlapAudit.placement(base, previousCount, total, gap, currentEpoch(), currentTail(), journal, messageVersion)
  }
  const prepareProgress = (state: Record<string, unknown>, count: number, rebinding = false, offerRestart = false,
    verifyPublishedPrefix = false) => {
    if (!readVersion) return legacyTranscriptProgressMatches(database, input.threadId, String(state.checkpoint_id),
      state, input.messages.slice(0, count), assertSearchGuard, !scope, rebinding, false, undefined, verifyPublishedPrefix)
    return overlapAudit.progress(state, count, rebinding, offerRestart, currentEpoch(), currentTail(), messageVersion,
      verifyPublishedPrefix)
  }
  const prepareInitialLayout = (options: LegacyInitialOptions, state?: Record<string, unknown>) => {
    if (!readVersion) return inspectInitialLegacyLayout(database, input.threadId, input.messages,
      hashes.contentKeys, options, assertSearchGuard, () => {})
    return overlapAudit.initialLayout(options, state, currentEpoch(), currentTail(), messageVersion)
  }
  const contentKey = (index: number) => hashes.contentKeys[index]
  const progressKey = () => hashes.progressDigest
  const activeLayout = (index: number, count = input.messages.length) =>
    legacyActiveLayoutDigest(input.messages, hashes.layoutKeys, count, index, checkSearchWork)
  const supersededImportKeys = new Map<number, string>()
  const confirmedImportLocations = new Map<number, { id: string; key: string }>()
  const publishOccurrenceRevisions = () => {
    if (!supersededImportKeys.size) return
    const publish = database.prepare(`UPDATE legacy_checkpoint_transcript_imports SET previous_content_key = NULL
      WHERE thread_id = ? AND message_id = ? AND content_key = ?`)
    for (const index of supersededImportKeys.keys()) {
      checkSearchWork()
      const physical = confirmedImportLocations.get(index)
      if (physical) publish.run(input.threadId, physical.id, physical.key)
    }
  }
  const earlierPrefix = (count: number, provider: boolean, useImported = false, first = 0) => {
    const keys = provider ? hashes.providerContentKeys : hashes.contentKeys
    if (!hashes.earlierKeys.size && !useImported) return null
    const end = first + count
    const older = keys.slice(first, end)
    let changed = false
    for (const index of hashes.revisableSlots) {
      if (index < first || index >= end) continue
      const matching = hashes.earlierKeys.get(index)?.find(({ beforeIndex }) => beforeIndex >= end)
      const key = (useImported && !provider ? supersededImportKeys.get(index) : undefined) ??
        (provider ? matching?.normalized : matching?.raw)
      if (!key) continue
      older[index - first] = key
      changed = true
    }
    return changed ? legacyPrefixDigest(older, count, checkSearchWork) : null
  }
  const preserveTimingPrefix = (state: Record<string, unknown>, checkpointId: string, previousCount: number) => {
    const recorded = parseJsonValue(state.timing_source_prefix)
    if (Array.isArray(recorded)) {
      const count = Number(recorded[0])
      const current = recorded[2] ?? recorded[1]
      if (typeof current === "string" && Number.isSafeInteger(count) && count > 0 && count <= previousCount) {
        const digest = legacyPrefixDigest(hashes.contentKeys, count, checkSearchWork)
        const layout = legacyPrefixDigest(hashes.layoutKeys, count, checkSearchWork)
        if (current === digest || current === earlierPrefix(count, false) ||
            current === earlierPrefix(count, false, true) || recorded[3] === layout) {
          return JSON.stringify([count, recorded[1], digest, layout])
        }
      }
      return typeof state.timing_source_prefix === "string" ? state.timing_source_prefix : null
    }
    if ((state.timing_checkpoint_id ?? checkpointId) !== checkpointId) return null
    return JSON.stringify([previousCount, state.progress_key,
      legacyPrefixDigest(hashes.contentKeys, previousCount, checkSearchWork),
      legacyPrefixDigest(hashes.layoutKeys, previousCount, checkSearchWork)])
  }
  const matchSourcePrefix = (state: Record<string, unknown>, count: number, first = 0) => {
    if (!Number.isSafeInteger(count) || count < 0 || first < 0 || first + count > input.messages.length) return null
    const whole = first === 0 && count === input.messages.length
    if (state.progress_key === (whole ? hashes.progressDigest :
      legacyPrefixDigest(hashes.contentKeys, count, checkSearchWork, first))) return "raw"
    const olderRaw = !whole && earlierPrefix(count, false, false, first)
    if (olderRaw && state.progress_key === olderRaw) return "raw"
    const priorImport = supersededImportKeys.size ? earlierPrefix(count, false, true, first) : null
    if (priorImport && state.progress_key === priorImport) return "revision"
    if (state.provider_progress_key === (whole ? hashes.providerProgressDigest :
      legacyPrefixDigest(hashes.providerContentKeys, count, checkSearchWork, first))) return "provider"
    const olderProvider = !whole && earlierPrefix(count, true, false, first)
    if (olderProvider && state.provider_progress_key === olderProvider) return "provider"
    if (state.source_layout_key === (whole ? hashes.layoutDigest :
      legacyPrefixDigest(hashes.layoutKeys, count, checkSearchWork, first))) return "layout"
    return null
  }
  const publishedPrefixCount = (state: Record<string, unknown>): number | null => {
    const index = Number(state.next_index)
    if (state.status !== "migrating" || !Number.isSafeInteger(index) || index < 0) return null
    if (Number(state.current_fragment_index) === 0) {
      return index > 0 && typeof state.copied_layout_key === "string" &&
        state.copied_layout_key === hashes.copiedLayoutKeys[index] ? index : null
    }
    const active = parseJsonValue(state.active_fragment_revision)
    return Array.isArray(active) && typeof active[6] === "string" &&
      activeLayout(index, index + 1) === active[6] ? index + 1 : null
  }
  const matchesPublishedLane = (state: Record<string, unknown>, first: number, last: number) => {
    const count = Number(state.source_lane_count)
    if (typeof state.source_lane_key !== "string" || !Number.isSafeInteger(count) || count <= 0) return false
    const hash = createHash("sha256")
    let seen = 0
    let position = first
    for (; position < input.messages.length && seen < count; position += 1) {
      checkSearchWork()
      if (input.messages[position].shadowSlot) continue
      hash.update(hashes.layoutKeys[position])
      seen += 1
    }
    return seen === count && position > last && hash.digest("hex") === state.source_lane_key
  }
  let insertImport: StatementSync | undefined
  let recordPartial: StatementSync | undefined
  let readPublishedUser: StatementSync | undefined
  let readPublishedOrdinal: StatementSync | undefined
  const publishedTurn = (id: string) => {
    readPublishedOrdinal ??= database.prepare("SELECT ordinal FROM thread_messages WHERE thread_id = ? AND message_id = ?")
    readPublishedUser ??= database.prepare(legacyPhysicalUserSql(true, "<="))
    const ordinal = readPublishedOrdinal.get(input.threadId, id)?.ordinal
    return typeof ordinal === "number"
      ? legacyPhysicalUserTurn(readPublishedUser.get({ threadId: input.threadId, ordinal })) : ""
  }
  const recordImportedMessage = (index: number, physical?: LegacyCopyProgress["activeImport"], owned = true) => {
    insertImport ??= database.prepare(`INSERT OR REPLACE INTO legacy_checkpoint_transcript_imports
      (thread_id, message_id, content_key, provider_content_key, payload_content_key, source_turn_key,
        owned_by_migration, published_checkpoint_id, source_declared_occurrence, field_content_keys)
      VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT published_checkpoint_id
        FROM legacy_checkpoint_transcript_imports WHERE thread_id = ? AND message_id = ? AND owned_by_migration = 0), ?),
        COALESCE((SELECT source_declared_occurrence
        FROM legacy_checkpoint_transcript_imports WHERE thread_id = ? AND message_id = ?), ?), ?)`)
    const id = physical?.id ?? input.messages[index].messageId
    insertImport.run(input.threadId, id,
      physical?.key ?? contentKey(index), physical?.providerKey ?? hashes.providerContentKeys[index],
      physical?.payloadKey ?? hashes.payloadContentKeys[index], publishedTurn(id),
      Number(owned), input.threadId, id, input.checkpointId, input.threadId, id,
      input.messages[index].sourceDeclaredOccurrence ?? null, owned ? physical?.fieldKeys ?? hashes.fieldContentKeys[index] : null)
  }
  let readNativeObservation: StatementSync | undefined
  const verifyNativeObservation = (index: number, ordinal: number | null) => {
    checkSearchWork()
    const message = input.messages[index]
    if (message.shadowSlot || message.sourceOccurrenceUncertain || message.revisionOrderConflict) return false
    if (message.role === "assistant" && !message.physicalOccurrenceBound) return false
    readNativeObservation ??= database.prepare(`SELECT 1 FROM thread_messages AS m
      LEFT JOIN legacy_checkpoint_transcript_imports AS i USING (thread_id, message_id)
      WHERE m.thread_id = ? AND m.message_id = ? AND i.owned_by_migration IS NOT 1
        AND i.published_checkpoint_id IS NULL AND i.merged_checkpoint_ids IS NULL`)
    return !!readNativeObservation.get(input.threadId, message.messageId) &&
      verifyCopy(message, ordinal, message.contentFragments?.length ?? 0, assertSearchGuard, false, true, true) === true
  }
  const recordPartialImport = (index: number, id: string, version: number, physical?: LegacyCopyProgress["activeImport"]) => {
    recordPartial ??= database.prepare(`INSERT INTO legacy_checkpoint_transcript_imports
      (thread_id, message_id, content_key, provider_content_key, payload_content_key, source_turn_key,
        partial_version, published_checkpoint_id, source_declared_occurrence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id, message_id) DO UPDATE SET
        content_key = excluded.content_key, provider_content_key = excluded.provider_content_key,
        payload_content_key = excluded.payload_content_key, source_turn_key = excluded.source_turn_key, partial_version = excluded.partial_version,
        previous_content_key = NULL, rewrite_progress = NULL, field_content_keys = NULL, owned_by_migration = 1,
        published_checkpoint_id = excluded.published_checkpoint_id, merged_checkpoint_ids = NULL,
        source_declared_occurrence = COALESCE(source_declared_occurrence, excluded.source_declared_occurrence)`)
    recordPartial.run(input.threadId, id, physical?.key ?? contentKey(index),
      physical?.providerKey ?? hashes.providerContentKeys[index], physical?.payloadKey ?? hashes.payloadContentKeys[index],
      publishedTurn(id), version, input.checkpointId, input.messages[index].sourceDeclaredOccurrence ?? null)
  }
  const recordSourceIds = (start: number, end: number) => {
    const add = database.prepare(`INSERT INTO legacy_checkpoint_transcript_source_ids
      (thread_id, checkpoint_id, message_id, source_index, content_key) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, checkpoint_id, message_id) DO UPDATE SET
        source_index = excluded.source_index,
        content_key = CASE WHEN legacy_checkpoint_transcript_source_ids.content_key LIKE '${LEGACY_RETIRED_MEMBER_PREFIX}%'
          THEN legacy_checkpoint_transcript_source_ids.content_key ELSE excluded.content_key END`)
    for (let index = start; index < end; index += 1) {
      checkSearchWork()
      const message = input.messages[index]
      if (message.shadowSlot || message.sourceOccurrenceUncertain || message.revisionOrderConflict) continue
      add.run(input.threadId, input.checkpointId, message.messageId, index,
        hashes.recoveryKeys[index])
    }
  }
  const recordVerifiedSourceAlias = (index: number, messageId: string, complete: boolean, replayKey?: string) => {
    const sourceId = input.messages[index].messageId
    const recorded = replayKey ?? database.prepare(`SELECT physical_replay_key FROM legacy_checkpoint_transcript_source_ids
      WHERE thread_id = ? AND checkpoint_id = ? AND message_id = ?`).get(input.threadId, input.checkpointId, sourceId)?.physical_replay_key
    const durable = recorded ?? database.prepare(`UPDATE thread_messages
      SET fork_replay_key = COALESCE(fork_replay_key, lower(hex(randomblob(16))))
      WHERE thread_id = ? AND message_id = ? RETURNING fork_replay_key`).get(input.threadId, messageId)?.fork_replay_key
    if (typeof durable !== "string") throw searchBootstrapSuperseded()
    database.prepare(`INSERT INTO legacy_checkpoint_transcript_source_ids
      (thread_id, checkpoint_id, message_id, source_index, content_key, physical_replay_key)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, checkpoint_id, message_id) DO UPDATE SET
        source_index = excluded.source_index, content_key = excluded.content_key,
        physical_replay_key = excluded.physical_replay_key`).run(
      input.threadId, input.checkpointId, sourceId, index, complete ? hashes.recoveryKeys[index] : null, durable
    )
  }
  const recordRetiredMembers = (checkpointId: string, retired: readonly RetiredLegacyMember[]) => {
    if (!retired.length) return
    const retire = database.prepare(`INSERT OR REPLACE INTO legacy_checkpoint_transcript_source_ids
      (thread_id, checkpoint_id, message_id, source_index, content_key) VALUES (?, ?, ?, ?, ?)`)
    for (const { id, index, aliasId } of retired)
      retire.run(input.threadId, checkpointId, id, index, LEGACY_RETIRED_MEMBER_PREFIX + JSON.stringify(aliasId))
    database.prepare(`UPDATE legacy_checkpoint_transcript_migrations SET
      search_projection_state = CASE WHEN search_projection_state = 'truncated' THEN 'truncated' ELSE 'unverified' END,
      updated_at = MAX(updated_at + 1, ?) WHERE thread_id = ? AND checkpoint_id = ?`)
      .run(Date.now(), input.threadId, checkpointId)
  }
  const rebindSourceMembers = (checkpointId: string, rebound: LegacyCopyProgress["rebound"]) => {
    if (!rebound.length) return
    const remove = database.prepare(`DELETE FROM legacy_checkpoint_transcript_source_ids
      WHERE thread_id = ? AND checkpoint_id = ? AND message_id = ? AND source_index = ?`)
    const insert = database.prepare(`INSERT INTO legacy_checkpoint_transcript_source_ids
      (thread_id, checkpoint_id, message_id, source_index, content_key) VALUES (?, ?, ?, ?, ?)`)
    const dropImport = database.prepare(`DELETE FROM legacy_checkpoint_transcript_imports
      WHERE thread_id = ? AND message_id = ?`)
    const transferable = database.prepare(`SELECT content_key, previous_content_key, provider_content_key, payload_content_key,
      source_turn_key, owned_by_migration, published_checkpoint_id, source_declared_occurrence, merged_checkpoint_ids, field_content_keys
      FROM legacy_checkpoint_transcript_imports
      WHERE thread_id = ? AND message_id = ? AND partial_version IS NULL AND rewrite_progress IS NULL`)
    const reinstate = database.prepare(`INSERT OR IGNORE INTO legacy_checkpoint_transcript_imports
      (thread_id, message_id, content_key, previous_content_key, provider_content_key, payload_content_key,
        source_turn_key, owned_by_migration, published_checkpoint_id, source_declared_occurrence, merged_checkpoint_ids, field_content_keys)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const transfers: SQLInputValue[][] = []
    for (const { oldId, index, physicalId } of rebound) {
      remove.run(input.threadId, checkpointId, oldId, index)
      if (physicalId !== input.messages[index].messageId) continue
      const receipt = transferable.get(input.threadId, oldId)
      if (typeof receipt?.content_key !== "string") continue
      dropImport.run(input.threadId, oldId)
      transfers.push([physicalId, receipt.content_key, receipt.previous_content_key, receipt.provider_content_key,
        receipt.payload_content_key, receipt.source_turn_key, receipt.owned_by_migration,
        receipt.published_checkpoint_id, receipt.source_declared_occurrence, receipt.merged_checkpoint_ids, receipt.field_content_keys])
    }
    for (const { index, key } of rebound) {
      insert.run(input.threadId, checkpointId, input.messages[index].messageId, index,
        key ?? hashes.recoveryKeys[index])
    }
    for (const transfer of transfers) {
      reinstate.run(input.threadId, ...transfer)
    }
  }
  const recordAppendPlacement = (checkpointId: string, placement: LegacyAppendPlacement) => {
    const remember = database.prepare(`INSERT INTO legacy_checkpoint_transcript_source_ids
      (thread_id, checkpoint_id, message_id, source_index, content_key) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, checkpoint_id, message_id) DO UPDATE SET source_index = excluded.source_index,
        content_key = CASE WHEN legacy_checkpoint_transcript_source_ids.content_key LIKE '${LEGACY_RETIRED_MEMBER_PREFIX}%'
          THEN legacy_checkpoint_transcript_source_ids.content_key ELSE excluded.content_key END`)
    for (const { id, index } of placement.adopted)
      remember.run(input.threadId, checkpointId, id, index, LEGACY_ADOPTED_MEMBER)
    recordRetiredMembers(checkpointId, placement.retired)
  }
  const clearSourceIds = () => {
    for (const table of ["legacy_checkpoint_transcript_source_ids", "legacy_checkpoint_transcript_sources"]) {
      database.prepare(`DELETE FROM ${table} WHERE thread_id = ? AND checkpoint_id = ?`)
        .run(input.threadId, input.checkpointId)
    }
  }
  const verifyRecoveryMembership = () => {
    if (input.prefixCopy) return
    database.prepare(`INSERT OR REPLACE INTO legacy_checkpoint_transcript_sources
      (thread_id, checkpoint_id, verified_at, transcript_revision) VALUES (?, ?, ?, ?)`
    ).run(input.threadId, input.checkpointId, Date.now(), input.transcriptRevision)
    const expired = `SELECT checkpoint_id FROM legacy_checkpoint_transcript_sources
      WHERE thread_id = ? ORDER BY verified_at DESC, checkpoint_id DESC LIMIT -1 OFFSET 8`
    for (const table of ["legacy_checkpoint_transcript_source_ids", "legacy_checkpoint_transcript_sources"]) {
      database.prepare(`DELETE FROM ${table} WHERE thread_id = ? AND checkpoint_id IN (${expired})`)
        .run(input.threadId, input.threadId)
    }
  }
  let guardRow: StatementSync | null = null
  const checkSearchWork = () => {
    throwIfCancelled(input.cancellation)
    if (publishStarted !== undefined && performance.now() - publishStarted > 80) {
      throw searchBootstrapNeedsForeground()
    }
  }
  const assertSearchGuard = () => {
    checkSearchWork()
    if (!scope || !guardRow) return
    assertLegacySearchThread(guardRow, input.threadId, scope)
    if (!input.sourceStillCurrent?.()) throw searchBootstrapSuperseded()
  }
  const finishOrdinalReservation = (checkpointId = input.checkpointId, progress = hashes.progressDigest,
    rebinding = false) => {
    const read = database.prepare(`SELECT ordinal_reservation, total_messages, append_ordinal_base, source_ordinal_gap, next_index,
      current_fragment_index
      FROM legacy_checkpoint_transcript_migrations
      WHERE thread_id = ? AND checkpoint_id = ? AND progress_key = ? AND status = 'reserving'`)
    const save = database.prepare(`UPDATE legacy_checkpoint_transcript_migrations SET
      ordinal_reservation = ?, status = ?, updated_at = ?
      WHERE thread_id = ? AND checkpoint_id = ? AND progress_key = ? AND status = 'reserving'`)
    const identity = [input.threadId, checkpointId, progress]
    for (;;) {
      writerTurn.wait()
      assertSearchGuard()
      if (!input.sourceStillCurrent?.()) throw searchBootstrapSuperseded()
      assertSourceFamily()
      database.exec("BEGIN IMMEDIATE")
      try {
        assertSearchGuard()
        const row = read.get(...identity)
        if (typeof row?.ordinal_reservation !== "string") throw searchBootstrapSuperseded()
        let reservation: LegacyOrdinalReservation | null = JSON.parse(row.ordinal_reservation)
        if (!reservation) throw searchBootstrapSuperseded()
        const priorCount = reservation.protectedPrefixCount
        database.exec("SAVEPOINT attempt_ordinal_reservation")
        const result = applyLegacyOrdinalReservationBatch(database, input.threadId, reservation)
        if (result === "changed") {
          database.exec("ROLLBACK TO attempt_ordinal_reservation")
          const replacement = priorCount === undefined ? null : prepareAppendPlacement(
            Number(row.append_ordinal_base ?? 0), priorCount, Number(row.total_messages), legacySourceOrdinalGaps(row.source_ordinal_gap), {
              checkpointId, offset: Number(row.next_index), rebinding,
              activeFragment: Number(row.current_fragment_index) > 0 ? Number(row.next_index) : undefined
            })
          overlapAudit.assertPrepared()
          if (!replacement) {
            database.exec("ROLLBACK")
            return false
          }
          reservation = replacement.reservation
          database.prepare("UPDATE thread_message_buckets SET next_ordinal = MAX(next_ordinal, ?) WHERE thread_id = ?")
            .run(replacement.nextOrdinal, input.threadId)
          recordAppendPlacement(checkpointId, replacement)
        }
        database.exec("RELEASE attempt_ordinal_reservation")
        const finished = result === "complete" || reservation === null
        save.run(finished ? null : JSON.stringify(reservation), finished ? "migrating" : "reserving",
          Date.now(), ...identity)
        assertSearchGuard()
        assertSourceFamily()
        if (finished) placementEpoch = currentEpoch()
        database.exec("COMMIT")
        writerTurn.released()
        if (finished) return true
        if (input.reservationDeadline !== undefined && performance.now() >= input.reservationDeadline) {
          const retry = new Error("Continue the committed history reservation in the next background slice")
          retry.name = CHECKPOINT_RUNTIME_PROJECTION_RESUME_REQUIRED
          throw retry
        }
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK")
        throw error
      }
    }
  }
  const finishPublishedReservation = () => {
    if (scope) {
      assertSearchGuard()
      assertSourceFamily()
      database.exec("COMMIT")
      writerTurn.released()
      publishStarted = undefined
      guardedCommittedEpoch = undefined
    }
    if (!finishOrdinalReservation()) throw searchBootstrapSuperseded()
    if (scope) {
      writerTurn.wait()
      database.exec("BEGIN IMMEDIATE")
      publishStarted = performance.now()
      guardedCommittedEpoch = currentEpoch()
      assertSearchGuard()
    }
  }
  let migratedMessages = 0
  let batches = 0
  const guardedCopies = new Set<string>()
  const countCopyBatch = (inserted: number) => {
    migratedMessages += inserted
    batches += 1
    if (!scope) {
      copied.migratedMessages += inserted
      copied.batches += 1
    }
  }
  try {
    throwIfCancelled(input.cancellation)
    configureLegacyTranscriptWriter(database)

    guardRow = scope ? prepareLegacySearchThreadGuard(database) : null
    assertSearchGuard()
    ensureLegacyTranscriptMigrationSchema(database)
    messageVersions = Boolean(database.prepare(`SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'thread_search_message_versions'`).get())
    const structureVersions = database.prepare(`SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'thread_search_structure_versions'`).get()
    readEpoch = structureVersions
      ? database.prepare("SELECT epoch FROM thread_search_structure_versions WHERE thread_id = ?") : null
    readVersion = messageVersions && structureVersions
      ? database.prepare("SELECT version FROM thread_search_message_versions WHERE thread_id = ? AND message_id = ?")
      : null
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

    const tooManyDurableRows = () => Number(database.prepare(`
      SELECT count(*) AS count FROM (SELECT 1 FROM thread_messages WHERE thread_id = ? LIMIT ?)
    `).get(input.threadId, SEARCH_LEGACY_MAX_PUBLISH_ROWS + 1)?.count) > SEARCH_LEGACY_MAX_PUBLISH_ROWS
    if (scope && (input.messages.length > SEARCH_LEGACY_MAX_PUBLISH_ROWS || tooManyDurableRows()))
      throw searchBootstrapNeedsForeground()
    const readState = database.prepare(LEGACY_COPY_STATE_SQL)
    let existingState = readState.get(input.threadId)
    if (existingState?.status === "migrating" && Number(existingState.current_fragment_index) > 0) {
      const active = parseJsonValue(existingState.active_fragment_revision)
      if (Array.isArray(active) && typeof active[0] === "string") {
        const current = database.prepare(`SELECT m.message_id, m.role, m.provider_source_id,
          m.provider_occurrence, i.published_checkpoint_id, i.merged_checkpoint_ids FROM thread_messages AS m
          JOIN legacy_checkpoint_transcript_imports AS i USING (thread_id, message_id)
          WHERE m.thread_id = ? AND m.message_id = ? AND i.partial_version IS NOT NULL`).get(input.threadId, active[0])
        if (current && (!inheritsLegacyPublication(input, current.published_checkpoint_id) ||
            legacyPublicationSources(null, current.merged_checkpoint_ids).some((ancestor) => !inheritsLegacyPublication(input, ancestor))) &&
            input.messages.some(
          (message) => !message.shadowSlot && message.role === current.role && matchesCheckpointProvider(current, message)
        )) throw searchBootstrapNeedsForeground()
      }
    }
    const uncertainOccurrences = new Set(input.messages.flatMap((message, index) =>
      message.sourceOccurrenceUncertain ? [index] : []))
    if (readVersion && existingState && hashes.revisableSlots.length) {
      const repairs = new Map<string, LegacyStreamRepair>()
      const epoch = currentEpoch()
      const columns = database.prepare("PRAGMA table_info(thread_messages)").all()
      const hasStreamAuthority = columns.some((column) => column.name === "stream_authority")
      const hasRecoveryIntegrity = columns.some((column) => column.name === "recovery_integrity")
      const imported = database.prepare(`SELECT content_key, previous_content_key, rewrite_progress, partial_version
        FROM legacy_checkpoint_transcript_imports WHERE thread_id = ? AND message_id = ? AND owned_by_migration = 1`)
      const activeIndex = existingState.status === "migrating" && Number(existingState.current_fragment_index) > 0
        ? Number(existingState.next_index) : -1
      const retainActiveCursor = activeIndex >= 0 && (matchSourcePrefix(existingState, Number(existingState.total_messages)) !== null ||
        publishedPrefixCount(existingState) !== null)
      const active = parseJsonValue(existingState.active_fragment_revision)
      for (const index of hashes.revisableSlots) {
        checkSearchWork()
        if (retainActiveCursor && index === activeIndex) continue
        const message = input.messages[index]
        const id = message.messageId
        const receipt = imported.get(input.threadId, id)
        if ((!receipt && !message.providerIdentityDeclared) ||
            (receipt?.content_key === contentKey(index) && !receipt.previous_content_key &&
              !receipt.rewrite_progress && receipt.partial_version == null)) continue
        const found = overlapAudit.reviseOccurrence(index, currentRevision(id, epoch), hasStreamAuthority)
        if (found?.repair) {
          if (retainActiveCursor && Array.isArray(active) && active[0] === found.repair.message.messageId) continue
          if (input.occurrenceSnapshot && input.occurrenceSnapshot.epoch !== epoch) throw searchBootstrapSuperseded()
          repairs.set(found.repair.message.messageId, found.repair)
        }
        if (found?.retained) uncertainOccurrences.add(index)
        if (found?.previousContentKey) supersededImportKeys.set(index, found.previousContentKey)
        if (found?.physicalImport) confirmedImportLocations.set(index, found.physicalImport)
      }
      overlapAudit.assertPrepared()
      if (repairs.size) {
        // An otherwise valid interval can belong to a source with later
        // conflicting anchors. Verify the complete durable placement first.
        const layout = prepareInitialLayout({ checkpointId: String(existingState.checkpoint_id),
          classifyStreams: false, inferNative: false, allowPendingImplicit: true }, existingState)
        overlapAudit.assertPrepared()
        const ordinals = layout?.ordinals.filter((ordinal) => ordinal !== null)
        if (!ordinals || ordinals.some((ordinal, index) => index > 0 && ordinal <= ordinals[index - 1]))
          throw searchBootstrapNeedsForeground()
        overlapAudit.flushRepairs(repairs, { hasStreamAuthority, hasRecoveryIntegrity })
      }
    }
    let resumesPublishedContinuation = false
    const pendingReservation = database.prepare(`SELECT checkpoint_id, progress_key, provider_progress_key, continuation_ancestor,
      source_layout_key, total_messages, next_index, active_fragment_revision,
      current_fragment_index, ordinal_reservation FROM legacy_checkpoint_transcript_migrations
      WHERE thread_id = ? AND status = 'reserving'`)
      .get(input.threadId)
    if (pendingReservation) {
      const count = Number(pendingReservation.total_messages)
      const sameSource = matchSourcePrefix(pendingReservation, count)
      const plan = objectRecord(parseJsonValue(pendingReservation.ordinal_reservation))
      const ancestor = pendingReservation.continuation_ancestor
      // Reserving moves existing rows before any child payload becomes visible.
      // Retain the verified parent while the child source can still change.
      resumesPublishedContinuation = plan?.continuesPublishedHistory === true &&
        (pendingReservation.checkpoint_id === input.checkpointId && pendingReservation.progress_key === hashes.progressDigest ||
          (typeof ancestor === "string" && input.descendsFrom?.(ancestor) === true))
      const hasPublishedRows = Number(pendingReservation.next_index) > 0 || Number(pendingReservation.current_fragment_index) > 0
      const mapped = sameSource && finishOrdinalReservation(String(pendingReservation.checkpoint_id),
        String(pendingReservation.progress_key), sameSource === "provider" || sameSource === "layout")
      if (!mapped && hasPublishedRows) throw searchBootstrapNeedsForeground()
    }

    if (scope) {
      writerTurn.wait()
      database.exec("BEGIN IMMEDIATE")
      publishStarted = performance.now()
      guardedCommittedEpoch = currentEpoch()
      assertSearchGuard()
      if (tooManyDurableRows()) throw searchBootstrapNeedsForeground()
    }
    existingState = readState.get(input.threadId)
    let adoptedProgress: LegacyCopyProgress | null = null
    const previousCount = Number(existingState?.total_messages ?? 0)
    const wholePrefixMatch = existingState ? matchSourcePrefix(existingState, previousCount) : null
    const copiedPrefix = existingState && !wholePrefixMatch ? publishedPrefixCount(existingState) : null
    const prefixMatch = wholePrefixMatch ?? (copiedPrefix !== null ? "layout" : null)
    const protectedPrefix = copiedPrefix ?? previousCount
    if ((existingState?.status === "migrating" || existingState?.status === "complete") &&
        !usesLegacyTranscriptSlots(existingState) && Number.isSafeInteger(previousCount) &&
        previousCount > 0 && prefixMatch &&
        !database.prepare("SELECT 1 FROM thread_graph_transcript_boundaries WHERE thread_id = ? LIMIT 1").get(input.threadId) &&
        (previousCount < input.messages.length || prefixMatch !== "raw" ||
          existingState.checkpoint_id !== input.checkpointId ||
          (existingState.status === "complete" && existingState.source_key !== input.sourceKey))) {
      let reservation: LegacyOrdinalReservation | null = null
      beginBatch()
      try {
        assertSearchGuard()
        const current = readState.get(input.threadId)
        if (!current || current.checkpoint_id !== existingState.checkpoint_id ||
            current.progress_key !== existingState.progress_key || current.status !== existingState.status)
          throw searchBootstrapSuperseded()
        const oldCheckpoint = String(current.checkpoint_id)
        const base = Number(current.append_ordinal_base ?? 0)
        const originalProgress = prepareProgress(current, protectedPrefix,
          prefixMatch === "provider" || prefixMatch === "layout", prefixMatch === "layout")
        if (originalProgress) {
          const placement = prepareAppendPlacement(base, protectedPrefix, input.messages.length, legacySourceOrdinalGaps(current.source_ordinal_gap),
            copiedPrefix === null ? null : { checkpointId: oldCheckpoint, offset: Number(current.next_index),
              rebinding: true, activeFragment: Number(current.current_fragment_index) > 0 ? Number(current.next_index) : undefined })
          overlapAudit.assertPrepared()
          if (placement) {
            const verifiedNativeSuffix = placement.adopted.filter(({ index }) =>
              verifyNativeObservation(index, null))
            overlapAudit.assertPrepared()
            reservation = placement.reservation
            if (oldCheckpoint !== input.checkpointId) {
              database.prepare(`INSERT OR REPLACE INTO legacy_checkpoint_transcript_source_ids
              (thread_id, checkpoint_id, message_id, source_index, content_key, physical_replay_key)
                SELECT thread_id, ?, message_id, source_index, content_key, physical_replay_key FROM legacy_checkpoint_transcript_source_ids
                WHERE thread_id = ? AND checkpoint_id = ?`).run(input.checkpointId, input.threadId, oldCheckpoint)
            }
            const originalTiming = preserveTimingPrefix(current, oldCheckpoint, protectedPrefix)
            for (const { index } of verifiedNativeSuffix) recordImportedMessage(index, undefined, false)
            database.prepare(`UPDATE legacy_checkpoint_transcript_migrations SET checkpoint_id = ?,
              total_messages = ?, progress_key = ?, provider_progress_key = ?, source_layout_key = ?,
              source_lane_key = ?, source_lane_count = ?, shadow_slots = ?,
              updated_at = ?, timing_source_prefix = ?,
              adopted_source_start = COALESCE(adopted_source_start, ?),
              search_projection_state = ?,
              ordinal_reservation = ?, status = ? WHERE thread_id = ?`)
              .run(input.checkpointId, input.messages.length, hashes.progressDigest, hashes.providerProgressDigest,
                hashes.layoutDigest, hashes.laneDigest, hashes.laneCount, hashes.storedShadowSlots, Date.now(), originalTiming,
                protectedPrefix, originalProgress.coverage === "durable-overlap" && current.search_projection_state !== "truncated"
                  ? "unverified" : current.search_projection_state,
                reservation ? JSON.stringify(reservation) : null,
                reservation ? "reserving" : "migrating", input.threadId)
            database.prepare(`UPDATE thread_message_buckets SET next_ordinal = MAX(next_ordinal, ?) WHERE thread_id = ?`)
              .run(placement.nextOrdinal, input.threadId)
            if (originalProgress.restartActive || originalProgress.activeReplacement) {
              const published = parseJsonValue(current.active_fragment_revision)
              if (Array.isArray(published) && published.length >= 5) {
                const active = Number(current.next_index)
                database.prepare(`UPDATE legacy_checkpoint_transcript_migrations SET active_fragment_revision = ?
                  WHERE thread_id = ?`).run(serializeActiveFragmentCursor(published, contentKey(active),
                    activeLayout(active), published[7]), input.threadId)
              }
            }
            rebindSourceMembers(input.checkpointId, originalProgress.rebound)
            recordAppendPlacement(input.checkpointId, placement)
            recordRetiredMembers(input.checkpointId, originalProgress.retired)
            publishOccurrenceRevisions()
            adoptedProgress = originalProgress
          }
        }
        overlapAudit.assertPrepared()
        commitBatch()
      } catch (error) {
        if (database.isTransaction) rollbackBatch()
        throw error
      }
      if (reservation) finishPublishedReservation()
      existingState = readState.get(input.threadId)
    }
    const completedScopedPrefix = existingState?.status === "migrating" && existingState.scoped_order === 1 &&
      existingState.checkpoint_id === input.checkpointId && prefixMatch === "raw" &&
      previousCount < input.messages.length && Number(existingState.next_index) === previousCount &&
      Number(existingState.current_fragment_index) === 0
    const completedSource = existingState?.status === "complete" || completedScopedPrefix
    // The checkpoint that owned positional message times can be older than the
    // source currently being audited. Keep it with the migration across revalidations.
    const timingCheckpoint = String(existingState?.timing_checkpoint_id ?? existingState?.checkpoint_id ?? input.checkpointId)
    const isTimingCheckpoint = timingCheckpoint === input.checkpointId
    const timingPrefix = parseJsonValue(existingState?.timing_source_prefix)
    const timingCount = Array.isArray(timingPrefix) ? Number(timingPrefix[0]) : 0
    const timingOriginalMessages = existingState?.timing_source_prefix == null
      ? isTimingCheckpoint ? input.messages : null
      : Number.isSafeInteger(timingCount) && timingCount > 0 && timingCount <= input.messages.length &&
          Array.isArray(timingPrefix) &&
          (timingPrefix[2] ?? timingPrefix[1]) === legacyPrefixDigest(hashes.contentKeys, timingCount, assertSearchGuard)
        ? input.messages.slice(0, timingCount) : null
    // A canceled reservation has only moved ordinals while retaining the old
    // order. A changed source or structural edit can plan again from those rows.
    const unresolvedReservation = existingState?.status === "reserving"
    const changedCopySource = existingState?.progress_key != null &&
      existingState.progress_key !== hashes.progressDigest
    const unpublishedCopy = !completedSource && existingState &&
      Number(existingState.next_index) === 0 && Number(existingState.current_fragment_index) === 0
    const reservedAncestor = existingState?.continuation_ancestor
    const unpublishedContinuation = unpublishedCopy && existingState?.continuation_verified === 1 &&
      typeof reservedAncestor === "string" && input.descendsFrom?.(reservedAncestor) === true
    const activeCopy = parseJsonValue(existingState?.active_fragment_revision)
    const activeRow = changedCopySource && !completedSource && Array.isArray(activeCopy) && typeof activeCopy[0] === "string"
      ? database.prepare(`SELECT message_id, role, provider_source_id, provider_occurrence FROM thread_messages
        WHERE thread_id = ? AND message_id = ?`).get(input.threadId, activeCopy[0]) : null
    const activeSlot = activeRow ? input.messages.findIndex((message) => !message.shadowSlot &&
      message.role === activeRow.role && matchesCheckpointProvider(activeRow, message)) : -1
    const activeOmitted = activeRow && activeSlot < 0
    const activeImport = activeRow && activeSlot >= 0 ? database.prepare(`SELECT provider_content_key, partial_version
      FROM legacy_checkpoint_transcript_imports WHERE thread_id = ? AND message_id = ?`)
      .get(input.threadId, activeRow.message_id as string) : null
    const activeRestored = activeImport && activeImport.partial_version === null &&
      activeImport.provider_content_key === hashes.providerContentKeys[activeSlot]
    const replanChangedCopy = !completedSource && changedCopySource && (unpublishedCopy || (readVersion && existingState?.status === "migrating" &&
      !adoptedProgress && (Number(existingState.current_fragment_index) === 0 || activeOmitted || activeRestored)))
    const scopedCopy = existingState?.status === "migrating" && existingState.scoped_order === 1 &&
      Number(existingState.current_fragment_index) > 0 && !replanChangedCopy &&
      (existingState.checkpoint_id !== input.checkpointId || changedCopySource)
      ? existingState : undefined
    if (scopedCopy) {
      const state = scopedCopy
      const checkpointId = String(state.checkpoint_id)
      const activeIndex = Number(state.next_index)
      const activeCount = Number(state.current_fragment_index)
      const count = Number(state.total_messages)
      const layoutKey = activeLayout(activeIndex)
      if (!inheritsLegacyPublication(input, checkpointId) || count !== input.messages.length ||
          !Array.isArray(activeCopy) || typeof activeCopy[0] !== "string" || activeCopy[3] !== activeCount ||
          typeof activeCopy[6] !== "string" || activeCopy[6] !== layoutKey)
        throw searchBootstrapNeedsForeground()
      beginBatch()
      try {
        assertSearchGuard()
        if (JSON.stringify(readState.get(input.threadId)) !== JSON.stringify(state))
          throw searchBootstrapSuperseded()
        const progress = prepareProgress(state, count, true, true, true)
        overlapAudit.assertPrepared()
        const ownership = database.prepare(`SELECT 1 FROM legacy_checkpoint_transcript_imports
          WHERE thread_id = ? AND message_id = ? AND owned_by_migration = 1 AND partial_version = ?`)
          .get(input.threadId, activeCopy[0], activeCopy[2])
        if (!progress || progress.activeMessageId !== activeCopy[0] ||
            (!progress.nativeActive && (!ownership || progress.coverage !== "exact" ||
              progress.activeReplacement || progress.activeRevision?.version !== activeCopy[2])))
          throw searchBootstrapNeedsForeground()

        // Preserve the reserved positions instead of classifying a partially
        // published row as a completed native observation of the new source.
        const graphFences = readLegacyGraphFences(database, input)
        let nextFence = 0
        let previousOrdinal = -1
        let foundActive = false
        const slots = database.prepare(`SELECT message_index, ordinal, provider_source_id, role, provider_occurrence
          FROM legacy_checkpoint_transcript_slots WHERE thread_id = ? AND checkpoint_id = ?
          ORDER BY message_index`)
        for (const slot of slots.iterate(input.threadId, checkpointId)) {
          checkSearchWork()
          const index = Number(slot.message_index)
          const ordinal = Number(slot.ordinal)
          const message = input.messages[index]
          if (!message || message.shadowSlot || index < activeIndex || ordinal <= previousOrdinal)
            throw searchBootstrapNeedsForeground()
          const [provider, role, occurrence] = legacySlotIdentity(message)
          if (slot.provider_source_id !== provider || slot.role !== role || slot.provider_occurrence !== occurrence)
            throw searchBootstrapNeedsForeground()
          while (nextFence < graphFences.length && graphFences[nextFence].index <= index) nextFence += 1
          if ((nextFence > 0 && graphFences[nextFence - 1].ordinal >= ordinal) ||
              (nextFence < graphFences.length && graphFences[nextFence].ordinal <= ordinal))
            throw searchBootstrapNeedsForeground()
          previousOrdinal = ordinal
          foundActive ||= index === activeIndex
        }
        if (!foundActive) throw searchBootstrapNeedsForeground()
        if (checkpointId !== input.checkpointId) {
          database.prepare(`INSERT OR REPLACE INTO legacy_checkpoint_transcript_source_ids
            (thread_id, checkpoint_id, message_id, source_index, content_key, physical_replay_key)
            SELECT thread_id, ?, message_id, source_index, content_key, physical_replay_key
            FROM legacy_checkpoint_transcript_source_ids WHERE thread_id = ? AND checkpoint_id = ?`)
            .run(input.checkpointId, input.threadId, checkpointId)
          database.prepare(`UPDATE legacy_checkpoint_transcript_slots SET checkpoint_id = ?
            WHERE thread_id = ? AND checkpoint_id = ?`).run(input.checkpointId, input.threadId, checkpointId)
        }
        const activeRevision = serializeActiveFragmentCursor(activeCopy,
          progress.restartActive ? contentKey(activeIndex) : null, layoutKey, null)
        database.prepare(`UPDATE legacy_checkpoint_transcript_migrations SET checkpoint_id = ?,
          progress_key = ?, source_key = ?, active_fragment_revision = ?, timing_source_prefix = ?,
          provider_progress_key = ?, source_layout_key = ?, source_lane_key = ?, source_lane_count = ?,
          shadow_slots = ?, copied_layout_key = ?, updated_at = ? WHERE thread_id = ? AND checkpoint_id = ?`)
          .run(input.checkpointId, progressKey(), input.sourceKey, activeRevision,
            preserveTimingPrefix(state, checkpointId, count),
            hashes.providerProgressDigest, hashes.layoutDigest, hashes.laneDigest,
            hashes.laneCount, hashes.storedShadowSlots, hashes.copiedLayoutKeys[activeIndex],
            Date.now(), input.threadId, checkpointId)
        rebindSourceMembers(input.checkpointId, progress.rebound)
        for (const { index, messageId } of progress.verifiedAliases)
          recordVerifiedSourceAlias(index, messageId, true)
        recordLegacyCheckpointParent(database, input)
        commitBatch()
      } catch (error) {
        rollbackBatch()
        throw error
      }
      existingState = readState.get(input.threadId)
    }
    const sameMigration = !completedSource && !unresolvedReservation &&
      !replanChangedCopy && existingState?.checkpoint_id === input.checkpointId
    if (sameMigration && existingState?.progress_key && existingState.progress_key !== progressKey())
      throw searchBootstrapNeedsForeground()
    const progressState = existingState && !adoptedProgress && !completedSource && !unresolvedReservation &&
      !replanChangedCopy && (scope || sameMigration)
      ? existingState : null
    if (progressState && progressState.checkpoint_id !== input.checkpointId) throw searchBootstrapNeedsForeground()
    const priorProgress = progressState ? prepareProgress(progressState, input.messages.length) : null
    overlapAudit.assertPrepared()
    if (progressState && !priorProgress) throw searchBootstrapNeedsForeground()
    if (progressState && priorProgress?.retired.length) {
      beginBatch()
      try {
        if (JSON.stringify(readState.get(input.threadId)) !== JSON.stringify(progressState))
          throw searchBootstrapSuperseded()
        const confirmed = prepareProgress(progressState, input.messages.length)
        overlapAudit.assertPrepared()
        if (!confirmed) throw searchBootstrapNeedsForeground()
        recordRetiredMembers(input.checkpointId, confirmed.retired)
        commitBatch()
      } catch (error) {
        rollbackBatch()
        throw error
      }
    }
    // A newer checkpoint can omit older rows, so only the original source can
    // resolve an older copy's unknown coverage. Known loss survives that rollover.
    const previousProjection = existingState?.search_projection_state
    const previousOverlap = previousProjection === "overlap-unverified"
    const replacedUnprovenCopy = (changedCopySource && unpublishedCopy) || replanChangedCopy ||
      (existingState && existingState.checkpoint_id !== input.checkpointId &&
        (!completedSource || (previousProjection == null && timingCheckpoint !== NATIVE_DURABLE_CHECKPOINT_ID)))
    const legacyReasoningVisibilityLoss = existingState?.checkpoint_id === input.checkpointId &&
      previousProjection == null && timingCheckpoint !== NATIVE_DURABLE_CHECKPOINT_ID &&
      input.messages.some((message) => !message.reasoning &&
        normalizeVisibleReasoningText(message.legacyReasoning ?? undefined))
    const previousOccurrenceProofs = existingState ? readPendingOccurrenceCoverage(existingState) : null
    // An omission keeps the earlier coverage obligation pending. A later
    // descendant can discharge it only by restoring the ordered raw claims
    // with the same payload or a proven extension of a text reply.
    const pendingOccurrenceProofs = previousOccurrenceProofs?.filter((proof) =>
      !coversPendingOccurrence(input, proof, overlapAudit, checkSearchWork)) ?? []
    overlapAudit.assertPrepared()
    let searchProjectionState: LegacySearchProjectionState =
      previousProjection === "truncated" || legacyReasoningVisibilityLoss ||
      input.messages.some((message) => message.searchProjectionTruncated)
        ? "truncated"
        : (previousProjection === "unverified" && (existingState?.occurrence_only !== 1 || !previousOccurrenceProofs)) ||
            priorProgress?.coverage === "durable-overlap" || replacedUnprovenCopy
          ? "unverified"
          : previousOverlap && sameMigration ? "overlap-unverified" : "complete"
    const occurrenceUnresolved = () => uncertainOccurrences.size > 0 || pendingOccurrenceProofs.length > 0
    const uncertaintyVersion = () => occurrenceUnresolved() ? input.occurrenceSnapshot?.version ?? null : null
    const reportedProjection = (): LegacySearchProjectionState => occurrenceUnresolved() && searchProjectionState === "complete"
      ? "unverified" : searchProjectionState
    const publishOccurrenceCoverage = () => {
      const rawPending = new Set<number>()
      for (const index of uncertainOccurrences) {
        const message = input.messages[index]
        rawPending.add(message.sourceIndex ?? index)
        for (const { payload } of message.previousCopies ?? []) {
          if (payload.sourceIndex !== undefined) rawPending.add(payload.sourceIndex)
        }
      }
      const pendingSlots = [...rawPending].sort((a, b) => a - b)
      const lastClaim = pendingSlots.at(-1) ?? -1
      const proofs = [...pendingOccurrenceProofs]
      const key = input.sourcePrefixKeys[lastClaim]
      if (key) {
        const count = lastClaim + 1
        const claims: PendingOccurrenceClaim[] = []
        const knownOwners = new Map<string, Set<string>>()
        const pendingIdentities = new Set(pendingSlots.map((index) => input.sourceClaims[index]?.identity))
        for (const [index, message] of resolvedLegacySourceSlots(input.messages)) {
          const raw = input.sourceClaims[index]
          if (!raw || rawPending.has(index) || !pendingIdentities.has(raw.identity)) continue
          const owners = knownOwners.get(raw.identity) ?? new Set()
          owners.add(legacyCheckpointProviderIdentity(message))
          knownOwners.set(raw.identity, owners)
        }
        let remaining = MAX_PENDING_OCCURRENCE_PROJECTION_BYTES -
          Buffer.byteLength(JSON.stringify(pendingOccurrenceProofs))
        if (pendingSlots.length <= SEARCH_LEGACY_MAX_PUBLISH_ROWS) {
          for (const index of pendingSlots) {
            checkSearchWork()
            const raw = input.sourceClaims[index]
            if (!raw || remaining <= 0) break
            const projection = overlapAudit.proof(raw.message, raw.message.contentFragments ?? [], index) ?? undefined
            const excludedOwners = [...knownOwners.get(raw.identity) ?? []]
            const claim = { key: raw.key, identity: raw.identity, projection, excludedOwners }
            remaining -= Buffer.byteLength(JSON.stringify(claim))
            if (remaining >= 0) claims.push(claim)
          }
          overlapAudit.assertPrepared()
        }
        proofs.push({ checkpointId: input.checkpointId, count, key, pendingCount: pendingSlots.length, claims })
      }
      const retained = proofs.length > 0 && proofs.length <= MAX_PENDING_OCCURRENCE_PROOFS
      if (proofs.length > MAX_PENDING_OCCURRENCE_PROOFS && searchProjectionState !== "truncated") {
        searchProjectionState = "unverified"
      }
      database.prepare(`UPDATE legacy_checkpoint_transcript_migrations
        SET search_projection_state = ?, occurrence_unverified_version = ?, occurrence_only = ?,
          occurrence_source_count = ?, occurrence_source_key = ?
        WHERE thread_id = ? AND checkpoint_id = ? AND status = 'complete'`).run(
        reportedProjection(), uncertaintyVersion(),
        Number(retained && searchProjectionState === "complete"), retained ? Math.max(...proofs.map(({ count }) => count)) : null,
        retained ? JSON.stringify(proofs) : null, input.threadId, input.checkpointId
      )
    }
    const noteOutstandingPartialCopy = () => {
      if (searchProjectionState !== "truncated" && database.prepare(`SELECT 1
        FROM legacy_checkpoint_transcript_imports WHERE thread_id = ? AND partial_version IS NOT NULL LIMIT 1`)
        .get(input.threadId)) searchProjectionState = "unverified"
    }
    if (existingState?.status === "complete" && previousProjection === reportedProjection() &&
        (existingState.occurrence_unverified_version ?? null) === uncertaintyVersion() &&
        existingState.checkpoint_id === input.checkpointId &&
        existingState.source_key === input.sourceKey) {
      if (!scope) {
        migrateLegacyMessageTimes(
          database, input.threadId, String(existingState.checkpoint_id),
          timingOriginalMessages, assertSearchGuard, writerTurn, input.sourceKey
        )
      }
      return {
        checkpointId: input.checkpointId,
        totalMessages: input.messages.length,
        migratedMessages: 0,
        batches: 0,
        payloadBytes: input.payloadBytes,
        searchProjectionState: reportedProjection()
      }
    }
    let appendOrdinalBase = sameMigration && existingState?.append_ordinal_base != null
      ? Number(existingState.append_ordinal_base)
      : null
    let ordinalGaps = sameMigration ? legacySourceOrdinalGaps(existingState?.source_ordinal_gap) : []
    let scopedOrder = sameMigration && usesLegacyTranscriptSlots(existingState)
    const legacyUnscopedSlots = scopedOrder && existingState?.scoped_order === 0
    const ordinalAt = (index: number) => legacySourceOrdinal(appendOrdinalBase ?? 0, ordinalGaps, index)
    let appendFromOrdinal: number | null = null
    const messageColumns = database.prepare("PRAGMA table_info(thread_messages)").all()
    const hasStreamAuthority = messageColumns.some((column) => column.name === "stream_authority")
    const hasRecoveryIntegrity = messageColumns.some((column) => column.name === "recovery_integrity")
    const unclassifiedTranscript = !existingState || previousOverlap
    const pendingOverlaps = new Map<string, Array<LegacyOverlapProof | null>>()
    const expectedOverlaps = new Map<string, LegacyOverlapProof | null>()
    const requiredForeground = new Map<string, LegacyOverlapProof | null>()
    const streamRepairs = new Map<string, LegacyStreamRepair>()
    const flagUnverifiedOverlap = (messageId: string, proof: LegacyOverlapProof | null) => {
      if (searchProjectionState === "complete") searchProjectionState = "overlap-unverified"
      const previous = pendingOverlaps.get(messageId) ?? []
      if (previous.some((item) => item?.digest === proof?.digest)) return
      const bounded = proof && previous.filter(Boolean).length < MAX_LEGACY_OVERLAP_PROOFS ? proof : null
      if (!previous.some((item) => item?.digest === bounded?.digest)) previous.push(bounded)
      pendingOverlaps.set(messageId, previous)
    }
    const noteStreamOverlap = (message: DurableLegacyCheckpointMessage, authoritative = true) => {
      const { messageId } = message
      if (!expectedOverlaps.has(messageId)) {
        expectedOverlaps.set(messageId, overlapAudit.proof(message, message.contentFragments ?? []))
      }
      const proof = expectedOverlaps.get(messageId) ?? null
      flagUnverifiedOverlap(messageId, proof)
      if (!unclassifiedTranscript && !authoritative) requiredForeground.set(messageId, proof)
    }
    const reconcilePreviousOverlaps = () => {
      if (!existingState || previousProjection === "complete") return
      const previous = database.prepare(`SELECT message_id, projection_proof FROM legacy_checkpoint_search_overlaps
        WHERE thread_id = ?`).all(input.threadId)
      for (const row of previous) {
        checkSearchWork()
        const messageId = String(row.message_id)
        for (const proof of decodeLegacyOverlapProofs(row.projection_proof)) {
          flagUnverifiedOverlap(messageId, proof)
        }
      }
    }
    const storePendingOverlaps = (applyRecoveredStreams: (() => void) | undefined, proofEpoch = currentEpoch()) => {
      if (!pendingOverlaps.size) {
        overlapAudit.assertPrepared()
        applyRecoveredStreams?.()
        database.prepare("DELETE FROM legacy_checkpoint_search_overlaps WHERE thread_id = ?").run(input.threadId)
        return
      }
      const read = createStoredLegacyOverlapReader(database, input.threadId, assertSearchGuard)
      const structureEpoch = currentEpoch()
      const add = database.prepare(`INSERT INTO legacy_checkpoint_search_overlaps
        (thread_id, message_id, projection_proof, structure_epoch, message_version) VALUES (?, ?, ?, ?, ${messageVersions
          ? "COALESCE((SELECT version FROM thread_search_message_versions WHERE thread_id = ? AND message_id = ?), 0)"
          : "0"})`)
      let remainingProofBytes = 4 * 1024 * 1024
      const unresolved = new Map<string, string>()
      let needsForeground = false
      // Audit the final projection using the validated durable revision and
      // the exact planned repairs, then store receipts with the resulting version.
      for (const [messageId, proofs] of pendingOverlaps) {
        checkSearchWork()
        const repair = streamRepairs.get(messageId)
        const revision = readVersion ? repair?.revision ?? currentRevision(messageId, proofEpoch) : null
        const stored = !revision && (proofs.some(Boolean) || requiredForeground.get(messageId))
          ? read(messageId) : null
        const covers = (proof: LegacyOverlapProof | null | undefined): boolean => {
          if (!proof) return false
          if (revision) return overlapAudit.coversStored(messageId, revision, proof, repair)
          return Boolean(stored && overlapAudit.covers(stored.payload, stored.parts, proof))
        }
        if (requiredForeground.has(messageId) && !covers(requiredForeground.get(messageId)))
          needsForeground = true
        const remaining = proofs.filter((proof) => !covers(proof))
        if (!remaining.length) continue
        let serialized = JSON.stringify(remaining)
        const bytes = Buffer.byteLength(serialized)
        if (bytes > remainingProofBytes) serialized = "[null]"
        else remainingProofBytes -= bytes
        unresolved.set(messageId, serialized)
      }
      overlapAudit.assertPrepared()
      if (needsForeground) throw searchBootstrapNeedsForeground()
      applyRecoveredStreams?.()
      database.prepare("DELETE FROM legacy_checkpoint_search_overlaps WHERE thread_id = ?").run(input.threadId)
      for (const [messageId, serialized] of unresolved) {
        checkSearchWork()
        add.run(input.threadId, messageId, serialized, structureEpoch,
          ...(messageVersions ? [input.threadId, messageId] : []))
      }
      if (!unresolved.size && searchProjectionState === "overlap-unverified") searchProjectionState = "complete"
    }
    const recoveredStreams: number[] = []
    const planRecoveredStreams = (): (() => void) | undefined => {
      if (!recoveredStreams.length) return
      const read = readVersion ? null : createLegacyStreamAuthorityReader(database, hasStreamAuthority)
      const readUnversioned = readVersion ? null : createLegacyStreamReader(database, input.threadId, assertSearchGuard)
      const nativeOwner = database.prepare(`SELECT published_checkpoint_id, merged_checkpoint_ids
        FROM legacy_checkpoint_transcript_imports
        WHERE thread_id = ? AND message_id = ? AND owned_by_migration = 0`)
      const epoch = currentEpoch()
      for (const index of recoveredStreams) {
        const message = input.messages[index]
        checkSearchWork()
        const revision = currentRevision(message.messageId, epoch)
        let evidence: LegacyStreamEvidence | null
        if (readUnversioned && read) {
          const row = read.get(input.threadId, message.messageId)
          if (row?.role !== "assistant" || !matchesCheckpointProvider(row, message))
            throw searchBootstrapSuperseded()
          evidence = { relations: compareLegacyStream(message, readUnversioned(message)),
            authority: currentLegacyStreamAuthority(row) }
        } else {
          evidence = overlapAudit.recoverStream(message, revision, hasStreamAuthority)
        }
        if (!evidence) continue
        const { authority, relations } = evidence
        const bodySnapshot = (authority & LEGACY_STREAM_BODY) !== 0
        if (relations.body === "different") {
          noteStreamOverlap(message, bodySnapshot)
          continue
        }
        let fields = 0
        if (relations.body === "durable-extends") noteStreamOverlap(message)
        if (relations.body === "checkpoint-extends") {
          if (bodySnapshot) noteStreamOverlap(message)
          else fields |= LEGACY_STREAM_BODY
        }
        if (relations.reasoning === "different") noteStreamOverlap(message)
        if (relations.reasoning === "missing") {
          if ((authority & LEGACY_STREAM_REASONING) !== 0) noteStreamOverlap(message)
          else fields |= LEGACY_STREAM_REASONING
        }
        const toolsSnapshot = (authority & LEGACY_STREAM_TOOLS) !== 0
        if (relations.tools === "durable-extends") noteStreamOverlap(message)
        if (relations.tools === "different") noteStreamOverlap(message, toolsSnapshot)
        if (relations.tools === "checkpoint-extends") {
          if (toolsSnapshot) noteStreamOverlap(message)
          else fields |= LEGACY_STREAM_TOOLS
        }
        if (fields) {
          if (!message.physicalOccurrenceBound) {
            noteStreamOverlap(message)
            continue
          }
          const receipt = nativeOwner.get(input.threadId, message.messageId)
          const owner = receipt?.published_checkpoint_id ?? null
          const mergedCheckpoints = receipt?.merged_checkpoint_ids ?? null
          if (legacyPublicationSources(owner, mergedCheckpoints).some((source) => !inheritsLegacyPublication(input, source))) {
            noteStreamOverlap(message)
            continue
          }
          const bodyWrites = (fields & LEGACY_STREAM_BODY) === 0 ? 0 : relations.fragmentBytes + relations.newFragmentBytes
          const writeBytes = relations.rowBytes + message.estimatedBytes + bodyWrites
          const append = bodyWrites > LEGACY_WRITER_BATCH_BYTES ? relations.append : undefined
          streamRepairs.set(message.messageId, { message, fields, revision, writeBytes, append,
            nativePublication: { previousCheckpoint: owner, mergedCheckpoints,
              contentKey: contentKey(index), providerKey: hashes.providerContentKeys[index], turnKey: publishedTurn(message.messageId) }
          })
        }
      }
      overlapAudit.assertPrepared()
      if (!streamRepairs.size) return

      const apply = () => {
        const snapshot = input.occurrenceSnapshot
        if (snapshot && (currentEpoch() !== snapshot.epoch ||
            Number(database.prepare(LEGACY_OCCURRENCE_VERSION_SQL).get(input.threadId)?.version ?? 0) !== snapshot.version))
          throw searchBootstrapSuperseded()
        const writeBytes = [...streamRepairs.values()].reduce((bytes, repair) => bytes + repair.writeBytes, 0)
        if (readVersion && !scope && writeBytes > LEGACY_WRITER_BATCH_BYTES) {
          // Above this size, publish the independently safe physical repairs
          // in short transactions. Reaudit coverage against the committed rows
          // in the next pass before marking this checkpoint complete.
          overlapAudit.flushRepairs(streamRepairs, { hasRecoveryIntegrity, hasStreamAuthority })
        }
        const { apply: write } = createLegacyStreamRepairWriter(database, input.threadId, input.checkpointId,
          hasRecoveryIntegrity, assertSearchGuard)
        for (const repair of streamRepairs.values()) {
          assertSearchGuard()
          write(repair)
        }
      }
      if (readVersion) return apply
      apply()
      return undefined
    }
    const interiorRows: LegacyOrdinalMove[] = []
    let continuationRanges: LegacyOrdinalRange[] | null = null
    let continuesPublishedHistory = false
    let continuationAncestor: string | null = null
    let interiorTailBoundary: number | null = null
    let interiorTailShift = 0
    let retainedMembers: RetiredLegacyMember[] = []
    let initialOptions: LegacyInitialOptions | undefined
    let initialOrdinals: readonly (number | null)[] = []
    let initialSourceAliases: LegacyInitialLayout["sourceAliases"] = new Map()
    let scopedSlots: Array<{ index: number; ordinal: number }> = []
    let initialGraphEpoch: number | undefined
    const recordInitialNativeObservations = () => {
      // A native row can first appear in any recovered layout. Its exact
      // checkpoint witness fences later repairs even in a mixed transcript.
      const verified: number[] = []
      for (const [index, ordinal] of initialOrdinals.entries()) {
        if (ordinal !== null && verifyNativeObservation(index, ordinal)) verified.push(index)
      }
      overlapAudit.assertPrepared()
      for (const index of verified) recordImportedMessage(index, undefined, false)
    }
    const confirmInitialLayout = () => {
      if (initialGraphEpoch !== undefined && initialGraphEpoch !== currentEpoch())
        throw searchBootstrapSuperseded()
      if (scope || !initialOptions) return
      if (JSON.stringify(readState.get(input.threadId)) !== JSON.stringify(existingState)) {
        throw searchBootstrapSuperseded()
      }
      const confirmed = prepareInitialLayout(initialOptions, existingState)
      overlapAudit.assertPrepared()
      if (!confirmed) throw searchBootstrapNeedsForeground()
    }
    if (!sameMigration && input.messages.length > 0) {
      // A checkpoint can contain a suffix of the durable transcript. Keep its
      // ownership proof in a read snapshot before publishing any new layout.
      initialOptions = {
        checkpointId: completedSource || (replanChangedCopy && !unpublishedCopy) ? String(existingState?.checkpoint_id) : undefined,
        classifyStreams: true,
        inferNative: unclassifiedTranscript && hasRecoveryIntegrity
      }
      const initial = prepareInitialLayout(initialOptions, existingState)
      overlapAudit.assertPrepared()
      if (!initial) throw searchBootstrapNeedsForeground()
      const sourceOrdinals = initial.ordinals
      initialOrdinals = sourceOrdinals
      initialSourceAliases = initial.sourceAliases
      const durableIds = initial.durableIds
      retainedMembers = initial.retired
      if ((retainedMembers.length || [...initial.providerConflicts].some((index) => !uncertainOccurrences.has(index)) ||
          [...initial.sourceAliases.values()].some((alias) => !alias.complete)) &&
          searchProjectionState !== "truncated")
        searchProjectionState = "unverified"
      recoveredStreams.push(...initial.recover)
      for (const index of initial.overlap) noteStreamOverlap(input.messages[index])
      const sharedOrdinals = sourceOrdinals.filter((ordinal) => ordinal !== null)
      if (sharedOrdinals.some((ordinal, index) => index > 0 && ordinal <= sharedOrdinals[index - 1])) {
        throw searchBootstrapNeedsForeground()
      }
      const priorSource = existingState?.checkpoint_id
      let amendsVerifiedContinuation = false
      if (completedSource && existingState?.continuation_verified === 1 && priorSource === input.checkpointId && sharedOrdinals.length) {
        const previousMember = database.prepare(`SELECT 1 FROM legacy_checkpoint_transcript_source_ids
          WHERE thread_id = ? AND checkpoint_id = ? AND message_id = ?`)
        amendsVerifiedContinuation = sourceOrdinals.some((ordinal, index) => ordinal !== null &&
          Boolean(previousMember.get(input.threadId, input.checkpointId, input.messages[index].messageId)))
      }
      continuesPublishedHistory = completedScopedPrefix || resumesPublishedContinuation || unpublishedContinuation || amendsVerifiedContinuation ||
        (typeof priorSource === "string" && input.publishedAncestor === priorSource) || Boolean(replanChangedCopy && !unpublishedCopy)
      if (continuesPublishedHistory) {
        const recorded = existingState?.continuation_ancestor
        continuationAncestor = input.publishedAncestor ??
          (typeof recorded === "string" && input.descendsFrom?.(recorded) ? recorded : null)
      }
      if (!sharedOrdinals.length && (continuesPublishedHistory || (completedSource && input.laterImplicitTurn))) {
        appendFromOrdinal = currentTail() + 1
        appendOrdinalBase = appendFromOrdinal
      }
      const removedSlots = new Set(retainedMembers.filter(({ index, aliasId }) =>
        aliasId === null && sourceOrdinals[index] === null).map(({ index }) => index))
      const ownsMessage = (index: number) => !input.messages[index].shadowSlot && !removedSlots.has(index)
      const graphFences = readLegacyGraphFences(database, input)
      if (graphFences.length) initialGraphEpoch = input.occurrenceSnapshot?.epoch ?? currentEpoch()
      if (sourceOrdinals.every((ordinal, index) => ordinal !== null || !ownsMessage(index))) {
        const originalOrder = isTimingCheckpoint && (!existingState ||
          (completedSource && existingState.checkpoint_id === input.checkpointId &&
            Number(existingState.total_messages) === input.messages.length)) &&
          sourceOrdinals.every((ordinal, index) => !ownsMessage(index) || ordinal === index)
        beginBatch()
        let inferredNative = false
        try {
          assertSearchGuard()
          confirmInitialLayout()
          reconcilePreviousOverlaps()
          inferredNative = initial.allVerifiedDurable
          recordInitialNativeObservations()
          storePendingOverlaps(planRecoveredStreams())
          clearSourceIds()
          recordSourceIds(0, input.messages.length)
          for (const [index, alias] of initialSourceAliases) recordVerifiedSourceAlias(index, alias.id, alias.complete, alias.key)
          recordRetiredMembers(input.checkpointId, retainedMembers)
          verifyRecoveryMembership()
          noteOutstandingPartialCopy()
          database.prepare(`INSERT INTO legacy_checkpoint_transcript_migrations
            (thread_id, checkpoint_id, total_messages, next_index, status, updated_at,
             timing_checkpoint_id, search_projection_state, append_ordinal_base, progress_key, provider_progress_key,
             source_layout_key, source_lane_key, source_lane_count, shadow_slots, continuation_verified, continuation_ancestor, scoped_order)
            SELECT thread_id, ?, ?, ?, 'complete', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0 FROM threads WHERE thread_id = ?
            ON CONFLICT(thread_id) DO UPDATE SET checkpoint_id = excluded.checkpoint_id,
              total_messages = excluded.total_messages, next_index = excluded.next_index,
              current_fragment_index = 0, active_fragment_revision = NULL, copied_layout_key = NULL,
              append_ordinal_base = excluded.append_ordinal_base, source_ordinal_gap = NULL,
              continuation_verified = excluded.continuation_verified, continuation_ancestor = excluded.continuation_ancestor,
              progress_key = excluded.progress_key, provider_progress_key = excluded.provider_progress_key,
              source_layout_key = excluded.source_layout_key, source_lane_key = excluded.source_lane_key,
              source_lane_count = excluded.source_lane_count, shadow_slots = excluded.shadow_slots,
              status = 'complete', updated_at = excluded.updated_at, source_key = NULL,
              timing_checkpoint_id = excluded.timing_checkpoint_id,
              search_projection_state = excluded.search_projection_state, scoped_order = 0`).run(
            input.checkpointId, input.messages.length, input.messages.length, Date.now(),
            inferredNative ? NATIVE_DURABLE_CHECKPOINT_ID : timingCheckpoint,
            searchProjectionState,
            sharedOrdinals.length && sourceOrdinals.every((ordinal, index) => !ownsMessage(index) || ordinal === sharedOrdinals[0] + index)
              ? sharedOrdinals[0] : null,
            progressKey(), hashes.providerProgressDigest, hashes.layoutDigest, hashes.laneDigest, hashes.laneCount,
            hashes.storedShadowSlots, Number(continuesPublishedHistory), continuationAncestor, input.threadId
          )
          publishOccurrenceRevisions()
          publishOccurrenceCoverage()
          database.prepare("DELETE FROM legacy_checkpoint_transcript_slots WHERE thread_id = ?").run(input.threadId)
          commitBatch()
        } catch (error) {
          rollbackBatch()
          throw error
        }
        if (scope) {
          assertSearchGuard()
          assertSourceFamily()
          database.exec("COMMIT")
        } else {
          migrateLegacyMessageTimes(database, input.threadId, input.checkpointId,
            (graphFences.length > 0 || (!inferredNative && (originalOrder || existingState?.timing_source_prefix != null)))
              ? timingOriginalMessages : null, assertSearchGuard, writerTurn, input.sourceKey)
        }
        return {
          checkpointId: input.checkpointId,
          totalMessages: input.messages.length,
          migratedMessages: 0,
          batches: 0,
          payloadBytes: input.payloadBytes,
          searchProjectionState: reportedProjection()
        }
      }
      if (graphFences.length) {
        const last = currentTail()
        const continuation = planLegacyContinuation(database, input.threadId, sourceOrdinals, last,
          checkSearchWork, graphFences)
        appendFromOrdinal = last + 1
        appendOrdinalBase = continuation.base
        ordinalGaps = continuation.gaps
        continuationRanges = continuation.ranges
        interiorTailShift = continuation.shift
        scopedOrder = true
        scopedSlots = continuation.reserved.flatMap((ordinal, index) =>
          sourceOrdinals[index] === null && ownsMessage(index) ? [{ index, ordinal }] : [])
      } else if (sharedOrdinals.length) {
        const bounds = database.prepare(`SELECT MIN(ordinal) AS first, MAX(ordinal) AS last
          FROM thread_messages WHERE thread_id = ?`).get(input.threadId)
        const firstDurable = Number(bounds?.first)
        const lastDurable = currentTail()
        const lastShared = sharedOrdinals.at(-1)!
        const firstShared = sharedOrdinals[0]
        const firstMissing = sourceOrdinals.findIndex((ordinal, index) => ordinal === null && ownsMessage(index))
        const firstMatch = sourceOrdinals.findIndex((ordinal) => ordinal !== null)
        const lastMatch = sourceOrdinals.findLastIndex((ordinal) => ordinal !== null)
        const hasMissingTail = input.messages.findLastIndex((_message, index) => ownsMessage(index)) > lastMatch
        const verifiedPriorLane = completedSource && existingState && previousCount > 0 &&
          ((lastMatch < firstMatch + previousCount && matchSourcePrefix(existingState, previousCount, firstMatch)) ||
            matchesPublishedLane(existingState, firstMatch, lastMatch))
        let enclosedGaps = true
        let missingStart = -1
        for (const [index, ordinal] of sourceOrdinals.entries()) {
          if (ordinal === null) {
            if (missingStart < 0 && ownsMessage(index)) missingStart = index
          } else if (missingStart >= 0) {
            enclosedGaps &&= input.messages[missingStart].exactInsertionFence === ordinal
            missingStart = -1
          }
        }
        const verifiedGapInsertion = enclosedGaps && firstMissing < lastMatch && missingStart < 0
        if (continuesPublishedHistory || verifiedGapInsertion) {
          const continuation = planLegacyContinuation(database, input.threadId, sourceOrdinals, lastDurable, checkSearchWork)
          appendFromOrdinal = lastDurable + 1
          appendOrdinalBase = continuation.base
          ordinalGaps = continuation.gaps
          continuationRanges = continuation.ranges
          interiorTailShift = continuation.shift
        } else if (firstMissing > lastMatch && lastShared === lastDurable) {
          appendFromOrdinal = lastDurable + 1
          appendOrdinalBase = lastDurable - lastMatch
        } else if (
          (firstMatch === 0 || firstShared === firstDurable) &&
          Number(database.prepare(`SELECT COUNT(*) AS count FROM (
            SELECT 1 FROM thread_messages WHERE thread_id = ? AND ordinal BETWEEN ? AND ? LIMIT ?
          )`).get(input.threadId, firstShared, lastShared, sharedOrdinals.length + 1)?.count) ===
            sharedOrdinals.length &&
          (!hasMissingTail || lastShared === lastDurable || verifiedPriorLane)
        ) {
          // Ordinals may have holes left by a rolled-back stream. The bounded
          // count proves all durable rows between these anchors belong to this source.
          appendFromOrdinal = lastDurable + 1
          appendOrdinalBase = Math.max(0, firstShared - firstMatch)
          interiorTailBoundary = lastShared
          for (let index = firstMatch; index < sourceOrdinals.length; index += 1) {
            const ordinal = sourceOrdinals[index]
            if (ordinal === null) continue
            const reserved = appendOrdinalBase + index
            if (reserved !== ordinal) {
              interiorRows.push({ messageId: durableIds.get(index) ?? input.messages[index].messageId,
                before: ordinal, after: reserved })
            }
            if (ordinal === lastShared) interiorTailShift = Math.max(0, reserved - ordinal)
          }
          if (hasMissingTail && lastShared < lastDurable) {
            const following = database.prepare(`SELECT MIN(ordinal) AS first FROM thread_messages
              WHERE thread_id = ? AND ordinal > ?`).get(input.threadId, lastShared)
            interiorTailShift = Math.max(interiorTailShift,
              appendOrdinalBase + input.messages.length - Number(following?.first))
          }
        } else {
          throw searchBootstrapNeedsForeground()
        }
      }
    }
    if (!sameMigration) {
      throwIfCancelled(input.cancellation)
      const sourceProgress = progressKey()
      let ordinalReservation: LegacyOrdinalReservation | null = null
      beginBatch()
      try {
        assertSearchGuard()
        confirmInitialLayout()
        const stillExists = database
          .prepare("SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1")
          .get(input.threadId)
        if (!stillExists) {
          rollbackBatch()
          return {
            checkpointId: input.checkpointId,
            totalMessages: input.messages.length,
            migratedMessages: 0,
            batches: 0,
            payloadBytes: input.payloadBytes
          }
        }
        const messageCount = Number(database.prepare("SELECT COUNT(*) AS count FROM thread_messages WHERE thread_id = ?")
          .get(input.threadId)?.count)
        const nextOrdinal = currentTail() + 1
        const nextAvailable = scopedOrder ? Math.max(nextOrdinal, Number(database.prepare(
          "SELECT next_ordinal FROM thread_message_buckets WHERE thread_id = ?"
        ).get(input.threadId)?.next_ordinal ?? 0)) : nextOrdinal
        if (appendFromOrdinal !== null && nextOrdinal !== appendFromOrdinal) {
          throw searchBootstrapSuperseded()
        }
        clearSourceIds()
        for (const [index, alias] of initialSourceAliases) recordVerifiedSourceAlias(index, alias.id, alias.complete, alias.key)
        reconcilePreviousOverlaps()
        recordInitialNativeObservations()
        storePendingOverlaps(planRecoveredStreams())
        const wholePrefix = appendOrdinalBase === null && input.messages.length > 0 && nextOrdinal > 0
        const shift = wholePrefix ? input.messages.length : interiorTailShift
        ordinalReservation = continuationRanges ? reserveLegacyOrdinalRanges(database, input.threadId, continuationRanges)
          : planLegacyOrdinalReservation(database, input.threadId, shift > 0
            ? { after: wholePrefix ? null : interiorTailBoundary, through: nextOrdinal - 1,
                shift, cursor: null } : null, interiorRows)
        if (!ordinalReservation && interiorTailBoundary !== null && interiorTailShift > 0) {
          for (const table of ["thread_messages", "thread_graph_transcript_boundaries"]) {
            database.prepare(`UPDATE ${table} SET ordinal = ordinal + ? WHERE thread_id = ? AND ordinal > ?`)
              .run(interiorTailShift, input.threadId, interiorTailBoundary)
          }
        }
        if (!ordinalReservation && interiorRows.length) {
          const move = database.prepare(`UPDATE thread_messages SET ordinal = ?
            WHERE thread_id = ? AND message_id = ? AND ordinal = ?`)
          for (const row of interiorRows) {
            assertSearchGuard()
            const change = move.run(row.after, input.threadId, row.messageId, row.before)
            if (Number(change.changes) !== 1) throw searchBootstrapSuperseded()
          }
        }
        if (!ordinalReservation && wholePrefix) {
          for (const table of ["thread_messages", "thread_graph_transcript_boundaries"]) {
            database.prepare(`UPDATE ${table} SET ordinal = ordinal + ? WHERE thread_id = ?`).run(shift, input.threadId)
          }
        }
        database.prepare("DELETE FROM legacy_checkpoint_transcript_slots WHERE thread_id = ?").run(input.threadId)
        if (scopedSlots.length) {
          const slots = scopedSlots.map(({ index, ordinal }) => [index, ordinal, ...legacySlotIdentity(input.messages[index])])
          database.prepare(`INSERT INTO legacy_checkpoint_transcript_slots
            (thread_id, checkpoint_id, message_index, ordinal, provider_source_id, role, provider_occurrence)
            SELECT ?, ?, value ->> 0, value ->> 1, value ->> 2, value ->> 3, value ->> 4
            FROM json_each(?)`).run(input.threadId, input.checkpointId, JSON.stringify(slots))
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
            messageCount,
            appendOrdinalBase === null
              ? nextOrdinal + input.messages.length
              : Math.max(nextAvailable + interiorTailShift, ordinalAt(input.messages.length)),
            Date.now()
          )
        database
          .prepare(
            `INSERT INTO legacy_checkpoint_transcript_migrations
             (thread_id, checkpoint_id, total_messages, next_index,
              current_fragment_index, append_ordinal_base, source_ordinal_gap, ordinal_reservation, status, updated_at, timing_checkpoint_id,
              timing_source_prefix, progress_key, provider_progress_key, source_layout_key, source_lane_key,
              source_lane_count, shadow_slots, search_projection_state, continuation_verified, continuation_ancestor, scoped_order)
             VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(thread_id) DO UPDATE SET checkpoint_id = excluded.checkpoint_id,
               total_messages = excluded.total_messages, next_index = 0, current_fragment_index = 0,
               active_fragment_revision = NULL, copied_layout_key = NULL,
               append_ordinal_base = excluded.append_ordinal_base, source_ordinal_gap = excluded.source_ordinal_gap,
               ordinal_reservation = excluded.ordinal_reservation,
               scoped_order = excluded.scoped_order,
               status = excluded.status, updated_at = excluded.updated_at, timing_checkpoint_id = excluded.timing_checkpoint_id,
               timing_source_prefix = excluded.timing_source_prefix, adopted_source_start = NULL, source_key = NULL,
               progress_key = excluded.progress_key, provider_progress_key = excluded.provider_progress_key,
               source_layout_key = excluded.source_layout_key, source_lane_key = excluded.source_lane_key,
               source_lane_count = excluded.source_lane_count, shadow_slots = excluded.shadow_slots,
               search_projection_state = excluded.search_projection_state, continuation_verified = excluded.continuation_verified,
               continuation_ancestor = excluded.continuation_ancestor`
          )
          .run(input.threadId, input.checkpointId, input.messages.length, appendOrdinalBase,
            ordinalGaps.length ? JSON.stringify(ordinalGaps) : null,
            ordinalReservation ? JSON.stringify(ordinalReservation) : null,
            ordinalReservation ? "reserving" : "migrating", Date.now(),
            timingCheckpoint, existingState?.timing_source_prefix ?? null, sourceProgress,
            hashes.providerProgressDigest, hashes.layoutDigest, hashes.laneDigest, hashes.laneCount,
            hashes.storedShadowSlots, searchProjectionState, Number(continuesPublishedHistory), continuationAncestor, Number(scopedOrder))
        recordRetiredMembers(input.checkpointId, retainedMembers)
        publishOccurrenceRevisions()
        assertSearchGuard()
        placementEpoch = currentEpoch()
        commitBatch()
      } catch (error) {
        try {
          rollbackBatch()
        } catch {
          // Preserve the reservation error.
        }
        throw error
      }
      if (ordinalReservation) finishPublishedReservation()
    }

    const state = database
      .prepare(
        `SELECT next_index, current_fragment_index, active_fragment_revision
         FROM legacy_checkpoint_transcript_migrations
         WHERE thread_id = ? AND checkpoint_id = ?`
      )
      .get(input.threadId, input.checkpointId) as
      | { next_index?: number; current_fragment_index?: number; active_fragment_revision?: string | null }
      | undefined
    let offset = Math.max(0, Number(state?.next_index) || 0)
    let fragmentOffset = Math.max(0, Number(state?.current_fragment_index) || 0)
    const resumedFragment = priorProgress ?? adoptedProgress
    let fragmentPhysicalId = resumedFragment?.activeMessageId ?? null
    let fragmentRevision = resumedFragment?.activeRevision
    let fragmentImport = resumedFragment?.activeImport
    let fragmentSuperseded = resumedFragment?.activeReplacement === true
    let fragmentRestart = resumedFragment?.restartActive === true
    const publishedFragment = parseJsonValue(state?.active_fragment_revision)
    let activeFragmentBytes = fragmentRestart && Array.isArray(publishedFragment) && typeof publishedFragment[4] === "number"
      ? publishedFragment[4] : (input.messages[offset]?.contentFragments ?? []).slice(0, fragmentOffset)
        .reduce((bytes, part) => bytes + Buffer.byteLength(part) + 256, 0)
    let copyEpoch = priorProgress?.structureEpoch ?? placementEpoch ??
      adoptedProgress?.structureEpoch ?? currentEpoch()
    const checkCopyEpoch = () => {
      if (readEpoch && currentEpoch() !== copyEpoch) overlapAudit.retryAfterDurableChange()
    }
    const readAdoptedMember = typeof existingState?.adopted_source_start === "number" || retainedMembers.length
      ? database.prepare(`SELECT content_key FROM legacy_checkpoint_transcript_source_ids
        WHERE thread_id = ? AND checkpoint_id = ? AND message_id = ? AND source_index = ?`)
      : null
    const existingDurableId = database.prepare(`SELECT message_id, ordinal, role, provider_source_id, provider_occurrence
      FROM thread_messages WHERE thread_id = ? AND message_id = ?`)
    const keepRetiredMember = (message: DurableLegacyCheckpointMessage, index: number) =>
      isRetiredLegacyMember(readAdoptedMember?.get(input.threadId, input.checkpointId, message.messageId, index)?.content_key)
    const readSlot = scopedOrder ? database.prepare(`SELECT ordinal, provider_source_id, role, provider_occurrence
      FROM legacy_checkpoint_transcript_slots WHERE thread_id = ? AND checkpoint_id = ? AND message_index = ?`) : null
    const deleteSlots = database.prepare(`DELETE FROM legacy_checkpoint_transcript_slots
      WHERE thread_id = ? AND checkpoint_id = ? AND message_index >= ? AND message_index < ?`)
    const readSlotOccupant = scopedOrder ? database.prepare(`SELECT message_id FROM thread_messages
      WHERE thread_id = ? AND ordinal = ? AND message_id != ? LIMIT 1`) : null
    const readSourceAlias = scopedOrder ? database.prepare(`SELECT m.message_id
      FROM legacy_checkpoint_transcript_source_ids AS source
      JOIN thread_messages AS m ON m.rowid = ${legacyCheckpointReplayRowSql("source.thread_id", "source.physical_replay_key")}
      WHERE source.thread_id = ? AND source.checkpoint_id = ? AND source.message_id = ? AND source.source_index = ?`) : null
    const resolveScopedOrdinal = (index: number, physicalId: string) => {
      const slot = readSlot?.get(input.threadId, input.checkpointId, index)
      if (!slot) {
        const message = input.messages[index]
        const recorded = readSourceAlias?.get(input.threadId, input.checkpointId, message.messageId, index)
        const id = typeof recorded?.message_id === "string" ? recorded.message_id : physicalId
        const existing = existingDurableId.get(input.threadId, id)
        if ((!existing || existing.role !== message.role || !matchesCheckpointProvider(existing, message)) &&
            !keepRetiredMember(message, index))
          throw searchBootstrapNeedsForeground()
        return null
      }
      const [provider, role, occurrence] = legacySlotIdentity(input.messages[index])
      if (slot.provider_source_id !== provider || slot.role !== role || slot.provider_occurrence !== occurrence ||
          typeof slot.ordinal !== "number" || readSlotOccupant?.get(input.threadId, slot.ordinal, physicalId))
        throw searchBootstrapSuperseded()
      return slot.ordinal
    }
    const copyToScopedAlias = (message: DurableLegacyCheckpointMessage, ordinal: number | null) => {
      if (!scopedOrder || ordinal === null) return
      const existing = existingDurableId.get(input.threadId, message.messageId)
      if (!existing || (existing.role === message.role && matchesCheckpointProvider(existing, message))) return
      if (existing.ordinal === ordinal) throw searchBootstrapSuperseded()
      const [providerSourceId, role, providerOccurrence] = legacySlotIdentity(message)
      const id = buildAvailableProviderOccurrenceId(providerSourceId, role, providerOccurrence, {
        has: (candidate) => Boolean(existingDurableId.get(input.threadId, candidate))
      })
      const physical = { ...message, messageId: id, providerSourceId, providerOccurrence }
      const { raw, normalized, payload, fields } = legacyMessageContentKeys(physical)
      return { physical, receipt: { id, key: raw, providerKey: normalized, payloadKey: payload, fieldKeys: fields } }
    }
    const confirmScopedNativeCopy = (index: number, plannedOrdinal: number) => {
      const message = input.messages[index]
      const row = existingDurableId.get(input.threadId, message.messageId)
      if (typeof row?.ordinal !== "number" || row.role !== message.role || !matchesCheckpointProvider(row, message))
        throw searchBootstrapSuperseded()
      const boundary = database.prepare(legacyPhysicalUserSql(true, "<"))
      const expectedTurn = legacyPhysicalUserTurn(boundary.get({ threadId: input.threadId, ordinal: plannedOrdinal }))
      const actualTurn = legacyPhysicalUserTurn(boundary.get({ threadId: input.threadId, ordinal: row.ordinal }))
      if (actualTurn !== expectedTurn) throw searchBootstrapNeedsForeground()
      const proofEpoch = guardedCommittedEpoch ?? copyEpoch
      const equal = verifyCopy(message, row.ordinal, message.contentFragments?.length ?? 0,
        assertSearchGuard, false, true, false, proofEpoch)
      overlapAudit.assertPrepared()
      if (row.ordinal !== plannedOrdinal && database.prepare(`SELECT 1 FROM thread_messages
        WHERE thread_id = $threadId AND ordinal > $first AND ordinal < $last
        UNION ALL SELECT 1 FROM legacy_checkpoint_transcript_slots
        WHERE thread_id = $threadId AND ordinal > $first AND ordinal < $last LIMIT 1`).get({
        threadId: input.threadId, first: Math.min(row.ordinal, plannedOrdinal), last: Math.max(row.ordinal, plannedOrdinal)
      })) {
        database.prepare("UPDATE thread_messages SET ordinal = ? WHERE thread_id = ? AND message_id = ?")
          .run(plannedOrdinal, input.threadId, message.messageId)
      }
      if (!equal) {
        // The running writer owns this occurrence. Keep its published payload
        // and retain a receipt if it does not yet cover the checkpoint text.
        reconcilePreviousOverlaps()
        noteStreamOverlap(message)
        storePendingOverlaps(undefined, proofEpoch)
        database.prepare(`UPDATE legacy_checkpoint_transcript_migrations
          SET search_projection_state = ? WHERE thread_id = ? AND checkpoint_id = ?`)
          .run(searchProjectionState, input.threadId, input.checkpointId)
      }
      if (scope) guardedCopies.add(message.messageId)
    }
    if (scopedOrder && database.prepare(`SELECT 1 FROM legacy_checkpoint_transcript_slots
      WHERE thread_id = ? AND checkpoint_id = ? AND provider_source_id IS NULL LIMIT 1`)
      .get(input.threadId, input.checkpointId)) {
      beginBatch()
      try {
        assertSearchGuard()
        checkCopyEpoch()
        const unknown = database.prepare(`SELECT message_index FROM legacy_checkpoint_transcript_slots
          WHERE thread_id = ? AND checkpoint_id = ? AND provider_source_id IS NULL`)
        const assign = database.prepare(`UPDATE legacy_checkpoint_transcript_slots
          SET provider_source_id = ?, role = ?, provider_occurrence = ?
          WHERE thread_id = ? AND checkpoint_id = ? AND message_index = ?`)
        for (const { message_index } of unknown.all(input.threadId, input.checkpointId)) {
          checkSearchWork()
          const message = input.messages[Number(message_index)]
          if (!message || message.shadowSlot) throw searchBootstrapNeedsForeground()
          assign.run(...legacySlotIdentity(message), input.threadId, input.checkpointId, message_index)
        }
        commitBatch()
      } catch (error) {
        rollbackBatch()
        throw error
      }
    }
    const insert = database.prepare(
      `INSERT OR IGNORE INTO thread_messages (
         thread_id, message_id, provider_source_id, provider_occurrence, role,
         content_json, reasoning, tool_calls_json, tool_call_id, name, status, is_error,
         content_priority, goal_id, active_window_id, created_at, start_at, end_at, ordinal
         ${hasRecoveryIntegrity ? ", recovery_integrity" : ""}
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, ?
         ${hasRecoveryIntegrity ? ", ?" : ""})`
    )
    const moveReservedDuplicate = database.prepare(
      `UPDATE thread_messages
       SET ordinal = ?
       WHERE thread_id = ? AND message_id = ? AND ordinal >= ?`
    )
    const insertFragment = database.prepare(
      `INSERT INTO thread_message_fragments
       (thread_id, message_id, content_text, created_at, generation)
       SELECT thread_id, message_id, ?, ?, fragment_generation FROM thread_messages
       WHERE thread_id = ? AND message_id = ?`
    )
    const updateFragmentState = database.prepare(
      `INSERT INTO thread_message_fragment_states
       (thread_id, message_id, total_chars, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id, message_id) DO UPDATE SET
         total_chars = thread_message_fragment_states.total_chars + excluded.total_chars,
         updated_at = excluded.updated_at`
    )
    const insertedFragmentMessages = new Set<number>()
    let resetActiveHeader: StatementSync | undefined
    let removeActiveFragmentState: StatementSync | undefined
    let stageActiveFragment: StatementSync | undefined
    let readActiveGeneration: StatementSync | undefined
    let retireActiveGeneration: StatementSync | undefined

    while (offset < input.messages.length) {
      throwIfCancelled(input.cancellation)
      const fragmentMessage = input.messages[offset]
      if (!fragmentMessage.shadowSlot && (fragmentMessage.contentFragments || fragmentRestart || fragmentSuperseded)) {
        const parts = fragmentMessage.contentFragments ?? []
        beginBatch()
        try {
          assertSearchGuard()
          checkCopyEpoch()
          const currentState = database
            .prepare(
              `SELECT next_index, current_fragment_index, active_fragment_revision
               FROM legacy_checkpoint_transcript_migrations
               WHERE thread_id = ? AND checkpoint_id = ? AND status = 'migrating'`
            )
            .get(input.threadId, input.checkpointId) as
            | { next_index?: number; current_fragment_index?: number; active_fragment_revision?: string | null }
            | undefined
          if (
            !currentState ||
            Number(currentState.next_index) !== offset ||
            Number(currentState.current_fragment_index) !== fragmentOffset
          ) {
            rollbackBatch()
            break
          }
          if (
            !database.prepare("SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1").get(input.threadId)
          ) {
            database
              .prepare("DELETE FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?")
              .run(input.threadId)
            commitBatch()
            break
          }

          const publishedId = fragmentPhysicalId ?? fragmentMessage.messageId
          const plannedOrdinal = scopedOrder ? resolveScopedOrdinal(offset, publishedId) : ordinalAt(offset)
          if (fragmentOffset > 0 && plannedOrdinal === null) throw searchBootstrapNeedsForeground()
          const alias = fragmentOffset === 0 ? copyToScopedAlias(fragmentMessage, plannedOrdinal) : undefined
          const fragmentId = alias?.physical.messageId ?? publishedId
          const copy = alias?.physical ?? fragmentMessage
          if (alias) fragmentImport = alias.receipt
          const replacesPreviouslyCopiedFragments = fragmentRestart
          const actualRevision = fragmentRevision ? currentRevision(fragmentId, currentEpoch()) : null
          if (fragmentOffset > 0 && (!existingDurableId.get(input.threadId, fragmentId) ||
              (fragmentRevision && (actualRevision?.version !== fragmentRevision.version ||
                actualRevision?.epoch !== fragmentRevision.epoch)))) overlapAudit.retryAfterDurableChange()
          if (fragmentRestart) {
            const published = parseJsonValue(currentState.active_fragment_revision)
            if (!Array.isArray(published) || !fragmentRevision) throw searchBootstrapSuperseded()
            const candidate = readLegacyFragmentRewrite(published[7])
            const key = contentKey(offset)
            const staged = candidate?.contentKey === key && candidate.version === fragmentRevision.version
              ? candidate : { contentKey: key, version: fragmentRevision.version, generation: randomUUID(), nextIndex: 0, totalChars: 0 }
            if (staged.nextIndex > parts.length) throw searchBootstrapSuperseded()
            stageActiveFragment ??= database.prepare(`INSERT INTO thread_message_fragments
              (thread_id, message_id, content_text, created_at, generation) VALUES (?, ?, ?, ?, ?)`)
            if (stageLegacyFragmentBatch(parts, staged, (part, index) => stageActiveFragment!.run(
              input.threadId, fragmentId, part, fragmentMessage.createdAt + index, staged.generation), checkSearchWork)) {
              database.prepare(`UPDATE legacy_checkpoint_transcript_migrations SET active_fragment_revision = ?, updated_at = ?
                WHERE thread_id = ? AND checkpoint_id = ?`)
                .run(serializeActiveFragmentCursor(published, published[5], published[6], staged),
                  Date.now(), input.threadId, input.checkpointId)
              assertSearchGuard()
              commitBatch()
              if (scope) {
                assertSourceFamily()
                database.exec("COMMIT")
                writerTurn.released()
                writerTurn.wait()
                database.exec("BEGIN IMMEDIATE")
                publishStarted = performance.now()
                guardedCommittedEpoch = currentEpoch()
              }
              continue
            }
            readActiveGeneration ??= database.prepare(`SELECT fragment_generation FROM thread_messages
              WHERE thread_id = ? AND message_id = ?`)
            const prior = String(readActiveGeneration.get(input.threadId, fragmentId)?.fragment_generation ?? "")
            if (prior === staged.generation) throw searchBootstrapSuperseded()
            resetActiveHeader ??= database.prepare(`UPDATE thread_messages SET
              fragment_generation = ?, content_json = ?, reasoning = ?, tool_calls_json = ?,
              tool_call_id = ?, name = ?, status = ?, is_error = ?${hasRecoveryIntegrity ? ", recovery_integrity = ?" : ""}
              WHERE thread_id = ? AND message_id = ?`)
            resetActiveHeader.run(staged.generation, fragmentMessage.contentJson, fragmentMessage.reasoning, fragmentMessage.toolCallsJson,
              fragmentMessage.toolCallId, fragmentMessage.name, fragmentMessage.status, fragmentMessage.isError,
              ...(hasRecoveryIntegrity ? [fragmentMessage.recoveryIntegrity] : []), input.threadId, fragmentId)
            retireActiveGeneration ??= database.prepare("INSERT OR IGNORE INTO legacy_checkpoint_retired_fragments VALUES (?, ?, ?)")
            retireActiveGeneration.run(input.threadId, fragmentId, prior)
            removeActiveFragmentState ??= database.prepare(`DELETE FROM thread_message_fragment_states
              WHERE thread_id = ? AND message_id = ?`)
            removeActiveFragmentState.run(input.threadId, fragmentId)
            if (staged.totalChars > 0) updateFragmentState.run(input.threadId, fragmentId, staged.totalChars, Date.now())
          }
          let insertedMessage = 0
          if (fragmentOffset === 0 && plannedOrdinal !== null && !fragmentRestart &&
              !keepRetiredMember(fragmentMessage, offset)) {
            const inserted = insert.run(
              input.threadId,
              fragmentId,
              copy.providerSourceId,
              copy.providerOccurrence,
              fragmentMessage.role,
              fragmentMessage.contentJson,
              fragmentMessage.reasoning,
              fragmentMessage.toolCallsJson,
              fragmentMessage.toolCallId,
              fragmentMessage.name,
              fragmentMessage.status,
              fragmentMessage.isError,
              fragmentMessage.createdAt,
              plannedOrdinal,
              ...(hasRecoveryIntegrity ? [fragmentMessage.recoveryIntegrity] : [])
            )
            insertedMessage = Number(inserted.changes)
            if (alias && insertedMessage !== 1) throw searchBootstrapSuperseded()
            if (alias) {
              fragmentPhysicalId = fragmentId
              recordVerifiedSourceAlias(offset, fragmentId, false)
            }
            if (insertedMessage === 0 && scopedOrder && !legacyUnscopedSlots)
              confirmScopedNativeCopy(offset, plannedOrdinal)
            if (insertedMessage === 0 && (!scopedOrder || legacyUnscopedSlots) && appendOrdinalBase === null) {
              moveReservedDuplicate.run(
                plannedOrdinal,
                input.threadId,
                fragmentId,
                input.messages.length
              )
            } else if (insertedMessage > 0) {
              insertedFragmentMessages.add(offset)
            }
          }

          let nextFragmentOffset = fragmentRestart ? parts.length : fragmentOffset
          let fragmentBatchBytes = fragmentMessage.estimatedBytes
          let fragmentChars = 0
          if (!fragmentSuperseded && (fragmentRestart || fragmentOffset > 0 || insertedMessage > 0)) {
            while (nextFragmentOffset < parts.length) {
              const fragment = parts[nextFragmentOffset]
              const fragmentBytes = Buffer.byteLength(fragment, "utf8") + 256
              if (
                nextFragmentOffset > fragmentOffset &&
                fragmentBatchBytes + fragmentBytes > LEGACY_TRANSCRIPT_BATCH_BYTE_BUDGET
              ) {
                break
              }
              insertFragment.run(
                fragment,
                fragmentMessage.createdAt + nextFragmentOffset,
                input.threadId,
                fragmentId
              )
              fragmentBatchBytes += fragmentBytes
              activeFragmentBytes += fragmentBytes
              fragmentChars += fragment.length
              nextFragmentOffset += 1
            }
            if (fragmentChars > 0) {
              updateFragmentState.run(
                input.threadId,
                fragmentId,
                fragmentChars,
                Date.now()
              )
            }
          } else {
            // A live row with the same identity wins. Do not attach legacy
            // fragments to it; simply advance the compatibility cursor.
            nextFragmentOffset = parts.length
          }

          const messageComplete =
            nextFragmentOffset >= parts.length
          if (messageComplete) {
            const verifiedNative = fragmentSuperseded && resumedFragment?.nativeActive === "verified"
            if (verifiedNative) recordImportedMessage(offset, fragmentImport, false)
            if (fragmentSuperseded && resumedFragment?.nativeActive === "unverified") {
              database.prepare(`UPDATE legacy_checkpoint_transcript_imports SET owned_by_migration = 0,
                partial_version = NULL, provider_content_key = NULL, payload_content_key = NULL,
                field_content_keys = NULL, previous_content_key = NULL, rewrite_progress = NULL
                WHERE thread_id = ? AND message_id = ? AND partial_version IS NOT NULL`)
                .run(input.threadId, fragmentId)
            }
            if (!fragmentSuperseded && (fragmentImport || fragmentId === fragmentMessage.messageId) &&
                (fragmentRestart || fragmentOffset > 0 || insertedMessage > 0)) recordImportedMessage(offset, fragmentImport)
            recordSourceIds(offset, offset + 1)
            deleteSlots.run(input.threadId, input.checkpointId, offset, offset + 1)
            if (verifiedNative) {
              if (fragmentId !== fragmentMessage.messageId) recordVerifiedSourceAlias(offset, fragmentId, true)
            } else if (fragmentSuperseded || fragmentId !== fragmentMessage.messageId) {
              const member = [{ id: fragmentMessage.messageId, index: offset, aliasId: fragmentId }]
              if (scopedOrder && fragmentImport && !fragmentSuperseded) {
                recordVerifiedSourceAlias(offset, fragmentId, true)
              } else {
                recordRetiredMembers(input.checkpointId, member)
                if (searchProjectionState !== "truncated") searchProjectionState = "unverified"
              }
            }
          }
          copyEpoch = currentEpoch()
          fragmentRevision = messageComplete || !readVersion ? undefined : currentRevision(fragmentId, copyEpoch)
          if (fragmentRevision && !fragmentSuperseded && (fragmentImport || fragmentId === fragmentMessage.messageId))
            recordPartialImport(offset, fragmentId, fragmentRevision.version, fragmentImport)
          database
            .prepare(
              `UPDATE legacy_checkpoint_transcript_migrations
               SET next_index = ?, current_fragment_index = ?, active_fragment_revision = ?, copied_layout_key = ?, updated_at = ?
               WHERE thread_id = ? AND checkpoint_id = ?`
            )
            .run(
              messageComplete ? offset + 1 : offset,
              messageComplete ? 0 : nextFragmentOffset,
              fragmentRevision ? JSON.stringify([
                fragmentId, fragmentRevision.epoch, fragmentRevision.version, nextFragmentOffset, activeFragmentBytes,
                null, activeLayout(offset)
              ]) : null,
              hashes.copiedLayoutKeys[messageComplete ? offset + 1 : offset],
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
          assertSearchGuard()
          commitBatch()
          fragmentRestart = false
          countCopyBatch(messageComplete && insertedFragmentMessages.delete(offset) ? 1 : 0)
          if (messageComplete) {
            if (scope && (insertedMessage > 0 || fragmentOffset > 0 || replacesPreviouslyCopiedFragments))
              guardedCopies.add(fragmentMessage.messageId)
            offset += 1
            fragmentOffset = 0
            fragmentPhysicalId = null
            fragmentImport = undefined
            fragmentSuperseded = false
            activeFragmentBytes = 0
          } else {
            fragmentOffset = nextFragmentOffset
          }
          continue
        } catch (error) {
          try {
            rollbackBatch()
          } catch {
            // Preserve the fragment migration error.
          }
          throw error
        }
      }

      let end = offset
      let batchBytes = 0
      while (end < input.messages.length && end - offset < LEGACY_TRANSCRIPT_BATCH_LIMIT) {
        const candidate = input.messages[end]
        if (!candidate.shadowSlot && candidate.contentFragments) break
        const nextBytes = candidate.shadowSlot ? 0 : candidate.estimatedBytes
        if (end > offset && batchBytes + nextBytes > LEGACY_TRANSCRIPT_BATCH_BYTE_BUDGET) break
        batchBytes += nextBytes
        end += 1
      }
      if (end === offset) end += 1

      beginBatch()
      try {
        assertSearchGuard()
        checkCopyEpoch()
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
          rollbackBatch()
          break
        }
        if (
          !database.prepare("SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1").get(input.threadId)
        ) {
          database
            .prepare("DELETE FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?")
            .run(input.threadId)
          commitBatch()
          break
        }

        let insertedInBatch = 0
        for (let index = offset; index < end; index += 1) {
          throwIfCancelled(input.cancellation)
          const message = input.messages[index]
          if (message.shadowSlot || keepRetiredMember(message, index)) continue
          const plannedOrdinal = scopedOrder ? resolveScopedOrdinal(index, message.messageId) : ordinalAt(index)
          if (plannedOrdinal === null) continue
          const alias = copyToScopedAlias(message, plannedOrdinal)
          const copy = alias?.physical ?? message
          const inserted = insert.run(
            input.threadId,
            copy.messageId,
            copy.providerSourceId,
            copy.providerOccurrence,
            message.role,
            message.contentJson,
            message.reasoning,
            message.toolCallsJson,
            message.toolCallId,
            message.name,
            message.status,
            message.isError,
            message.createdAt,
            plannedOrdinal,
            ...(hasRecoveryIntegrity ? [message.recoveryIntegrity] : [])
          )
          insertedInBatch += Number(inserted.changes)
          if (Number(inserted.changes) > 0) {
            recordImportedMessage(index, alias?.receipt)
            if (alias) recordVerifiedSourceAlias(index, copy.messageId, true)
            if (scope) guardedCopies.add(message.messageId)
          }
          if (Number(inserted.changes) === 0 && scopedOrder && !legacyUnscopedSlots)
            confirmScopedNativeCopy(index, plannedOrdinal)
          if (Number(inserted.changes) === 0 && (!scopedOrder || legacyUnscopedSlots) && appendOrdinalBase === null) {
            moveReservedDuplicate.run(
              plannedOrdinal,
              input.threadId,
              message.messageId,
              input.messages.length
            )
          }
        }
        database
          .prepare(
            `UPDATE thread_message_buckets
             SET message_count = message_count + ?, updated_at = ?
             WHERE thread_id = ?`
          )
          .run(insertedInBatch, Date.now(), input.threadId)
        recordSourceIds(offset, end)
        deleteSlots.run(input.threadId, input.checkpointId, offset, end)
        database
          .prepare(
            `UPDATE legacy_checkpoint_transcript_migrations
             SET next_index = ?, current_fragment_index = 0, active_fragment_revision = NULL, copied_layout_key = ?, updated_at = ?
             WHERE thread_id = ? AND checkpoint_id = ?`
          )
          .run(end, hashes.copiedLayoutKeys[end], Date.now(), input.threadId, input.checkpointId)
        assertSearchGuard()
        copyEpoch = currentEpoch()
        commitBatch()
        countCopyBatch(insertedInBatch)
        offset = end
      } catch (error) {
        try {
          rollbackBatch()
        } catch {
          // Preserve the batch error.
        }
        throw error
      }
    }

    if (offset >= input.messages.length) {
      throwIfCancelled(input.cancellation)
      beginBatch()
      try {
        assertSearchGuard()
        checkCopyEpoch()
        if (searchProjectionState !== "truncated" && searchProjectionState !== "unverified") {
          const auditSuffix = typeof existingState?.adopted_source_start === "number" ? existingState.adopted_source_start : Infinity
          const imported = database.prepare(`SELECT 1 FROM legacy_checkpoint_transcript_imports
            WHERE thread_id = ? AND message_id = ? AND owned_by_migration = 1`)
          for (const [index, message] of input.messages.entries()) {
            checkSearchWork()
            if (message.shadowSlot || guardedCopies.has(message.messageId) ||
                (index < auditSuffix && !imported.get(input.threadId, message.messageId))) continue
            const actual = scopedOrder ? database.prepare(`SELECT ordinal FROM thread_messages
              WHERE thread_id = ? AND message_id = ?`).get(input.threadId, message.messageId)?.ordinal : ordinalAt(index)
            if ((typeof actual !== "number" || verifyCopy(message, actual, message.contentFragments?.length ?? 0,
              assertSearchGuard, false, true) === false) && !uncertainOccurrences.has(index)) {
              searchProjectionState = "unverified"
              break
            }
          }
          overlapAudit.assertPrepared()
        }
        if (
          !database.prepare("SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1").get(input.threadId)
        ) {
          database
            .prepare("DELETE FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?")
            .run(input.threadId)
          commitBatch()
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
             SET message_count = ?, next_ordinal = ${scopedOrder ? "MAX(next_ordinal, ?)" : "?"}, updated_at = ?
             WHERE thread_id = ?`
          )
          .run(
            Number(summary.message_count),
            currentTail() + 1,
            Date.now(),
            input.threadId
          )
        noteOutstandingPartialCopy()
        database
          .prepare(
            `UPDATE legacy_checkpoint_transcript_migrations
             SET next_index = total_messages, status = ?, updated_at = ?, search_projection_state = ?
             WHERE thread_id = ? AND checkpoint_id = ?`
          )
          .run(input.prefixCopy ? "migrating" : "complete", Date.now(), searchProjectionState, input.threadId, input.checkpointId)
        publishOccurrenceCoverage()
        if (sameMigration && !existingState?.progress_key) recordSourceIds(0, input.messages.length)
        else for (const index of new Set([...hashes.earlierKeys.keys(), ...supersededImportKeys.keys()]))
          recordSourceIds(index, index + 1)
        verifyRecoveryMembership()
        publishOccurrenceRevisions()
        assertSearchGuard()
        commitBatch()
      } catch (error) {
        try {
          rollbackBatch()
        } catch {
          // Preserve the completion error.
        }
        throw error
      }
    }

    if (scope && offset < input.messages.length) throw searchBootstrapSuperseded()
    if (!scope && !input.prefixCopy) {
      migrateLegacyMessageTimes(
        database, input.threadId, input.checkpointId, timingOriginalMessages,
        assertSearchGuard, writerTurn, input.sourceKey
      )
    }
    if (scope) {
      assertSearchGuard()
      assertSourceFamily()
      database.exec("COMMIT")
    }
    return {
      checkpointId: input.checkpointId,
      totalMessages: input.messages.length,
      migratedMessages,
      batches,
      payloadBytes: input.payloadBytes,
      searchProjectionState: reportedProjection()
    }
  } finally {
    if (scope && database.isTransaction) database.exec("ROLLBACK")
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

function readLegacyTranscriptBootstrapSource(
  database: DatabaseSync,
  threadId: string,
  checkpointNs: string,
  layout: CheckpointSchemaLayout,
  cancellation: Int32Array,
  searchGuard?: LegacySearchBootstrapGuard,
  reservedCheckpointId?: string
) {
  database.exec("BEGIN")
  try {
    throwIfCancelled(cancellation)
    const row = readStoredCheckpointRow(database, threadId, checkpointNs, true, layout, reservedCheckpointId)
    if (!row || row.metadata === undefined) {
      database.exec("COMMIT")
      return null
    }
    if (searchGuard?.checkpointId !== undefined) {
      const selected = database.prepare(
        "SELECT rowid FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?"
      ).get(threadId, checkpointNs, row.checkpointId)
      if (row.checkpointId !== searchGuard.checkpointId || selected?.rowid !== searchGuard.checkpointRowId)
        throw searchBootstrapSuperseded()
    }
    const parsed = parseTypedJson(row.type, row.checkpoint, "checkpoint")
    throwIfCancelled(cancellation)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("[CheckpointRuntimeWorker] Invalid checkpoint object")
    }
    const rawCheckpoint = parsed as Record<string, unknown>
    const hydratedCheckpoint = hydrateRawCheckpointMessages(database, row, rawCheckpoint, cancellation)
    throwIfCancelled(cancellation)
    database.exec("COMMIT")
    return { row, rawCheckpoint, hydratedCheckpoint }
  } catch (error) {
    try {
      database.exec("ROLLBACK")
    } catch {
      // Preserve the checkpoint read error.
    }
    throw error
  }
}

/**
 * One-time compatibility bridge for databases whose checkpoint transcript was
 * never copied into the durable message table. The worker keeps the full array
 * local, persists it in bounded transactions, and returns only runtime state.
 */
function searchBootstrapSuperseded(): Error {
  const error = new Error("Search backfill source or thread changed")
  error.name = CHECKPOINT_RUNTIME_PROJECTION_CANCELLED
  return error
}

function searchBootstrapNeedsForeground(): Error {
  const error = new Error("Legacy search transcript requires foreground recovery")
  error.name = CHECKPOINT_RUNTIME_PROJECTION_FOREGROUND_REQUIRED
  return error
}

function selectBackgroundCheckpoint(path: string): string {
  try {
    const selected = findNativeSqliteRecoverySource(path, SEARCH_LEGACY_MAX_SOURCE_BYTES)
    if (!selected) throw new Error("No recoverable legacy checkpoint was found")
    return selected
  } catch (error) {
    if (error instanceof RangeError) throw searchBootstrapNeedsForeground()
    throw error
  }
}

function resolveForegroundCheckpointReadPath(path: string): string {
  return hasSqliteRecoverySidecar(path) ? (findNativeSqliteRecoverySource(path, Infinity) ?? path) : path
}

function readLegacyReservationSource(path: string, threadId: string): string | undefined {
  if (!existsSync(path)) return undefined
  const database = new DatabaseSync(path, { readOnly: true, timeout: 100 })
  try {
    if (!database.prepare(`SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'legacy_checkpoint_transcript_slots'`).get()) return undefined
    const pending = database.prepare(`SELECT m.checkpoint_id FROM legacy_checkpoint_transcript_migrations AS m
      WHERE m.thread_id = ? AND m.status IN ('migrating', 'reserving')
        AND EXISTS (SELECT 1 FROM legacy_checkpoint_transcript_slots AS slot
          WHERE slot.thread_id = m.thread_id AND slot.checkpoint_id = m.checkpoint_id)`).get(threadId)
    return typeof pending?.checkpoint_id === "string" ? pending.checkpoint_id : undefined
  } finally {
    database.close()
  }
}

export function bootstrapLegacyCheckpointTranscript(
  checkpointDatabasePath: string,
  messageDatabasePath: string,
  threadId: string,
  checkpointNs: string,
  cancellationBuffer: SharedArrayBuffer,
  searchGuard?: LegacySearchBootstrapGuard
): LegacyCheckpointTranscriptBootstrapResult {
  return bootstrapLegacyTranscript(checkpointDatabasePath, messageDatabasePath, threadId, checkpointNs,
    cancellationBuffer, searchGuard)
}

function bootstrapLegacyTranscript(
  checkpointDatabasePath: string,
  messageDatabasePath: string,
  threadId: string,
  checkpointNs: string,
  cancellationBuffer: SharedArrayBuffer,
  searchGuard?: LegacySearchBootstrapGuard,
  reservedCheckpointId?: string
): LegacyCheckpointTranscriptBootstrapResult {
  // Leave time for the watchdog to stop genuinely unresponsive work. Ordinal
  // reservations can return earlier after committing usable progress.
  const reservationDeadline = searchGuard ? performance.now() + 3_700 : undefined
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
  const initialSourceKey = searchGuard?.sourceKey ?? sqliteRecoveryFamilyKey(checkpointDatabasePath)
  const sourceFamilyUnchanged = () => sqliteRecoveryFamilyKey(checkpointDatabasePath) === initialSourceKey
  if (!sourceFamilyUnchanged()) throw searchBootstrapSuperseded()
  const sourcePath = searchGuard
    ? selectBackgroundCheckpoint(checkpointDatabasePath)
    : resolveForegroundCheckpointReadPath(checkpointDatabasePath)
  if (!sourcePath || !existsSync(sourcePath)) return emptyResult()
  if (searchGuard?.recoverySuffix !== undefined &&
      sourcePath !== checkpointDatabasePath + searchGuard.recoverySuffix) {
    throw searchBootstrapSuperseded()
  }
  const sourceFile = statSync(sourcePath, { bigint: true })
  const sourcePathUnchanged = () => {
    const current = statSync(sourcePath, { bigint: true, throwIfNoEntry: false })
    return Boolean(current && current.dev === sourceFile.dev && current.ino === sourceFile.ino)
  }
  // Only the saver owns physical publication. This compatibility reader can
  // recover a transcript from a backup, but never rewrites the file family.
  const checkpointDatabase = new DatabaseSync(sourcePath, {
    readOnly: !searchGuard, timeout: searchGuard ? 100 : 5_000
  })
  let verifiedSource: { checkpointId: string; key: string } | undefined
  let lineageDatabase: DatabaseSync | undefined
  try {
    const dataVersion = checkpointDatabase.prepare("PRAGMA data_version")
    const expectedVersion = dataVersion.get()?.data_version
    const sourceIsUnchanged = () => sourcePathUnchanged() && dataVersion.get()?.data_version === expectedVersion
    // Bootstrap can recover an inline legacy transcript using only the base
    // checkpoint table. Auxiliary tables are optional optimizations unless the
    // checkpoint itself contains an external-message marker.
    const checkpointSchema = assertCheckpointSchemaIsPublished(checkpointDatabase)
    const source = readLegacyTranscriptBootstrapSource(
      checkpointDatabase, threadId, checkpointNs, checkpointSchema, cancellation, searchGuard, reservedCheckpointId
    )
    if (!source) return emptyResult()
    const { row, rawCheckpoint, hydratedCheckpoint } = source

    if (!reservedCheckpointId) {
      const pending = readLegacyReservationSource(messageDatabasePath, threadId)
      if (pending && pending !== row.checkpointId) {
        if (searchGuard) throw searchBootstrapNeedsForeground()
        // Recover the original reservations before applying a newer head that
        // can omit the pending rows entirely.
        bootstrapLegacyTranscript(checkpointDatabasePath, messageDatabasePath, threadId, checkpointNs,
          cancellationBuffer, undefined, pending)
        if (!sourceIsUnchanged() || !sourceFamilyUnchanged()) throw searchBootstrapSuperseded()
      }
    }
    throwIfCancelled(cancellation)
    // The runtime projection cache can be filled independently. Bootstrap keeps
    // the recovery source read-only so its durable proof identifies the bytes read.
    if (!reservedCheckpointId && !exactSourceIsStillLatest(checkpointDatabase, row, checkpointSchema)) {
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
      serializeJsonPayload(messages).byteLength
    )
    const { messages: durableMessages, sourceClaims, sourcePrefixKeys, occurrenceSnapshot, graphBoundaries } = buildDurableLegacyCheckpointMessages(
      messages,
      row.checkpointTs,
      cancellation,
      messageDatabasePath,
      threadId
    )
    if (searchGuard) {
      throwIfCancelled(cancellation)
      if (
        selectBackgroundCheckpoint(checkpointDatabasePath) !== sourcePath ||
        !sourcePathUnchanged() || !sourceFamilyUnchanged()
      ) throw searchBootstrapSuperseded()
      throwIfCancelled(cancellation)
      // Pin the source only for atomic publication. All decoding and projection was done above.
      checkpointDatabase.exec("BEGIN IMMEDIATE")
    }
    const sourceKey = sqliteRecoveryFamilyKey(checkpointDatabasePath)
    if (sourceKey !== initialSourceKey || !sourceIsUnchanged()) throw searchBootstrapSuperseded()
    const reference = objectRecord(objectRecord(rawCheckpoint.channel_values)?.messages)
    const transcriptRevision = reference?.[EXTERNAL_MESSAGES_MARKER] === true &&
      typeof reference.transcriptRevision === "string" ? reference.transcriptRevision : null
    const parent = checkpointDatabase.prepare(`SELECT parent_checkpoint_id FROM checkpoints
      WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`)
    const lineageColumns = checkpointDatabase.prepare("PRAGMA table_info(checkpoint_lineage)").all()
    const hasSpans = lineageColumns.some((column) => column.name === "ancestor_span_depth")
    const spanColumns = hasSpans ? "lineage_depth, ancestor_span_id, ancestor_span_depth" :
      "NULL AS lineage_depth, NULL AS ancestor_span_id, NULL AS ancestor_span_depth"
    const recordedParent = lineageColumns.length ? checkpointDatabase.prepare(`
      SELECT parent_checkpoint_id, conflicting_parent, ${spanColumns} FROM checkpoint_lineage
      WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`) : undefined
    if (existsSync(messageDatabasePath)) {
      lineageDatabase = new DatabaseSync(messageDatabasePath, { readOnly: true, timeout: searchGuard ? 100 : 5_000 })
    }
    const knownParent = lineageDatabase?.prepare(`SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'legacy_checkpoint_transcript_parents'`).get()
      ? lineageDatabase.prepare(`SELECT parent_checkpoint_id FROM legacy_checkpoint_transcript_parents
        WHERE thread_id = ? AND checkpoint_id = ?`) : undefined
    const savedRoot = knownParent?.get(threadId, row.checkpointId)
    const recordedRoot = recordedParent?.get(threadId, checkpointNs, row.checkpointId)
    if ((savedRoot && savedRoot.parent_checkpoint_id !== row.parentCheckpointId) ||
        (recordedRoot && (recordedRoot.conflicting_parent === 1 ||
          recordedRoot.parent_checkpoint_id !== row.parentCheckpointId))) throw searchBootstrapNeedsForeground()
    const skipConflicts = hasSpans && checkpointDatabase.prepare(`SELECT 1 FROM checkpoint_lineage
      WHERE thread_id = ? AND checkpoint_ns = ? AND conflicting_parent = 1
        AND lineage_depth BETWEEN ? AND ? LIMIT 1`)
    const changedLiveParents = hasSpans && checkpointDatabase.prepare(`
      SELECT 1 FROM checkpoints AS live JOIN checkpoint_lineage AS lineage
        USING (thread_id, checkpoint_ns, checkpoint_id)
      WHERE live.thread_id = ? AND live.checkpoint_ns = ?
        AND live.parent_checkpoint_id IS NOT lineage.parent_checkpoint_id LIMIT 1
    `).get(threadId, checkpointNs)
    const checkpoints = new Map<string, { parent: string | null; spanId?: string; spanDepth?: number } | null>()
    const lookup = (id: string) => {
      if (checkpoints.has(id)) return checkpoints.get(id)
      const available = parent.get(threadId, checkpointNs, id)
      const recorded = recordedParent?.get(threadId, checkpointNs, id)
      const remembered = knownParent?.get(threadId, id)
      const row = available ?? recorded
      const conflicted = recorded?.conflicting_parent === 1 ||
        (recorded && available && available.parent_checkpoint_id !== recorded.parent_checkpoint_id) ||
        (remembered && row && remembered.parent_checkpoint_id !== row.parent_checkpoint_id)
      const node = conflicted ? null : {
        parent: typeof row?.parent_checkpoint_id === "string" ? row.parent_checkpoint_id : null,
        ...(skipConflicts && !changedLiveParents && typeof recorded?.ancestor_span_id === "string" &&
          typeof recorded.ancestor_span_depth === "number" && typeof recorded.lineage_depth === "number" &&
          !skipConflicts.get(threadId, checkpointNs, recorded.ancestor_span_depth, recorded.lineage_depth)
          ? { spanId: recorded.ancestor_span_id, spanDepth: recorded.ancestor_span_depth } : {})
      }
      checkpoints.set(id, node)
      return node
    }
    const ancestry = new Map<string, boolean>()
    const descendsFrom = (previousId: string) => {
      const cached = ancestry.get(previousId)
      if (cached !== undefined) return cached
      const depth = recordedParent?.get(threadId, checkpointNs, previousId)?.lineage_depth
      const visited = new Set<string>([row.checkpointId])
      let id = row.parentCheckpointId
      while (id !== null && !visited.has(id) && visited.size <= CHECKPOINT_TRANSCRIPT_PRESENCE_CHAIN_LIMIT) {
        throwIfCancelled(cancellation)
        const node = lookup(id)
        if (!node) break
        if (id === previousId) {
          ancestry.set(previousId, true)
          return true
        }
        visited.add(id)
        id = node.spanId && node.spanDepth !== undefined &&
          (typeof depth !== "number" || depth <= node.spanDepth) ? node.spanId : node.parent
      }
      ancestry.set(previousId, false)
      return false
    }
    const stats = migrateLegacyMessagesIntoDurableRows({
      databasePath: messageDatabasePath,
      threadId,
      checkpointId: row.checkpointId,
      messages: durableMessages,
      sourcePrefixKeys,
      sourceClaims,
      occurrenceSnapshot,
      graphBoundaries,
      payloadBytes: sourceBytes,
      cancellation,
      searchGuard,
      reservationDeadline,
      sourceStillCurrent: sourceIsUnchanged,
      sourceFamilyStillCurrent: sourceFamilyUnchanged,
      sourceKey,
      transcriptRevision,
      parentCheckpointId: row.parentCheckpointId,
      descendsFrom
    })
    throwIfCancelled(cancellation)
    if (!reservedCheckpointId && sourceIsUnchanged()) {
      verifiedSource = { checkpointId: row.checkpointId, key: sourceKey }
    }
    return {
      runtimeTuple: checkpointTupleFromRaw({
        row,
        checkpoint: runtimeCheckpoint
      }),
      stats
    }
  } finally {
    lineageDatabase?.close()
    checkpointDatabase.close()
    if (verifiedSource && sqliteRecoveryFamilyKey(checkpointDatabasePath) === verifiedSource.key) {
      const database = new DatabaseSync(messageDatabasePath, { timeout: searchGuard ? 100 : 5000 })
      try {
        database.prepare(`UPDATE legacy_checkpoint_transcript_migrations SET source_key = ?
          WHERE thread_id = ? AND checkpoint_id = ? AND status = 'complete' AND source_key IS NOT ?`)
          .run(verifiedSource.key, threadId, verifiedSource.checkpointId, verifiedSource.key)
      } finally {
        database.close()
      }
    }
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
// A JSON string token uses at most six bytes per UTF-16 code unit, plus its quotes.
const CHECKPOINT_TRANSFER_IDENTITY_TOKEN_BYTE_LIMIT = MAX_BOUNDED_TRANSCRIPT_ID_LENGTH * 6 + 2
const CHECKPOINT_ID_HASH_FIELD = "cmb_checkpoint_id_sha256"
// Keep blank provider IDs invalid after SQL has replaced the original text with a hash.
const CHECKPOINT_ID_TRIM_CHARACTERS = "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195," +
  "8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)"
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

function boundedTransferIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_BOUNDED_TRANSCRIPT_ID_LENGTH
    ? value
    : undefined
}

function projectCheckpointIdentity(
  value: unknown,
  fromSql: boolean,
  kind: DisplayMessageIdKind
): string | undefined {
  if (typeof value === "string") return projectDisplayMessageId(value, kind)
  const hash = fromSql ? objectRecord(value)?.[CHECKPOINT_ID_HASH_FIELD] : undefined
  return typeof hash === "string" ? formatDisplayMessageIdHash(hash, kind) : undefined
}

function boundedTransferToolCalls(
  value: unknown,
  projectId = boundedTransferIdentity
): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.slice(0, CHECKPOINT_TRANSFER_TOOL_CALL_LIMIT).flatMap((rawToolCall) => {
    const toolCall = objectRecord(rawToolCall)
    if (!toolCall) return []
    const id = projectId(toolCall.id)
    return [
      {
        ...(id !== undefined ? { id } : {}),
        ...(typeof toolCall.name === "string" ? { name: toolCall.name.slice(0, 256) } : {}),
        args: boundedTransferToolArgs(toolCall.args)
      }
    ]
  })
}

function boundedTransferCheckpointMessage(
  raw: unknown,
  index: number,
  fromSql: boolean
): unknown | null {
  const message = objectRecord(raw)
  if (!message) return null
  const kwargs = objectRecord(message.kwargs) ?? {}
  const additionalKwargs =
    objectRecord(message.additional_kwargs) ?? objectRecord(kwargs.additional_kwargs) ?? {}
  const role = serializedMessageRole(message, kwargs)
  const rawId = kwargs.id ?? (typeof message.id === "string" ? message.id : undefined)
  const toolCalls = boundedTransferToolCalls(message.tool_calls ?? kwargs.tool_calls, (id) =>
    projectCheckpointIdentity(id, fromSql, "tool-call")
  )
  const toolCallId = projectCheckpointIdentity(
    message.tool_call_id ?? kwargs.tool_call_id,
    fromSql,
    "tool-call"
  )
  const name = message.name ?? kwargs.name
  const status = message.status ?? kwargs.status
  const providerSourceId = projectCheckpointIdentity(
    additionalKwargs[MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY],
    fromSql,
    "provider-source"
  )
  const provider =
    providerSourceId && (role !== "tool" || toolCallId)
      ? getMessageProviderTupleFromMetadata({
          [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: providerSourceId,
          [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]:
            additionalKwargs[MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]
        })
      : undefined
  const selectedAdditionalKwargs = {
    ...(additionalKwargs.cmb_internal_coordinator_notification === true
      ? { cmb_internal_coordinator_notification: true }
      : {}),
    ...(additionalKwargs.is_error === true ? { is_error: true } : {}),
    ...(provider && {
      [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: provider.provider_source_id,
      [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: provider.provider_occurrence
    })
  }
  return {
    id: typeof rawId === "string" && rawId ? rawId : `worker-snapshot-${index}`,
    type: role === "user" ? "human" : role === "assistant" ? "ai" : role,
    content: boundedTransferContent(message.content ?? kwargs.content),
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
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
    row.messageIndex,
    row.rawMessage === null
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

function registerCheckpointIdHash(database: DatabaseSync): void {
  // Store only the hash state in JS. SQLite supplies oversized IDs in 4 KiB pieces.
  const states = new Map<number, Hash>()
  let next = 0
  database.aggregate<number>("cmb_checkpoint_id_hash", {
    start: () => {
      const id = ++next
      states.set(id, createHash("sha256"))
      return id
    },
    step: (id, bytes) => {
      if (bytes instanceof Uint8Array) states.get(id)?.update(bytes)
      return id
    },
    result: (id) => {
      const hash = states.get(id)?.digest("hex") ?? null
      states.delete(id)
      return hash
    }
  })
}

function checkpointIdentityJson(jsonToken: string, { skipBlank = false } = {}): string {
  // The token comes from the serialized checkpoint, so the chunks hash the same
  // UTF-8 JSON representation as JSON.stringify on the ordinary row path.
  return `json((
    WITH RECURSIVE token(bytes) AS MATERIALIZED (SELECT CAST((${jsonToken}) AS BLOB)),
      chunks(position) AS (
        SELECT 1
        UNION ALL
        SELECT position + 4096 FROM chunks, token WHERE position + 4096 <= length(bytes)
      )
    SELECT CASE
      WHEN length(bytes) <= ${CHECKPOINT_TRANSFER_IDENTITY_TOKEN_BYTE_LIMIT}
        THEN CAST(bytes AS TEXT)
      ${skipBlank ? `WHEN length(CAST(trim(
        json_extract(CAST(bytes AS TEXT), '$'), ${CHECKPOINT_ID_TRIM_CHARACTERS}
      ) AS BLOB)) = 0 THEN NULL` : ""}
      WHEN bytes IS NOT NULL THEN json_object(
        '${CHECKPOINT_ID_HASH_FIELD}',
        (SELECT cmb_checkpoint_id_hash(substr(bytes, position, 4096) ORDER BY position) FROM chunks)
      )
    END FROM token
  ))`
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
                  'id', ${checkpointIdentityJson(`CASE
                    WHEN json_type(bounded_tool.tool_value, '$.id') = 'text'
                    THEN bounded_tool.tool_value -> '$.id' END`)},
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
          'tool_call_id', ${checkpointIdentityJson(`
            COALESCE(
              CASE WHEN json_type(message.value, '$.tool_call_id') = 'text'
                THEN message.value -> '$.tool_call_id' END,
              CASE WHEN json_type(message.value, '$.kwargs.tool_call_id') = 'text'
                THEN message.value -> '$.kwargs.tool_call_id' END
            )
          `)},
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
            'cmb_internal_provider_source_id', ${checkpointIdentityJson(`
              CASE
                WHEN json_type(message.value, '$.additional_kwargs') = 'object'
                  THEN CASE
                    WHEN json_type(message.value, '$.additional_kwargs.cmb_internal_provider_source_id') = 'text'
                      THEN message.value -> '$.additional_kwargs.cmb_internal_provider_source_id'
                  END
                ELSE CASE
                  WHEN json_type(message.value, '$.kwargs.additional_kwargs.cmb_internal_provider_source_id') = 'text'
                    THEN message.value -> '$.kwargs.additional_kwargs.cmb_internal_provider_source_id'
                END
              END
            `, { skipBlank: true })},
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
    .get(row.threadId, row.checkpointNs, row.checkpointId) as Record<string, unknown> | undefined
  if (!source) {
    throw new Error("[CheckpointRuntimeWorker] Checkpoint changed during bounded read")
  }
  const sourceType = typeof source.type === "string" ? source.type : "json"
  if (sourceType !== "json") {
    throw new Error(`[CheckpointRuntimeWorker] Unsupported checkpoint serialization: ${sourceType}`)
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
      registerCheckpointIdHash(database)
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
    const row = readStoredCheckpointRow(
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
