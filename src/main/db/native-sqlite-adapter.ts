import { DatabaseSync, StatementSync } from "node:sqlite"
import { types } from "node:util"
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync
} from "fs"
import { dirname } from "path"
import { registerSqliteQuarantineArtifact } from "../utils/sqlite-durable-file"

export type NativeSqliteValue = string | number | bigint | null | Uint8Array
export type NativeSqliteBindings = readonly unknown[] | Record<string, unknown>
export type NativeSqliteReadOne = (
  bindings?: NativeSqliteBindings
) => Record<string, NativeSqliteValue> | undefined

interface CurrentExecutionOrigin {
  readonly database: NativeSqliteAdapter
  readonly native: DatabaseSync
  readonly prototype: object | null
  readonly nativeField: PropertyDescriptor
  readonly closedField: PropertyDescriptor
  readonly nativeOrigin: NativeCurrentFactoryOrigin
  readonly view: NativeSqliteCurrentExecution
  failed: boolean
}
export interface NativeSqliteCurrentExecution {
  prepareReadOne(sql: string): NativeSqliteReadOne
  assertDataCurrent(): void
}
const currentExecutionOrigins = new WeakMap<NativeSqliteAdapter, CurrentExecutionOrigin>()
interface NativeCurrentFactoryOrigin {
  readonly native: DatabaseSync
  readonly nativeConstructor: typeof DatabaseSync
  readonly prototype: object | null
  readonly isTransactionField: PropertyDescriptor
  readonly isOpenField: PropertyDescriptor
  readonly isOpen: (this: DatabaseSync) => boolean
}
const nativeCurrentFactoryOrigins = new WeakMap<DatabaseSync, NativeCurrentFactoryOrigin>()
const executionWeakGet = WeakMap.prototype.get, executionWeakSet = WeakMap.prototype.set
const executionApply = Reflect.apply
const executionNativeConstructor = DatabaseSync
const executionNativePrepare = DatabaseSync.prototype.prepare
const executionStatementRun = StatementSync.prototype.run
const executionDescriptor = Object.getOwnPropertyDescriptor
const executionPrototype = Object.getPrototypeOf
const executionCreate = Object.create
const executionDefine = Object.defineProperty
const executionFreeze = Object.freeze
const executionIsProxy = types.isProxy
const executionIsUint8Array = types.isUint8Array
const executionIsSharedArrayBuffer = types.isSharedArrayBuffer
const executionIsArray = Array.isArray
const executionSafeInteger = Number.isSafeInteger
const executionArray = Array
const executionBytes = Uint8Array
const executionTypedArrayPrototype = executionPrototype(Uint8Array.prototype)
const executionBuffer = executionDescriptor(executionTypedArrayPrototype, "buffer")!.get!
const executionByteLength = executionDescriptor(executionTypedArrayPrototype, "byteLength")!.get!
const executionBytesSet = Uint8Array.prototype.set
const executionRegExp = RegExp.prototype.exec
const executionSelect = /^\s*SELECT\b/i
const executionStatementGet = StatementSync.prototype.get
const executionObjectKeys = Object.keys
const rowCopyGlobal = globalThis
const rowCopyObject = Object
const rowCopyReflect = Reflect
const rowCopyDescriptor = Object.getOwnPropertyDescriptor
const rowCopyObjectField = rowCopyDescriptor(rowCopyGlobal, "Object")!
const rowCopyReflectField = rowCopyDescriptor(rowCopyGlobal, "Reflect")!
const rowCopyEntriesField = rowCopyDescriptor(rowCopyObject, "entries")!
const rowCopyDefineField = rowCopyDescriptor(rowCopyObject, "defineProperty")!
const rowCopyApplyField = rowCopyDescriptor(rowCopyReflect, "apply")!
interface FreshNativeRowTransfer {
  readonly setPrototype: typeof Object.setPrototypeOf
  readonly objectPrototype: object | null
  readonly typedConstructor: object
  readonly functionPrototype: object
  readonly hasInstance: symbol
  readonly instanceField: PropertyDescriptor
  readonly arrayField: PropertyDescriptor
  readonly arrayIsArrayField: PropertyDescriptor
  readonly bytesField: PropertyDescriptor
}
const freshNativeRowTransfer = captureFreshNativeRowTransfer()

function hasOriginalRowCopyField(
  receiver: object, key: PropertyKey, expected: PropertyDescriptor
): boolean {
  const field = rowCopyDescriptor(receiver, key)
  return !!field && !!rowCopyDescriptor(field, "value") && field.value === expected.value &&
    field.writable === expected.writable && field.enumerable === expected.enumerable &&
    field.configurable === expected.configurable
}

