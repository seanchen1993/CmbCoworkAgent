import { createHash, randomUUID } from "node:crypto"
import { types } from "node:util"
import { DatabaseSync, StatementSync } from "node:sqlite"
import { CheckpointSnapshotInterpretations } from "./checkpoint-snapshot-interpretation"
import type { ModObject } from "../../shared/mods/types"
import { encodeModJson } from "../../shared/mods/validation"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation,
  type ThreadIncarnation
} from "../services/thread-incarnation"
import { deleteFunctionConversationThreadDataInTransaction } from "./function-conversation-cleanup"
import { readFunctionConversationNativeSqliteCurrentExecution,
  NativeSqliteAdapter, type NativeSqliteCurrentExecution,
  type NativeSqliteReadOne, type NativeSqliteValue } from "./native-sqlite-adapter"
import { ensureFunctionConversationProjectionReceiptSchema } from "./function-conversation-projection-receipt"
import { ensureFunctionConversationPresentationDispositionSchema } from
  "./function-conversation-presentation-disposition"
import { ensureFunctionConversationNativeDestinationSchema } from "./function-conversation-native-destination"
import {
  assertFunctionConversationForkReady,
  bindFunctionConversationForkStore,
  ensureFunctionConversationForkSchema
} from "./function-conversation-fork"
import {
  functionConversationMembershipDigest,
  functionConversationRowDigest,
  readFunctionConversationCheckpointMembership,
  type FunctionConversationCanonicalCut,
  type FunctionConversationCheckpointMembershipProof,
  type FunctionConversationCheckpointMembershipSnapshot
} from "../checkpointer/function-conversation-checkpoint-membership"

const checkpointInterpretations = new WeakMap<object, CheckpointSnapshotInterpretations>()
const readCheckpointInterpretation = CheckpointSnapshotInterpretations.prototype.read
const indexedCheckpointMember = CheckpointSnapshotInterpretations.prototype.member
const checkpointApply = Reflect.apply
function checkpointInterpreter(store: object): CheckpointSnapshotInterpretations {
  let value = checkpointApply(storeWeakGet, checkpointInterpretations, [store]) as
    CheckpointSnapshotInterpretations | undefined
  if (!value) {
    value = new CheckpointSnapshotInterpretations(functionConversationMembershipDigest)
    checkpointApply(storeWeakSet, checkpointInterpretations, [store, value])
  }
  return value
}

export const FUNCTION_CONVERSATION_LIMITS = Object.freeze({
  inboxRows: 64,
  inboxBytes: 16 * 1024 * 1024,
  sessionInboxRows: 256,
  sessionInboxBytes: 64 * 1024 * 1024,
  readRows: 4096,
  branchDepth: 32
})

/** Durable data identity. These strings are never an execution authority. */
export interface FunctionConversationRef {
  readonly logicalSessionId: string
  readonly conversationId: string
  readonly branchId: string
  readonly threadId: string
  readonly workspace: string
  readonly incarnation: ThreadIncarnation
  readonly checkpointNamespace: string
  readonly kind: "main" | "child"
}

export interface FunctionConversationRow {
  readonly uuid: string
  readonly sequence: number
  readonly receiptId: string
  readonly branchId: string
  readonly inputDigest: string
  readonly door: string
  readonly origin: ModObject
  readonly message: ModObject
  /** Exact host serializer output, including blocks, artifacts and native metadata. */
  readonly nativePayload: string
  readonly orderAnchor: ModObject
  readonly createdAt: number
  readonly inbox: boolean
  readonly bytes: number
}

/** Fixed host recovery boundary. This data does not confer execution or checkpoint authority. */
export interface FunctionConversationRowReadCut {
  readonly frontier: number
  readonly notAfterCreatedAt?: number
}

export interface FunctionConversationCommit {
  readonly uuid: string
  readonly inputDigest: string
  readonly door: string
  readonly origin: ModObject
  readonly message: ModObject
  readonly nativePayload: string
  readonly orderAnchor: ModObject
  readonly inbox: boolean
  readonly sdk: boolean
}

export interface FunctionConversationCheckpointReceipt {
  readonly checkpointId: string
  readonly generation: string
  readonly frontier: number
}

const checkpointReceiptBrand = Symbol("function-conversation-checkpoint-receipt")
export interface FunctionConversationDeliveryProof {
  readonly [checkpointReceiptBrand]: true
}

type SqlRow = Record<string, NativeSqliteValue>
type Guard = () => void
export type FunctionConversationTranscriptWriter = (
  database: NativeSqliteAdapter,
  target: FunctionConversationRef,
  row: FunctionConversationRow
) => void
/** Verify the actual canonical native row/source, not merely the sidecar receipt or write count. */
export type FunctionConversationTranscriptVerifier = FunctionConversationTranscriptWriter

function fail(code: string): never {
  throw new ModFunctionError(code)
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value.length) fail("MODS_CONVERSATION_STORE_CORRUPT")
  return value
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail("MODS_CONVERSATION_STORE_CORRUPT")
  return value
}

function rows(db: NativeSqliteAdapter, sql: string, args: readonly unknown[] = []): SqlRow[] {
  const result = db.exec(sql, args)[0]
  if (!result) return []
  return result.values.map((values) =>
    Object.fromEntries(result.columns.map((name, index) => [name, values[index]]))
  )
}

const CURRENT_THREAD_QUERY = "SELECT created_at, metadata FROM threads WHERE thread_id = ?"
const JOINED_CURRENT_QUERY = `SELECT t.thread_id AS physical_thread_id,t.created_at AS physical_created_at,
  t.metadata AS physical_metadata,s.thread_id,s.incarnation_key,s.workspace,
  c.logical_session_id,c.kind,c.checkpoint_namespace
  FROM threads t
  LEFT JOIN function_conversations c ON c.conversation_id=?
  LEFT JOIN function_conversation_branches b ON b.branch_id=?
    AND b.conversation_id=c.conversation_id
  LEFT JOIN function_logical_sessions s ON s.logical_session_id=c.logical_session_id
    AND b.branch_id IS NOT NULL WHERE t.thread_id=?`
const CURRENT_HIGH_WATER_QUERY = "SELECT next_sequence FROM function_conversations WHERE conversation_id = ?"
const JOINED_CURRENT_HIGH_WATER_QUERY = JOINED_CURRENT_QUERY.replace(
  "c.logical_session_id,c.kind,c.checkpoint_namespace",
  "c.logical_session_id,c.kind,c.checkpoint_namespace,c.next_sequence")
const CURRENT_TARGET_QUERY = `SELECT s.thread_id, s.incarnation_key, s.workspace,
  c.logical_session_id, c.kind, c.checkpoint_namespace, b.conversation_id
  FROM function_conversations c JOIN function_logical_sessions s
  ON s.logical_session_id = c.logical_session_id JOIN function_conversation_branches b
  ON b.conversation_id = c.conversation_id WHERE c.conversation_id = ? AND b.branch_id = ?`
const currentReads = new WeakMap<NativeSqliteAdapter, Map<string, NativeSqliteReadOne>>()
const currentReadsInUse = new WeakMap<NativeSqliteAdapter, Set<string>>()
const pureCurrentReaders = new WeakSet<NativeSqliteReadOne>()
const currentDescriptor = Object.getOwnPropertyDescriptor, currentPrototype = Object.getPrototypeOf
const currentFrozen = Object.isFrozen, currentApply = Reflect.apply
const currentWeakHas = WeakSet.prototype.has, currentWeakAdd = WeakSet.prototype.add
const nativePrepare = DatabaseSync.prototype.prepare, nativeGet = StatementSync.prototype.get
const publicReadOne = NativeSqliteAdapter.prototype.prepareReadOne
const currentJson = JSON, currentParse = JSON.parse, currentStringify = JSON.stringify
const currentArrayIsArray = Array.isArray, currentNumber = Number
const currentSafeInteger = Number.isSafeInteger
const currentEntries = Object.entries, currentDefine = Object.defineProperty
const currentObject = Object, currentArray = Array, currentReflect = Reflect
const currentUint8Array = Uint8Array, currentFunction = Function, currentIsProxy = types.isProxy
const currentMap = Map, currentSet = Set
const currentHasInstanceKey = Symbol.hasInstance
const currentTypedConstructor = currentPrototype(currentUint8Array)
const currentHasInstance = currentDescriptor(currentFunction.prototype, currentHasInstanceKey)!.value
function currentDataField(receiver: object, key: PropertyKey, value: unknown): boolean {
  const field = currentDescriptor(receiver, key)
  return !!field && "value" in field && field.value === value
}

