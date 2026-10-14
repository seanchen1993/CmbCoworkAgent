import { createHash } from "node:crypto"
import { ToolMessage } from "@langchain/core/messages"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { validateFunctionConversationTranscriptStamp } from
  "../../shared/mods/v2/conversation-transcript"
import { deserializeFunctionConversationNativeMessage } from
  "../agent/function-conversation-native-message"
import { matchesThreadIncarnation, type ThreadIncarnation } from "../services/thread-incarnation"
import type { FunctionConversationRef, FunctionConversationRow } from "./function-conversation-store"
import { getDb, getThreadMessageCanonicalId } from "./index"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS, functionConversationProjectionStamp,
  readFunctionConversationRawProjection, readFunctionConversationProjectionReceipt,
  recordFunctionConversationProjectionReceipt,
  type FunctionConversationProjectionColumns } from "./function-conversation-projection-receipt"
import type { NativeSqliteAdapter, NativeSqliteValue } from "./native-sqlite-adapter"
import { readFunctionConversationPresentationDisposition,
  recordFunctionConversationPresentationDisposition } from
  "./function-conversation-presentation-disposition"

interface NativeForkThread {
  readonly threadId: string
  readonly incarnation: ThreadIncarnation
  assertCurrent(): void
}
export interface FunctionConversationForkVisibleSelector {
  readonly messageId: string
  readonly role: "user" | "assistant" | "system" | "tool"
  readonly providerSourceId?: string
  readonly providerOccurrence?: number
}
type SqlRow = Record<string, NativeSqliteValue>
interface Fragments {
  readonly rows: readonly { readonly content: string; readonly createdAt: number }[]
  readonly state: Readonly<{ totalChars: number; updatedAt: number }> | null
}
const tailBrand = Symbol("function-conversation-fork-transcript-data-tail")
export interface FunctionConversationForkTranscriptDataTail { readonly [tailBrand]: true }
interface DataObservation {
  readonly uuid: string
  readonly branchId?: string
  readonly fingerprint: string
  // This is only a factory-owned pure reader, never a caller's verifier/guard.
  readonly read: () => string
}
interface DataTail {
  readonly database: NativeSqliteAdapter
  readonly source: NativeForkThread
  readonly target: NativeForkThread
  readonly observations: Map<string, DataObservation>
}
const dataTails = new WeakMap<FunctionConversationForkTranscriptDataTail, DataTail>()
function observationKey(uuid: string, branchId?: string): string {
  return JSON.stringify([uuid, branchId ?? null])
}
function dataFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

/** Exact native access only. Caller keys select an already verified observation, not authority. */
export function assertFunctionConversationForkTranscriptDataTail(
  token: FunctionConversationForkTranscriptDataTail, database: NativeSqliteAdapter,
  expected?: readonly { readonly uuid: string; readonly branchId?: string }[],
  threads?: { readonly source: string; readonly target: string }
): void {
  const actual = dataTails.get(token)
  if (!actual || actual.database !== database || getDb() !== database ||
    threads && (threads.source !== actual.source.threadId || threads.target !== actual.target.threadId))
    fail()
  assertThreadData(database, actual.source)
  assertThreadData(database, actual.target)
  const check = (observation: DataObservation | undefined) => {
    if (!observation || observation.read() !== observation.fingerprint) fail()
  }
  if (expected) for (const key of expected)
    check(actual.observations.get(observationKey(key.uuid, key.branchId)))
  else for (const observation of actual.observations.values()) check(observation)
  if (getDb() !== database) fail()
  assertThreadData(database, actual.source)
  assertThreadData(database, actual.target)
}