/** Optional performance cohort, not native identity or authority authentication. */
function captureFreshNativeRowTransfer(): FreshNativeRowTransfer | undefined {
  // Trusted boot may install ordinary counting wrappers. All additional captures are
  // optional too: an initial shim/getter must not turn this optimization into a startup rule.
  try {
    const FunctionCtor = Function, SymbolCtor = Symbol
    const functionSource = FunctionCtor.prototype.toString, setPrototype = Object.setPrototypeOf
    const nativeSource = (value: unknown, name: string): boolean => typeof value === "function" &&
      executionApply(functionSource, value, []) === `function ${name}() { [native code] }`
    if (!nativeSource(functionSource, "toString") || !nativeSource(executionApply, "apply") ||
      !nativeSource(executionStatementGet, "get") ||
      !nativeSource(executionDescriptor, "getOwnPropertyDescriptor") ||
      !nativeSource(executionPrototype, "getPrototypeOf") ||
      !nativeSource(setPrototype, "setPrototypeOf") ||
      !nativeSource(executionIsArray, "isArray") || !nativeSource(executionObjectKeys, "keys") ||
      !nativeSource(executionBytes, "Uint8Array") || !nativeSource(rowCopyObject, "Object") ||
      !nativeSource(FunctionCtor, "Function") || !nativeSource(SymbolCtor, "Symbol")) return undefined
    // Node's util export is anonymous. This exact compatibility shape is cold-only opt-out,
    // not authentication: deliberately forged metadata must never gain access to raw rows.
    const proxyField = (key: string, expected: unknown): boolean => {
      const field = rowCopyDescriptor(executionIsProxy, key)
      return !!field && !!rowCopyDescriptor(field, "value") && field.value === expected &&
        field.writable === false && field.enumerable === false && field.configurable === true
    }
    if (!nativeSource(executionIsProxy, "isProxy") &&
      (executionApply(functionSource, executionIsProxy, []) !== "function () { [native code] }" ||
        !proxyField("name", "") || !proxyField("length", 0) ||
        executionPrototype(executionIsProxy) !== FunctionCtor.prototype ||
        executionApply(executionIsProxy, undefined, [executionIsProxy]) !== false)) return undefined
    if (executionIsProxy(executionStatementGet) ||
      executionIsProxy(rowCopyGlobal) || executionIsProxy(rowCopyReflect) ||
      executionIsProxy(executionArray)) return undefined
    // Bound/Proxy/own-toString disguises opt out above. Only qualified predicates receive
    // these additional values; the capture result stays private.
    const functionPrototype = FunctionCtor.prototype, hasInstance = SymbolCtor.hasInstance
    const typedConstructor = executionPrototype(executionBytes)
    if (!nativeSource(typedConstructor, "TypedArray") || executionIsProxy(typedConstructor) ||
      executionPrototype(typedConstructor) !== functionPrototype ||
      rowCopyDescriptor(executionBytes, hasInstance) ||
      rowCopyDescriptor(typedConstructor, hasInstance)) return undefined
    const instanceField = rowCopyDescriptor(functionPrototype, hasInstance)
    const arrayField = rowCopyDescriptor(rowCopyGlobal, "Array")
    const arrayIsArrayField = rowCopyDescriptor(executionArray, "isArray")
    const bytesField = rowCopyDescriptor(rowCopyGlobal, "Uint8Array")
    if (!instanceField || !rowCopyDescriptor(instanceField, "value") ||
      !nativeSource(instanceField.value, "[Symbol.hasInstance]") ||
      !arrayField || !rowCopyDescriptor(arrayField, "value") || arrayField.value !== executionArray ||
      !arrayIsArrayField || !rowCopyDescriptor(arrayIsArrayField, "value") ||
      arrayIsArrayField.value !== executionIsArray ||
      !bytesField || !rowCopyDescriptor(bytesField, "value") ||
      bytesField.value !== executionBytes) return undefined
    return { setPrototype, objectPrototype: executionPrototype({}), typedConstructor,
      functionPrototype, hasInstance, instanceField, arrayField, arrayIsArrayField, bytesField }
  } catch { return undefined }
}

function hasOriginalRowTransferArray(transfer: FreshNativeRowTransfer): boolean {
  return hasOriginalRowCopyField(rowCopyGlobal, "Array", transfer.arrayField) &&
    hasOriginalRowCopyField(executionArray, "isArray", transfer.arrayIsArrayField)
}

function hasOriginalRowTransferBytes(transfer: FreshNativeRowTransfer): boolean {
  return hasOriginalRowCopyField(rowCopyGlobal, "Uint8Array", transfer.bytesField) &&
    !rowCopyDescriptor(executionBytes, transfer.hasInstance) &&
    executionPrototype(executionBytes) === transfer.typedConstructor &&
    !rowCopyDescriptor(transfer.typedConstructor, transfer.hasInstance) &&
    executionPrototype(transfer.typedConstructor) === transfer.functionPrototype &&
    hasOriginalRowCopyField(transfer.functionPrototype, transfer.hasInstance, transfer.instanceField)
}

function assertCurrentExecutionOrigin(record: CurrentExecutionOrigin): void {
  const database = record.database
  if (record.failed || types.isProxy(database) ||
    Object.getPrototypeOf(database) !== record.prototype ||
    executionApply(executionWeakGet, currentExecutionOrigins, [database]) !== record)
    throw new Error("[NativeSqlite] Read-one adapter changed")
  const native = Object.getOwnPropertyDescriptor(database, "native")
  const closed = Object.getOwnPropertyDescriptor(database, "closed")
  if (!native || !("value" in native) || native.value !== record.native ||
    native.enumerable !== record.nativeField.enumerable ||
    native.writable !== record.nativeField.writable ||
    native.configurable !== record.nativeField.configurable ||
    !closed || !("value" in closed) || typeof closed.value !== "boolean" ||
    closed.enumerable !== record.closedField.enumerable ||
    closed.writable !== record.closedField.writable ||
    closed.configurable !== record.closedField.configurable ||
    types.isProxy(record.native) || Object.getPrototypeOf(record.native) !== record.nativeOrigin.prototype ||
    executionApply(executionWeakGet, nativeCurrentFactoryOrigins, [record.native]) !== record.nativeOrigin)
    throw new Error("[NativeSqlite] Read-one adapter changed")
  const isOpen = Object.getOwnPropertyDescriptor(record.native, "isOpen")
  const expected = record.nativeOrigin.isOpenField
  if (!isOpen || "value" in isOpen || isOpen.get !== record.nativeOrigin.isOpen ||
    isOpen.set !== expected.set || isOpen.enumerable !== expected.enumerable ||
    isOpen.configurable !== expected.configurable)
    throw new Error("[NativeSqlite] Read-one adapter changed")
  if (closed.value || Reflect.apply(record.nativeOrigin.isOpen, record.native, []) !== true)
    throw new Error("[NativeSqlite] Database is closed")
  Reflect.apply(readOneAssertOpen, database, [])
}

