import { createHash } from "node:crypto"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { sameFunctionConversationTranscriptStamp,
  validateFunctionConversationTranscriptStamp } from "../../shared/mods/v2/conversation-transcript"
import { matchesThreadIncarnation, type ThreadIncarnation } from "../services/thread-incarnation"
import type { FunctionConversationRef, FunctionConversationRow } from "./function-conversation-store"
import { readFunctionConversationNativeSqliteCurrentExecution,
  type NativeSqliteAdapter, type NativeSqliteReadOne, type NativeSqliteValue } from
  "./native-sqlite-adapter"

/** Exact current storage schema. Unknown columns require an explicit receipt migration. */
export const FUNCTION_CONVERSATION_PROJECTION_COLUMNS = Object.freeze([
  "thread_id", "message_id", "provider_source_id", "provider_occurrence", "role", "content_json",
  "prompt_origin_json", "function_row_json", "reasoning", "tool_calls_json", "tool_call_id", "name",
  "status", "is_error", "content_priority", "stream_authority", "recovery_integrity", "goal_id",
  "active_window_id", "created_at", "start_at", "end_at", "ordinal"
] as const)
export type FunctionConversationProjectionColumn =
  typeof FUNCTION_CONVERSATION_PROJECTION_COLUMNS[number]
export type FunctionConversationProjectionColumns = Readonly<
  Record<FunctionConversationProjectionColumn, NativeSqliteValue>>

export interface FunctionConversationProjectionSelection {
  readonly target: FunctionConversationRef
  readonly row: FunctionConversationRow
  readonly threadId: string
  readonly incarnation: ThreadIncarnation
  assertCurrent(): void
}

type SqlRow = Record<string, NativeSqliteValue>
const TABLE = "function_conversation_projection_receipts"
const readers = new WeakMap<NativeSqliteAdapter, Map<string, NativeSqliteReadOne>>()
interface PinnedSelection extends FunctionConversationProjectionSelection {
  readonly memo: {
    payload?: { raw: string, digest: string, bytes: number }
    expected?: { columns: FunctionConversationProjectionColumns, value: SqlRow }
  }
}

function fail(code = "MODS_CONVERSATION_PROJECTION_CONFLICT"): never {
  throw new ModFunctionError(code)
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) fail()
  return value
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail()
  return value
}
function query(db: NativeSqliteAdapter, sql: string, args: readonly unknown[] = []): SqlRow[] {
  const result = db.exec(sql, args)[0]
  return result ? result.values.map(values => Object.fromEntries(
    result.columns.map((name, index) => [name, values[index]]))) : []
}
// Only fixed SELECT statements that already consumed the first row use this path.
// PRAGMA and multi-row reads continue through query. Native readers check their owner on every call.
function readOne(db: NativeSqliteAdapter, sql: string, args: readonly unknown[] = []):
  SqlRow | undefined {
  const execution = readFunctionConversationNativeSqliteCurrentExecution(db)
  if (!execution) return query(db, sql, args)[0]
  let statements = readers.get(db)
  if (!statements) { statements = new Map(); readers.set(db, statements) }
  let read = statements.get(sql)
  if (!read) { read = execution.prepareReadOne(sql); statements.set(sql, read) }
  return read(args)
}
function sync(guard: () => void): void {
  const result: unknown = guard()
  if (result && typeof (result as { then?: unknown }).then === "function")
    fail("MODS_CONVERSATION_ASYNC_TRANSACTION")
}
export function functionConversationProjectionIncarnation(incarnation: ThreadIncarnation): string {
  integer(incarnation.legacyCreatedAt)
  return JSON.stringify(incarnation.token === null ? ["legacy", incarnation.legacyCreatedAt]
    : ["token", text(incarnation.token)])
}
function targetJson(target: FunctionConversationRef): string {
  return JSON.stringify({ logicalSessionId: text(target.logicalSessionId),
    conversationId: text(target.conversationId), branchId: text(target.branchId),
    threadId: text(target.threadId), workspace: text(target.workspace),
    incarnation: functionConversationProjectionIncarnation(target.incarnation),
    checkpointNamespace: target.checkpointNamespace, kind: target.kind })
}
function rowDigest(row: FunctionConversationRow): string {
  return hash(JSON.stringify({ uuid: row.uuid, sequence: row.sequence, receiptId: row.receiptId,
    branchId: row.branchId, inputDigest: row.inputDigest, door: row.door, origin: row.origin,
    message: row.message, nativePayload: row.nativePayload, orderAnchor: row.orderAnchor,
    createdAt: row.createdAt, inbox: row.inbox, bytes: row.bytes }))
}
export function functionConversationProjectionStamp(target: FunctionConversationRef,
  row: FunctionConversationRow) {
  const stamp = { conversationId: target.conversationId, branchId: row.branchId,
    uuid: row.uuid, sequence: row.sequence, door: row.door, messageType: row.message.type,
    ...(row.message.isMeta === true ? { isMeta: true as const } : {}), origin: row.origin }
  validateFunctionConversationTranscriptStamp(stamp)
  return stamp
}

