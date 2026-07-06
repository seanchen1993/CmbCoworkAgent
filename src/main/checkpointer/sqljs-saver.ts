import initSqlJs, { Database as SqlJsDatabase } from "sql.js"
import { renameSync, unlinkSync } from "fs"
import {
  openRecoveredSqliteDatabase,
  persistSqliteSnapshot,
  sqliteFileSize
} from "../utils/sqlite-durable-file"

// Debounce window for background checkpoint saves. Checkpoints are written very
// frequently during a streaming agent run; coalescing keeps the synchronous
// db.export() snapshot off the hot path while the disk write runs async.
const CHECKPOINT_SAVE_DEBOUNCE_MS = 300
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
  metadata: string
  checkpoint_ts?: string | null
}

interface WriteRow {
  task_id: string
  channel: string
  type: string | null
  value: string
}

export interface SqlJsSaverOptions {
  maxCheckpointsPerNamespace?: number
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
  private flushPromise: Promise<void> | null = null
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

  /** Max checkpoints to keep per (thread_id, checkpoint_ns). Older ones are pruned on each put().
   * Kept at 1 because sql.js loads the entire DB file into memory — retaining more checkpoints
   * increases memory usage without benefit since we don't use LangGraph's time-travel feature. */
  private maxCheckpointsPerNamespace = 1

  constructor(dbPath: string, serde?: SerializerProtocol, options: SqlJsSaverOptions = {}) {
    super(serde)
    this.dbPath = dbPath
    const maxCheckpoints = options.maxCheckpointsPerNamespace ?? 1
    this.maxCheckpointsPerNamespace = Math.max(1, Math.floor(maxCheckpoints))
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

    const MAX_DB_SIZE = 100 * 1024 * 1024 // 100MB limit
    const recovered = await openRecoveredSqliteDatabase(SQL, this.dbPath, "SqlJsSaver", {
      maxBytes: MAX_DB_SIZE
    })
    if (recovered.database) {
      this.db = recovered.database
    } else {
      const liveSize = sqliteFileSize(this.dbPath)
      if (liveSize && liveSize > MAX_DB_SIZE) {
        console.warn(
          `[SqlJsSaver] Database file is too large (${Math.round(liveSize / 1024 / 1024)}MB). ` +
            `Creating fresh database to prevent memory issues.`
        )
        // Rename the old file for backup
        const backupPath = this.dbPath + ".bak." + Date.now()
        try {
          renameSync(this.dbPath, backupPath)
          console.log(`[SqlJsSaver] Old database backed up to: ${backupPath}`)
        } catch (e) {
          console.warn("[SqlJsSaver] Could not backup old database:", e)
          // Try to delete instead
          try {
            unlinkSync(this.dbPath)
          } catch (e2) {
            console.error("[SqlJsSaver] Could not delete old database:", e2)
          }
        }
      }
      this.db = new SQL.Database()
    }

    this.setup()
  }

  private setup(): void {
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
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )
    `)

    try {
      this.db.run(`ALTER TABLE checkpoints ADD COLUMN checkpoint_ts TEXT`)
    } catch {
      // Column already exists.
    }
    this.db.run(`UPDATE checkpoints SET checkpoint_ts = checkpoint_id WHERE checkpoint_ts IS NULL`)

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
  private pruneOldCheckpoints(threadId: string, checkpointNs: string): void {
    if (!this.db) return

    const limit = this.maxCheckpointsPerNamespace
    const countResult = this.db.exec(
      `SELECT COUNT(*) FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?`,
      [threadId, checkpointNs]
    )
    const total = countResult[0]?.values[0]?.[0] as number
    if (total <= limit) return

    try {
      this.db.run("BEGIN")

      this.db.run(
        `DELETE FROM writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id IN (
          SELECT checkpoint_id FROM checkpoints
          WHERE thread_id = ? AND checkpoint_ns = ?
          ORDER BY COALESCE(checkpoint_ts, checkpoint_id) DESC, checkpoint_id DESC
          LIMIT -1 OFFSET ?
        )`,
        [threadId, checkpointNs, threadId, checkpointNs, limit]
      )

      this.db.run(
        `DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id NOT IN (
          SELECT checkpoint_id FROM checkpoints
          WHERE thread_id = ? AND checkpoint_ns = ?
          ORDER BY COALESCE(checkpoint_ts, checkpoint_id) DESC, checkpoint_id DESC
          LIMIT ?
        )`,
        [threadId, checkpointNs, threadId, checkpointNs, limit]
      )

      this.db.run("COMMIT")
    } catch (e) {
      this.db.run("ROLLBACK")
      console.warn("[SqlJsSaver] Failed to prune old checkpoints:", e)
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

  private async drainSaves(keepBlocked: boolean): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.db) return
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
      console.warn("[SqlJsSaver] flush write failed:", e)
    } finally {
      if (!keepBlocked) {
        this.blockAsyncWrite = false
        if (this.db && this.dirty) this.saveToDisk()
      }
    }
  }

  /**
   * Force an immediate durable save without blocking the Electron main thread.
   */
  async flush(): Promise<void> {
    if (this.closePromise) {
      try {
        await this.closePromise
      } catch {
        // close already reported the persistence failure
      }
      return
    }
    if (this.flushPromise) return this.flushPromise

    this.flushPromise = this.drainSaves(false).finally(() => {
      this.flushPromise = null
    })
    return this.flushPromise
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
      sql += ` AND checkpoint_id < ?`
      params.push(before.configurable.checkpoint_id)
    }

    sql += ` ORDER BY COALESCE(checkpoint_ts, checkpoint_id) DESC, checkpoint_id DESC`

    if (limit) {
      sql += ` LIMIT ${parseInt(String(limit), 10)}`
    }

    const stmt = this.db.prepare(sql)
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

    stmt.free()
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

    this.db.run(
      `INSERT OR REPLACE INTO checkpoints 
       (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata, checkpoint_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        thread_id,
        checkpoint_ns,
        checkpoint.id,
        parent_checkpoint_id ?? null,
        type1,
        serializedCheckpoint,
        serializedMetadata,
        checkpointTs
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
       SET metadata = ?
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
      [serializedMetadata, row.thread_id, row.checkpoint_ns, row.checkpoint_id]
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