function fail(code = "MODS_CONVERSATION_FORK_PROJECTION_CONFLICT"): never {
  throw new ModFunctionError(code)
}
function query(db: NativeSqliteAdapter, sql: string, args: readonly unknown[] = []): SqlRow[] {
  const result = db.exec(sql, args)[0]
  return result ? result.values.map(values => Object.fromEntries(
    result.columns.map((name, index) => [name, values[index]]))) : []
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail()
  return value
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) fail()
  return value
}
function sync(guard: () => void): void {
  const result: unknown = guard()
  if (result && typeof (result as { then?: unknown }).then === "function")
    fail("MODS_CONVERSATION_ASYNC_TRANSACTION")
}
function sameColumns(a: FunctionConversationProjectionColumns,
  b: FunctionConversationProjectionColumns): boolean {
  return FUNCTION_CONVERSATION_PROJECTION_COLUMNS.every(name => a[name] === b[name])
}
function fragments(db: NativeSqliteAdapter, threadId: string, uuid: string): Fragments {
  const rows = query(db, `SELECT content_text,created_at FROM thread_message_fragments
    WHERE thread_id=? AND message_id=? ORDER BY fragment_id`, [threadId, uuid]).map(row => {
    if (typeof row.content_text !== "string") fail()
    return Object.freeze({ content: row.content_text, createdAt: number(row.created_at) })
  })
  const state = query(db, `SELECT total_chars,updated_at FROM thread_message_fragment_states
    WHERE thread_id=? AND message_id=?`, [threadId, uuid])[0]
  return Object.freeze({ rows: Object.freeze(rows), state: state ? Object.freeze({
    totalChars: number(state.total_chars), updatedAt: number(state.updated_at) }) : null })
}
function canonicalPair(original: FunctionConversationRow, copied: FunctionConversationRow): void {
  const fixed = (row: FunctionConversationRow) => JSON.stringify({ uuid: row.uuid,
    sequence: row.sequence, inputDigest: row.inputDigest, door: row.door, origin: row.origin,
    message: row.message, nativePayload: row.nativePayload, orderAnchor: row.orderAnchor,
    createdAt: row.createdAt, inbox: row.inbox, bytes: row.bytes })
  if (fixed(original) !== fixed(copied) || original.receiptId === copied.receiptId) fail()
}
function actualTool(row: FunctionConversationRow, columns: FunctionConversationProjectionColumns): void {
  if (columns.role !== "tool") return
  const native = deserializeFunctionConversationNativeMessage(row.nativePayload)
  if (!ToolMessage.isInstance(native) || native.id !== row.uuid ||
    columns.tool_call_id !== native.tool_call_id ||
    (columns.status !== null && columns.status !== native.status) ||
    (columns.name !== null && columns.name !== native.name)) fail()
}
function pinThread(thread: NativeForkThread): NativeForkThread {
  return Object.freeze({ threadId: text(thread.threadId),
    incarnation: Object.freeze({ ...thread.incarnation }),
    assertCurrent: thread.assertCurrent.bind(thread) })
}
function assertThread(db: NativeSqliteAdapter, owner: NativeForkThread): void {
  sync(owner.assertCurrent)
  assertThreadData(db, owner)
}
function assertThreadData(db: NativeSqliteAdapter, owner: NativeForkThread): void {
  const row = query(db, "SELECT created_at,metadata FROM threads WHERE thread_id=?",
    [owner.threadId])[0]
  if (!row || !matchesThreadIncarnation({ created_at: Number(row.created_at),
    metadata: typeof row.metadata === "string" ? row.metadata : null }, owner.incarnation))
    fail("MODS_CONVERSATION_THREAD_CHANGED")
}
function storedRow(db: NativeSqliteAdapter, ref: FunctionConversationRef, uuid: string):
  { raw: SqlRow; row: FunctionConversationRow } {
  const raw = query(db, "SELECT * FROM function_conversation_rows WHERE conversation_id=? AND uuid=?",
    [ref.conversationId, uuid])[0]
  if (!raw || typeof raw.payload_json !== "string" ||
    createHash("sha256").update(raw.payload_json).digest("hex") !== raw.payload_digest ||
    Buffer.byteLength(raw.payload_json) !== raw.bytes) fail()
  const payload: unknown = JSON.parse(raw.payload_json)
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail()
  const data = payload as Record<string, unknown>
  const object = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail()
    return value as FunctionConversationRow["message"]
  }
  const row: FunctionConversationRow = Object.freeze({ uuid: text(raw.uuid), sequence: number(raw.sequence),
    receiptId: text(raw.receipt_id), branchId: text(raw.branch_id), inputDigest: text(raw.input_digest),
    door: text(raw.door), origin: object(data.origin), message: object(data.message),
    nativePayload: text(data.nativePayload), orderAnchor: object(data.orderAnchor),
    inbox: data.inbox === true, bytes: number(raw.bytes), createdAt: number(raw.created_at) })
  if (row.uuid !== uuid || row.branchId !== ref.branchId || !row.sequence) fail()
  return { raw, row }
}
function visibleIdentity(columns: FunctionConversationProjectionColumns,
  selector: FunctionConversationForkVisibleSelector): void {
  if (columns.role !== selector.role ||
    (selector.providerSourceId !== undefined &&
      selector.providerSourceId !== (columns.provider_source_id ?? selector.messageId)) ||
    (selector.providerOccurrence !== undefined &&
      selector.providerOccurrence !== (columns.provider_occurrence ?? 1))) fail()
}

