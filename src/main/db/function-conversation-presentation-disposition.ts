import { createHash } from "node:crypto"
import { types } from "node:util"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS, functionConversationProjectionIncarnation,
  readFunctionConversationProjectionReceipt, type FunctionConversationProjectionColumns,
  type FunctionConversationProjectionSelection } from "./function-conversation-projection-receipt"
import type { NativeSqliteAdapter, NativeSqliteValue } from "./native-sqlite-adapter"

const table = "function_conversation_presentation_dispositions"
const names = Object.freeze(["thread_id", "incarnation", "uuid", "target_json",
  "canonical_receipt_id", "canonical_row_digest", "native_payload_digest", "projection_digest",
  "anchor_digest", "intent_digest", "disposition", "version"] as const)
type SqlRow = Record<string, NativeSqliteValue>
export interface FunctionConversationPresentationDisposition {
  readonly kind: "visible" | "blank" | "plumbing"
  /** Includes legacy absence, so A/B readers detect insertion as well as mutation/removal. */
  readonly fingerprint: string
}
export interface FunctionConversationPresentationAnchor {
  readonly version: 1
  readonly disposition: "persisted" | "blank" | "plumbing"
  readonly intentDigest: string
}
/** Pure data from a caller's actual full canonical/member and 23-column seal. Not authority. */
export interface FunctionConversationPresentationDispositionData {
  readonly threadId: string
  readonly incarnation: string
  readonly uuid: string
  readonly targetJson: string
  readonly canonicalReceiptId: string
  readonly canonicalRowDigest: string
  readonly nativePayloadDigest: string
  readonly projectionDigest: string
  readonly orderAnchor: unknown
  readonly role: string
  readonly door: string
  readonly messageType: string
  readonly contentJson: string
  readonly recoveryIntegrity: NativeSqliteValue
}
const factNames = Object.freeze(["threadId", "incarnation", "uuid", "targetJson",
  "canonicalReceiptId", "canonicalRowDigest", "nativePayloadDigest", "projectionDigest",
  "orderAnchor", "role", "door", "messageType", "contentJson", "recoveryIntegrity"] as const)
const stringify = JSON.stringify
const reads = new WeakMap<FunctionConversationPresentationDisposition, {
  readonly database: NativeSqliteAdapter
  readonly captured: ReturnType<typeof prepareData>
}>()
function fail(code = "MODS_CONVERSATION_PRESENTATION_CONFLICT"): never {
  throw new ModFunctionError(code)
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex") }
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field || !field.enumerable || !("value" in field)) fail()
  return field.value
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) fail()
  return value
}
function copyData(value: unknown): unknown {
  let copied: unknown
  type Task = { value: unknown; put(value: unknown): void } | { exit: object }
  const tasks: Task[] = [{ value, put: value => { copied = value } }]
  const ancestors = new Set<object>()
  let remaining = 1_000_000
  while (tasks.length) {
    const task = tasks.pop()
    if (!task) fail()
    if ("exit" in task) { ancestors.delete(task.exit); continue }
    const input = task.value
    if (input === null || typeof input === "string" || typeof input === "boolean" ||
      typeof input === "number" && Number.isFinite(input)) { task.put(input); continue }
    if (!input || typeof input !== "object" || types.isProxy(input) || ancestors.has(input)) fail()
    const prototype = Object.getPrototypeOf(input), array = Array.isArray(input)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      fail()
    const keys = Reflect.ownKeys(input)
    const length: unknown = array ? Object.getOwnPropertyDescriptor(input, "length")?.value : undefined
    if (array && (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
      keys.length !== length + 1)) fail()
    if (keys.length > remaining) fail()
    remaining -= keys.length
    const output: object = array ? [] : Object.create(prototype)
    task.put(output)
    ancestors.add(input); tasks.push({ exit: input })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      if (array && key === "length") continue
      if (typeof key !== "string" || array &&
        (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= Number(length))) fail()
      const field = own(input, key)
      tasks.push({ value: field, put: value => {
        Object.defineProperty(output, key, { value, enumerable: true })
      } })
    }
  }
  return copied
}
function query(db: NativeSqliteAdapter, sql: string, args: readonly unknown[] = []): SqlRow[] {
  const result = db.exec(sql, args)[0]
  return result ? result.values.map(values => Object.fromEntries(
    result.columns.map((key, index) => [key, values[index]]))) : []
}
function exists(db: NativeSqliteAdapter): boolean {
  return query(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [table]).length === 1
}
function schema(db: NativeSqliteAdapter): void {
  const columns = query(db, `PRAGMA table_info(${table})`)
  if (columns.length !== names.length || columns.some((column, index) =>
    column.cid !== index || column.name !== names[index] || column.notnull !== 1 ||
    column.type !== (column.name === "version" ? "INTEGER" : "TEXT") ||
    column.pk !== (column.name === "thread_id" ? 1 : column.name === "incarnation" ? 2
      : column.name === "uuid" ? 3 : 0))) fail()
}
export function ensureFunctionConversationPresentationDispositionSchema(db: NativeSqliteAdapter): void {
  db.run(`CREATE TABLE IF NOT EXISTS ${table} (
    thread_id TEXT NOT NULL, incarnation TEXT NOT NULL, uuid TEXT NOT NULL,
    target_json TEXT NOT NULL, canonical_receipt_id TEXT NOT NULL,
    canonical_row_digest TEXT NOT NULL, native_payload_digest TEXT NOT NULL,
    projection_digest TEXT NOT NULL, anchor_digest TEXT NOT NULL, intent_digest TEXT NOT NULL,
    disposition TEXT NOT NULL, version INTEGER NOT NULL,
    PRIMARY KEY(thread_id,incarnation,uuid)
  )`)
  schema(db)
}

