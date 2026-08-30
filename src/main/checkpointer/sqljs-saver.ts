import initSqlJs, { Database as SqlJsDatabase } from "sql.js"
import { readFileSync, renameSync, unlinkSync } from "fs"
import {
  openRecoveredSqliteDatabase,
  persistSqliteSnapshot,
  sqliteFileSize
} from "../utils/sqlite-durable-file"

// Debounce window for background checkpoint saves. Checkpoints are written very
// frequently during a streaming agent run; coalescing keeps the synchronous
// db.export() snapshot off the hot path while the disk write runs async.
const CHECKPOINT_SAVE_DEBOUNCE_MS = 300
const DEFAULT_MAX_DB_SIZE_BYTES = 100 * 1024 * 1024
const DEFAULT_MAX_OVERSIZED_RECOVERY_BYTES = 128 * 1024 * 1024
const DEFAULT_MAX_ROOT_FORK_BOUNDARY_CHECKPOINTS = 0
const DEFAULT_MAX_ROOT_FORK_BOUNDARY_BYTES = 48 * 1024 * 1024
import type { RunnableConfig } from "@langchain/core/runnables"
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  type SerializerProtocol,
  type PendingWrite,
  type CheckpointMetadata,
  copyCheckpoint
} from "@langchain/langgraph-checkpoint"

interface CheckpointRow {
  thread_id: string
  checkpoint_ns: string
  checkpoint_id: string
  parent_checkpoint_id: string | null
  type: string | null
  checkpoint: string
  metadata: string | Uint8Array
  checkpoint_ts?: string | null
  fork_boundary_marker?: number | null
}

interface RootCheckpointRetentionRow {
  checkpoint_id: string
  fork_boundary_marker: number
  payload_bytes: number
}

interface WriteRow {
  task_id: string
  channel: string
  type: string | null
  value: string
}

export interface SqlJsSaverOptions {
  /** Legacy option: applies to every namespace unless the split options below are set. */
  maxCheckpointsPerNamespace?: number
  /** Root namespace checkpoints back runtime resume and recent checkpoint fork. */
  maxRootCheckpoints?: number
  /** Completed-turn root checkpoints retained for message fork, bounded separately. */
  maxRootForkBoundaryCheckpoints?: number
  /** Approximate serialized checkpoint+metadata budget for retained fork boundaries. */
  maxRootForkBoundaryBytes?: number
  /** Non-root namespaces are LangGraph internals/tool subgraphs and can grow very large. */
  maxNonRootCheckpoints?: number
  /** Soft size guard for opening a database without emergency pruning. */
  maxDatabaseBytes?: number
  /** Harder cap for attempting to open and compact an oversized live database. */
  maxOversizedRecoveryBytes?: number
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value >= 0
    ? Math.max(0, Math.floor(value))
    : fallback
}

function checkpointMetadataHasForkBoundaryMarker(metadata: CheckpointMetadata): boolean {
  const value = metadata as Record<string, unknown> | null | undefined
  const boundary = value?.cmb_fork_boundary
  return Boolean(boundary && typeof boundary === "object" && !Array.isArray(boundary))
}

function isSqliteIntegrityOk(database: SqlJsDatabase): boolean {
  try {
    const result = database.exec("PRAGMA integrity_check")
    return result[0]?.values[0]?.[0] === "ok"
  } catch {
    return false
  }
}

/**
 * SQLite checkpointer using sql.js (pure JavaScript, no native modules)
 * Compatible with all Electron versions without native compilation.
 */
export class SqlJsSaver extends BaseCheckpointSaver {
  private db: SqlJsDatabase | null = null
  private dbPath: string
  private isSetup = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  /** In-flight async save, so flush() knows bytes may be in an unrenamed temp. */
  private savePromise: Promise<void> | null = null
  private flushPromise: Promise<unknown | null> | null = null
  private closePromise: Promise<void> | null = null
  /** Set while a flush/close drains the writer so no older rename can land
   * after the authoritative snapshot. */
  private blockAsyncWrite = false
  /** Permanently dead (thread deleted). Unlike close(), this survives
   * initialize(): a held reference in a writer that outlived deletion (hung
   * subagent, evicted-then-reused instance) must never reopen the db and
   * resurrect the just-deleted file. Gates every disk write, not just
   * initialize(), so a write loop that raced past the front check still can't
   * land a snapshot. */
  private retired = false