/** Actual constructor/native resource facts only; no statement or business query is created here. */
export function readFunctionConversationNativeSqliteCurrentExecution(database: unknown):
  NativeSqliteCurrentExecution | undefined {
  if (!database || typeof database !== "object" || types.isProxy(database)) return undefined
  const record = executionApply(executionWeakGet, currentExecutionOrigins, [database]) as
    CurrentExecutionOrigin | undefined
  if (!record) return undefined
  record.view.assertDataCurrent()
  return record.view
}

function installCurrentExecutionOrigin(database: NativeSqliteAdapter, native: DatabaseSync): void {
  const nativeOrigin = native && executionApply(executionWeakGet, nativeCurrentFactoryOrigins, [native]) as
    NativeCurrentFactoryOrigin | undefined
  if (!native || typeof native !== "object" || types.isProxy(database) || types.isProxy(native) ||
    !nativeOrigin ||
    Object.getPrototypeOf(database) !== NativeSqliteAdapter.prototype ||
    Object.getPrototypeOf(native) !== DatabaseSync.prototype) return
  const nativeField = Object.getOwnPropertyDescriptor(database, "native")
  const closedField = Object.getOwnPropertyDescriptor(database, "closed")
  if (!nativeField || !("value" in nativeField) || nativeField.value !== native ||
    !closedField || !("value" in closedField) || closedField.value !== false) return
  // Only the actual native factory can supply this original resource/getter relationship.
  try { if (Reflect.apply(nativeOrigin.isOpen, native, []) !== true) return } catch { return }
  const assertDataCurrent = () => {
    try { assertCurrentExecutionOrigin(record) }
    catch (error) { record.failed = true; throw error }
  }
  const view: NativeSqliteCurrentExecution = Object.freeze({ assertDataCurrent,
    prepareReadOne(sql: string) {
      assertDataCurrent()
      if (typeof sql !== "string") throw new TypeError("[NativeSqlite] Read-one requires SELECT")
      return prepareReadOneData(database, sql,
        () => Reflect.apply(executionNativePrepare, native, [sql]) as StatementSync,
        assertDataCurrent, executionStatementGet)
    } })
  const record: CurrentExecutionOrigin = { database, native,
    prototype: Object.getPrototypeOf(database), nativeField, closedField, nativeOrigin,
    view, failed: false }
  executionApply(executionWeakSet, currentExecutionOrigins, [database, record])
}


/** Fixed native dispatch for the prepared-data seal and its immediate transaction only. */
export interface NativeSqlitePreparedExecution {
  assertDataCurrent(requireAutocommit?: boolean): void
  prepareReadOne(sql: string): NativeSqliteReadOne
  run(sql: string, bindings?: readonly unknown[]): void
}

function executionOwnValue(receiver: object, key: PropertyKey): unknown {
  const descriptor = executionDescriptor(receiver, key)
  if (!descriptor || !executionDescriptor(descriptor, "value"))
    throw new TypeError("[NativeSqlite] Prepared execution requires own data")
  return descriptor.value
}

function executionDefineValue(receiver: object, key: PropertyKey, value: unknown): void {
  const descriptor = executionCreate(null) as PropertyDescriptor
  descriptor.value = value
  descriptor.writable = true
  descriptor.enumerable = true
  descriptor.configurable = true
  executionDefine(receiver, key, descriptor)
}

function executionBindings(bindings: NativeSqliteBindings | undefined): NativeSqliteValue[] {
  if (bindings === undefined) return []
  if (executionIsProxy(bindings) || !executionIsArray(bindings))
    throw new TypeError("[NativeSqlite] Prepared execution requires positional bindings")
  const length = executionOwnValue(bindings, "length")
  if (typeof length !== "number" || !executionSafeInteger(length) || length < 0)
    throw new TypeError("[NativeSqlite] Invalid binding length")
  const result = new executionArray<NativeSqliteValue>(length)
  for (let index = 0; index < length; index++) {
    const value = executionOwnValue(bindings, index)
    let normalized: NativeSqliteValue
    if (value === undefined || value === null) normalized = null
    else if (typeof value === "boolean") normalized = value ? 1 : 0
    else if (typeof value === "string" || typeof value === "number" || typeof value === "bigint")
      normalized = value
    else if (value && !executionIsProxy(value) && executionIsUint8Array(value) &&
      !executionIsSharedArrayBuffer(executionApply(executionBuffer, value, []))) normalized = value
    else throw new TypeError("[NativeSqlite] Unsupported prepared binding")
    executionDefineValue(result, index, normalized)
  }
  return result
}

function executionCopyRow(row: Record<string, NativeSqliteValue> | undefined):
  Record<string, NativeSqliteValue> | undefined {
  if (!row) return undefined
  const result = executionCreate(null) as Record<string, NativeSqliteValue>
  const keys = executionObjectKeys(row)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    let value = executionOwnValue(row, key) as NativeSqliteValue
    if (value && typeof value === "object" && executionIsUint8Array(value)) {
      const copy = new executionBytes(executionApply(executionByteLength, value, []))
      executionApply(executionBytesSet, copy, [value])
      value = copy
    }
    executionDefineValue(result, key, value)
  }
  return result
}