function capture(db: NativeSqliteAdapter, input: FunctionConversationProjectionSelection,
  columns: FunctionConversationProjectionColumns) {
  // Never read or call input.assertCurrent. Caller owns its original A/B source/proof scope.
  const target = copyData(own(input, "target")) as FunctionConversationProjectionSelection["target"]
  const row = copyData(own(input, "row")) as FunctionConversationProjectionSelection["row"]
  const incarnation = copyData(own(input, "incarnation")) as FunctionConversationProjectionSelection["incarnation"]
  const threadId = text(own(input, "threadId"))
  const selection: FunctionConversationProjectionSelection = { target, row, incarnation, threadId,
    assertCurrent: () => undefined }
  // All internal checks below are actual SQL/data checks, with no source/selection callbacks.
  const actual = readFunctionConversationProjectionReceipt(db, selection)
  if (Reflect.ownKeys(columns).length !== FUNCTION_CONVERSATION_PROJECTION_COLUMNS.length ||
    FUNCTION_CONVERSATION_PROJECTION_COLUMNS.some(key => own(columns, key) !== actual[key])) fail()
  const key = { thread_id: threadId, incarnation: functionConversationProjectionIncarnation(incarnation),
    uuid: text(row.uuid) }
  const receipt = query(db, `SELECT * FROM function_conversation_projection_receipts
    WHERE thread_id=? AND incarnation=? AND uuid=?`, Object.values(key))[0]
  if (!receipt) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
  return prepareData({ threadId, incarnation: key.incarnation, uuid: key.uuid,
    targetJson: text(receipt.target_json), canonicalReceiptId: text(receipt.canonical_receipt_id),
    canonicalRowDigest: text(receipt.canonical_row_digest),
    nativePayloadDigest: text(receipt.native_payload_digest),
    projectionDigest: text(receipt.projection_digest), orderAnchor: row.orderAnchor,
    role: text(actual.role), door: text(row.door), messageType: text(row.message.type),
    contentJson: text(actual.content_json), recoveryIntegrity: actual.recovery_integrity })
}