function originalCurrentDispatch(database: NativeSqliteAdapter): boolean {
  // Fixed readers still traverse these origin/row helpers; an override must keep the old windows.
  if (!currentDataField(globalThis, "Object", currentObject) ||
    !currentDataField(globalThis, "Array", currentArray) ||
    !currentDataField(globalThis, "Reflect", currentReflect) ||
    !currentDataField(globalThis, "Uint8Array", currentUint8Array) ||
    !currentDataField(globalThis, "Function", currentFunction) ||
    !currentDataField(currentObject, "getOwnPropertyDescriptor", currentDescriptor) ||
    !currentDataField(currentObject, "getPrototypeOf", currentPrototype) ||
    !currentDataField(currentNumber, "isSafeInteger", currentSafeInteger)) return false
  if (types.isProxy !== currentIsProxy ||
    currentDescriptor(currentUint8Array, currentHasInstanceKey) ||
    currentPrototype(currentUint8Array) !== currentTypedConstructor ||
    currentDescriptor(currentTypedConstructor, currentHasInstanceKey) ||
    currentPrototype(currentTypedConstructor) !== currentFunction.prototype ||
    !currentDataField(currentFunction.prototype, currentHasInstanceKey, currentHasInstance) ||
    currentPrototype(currentArray.prototype) !== currentObject.prototype ||
    currentPrototype(currentObject.prototype) !== null) return false
  // The joined query binds exactly three primitives; array normalization must not call a setter.
  for (let index = 0; index < 3; index++)
    if (currentDescriptor(currentArray.prototype, index) ||
      currentDescriptor(currentObject.prototype, index)) return false
  if (types.isProxy(database) || currentPrototype(database) !== NativeSqliteAdapter.prototype) return false
  const field = currentDescriptor(database, "native")
  if (!field || !("value" in field) || !field.value ||
    types.isProxy(field.value) || currentPrototype(field.value) !== DatabaseSync.prototype ||
    currentDescriptor(field.value, "prepare") || currentDescriptor(database, "prepareReadOne")) return false
  const prepare = currentDescriptor(DatabaseSync.prototype, "prepare")
  const get = currentDescriptor(StatementSync.prototype, "get")
  const read = currentDescriptor(NativeSqliteAdapter.prototype, "prepareReadOne")
  const apply = currentDescriptor(Reflect, "apply")
  const entries = currentDescriptor(Object, "entries"), define = currentDescriptor(Object, "defineProperty")
  const array = currentDescriptor(Array, "isArray")
  return !!prepare && "value" in prepare && prepare.value === nativePrepare &&
    !!get && "value" in get && get.value === nativeGet &&
    !!read && "value" in read && read.value === publicReadOne &&
    !!apply && "value" in apply && apply.value === currentApply &&
    !!entries && "value" in entries && entries.value === currentEntries &&
    !!define && "value" in define && define.value === currentDefine &&
    !!array && "value" in array && array.value === currentArrayIsArray
}

function joinedCurrentTarget(target: FunctionConversationRef): boolean {
  const parse = currentDescriptor(currentJson, "parse"), stringify = currentDescriptor(currentJson, "stringify")
  const json = currentDescriptor(globalThis, "JSON"), number = currentDescriptor(globalThis, "Number")
  if (!json || !("value" in json) || json.value !== currentJson ||
    !number || !("value" in number) || number.value !== currentNumber ||
    !parse || !("value" in parse) || parse.value !== currentParse ||
    !stringify || !("value" in stringify) || stringify.value !== currentStringify ||
    currentDescriptor(Object.prototype, "cmb_thread_incarnation") ||
    currentDescriptor(Object.prototype, "toJSON") || currentDescriptor(Array.prototype, "toJSON") ||
    !target || types.isProxy(target) || !currentFrozen(target) || currentPrototype(target) !== Object.prototype)
    return false
  const names = ["threadId", "conversationId", "branchId", "logicalSessionId", "workspace",
    "checkpointNamespace", "kind"]
  for (let index = 0; index < names.length; index++) {
    const field = currentDescriptor(target, names[index])
    if (!field || !("value" in field) || typeof field.value !== "string") return false
  }
  const incarnation = currentDescriptor(target, "incarnation")
  if (!incarnation || !("value" in incarnation) || !incarnation.value || types.isProxy(incarnation.value) ||
    !currentFrozen(incarnation.value) || currentPrototype(incarnation.value) !== Object.prototype) return false
  const token = currentDescriptor(incarnation.value, "token")
  const time = currentDescriptor(incarnation.value, "legacyCreatedAt")
  return !!token && "value" in token && (token.value === null || typeof token.value === "string" && !!token.value) &&
    !!time && "value" in time && typeof time.value === "number" &&
    currentSafeInteger(time.value) && time.value >= 0
}

function assertJoinedCurrent(database: NativeSqliteAdapter, target: FunctionConversationRef,
  execution: NativeSqliteCurrentExecution, sql = JOINED_CURRENT_QUERY): SqlRow {
  const row = readCurrentExecution(database, execution, sql,
    [target.conversationId, target.branchId, target.threadId])
  if (!row || row.physical_thread_id !== target.threadId ||
    !matchesThreadIncarnation({ created_at: currentNumber(row.physical_created_at),
      metadata: typeof row.physical_metadata === "string" ? row.physical_metadata : null },
    target.incarnation)) fail("MODS_CONVERSATION_THREAD_CHANGED")
  if (row.thread_id !== target.threadId || row.workspace !== target.workspace ||
    row.incarnation_key !== currentStringify(target.incarnation.token === null
      ? ["legacy", target.incarnation.legacyCreatedAt] : ["token", target.incarnation.token]) ||
    row.logical_session_id !== target.logicalSessionId || row.kind !== target.kind ||
    row.checkpoint_namespace !== target.checkpointNamespace)
    fail("MODS_CONVERSATION_TARGET_CHANGED")
  return row
}
const executionReads = new WeakMap<NativeSqliteAdapter, Map<string, NativeSqliteReadOne>>()
const executionReadsInUse = new WeakMap<NativeSqliteAdapter, Set<string>>()
const storeWeakGet = WeakMap.prototype.get, storeWeakSet = WeakMap.prototype.set
const storeMapGet = Map.prototype.get, storeMapSet = Map.prototype.set
const storeMapDelete = Map.prototype.delete
const storeSetHas = Set.prototype.has, storeSetAdd = Set.prototype.add
const storeSetDelete = Set.prototype.delete
interface StoreCurrentOrigin {
  readonly store: FunctionConversationStore
  readonly database: NativeSqliteAdapter
  readonly prototype: object | null
  readonly field: PropertyDescriptor
  execution?: FunctionConversationStoreCurrentExecution
  failed: boolean
  reading: boolean
}
const storeCurrentOrigins = new WeakMap<FunctionConversationStore, StoreCurrentOrigin>()
export interface FunctionConversationStoreCurrentExecution {
  assertCurrent(target: FunctionConversationRef): void
  assertDataCurrent(): void
}

/** Constructor/resource identity only. The Registry must separately prove its live source relation. */
export function readFunctionConversationStoreCurrentExecution(store: unknown,
  expectedDatabase: NativeSqliteAdapter): FunctionConversationStoreCurrentExecution | undefined {
  if (!store || typeof store !== "object" || types.isProxy(store)) return undefined
  const record = Reflect.apply(storeWeakGet, storeCurrentOrigins, [store]) as
    StoreCurrentOrigin | undefined
  if (!record || record.database !== expectedDatabase) return undefined
  const adapter = readFunctionConversationNativeSqliteCurrentExecution(expectedDatabase)
  if (!adapter) return undefined
  if (record.execution) { record.execution.assertDataCurrent(); return record.execution }
  const assertDataCurrent = () => {
    try {
      if (record.failed || types.isProxy(record.store) ||
        Reflect.apply(storeWeakGet, storeCurrentOrigins, [record.store]) !== record ||
        Object.getPrototypeOf(record.store) !== record.prototype)
        fail("MODS_CONVERSATION_TARGET_CHANGED")
      const field = Object.getOwnPropertyDescriptor(record.store, "database")
      if (!field || !("value" in field) || field.value !== record.database ||
        field.enumerable !== record.field.enumerable || field.writable !== record.field.writable ||
        field.configurable !== record.field.configurable) fail("MODS_CONVERSATION_TARGET_CHANGED")
      adapter.assertDataCurrent()
    } catch (error) { record.failed = true; throw error }
  }
  const execution: FunctionConversationStoreCurrentExecution = Object.freeze({ assertDataCurrent,
    assertCurrent(target: FunctionConversationRef) {
      if (record.reading || record.failed) { record.failed = true; fail("MODS_CONVERSATION_TARGET_CHANGED") }
      record.reading = true
      try {
        assertDataCurrent()
        if (joinedCurrentTarget(target) && originalCurrentDispatch(record.database))
          assertJoinedCurrent(record.database, target, adapter)
        else {
          assertThreadCurrent(record.database, target, adapter)
          assertConversationCurrent(record.database, target, adapter)
        }
        assertDataCurrent()
      } catch (error) { record.failed = true; throw error }
      finally { record.reading = false }
    } })
  assertDataCurrent()
  record.execution = execution
  return execution
}

