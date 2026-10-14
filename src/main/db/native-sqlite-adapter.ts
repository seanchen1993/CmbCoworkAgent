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
  readonly prototype: object | null
  readonly isOpenField: PropertyDescriptor
  readonly isOpen: (this: DatabaseSync) => boolean
}
const nativeCurrentFactoryOrigins = new WeakMap<DatabaseSync, NativeCurrentFactoryOrigin>()
const executionWeakGet = WeakMap.prototype.get, executionWeakSet = WeakMap.prototype.set
const executionNativePrepare = DatabaseSync.prototype.prepare
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

function hasOriginalRowCopyField(
  receiver: object, key: string, expected: PropertyDescriptor
): boolean {
  const field = rowCopyDescriptor(receiver, key)
  return !!field && !!rowCopyDescriptor(field, "value") && field.value === expected.value &&
    field.writable === expected.writable && field.enumerable === expected.enumerable &&
    field.configurable === expected.configurable
}

function assertCurrentExecutionOrigin(record: CurrentExecutionOrigin): void {
  const database = record.database
  if (record.failed || types.isProxy(database) ||
    Object.getPrototypeOf(database) !== record.prototype ||
    Reflect.apply(executionWeakGet, currentExecutionOrigins, [database]) !== record)
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
    Reflect.apply(executionWeakGet, nativeCurrentFactoryOrigins, [record.native]) !== record.nativeOrigin)
    throw new Error("[NativeSqlite] Read-one adapter changed")
  const isOpen = Object.getOwnPropertyDescriptor(record.native, "isOpen")
  const expected = record.nativeOrigin.isOpenField
  if (!isOpen || "value" in isOpen || isOpen.get !== record.nativeOrigin.isOpen ||
    isOpen.set !== expected.set || isOpen.enumerable !== expected.enumerable ||
    isOpen.configurable !== expected.configurable)
    throw new Error("[NativeSqlite] Read-one adapter changed")
  if (closed.value || Reflect.apply(record.nativeOrigin.isOpen, record.native, []) !== true)
    throw new Error("[NativeSqlite] Database is closed")
}

/** Actual constructor/native resource facts only; no statement or business query is created here. */
export function readFunctionConversationNativeSqliteCurrentExecution(database: unknown):
  NativeSqliteCurrentExecution | undefined {
  if (!database || typeof database !== "object" || types.isProxy(database)) return undefined
  const record = Reflect.apply(executionWeakGet, currentExecutionOrigins, [database]) as
    CurrentExecutionOrigin | undefined
  if (!record) return undefined
  record.view.assertDataCurrent()
  return record.view
}

function installCurrentExecutionOrigin(database: NativeSqliteAdapter, native: DatabaseSync): void {
  const nativeOrigin = native && Reflect.apply(executionWeakGet, nativeCurrentFactoryOrigins, [native]) as
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
  Reflect.apply(executionWeakSet, currentExecutionOrigins, [database, record])
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

/** Read-one's private traversal preserves map semantics without a late Array method/iterator. */
function normalizeReadOneBindings(
  bindings: NativeSqliteBindings
): NativeSqliteValue[] | Record<string, NativeSqliteValue> {
  if (Array.isArray(bindings)) {
    const length = bindings.length
    const result = new Array<NativeSqliteValue>(length)
    for (let index = 0; index < length; index++) {
      if (index in bindings) result[index] = normalizeBinding(bindings[index])
    }
    return result
  }
  const entries = Object.entries(bindings), result: Record<string, NativeSqliteValue> = {}
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    Object.defineProperty(result, entry[0], { value: normalizeBinding(entry[1]),
      enumerable: true, writable: true, configurable: true })
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

  constructor(private readonly statement: StatementSync) {}

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
  }
}

/**
 * A file-backed node:sqlite database with a sql.js-compatible query facade.
 * SQLite commits mutations directly to the WAL; there is deliberately no export().
 */
export class NativeSqliteAdapter {
  private closed = false
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
    const statement = new NativeSqliteStatement(this.native.prepare(sql))
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

  private assertOpen(): void {
    if (this.closed) throw new Error("[NativeSqlite] Database is closed")
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
  if (!/^\s*SELECT\b/i.test(sql)) throw new TypeError("[NativeSqlite] Read-one requires SELECT")
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
    const row = Reflect.apply(originalGet, statement, Array.isArray(normalized)
      ? normalized : [normalized]) as Record<string, NativeSqliteValue> | undefined
    let result: Record<string, NativeSqliteValue> | undefined
    if (row) {
      if (fixedGet === executionStatementGet || ordinaryNativeCall &&
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

  const native = new DatabaseSync(dbPath, {
    enableForeignKeyConstraints: false,
    timeout: 5_000
  })
  const isOpen = Object.getOwnPropertyDescriptor(native, "isOpen")
  if (isOpen && !("value" in isOpen) && typeof isOpen.get === "function" &&
    !types.isProxy(isOpen.get))
    Reflect.apply(executionWeakSet, nativeCurrentFactoryOrigins, [native, {
      native, prototype: Object.getPrototypeOf(native), isOpenField: Object.freeze(isOpen),
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