/** Reuses the actual native factory/resource records; never calls adapter methods. */
export function captureFunctionConversationNativeSqlitePreparedExecution(database: unknown):
  NativeSqlitePreparedExecution | undefined {
  if (!database || typeof database !== "object" || executionIsProxy(database)) return undefined
  const record = executionApply(executionWeakGet, currentExecutionOrigins, [database]) as
    CurrentExecutionOrigin | undefined
  if (!record || record.database !== database || record.nativeOrigin.nativeConstructor !== executionNativeConstructor)
    return undefined
  const native = record.native, origin = record.nativeOrigin
  const unusableField = executionDescriptor(database, "unusable")
  if (!unusableField || !executionDescriptor(unusableField, "value") ||
    typeof unusableField.value !== "boolean") return undefined
  const matchesDataField = (key: string, expected: PropertyDescriptor, value: unknown) => {
    const field = executionDescriptor(database, key)
    return !!field && !!executionDescriptor(field, "value") && field.value === value &&
      field.writable === expected.writable && field.enumerable === expected.enumerable &&
      field.configurable === expected.configurable
  }
  const matchesGetter = (key: string, expected: PropertyDescriptor) => {
    const field = executionDescriptor(native, key)
    return !!field && !executionDescriptor(field, "value") && field.get === expected.get &&
      field.set === expected.set && field.enumerable === expected.enumerable &&
      field.configurable === expected.configurable && field.configurable === false
  }
  const assertResourceCurrent = (requireAutocommit = false) => {
    if (record.failed || executionIsProxy(database) || executionIsProxy(native) ||
      executionPrototype(database) !== record.prototype ||
      executionPrototype(native) !== origin.prototype ||
      executionApply(executionWeakGet, currentExecutionOrigins, [database]) !== record ||
      executionApply(executionWeakGet, nativeCurrentFactoryOrigins, [native]) !== origin ||
      !matchesDataField("native", record.nativeField, native) ||
      !matchesDataField("closed", record.closedField, false) ||
      !matchesDataField("unusable", unusableField, false) ||
      !matchesGetter("isOpen", origin.isOpenField) ||
      !matchesGetter("isTransaction", origin.isTransactionField))
      throw new Error("[NativeSqlite] Prepared native resource changed")
    if (executionApply(origin.isOpen, native, []) !== true)
      throw new Error("[NativeSqlite] Database is closed")
    if (requireAutocommit && executionApply(origin.isTransactionField.get!, native, []) !== false)
      throw new Error("[NativeSqlite] Prepared execution requires autocommit")
  }
  assertResourceCurrent()
  // Prepared writes must not call JS through CHECK/generated columns/expression indexes.
  // This connection policy remains OFF once the connection enters the prepared cohort;
  // ordinary-only connections never invoke this factory. Direct SELECTs still need the
  // limited function qualification below. No schema/data rewrite is involved.
  const schemaTrust = executionApply(executionNativePrepare, native,
    ["PRAGMA trusted_schema"]) as StatementSync
  const assertSchemaTrust = () => {
    const row = executionApply(executionStatementGet, schemaTrust, []) as
      Record<string, NativeSqliteValue> | undefined
    if (!row || executionOwnValue(row, "trusted_schema") !== 0)
      throw new Error("[NativeSqlite] Prepared schema trust changed")
  }
  const initialTrust = executionApply(executionStatementGet, schemaTrust, []) as
    Record<string, NativeSqliteValue> | undefined
  if (!initialTrust || executionOwnValue(initialTrust, "trusted_schema") !== 0) {
    const disableTrust = executionApply(executionNativePrepare, native,
      ["PRAGMA trusted_schema=OFF"]) as StatementSync
    executionApply(executionStatementRun, disableTrust, [])
  }
  assertSchemaTrust()
  // These two queries contain no SQL functions. Qualify only the functions used by the
  // prepared Saver/Store seals, preserving SQLite's unrelated built-in extension functions.
  const shadow = executionApply(executionNativePrepare, native, [
    "SELECT 1 FROM main.sqlite_schema WHERE name='pragma_function_list' COLLATE NOCASE " +
    "AND type IN ('table','view') LIMIT 1"
  ]) as StatementSync
  const assertFunctionListSchema = () => {
    if (executionApply(executionStatementGet, shadow, []))
      throw new Error("[NativeSqlite] Function-list schema changed")
  }
  assertFunctionListSchema()
  const functions = executionApply(executionNativePrepare, native, [
    "SELECT 1 FROM main.pragma_function_list WHERE builtin=0 AND name COLLATE NOCASE " +
    "IN ('lower','count','total_changes','length','typeof','json_extract','json_type','sum','coalesce') LIMIT 1"
  ]) as StatementSync
  const assertDataCurrent = (requireAutocommit = false) => {
    assertResourceCurrent(requireAutocommit)
    assertSchemaTrust()
    assertFunctionListSchema()
    if (executionApply(executionStatementGet, functions, []))
      throw new Error("[NativeSqlite] SQL function replaced")
    assertResourceCurrent(requireAutocommit)
  }
  assertDataCurrent()
  return executionFreeze({
    assertDataCurrent,
    prepareReadOne(sql: string): NativeSqliteReadOne {
      assertResourceCurrent()
      if (typeof sql !== "string" ||
        sql !== "PRAGMA main.data_version" && !executionApply(executionRegExp, executionSelect, [sql]))
        throw new TypeError("[NativeSqlite] Read-one requires SELECT")
      const statement = executionApply(executionNativePrepare, native, [sql]) as StatementSync
      return (bindings?: NativeSqliteBindings) => {
        assertResourceCurrent()
        const normalized = executionBindings(bindings)
        assertResourceCurrent()
        const row = executionApply(executionStatementGet, statement, normalized) as
          Record<string, NativeSqliteValue> | undefined
        const result = executionCopyRow(row)
        assertResourceCurrent()
        return result
      }
    },
    run(sql: string, bindings?: readonly unknown[]): void {
      if (typeof sql !== "string") throw new TypeError("[NativeSqlite] SQL must be a string")
      const rollback = sql === "ROLLBACK" && bindings === undefined
      if (!rollback) assertResourceCurrent()
      const normalized = executionBindings(bindings)
      if (!rollback) assertResourceCurrent()
      const statement = executionApply(executionNativePrepare, native, [sql]) as StatementSync
      executionApply(executionStatementRun, statement, normalized)
      if (!rollback) assertResourceCurrent()
    }
  })
}

