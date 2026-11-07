import type { NativeSqliteCurrentExecution, NativeSqliteReadOne } from "./native-sqlite-adapter"

const MATCH = "typeof(metadata) = 'text' AND metadata COLLATE BINARY = ?2"
const QUERY = `SELECT created_at, CASE WHEN ${MATCH} THEN 1 ELSE 0 END AS same_metadata,
  CASE WHEN ${MATCH} THEN NULL ELSE metadata END AS metadata
  FROM threads WHERE thread_id = ?1 LIMIT 1`
export const NATIVE_JOINED_CURRENT_QUERY = `SELECT t.thread_id AS physical_thread_id,t.created_at AS physical_created_at,
  t.metadata AS physical_metadata,s.thread_id,s.incarnation_key,s.workspace,
  c.logical_session_id,c.kind,c.checkpoint_namespace
  FROM threads t
  LEFT JOIN function_conversations c ON c.conversation_id=?1
  LEFT JOIN function_conversation_branches b ON b.branch_id=?2
    AND b.conversation_id=c.conversation_id
  LEFT JOIN function_logical_sessions s ON s.logical_session_id=c.logical_session_id
    AND b.branch_id IS NOT NULL WHERE t.thread_id=?3`
export const NATIVE_JOINED_CURRENT_HIGH_WATER_QUERY = NATIVE_JOINED_CURRENT_QUERY.replace(
  "c.logical_session_id,c.kind,c.checkpoint_namespace",
  "c.logical_session_id,c.kind,c.checkpoint_namespace,c.next_sequence")
const JOINED_MATCH = "typeof(t.metadata) = 'text' AND t.metadata COLLATE BINARY = ?4"
const JOINED_METADATA = `CASE WHEN ${JOINED_MATCH} THEN 1 ELSE 0 END AS same_metadata,
  CASE WHEN ${JOINED_MATCH} THEN NULL ELSE t.metadata END AS physical_metadata`
const JOINED_QUERY = NATIVE_JOINED_CURRENT_QUERY.replace(
  "t.metadata AS physical_metadata", JOINED_METADATA)
const JOINED_HIGH_WATER_QUERY = NATIVE_JOINED_CURRENT_HIGH_WATER_QUERY.replace(
  "t.metadata AS physical_metadata", JOINED_METADATA)
const charCodeAt = String.prototype.charCodeAt
const apply = Reflect.apply

function retainable(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 * 1024) return false
  // SQLite parameters cross UTF-8. Do not reuse text that cannot round-trip exactly.
  for (let index = 0; index < value.length; index++) {
    const code = apply(charCodeAt, value, [index]) as number
    if (code === 0) return false
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = apply(charCodeAt, value, [++index]) as number
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

/** Transfer deduplication only: every invocation still reads the current SQLite row. */
export function createNativeThreadIdentityReader(
  execution: NativeSqliteCurrentExecution
): NativeSqliteReadOne {
  return createTransferReader(execution.prepareReadOne(QUERY), false)
}

/** The joins and every non-metadata column remain a fresh observation in the same statement. */
export function createNativeJoinedThreadIdentityReader(
  execution: NativeSqliteCurrentExecution, highWater = false
): NativeSqliteReadOne {
  const read = execution.prepareReadOne(highWater ? JOINED_HIGH_WATER_QUERY : JOINED_QUERY)
  return createTransferReader(read, true)
}

function createTransferReader(read: NativeSqliteReadOne, joined: boolean): NativeSqliteReadOne {
  let raw: string | undefined
  let lastThread: unknown
  return (bindings): ReturnType<NativeSqliteReadOne> => {
    // These are only the two fixed native queries' captured internal bindings. Array literals
    // define own indices, so an inherited index-3 setter cannot intercept the new parameter.
    const values = bindings as readonly unknown[]
    const threadId = values[joined ? 2 : 0]
    const previous = threadId === lastThread ? raw : undefined
    const row = read(joined ? [values[0], values[1], threadId, previous ?? null] :
      [threadId, previous ?? null])
    lastThread = threadId
    if (!row) { raw = undefined; return undefined }
    const metadata = row.same_metadata === 1 && previous !== undefined ? previous :
      joined ? row.physical_metadata : row.metadata
    if (metadata !== previous) raw = retainable(metadata) ? metadata : undefined
    // Never return a cached mutable row or a cached creation timestamp.
    if (joined) {
      delete row.same_metadata
      return { ...row, physical_metadata: metadata }
    }
    return { created_at: row.created_at, metadata }
  }
}