  /** Root checkpoints are for runtime state and recent fork boundaries. User-visible
   * transcript history lives in the main database, so checkpoint retention can stay small.
   * Non-root namespaces are internal/tool subgraphs and balloon sql.js DBs quickly. */
  private maxRootCheckpoints = 1
  private maxRootForkBoundaryCheckpoints = DEFAULT_MAX_ROOT_FORK_BOUNDARY_CHECKPOINTS
  private maxRootForkBoundaryBytes = DEFAULT_MAX_ROOT_FORK_BOUNDARY_BYTES
  private maxNonRootCheckpoints = 1
  private maxDatabaseBytes = DEFAULT_MAX_DB_SIZE_BYTES
  private maxOversizedRecoveryBytes = DEFAULT_MAX_OVERSIZED_RECOVERY_BYTES

  constructor(dbPath: string, serde?: SerializerProtocol, options: SqlJsSaverOptions = {}) {
    super(serde)
    this.dbPath = dbPath
    const legacyMax = options.maxCheckpointsPerNamespace
    this.maxRootCheckpoints = normalizePositiveInteger(
      options.maxRootCheckpoints ?? legacyMax,
      1
    )
    this.maxRootForkBoundaryCheckpoints = normalizeNonNegativeInteger(
      options.maxRootForkBoundaryCheckpoints,
      DEFAULT_MAX_ROOT_FORK_BOUNDARY_CHECKPOINTS
    )
    this.maxRootForkBoundaryBytes = normalizePositiveInteger(
      options.maxRootForkBoundaryBytes,
      DEFAULT_MAX_ROOT_FORK_BOUNDARY_BYTES
    )
    this.maxNonRootCheckpoints = normalizePositiveInteger(
      options.maxNonRootCheckpoints ?? legacyMax,
      1
    )
    this.maxDatabaseBytes = normalizePositiveInteger(
      options.maxDatabaseBytes,
      DEFAULT_MAX_DB_SIZE_BYTES
    )
    this.maxOversizedRecoveryBytes = Math.max(
      this.maxDatabaseBytes,
      normalizePositiveInteger(
        options.maxOversizedRecoveryBytes,
        DEFAULT_MAX_OVERSIZED_RECOVERY_BYTES
      )
    )
  }

  /**
   * Initialize the database asynchronously
   */
  async initialize(): Promise<void> {
    if (this.retired) {
      throw new Error(`[SqlJsSaver] Saver is retired (thread deleted): ${this.dbPath}`)
    }
    if (this.db) return
    // Reset in case this instance was previously closed (flush set the guard).
    this.blockAsyncWrite = false

    const SQL = await initSqlJs()

    const liveSize = sqliteFileSize(this.dbPath)
    const recoveryMaxBytes =
      liveSize && liveSize > this.maxDatabaseBytes
        ? this.maxOversizedRecoveryBytes
        : this.maxDatabaseBytes
    const recovered = await openRecoveredSqliteDatabase(SQL, this.dbPath, "SqlJsSaver", {
      maxBytes: recoveryMaxBytes
    })
    if (recovered.database) {
      this.db = recovered.database
    }

    const selectedSize = sqliteFileSize(this.dbPath)
    if (this.db && selectedSize && selectedSize > this.maxDatabaseBytes) {
      this.db.close()
      this.db = await this.tryCompactOversizedLiveDatabase(SQL, selectedSize)
      if (!this.db) this.backupOversizedLiveDatabase(selectedSize)
    } else if (!this.db && liveSize && liveSize > this.maxDatabaseBytes) {
      this.db = await this.tryCompactOversizedLiveDatabase(SQL, liveSize)
      if (!this.db) this.backupOversizedLiveDatabase(liveSize)
    }

    if (!this.db) {
      this.db = new SQL.Database()
    }

    await this.setup()
  }