function prepareData(input: FunctionConversationPresentationDispositionData) {
  if (!input || typeof input !== "object" || types.isProxy(input) || Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) ||
    Reflect.ownKeys(input).length !== factNames.length) fail()
  const fixed: Record<string, unknown> = {}
  for (const key of factNames) Object.defineProperty(fixed, key, {
    value: key === "orderAnchor" ? copyData(own(input, key)) : own(input, key), enumerable: true })
  for (const key of factNames)
    if (key !== "orderAnchor" && key !== "recoveryIntegrity") text(fixed[key])
  for (const key of ["canonicalRowDigest", "nativePayloadDigest", "projectionDigest"] as const)
    if (typeof fixed[key] !== "string" || !/^[a-f0-9]{64}$/.test(fixed[key])) fail()
  if (fixed.recoveryIntegrity !== null && fixed.recoveryIntegrity !== 0 && fixed.recoveryIntegrity !== 1)
    fail()
  const encodedIncarnation = text(fixed.incarnation)
  let incarnation: unknown, target: unknown
  try {
    incarnation = JSON.parse(encodedIncarnation)
    target = JSON.parse(text(fixed.targetJson))
  } catch { fail() }
  if (!Array.isArray(incarnation) || incarnation.length !== 2 ||
    (incarnation[0] === "token" ? typeof incarnation[1] !== "string" || !incarnation[1]
      : incarnation[0] !== "legacy" || typeof incarnation[1] !== "number" ||
        !Number.isSafeInteger(incarnation[1]) || incarnation[1] < 0) ||
    stringify(incarnation) !== encodedIncarnation || !target || typeof target !== "object" ||
    Array.isArray(target) || Object.keys(target).length !== 8) fail()
  for (const key of ["logicalSessionId", "conversationId", "branchId", "threadId", "workspace",
    "incarnation"] as const) text(own(target, key))
  if (typeof own(target, "checkpointNamespace") !== "string" ||
    own(target, "kind") !== "main" && own(target, "kind") !== "child") fail()
  const key = { thread_id: text(fixed.threadId), incarnation: encodedIncarnation, uuid: text(fixed.uuid) }
  const rawAnchor = fixed.orderAnchor
  if (!rawAnchor || typeof rawAnchor !== "object" || Array.isArray(rawAnchor)) fail()
  const field = Object.getOwnPropertyDescriptor(rawAnchor, "presentation")
  let anchor: FunctionConversationPresentationAnchor | undefined
  if (field) {
    const value: unknown = field.value
    if (!field.enumerable || !("value" in field) || !value || typeof value !== "object" ||
      Array.isArray(value) || Reflect.ownKeys(value).length !== 3) fail()
    const version = own(value, "version"), disposition = own(value, "disposition")
    const intentDigest = own(value, "intentDigest")
    if (version !== 1 || disposition !== "persisted" && disposition !== "blank" &&
      disposition !== "plumbing" || typeof intentDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(intentDigest) || fixed.door !== "prompt" || fixed.messageType !== "user" ||
      fixed.role !== "user") fail()
    anchor = { version, disposition, intentDigest }
    if (disposition !== "persisted" &&
      (fixed.contentJson !== stringify("") || fixed.recoveryIntegrity !== 0)) fail()
  }
  const expected: SqlRow | undefined = anchor ? { ...key,
    target_json: text(fixed.targetJson), canonical_receipt_id: text(fixed.canonicalReceiptId),
    canonical_row_digest: text(fixed.canonicalRowDigest),
    native_payload_digest: text(fixed.nativePayloadDigest),
    projection_digest: text(fixed.projectionDigest), anchor_digest: hash(stringify(rawAnchor)),
    intent_digest: anchor.intentDigest, disposition: anchor.disposition, version: anchor.version } : undefined
  return { key, anchor, expected, projectionDigest: text(fixed.projectionDigest) }
}
function read(db: NativeSqliteAdapter, captured: ReturnType<typeof capture>):
  FunctionConversationPresentationDisposition {
  const available = exists(db)
  if (available) schema(db)
  const matching = available ? query(db, `SELECT * FROM ${table}
    WHERE thread_id=? AND incarnation=? AND uuid=?`, Object.values(captured.key)) : []
  if (matching.length > 1) fail()
  const actual = matching[0]
  if (!captured.expected) {
    if (actual) fail()
    const result = Object.freeze({ kind: "visible" as const, fingerprint: hash(stringify({
      ...captured.key, projectionDigest: captured.projectionDigest, ledger: null })) })
    reads.set(result, { database: db, captured })
    return result
  }
  if (!actual) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
  if (Object.keys(actual).length !== names.length || names.some(key =>
    actual[key] !== captured.expected?.[key])) fail()
  const result: FunctionConversationPresentationDisposition = Object.freeze({
    kind: captured.anchor?.disposition === "persisted" ? "visible"
    : captured.anchor?.disposition === "blank" ? "blank" : "plumbing",
  fingerprint: hash(stringify(names.map(key => actual[key]))) })
  reads.set(result, { database: db, captured })
  return result
}

/** Same Keeper transaction, after full writer/receipt verification. Never overwrite a ledger. */
export function recordFunctionConversationPresentationDisposition(db: NativeSqliteAdapter,
  selection: FunctionConversationProjectionSelection, columns: FunctionConversationProjectionColumns):
  void {
  if (!db.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
  const captured = capture(db, selection, columns)
  const expected = captured.expected
  if (expected) {
    if (!exists(db)) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
    schema(db)
    const previous = query(db, `SELECT 1 FROM ${table}
      WHERE thread_id=? AND incarnation=? AND uuid=?`, Object.values(captured.key))
    if (!previous.length) db.run(`INSERT INTO ${table} (${names.join(",")})
      VALUES (${names.map(() => "?").join(",")})`, names.map(key => expected[key]))
  }
  read(db, captured)
  if (!db.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
}

/** Data-only read. Use on both sides of the original Main scope, or inside Worker readonly txn. */
export function readFunctionConversationPresentationDisposition(db: NativeSqliteAdapter,
  selection: FunctionConversationProjectionSelection, columns: FunctionConversationProjectionColumns):
  FunctionConversationPresentationDisposition {
  return read(db, capture(db, selection, columns))
}

/** No canonical scan, source callback, cached row or authorization. Caller supplies its full seal. */
export function readFunctionConversationPresentationDispositionData(db: NativeSqliteAdapter,
  facts: FunctionConversationPresentationDispositionData): FunctionConversationPresentationDisposition {
  return read(db, prepareData(facts))
}

/** Original bounded data observation only. Does not retain native body or authorize its caller. */
export function revalidateFunctionConversationPresentationDispositionData(db: NativeSqliteAdapter,
  original: FunctionConversationPresentationDisposition): void {
  const record = reads.get(original)
  if (!record || record.database !== db) fail()
  const current = read(db, record.captured)
  if (current.kind !== original.kind || current.fingerprint !== original.fingerprint) fail()
}