export interface NativeSqliteExecResult {
  columns: string[]
  values: NativeSqliteValue[][]
}

interface RecoveryCandidate {
  path: string
  suffix: string
  mtimeMs: number
}

export interface OpenNativeSqliteResult {
  database: NativeSqliteAdapter
  sourcePath: string | null
  recovered: boolean
}

export interface NativeSqliteCloseOptions {
  checkpoint?: boolean
}

const RECOVERY_SUFFIXES = ["", ".flush.tmp", ".tmp", ".bak", ".bak.tmp"]
const NATIVE_SIDECAR_SUFFIXES = ["-wal", "-shm"]

function normalizeBinding(value: unknown): NativeSqliteValue {
  if (value === undefined || value === null) return null
  if (typeof value === "boolean") return value ? 1 : 0
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return value
  }
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new TypeError(`[NativeSqlite] Unsupported binding value: ${typeof value}`)
}

function normalizeBindings(
  bindings: NativeSqliteBindings
): NativeSqliteValue[] | Record<string, NativeSqliteValue> {
  if (Array.isArray(bindings)) return bindings.map(normalizeBinding)
  return Object.fromEntries(
    Object.entries(bindings).map(([key, value]) => [key, normalizeBinding(value)])
  )
}

const readOneArray = Array
const readOneIsArray = Array.isArray
const readOneCreate = Object.create
const readOneDefine = Object.defineProperty

function defineReadOneBinding(receiver: object, key: PropertyKey, value: NativeSqliteValue): void {
  const descriptor = readOneCreate(null) as PropertyDescriptor
  descriptor.value = value
  descriptor.enumerable = true
  descriptor.writable = true
  descriptor.configurable = true
  readOneDefine(receiver, key, descriptor)
}

/** Read-one's private traversal preserves map semantics without a late Array method/iterator. */
function normalizeReadOneBindings(
  bindings: NativeSqliteBindings
): NativeSqliteValue[] | Record<string, NativeSqliteValue> {
  if (readOneIsArray(bindings)) {
    const length = bindings.length
    const result = new readOneArray<NativeSqliteValue>(length)
    for (let index = 0; index < length; index++) {
      if (index in bindings) defineReadOneBinding(result, index, normalizeBinding(bindings[index]))
    }
    return result
  }
  const entries = Object.entries(bindings), result: Record<string, NativeSqliteValue> = {}
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    defineReadOneBinding(result, entry[0], normalizeBinding(entry[1]))
  }
  return result
}

function statementIterator(
  statement: StatementSync,
  bindings: NativeSqliteValue[] | Record<string, NativeSqliteValue>
): Iterator<Record<string, NativeSqliteValue>> {
  if (Array.isArray(bindings)) {
    return statement.iterate(...bindings) as Iterator<Record<string, NativeSqliteValue>>
  }
  return statement.iterate(bindings) as Iterator<Record<string, NativeSqliteValue>>
}

function statementRows(
  statement: StatementSync,
  bindings: NativeSqliteValue[] | Record<string, NativeSqliteValue>
): Record<string, NativeSqliteValue>[] {
  if (Array.isArray(bindings)) {
    return statement.all(...bindings) as Record<string, NativeSqliteValue>[]
  }
  return statement.all(bindings) as Record<string, NativeSqliteValue>[]
}

function runStatement(
  statement: StatementSync,
  bindings: NativeSqliteValue[] | Record<string, NativeSqliteValue>
): void {
  if (Array.isArray(bindings)) {
    statement.run(...bindings)
  } else {
    statement.run(bindings)
  }
}

/**
 * Compatibility wrapper for the small sql.js surface used by the main database.
 * Statements are owned by DatabaseSync, so free() only releases adapter references.
 */
export class NativeSqliteStatement {
  private bindings: NativeSqliteValue[] | Record<string, NativeSqliteValue> = []
  private iterator: Iterator<Record<string, NativeSqliteValue>> | null = null
  private currentRow: Record<string, NativeSqliteValue> | null = null
  private freed = false

  constructor(private readonly statement: StatementSync,
    private readonly assertDatabaseOpen?: () => void) {}

  bind(bindings: NativeSqliteBindings): boolean {
    this.assertUsable()
    this.releaseIterator()
    this.bindings = normalizeBindings(bindings)
    this.currentRow = null
    return true
  }

  step(): boolean {
    this.assertUsable()
    this.iterator ??= statementIterator(this.statement, this.bindings)
    const next = this.iterator.next()
    this.currentRow = next.done ? null : next.value
    return !next.done
  }

  getAsObject(): Record<string, NativeSqliteValue> {
    this.assertUsable()
    return this.currentRow ?? {}
  }