  private retentionLimitForNamespace(checkpointNs: string): number {
    return checkpointNs === "" ? this.maxRootCheckpoints : this.maxNonRootCheckpoints
  }

  private migrateCheckpointTimestampColumn(database: SqlJsDatabase): void {
    const table = database.exec(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checkpoints'`
    )
    if (!table[0]?.values.length) return
    try {
      database.run(`ALTER TABLE checkpoints ADD COLUMN checkpoint_ts TEXT`)
    } catch {
      // Column already exists.
    }
    database.run(`UPDATE checkpoints SET checkpoint_ts = checkpoint_id WHERE checkpoint_ts IS NULL`)
  }

  private migrateCheckpointForkBoundaryColumn(database: SqlJsDatabase): void {
    const table = database.exec(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checkpoints'`
    )
    if (!table[0]?.values.length) return
    try {
      database.run(`ALTER TABLE checkpoints ADD COLUMN fork_boundary_marker INTEGER NOT NULL DEFAULT 0`)
    } catch {
      // Column already exists.
    }
    database.run(
      `UPDATE checkpoints
       SET fork_boundary_marker = 1
       WHERE fork_boundary_marker = 0 AND metadata LIKE '%cmb_fork_boundary%'`
    )
  }

  private async backfillCheckpointForkBoundaryMarkers(database: SqlJsDatabase): Promise<void> {
    const result = database.exec(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, type, metadata
       FROM checkpoints
       WHERE fork_boundary_marker = 0`
    )
    const rows = result[0]?.values ?? []
    if (rows.length === 0) return

    for (const row of rows) {
      try {
        const metadata = (await this.serde.loadsTyped(
          typeof row[3] === "string" ? row[3] : "json",
          row[4] as string | Uint8Array
        )) as CheckpointMetadata
        if (!checkpointMetadataHasForkBoundaryMarker(metadata)) continue
        database.run(
          `UPDATE checkpoints
           SET fork_boundary_marker = 1
           WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
          [String(row[0] ?? ""), String(row[1] ?? ""), String(row[2] ?? "")]
        )
      } catch (error) {
        console.warn("[SqlJsSaver] Failed to backfill checkpoint fork marker:", error)
      }
    }
  }

  private pruneAllCheckpointNamespaces(database: SqlJsDatabase): void {
    const namespaces = database.exec(
      `SELECT thread_id, checkpoint_ns FROM checkpoints GROUP BY thread_id, checkpoint_ns`
    )
    for (const row of namespaces[0]?.values ?? []) {
      const threadId = typeof row[0] === "string" ? row[0] : String(row[0] ?? "")
      const checkpointNs = typeof row[1] === "string" ? row[1] : String(row[1] ?? "")
      if (!threadId) continue
      this.pruneOldCheckpoints(threadId, checkpointNs, database)
    }
  }

  private async tryCompactOversizedLiveDatabase(
    SQL: Awaited<ReturnType<typeof initSqlJs>>,
    liveSize: number
  ): Promise<SqlJsDatabase | null> {
    if (liveSize > this.maxOversizedRecoveryBytes) {
      console.warn(
        `[SqlJsSaver] Database file is too large to compact safely ` +
          `(${Math.round(liveSize / 1024 / 1024)}MB).`
      )
      return null
    }

    let database: SqlJsDatabase | null = null
    try {
      database = new SQL.Database(readFileSync(this.dbPath))
      if (!isSqliteIntegrityOk(database)) {
        throw new Error("integrity_check failed")
      }

      this.migrateCheckpointTimestampColumn(database)
      this.migrateCheckpointForkBoundaryColumn(database)
      await this.backfillCheckpointForkBoundaryMarkers(database)
      this.pruneAllCheckpointNamespaces(database)
      database.run("VACUUM")

      await persistSqliteSnapshot(
        this.dbPath,
        Buffer.from(database.export()),
        "SqlJsSaver",
        { tmpSuffix: ".recovery.tmp" }
      )
      const nextSize = sqliteFileSize(this.dbPath)
      console.warn(
        `[SqlJsSaver] Compacted oversized database from ` +
          `${Math.round(liveSize / 1024 / 1024)}MB to ` +
          `${nextSize ? Math.round(nextSize / 1024 / 1024) : "unknown"}MB.`
      )
      return database
    } catch (error) {
      database?.close()
      console.warn("[SqlJsSaver] Failed to compact oversized database:", error)
      return null
    }
  }

  private backupOversizedLiveDatabase(liveSize: number): void {
    console.warn(
      `[SqlJsSaver] Database file is too large (${Math.round(liveSize / 1024 / 1024)}MB). ` +
        `Creating fresh database to prevent memory issues.`
    )
    const backupPath = this.dbPath + ".bak." + Date.now()
    try {
      renameSync(this.dbPath, backupPath)
      console.log(`[SqlJsSaver] Old database backed up to: ${backupPath}`)
    } catch (e) {
      console.warn("[SqlJsSaver] Could not backup old database:", e)
      try {
        unlinkSync(this.dbPath)
      } catch (e2) {
        console.error("[SqlJsSaver] Could not delete old database:", e2)
      }
    }
  }

  private async setup(): Promise<void> {
    if (this.isSetup || !this.db) return

    // Create tables
    this.db.run(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint TEXT,
        metadata TEXT,
        checkpoint_ts TEXT,
        fork_boundary_marker INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )
    `)

    this.migrateCheckpointTimestampColumn(this.db)
    this.migrateCheckpointForkBoundaryColumn(this.db)
    await this.backfillCheckpointForkBoundaryMarkers(this.db)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value TEXT,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )
    `)

    this.isSetup = true
    this.saveToDisk()
  }

  /**
   * Delete old checkpoints (and their writes) beyond the retention limit.
   * Keeps the most recent N checkpoints per (thread_id, checkpoint_ns).
   */
  private pruneOldCheckpoints(
    threadId: string,
    checkpointNs: string,
    database: SqlJsDatabase | null = this.db
  ): void {
    if (!database) return
    if (checkpointNs === "") {
      this.pruneRootCheckpoints(threadId, database)
      return
    }

    const limit = this.retentionLimitForNamespace(checkpointNs)
    const countResult = database.exec(
      `SELECT COUNT(*) FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?`,
      [threadId, checkpointNs]
    )
    const total = countResult[0]?.values[0]?.[0] as number
    if (total <= limit) return

    try {
      database.run("BEGIN")

      database.run(
        `DELETE FROM writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id IN (
          SELECT checkpoint_id FROM checkpoints
          WHERE thread_id = ? AND checkpoint_ns = ?
          ORDER BY COALESCE(checkpoint_ts, checkpoint_id) DESC, checkpoint_id DESC
          LIMIT -1 OFFSET ?
        )`,
        [threadId, checkpointNs, threadId, checkpointNs, limit]
      )

      database.run(
        `DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id NOT IN (
          SELECT checkpoint_id FROM checkpoints
          WHERE thread_id = ? AND checkpoint_ns = ?
          ORDER BY COALESCE(checkpoint_ts, checkpoint_id) DESC, checkpoint_id DESC
          LIMIT ?
        )`,
        [threadId, checkpointNs, threadId, checkpointNs, limit]
      )

      database.run("COMMIT")
    } catch (e) {
      database.run("ROLLBACK")
      console.warn("[SqlJsSaver] Failed to prune old checkpoints:", e)
    }
  }

  private pruneRootCheckpoints(threadId: string, database: SqlJsDatabase): void {
    const result = database.exec(
      `SELECT checkpoint_id,
              fork_boundary_marker,
              LENGTH(COALESCE(checkpoint, '')) + LENGTH(COALESCE(metadata, '')) AS payload_bytes
       FROM checkpoints
       WHERE thread_id = ? AND checkpoint_ns = ''
       ORDER BY COALESCE(checkpoint_ts, checkpoint_id) DESC, checkpoint_id DESC`,
      [threadId]
    )
    const rows = (result[0]?.values ?? []).map((row) => ({
      checkpoint_id: typeof row[0] === "string" ? row[0] : String(row[0] ?? ""),
      fork_boundary_marker: typeof row[1] === "number" ? row[1] : Number(row[1] ?? 0),
      payload_bytes: typeof row[2] === "number" ? row[2] : Number(row[2] ?? 0)
    })) as RootCheckpointRetentionRow[]
    if (rows.length <= this.maxRootCheckpoints) return

    const keepIds = new Set<string>()
    for (const row of rows.slice(0, this.maxRootCheckpoints)) {
      if (row.checkpoint_id) keepIds.add(row.checkpoint_id)
    }

    const hasAnyForkBoundary = rows.some((row) => row.fork_boundary_marker === 1)
    let seenForkBoundary = false
    let archivedCount = 0
    let archivedBytes = 0

    for (const row of rows.slice(this.maxRootCheckpoints)) {
      const isForkBoundary = row.fork_boundary_marker === 1
      const isLegacyCandidate = !isForkBoundary && (!hasAnyForkBoundary || seenForkBoundary)
      if (isForkBoundary || isLegacyCandidate) {
        const nextBytes = archivedBytes + Math.max(0, row.payload_bytes)
        if (
          archivedCount < this.maxRootForkBoundaryCheckpoints &&
          nextBytes <= this.maxRootForkBoundaryBytes
        ) {
          keepIds.add(row.checkpoint_id)
          archivedCount += 1
          archivedBytes = nextBytes
        }
      }
      if (isForkBoundary) seenForkBoundary = true
    }

    if (keepIds.size >= rows.length) return
    const placeholders = Array.from(keepIds, () => "?").join(", ")
    const params = [threadId, ...keepIds]

    try {
      database.run("BEGIN")

      database.run(
        `DELETE FROM writes
         WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id NOT IN (${placeholders})`,
        params
      )

      database.run(
        `DELETE FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id NOT IN (${placeholders})`,
        params
      )

      database.run("COMMIT")
    } catch (e) {
      database.run("ROLLBACK")
      console.warn("[SqlJsSaver] Failed to prune old root checkpoints:", e)
    }
  }

  /**
   * Atomically persist the current snapshot off the main thread: export()
   * snapshots synchronously, then bytes are written to a temp file and renamed
   * into place (atomic — a crash mid-write can't truncate the live DB). Loops if
   * more checkpoints arrived while writing.
   */
  private async runSaveLoop(): Promise<void> {
    while (this.db && this.dirty && !this.blockAsyncWrite && !this.retired) {
      this.dirty = false
      try {
        const data = Buffer.from(this.db.export())
        await persistSqliteSnapshot(this.dbPath, data, "SqlJsSaver")
        // flush() took over while this save was in flight; re-mark dirty and let
        // flush write the authoritative final snapshot after this save settles.
        if (this.blockAsyncWrite) {
          this.dirty = true
          return
        }
      } catch (e) {
        this.dirty = true
        console.warn("[SqlJsSaver] async save failed, will retry on next change:", e)
        break
      }
    }
  }

  /**
   * Save database to disk (debounced, async, atomic)
   */
  private saveToDisk(): void {
    if (!this.db || this.retired) return

    this.dirty = true

    // Debounce saves to avoid excessive disk writes
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (!this.savePromise) {
        this.savePromise = this.runSaveLoop().finally(() => {
          this.savePromise = null
        })
      }
    }, CHECKPOINT_SAVE_DEBOUNCE_MS)
    // Don't keep the event loop alive solely for a pending background save;
    // orderly shutdown explicitly awaits close().
    this.saveTimer.unref?.()
  }

  private async drainSaves(
    keepBlocked: boolean
  ): Promise<unknown | null> {
    let failure: unknown
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.db) return null
    this.blockAsyncWrite = true
    try {
      const pendingSave = this.savePromise
      if (pendingSave) await pendingSave

      // Mutations can land while an earlier async write is settling. Continue
      // until the latest in-memory state has reached disk. A retired saver
      // skips the final flush entirely — its file is about to be deleted.
      while (this.db && this.dirty && !this.retired) {
        this.dirty = false
        const data = Buffer.from(this.db.export())
        await persistSqliteSnapshot(this.dbPath, data, "SqlJsSaver")
      }
    } catch (e) {
      this.dirty = true
      failure = e
      console.warn("[SqlJsSaver] flush write failed:", e)
    } finally {
      if (!keepBlocked) {
        this.blockAsyncWrite = false
        if (this.db && this.dirty) this.saveToDisk()
      }
    }
    return failure ?? null
  }

  /**
   * Force an immediate durable save without blocking the Electron main thread.
   */
  private ensureFlushDrain(): Promise<unknown | null> {
    if (this.flushPromise) return this.flushPromise

    const flushPromise = this.drainSaves(false).finally(() => {
      if (this.flushPromise === flushPromise) {
        this.flushPromise = null
      }
    })
    this.flushPromise = flushPromise
    return flushPromise
  }

  async flush(): Promise<void> {
    if (this.closePromise) {
      try {
        await this.closePromise
      } catch {
        // close already reported the persistence failure
      }
      return
    }
    await this.ensureFlushDrain()
  }

  async flushStrict(): Promise<void> {
    if (this.closePromise) await this.closePromise
    while (this.flushPromise) {
      await this.flushPromise
    }
    const failure = await this.ensureFlushDrain()
    if (failure) throw failure
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")

    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {}

    let sql: string
    let params: (string | undefined)[]

    if (checkpoint_id) {
      sql = `
        SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
        FROM checkpoints
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
      `
      params = [thread_id, checkpoint_ns, checkpoint_id]
    } else {
      sql = `
        SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
        FROM checkpoints
        WHERE thread_id = ? AND checkpoint_ns = ?
        ORDER BY COALESCE(checkpoint_ts, checkpoint_id) DESC, checkpoint_id DESC
        LIMIT 1
      `
      params = [thread_id, checkpoint_ns]
    }

    const stmt = this.db.prepare(sql)
    stmt.bind(params.filter((p) => p !== undefined))

    if (!stmt.step()) {
      stmt.free()
      return undefined
    }

    const row = stmt.getAsObject() as unknown as CheckpointRow
    stmt.free()

    // Get pending writes
    const writesStmt = this.db.prepare(`
      SELECT task_id, channel, type, value
      FROM writes
      WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
    `)
    writesStmt.bind([row.thread_id, row.checkpoint_ns, row.checkpoint_id])

    const pendingWrites: [string, string, unknown][] = []
    while (writesStmt.step()) {
      const write = writesStmt.getAsObject() as unknown as WriteRow
      const value = await this.serde.loadsTyped(write.type ?? "json", write.value ?? "")
      pendingWrites.push([write.task_id, write.channel, value])
    }
    writesStmt.free()

    const checkpoint = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint
    )) as Checkpoint

    const finalConfig = checkpoint_id
      ? config
      : {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id
          }
        }

    return {
      checkpoint,
      config: finalConfig,
      metadata: (await this.serde.loadsTyped(
        row.type ?? "json",
        row.metadata
      )) as CheckpointMetadata,
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id
            }
          }
        : undefined,
      pendingWrites
    }
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")

    const { limit, before } = options ?? {}
    const thread_id = config.configurable?.thread_id
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? ""

    let sql = `
      SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
      FROM checkpoints
      WHERE thread_id = ? AND checkpoint_ns = ?
    `
    const params: string[] = [thread_id, checkpoint_ns]

    if (before?.configurable?.checkpoint_id) {
      const beforeStmt = this.db.prepare(`
        SELECT COALESCE(checkpoint_ts, checkpoint_id) AS checkpoint_sort_key
        FROM checkpoints
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
      `)
      beforeStmt.bind([thread_id, checkpoint_ns, before.configurable.checkpoint_id])
      if (!beforeStmt.step()) {
        beforeStmt.free()
        return
      }
      const beforeRow = beforeStmt.getAsObject() as { checkpoint_sort_key?: string | null }
      beforeStmt.free()
      const beforeSortKey = beforeRow.checkpoint_sort_key ?? before.configurable.checkpoint_id
      sql += ` AND (
        COALESCE(checkpoint_ts, checkpoint_id) < ?
        OR (COALESCE(checkpoint_ts, checkpoint_id) = ? AND checkpoint_id < ?)
      )`
      params.push(beforeSortKey, beforeSortKey, before.configurable.checkpoint_id)
    }

    sql += ` ORDER BY COALESCE(checkpoint_ts, checkpoint_id) DESC, checkpoint_id DESC`

    if (limit) {
      sql += ` LIMIT ${parseInt(String(limit), 10)}`
    }

    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params)

      while (stmt.step()) {
        const row = stmt.getAsObject() as unknown as CheckpointRow

        // Get pending writes for this checkpoint
        const writesStmt = this.db.prepare(`
          SELECT task_id, channel, type, value
          FROM writes
          WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
        `)
        writesStmt.bind([row.thread_id, row.checkpoint_ns, row.checkpoint_id])

        const pendingWrites: [string, string, unknown][] = []
        try {
          while (writesStmt.step()) {
            const write = writesStmt.getAsObject() as unknown as WriteRow
            const value = await this.serde.loadsTyped(write.type ?? "json", write.value ?? "")
            pendingWrites.push([write.task_id, write.channel, value])
          }
        } finally {
          writesStmt.free()
        }

        const checkpoint = (await this.serde.loadsTyped(
          row.type ?? "json",
          row.checkpoint
        )) as Checkpoint

        yield {
          config: {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns,
              checkpoint_id: row.checkpoint_id
            }
          },
          checkpoint,
          metadata: (await this.serde.loadsTyped(
            row.type ?? "json",
            row.metadata
          )) as CheckpointMetadata,
          parentConfig: row.parent_checkpoint_id
            ? {
                configurable: {
                  thread_id: row.thread_id,
                  checkpoint_ns: row.checkpoint_ns,
                  checkpoint_id: row.parent_checkpoint_id
                }
              }
            : undefined,
          pendingWrites
        }
      }
    } finally {
      stmt.free()
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.")
    }

    const thread_id = config.configurable?.thread_id
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? ""
    const parent_checkpoint_id = config.configurable?.checkpoint_id

    if (!thread_id) {
      throw new Error('Missing "thread_id" field in passed "config.configurable".')
    }

    const preparedCheckpoint = copyCheckpoint(checkpoint)

    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata)
    ])

    if (type1 !== type2) {
      throw new Error("Failed to serialize checkpoint and metadata to the same type.")
    }

    const checkpointTs =
      typeof preparedCheckpoint.ts === "string" ? preparedCheckpoint.ts : preparedCheckpoint.id
    const forkBoundaryMarker = checkpointMetadataHasForkBoundaryMarker(metadata) ? 1 : 0

    this.db.run(
      `INSERT OR REPLACE INTO checkpoints 
       (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata, checkpoint_ts, fork_boundary_marker)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        thread_id,
        checkpoint_ns,
        checkpoint.id,
        parent_checkpoint_id ?? null,
        type1,
        serializedCheckpoint,
        serializedMetadata,
        checkpointTs,
        forkBoundaryMarker
      ]
    )

    this.pruneOldCheckpoints(thread_id, checkpoint_ns)
    this.saveToDisk()

    return {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id
      }
    }
  }

  async updateCheckpointMetadata(
    config: RunnableConfig,
    updater: (metadata: CheckpointMetadata) => CheckpointMetadata
  ): Promise<CheckpointMetadata | undefined> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.")
    }

    const thread_id = config.configurable.thread_id
    const checkpoint_ns = config.configurable.checkpoint_ns ?? ""
    const checkpoint_id = config.configurable.checkpoint_id

    if (!thread_id) {
      throw new Error('Missing "thread_id" field in passed "config.configurable".')
    }

    let sql: string
    let params: unknown[]

    if (checkpoint_id) {
      sql = `
        SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
        FROM checkpoints
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
      `
      params = [thread_id, checkpoint_ns, checkpoint_id]
    } else {
      sql = `
        SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
        FROM checkpoints
        WHERE thread_id = ? AND checkpoint_ns = ?
        ORDER BY COALESCE(checkpoint_ts, checkpoint_id) DESC, checkpoint_id DESC
        LIMIT 1
      `
      params = [thread_id, checkpoint_ns]
    }

    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    if (!stmt.step()) {
      stmt.free()
      return undefined
    }
    const row = stmt.getAsObject() as unknown as CheckpointRow
    stmt.free()

    const currentMetadata = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.metadata
    )) as CheckpointMetadata
    const nextMetadata = updater(currentMetadata)
    const [metadataType, serializedMetadata] = await this.serde.dumpsTyped(nextMetadata)
    if (metadataType !== (row.type ?? "json")) {
      throw new Error("Failed to serialize updated checkpoint metadata to the existing type.")
    }

    this.db.run(
      `UPDATE checkpoints
       SET metadata = ?, fork_boundary_marker = ?
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
      [
        serializedMetadata,
        checkpointMetadataHasForkBoundaryMarker(nextMetadata) ? 1 : 0,
        row.thread_id,
        row.checkpoint_ns,
        row.checkpoint_id
      ]
    )
    this.saveToDisk()
    return nextMetadata
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.")
    }

    if (!config.configurable?.thread_id) {
      throw new Error("Missing thread_id field in config.configurable.")
    }

    if (!config.configurable?.checkpoint_id) {
      throw new Error("Missing checkpoint_id field in config.configurable.")
    }

    for (let idx = 0; idx < writes.length; idx++) {
      const write = writes[idx]
      const [type, serializedWrite] = await this.serde.dumpsTyped(write[1])

      this.db.run(
        `INSERT OR REPLACE INTO writes 
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          config.configurable.thread_id,
          config.configurable.checkpoint_ns ?? "",
          config.configurable.checkpoint_id,
          taskId,
          idx,
          write[0],
          type,
          serializedWrite
        ]
      )
    }

    this.saveToDisk()
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")

    this.db.run(`DELETE FROM checkpoints WHERE thread_id = ?`, [threadId])
    this.db.run(`DELETE FROM writes WHERE thread_id = ?`, [threadId])

    this.saveToDisk()
  }

  /**
   * Permanently close for thread deletion. Unlike close() (reusable shutdown:
   * flushes pending state, and a later initialize() may legitimately reopen),
   * retire() poisons the instance first — in-flight writes are awaited, the
   * final flush is skipped (the file is about to be deleted), and every future
   * initialize()/save is refused. Call this, not close(), whenever the backing
   * file is being removed from disk.
   */
  async retire(): Promise<void> {
    this.retired = true
    await this.close()
  }

  /**
   * Close the database and save any pending changes
   */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = (async () => {
      const pendingFlush = this.flushPromise
      if (pendingFlush) await pendingFlush
      await this.drainSaves(true)
      if (this.db) {
        this.db.close()
        this.db = null
      }
    })().finally(() => {
      this.closePromise = null
    })
    return this.closePromise
  }
}