/** Reuse SELECT compilation only. Every invocation reads fresh rows and runs all guards. */
function readCurrent(db: NativeSqliteAdapter, sql: string, args: readonly unknown[]): SqlRow | undefined {
  let busy = currentReadsInUse.get(db)
  if (!busy) { busy = new Set(); currentReadsInUse.set(db, busy) }
  const temporary = busy.has(sql)
  if (!temporary) busy.add(sql)
  let reads = currentReads.get(db)
  if (!reads) { reads = new Map(); currentReads.set(db, reads) }
  let read: NativeSqliteReadOne | undefined
  try {
    read = temporary ? db.prepareReadOne(sql) : reads.get(sql)
    if (!read) {
      const pure = originalCurrentDispatch(db)
      read = db.prepareReadOne(sql)
      if (pure && originalCurrentDispatch(db)) currentApply(currentWeakAdd, pureCurrentReaders, [read])
      reads.set(sql, read)
    }
    return read(args)
  } catch (error) {
    if (!temporary && reads.get(sql) === read) reads.delete(sql)
    throw error
  } finally { if (!temporary) busy.delete(sql) }
}

function readCurrentExecution(db: NativeSqliteAdapter, adapter: NativeSqliteCurrentExecution,
  sql: string, args: readonly unknown[]): SqlRow | undefined {
  let busy = Reflect.apply(storeWeakGet, executionReadsInUse, [db]) as Set<string> | undefined
  if (!busy) { busy = new Set(); Reflect.apply(storeWeakSet, executionReadsInUse, [db, busy]) }
  const temporary = Reflect.apply(storeSetHas, busy, [sql]) === true
  if (!temporary) Reflect.apply(storeSetAdd, busy, [sql])
  let reads = Reflect.apply(storeWeakGet, executionReads, [db]) as Map<string, NativeSqliteReadOne> | undefined
  if (!reads) { reads = new Map(); Reflect.apply(storeWeakSet, executionReads, [db, reads]) }
  let read: NativeSqliteReadOne | undefined
  try {
    read = temporary ? adapter.prepareReadOne(sql) :
      Reflect.apply(storeMapGet, reads, [sql]) as NativeSqliteReadOne | undefined
    if (!read) { read = adapter.prepareReadOne(sql); Reflect.apply(storeMapSet, reads, [sql, read]) }
    return read(args)
  } catch (error) {
    if (!temporary && Reflect.apply(storeMapGet, reads, [sql]) === read)
      Reflect.apply(storeMapDelete, reads, [sql])
    throw error
  } finally { if (!temporary) Reflect.apply(storeSetDelete, busy, [sql]) }
}

function assertThreadCurrent(database: NativeSqliteAdapter,
  target: Pick<FunctionConversationRef, "threadId" | "incarnation">,
  execution?: NativeSqliteCurrentExecution): void {
  const args = [target.threadId]
  const row = execution ? readCurrentExecution(database, execution, CURRENT_THREAD_QUERY, args) :
    readCurrent(database, CURRENT_THREAD_QUERY, args)
  if (!row || !matchesThreadIncarnation({ created_at: Number(row.created_at),
    metadata: typeof row.metadata === "string" ? row.metadata : null }, target.incarnation))
    fail("MODS_CONVERSATION_THREAD_CHANGED")
}

function assertConversationCurrent(database: NativeSqliteAdapter, target: FunctionConversationRef,
  execution?: NativeSqliteCurrentExecution): void {
  const args = [target.conversationId, target.branchId]
  const row = execution ? readCurrentExecution(database, execution, CURRENT_TARGET_QUERY, args) :
    readCurrent(database, CURRENT_TARGET_QUERY, args)
  if (!row || row.thread_id !== target.threadId || row.workspace !== target.workspace ||
    row.incarnation_key !== incarnationKey(target.incarnation) ||
    row.logical_session_id !== target.logicalSessionId || row.kind !== target.kind ||
    row.checkpoint_namespace !== target.checkpointNamespace)
    fail("MODS_CONVERSATION_TARGET_CHANGED")
}

function incarnationKey(value: ThreadIncarnation): string {
  if (value.token !== null) return JSON.stringify(["token", string(value.token)])
  return JSON.stringify(["legacy", integer(value.legacyCreatedAt)])
}

function checkpointTargetJson(target: FunctionConversationRef): string {
  return JSON.stringify({ logicalSessionId: target.logicalSessionId, conversationId: target.conversationId,
    branchId: target.branchId, threadId: target.threadId, workspace: target.workspace,
    incarnation: incarnationKey(target.incarnation), checkpointNamespace: target.checkpointNamespace,
    kind: target.kind })
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/** The verifier can mutate nested data. Never invoke its getters, toJSON or Proxy traps at ACK. */
function sameCommittedData(left: unknown, right: unknown): boolean {
  type Task = { left: unknown; right: unknown; leave?: false } |
    { left: object; right: object; leave: true }
  const tasks: Task[] = [{ left, right }]
  const leftAncestors = new WeakSet<object>(), rightAncestors = new WeakSet<object>()
  let expanded = 1
  while (tasks.length) {
    const task = tasks.pop()!
    if (task.leave) {
      leftAncestors.delete(task.left)
      rightAncestors.delete(task.right)
      continue
    }
    const a = task.left, b = task.right
    if (a === null || typeof a !== "object") {
      if (typeof a !== "string" && typeof a !== "boolean" &&
        !(typeof a === "number" && Number.isFinite(a)) && a !== null) return false
      if (!Object.is(a, b)) return false
      continue
    }
    if (!b || typeof b !== "object" || types.isProxy(a) || types.isProxy(b)) return false
    const prototype = Object.getPrototypeOf(a)
    if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype ||
      Object.getPrototypeOf(b) !== prototype || leftAncestors.has(a) || rightAncestors.has(b))
      return false
    const aKeys = Reflect.ownKeys(a), bKeys = Reflect.ownKeys(b)
    if (aKeys.length !== bKeys.length || expanded + aKeys.length > 1_000_000) return false
    expanded += aKeys.length
    leftAncestors.add(a)
    rightAncestors.add(b)
    tasks.push({ left: a, right: b, leave: true })
    for (let index = aKeys.length - 1; index >= 0; index--) {
      const key = aKeys[index]
      if (typeof key !== "string" || bKeys[index] !== key) return false
      const aField = Object.getOwnPropertyDescriptor(a, key)
      const bField = Object.getOwnPropertyDescriptor(b, key)
      if (!aField || !bField || !("value" in aField) || !("value" in bField) ||
        aField.enumerable !== bField.enumerable || aField.configurable !== bField.configurable ||
        aField.writable !== bField.writable) return false
      tasks.push({ left: aField.value, right: bField.value })
    }
  }
  return true
}

function objectJson(text: unknown): ModObject {
  const value: unknown = JSON.parse(string(text))
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("MODS_CONVERSATION_STORE_CORRUPT")
  return value as ModObject
}