  reset(): void {
    this.assertUsable()
    this.releaseIterator()
    this.currentRow = null
  }

  free(): boolean {
    this.releaseIterator()
    this.currentRow = null
    this.freed = true
    return true
  }

  private releaseIterator(): void {
    this.iterator?.return?.()
    this.iterator = null
  }

  private assertUsable(): void {
    if (this.freed) throw new Error("[NativeSqlite] Statement has been freed")
    this.assertDatabaseOpen?.()
  }
}

/**
 * A file-backed node:sqlite database with a sql.js-compatible query facade.
 * SQLite commits mutations directly to the WAL; there is deliberately no export().
 */
export class NativeSqliteAdapter {
  private closed = false
  private unusable = false
  private lastRowsModified = 0

  constructor(private readonly native: DatabaseSync) {}

  /** The actual SQLite connection owns this fact; callers cannot supply a transaction flag. */
  get inTransaction(): boolean {
    this.assertOpen()
    return this.native.isTransaction
  }

  run(sql: string, bindings?: NativeSqliteBindings): this {
    this.assertOpen()
    if (bindings === undefined) {
      this.native.exec(sql)
    } else {
      runStatement(this.native.prepare(sql), normalizeBindings(bindings))
    }
    this.lastRowsModified = this.readChanges()
    return this
  }

  /**
   * sql.js-compatible row count for the most recent run(): the number of rows
   * affected by the last completed INSERT/UPDATE/DELETE on this connection.
   */
  getRowsModified(): number {
    return this.lastRowsModified
  }

  private readChanges(): number {
    const row = this.native.prepare("SELECT changes() AS changed_rows").get()
    const value = row?.changed_rows
    if (typeof value === "bigint") return Number(value) || 0
    return Number(value ?? 0) || 0
  }

  exec(sql: string, bindings?: NativeSqliteBindings): NativeSqliteExecResult[] {
    this.assertOpen()
    let statement: StatementSync
    try {
      statement = this.native.prepare(sql)
    } catch (error) {
      if (bindings !== undefined) throw error
      this.native.exec(sql)
      return []
    }

    const columns = statement.columns().map((column) => column.name)
    if (columns.length === 0) {
      if (bindings === undefined) {
        this.native.exec(sql)
      } else {
        runStatement(statement, normalizeBindings(bindings))
      }
      return []
    }

    const normalizedBindings = normalizeBindings(bindings ?? [])
    const rows = statementRows(statement, normalizedBindings)
    return [
      {
        columns,
        values: rows.map((row) => columns.map((column) => row[column]))
      }
    ]
  }

  prepare(sql: string, bindings?: NativeSqliteBindings): NativeSqliteStatement {
    this.assertOpen()
    const statement = new NativeSqliteStatement(this.native.prepare(sql), () =>
      Reflect.apply(readOneAssertOpen, this, []))
    if (bindings !== undefined) statement.bind(bindings)
    return statement
  }

  /** Keep a large DELETE's WAL checkpoint out of the main-thread COMMIT.
   * The caller must schedule a background checkpoint after committing. WAL
   * durability is unchanged; restore the connection policy even on rollback.
   */
  withoutAutomaticCheckpoint<T>(operation: () => T): T {
    this.assertOpen()
    const pages = Number(this.native.prepare("PRAGMA wal_autocheckpoint").get()?.wal_autocheckpoint)
    this.native.exec("PRAGMA wal_autocheckpoint = 0")
    try {
      return operation()
    } finally {
      this.native.exec(`PRAGMA wal_autocheckpoint = ${pages}`)
    }
  }

  /** A fixed SELECT statement only. Every call reads fresh data, without an iterator or row cache. */
  prepareReadOne(sql: string): NativeSqliteReadOne {
    return prepareReadOneData(this, sql, () => this.native.prepare(sql))
  }

  /** Move committed WAL pages into the main file without copying the full database. */
  flush(mode: "FULL" | "TRUNCATE" = "FULL"): void {
    this.assertOpen()
    const result = this.native.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as
      | Record<string, NativeSqliteValue>
      | undefined
    if (Number(result?.busy ?? 0) !== 0) {
      throw new Error(`[NativeSqlite] WAL checkpoint ${mode} could not acquire the writer lock`)
    }
  }

  close(options: NativeSqliteCloseOptions = {}): void {
    if (this.closed) return
    try {
      if (options.checkpoint !== false) this.flush("TRUNCATE")
    } finally {
      this.native.close()
      this.closed = true
    }
  }

  /** Fail closed after an unclean transaction; this does not claim the handle is closed. */
  markUnusable(): void {
    this.unusable = true
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("[NativeSqlite] Database is closed")
    if (this.unusable) throw new Error("[NativeSqlite] Database is unavailable")
  }
}

// Capture the actual class method at module evaluation, before any reader is published.
const readOneAssertOpen = Object.getOwnPropertyDescriptor(
  NativeSqliteAdapter.prototype, "assertOpen")!.value as (this: NativeSqliteAdapter) => void