/** Source-only preflight, before creating a target. A marker never becomes an ordinary row. */
export function captureFunctionConversationForkVisibleSource(input: {
  readonly source: NativeForkThread
  canonicalMessageId(messageId: string): string
}) {
  const database = getDb(), source = pinThread(input.source)
  const resolveId = input.canonicalMessageId.bind(input)
  const guard = () => {
    if (getDb() !== database) fail()
    assertThread(database, source)
  }
  guard()
  return Object.freeze({
    preflightVisible(selector: FunctionConversationForkVisibleSelector): boolean {
      guard()
      const id = text(selector.messageId)
      if (text(resolveId(id)) !== id) fail()
      const columns = readFunctionConversationRawProjection(database, source.threadId, id)
      if (!columns) { guard(); return false }
      visibleIdentity(columns, selector)
      if (columns.function_row_json !== null) {
        if (typeof columns.function_row_json !== "string") fail()
        const stamp: unknown = JSON.parse(columns.function_row_json)
        validateFunctionConversationTranscriptStamp(stamp)
        if (stamp.uuid !== id) fail()
      }
      const parts = fragments(database, source.threadId, id)
      guard()
      const latest = readFunctionConversationRawProjection(database, source.threadId, id)
      if (!latest || !sameColumns(latest, columns) ||
        JSON.stringify(fragments(database, source.threadId, id)) !== JSON.stringify(parts)) fail()
      guard()
      return true
    }
  })
}

