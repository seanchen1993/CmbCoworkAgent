import { DatabaseSync, type StatementSync } from "node:sqlite"
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
  native.exec("PRAGMA journal_mode = WAL")
  native.exec("PRAGMA synchronous = NORMAL")
  native.exec("PRAGMA busy_timeout = 5000")

  return {
    database: new NativeSqliteAdapter(native),
    sourcePath: selected?.path ?? null,
    recovered: Boolean(selected && selected.suffix !== "")
  }
}