/** One complete read-one implementation; only the private execution supplies fixed native dispatch. */
function prepareReadOneData(database: NativeSqliteAdapter, sql: string,
  prepare: () => StatementSync, assertOrigin?: () => void,
  fixedGet?: StatementSync["get"]): NativeSqliteReadOne {
  if (types.isProxy(database)) throw new Error("[NativeSqlite] Read-one adapter changed")
  const originalPrototype = Object.getPrototypeOf(database)
  const originalClosed = Object.getOwnPropertyDescriptor(database, "closed")
  if (!originalClosed || !("value" in originalClosed) || typeof originalClosed.value !== "boolean")
    throw new Error("[NativeSqlite] Read-one adapter changed")
  const assertReadOpen = () => {
    if (types.isProxy(database) || Object.getPrototypeOf(database) !== originalPrototype)
      throw new Error("[NativeSqlite] Read-one adapter changed")
    const closed = Object.getOwnPropertyDescriptor(database, "closed")
    if (!closed || !("value" in closed) || typeof closed.value !== "boolean" ||
      closed.enumerable !== originalClosed.enumerable ||
      closed.writable !== originalClosed.writable || closed.configurable !== originalClosed.configurable)
      throw new Error("[NativeSqlite] Read-one adapter changed")
    assertOrigin?.()
    Reflect.apply(readOneAssertOpen, database, [])
  }
  assertReadOpen()
  const mainDataVersion = fixedGet === executionStatementGet && sql === "PRAGMA main.data_version"
  if (!/^\s*SELECT\b/i.test(sql) && !mainDataVersion)
    throw new TypeError("[NativeSqlite] Read-one requires SELECT")
  const statement = prepare()
  const getDescriptor = fixedGet ? undefined : Object.getOwnPropertyDescriptor(statement, "get") ??
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(statement), "get")
  if (!fixedGet && (!getDescriptor || !("value" in getDescriptor) ||
    typeof getDescriptor.value !== "function"))
    throw new TypeError("[NativeSqlite] Read-one requires native get")
  const originalGet = fixedGet ?? getDescriptor!.value as StatementSync["get"]
  return (bindings = []) => {
    assertReadOpen()
    const normalized = normalizeReadOneBindings(bindings)
    assertReadOpen()
    const ordinaryNativeCall = !fixedGet && originalGet === executionStatementGet &&
      hasOriginalRowCopyField(rowCopyGlobal, "Reflect", rowCopyReflectField) &&
      hasOriginalRowCopyField(rowCopyReflect, "apply", rowCopyApplyField)
    const nativeRowCall = freshNativeRowTransfer && originalGet === executionStatementGet &&
      (ordinaryNativeCall || !!fixedGet &&
        hasOriginalRowCopyField(rowCopyGlobal, "Reflect", rowCopyReflectField) &&
        hasOriginalRowCopyField(rowCopyReflect, "apply", rowCopyApplyField)) &&
      hasOriginalRowTransferArray(freshNativeRowTransfer)
    const row = Reflect.apply(originalGet, statement, Array.isArray(normalized)
      ? normalized : [normalized]) as Record<string, NativeSqliteValue> | undefined
    let result: Record<string, NativeSqliteValue> | undefined
    if (row) {
      if (nativeRowCall && freshNativeRowTransfer &&
        hasOriginalRowCopyField(rowCopyGlobal, "Object", rowCopyObjectField) &&
        hasOriginalRowCopyField(rowCopyObject, "entries", rowCopyEntriesField) &&
        hasOriginalRowCopyField(rowCopyObject, "defineProperty", rowCopyDefineField) &&
        hasOriginalRowTransferBytes(freshNativeRowTransfer) &&
        !executionIsArray(row) && executionPrototype(row) === null) {
        // Actual C++ get owns a plain row (never a Proxy) and its blobs. Do not expose that
        // row to the cold metadata predicate. Preserve the public literal Object prototype
        // without allocating another row, key list or blob per column.
        result = freshNativeRowTransfer.setPrototype(row, freshNativeRowTransfer.objectPrototype)
      } else if (fixedGet === executionStatementGet || ordinaryNativeCall &&
        hasOriginalRowCopyField(rowCopyGlobal, "Object", rowCopyObjectField) &&
        hasOriginalRowCopyField(rowCopyObject, "entries", rowCopyEntriesField) &&
        hasOriginalRowCopyField(rowCopyObject, "defineProperty", rowCopyDefineField)) {
        // Genuine native get returns fresh data rows. Copy every own field and every blob.
        result = { ...row }
        const keys = executionObjectKeys(result)
        for (let index = 0; index < keys.length; index++) {
          const key = keys[index], value = result[key]
          if (value instanceof Uint8Array) result[key] = new Uint8Array(value)
        }
      } else {
        result = {}
        const entries = Object.entries(row)
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index], value = entry[1]
          Object.defineProperty(result, entry[0], {
            value: value instanceof Uint8Array ? new Uint8Array(value) : value,
            enumerable: true, writable: true, configurable: true })
        }
      }
    }
    assertReadOpen()
    return result as Record<string, NativeSqliteValue> | undefined
  }
}

function candidateMtime(path: string): number {
  let mtimeMs = statSync(path).mtimeMs
  for (const sidecarSuffix of NATIVE_SIDECAR_SUFFIXES) {
    try {
      mtimeMs = Math.max(mtimeMs, statSync(`${path}${sidecarSuffix}`).mtimeMs)
    } catch {
      // Sidecar absent.
    }
  }
  return mtimeMs
}