/** Actual guarded app DB rows; neither an SDK capability nor a renderer Message converter. */
export function captureFunctionConversationForkTranscriptAccess(input: {
  readonly source: NativeForkThread
  readonly target: NativeForkThread
}) {
  const database = getDb()
  const source = pinThread(input.source), target = pinThread(input.target)
  if (source.threadId === target.threadId) fail()
  const dataTail: FunctionConversationForkTranscriptDataTail = Object.freeze({ [tailBrand]: true as const })
  const observations = new Map<string, DataObservation>()
  dataTails.set(dataTail, { database, source, target, observations })
  const observe = (uuid: string, branchId: string | undefined, read: () => string) => {
    const fingerprint = read(), key = observationKey(uuid, branchId), previous = observations.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail()
    } else observations.set(key, Object.freeze({ uuid, ...(branchId ? { branchId } : {}),
      fingerprint, read }))
  }
  const guard = (db: NativeSqliteAdapter, writing = false) => {
    if (db !== database || getDb() !== database) fail()
    if (writing && !database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    assertThread(database, source); assertThread(database, target)
    if (writing && !database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
  }
  const selection = (owner: NativeForkThread, ref: FunctionConversationRef,
    row: FunctionConversationRow) => {
    if (ref.kind !== "main" || ref.threadId !== owner.threadId ||
      ref.incarnation.token !== owner.incarnation.token ||
      ref.incarnation.legacyCreatedAt !== owner.incarnation.legacyCreatedAt ||
      ref.branchId !== row.branchId) fail()
    return { target: ref, row, threadId: owner.threadId, incarnation: owner.incarnation,
      assertCurrent: () => { guard(database); assertThread(database, owner) } }
  }
  const expected = (columns: FunctionConversationProjectionColumns, stamp?: string):
    FunctionConversationProjectionColumns => Object.freeze({ ...columns, thread_id: target.threadId,
      ...(stamp === undefined ? {} : { function_row_json: stamp }) })
  const aliasIdentity = (uuid: string) => {
    const original = getThreadMessageCanonicalId(source.threadId, uuid)
    const copied = getThreadMessageCanonicalId(target.threadId, uuid)
    if (original !== uuid || copied !== uuid) fail()
    return [original, copied]
  }
  const canonicalData = (sourceRef: FunctionConversationRef, targetRef: FunctionConversationRef,
    uuid: string): string => {
    const original = storedRow(database, sourceRef, uuid), copied = storedRow(database, targetRef, uuid)
    canonicalPair(original.row, copied.row)
    const from = { ...selection(source, sourceRef, original.row), assertCurrent: () => undefined }
    const to = { ...selection(target, targetRef, copied.row), assertCurrent: () => undefined }
    const columns = readFunctionConversationProjectionReceipt(database, from)
    const copiedColumns = readFunctionConversationProjectionReceipt(database, to)
    const wanted = expected(columns, JSON.stringify(functionConversationProjectionStamp(targetRef, copied.row)))
    if (!sameColumns(copiedColumns, wanted)) fail()
    actualTool(original.row, columns)
    const fromPresentation = readFunctionConversationPresentationDisposition(database, from, columns)
    const toPresentation = readFunctionConversationPresentationDisposition(database, to, copiedColumns)
    const fromParts = fragments(database, source.threadId, uuid)
    const toParts = fragments(database, target.threadId, uuid)
    if (fromParts.rows.length || fromParts.state || toParts.rows.length || toParts.state ||
      fromPresentation.kind !== toPresentation.kind) fail()
    return dataFingerprint([original.raw, copied.raw, columns, copiedColumns,
      fromPresentation, toPresentation, fromParts, toParts, aliasIdentity(uuid)])
  }
  const ordinaryData = (selector: FunctionConversationForkVisibleSelector): string => {
    const columns = readFunctionConversationRawProjection(database, source.threadId, selector.messageId)
    if (!columns || columns.function_row_json !== null) fail()
    visibleIdentity(columns, selector)
    const parts = fragments(database, source.threadId, selector.messageId)
    const values = expected(columns)
    verifyRaw(values, parts)
    // Ordinary absence cannot acquire a canonical receipt during a later row's guard.
    for (const owner of [source, target]) {
      if (query(database, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        ["function_conversation_projection_receipts"]).length &&
        query(database, "SELECT 1 FROM function_conversation_projection_receipts WHERE thread_id=? AND uuid=? LIMIT 1",
          [owner.threadId, selector.messageId]).length) fail()
      if (query(database, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        ["function_conversation_presentation_dispositions"]).length &&
        query(database, "SELECT 1 FROM function_conversation_presentation_dispositions WHERE thread_id=? AND uuid=? LIMIT 1",
          [owner.threadId, selector.messageId]).length) fail()
    }
    return dataFingerprint([columns, values, parts, aliasIdentity(selector.messageId)])
  }
  const verifyRaw = (values: FunctionConversationProjectionColumns, parts: Fragments) => {
    const uuid = text(values.message_id)
    const actual = readFunctionConversationRawProjection(database, target.threadId, uuid)
    if (!actual || !sameColumns(actual, values) ||
      JSON.stringify(fragments(database, target.threadId, uuid)) !== JSON.stringify(parts)) fail()
  }
  const insert = (values: FunctionConversationProjectionColumns, parts: Fragments) => {
    const uuid = text(values.message_id)
    const existing = readFunctionConversationRawProjection(database, target.threadId, uuid)
    if (existing) { verifyRaw(values, parts); return false }
    if (query(database, "SELECT 1 FROM thread_messages WHERE thread_id=? AND ordinal=? LIMIT 1",
      [target.threadId, values.ordinal]).length) fail()
    const provider = values.provider_source_id ?? uuid, occurrence = values.provider_occurrence ?? 1
    if (query(database, `SELECT 1 FROM thread_messages WHERE thread_id=? AND role=?
      AND COALESCE(provider_source_id,message_id)=? AND COALESCE(provider_occurrence,1)=? LIMIT 1`,
    [target.threadId, values.role, provider, occurrence]).length) fail()
    database.run(`INSERT INTO thread_messages (${FUNCTION_CONVERSATION_PROJECTION_COLUMNS.join(",")})
      VALUES (${FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(() => "?").join(",")})`,
    FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(name => values[name]))
    for (const row of parts.rows) database.run(`INSERT INTO thread_message_fragments
      (thread_id,message_id,content_text,created_at) VALUES (?,?,?,?)`,
    [target.threadId, uuid, row.content, row.createdAt])
    if (parts.state) database.run(`INSERT INTO thread_message_fragment_states
      (thread_id,message_id,total_chars,updated_at) VALUES (?,?,?,?)`,
    [target.threadId, uuid, parts.state.totalChars, parts.state.updatedAt])
    const bucket = query(database, "SELECT message_count,next_ordinal FROM thread_message_buckets WHERE thread_id=?",
      [target.threadId])[0]
    if (bucket) database.run(`UPDATE thread_message_buckets SET message_count=?,next_ordinal=?,updated_at=?
      WHERE thread_id=?`, [number(bucket.message_count) + 1,
      Math.max(number(bucket.next_ordinal), number(values.ordinal) + 1), Date.now(), target.threadId])
    else database.run(`INSERT INTO thread_message_buckets (thread_id,message_count,next_ordinal,updated_at)
      SELECT ?,COUNT(*),COALESCE(MAX(ordinal),-1)+1,? FROM thread_messages WHERE thread_id=?`,
    [target.threadId, Date.now(), target.threadId])
    verifyRaw(values, parts)
    return true
  }
  const canonical = (db: NativeSqliteAdapter, sourceRef: FunctionConversationRef,
    original: FunctionConversationRow, targetRef: FunctionConversationRef,
    copied: FunctionConversationRow, writing: boolean) => {
    guard(db, writing)
    canonicalPair(original, copied)
    const sourceSelection = selection(source, sourceRef, original)
    const columns = readFunctionConversationProjectionReceipt(database, sourceSelection)
    const presentation = readFunctionConversationPresentationDisposition(database, sourceSelection,
      columns)
    actualTool(original, columns)
    const parts = fragments(database, source.threadId, original.uuid)
    if (parts.rows.length || parts.state !== null) fail()
    const targetSelection = selection(target, targetRef, copied)
    const values = expected(columns, JSON.stringify(functionConversationProjectionStamp(targetRef, copied)))
    if (writing) {
      if (insert(values, parts)) {
        recordFunctionConversationProjectionReceipt(database, targetSelection)
        recordFunctionConversationPresentationDisposition(database, targetSelection, values)
      }
    }
    verifyRaw(values, parts)
    readFunctionConversationProjectionReceipt(database, targetSelection)
    guard(db, writing)
    // Original source callbacks are finished. Recheck every actual seal before returning success.
    const pureSource = { ...sourceSelection, assertCurrent: () => undefined }
    const pureTarget = { ...targetSelection, assertCurrent: () => undefined }
    const latest = readFunctionConversationProjectionReceipt(database, pureSource)
    const latestTarget = readFunctionConversationProjectionReceipt(database, pureTarget)
    const latestPresentation = readFunctionConversationPresentationDisposition(database, pureSource,
      latest)
    const targetPresentation = readFunctionConversationPresentationDisposition(database, pureTarget,
      latestTarget)
    if (!sameColumns(latest, columns) || !sameColumns(latestTarget, values) ||
      latestPresentation.kind !== presentation.kind ||
      latestPresentation.fingerprint !== presentation.fingerprint ||
      targetPresentation.kind !== presentation.kind ||
      JSON.stringify(fragments(database, source.threadId, original.uuid)) !== JSON.stringify(parts) ||
      JSON.stringify(fragments(database, target.threadId, copied.uuid)) !== JSON.stringify(parts) ||
      writing && !database.inTransaction) fail()
    // Keep only native refs/keys and a complete SQL-data fingerprint, never the full history body.
    const from = Object.freeze({ ...sourceRef, incarnation: Object.freeze({ ...sourceRef.incarnation }) })
    const to = Object.freeze({ ...targetRef, incarnation: Object.freeze({ ...targetRef.incarnation }) })
    const uuid = original.uuid
    observe(uuid, to.branchId, () => canonicalData(from, to, uuid))
  }
  const ordinary = (db: NativeSqliteAdapter, selector: FunctionConversationForkVisibleSelector,
    writing: boolean): boolean => {
    if (!writing && database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    guard(db, writing)
    const id = text(selector.messageId)
    const columns = readFunctionConversationRawProjection(database, source.threadId, id)
    if (!columns) {
      guard(db, writing)
      if (!writing) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
      return false
    }
    if (columns.function_row_json !== null) fail("MODS_CONVERSATION_MARKED_ROW_REQUIRED")
    visibleIdentity(columns, selector)
    const parts = fragments(database, source.threadId, id), values = expected(columns)
    if (writing) insert(values, parts)
    else verifyRaw(values, parts)
    const latest = readFunctionConversationRawProjection(database, source.threadId, id)
    if (!latest || !sameColumns(latest, columns) ||
      JSON.stringify(fragments(database, source.threadId, id)) !== JSON.stringify(parts)) fail()
    guard(db, writing)
    if (!writing && database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    const fixed = Object.freeze({ messageId: id, role: selector.role,
      ...(selector.providerSourceId === undefined ? {} : { providerSourceId: selector.providerSourceId }),
      ...(selector.providerOccurrence === undefined ? {} : { providerOccurrence: selector.providerOccurrence }) })
    observe(id, undefined, () => ordinaryData(fixed))
    return true
  }

  guard(database)
  return Object.freeze({
    dataTail,
    writeCanonical(db: NativeSqliteAdapter, sourceRef: FunctionConversationRef,
      original: FunctionConversationRow, targetRef: FunctionConversationRef, copied: FunctionConversationRow) {
      canonical(db, sourceRef, original, targetRef, copied, true)
    },
    verifyCanonical(db: NativeSqliteAdapter, sourceRef: FunctionConversationRef,
      original: FunctionConversationRow, targetRef: FunctionConversationRef, copied: FunctionConversationRow) {
      canonical(db, sourceRef, original, targetRef, copied, false)
    },
    copyPersistedVisible(db: NativeSqliteAdapter, selector: FunctionConversationForkVisibleSelector): boolean {
      return ordinary(db, selector, true)
    },
    verifyPersistedVisible(db: NativeSqliteAdapter, selector: FunctionConversationForkVisibleSelector): void {
      ordinary(db, selector, false)
    }
  })
}
