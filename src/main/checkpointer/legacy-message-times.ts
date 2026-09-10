import type { DatabaseSync } from "node:sqlite"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"

const TIME_PROJECTION = `json_extract(thread_values,
  '$.messageTimes', '$.messageTimeOrder',
  '$.internalGoalMessageTimes', '$.internalGoalMessageTimeOrder')`
const OLD_TIME_PROJECTION = TIME_PROJECTION.replace("thread_values", "OLD.thread_values")
const NEW_TIME_PROJECTION = TIME_PROJECTION.replace("thread_values", "NEW.thread_values")
const ARCHIVED_TIME_PROJECTION = `COALESCE(
  CASE WHEN json_valid(NEW.thread_values) THEN NULLIF(${NEW_TIME_PROJECTION}, '[null,null,null,null]') END,
  CASE WHEN json_valid(OLD.thread_values) THEN ${OLD_TIME_PROJECTION} END)`

/** Preserve legacy timing before compact writes, entirely inside the existing SQLite transaction. */
export function ensureLegacyMessageTimeArchive(database: NativeSqliteAdapter): void {
  database.run(`CREATE TABLE IF NOT EXISTS thread_legacy_message_times (
    thread_id TEXT PRIMARY KEY,
    values_json TEXT NOT NULL,
    applied_checkpoint_id TEXT
  )`)
  database.run(`CREATE TRIGGER IF NOT EXISTS preserve_legacy_message_times
    BEFORE UPDATE OF thread_values ON threads
    WHEN OLD.thread_values IS NOT NEW.thread_values
      AND (json_valid(OLD.thread_values) OR json_valid(NEW.thread_values))
    BEGIN
      INSERT INTO thread_legacy_message_times (thread_id, values_json)
      SELECT OLD.thread_id, ${ARCHIVED_TIME_PROJECTION}
      WHERE ${ARCHIVED_TIME_PROJECTION} <> '[null,null,null,null]'
      ON CONFLICT(thread_id) DO UPDATE SET
        values_json = excluded.values_json,
        applied_checkpoint_id = NULL
      WHERE thread_legacy_message_times.values_json <> excluded.values_json;
    END`)
  database.run(`CREATE TRIGGER IF NOT EXISTS delete_legacy_message_times
    AFTER DELETE ON threads
    BEGIN
      DELETE FROM thread_legacy_message_times WHERE thread_id = OLD.thread_id;
    END`)
}

interface TimingTarget {
  messageId: string
  providerSourceId: string | null
  providerOccurrence: number | null
}

/** Initial-page probe only; a completed archive is a primary-key-only fast path. */
export function hasPendingLegacyMessageTimes(
  database: DatabaseSync,
  threadId: string,
  checkpointId: string
): boolean {
  if (
    !database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_legacy_message_times'"
      )
      .get()
  )
    return false
  const archive = database
    .prepare("SELECT applied_checkpoint_id FROM thread_legacy_message_times WHERE thread_id = ?")
    .get(threadId)
  if (archive) return archive.applied_checkpoint_id !== checkpointId
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM threads WHERE thread_id = ? AND
    CASE WHEN json_valid(thread_values) THEN
      json_type(thread_values, '$.messageTimes') = 'object'
      OR json_type(thread_values, '$.messageTimeOrder') = 'array'
    ELSE 0 END`
      )
      .get(threadId)
  )
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
  messages: readonly TimingTarget[],
  checkCancelled: () => void
): void {
  checkCancelled()
  // Some supported base-only fixture/deployed schemas have no thread_values yet.
  const columns = database.prepare("PRAGMA table_info(threads)").all()
  if (!columns.some((column) => column.name === "thread_values")) return
  const incarnation = columns.some((column) => column.name === "metadata")
    ? "CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.cmb_thread_incarnation') END"
    : "NULL"
  const hasArchive = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_legacy_message_times'"
    )
    .get()
  if (!hasArchive) return
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
      "SELECT values_json, applied_checkpoint_id FROM thread_legacy_message_times WHERE thread_id = ?"
    )
    .get(threadId)
  const liveTimes =
    typeof thread.times === "string" && thread.times !== "[null,null,null,null]"
      ? thread.times
      : undefined
  const source =
    liveTimes ?? (typeof archived?.values_json === "string" ? archived.values_json : undefined)
  if (!source) return
  if (archived?.values_json === source && archived.applied_checkpoint_id === checkpointId) return

  // Keep a resumable source before touching rows. No JSON decoding under the writer lock.
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
  const canonicalIds = new Set(messages.map((message) => message.messageId))
  const identityEntry = (message: TimingTarget): TimeEntry | undefined => {
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
  // A positional fallback is allowed only for a complete, unshifted legacy order.
  const useOrder = order.length === messages.length && !messages.some(identityEntry)
  const update = database.prepare(`UPDATE thread_messages
    SET start_at = COALESCE(start_at, CASE WHEN end_at IS NULL OR ? <= end_at THEN ? END),
      end_at = COALESCE(end_at, CASE WHEN start_at IS NULL OR ? >= start_at THEN ? END),
      created_at = CASE WHEN start_at IS NULL AND ? IS NOT NULL
        AND (end_at IS NULL OR ? <= end_at) THEN ? ELSE created_at END
    WHERE thread_id = ? AND message_id = ?`)
  for (let offset = 0; offset < messages.length; offset += 64) {
    checkCancelled()
    database.exec("BEGIN IMMEDIATE")
    try {
      if (
        !database
          .prepare(
            `SELECT 1 FROM threads WHERE thread_id = ? AND created_at = ?
        AND ${incarnation} IS ?`
          )
          .get(threadId, thread.created_at, thread.incarnation)
      ) {
        database.exec("ROLLBACK")
        return
      }
      for (let index = offset; index < Math.min(offset + 64, messages.length); index += 1) {
        const entry =
          identityEntry(messages[index]) ?? (useOrder ? record(order[index]) : undefined)
        const start = timestamp(entry?.start_at)
        const rawEnd = timestamp(entry?.end_at)
        const end = rawEnd !== null && (start === null || rawEnd >= start) ? rawEnd : null
        if (start !== null || end !== null) {
          update.run(
            start,
            start,
            end,
            end,
            start,
            start,
            start,
            threadId,
            messages[index].messageId
          )
        }
      }
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  }
  checkCancelled()
  // Retain the archive for unmatched/internal entries and safe retries against a newer checkpoint.
  database
    .prepare(
      `UPDATE thread_legacy_message_times SET applied_checkpoint_id = ?
    WHERE thread_id = ? AND values_json = ?
      AND EXISTS (SELECT 1 FROM threads WHERE thread_id = ? AND created_at = ?
        AND ${incarnation} IS ?)`
    )
    .run(checkpointId, threadId, source, threadId, thread.created_at, thread.incarnation)
}