export function ensureFunctionConversationProjectionReceiptSchema(db: NativeSqliteAdapter): void {
  db.run(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    thread_id TEXT NOT NULL, incarnation TEXT NOT NULL, uuid TEXT NOT NULL,
    target_json TEXT NOT NULL, canonical_receipt_id TEXT NOT NULL,
    canonical_row_digest TEXT NOT NULL, native_payload_digest TEXT NOT NULL,
    projection_json TEXT NOT NULL, projection_digest TEXT NOT NULL,
    PRIMARY KEY(thread_id,incarnation,uuid)
  )`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_function_conversation_projection_thread_uuid
    ON ${TABLE}(thread_id,uuid)`)
}

function pin(input: FunctionConversationProjectionSelection): PinnedSelection {
  return Object.freeze({ target: Object.freeze({ ...input.target,
    incarnation: Object.freeze({ ...input.target.incarnation }) }), row: structuredClone(input.row),
    threadId: text(input.threadId), incarnation: Object.freeze({ ...input.incarnation }),
    assertCurrent: input.assertCurrent.bind(input), memo: {} })
}
function current(db: NativeSqliteAdapter, selection: PinnedSelection): void {
  sync(selection.assertCurrent)
  const row = readOne(db, "SELECT created_at,metadata FROM threads WHERE thread_id=?",
    [selection.threadId])
  if (!row || !matchesThreadIncarnation({ created_at: Number(row.created_at),
    metadata: typeof row.metadata === "string" ? row.metadata : null }, selection.incarnation))
    fail("MODS_CONVERSATION_THREAD_CHANGED")
  if (selection.row.branchId !== selection.target.branchId || !selection.row.uuid ||
    !selection.row.receiptId || selection.row.sequence < 1) fail()
  const stored = readOne(db, `SELECT * FROM function_conversation_rows
    WHERE conversation_id=? AND uuid=?`, [selection.target.conversationId, selection.row.uuid])
  if (!stored || typeof stored.payload_json !== "string") fail()
  // A fresh read is mandatory even within a pin. Same length/digest alone cannot reuse validation.
  const previous = selection.memo.payload
  const unchanged = previous?.raw === stored.payload_json
  const digest = unchanged ? previous.digest : hash(stored.payload_json)
  const bytes = unchanged ? previous.bytes : Buffer.byteLength(stored.payload_json)
  if (digest !== stored.payload_digest || bytes !== stored.bytes ||
    stored.branch_id !== selection.row.branchId || stored.sequence !== selection.row.sequence ||
    stored.receipt_id !== selection.row.receiptId || stored.input_digest !== selection.row.inputDigest ||
    stored.door !== selection.row.door || stored.created_at !== selection.row.createdAt ||
    stored.bytes !== selection.row.bytes) fail()
  if (!unchanged) {
    const payload: unknown = JSON.parse(stored.payload_json)
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail()
    const values = payload as Record<string, unknown>
    if (values.nativePayload !== selection.row.nativePayload || values.inbox !== selection.row.inbox ||
      JSON.stringify(values.origin) !== JSON.stringify(selection.row.origin) ||
      JSON.stringify(values.message) !== JSON.stringify(selection.row.message) ||
      JSON.stringify(values.orderAnchor) !== JSON.stringify(selection.row.orderAnchor)) fail()
    selection.memo.payload = { raw: stored.payload_json, digest, bytes }
  }
}

/** Raw values only. Never invoke a renderer parser, clamp, alias resolver or stream merge. */
export function readFunctionConversationRawProjection(db: NativeSqliteAdapter, threadId: string,
  uuid: string): FunctionConversationProjectionColumns | undefined {
  const schema = query(db, "PRAGMA table_info(thread_messages)")
  if (schema.length !== FUNCTION_CONVERSATION_PROJECTION_COLUMNS.length ||
    schema.some(column => !FUNCTION_CONVERSATION_PROJECTION_COLUMNS.some(name => name === column.name)))
    fail("MODS_CONVERSATION_PROJECTION_SCHEMA")
  const row = readOne(db, "SELECT * FROM thread_messages WHERE thread_id=? AND message_id=?",
    [text(threadId), text(uuid)])
  if (!row) return undefined
  return validateFunctionConversationRawProjection(row, threadId, uuid)
}