function getRecoveryCandidates(dbPath: string): RecoveryCandidate[] {
  const candidates: RecoveryCandidate[] = []
  for (const suffix of RECOVERY_SUFFIXES) {
    const path = `${dbPath}${suffix}`
    try {
      const stats = statSync(path)
      if (!stats.isFile() || stats.size <= 0) continue
      candidates.push({ path, suffix, mtimeMs: candidateMtime(path) })
    } catch {
      // Candidate absent.
    }
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

function probeSqliteFile(path: string, verifyAllPages: boolean): boolean {
  let candidate: DatabaseSync | null = null
  try {
    candidate = new DatabaseSync(path, {
      readOnly: true,
      enableForeignKeyConstraints: false,
      timeout: 1_000
    })
    if (!verifyAllPages) {
      candidate.prepare("PRAGMA schema_version").get()
      candidate.prepare("SELECT name FROM sqlite_schema LIMIT 1").get()
      return true
    }
    const row = candidate.prepare("PRAGMA quick_check(1)").get()
    return Boolean(row && Object.values(row)[0] === "ok")
  } catch {
    return false
  } finally {
    candidate?.close()
  }
}

function chooseRecoveryCandidate(
  candidates: readonly RecoveryCandidate[]
): RecoveryCandidate | null {
  const live = candidates.find((candidate) => candidate.suffix === "")
  // Keep the normal open path O(1): a full integrity_check scans the entire
  // database and recreates the same main-thread-size stall this adapter removes.
  // Recovery candidates are cold paths and receive a bounded quick_check.
  if (live && probeSqliteFile(live.path, false)) {
    for (const candidate of candidates) {
      const isNewerTemp =
        (candidate.suffix === ".tmp" || candidate.suffix === ".flush.tmp") &&
        candidate.mtimeMs > live.mtimeMs
      if (isNewerTemp && probeSqliteFile(candidate.path, true)) return candidate
    }
    return live
  }

  for (const candidate of candidates) {
    if (candidate !== live && probeSqliteFile(candidate.path, true)) return candidate
  }
  return null
}

function removeNativeSidecars(dbPath: string): void {
  for (const suffix of NATIVE_SIDECAR_SUFFIXES) {
    try {
      unlinkSync(`${dbPath}${suffix}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}

function archiveInvalidLiveFile(dbPath: string, label: string): void {
  if (!existsSync(dbPath)) return
  const archivePath = `${dbPath}.corrupt.${Date.now()}`
  try {
    renameSync(dbPath, archivePath)
    registerSqliteQuarantineArtifact(dbPath, archivePath)
    for (const suffix of NATIVE_SIDECAR_SUFFIXES) {
      if (existsSync(`${dbPath}${suffix}`)) {
        const archivedSidecarPath = `${archivePath}${suffix}`
        renameSync(`${dbPath}${suffix}`, archivedSidecarPath)
        registerSqliteQuarantineArtifact(dbPath, archivedSidecarPath)
      }
    }
    console.warn(`[${label}] Archived invalid database: ${archivePath}`)
  } catch (error) {
    console.warn(`[${label}] Failed to archive invalid database:`, error)
  }
}

function restoreCandidate(dbPath: string, candidatePath: string): void {
  if (existsSync(`${candidatePath}-wal`)) {
    const candidate = new DatabaseSync(candidatePath, {
      enableForeignKeyConstraints: false,
      timeout: 5_000
    })
    try {
      const result = candidate.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
        | Record<string, NativeSqliteValue>
        | undefined
      if (Number(result?.busy ?? 0) !== 0) {
        throw new Error(`[NativeSqlite] Recovery WAL is busy: ${candidatePath}`)
      }
    } finally {
      candidate.close()
    }
  }

  const recoveryPath = `${dbPath}.recovery.tmp`
  copyFileSync(candidatePath, recoveryPath)
  const descriptor = openSync(recoveryPath, "r+")
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  removeNativeSidecars(dbPath)
  renameSync(recoveryPath, dbPath)
}

/**
 * Open an existing standard SQLite/sql.js file or recover a legacy durable
 * snapshot candidate before switching the live database to WAL mode.
 */
export function openNativeSqliteDatabase(
  dbPath: string,
  label = "NativeSqlite"
): OpenNativeSqliteResult {
  mkdirSync(dirname(dbPath), { recursive: true })
  const candidates = getRecoveryCandidates(dbPath)
  const liveCandidate = candidates.find((candidate) => candidate.suffix === "")
  const selected = chooseRecoveryCandidate(candidates)

  if (!selected && liveCandidate) archiveInvalidLiveFile(dbPath, label)
  if (selected && selected.suffix !== "") {
    if (liveCandidate && !probeSqliteFile(liveCandidate.path, false)) {
      archiveInvalidLiveFile(dbPath, label)
    }
    restoreCandidate(dbPath, selected.path)
    console.warn(`[${label}] Recovered database from: ${selected.path}`)
  }

  const nativeConstructor = DatabaseSync
  const native = new nativeConstructor(dbPath, {
    enableForeignKeyConstraints: false,
    timeout: 5_000
  })
  const isOpen = executionDescriptor(native, "isOpen")
  const isTransaction = executionDescriptor(native, "isTransaction")
  if (isTransaction && !executionDescriptor(isTransaction, "value") &&
    typeof isTransaction.get === "function" && !executionIsProxy(isTransaction.get) && isOpen && !("value" in isOpen) && typeof isOpen.get === "function" &&
    !types.isProxy(isOpen.get))
    executionApply(executionWeakSet, nativeCurrentFactoryOrigins, [native, {
      native, nativeConstructor, prototype: executionPrototype(native),
      isTransactionField: executionFreeze(isTransaction), isOpenField: executionFreeze(isOpen),
      isOpen: isOpen.get }])
  native.exec("PRAGMA journal_mode = WAL")
  native.exec("PRAGMA synchronous = NORMAL")
  native.exec("PRAGMA busy_timeout = 5000")
  const database = new NativeSqliteAdapter(native)
  installCurrentExecutionOrigin(database, native)

  return {
    database,
    sourcePath: selected?.path ?? null,
    recovered: Boolean(selected && selected.suffix !== "")
  }
}