export function ensureFunctionConversationSchema(db: NativeSqliteAdapter): void {
  ensureFunctionConversationForkSchema(db)
  ensureFunctionConversationProjectionReceiptSchema(db)
  ensureFunctionConversationPresentationDispositionSchema(db)
  ensureFunctionConversationNativeDestinationSchema(db)
  db.run(`CREATE TABLE IF NOT EXISTS function_logical_sessions (
    logical_session_id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL, incarnation_key TEXT NOT NULL, workspace TEXT NOT NULL,
    UNIQUE(thread_id, incarnation_key)
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS function_conversations (
    conversation_id TEXT PRIMARY KEY NOT NULL, logical_session_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('main','child')), invocation_id TEXT NOT NULL,
    checkpoint_namespace TEXT NOT NULL, root_branch_id TEXT NOT NULL,
    next_sequence INTEGER NOT NULL DEFAULT 1,
    UNIQUE(logical_session_id, kind, invocation_id)
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS function_conversation_branches (
    branch_id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL,
    parent_branch_id TEXT, parent_frontier INTEGER NOT NULL DEFAULT 0,
    source_checkpoint_id TEXT, depth INTEGER NOT NULL
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS function_conversation_rows (
    conversation_id TEXT NOT NULL, uuid TEXT NOT NULL, branch_id TEXT NOT NULL,
    sequence INTEGER NOT NULL, receipt_id TEXT NOT NULL UNIQUE,
    input_digest TEXT NOT NULL, payload_digest TEXT NOT NULL, payload_json TEXT NOT NULL,
    door TEXT NOT NULL, created_at INTEGER NOT NULL, bytes INTEGER NOT NULL,
    PRIMARY KEY(conversation_id, uuid), UNIQUE(conversation_id, sequence)
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS function_conversation_inbox (
    conversation_id TEXT NOT NULL, uuid TEXT NOT NULL, logical_session_id TEXT NOT NULL,
    branch_id TEXT NOT NULL, sequence INTEGER NOT NULL, bytes INTEGER NOT NULL,
    PRIMARY KEY(conversation_id, uuid)
  )`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_function_inbox_session
    ON function_conversation_inbox(logical_session_id, conversation_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_function_rows_branch
    ON function_conversation_rows(conversation_id, branch_id, sequence)`)
  db.run(`CREATE TABLE IF NOT EXISTS function_conversation_deliveries (
    conversation_id TEXT NOT NULL, branch_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
    generation TEXT NOT NULL, frontier INTEGER NOT NULL,
    PRIMARY KEY(conversation_id, branch_id, checkpoint_id)
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS function_conversation_checkpoint_receipts (
    receipt_id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    checkpoint_thread_id TEXT NOT NULL, checkpoint_incarnation TEXT NOT NULL,
    checkpoint_namespace TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
    target_json TEXT NOT NULL, snapshot_digest TEXT NOT NULL, snapshot_json TEXT NOT NULL,
    UNIQUE(conversation_id,branch_id,checkpoint_thread_id,checkpoint_incarnation,
      checkpoint_namespace,checkpoint_id)
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS function_conversation_checkpoint_members (
    receipt_id TEXT NOT NULL, ordinal INTEGER NOT NULL, uuid TEXT NOT NULL,
    member_json TEXT NOT NULL, PRIMARY KEY(receipt_id,ordinal), UNIQUE(receipt_id,uuid)
  )`)
}

/** App SQLite is authoritative for kept rows; a successful graph checkpoint is a separate fact. */
export class FunctionConversationStore {
  private readonly deliveries = new WeakMap<FunctionConversationDeliveryProof, {
    target: FunctionConversationRef
    receipt: FunctionConversationCheckpointReceipt
    assertActualSaverReceipt: Guard
  }>()
  constructor(private readonly database: NativeSqliteAdapter) {
    const field = Object.getOwnPropertyDescriptor(this, "database")
    if (!types.isProxy(this) && Object.getPrototypeOf(this) === FunctionConversationStore.prototype &&
      field && "value" in field && field.value === database)
      Reflect.apply(storeWeakSet, storeCurrentOrigins, [this, { store: this, database,
        prototype: Object.getPrototypeOf(this), field, execution: undefined,
        failed: false, reading: false }])
    ensureFunctionConversationSchema(database)
    bindFunctionConversationForkStore(this, database)
  }

  /** Data admission fence only. It does not recreate an execution authority. */
  assertForkImportReady(input: Pick<FunctionConversationRef, "threadId" | "incarnation">): void {
    this.assertThread(input)
    assertFunctionConversationForkReady(this.database, input)
  }

  private transaction<T>(run: () => T, committing?: () => void): T {
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NESTED_TRANSACTION")
    this.database.run("BEGIN IMMEDIATE")
    try {
      const result = run()
      committing?.()
      this.database.run("COMMIT")
      return result
    } catch (error) {
      try {
        this.database.run("ROLLBACK")
      } catch {
        // COMMIT may have succeeded before an I/O error. Never blindly replay it.
      }
      throw error
    }
  }

  private assertThread(target: Pick<FunctionConversationRef, "threadId" | "incarnation">): void {
    assertThreadCurrent(this.database, target)
  }

  assertCurrent(target: FunctionConversationRef): void {
    const record = currentApply(storeWeakGet, storeCurrentOrigins, [this]) as StoreCurrentOrigin | undefined
    const thread = currentDescriptor(FunctionConversationStore.prototype, "assertThread")
    if (record && currentPrototype(this) === FunctionConversationStore.prototype &&
      !currentDescriptor(this, "assertThread") && thread && "value" in thread &&
      thread.value === originalAssertThread && originalCurrentDispatch(record.database) && joinedCurrentTarget(target)) {
      const reads = currentApply(storeWeakGet, currentReads, [record.database]) as
        Map<string, NativeSqliteReadOne> | undefined
      const priorThread = reads && currentApply(storeMapGet, reads, [CURRENT_THREAD_QUERY])
      const priorTarget = reads && currentApply(storeMapGet, reads, [CURRENT_TARGET_QUERY])
      if ((!priorThread || currentApply(currentWeakHas, pureCurrentReaders, [priorThread])) &&
        (!priorTarget || currentApply(currentWeakHas, pureCurrentReaders, [priorTarget]))) {
        const execution = readFunctionConversationStoreCurrentExecution(this, record.database)
        const adapter = readFunctionConversationNativeSqliteCurrentExecution(record.database)
        if (execution && adapter) {
          // Public stale-target errors remain recoverable; only identity failures poison the factory.
          execution.assertDataCurrent()
          assertJoinedCurrent(record.database, target, adapter)
          execution.assertDataCurrent()
          return
        }
      }
    }
    this.assertThread(target)
    assertConversationCurrent(this.database, target)
  }

  ensureMain(input: Pick<FunctionConversationRef,
    "threadId" | "workspace" | "incarnation" | "checkpointNamespace">, guard: Guard
  ): FunctionConversationRef {
    guard()
    this.assertForkImportReady(input)
    const result = this.transaction(() => {
      guard()
      this.assertThread(input)
      const key = incarnationKey(input.incarnation)
      let session = rows(this.database, `SELECT * FROM function_logical_sessions
        WHERE thread_id = ? AND incarnation_key = ?`, [input.threadId, key])[0]
      if (!session) {
        const id = randomUUID()
        this.database.run(`INSERT INTO function_logical_sessions VALUES (?, ?, ?, ?)`, [
          id, input.threadId, key, input.workspace
        ])
        session = { logical_session_id: id, workspace: input.workspace }
      }
      if (session.workspace !== input.workspace) fail("MODS_CONVERSATION_TARGET_CHANGED")
      const logicalSessionId = string(session.logical_session_id)
      let conversation = rows(this.database, `SELECT * FROM function_conversations
        WHERE logical_session_id = ? AND kind = 'main' AND invocation_id = ''`, [logicalSessionId])[0]
      if (!conversation) conversation = this.insertConversation(logicalSessionId, "main", "", input.checkpointNamespace)
      if (conversation.checkpoint_namespace !== input.checkpointNamespace)
        fail("MODS_CONVERSATION_NAMESPACE_CHANGED")
      guard()
      return Object.freeze({ ...input, incarnation: Object.freeze({ ...input.incarnation }),
        logicalSessionId, conversationId: string(conversation.conversation_id),
        branchId: string(conversation.root_branch_id), kind: "main" as const })
    })
    guard()
    this.assertCurrent(result)
    return result
  }

  /** Existing durable main identity only; this read never creates a session or branch. */
  findMain(input: Pick<FunctionConversationRef,
    "threadId" | "workspace" | "incarnation" | "checkpointNamespace">, guard: Guard
  ): FunctionConversationRef | undefined {
    const fixed = Object.freeze({ ...input, incarnation: Object.freeze({ ...input.incarnation }) })
    guard()
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    this.assertThread(fixed)
    this.assertForkImportReady(fixed)
    const row = rows(this.database, `SELECT s.logical_session_id,s.workspace,
      c.conversation_id,c.root_branch_id,c.checkpoint_namespace FROM function_logical_sessions s
      JOIN function_conversations c ON c.logical_session_id=s.logical_session_id
      WHERE s.thread_id=? AND s.incarnation_key=? AND c.kind='main' AND c.invocation_id=''`, [
      fixed.threadId, incarnationKey(fixed.incarnation)
    ])[0]
    if (row && (row.workspace !== fixed.workspace ||
      row.checkpoint_namespace !== fixed.checkpointNamespace)) fail("MODS_CONVERSATION_TARGET_CHANGED")
    const result = row ? Object.freeze({ ...fixed,
      logicalSessionId: string(row.logical_session_id), conversationId: string(row.conversation_id),
      branchId: string(row.root_branch_id), kind: "main" as const }) : undefined
    guard()
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    this.assertThread(fixed)
    if (result) this.assertCurrent(result)
    return result
  }

  private insertConversation(session: string, kind: "main" | "child", invocation: string, namespace: string): SqlRow {
    const conversationId = randomUUID(), branchId = randomUUID()
    this.database.run(`INSERT INTO function_conversations
      (conversation_id,logical_session_id,kind,invocation_id,checkpoint_namespace,root_branch_id)
      VALUES (?, ?, ?, ?, ?, ?)`, [conversationId, session, kind, invocation, namespace, branchId])
    this.database.run(`INSERT INTO function_conversation_branches VALUES (?, ?, NULL, 0, NULL, 0)`, [
      branchId, conversationId
    ])
    return { conversation_id: conversationId, root_branch_id: branchId, checkpoint_namespace: namespace }
  }

  createChild(parent: FunctionConversationRef, input: { invocationId: string; checkpointNamespace: string },
    guard: Guard, onCreateInTransaction?: (ref: FunctionConversationRef) => void): FunctionConversationRef {
    guard()
    this.assertForkImportReady(parent)
    string(input.invocationId)
    const result = this.transaction(() => {
      guard()
      this.assertCurrent(parent)
      if (rows(this.database, `SELECT 1 FROM function_conversations
        WHERE logical_session_id = ? AND kind = 'child' AND invocation_id = ?`, [
        parent.logicalSessionId, input.invocationId
      ]).length) fail("MODS_CONVERSATION_INVOCATION_CONFLICT")
      const row = this.insertConversation(parent.logicalSessionId, "child", input.invocationId, input.checkpointNamespace)
      const ref = Object.freeze({ ...parent, conversationId: string(row.conversation_id),
        branchId: string(row.root_branch_id), checkpointNamespace: input.checkpointNamespace, kind: "child" as const })
      if (onCreateInTransaction) {
        const returned: unknown = onCreateInTransaction(ref)
        if (returned !== undefined) fail("MODS_CONVERSATION_ASYNC_TRANSACTION")
        guard()
        if (!this.database.inTransaction) fail("MODS_CONVERSATION_TRANSACTION_REQUIRED")
        this.assertCurrent(ref)
      }
      return ref
    })
    guard()
    return result
  }

  forkBranch(parent: FunctionConversationRef, input: { parentFrontier: number; checkpointId: string }, guard: Guard): FunctionConversationRef {
    integer(input.parentFrontier)
    string(input.checkpointId)
    guard()
    this.assertForkImportReady(parent)
    const branchId = this.transaction(() => {
      guard()
      this.assertCurrent(parent)
      if (input.parentFrontier > this.highWater(parent)) fail("MODS_CONVERSATION_FRONTIER_INVALID")
      const branch = rows(this.database, "SELECT depth FROM function_conversation_branches WHERE branch_id = ?", [parent.branchId])[0]
      const depth = integer(branch?.depth) + 1
      if (depth > FUNCTION_CONVERSATION_LIMITS.branchDepth) fail("MODS_CONVERSATION_BRANCH_LIMIT")
      const id = randomUUID()
      this.database.run(`INSERT INTO function_conversation_branches VALUES (?, ?, ?, ?, ?, ?)`, [
        id, parent.conversationId, parent.branchId, input.parentFrontier, input.checkpointId, depth
      ])
      return id
    })
    guard()
    return Object.freeze({ ...parent, branchId })
  }

  highWater(target: FunctionConversationRef): number {
    this.assertCurrent(target)
    const row = readCurrent(this.database, CURRENT_HIGH_WATER_QUERY, [target.conversationId])
    return integer(row?.next_sequence) - 1
  }

  /** The branch comes from the actual checkpoint channel or host fork receipt. */
  selectBranch(target: FunctionConversationRef, branchId: string, guard: Guard): FunctionConversationRef {
    guard()
    const selected = Object.freeze({ ...target, branchId: string(branchId) })
    this.assertCurrent(selected)
    guard()
    return selected
  }

  private decode(row: SqlRow): FunctionConversationRow {
    const text = string(row.payload_json)
    if (digest(text) !== row.payload_digest || Buffer.byteLength(text) !== row.bytes)
      fail("MODS_CONVERSATION_STORE_CORRUPT")
    const payload = objectJson(text)
    return Object.freeze({ uuid: string(row.uuid), sequence: integer(row.sequence),
      receiptId: string(row.receipt_id), branchId: string(row.branch_id),
      inputDigest: string(row.input_digest), door: string(row.door),
      origin: objectJson(JSON.stringify(payload.origin)), message: objectJson(JSON.stringify(payload.message)),
      nativePayload: string(payload.nativePayload), orderAnchor: objectJson(JSON.stringify(payload.orderAnchor)),
      inbox: payload.inbox === true, bytes: integer(row.bytes), createdAt: integer(row.created_at) })
  }

  readReceipt(target: FunctionConversationRef, uuid: string): FunctionConversationRow | undefined {
    this.assertCurrent(target)
    const row = readCurrent(this.database, `SELECT * FROM function_conversation_rows
      WHERE conversation_id = ? AND uuid = ?`, [target.conversationId, uuid])
    return row ? this.decode(row) : undefined
  }

  private verifyTranscript(target: FunctionConversationRef, row: FunctionConversationRow,
    verify: FunctionConversationTranscriptVerifier
  ): void {
    const returned: unknown = verify(this.database, target, row)
    if (returned && typeof (returned as { then?: unknown }).then === "function")
      fail("MODS_CONVERSATION_ASYNC_TRANSACTION")
  }

  commit(target: FunctionConversationRef, input: FunctionConversationCommit, guard: Guard,
    writeTranscript: FunctionConversationTranscriptWriter,
    verifyTranscript: FunctionConversationTranscriptVerifier
  ): FunctionConversationRow {
    guard()
    this.assertForkImportReady(target)
    string(input.uuid)
    string(input.inputDigest)
    string(input.door)
    string(input.nativePayload)
    if (input.inbox && (input.message.type !== "user" || input.message.isMeta !== true ||
      (input.message.role !== undefined && input.message.role !== "user")))
      fail("MODS_CONVERSATION_INBOX_MESSAGE")
    const payload = { origin: input.origin, message: input.message,
      nativePayload: input.nativePayload, orderAnchor: input.orderAnchor, inbox: input.inbox }
    // SDK admission is bounded; native producers keep their complete serializer output.
    if (input.sdk) encodeModJson(input.message)
    encodeModJson(input.origin)
    encodeModJson(input.orderAnchor)
    const payloadJson = JSON.stringify(payload)
    const payloadDigest = digest(payloadJson), bytes = Buffer.byteLength(payloadJson)
    let commitAttempted = false
    let saved: FunctionConversationRow
    try {
      saved = this.transaction(() => {
        guard()
        this.assertCurrent(target)
        const previous = this.readReceipt(target, input.uuid)
        if (previous) {
          const raw = rows(this.database, `SELECT payload_digest FROM function_conversation_rows
            WHERE conversation_id = ? AND uuid = ?`, [target.conversationId, input.uuid])[0]
          if (previous.branchId !== target.branchId || previous.inputDigest !== input.inputDigest ||
            previous.door !== input.door || raw.payload_digest !== payloadDigest)
            fail("MODS_CONVERSATION_ROW_CONFLICT")
          this.verifyTranscript(target, previous, verifyTranscript)
          guard()
          this.assertCurrent(target)
          return previous
        }
        if (input.inbox) this.assertInboxCapacity(target, bytes)
        const sequence = this.highWater(target) + 1
        const receiptId = randomUUID(), createdAt = Date.now()
        this.database.run(`INSERT INTO function_conversation_rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          target.conversationId, input.uuid, target.branchId, sequence, receiptId,
          input.inputDigest, payloadDigest, payloadJson, input.door, createdAt, bytes
        ])
        if (input.inbox) this.database.run(`INSERT INTO function_conversation_inbox VALUES (?, ?, ?, ?, ?, ?)`, [
          target.conversationId, input.uuid, target.logicalSessionId, target.branchId, sequence, bytes
        ])
        this.database.run(`UPDATE function_conversations SET next_sequence = ? WHERE conversation_id = ?`, [
          sequence + 1, target.conversationId
        ])
        const row = this.readReceipt(target, input.uuid)
        if (!row) fail("MODS_CONVERSATION_NOT_COMMITTED")
        // Required synchronous writer shares this transaction. No nested BEGIN or Guest call.
        const returned: unknown = writeTranscript(this.database, target, row)
        if (returned && typeof (returned as { then?: unknown }).then === "function")
          fail("MODS_CONVERSATION_ASYNC_TRANSACTION")
        guard()
        this.assertCurrent(target)
        this.verifyTranscript(target, row, verifyTranscript)
        guard()
        this.assertCurrent(target)
        return row
      }, () => { commitAttempted = true })
    } catch (error) {
      if (!commitAttempted) throw error
      // A failed rollback may leave the row visible only on this still-open connection.
      // That is not a durable COMMIT receipt, and this admission must never replay it.
      if (this.database.inTransaction) throw error
      // Do not mint another UUID after an uncertain COMMIT. Recovery is exact-key only.
      const recovered = this.readReceipt(target, input.uuid)
      if (!recovered || recovered.inputDigest !== input.inputDigest ||
        recovered.branchId !== target.branchId || recovered.door !== input.door ||
        digest(JSON.stringify({ origin: recovered.origin, message: recovered.message,
          nativePayload: recovered.nativePayload, orderAnchor: recovered.orderAnchor,
          inbox: recovered.inbox })) !== payloadDigest) throw error
      guard()
      saved = recovered
    }
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    guard()
    this.assertCurrent(target)
    const confirmed = this.readReceipt(target, input.uuid)
    if (!confirmed || confirmed.receiptId !== saved.receiptId ||
      confirmed.inputDigest !== input.inputDigest || confirmed.branchId !== target.branchId ||
      confirmed.door !== input.door ||
      digest(JSON.stringify({ origin: confirmed.origin, message: confirmed.message,
        nativePayload: confirmed.nativePayload, orderAnchor: confirmed.orderAnchor,
        inbox: confirmed.inbox })) !== payloadDigest)
      fail("MODS_CONVERSATION_NOT_COMMITTED")
    guard()
    this.assertCurrent(target)
    this.verifyTranscript(target, confirmed, verifyTranscript)
    // The verifier owns the last actual source callbacks. Only native SQL/data checks follow:
    // a callback must not change the returned object or its canonical row after verification.
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    this.assertCurrent(target)
    const rawFinal = rows(this.database, `SELECT * FROM function_conversation_rows
      WHERE conversation_id = ? AND uuid = ?`, [target.conversationId, input.uuid])[0]
    const final = rawFinal ? this.decode(rawFinal) : undefined
    if (!final || rawFinal.payload_digest !== payloadDigest || final.receiptId !== saved.receiptId ||
      final.inputDigest !== input.inputDigest || final.branchId !== target.branchId ||
      final.door !== input.door || !sameCommittedData(final, confirmed))
      fail("MODS_CONVERSATION_NOT_COMMITTED")
    this.assertCurrent(target)
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    return final
  }

  private assertInboxCapacity(target: FunctionConversationRef, bytes: number): void {
    const sums = (column: string, key: string) => rows(this.database,
      `SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM function_conversation_inbox WHERE ${column} = ?`, [key])[0]
    const local = sums("conversation_id", target.conversationId)
    const session = sums("logical_session_id", target.logicalSessionId)
    if (Number(local.count) >= FUNCTION_CONVERSATION_LIMITS.inboxRows ||
      Number(local.bytes) + bytes > FUNCTION_CONVERSATION_LIMITS.inboxBytes ||
      Number(session.count) >= FUNCTION_CONVERSATION_LIMITS.sessionInboxRows ||
      Number(session.bytes) + bytes > FUNCTION_CONVERSATION_LIMITS.sessionInboxBytes)
      fail("MODS_CONVERSATION_INBOX_LIMIT")
  }

  private lineage(target: FunctionConversationRef, highWater: number): Array<{ branchId: string; cut: number }> {
    integer(highWater)
    const result: Array<{ branchId: string; cut: number }> = []
    let branchId: string | null = target.branchId, cut = highWater
    while (branchId !== null) {
      if (result.length > FUNCTION_CONVERSATION_LIMITS.branchDepth || result.some((entry) => entry.branchId === branchId))
        fail("MODS_CONVERSATION_BRANCH_INVALID")
      const row: SqlRow | undefined = readCurrent(this.database, `SELECT * FROM function_conversation_branches
        WHERE branch_id = ? AND conversation_id = ?`, [branchId, target.conversationId])
      if (!row) fail("MODS_CONVERSATION_BRANCH_INVALID")
      result.push({ branchId, cut })
      cut = Math.min(cut, integer(row.parent_frontier))
      branchId = row.parent_branch_id === null ? null : string(row.parent_branch_id)
    }
    return result
  }

  captureCheckpointCanonicalCut(target: FunctionConversationRef, guard: Guard): FunctionConversationCanonicalCut {
    guard()
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    const highWater = this.highWater(target)
    const lineage = Object.freeze(this.lineage(target, highWater).map(entry => Object.freeze(entry)))
    const result = Object.freeze({ highWater, lineage,
      lineageDigest: functionConversationMembershipDigest(lineage) })
    guard()
    this.assertCheckpointCanonicalCut(target, result)
    return result
  }

  /** Synchronous same-DB verification, also used inside the ACK transaction. */
  assertCheckpointCanonicalCut(target: FunctionConversationRef, cut: FunctionConversationCanonicalCut): void {
    const highWater = currentCutHighWater(this, target, cut)
    if (highWater === undefined) {
      this.assertCurrent(target)
      integer(cut.highWater)
      if (cut.highWater > this.highWater(target) ||
        functionConversationMembershipDigest(cut.lineage) !== cut.lineageDigest ||
        functionConversationMembershipDigest(this.lineage(target, cut.highWater)) !== cut.lineageDigest)
        fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
      return
    }
    if (cut.highWater > highWater ||
      functionConversationMembershipDigest(cut.lineage) !== cut.lineageDigest ||
      functionConversationMembershipDigest(this.lineage(target, cut.highWater)) !== cut.lineageDigest)
      fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
  }

  private rowWithinCheckpointCut(target: FunctionConversationRef, uuid: string,
    cut: FunctionConversationCanonicalCut): FunctionConversationRow {
    this.assertCheckpointCanonicalCut(target, cut)
    const predicates = cut.lineage.map(() => "(branch_id=? AND sequence>=1 AND sequence<=?)").join(" OR ")
    const raw = readCurrent(this.database, `SELECT * FROM function_conversation_rows
      WHERE conversation_id=? AND uuid=? AND (${predicates})`, [target.conversationId, uuid,
      ...cut.lineage.flatMap(entry => [entry.branchId, entry.cut])])
    if (!raw) fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    return this.decode(raw)
  }

  /** Stored cut is data only; a real Saver membership proof is still required to authorize reads. */
  readCheckpointCanonicalCut(target: FunctionConversationRef, input: {
    checkpointThreadId: string; checkpointIncarnation: ThreadIncarnation; checkpointId: string
  }, guard: Guard): FunctionConversationCanonicalCut | undefined {
    const fixed = { checkpointThreadId: input.checkpointThreadId,
      checkpointIncarnation: incarnationKey(input.checkpointIncarnation), checkpointId: input.checkpointId }
    guard()
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    this.assertCurrent(target)
    const row = rows(this.database, `SELECT snapshot_json,snapshot_digest,target_json
      FROM function_conversation_checkpoint_receipts WHERE conversation_id=? AND branch_id=?
      AND checkpoint_thread_id=? AND checkpoint_incarnation=? AND checkpoint_namespace=? AND checkpoint_id=?`, [
      target.conversationId, target.branchId, fixed.checkpointThreadId, fixed.checkpointIncarnation,
      target.checkpointNamespace, fixed.checkpointId
    ])[0]
    const snapshot = row ? this.decodeCheckpointSnapshot(target, row) : undefined
    guard()
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    this.assertCurrent(target)
    return snapshot?.cut
  }

  private decodeCheckpointSnapshot(target: FunctionConversationRef, row: SqlRow, privateMemberRead = false):
    FunctionConversationCheckpointMembershipSnapshot {
    if (row.target_json !== checkpointTargetJson(target)) fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    // Public recovery/cut reads retain independent mutable parsed values. Only the internal
    // member comparison can reuse frozen exact-text interpretation; it never returns it.
    const { snapshot, digest } = privateMemberRead
      ? checkpointApply(readCheckpointInterpretation, checkpointInterpreter(this), [string(row.snapshot_json)]) as
        ReturnType<CheckpointSnapshotInterpretations["read"]>
      : (() => {
        const snapshot = JSON.parse(string(row.snapshot_json)) as FunctionConversationCheckpointMembershipSnapshot
        const { snapshotDigest: _snapshotDigest, ...content } = snapshot
        void _snapshotDigest
        return { snapshot, digest: functionConversationMembershipDigest(content) }
      })()
    if (snapshot.snapshotDigest !== row.snapshot_digest || digest !== snapshot.snapshotDigest)
      fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    this.assertCheckpointCanonicalCut(target, snapshot.cut)
    return snapshot
  }

  /** Persisted data only. An actual native raw-row receipt must separately authenticate recovery. */
  readCheckpointRecoverySnapshot(target: FunctionConversationRef, input: {
    checkpointThreadId: string; checkpointIncarnation: ThreadIncarnation; checkpointId: string
  }, guard: Guard): { snapshot: FunctionConversationCheckpointMembershipSnapshot;
    rows: readonly FunctionConversationRow[] } {
    const fixed = { checkpointThreadId: string(input.checkpointThreadId),
      checkpointIncarnation: incarnationKey(input.checkpointIncarnation), checkpointId: string(input.checkpointId) }
    guard()
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    this.assertCurrent(target)
    const receipt = rows(this.database, `SELECT * FROM function_conversation_checkpoint_receipts
      WHERE conversation_id=? AND branch_id=? AND checkpoint_thread_id=? AND checkpoint_incarnation=?
      AND checkpoint_namespace=? AND checkpoint_id=?`, [target.conversationId, target.branchId,
      fixed.checkpointThreadId, fixed.checkpointIncarnation, target.checkpointNamespace, fixed.checkpointId])[0]
    if (!receipt) fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    const snapshot = this.decodeCheckpointSnapshot(target, receipt)
    this.verifyPersistedCheckpointSnapshot(target, snapshot)
    const kept = snapshot.members.map(member => this.rowWithinCheckpointCut(target, member.uuid, snapshot.cut))
    guard()
    this.assertCurrent(target)
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    return { snapshot, rows: Object.freeze(kept) }
  }

  private verifyCheckpointSnapshot(target: FunctionConversationRef,
    snapshot: FunctionConversationCheckpointMembershipSnapshot): void {
    this.assertCheckpointCanonicalCut(target, snapshot.cut)
    for (const member of snapshot.members) {
      const row = this.rowWithinCheckpointCut(target, member.uuid, snapshot.cut)
      if (member.sequence !== row.sequence || member.branchId !== row.branchId ||
        member.rowReceiptId !== row.receiptId || member.createdAt !== row.createdAt ||
        member.rowDigest !== functionConversationRowDigest(row))
        fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    }
  }

  private checkpointReceipt(target: FunctionConversationRef,
    snapshot: FunctionConversationCheckpointMembershipSnapshot): SqlRow | undefined {
    return readCurrent(this.database, `SELECT * FROM function_conversation_checkpoint_receipts
      WHERE conversation_id=? AND branch_id=? AND checkpoint_thread_id=? AND checkpoint_incarnation=?
      AND checkpoint_namespace=? AND checkpoint_id=?`, [target.conversationId, target.branchId,
      snapshot.checkpointThreadId, snapshot.checkpointIncarnation, snapshot.namespace, snapshot.checkpointId])
  }

  private persistCheckpointSnapshot(target: FunctionConversationRef,
    snapshot: FunctionConversationCheckpointMembershipSnapshot): void {
    this.verifyCheckpointSnapshot(target, snapshot)
    const previous = this.checkpointReceipt(target, snapshot)
    if (previous) {
      const actual = this.decodeCheckpointSnapshot(target, previous)
      if (actual.snapshotDigest !== snapshot.snapshotDigest) fail("MODS_CONVERSATION_DELIVERY_CONFLICT")
    } else {
      const receiptId = randomUUID()
      this.database.run(`INSERT INTO function_conversation_checkpoint_receipts VALUES (?,?,?,?,?,?,?,?,?,?)`, [
        receiptId, target.conversationId, target.branchId, snapshot.checkpointThreadId,
        snapshot.checkpointIncarnation, snapshot.namespace, snapshot.checkpointId,
        checkpointTargetJson(target), snapshot.snapshotDigest, JSON.stringify(snapshot)
      ])
      for (const member of snapshot.members) this.database.run(
        "INSERT INTO function_conversation_checkpoint_members VALUES (?,?,?,?)", [
          receiptId, member.ordinal, member.uuid, JSON.stringify(member)
        ])
    }
    this.verifyPersistedCheckpointSnapshot(target, snapshot)
  }

  private verifyPersistedCheckpointSnapshot(target: FunctionConversationRef,
    snapshot: FunctionConversationCheckpointMembershipSnapshot): void {
    const receipt = this.checkpointReceipt(target, snapshot)
    if (!receipt || this.decodeCheckpointSnapshot(target, receipt).snapshotDigest !== snapshot.snapshotDigest)
      fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    const members = rows(this.database, `SELECT ordinal,uuid,member_json
      FROM function_conversation_checkpoint_members WHERE receipt_id=? ORDER BY ordinal`, [receipt.receipt_id])
    if (members.length !== snapshot.members.length || members.some((row, index) =>
      row.ordinal !== snapshot.members[index].ordinal || row.uuid !== snapshot.members[index].uuid ||
      row.member_json !== JSON.stringify(snapshot.members[index]))) fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    this.verifyCheckpointSnapshot(target, snapshot)
  }

  readCheckpointMember(target: FunctionConversationRef,
    proof: FunctionConversationCheckpointMembershipProof, uuid: string, guard: Guard
  ): FunctionConversationRow {
    guard()
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    const snapshot = readFunctionConversationCheckpointMembership(proof, this, target)
    const receipt = this.checkpointReceipt(target, snapshot)
    if (!receipt || this.decodeCheckpointSnapshot(target, receipt, true).snapshotDigest !== snapshot.snapshotDigest)
      fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    const member = checkpointApply(indexedCheckpointMember, checkpointInterpreter(this),
      [proof, snapshot, uuid]) as ReturnType<CheckpointSnapshotInterpretations["member"]>
    if (!member)
      fail("MODS_CONVERSATION_ROW_OUTSIDE_CHECKPOINT")
    const indexed = readCurrent(this.database, `SELECT ordinal,member_json
      FROM function_conversation_checkpoint_members WHERE receipt_id=? AND uuid=?`, [receipt.receipt_id, uuid])
    if (!indexed || indexed.ordinal !== member.ordinal || indexed.member_json !== JSON.stringify(member))
      fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    const row = this.rowWithinCheckpointCut(target, uuid, snapshot.cut)
    if (functionConversationRowDigest(row) !== member.rowDigest)
      fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    guard()
    readFunctionConversationCheckpointMembership(proof, this, target)
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    return row
  }

  /** Read one complete kept row at the actual host-bound branch/cut, independently of API paging. */
  readRowAtCut(target: FunctionConversationRef, uuid: string,
    cut: FunctionConversationRowReadCut, guard: Guard
  ): FunctionConversationRow {
    if (!cut || typeof cut !== "object" || Array.isArray(cut) || typeof guard !== "function")
      fail("MODS_CONVERSATION_READ_CUT_INVALID")
    const frontierDescriptor = Object.getOwnPropertyDescriptor(cut, "frontier")
    const timeDescriptor = Object.getOwnPropertyDescriptor(cut, "notAfterCreatedAt")
    const frontier: unknown = frontierDescriptor?.value
    const time: unknown = timeDescriptor?.value
    if (!frontierDescriptor || !("value" in frontierDescriptor) ||
      typeof frontier !== "number" || !Number.isSafeInteger(frontier) || frontier < 0 ||
      (timeDescriptor && (!("value" in timeDescriptor) || (time !== undefined &&
        (typeof time !== "number" || !Number.isSafeInteger(time) || time < 0)))))
      fail("MODS_CONVERSATION_READ_CUT_INVALID")
    // A guard may reenter native code; never let it expand the caller's captured cut.
    const fixedCut = Object.freeze({ frontier,
      notAfterCreatedAt: typeof time === "number" ? time : undefined })
    const fixedTarget = Object.freeze({ ...target,
      incarnation: Object.freeze({ ...target.incarnation }) })
    guard()
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    this.assertCurrent(fixedTarget)
    if (fixedCut.frontier > this.highWater(fixedTarget))
      fail("MODS_CONVERSATION_READ_CUT_INVALID")
    if (typeof uuid !== "string" || !uuid.length)
      fail("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
    const lineage = this.lineage(fixedTarget, fixedCut.frontier)
    const predicates = lineage.map(() => "(branch_id = ? AND sequence >= 1 AND sequence <= ?)")
      .join(" OR ")
    const selected = rows(this.database, `SELECT * FROM function_conversation_rows
      WHERE conversation_id = ? AND uuid = ? AND (${predicates})
      ${fixedCut.notAfterCreatedAt === undefined ? "" : "AND created_at <= ?"} LIMIT 1`, [
      fixedTarget.conversationId, uuid, ...lineage.flatMap((entry) => [entry.branchId, entry.cut]),
      ...(fixedCut.notAfterCreatedAt === undefined ? [] : [fixedCut.notAfterCreatedAt])
    ])[0]
    if (!selected) fail("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
    const result = this.decode(selected)
    const branch = lineage.find((entry) => entry.branchId === result.branchId)
    if (result.uuid !== uuid || !branch || result.sequence < 1 || result.sequence > branch.cut ||
      (fixedCut.notAfterCreatedAt !== undefined && result.createdAt > fixedCut.notAfterCreatedAt))
      fail("MODS_CONVERSATION_ROW_OUTSIDE_CUT")
    guard()
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    this.assertCurrent(fixedTarget)
    return result
  }

  readRows(target: FunctionConversationRef, options: { highWater?: number; limit?: number; notAfterCreatedAt?: number } = {}): FunctionConversationRow[] {
    this.assertForkImportReady(target)
    this.assertCurrent(target)
    const limit = options.limit ?? FUNCTION_CONVERSATION_LIMITS.readRows
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > FUNCTION_CONVERSATION_LIMITS.readRows)
      fail("MODS_CONVERSATION_READ_LIMIT")
    const lineage = this.lineage(target, options.highWater ?? this.highWater(target))
    const predicates = lineage.map(() => "(branch_id = ? AND sequence <= ?)").join(" OR ")
    const parameters = lineage.flatMap((entry) => [entry.branchId, entry.cut])
    const time = options.notAfterCreatedAt
    if (time !== undefined) integer(time)
    const selected = rows(this.database, `SELECT * FROM function_conversation_rows
      WHERE conversation_id = ? AND (${predicates}) ${time === undefined ? "" : "AND created_at <= ?"}
      ORDER BY sequence DESC LIMIT ?`, [target.conversationId, ...parameters,
      ...(time === undefined ? [] : [time]), limit])
    return selected.reverse().map((row) => this.decode(row))
  }

  captureInbox(target: FunctionConversationRef, frontier: number, highWater = this.highWater(target)): {
    highWater: number; frontier: number; rows: FunctionConversationRow[]
  } {
    this.assertForkImportReady(target)
    this.assertCurrent(target)
    integer(frontier)
    if (frontier > highWater || highWater > this.highWater(target)) fail("MODS_CONVERSATION_FRONTIER_INVALID")
    const lineage = this.lineage(target, highWater)
    const predicates = lineage.map(() => "(r.branch_id = ? AND r.sequence <= ?)").join(" OR ")
    // History remains readable after delivery: a checkpoint rollback can use its older frontier.
    const selected = rows(this.database, `SELECT r.* FROM function_conversation_rows r
      WHERE r.conversation_id = ? AND r.sequence > ? AND (${predicates})
      AND json_extract(r.payload_json, '$.inbox') = 1 ORDER BY r.sequence ASC LIMIT ?`, [
      target.conversationId, frontier, ...lineage.flatMap((entry) => [entry.branchId, entry.cut]),
      FUNCTION_CONVERSATION_LIMITS.inboxRows + 1
    ]).map((row) => this.decode(row))
    if (selected.length > FUNCTION_CONVERSATION_LIMITS.inboxRows ||
      selected.reduce((sum, row) => sum + row.bytes, 0) > FUNCTION_CONVERSATION_LIMITS.inboxBytes)
      fail("MODS_CONVERSATION_INBOX_LIMIT")
    return { highWater, frontier, rows: selected }
  }

  /** Host adapter must verify the successful saver.put and the exact committed channel. */
  captureCheckpointDelivery(target: FunctionConversationRef, receipt: FunctionConversationCheckpointReceipt,
    assertActualSaverReceipt: Guard
  ): FunctionConversationDeliveryProof {
    assertActualSaverReceipt()
    this.assertCurrent(target)
    string(receipt.checkpointId)
    string(receipt.generation)
    integer(receipt.frontier)
    const proof = Object.freeze({ [checkpointReceiptBrand]: true as const })
    this.deliveries.set(proof, { target, receipt: Object.freeze({ ...receipt }), assertActualSaverReceipt })
    return proof
  }

  recordCheckpointDelivery(target: FunctionConversationRef, proof: FunctionConversationDeliveryProof,
    guard: Guard, membership?: FunctionConversationCheckpointMembershipProof,
    writeAcknowledgement?: (database: NativeSqliteAdapter) => void): void {
    const actual = this.deliveries.get(proof)
    if (!actual || actual.target !== target) fail("MODS_CONVERSATION_DELIVERY_PROOF")
    const { receipt } = actual
    guard()
    actual.assertActualSaverReceipt()
    string(receipt.checkpointId)
    string(receipt.generation)
    integer(receipt.frontier)
    const snapshot = membership
      ? readFunctionConversationCheckpointMembership(membership, this, target) : undefined
    if (snapshot && (snapshot.checkpointId !== receipt.checkpointId ||
      snapshot.frontier !== receipt.frontier || snapshot.namespace !== target.checkpointNamespace))
      fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    this.transaction(() => {
      guard()
      actual.assertActualSaverReceipt()
      this.assertCurrent(target)
      if (membership && snapshot) {
        if (readFunctionConversationCheckpointMembership(membership, this, target) !== snapshot)
          fail("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
        this.persistCheckpointSnapshot(target, snapshot)
      }
      if (receipt.frontier > this.highWater(target)) fail("MODS_CONVERSATION_FRONTIER_INVALID")
      const previous = rows(this.database, `SELECT generation,frontier FROM function_conversation_deliveries
        WHERE conversation_id = ? AND branch_id = ? AND checkpoint_id = ?`, [
        target.conversationId, target.branchId, receipt.checkpointId
      ])[0]
      if (previous && (previous.generation !== receipt.generation || previous.frontier !== receipt.frontier))
        fail("MODS_CONVERSATION_DELIVERY_CONFLICT")
      if (!previous) this.database.run(`INSERT INTO function_conversation_deliveries VALUES (?, ?, ?, ?, ?)`, [
        target.conversationId, target.branchId, receipt.checkpointId, receipt.generation, receipt.frontier
      ])
      const lineage = this.lineage(target, receipt.frontier)
      for (const entry of lineage) this.database.run(`DELETE FROM function_conversation_inbox
        WHERE conversation_id = ? AND branch_id = ? AND sequence <= ?`, [
        target.conversationId, entry.branchId, entry.cut
      ])
      if (writeAcknowledgement) {
        const returned: unknown = writeAcknowledgement(this.database)
        if (returned && typeof (returned as { then?: unknown }).then === "function")
          fail("MODS_CONVERSATION_ASYNC_TRANSACTION")
      }
      guard()
      actual.assertActualSaverReceipt()
    }, () => {
      guard()
      actual.assertActualSaverReceipt()
      if (membership) readFunctionConversationCheckpointMembership(membership, this, target)
    })
    guard()
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    actual.assertActualSaverReceipt()
    this.assertCurrent(target)
    if (snapshot) this.verifyPersistedCheckpointSnapshot(target, snapshot)
    guard()
    if (this.database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
  }

  /** Host deletion must retire actual backends first; this helper joins the caller's transaction. */
  deleteThreadInTransaction(threadId: string): void {
    if (!this.database.inTransaction) fail("MODS_CONVERSATION_TRANSACTION_REQUIRED")
    const raw = rows(this.database, "SELECT created_at,metadata FROM threads WHERE thread_id=?",
      [threadId])[0]
    if (!raw) fail("MODS_CONVERSATION_THREAD_CHANGED")
    const original = { created_at: integer(raw.created_at),
      metadata: typeof raw.metadata === "string" ? raw.metadata : null }
    const incarnation = captureThreadIncarnation(original)
    deleteFunctionConversationThreadDataInTransaction(this.database, { threadId, incarnation,
      assertCurrent: () => {
        const actual = rows(this.database, "SELECT created_at,metadata FROM threads WHERE thread_id=?",
          [threadId])[0]
        if (!actual || actual.metadata !== raw.metadata ||
          !matchesThreadIncarnation({ created_at: integer(actual.created_at),
            metadata: typeof actual.metadata === "string" ? actual.metadata : null }, incarnation))
          fail("MODS_CONVERSATION_THREAD_CHANGED")
      }
    })
  }
}
const originalAssertThread = Object.getOwnPropertyDescriptor(FunctionConversationStore.prototype,
  "assertThread")!.value
const originalAssertCurrent = Object.getOwnPropertyDescriptor(FunctionConversationStore.prototype,
  "assertCurrent")!.value
const originalHighWater = Object.getOwnPropertyDescriptor(FunctionConversationStore.prototype,
  "highWater")!.value

/** Only the two callback-free identity/high-water reads inside one cut share a SQL row. */
function currentCutHighWater(store: FunctionConversationStore, target: FunctionConversationRef,
  cut: FunctionConversationCanonicalCut): number | undefined {
  const record = currentApply(storeWeakGet, storeCurrentOrigins, [store]) as StoreCurrentOrigin | undefined
  if (!record || currentPrototype(store) !== FunctionConversationStore.prototype ||
    !originalCurrentDispatch(record.database) || !joinedCurrentTarget(target) ||
    !currentDataField(globalThis, "Map", currentMap) || !currentDataField(globalThis, "Set", currentSet) ||
    !cut || typeof cut !== "object" || currentIsProxy(cut)) return
  const water = currentDescriptor(cut, "highWater")
  if (!water || !("value" in water)) return
  const names = ["assertCurrent", "assertThread", "highWater"]
  const methods = [originalAssertCurrent, originalAssertThread, originalHighWater]
  for (let index = 0; index < names.length; index++) {
    if (currentDescriptor(store, names[index]) ||
      !currentDataField(FunctionConversationStore.prototype, names[index], methods[index])) return
  }
  const reads = currentApply(storeWeakGet, currentReads, [record.database]) as
    Map<string, NativeSqliteReadOne> | undefined
  const queries = [CURRENT_THREAD_QUERY, CURRENT_TARGET_QUERY, CURRENT_HIGH_WATER_QUERY]
  for (let index = 0; index < queries.length; index++) {
    const prior = reads && currentApply(storeMapGet, reads, [queries[index]])
    if (prior && !currentApply(currentWeakHas, pureCurrentReaders, [prior])) return
  }
  const execution = readFunctionConversationStoreCurrentExecution(store, record.database)
  const adapter = readFunctionConversationNativeSqliteCurrentExecution(record.database)
  if (!execution || !adapter) return
  execution.assertDataCurrent()
  const row = assertJoinedCurrent(record.database, target, adapter, JOINED_CURRENT_HIGH_WATER_QUERY)
  // Preserve thread/target, invalid cut, invalid sequence error precedence.
  integer(water.value)
  const highWater = integer(row.next_sequence) - 1
  execution.assertDataCurrent()
  return highWater
}

