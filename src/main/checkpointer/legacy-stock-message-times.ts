import type { DatabaseSync } from "node:sqlite"
import type { LegacyMessageTimingTarget } from "./legacy-message-times"
import { createLegacyWriterTurn, LEGACY_WRITER_BATCH_BYTES, LEGACY_WRITER_BATCH_MS } from "./legacy-write-budget"

const TIME_PROJECTION = `json_extract(thread_values,
  '$.messageTimes', '$.messageTimeOrder',
  '$.internalGoalMessageTimes', '$.internalGoalMessageTimeOrder')`

// Older readers could mark a checkpoint suffix applied without checking dates
// for the earlier durable messages in the same archive.
const LEGACY_TIME_MAPPING_VERSION = 1

function legacyTimeArchiveSchema(database: DatabaseSync) {
  return database.prepare(`SELECT
    EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_legacy_message_times') AS present,
    EXISTS (SELECT 1 FROM pragma_table_info('thread_legacy_message_times')
      WHERE name = 'applied_context') AS versioned,
    EXISTS (SELECT 1 FROM pragma_table_info('legacy_checkpoint_transcript_migrations')
      WHERE name = 'source_key') AS source,
    EXISTS (SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'thread_search_structure_versions') AS structure`).get()
}

function readLegacyTimeContext(
  database: DatabaseSync, schema: Record<string, unknown>, threadId: string, sourceKey?: string
): string {
  const source = sourceKey === undefined && schema.source
    ? database.prepare("SELECT source_key FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?")
        .get(threadId)?.source_key : sourceKey
  const epoch = schema.structure
    ? database.prepare("SELECT epoch FROM thread_search_structure_versions WHERE thread_id = ?").get(threadId)?.epoch
    : null
  const size = database.prepare("SELECT COUNT(*) AS count FROM thread_messages WHERE thread_id = ?").get(threadId)?.count
  return JSON.stringify([LEGACY_TIME_MAPPING_VERSION, source ?? null, Number(epoch ?? 0), Number(size ?? 0)])
}

/** Ordinary UAT archives are tied to the exact durable membership, not only the checkpoint ID. */
export function hasPendingStockLegacyMessageTimes(
  database: DatabaseSync,
  threadId: string,
  checkpointId: string,
  sourceKey?: string
): boolean {
  const schema = legacyTimeArchiveSchema(database)
  if (!schema?.present) return false
  const archive = database
    .prepare(`SELECT applied_checkpoint_id, ${schema.versioned ? "applied_context" : "NULL AS applied_context"}
      FROM thread_legacy_message_times WHERE thread_id = ?`)
    .get(threadId)
  if (archive) {
    return archive.applied_checkpoint_id !== checkpointId || typeof archive.applied_context !== "string" ||
      archive.applied_context !== readLegacyTimeContext(database, schema, threadId, sourceKey)
  }
  // The stock page caller has already checked the ordinary checkpoint-ID rule.
  if (sourceKey !== undefined) return false
  return Boolean(database.prepare(`SELECT 1 FROM threads WHERE thread_id = ? AND
    CASE WHEN json_valid(thread_values) THEN
      json_type(thread_values, '$.messageTimes') = 'object'
      OR json_type(thread_values, '$.messageTimeOrder') = 'array'
    ELSE 0 END`).get(threadId))
}