/** Shared pure column validation; this function does not certify a seal or COMMIT. */
export function validateFunctionConversationRawProjection(row: SqlRow, threadId: string,
  uuid: string): FunctionConversationProjectionColumns {
  const values = {} as Record<FunctionConversationProjectionColumn, NativeSqliteValue>
  for (const name of FUNCTION_CONVERSATION_PROJECTION_COLUMNS) {
    const value = row[name]
    if (!(value === null || typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value)))) fail()
    values[name] = value
  }
  if (values.thread_id !== threadId || values.message_id !== uuid ||
    !["user", "assistant", "system", "tool"].includes(String(values.role))) fail()
  for (const name of ["provider_source_id", "prompt_origin_json", "function_row_json", "reasoning",
    "tool_calls_json", "tool_call_id", "name", "status", "goal_id", "active_window_id"] as const)
    if (values[name] !== null && typeof values[name] !== "string") fail()
  if (typeof values.content_json !== "string") fail()
  const content: unknown = JSON.parse(values.content_json)
  if (!(typeof content === "string" || Array.isArray(content))) fail()
  integer(values.ordinal); integer(values.created_at)
  if (integer(values.stream_authority) > 7) fail()
  if (values.provider_occurrence !== null && integer(values.provider_occurrence) < 1) fail()
  if (values.content_priority !== null &&
    (typeof values.content_priority !== "number" || !Number.isFinite(values.content_priority) ||
      values.content_priority <= 0)) fail()
  for (const name of ["start_at", "end_at"] as const)
    if (values[name] !== null) integer(values[name])
  for (const name of ["is_error", "recovery_integrity"] as const)
    if (values[name] !== null && values[name] !== 0 && values[name] !== 1) fail()
  for (const name of ["content_json", "prompt_origin_json", "function_row_json", "tool_calls_json"] as const) {
    const encoded = values[name]
    if (encoded !== null) {
      if (typeof encoded !== "string") fail()
      try { JSON.parse(encoded) } catch { fail() }
    }
  }
  return Object.freeze(values)
}

function projection(db: NativeSqliteAdapter, selection: PinnedSelection):
  FunctionConversationProjectionColumns {
  current(db, selection)
  const actual = readFunctionConversationRawProjection(db, selection.threadId, selection.row.uuid)
  if (!actual || typeof actual.function_row_json !== "string") fail()
  const stamp: unknown = JSON.parse(actual.function_row_json)
  validateFunctionConversationTranscriptStamp(stamp)
  if (!sameFunctionConversationTranscriptStamp(stamp,
    functionConversationProjectionStamp(selection.target, selection.row))) fail()
  const role = actual.role
  if (role === "tool") {
    const content = selection.row.message.content
    if (typeof actual.tool_call_id !== "string" || !actual.tool_call_id ||
      selection.row.message.type !== "user" || selection.row.message.isMeta === true ||
      !["tool-result", "tool-message"].includes(selection.row.door) ||
      !Array.isArray(content) || content.length !== 1 || !content[0] ||
      typeof content[0] !== "object" || Array.isArray(content[0]) ||
      content[0].type !== "tool_result" || content[0].tool_use_id !== actual.tool_call_id) fail()
  } else if (role !== (selection.row.message.type === "attachment" ? "user"
    : selection.row.message.type)) fail()
  if (readOne(db, "SELECT 1 FROM thread_message_fragments WHERE thread_id=? AND message_id=? LIMIT 1",
    [selection.threadId, selection.row.uuid]) ||
    readOne(db, "SELECT 1 FROM thread_message_fragment_states WHERE thread_id=? AND message_id=? LIMIT 1",
    [selection.threadId, selection.row.uuid])) fail()
  current(db, selection)
  return actual
}

function expected(selection: PinnedSelection,
  columns: FunctionConversationProjectionColumns): SqlRow {
  if (selection.memo.expected?.columns === columns) return selection.memo.expected.value
  const encoded = JSON.stringify(columns)
  const value = { thread_id: selection.threadId,
    incarnation: functionConversationProjectionIncarnation(selection.incarnation),
    uuid: selection.row.uuid, target_json: targetJson(selection.target),
    canonical_receipt_id: selection.row.receiptId, canonical_row_digest: rowDigest(selection.row),
    native_payload_digest: hash(selection.row.nativePayload), projection_json: encoded,
    projection_digest: hash(encoded) }
  selection.memo.expected = { columns, value }
  return value
}
function readReceipt(db: NativeSqliteAdapter, selection: PinnedSelection,
  columns: FunctionConversationProjectionColumns): void {
  if (!readOne(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [TABLE]))
    fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
  const value = expected(selection, columns)
  const actual = readOne(db, `SELECT * FROM ${TABLE} WHERE thread_id=? AND incarnation=? AND uuid=?`,
    [value.thread_id, value.incarnation, value.uuid])
  if (!actual) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
  if (Object.entries(value).some(([key, item]) => actual[key] !== item)) fail()
}

/** Called only after the original native writer's full expected-column verification, in its txn. */
export function recordFunctionConversationProjectionReceipt(db: NativeSqliteAdapter,
  input: FunctionConversationProjectionSelection): void {
  const selection = pin(input)
  if (!db.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
  const columns = projection(db, selection), value = expected(selection, columns)
  const prior = readOne(db, `SELECT 1 FROM ${TABLE} WHERE thread_id=? AND incarnation=? AND uuid=?`,
    [value.thread_id, value.incarnation, value.uuid])
  if (!prior) {
    const names = Object.keys(value)
    db.run(`INSERT INTO ${TABLE} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
      Object.values(value))
  }
  readReceipt(db, selection, columns)
  if (!db.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
  current(db, selection)
}

/** Data integrity only. The actual native owner/target guard remains mandatory on both sides. */
export function readFunctionConversationProjectionReceipt(db: NativeSqliteAdapter,
  input: FunctionConversationProjectionSelection): FunctionConversationProjectionColumns {
  const selection = pin(input), columns = projection(db, selection)
  readReceipt(db, selection, columns)
  current(db, selection)
  return columns
}