interface TimeEntry {
  id?: string
  start_at?: unknown
  end_at?: unknown
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function timestamp(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Date.parse(value)
        : NaN
  return Number.isFinite(parsed) && Math.abs(parsed) <= 8.64e15 ? parsed : null
}

/** Runs only in the checkpoint worker's cold compatibility path, never in metadata hydration. */
export function migrateLegacyMessageTimes(
  database: DatabaseSync,
  threadId: string,
  checkpointId: string,
  originalMessages: readonly LegacyMessageTimingTarget[] | null,
  checkCancelled: () => void,
  writerTurn = createLegacyWriterTurn(),
  sourceKey?: string
): void {
  checkCancelled()
  // Some supported base-only fixture/deployed schemas have no thread_values yet.
  const columns = database.prepare("PRAGMA table_info(threads)").all()
  if (!columns.some((column) => column.name === "thread_values")) return
  const incarnation = columns.some((column) => column.name === "metadata")
    ? "CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.cmb_thread_incarnation') END"
    : "NULL"
  const schema = legacyTimeArchiveSchema(database)
  if (!schema?.present) return
  const thread = database
    .prepare(
      `SELECT created_at, ${incarnation} AS incarnation,
    CASE WHEN json_valid(thread_values) THEN ${TIME_PROJECTION} ELSE NULL END AS times
    FROM threads WHERE thread_id = ?`
    )
    .get(threadId)
  if (!thread) return
  const archived = database
    .prepare(
      `SELECT values_json, applied_checkpoint_id, ${schema.versioned ? "applied_context" : "NULL AS applied_context"}
       FROM thread_legacy_message_times WHERE thread_id = ?`
    )
    .get(threadId)
  const liveTimes =
    typeof thread.times === "string" && thread.times !== "[null,null,null,null]"
      ? thread.times
      : undefined
  const source =
    liveTimes ?? (typeof archived?.values_json === "string" ? archived.values_json : undefined)
  if (!source) return
  const context = readLegacyTimeContext(database, schema, threadId, sourceKey)
  if (archived?.values_json === source && archived.applied_checkpoint_id === checkpointId &&
      archived.applied_context === context) return

  // Keep a resumable source before touching rows. No JSON decoding under the writer lock.
  writerTurn.wait()
  checkCancelled()
  const staged = database
    .prepare(
      `INSERT INTO thread_legacy_message_times (thread_id, values_json)
    SELECT thread_id, ? FROM threads
    WHERE thread_id = ? AND created_at = ? AND ${incarnation} IS ?
      AND (CASE WHEN json_valid(thread_values) THEN ${TIME_PROJECTION} ELSE NULL END IS ?
        OR EXISTS (SELECT 1 FROM thread_legacy_message_times WHERE thread_id = ? AND values_json = ?))
    ON CONFLICT(thread_id) DO UPDATE SET values_json = excluded.values_json,
      applied_checkpoint_id = NULL
    WHERE thread_legacy_message_times.values_json IS ?
  `
    )
    .run(
      source,
      threadId,
      thread.created_at,
      thread.incarnation,
      liveTimes ?? null,
      threadId,
      source,
      archived?.values_json ?? null
    )
  writerTurn.released()
  if (Number(staged.changes) === 0) return

  const decoded = JSON.parse(source) as unknown[]
  const byId = record(decoded[0]) ?? {}
  const order = Array.isArray(decoded[1]) ? (decoded[1] as TimeEntry[]) : []
  const orderById = new Map<string, TimeEntry>()
  const duplicateIds = new Set<string>()
  for (let index = 0; index < order.length; index += 1) {
    if (index % 64 === 0) checkCancelled()
    const entry = record(order[index]) as TimeEntry | undefined
    if (!entry || typeof entry.id !== "string" || !entry.id) continue
    if (orderById.has(entry.id)) duplicateIds.add(entry.id)
    else orderById.set(entry.id, entry)
  }
  for (const id of duplicateIds) orderById.delete(id)
  // An archived named date can belong to any persisted row, even if the first
  // checkpoint discovered during recovery only contains the latest messages.
  const messages: Array<LegacyMessageTimingTarget & { ordinal: number }> = []
  const rows = database.prepare(`SELECT message_id, provider_source_id, provider_occurrence, ordinal
    FROM thread_messages WHERE thread_id = ? ORDER BY ordinal, message_id`)
  for (const row of rows.iterate(threadId)) {
    if (messages.length % 64 === 0) checkCancelled()
    if (typeof row.message_id !== "string") continue
    messages.push({
      messageId: row.message_id,
      providerSourceId: typeof row.provider_source_id === "string" ? row.provider_source_id : null,
      providerOccurrence: typeof row.provider_occurrence === "number" ? row.provider_occurrence : null,
      ordinal: Number(row.ordinal)
    })
  }
  const canonicalIds = new Set(messages.map((message) => message.messageId))
  const identityEntry = (message: LegacyMessageTimingTarget): TimeEntry | undefined => {
    const sourceId =
      (message.providerOccurrence ?? 1) <= 1 && !canonicalIds.has(message.providerSourceId ?? "")
        ? message.providerSourceId
        : null
    return (
      record(byId[message.messageId]) ??
      orderById.get(message.messageId) ??
      (sourceId ? (record(byId[sourceId]) ?? orderById.get(sourceId)) : undefined)
    )
  }
  // Only the verified original prefix can be aligned against an unnamed
  // positional archive. A checkpoint suffix cannot shift those positions.
  const useOrder = originalMessages !== null && order.length === originalMessages.length &&
    originalMessages.every((source, index) => messages[index]?.ordinal === index &&
      source.messageId === messages[index].messageId) && !messages.some(identityEntry)
  const changes: Array<{ threadId: string; messageId: string; start: number | null; end: number | null }> = []
  for (let index = 0; index < messages.length; index++) {
    const entry = identityEntry(messages[index]) ?? (useOrder ? record(order[index]) : undefined)
    const start = timestamp(entry?.start_at)
    const rawEnd = timestamp(entry?.end_at)
    const end = rawEnd !== null && (start === null || rawEnd >= start) ? rawEnd : null
    if (start !== null || end !== null) changes.push({ threadId, messageId: messages[index].messageId, start, end })
  }

  const needsWrite = `thread_id = $threadId AND message_id = $messageId AND (
    ($start IS NOT NULL AND start_at IS NULL AND (end_at IS NULL OR $start <= end_at))
    OR ($end IS NOT NULL AND end_at IS NULL AND (start_at IS NULL OR $end >= start_at)))`
  // SQLite rewrites the containing row even when only its timestamps change.
  const estimate = database.prepare(`SELECT 1024 + octet_length(content_json) +
      COALESCE(octet_length(tool_calls_json), 0) + COALESCE(octet_length(reasoning), 0) AS bytes
    FROM thread_messages WHERE ${needsWrite}`)
  const update = database.prepare(`UPDATE thread_messages
    SET start_at = COALESCE(start_at, CASE WHEN end_at IS NULL OR $start <= end_at THEN $start END),
      end_at = COALESCE(end_at, CASE WHEN start_at IS NULL OR $end >= start_at THEN $end END),
      created_at = CASE WHEN start_at IS NULL AND $start IS NOT NULL
        AND (end_at IS NULL OR $start <= end_at) THEN $start ELSE created_at END
    WHERE ${needsWrite}`)
  const isCurrent = database.prepare(`SELECT 1 FROM threads WHERE thread_id = ?
    AND created_at = ? AND ${incarnation} IS ?
    AND EXISTS (SELECT 1 FROM thread_legacy_message_times WHERE thread_id = ? AND values_json = ?)`)
  let offset = 0
  while (offset < changes.length) {
    writerTurn.wait()
    checkCancelled()
    database.exec("BEGIN IMMEDIATE")
    try {
      if (!isCurrent.get(threadId, thread.created_at, thread.incarnation, threadId, source) ||
          (useOrder && readLegacyTimeContext(database, schema, threadId, sourceKey) !== context)) {
        database.exec("ROLLBACK")
        return
      }
      const batchEnd = Math.min(offset + 64, changes.length)
      const started = performance.now()
      let bytes = 0
      do {
        const change = changes[offset]
        const estimatedBytes = Number(estimate.get(change)?.bytes ?? 0)
        if (bytes && bytes + estimatedBytes > LEGACY_WRITER_BATCH_BYTES) break
        if (estimatedBytes) update.run(change)
        bytes += estimatedBytes
        offset += 1
      } while (offset < batchEnd && performance.now() - started < LEGACY_WRITER_BATCH_MS)
      database.exec("COMMIT")
      writerTurn.released()
    } catch (error) {
      if (database.isTransaction) {
        database.exec("ROLLBACK")
      }
      throw error
    }
  }
  checkCancelled()
  const hasUnmappedOrder = !useOrder && order.some((raw) => {
    const entry = record(raw) as TimeEntry | undefined
    return entry && !entry.id && (timestamp(entry.start_at) !== null || timestamp(entry.end_at) !== null)
  })
  if (hasUnmappedOrder) return
  // Retain the archive for unmatched/internal entries and safe retries against a newer checkpoint.
  writerTurn.wait()
  checkCancelled()
  database.exec("BEGIN IMMEDIATE")
  try {
    if (readLegacyTimeContext(database, schema, threadId, sourceKey) === context) {
      database.prepare(`UPDATE thread_legacy_message_times SET applied_checkpoint_id = ?
        ${schema.versioned ? ", applied_context = ?" : ""}
        WHERE thread_id = ? AND values_json = ?
          AND EXISTS (SELECT 1 FROM threads WHERE thread_id = ? AND created_at = ?
            AND ${incarnation} IS ?)`).run(checkpointId, ...(schema.versioned ? [context] : []),
        threadId, source, threadId, thread.created_at, thread.incarnation)
    }
    database.exec("COMMIT")
    writerTurn.released()
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK")
    throw error
  }
}
