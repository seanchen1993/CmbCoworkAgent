import {
  NativeSqliteAdapter,
  openNativeSqliteDatabase
} from "../db/native-sqlite-adapter"
import { sqliteFileSize } from "../utils/sqlite-durable-file"

const DEFAULT_MAX_DB_SIZE_BYTES = 100 * 1024 * 1024
const DEFAULT_MAX_ROOT_FORK_BOUNDARY_CHECKPOINTS = 0
const DEFAULT_MAX_ROOT_FORK_BOUNDARY_BYTES = 48 * 1024 * 1024
const MAX_CHECKPOINT_MESSAGE_SNAPSHOT_DEPTH = 128
const MAX_CHECKPOINT_MESSAGE_DELTA_BYTES = 8 * 1024 * 1024
const MESSAGE_SNAPSHOT_DELETE_BATCH_SIZE = 400
const MESSAGE_PREFIX_SENTINEL_COUNT = 24
const MESSAGE_PREFIX_TAIL_WINDOW = 16
const MESSAGE_PREFIX_MIN_SHARED_TAIL = 4
const CHECKPOINT_SCHEMA_MIGRATION_ID = "checkpoint-columns-and-fork-boundary-v1"
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
  checkpoint: string | Uint8Array
  metadata: string | Uint8Array
  checkpoint_ts?: string | null
  fork_boundary_marker?: number | null
}

interface CheckpointMessageSnapshotRow {
  checkpoint_id: string
  parent_checkpoint_id: string | null
  prefix_length: number
  message_count: number
  type: string | null
  suffix: string | Uint8Array
}

interface CheckpointMessageWriteState {
  checkpointId: string
  messages: unknown[]
  messageCount: number
  prefixSentinels: CheckpointMessageSentinel[]
  tailSentinels: CheckpointMessageSentinel[]
  hasExternalSnapshot: boolean
  snapshotDepth: number
  deltaBytes: number
}

interface CheckpointMessageSentinel {
  index: number
  value: unknown
}

interface HydratedCheckpointMessages {
  messages: unknown[]
  snapshotDepth: number
  deltaBytes: number
}

const EXTERNAL_MESSAGES_MARKER = "__cmb_sqljs_external_messages_v1"
const MAX_HYDRATED_MESSAGE_SNAPSHOTS = 8

interface ExternalMessagesReference {
  [EXTERNAL_MESSAGES_MARKER]: true
  messageCount: number
}

function buildExternalMessagesReference(messageCount: number): ExternalMessagesReference {
  return {
    [EXTERNAL_MESSAGES_MARKER]: true,
    messageCount
  }
}

function isExternalMessagesReference(value: unknown): value is ExternalMessagesReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<ExternalMessagesReference>
  return candidate[EXTERNAL_MESSAGES_MARKER] === true && Number.isInteger(candidate.messageCount)
}

function checkpointMessageCacheKey(
  threadId: string,
  checkpointNs: string,
  checkpointId: string
): string {
  return `${threadId}\u0000${checkpointNs}\u0000${checkpointId}`
}

function checkpointMessageNamespaceKey(threadId: string, checkpointNs: string): string {
  return `${threadId}\u0000${checkpointNs}`
}

function captureCheckpointMessageSentinels(messages: unknown[]): {
  messageCount: number
  prefixSentinels: CheckpointMessageSentinel[]
  tailSentinels: CheckpointMessageSentinel[]
} {
  const messageCount = messages.length
  const tailStart = Math.max(0, messageCount - MESSAGE_PREFIX_TAIL_WINDOW)
  const prefixSentinels: CheckpointMessageSentinel[] = []
  if (tailStart > 0) {
    const sentinelCount = Math.min(MESSAGE_PREFIX_SENTINEL_COUNT, tailStart)
    const indices = new Set<number>()
    for (let offset = 0; offset < sentinelCount; offset += 1) {
      const index =
        sentinelCount === 1
          ? 0
          : Math.floor((offset * (tailStart - 1)) / (sentinelCount - 1))
      indices.add(index)
    }
    for (const index of indices) prefixSentinels.push({ index, value: messages[index] })
  }

  const tailSentinels: CheckpointMessageSentinel[] = []
  for (let index = tailStart; index < messageCount; index += 1) {
    tailSentinels.push({ index, value: messages[index] })
  }
  return { messageCount, prefixSentinels, tailSentinels }
}

/**
 * Return a trusted common prefix for the append/replace-tail shapes emitted by
 * LangGraph's messages reducer. Distributed sentinels guard the stable history,
 * while the final window identifies an exact changed suffix without rescanning
 * a long transcript. Shapes that do not prove that structural sharing fall
 * back to the exact reference scan below.
 */
function trustedMessageReferencePrefix(
  previous: CheckpointMessageWriteState,
  next: unknown[]
): number | null {
  const previousCount = previous.messageCount
  if (previousCount === 0) return 0
  if (next.length < previousCount) return null

  for (const sentinel of previous.prefixSentinels) {
    if (next[sentinel.index] !== sentinel.value) {
      // If the same array was mutated in place, it no longer contains the
      // persisted prefix needed by the exact fallback. Rebase safely instead.
      return next === previous.messages ? 0 : null
    }
  }

  let sharedTail = 0
  for (const sentinel of previous.tailSentinels) {
    if (next[sentinel.index] !== sentinel.value) {
      return sharedTail >= Math.min(MESSAGE_PREFIX_MIN_SHARED_TAIL, sentinel.index)
        ? sentinel.index
        : next === previous.messages
          ? 0
          : null
    }
    sharedTail += 1
  }

  if (next === previous.messages || next.length > previousCount) return previousCount
  // A cloned, equal-length array could contain an unsampled replacement in the
  // middle. Treat it as ambiguous and retain the exact fallback.
  return null
}

function commonMessageReferencePrefix(
  previous: CheckpointMessageWriteState,
  next: unknown[]
): number {
  const trustedPrefix = trustedMessageReferencePrefix(previous, next)
  if (trustedPrefix !== null) return trustedPrefix
  if (previous.messages.length !== previous.messageCount) return 0

  const limit = Math.min(previous.messageCount, next.length)
  let index = 0
  while (index < limit && previous.messages[index] === next[index]) index += 1
  return index
}

function serializedPayloadBytes(payload: string | Uint8Array): number {
  return typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.byteLength
}

interface CheckpointMessageChunk {
  messages: unknown[]
  start: number
  end: number
}

function truncateCheckpointMessageChunks(
  chunks: CheckpointMessageChunk[],
  currentLength: number,
  length: number
): void {
  let retainedLength = currentLength
  while (retainedLength > length) {
    const chunk = chunks.at(-1)
    if (!chunk) break
    const chunkLength = chunk.end - chunk.start
    const removeCount = Math.min(chunkLength, retainedLength - length)
    chunk.end -= removeCount
    retainedLength -= removeCount
    if (chunk.start === chunk.end) chunks.pop()
  }
}

function materializeCheckpointMessageChunks(
  chunks: readonly CheckpointMessageChunk[],
  messageCount: number
): unknown[] {
  const messages = new Array<unknown>(messageCount)
  let outputIndex = 0
  for (const chunk of chunks) {
    for (let sourceIndex = chunk.start; sourceIndex < chunk.end; sourceIndex += 1) {
      messages[outputIndex] = chunk.messages[sourceIndex]
      outputIndex += 1
    }
  }
  if (outputIndex !== messageCount) {
    throw new Error("[SqlJsSaver] Checkpoint message chunk count mismatch")
  }
  return messages
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
  /** @deprecated Native SQLite no longer loads the whole file into memory. */
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

/**
 * SQLite checkpointer. The historical class name remains part of the public API,
 * while persistence is backed by Electron's bundled node:sqlite implementation.
 */
export class SqlJsSaver extends BaseCheckpointSaver {
  private db: NativeSqliteAdapter | null = null
  private dbPath: string
  private isSetup = false
  private initializePromise: Promise<void> | null = null
  private flushPromise: Promise<unknown | null> | null = null
  private closePromise: Promise<void> | null = null
  /** Permanently dead (thread deleted). Unlike close(), this survives
   * initialize(): a held reference in a writer that outlived deletion (hung
   * subagent, evicted-then-reused instance) must never reopen the db and
   * resurrect the just-deleted file. */
  private retired = false
  /** The active graph keeps message object references stable across checkpoints. Comparing
   * those references lets put() serialize only the changed suffix without touching content
   * from a long, already-persisted transcript. */
  private checkpointMessageWriteStates = new Map<string, CheckpointMessageWriteState>()
  /** Small read-through cache for reconstructing delta-backed checkpoints. The runtime normally
   * needs only the latest snapshot; the bound also prevents fork-history inspection retaining
   * every transcript in a long-lived saver. */
  private hydratedCheckpointMessages = new Map<string, HydratedCheckpointMessages>()

  /** Root checkpoints are for runtime state and recent fork boundaries. User-visible
   * transcript history lives in the main database, so checkpoint retention can stay small.
   * Non-root namespaces are internal/tool subgraphs and can still grow quickly. */
  private maxRootCheckpoints = 1
  private maxRootForkBoundaryCheckpoints = DEFAULT_MAX_ROOT_FORK_BOUNDARY_CHECKPOINTS
  private maxRootForkBoundaryBytes = DEFAULT_MAX_ROOT_FORK_BOUNDARY_BYTES
  private maxNonRootCheckpoints = 1
  private maxDatabaseBytes = DEFAULT_MAX_DB_SIZE_BYTES

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
  }

  /**
   * Initialize the database asynchronously
   */
  async initialize(): Promise<void> {
    if (this.retired) {
      throw new Error(`[SqlJsSaver] Saver is retired (thread deleted): ${this.dbPath}`)
    }
    if (this.db && !this.closePromise) return
    if (this.initializePromise) {
      await this.initializePromise
      if (this.closePromise) await this.closePromise
      if (!this.db) return this.initialize()
      return
    }
    if (this.closePromise) await this.closePromise

    const initializePromise = (async () => {
      if (this.retired) {
        throw new Error(`[SqlJsSaver] Saver is retired (thread deleted): ${this.dbPath}`)
      }

      const { database } = openNativeSqliteDatabase(this.dbPath, "SqlJsSaver")
      this.db = database
      this.isSetup = false
      try {
        await this.setup()
        if (this.retired) {
          throw new Error(`[SqlJsSaver] Saver is retired (thread deleted): ${this.dbPath}`)
        }
        const liveSize = sqliteFileSize(this.dbPath)
        if (liveSize && liveSize > this.maxDatabaseBytes) {
          this.compactOversizedLiveDatabase(database, liveSize)
        }
      } catch (error) {
        if (this.db === database) {
          this.db = null
          this.isSetup = false
        }
        database.close({ checkpoint: false })
        throw error
      }
    })().finally(() => {
      if (this.initializePromise === initializePromise) this.initializePromise = null
    })
    this.initializePromise = initializePromise
    return initializePromise
  }

  private retentionLimitForNamespace(checkpointNs: string): number {
    return checkpointNs === "" ? this.maxRootCheckpoints : this.maxNonRootCheckpoints
  }

  private async backfillCheckpointForkBoundaryMarkers(
    database: NativeSqliteAdapter
  ): Promise<void> {
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

  /**
   * Schema upgrades and the legacy metadata decode are cold, one-time work.
   * Keep the marker in the same transaction as the data changes so a crash can
   * only expose either the complete migration or an empty marker that retries.
   */
  private async migrateCheckpointSchemaOnce(database: NativeSqliteAdapter): Promise<void> {
    database.run(`
      CREATE TABLE IF NOT EXISTS checkpoint_schema_migrations (
        migration_id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `)
    const applied = database.exec(
      `SELECT 1 FROM checkpoint_schema_migrations WHERE migration_id = ? LIMIT 1`,
      [CHECKPOINT_SCHEMA_MIGRATION_ID]
    )
    if (applied[0]?.values.length) return

    database.run("BEGIN")
    try {
      const tableInfo = database.exec("PRAGMA table_info(checkpoints)")
      const columns = new Set(
        (tableInfo[0]?.values ?? []).map((row) => String(row[1] ?? ""))
      )
      if (!columns.has("checkpoint_ts")) {
        database.run(`ALTER TABLE checkpoints ADD COLUMN checkpoint_ts TEXT`)
      }
      if (!columns.has("fork_boundary_marker")) {
        database.run(
          `ALTER TABLE checkpoints
           ADD COLUMN fork_boundary_marker INTEGER NOT NULL DEFAULT 0`
        )
      }
      database.run(
        `UPDATE checkpoints SET checkpoint_ts = checkpoint_id WHERE checkpoint_ts IS NULL`
      )
      database.run(
        `UPDATE checkpoints
         SET fork_boundary_marker = 1
         WHERE fork_boundary_marker = 0 AND metadata LIKE '%cmb_fork_boundary%'`
      )
      await this.backfillCheckpointForkBoundaryMarkers(database)
      database.run(
        `INSERT INTO checkpoint_schema_migrations (migration_id, applied_at) VALUES (?, ?)`,
        [CHECKPOINT_SCHEMA_MIGRATION_ID, Date.now()]
      )
      database.run("COMMIT")
    } catch (error) {
      try {
        database.run("ROLLBACK")
      } catch {
        // Preserve the migration error.
      }
      throw error
    }
  }

  private pruneAllCheckpointNamespaces(database: NativeSqliteAdapter): void {
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

  private compactOversizedLiveDatabase(
    database: NativeSqliteAdapter,
    liveSize: number
  ): void {
    try {
      this.pruneAllCheckpointNamespaces(database)
      this.pruneAllUnreachableMessageSnapshots(database)
      const freelistResult = database.exec("PRAGMA freelist_count")
      const freePages = Number(freelistResult[0]?.values[0]?.[0] ?? 0)
      if (freePages > 0) database.run("VACUUM")
      database.flush("TRUNCATE")
      const nextSize = sqliteFileSize(this.dbPath)
      console.warn(
        `[SqlJsSaver] Compacted oversized database from ` +
          `${Math.round(liveSize / 1024 / 1024)}MB to ` +
          `${nextSize ? Math.round(nextSize / 1024 / 1024) : "unknown"}MB.`
      )
    } catch (error) {
      console.warn("[SqlJsSaver] Failed to compact oversized database:", error)
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

    await this.migrateCheckpointSchemaOnce(this.db)

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

    this.db.run(`
      CREATE TABLE IF NOT EXISTS checkpoint_message_snapshots (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        prefix_length INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL,
        type TEXT,
        suffix BLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )
    `)

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_checkpoint_message_snapshot_parent
      ON checkpoint_message_snapshots (thread_id, checkpoint_ns, parent_checkpoint_id)
    `)
    this.isSetup = true
  }

  private rememberHydratedCheckpointMessages(
    key: string,
    hydrated: HydratedCheckpointMessages
  ): void {
    this.hydratedCheckpointMessages.delete(key)
    this.hydratedCheckpointMessages.set(key, hydrated)
    while (this.hydratedCheckpointMessages.size > MAX_HYDRATED_MESSAGE_SNAPSHOTS) {
      const oldestKey = this.hydratedCheckpointMessages.keys().next().value as string | undefined
      if (!oldestKey) break
      this.hydratedCheckpointMessages.delete(oldestKey)
    }
  }

  private async loadCheckpointMessages(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
  ): Promise<HydratedCheckpointMessages> {
    if (!this.db) throw new Error("Database not initialized")

    const targetKey = checkpointMessageCacheKey(threadId, checkpointNs, checkpointId)
    const cachedTarget = this.hydratedCheckpointMessages.get(targetKey)
    if (cachedTarget) {
      this.rememberHydratedCheckpointMessages(targetKey, cachedTarget)
      return cachedTarget
    }

    const pendingRows: CheckpointMessageSnapshotRow[] = []
    const visited = new Set<string>()
    let cursor: string | null = checkpointId
    let base: HydratedCheckpointMessages = {
      messages: [],
      snapshotDepth: 0,
      deltaBytes: 0
    }

    while (cursor) {
      if (visited.has(cursor)) {
        throw new Error(`[SqlJsSaver] Cyclic checkpoint message snapshot: ${cursor}`)
      }
      visited.add(cursor)

      const cursorKey = checkpointMessageCacheKey(threadId, checkpointNs, cursor)
      const cached = this.hydratedCheckpointMessages.get(cursorKey)
      if (cached) {
        base = cached
        this.rememberHydratedCheckpointMessages(cursorKey, cached)
        break
      }

      const stmt = this.db.prepare(`
        SELECT checkpoint_id, parent_checkpoint_id, prefix_length, message_count, type, suffix
        FROM checkpoint_message_snapshots
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
      `)
      stmt.bind([threadId, checkpointNs, cursor])
      if (!stmt.step()) {
        stmt.free()
        throw new Error(`[SqlJsSaver] Missing checkpoint message snapshot: ${cursor}`)
      }
      const row = stmt.getAsObject() as unknown as CheckpointMessageSnapshotRow
      stmt.free()
      pendingRows.push(row)
      cursor = row.parent_checkpoint_id
    }

    const chunks: CheckpointMessageChunk[] = base.messages.length
      ? [{ messages: base.messages, start: 0, end: base.messages.length }]
      : []
    let messageCount = base.messages.length
    let snapshotDepth = base.snapshotDepth
    let deltaBytes = base.deltaBytes
    for (let index = pendingRows.length - 1; index >= 0; index -= 1) {
      const row = pendingRows[index]
      const prefixLength = Number(row.prefix_length)
      const nextMessageCount = Number(row.message_count)
      if (
        !Number.isInteger(prefixLength) ||
        prefixLength < 0 ||
        prefixLength > messageCount ||
        !Number.isInteger(nextMessageCount) ||
        nextMessageCount < prefixLength
      ) {
        throw new Error(`[SqlJsSaver] Invalid checkpoint message snapshot: ${row.checkpoint_id}`)
      }

      const suffix = await this.serde.loadsTyped(row.type ?? "json", row.suffix ?? "")
      if (!Array.isArray(suffix)) {
        throw new Error(`[SqlJsSaver] Invalid checkpoint message suffix: ${row.checkpoint_id}`)
      }
      if (prefixLength + suffix.length !== nextMessageCount) {
        throw new Error(`[SqlJsSaver] Checkpoint message count mismatch: ${row.checkpoint_id}`)
      }
      truncateCheckpointMessageChunks(chunks, messageCount, prefixLength)
      if (suffix.length > 0) {
        chunks.push({ messages: suffix, start: 0, end: suffix.length })
      }
      messageCount = nextMessageCount
      if (row.parent_checkpoint_id === null) {
        snapshotDepth = 1
        deltaBytes = 0
      } else {
        snapshotDepth += 1
        deltaBytes += serializedPayloadBytes(row.suffix ?? "")
      }
    }

    // A long-running graph can leave many tiny tail deltas behind the single
    // retained checkpoint. Keep them as chunks while replaying the chain and
    // allocate the full transcript only once; repeated slice/concat here turns
    // restart or task re-entry into O(checkpoints * history).
    const messages = materializeCheckpointMessageChunks(chunks, messageCount)
    const hydrated = { messages, snapshotDepth, deltaBytes }

    // Heal databases created before depth/byte bounds existed. The first legacy
    // recovery may traverse the old chain once; all subsequent restores start
    // from this full base and stay bounded.
    if (
      snapshotDepth > MAX_CHECKPOINT_MESSAGE_SNAPSHOT_DEPTH ||
      deltaBytes > MAX_CHECKPOINT_MESSAGE_DELTA_BYTES
    ) {
      const [type, suffix] = await this.serde.dumpsTyped(messages)
      this.db.run(
        `UPDATE checkpoint_message_snapshots
         SET parent_checkpoint_id = NULL, prefix_length = 0, message_count = ?, type = ?, suffix = ?
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
        [messages.length, type, suffix, threadId, checkpointNs, checkpointId]
      )
      hydrated.snapshotDepth = 1
      hydrated.deltaBytes = 0
      this.pruneUnreachableMessageSnapshots(threadId, checkpointNs, this.db)
    }

    this.rememberHydratedCheckpointMessages(targetKey, hydrated)
    return hydrated
  }

  private async hydrateCheckpointMessages(
    row: CheckpointRow,
    checkpoint: Checkpoint
  ): Promise<Checkpoint> {
    const channelValues = checkpoint.channel_values as Record<string, unknown>
    const storedMessages = channelValues.messages
    if (!isExternalMessagesReference(storedMessages)) return checkpoint

    const hydrated = await this.loadCheckpointMessages(
      row.thread_id,
      row.checkpoint_ns,
      row.checkpoint_id
    )
    const messages = hydrated.messages
    if (messages.length !== storedMessages.messageCount) {
      throw new Error(`[SqlJsSaver] External checkpoint message count mismatch: ${row.checkpoint_id}`)
    }
    checkpoint.channel_values = {
      ...checkpoint.channel_values,
      messages
    }
    return checkpoint
  }

  /**
   * Upgrade a pre-snapshot checkpoint after its one unavoidable compatibility
   * read. Keeping the snapshot insert and compact checkpoint rewrite in one
   * transaction means a crash can expose either the complete legacy row or the
   * complete external reference, never a reference without its message base.
   */
  private async migrateLegacyInlineCheckpointMessages(
    row: CheckpointRow,
    checkpoint: Checkpoint,
    messages: unknown[]
  ): Promise<boolean> {
    if (!this.db) throw new Error("Database not initialized")
    const database = this.db
    const compactCheckpoint: Checkpoint = {
      ...checkpoint,
      channel_values: {
        ...checkpoint.channel_values,
        messages: buildExternalMessagesReference(messages.length)
      }
    }
    const [[snapshotType, serializedMessages], [checkpointType, serializedCheckpoint]] =
      await Promise.all([
        this.serde.dumpsTyped(messages),
        this.serde.dumpsTyped(compactCheckpoint)
      ])

    database.run("BEGIN")
    try {
      database.run(
        `INSERT OR REPLACE INTO checkpoint_message_snapshots
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, prefix_length,
          message_count, type, suffix)
         VALUES (?, ?, ?, NULL, 0, ?, ?, ?)`,
        [
          row.thread_id,
          row.checkpoint_ns,
          row.checkpoint_id,
          messages.length,
          snapshotType,
          serializedMessages
        ]
      )
      // A concurrent put may have replaced this exact checkpoint id while the
      // async serializer yielded. Compare-and-swap the payload so migration can
      // never overwrite a newer authoritative checkpoint.
      database.run(
        `UPDATE checkpoints
         SET type = ?, checkpoint = ?
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
           AND type IS ? AND checkpoint = ?`,
        [
          checkpointType,
          serializedCheckpoint,
          row.thread_id,
          row.checkpoint_ns,
          row.checkpoint_id,
          row.type,
          row.checkpoint
        ]
      )
      const changed = Number(database.exec("SELECT changes() AS changed")[0]?.values[0]?.[0] ?? 0)
      if (changed !== 1) {
        database.run("ROLLBACK")
        return false
      }
      database.run("COMMIT")
      return true
    } catch (error) {
      try {
        database.run("ROLLBACK")
      } catch {
        // Preserve the migration error.
      }
      throw error
    }
  }

  private pruneUnreachableMessageSnapshots(
    threadId: string,
    checkpointNs: string,
    database: NativeSqliteAdapter
  ): void {
    const snapshotTable = database.exec(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'checkpoint_message_snapshots'`
    )
    if (!snapshotTable[0]?.values.length) return

    const checkpointResult = database.exec(
      `SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?`,
      [threadId, checkpointNs]
    )
    const reachable = new Set<string>(
      (checkpointResult[0]?.values ?? []).map((row) => String(row[0] ?? "")).filter(Boolean)
    )

    const snapshotResult = database.exec(
      `SELECT checkpoint_id, parent_checkpoint_id
       FROM checkpoint_message_snapshots
       WHERE thread_id = ? AND checkpoint_ns = ?`,
      [threadId, checkpointNs]
    )
    const parents = new Map<string, string | null>()
    for (const row of snapshotResult[0]?.values ?? []) {
      const id = String(row[0] ?? "")
      if (!id) continue
      parents.set(id, row[1] == null ? null : String(row[1]))
    }

    const queue = Array.from(reachable)
    for (let index = 0; index < queue.length; index += 1) {
      const parent = parents.get(queue[index])
      if (!parent || reachable.has(parent)) continue
      reachable.add(parent)
      queue.push(parent)
    }

    const staleIds = Array.from(parents.keys()).filter((id) => !reachable.has(id))
    if (staleIds.length === 0) return
    for (let offset = 0; offset < staleIds.length; offset += MESSAGE_SNAPSHOT_DELETE_BATCH_SIZE) {
      const batch = staleIds.slice(offset, offset + MESSAGE_SNAPSHOT_DELETE_BATCH_SIZE)
      const placeholders = batch.map(() => "?").join(", ")
      database.run(
        `DELETE FROM checkpoint_message_snapshots
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id IN (${placeholders})`,
        [threadId, checkpointNs, ...batch]
      )
    }
    for (const checkpointId of staleIds) {
      this.hydratedCheckpointMessages.delete(
        checkpointMessageCacheKey(threadId, checkpointNs, checkpointId)
      )
    }
  }

  private pruneAllUnreachableMessageSnapshots(database: NativeSqliteAdapter): void {
    const namespaces = database.exec(
      `SELECT thread_id, checkpoint_ns
       FROM checkpoint_message_snapshots
       GROUP BY thread_id, checkpoint_ns`
    )
    for (const row of namespaces[0]?.values ?? []) {
      const threadId = String(row[0] ?? "")
      const checkpointNs = String(row[1] ?? "")
      if (threadId) this.pruneUnreachableMessageSnapshots(threadId, checkpointNs, database)
    }
  }

  /**
   * Delete old checkpoints (and their writes) beyond the retention limit.
   * Keeps the most recent N checkpoints per (thread_id, checkpoint_ns).
   */
  private pruneOldCheckpoints(
    threadId: string,
    checkpointNs: string,
    database: NativeSqliteAdapter | null = this.db
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

  private pruneRootCheckpoints(threadId: string, database: NativeSqliteAdapter): void {
    const result = database.exec(
      `WITH RECURSIVE message_chain(
         root_checkpoint_id, checkpoint_id, parent_checkpoint_id, payload_bytes
       ) AS (
         SELECT checkpoint.checkpoint_id,
                snapshot.checkpoint_id,
                snapshot.parent_checkpoint_id,
                LENGTH(COALESCE(snapshot.suffix, ''))
         FROM checkpoints AS checkpoint
         JOIN checkpoint_message_snapshots AS snapshot
           ON snapshot.thread_id = checkpoint.thread_id
          AND snapshot.checkpoint_ns = checkpoint.checkpoint_ns
          AND snapshot.checkpoint_id = checkpoint.checkpoint_id
         WHERE checkpoint.thread_id = ? AND checkpoint.checkpoint_ns = ''
         UNION
         SELECT chain.root_checkpoint_id,
                parent.checkpoint_id,
                parent.parent_checkpoint_id,
                LENGTH(COALESCE(parent.suffix, ''))
         FROM message_chain AS chain
         JOIN checkpoint_message_snapshots AS parent
           ON parent.thread_id = ?
          AND parent.checkpoint_ns = ''
          AND parent.checkpoint_id = chain.parent_checkpoint_id
       ), message_payload AS (
         SELECT root_checkpoint_id, SUM(payload_bytes) AS payload_bytes
         FROM message_chain
         GROUP BY root_checkpoint_id
       )
       SELECT checkpoint.checkpoint_id,
              checkpoint.fork_boundary_marker,
              LENGTH(COALESCE(checkpoint.checkpoint, '')) +
                LENGTH(COALESCE(checkpoint.metadata, '')) +
                COALESCE(message_payload.payload_bytes, 0) AS payload_bytes
       FROM checkpoints AS checkpoint
       LEFT JOIN message_payload
         ON message_payload.root_checkpoint_id = checkpoint.checkpoint_id
       WHERE checkpoint.thread_id = ? AND checkpoint.checkpoint_ns = ''
       ORDER BY COALESCE(checkpoint.checkpoint_ts, checkpoint.checkpoint_id) DESC,
                checkpoint.checkpoint_id DESC`,
      [threadId, threadId, threadId]
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

  /** Checkpoint committed WAL pages without copying or serializing the database. */
  private ensureFlushCheckpoint(): Promise<unknown | null> {
    if (this.flushPromise) return this.flushPromise

    let failure: unknown
    try {
      if (this.db && !this.retired) this.db.flush("FULL")
    } catch (error) {
      failure = error
      console.warn("[SqlJsSaver] WAL checkpoint failed:", error)
    }

    const flushPromise = Promise.resolve(failure ?? null).finally(() => {
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
    await this.ensureFlushCheckpoint()
  }

  async flushStrict(): Promise<void> {
    if (this.closePromise) await this.closePromise
    while (this.flushPromise) {
      await this.flushPromise
    }
    const failure = await this.ensureFlushCheckpoint()
    if (failure) throw failure
  }

  /**
   * Read only the latest checkpoint state needed to restore renderer/runtime
   * affordances such as todos and interrupts. Unlike getTuple()/list(), this
   * deliberately does not traverse the external transcript snapshot chain and
   * never returns channel_values.messages across IPC.
   *
   * Full tuples remain available through the existing methods for graph resume,
   * worker restore, export and fork operations.
   */
  async getLatestRuntimeTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")

    const threadId = config.configurable?.thread_id
    const checkpointNs = config.configurable?.checkpoint_ns ?? ""
    if (typeof threadId !== "string" || !threadId) return undefined

    const stmt = this.db.prepare(`
      SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint
      FROM checkpoints
      WHERE thread_id = ? AND checkpoint_ns = ?
      ORDER BY COALESCE(checkpoint_ts, checkpoint_id) DESC, checkpoint_id DESC
      LIMIT 1
    `)
    stmt.bind([threadId, checkpointNs])
    if (!stmt.step()) {
      stmt.free()
      return undefined
    }

    const row = stmt.getAsObject() as unknown as CheckpointRow
    stmt.free()
    const serializedCheckpoint = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint
    )) as Checkpoint
    const storedMessages = (serializedCheckpoint.channel_values as Record<string, unknown>)
      .messages
    if (Array.isArray(storedMessages)) {
      try {
        await this.migrateLegacyInlineCheckpointMessages(row, serializedCheckpoint, storedMessages)
      } catch (error) {
        // Runtime hydration still succeeds from the already-decoded legacy row.
        // A later access can retry the crash-safe migration.
        console.warn("[SqlJsSaver] Failed to migrate legacy inline checkpoint messages:", error)
      }
    }
    const runtimeChannelValues = {
      ...(serializedCheckpoint.channel_values as Record<string, unknown>)
    }
    delete runtimeChannelValues.messages

    return {
      config: {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id
        }
      },
      checkpoint: {
        ...serializedCheckpoint,
        channel_values: runtimeChannelValues
      },
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id
            }
          }
        : undefined
    }
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

    const serializedCheckpoint = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint
    )) as Checkpoint
    const hasExternalSnapshot = isExternalMessagesReference(
      (serializedCheckpoint.channel_values as Record<string, unknown>).messages
    )
    const checkpoint = await this.hydrateCheckpointMessages(row, serializedCheckpoint)

    const restoredMessages = (checkpoint.channel_values as Record<string, unknown>).messages
    if (Array.isArray(restoredMessages)) {
      const hydrated = hasExternalSnapshot
        ? this.hydratedCheckpointMessages.get(
            checkpointMessageCacheKey(row.thread_id, row.checkpoint_ns, row.checkpoint_id)
          )
        : undefined
      this.checkpointMessageWriteStates.set(
        checkpointMessageNamespaceKey(row.thread_id, row.checkpoint_ns),
        {
          checkpointId: row.checkpoint_id,
          messages: restoredMessages,
          ...captureCheckpointMessageSentinels(restoredMessages),
          hasExternalSnapshot,
          snapshotDepth: hydrated?.snapshotDepth ?? 0,
          deltaBytes: hydrated?.deltaBytes ?? 0
        }
      )
    }

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

        const checkpoint = await this.hydrateCheckpointMessages(
          row,
          (await this.serde.loadsTyped(row.type ?? "json", row.checkpoint)) as Checkpoint
        )

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
    const database = this.db

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
    const namespaceKey = checkpointMessageNamespaceKey(thread_id, checkpoint_ns)
    const messages = (preparedCheckpoint.channel_values as Record<string, unknown>).messages
    let messageSnapshotParentCheckpointId: string | null = null
    let messageSnapshotPrefixLength = 0
    let externalMessageCount: number | undefined
    let serializedMessageSuffix: [string, string | Uint8Array] | undefined
    let nextSnapshotDepth = 0
    let nextDeltaBytes = 0
    let shouldPruneMessageSnapshots = false

    if (Array.isArray(messages)) {
      externalMessageCount = messages.length
      const previous = this.checkpointMessageWriteStates.get(namespaceKey)
      if (
        previous?.hasExternalSnapshot &&
        parent_checkpoint_id === previous.checkpointId &&
        previous.snapshotDepth < MAX_CHECKPOINT_MESSAGE_SNAPSHOT_DEPTH
      ) {
        messageSnapshotPrefixLength = commonMessageReferencePrefix(previous, messages)
        if (messageSnapshotPrefixLength > 0) {
          messageSnapshotParentCheckpointId = previous.checkpointId
        }
      }

      const suffix = messages.slice(messageSnapshotPrefixLength)
      preparedCheckpoint.channel_values = {
        ...preparedCheckpoint.channel_values,
        messages: buildExternalMessagesReference(messages.length)
      }
      serializedMessageSuffix = await this.serde.dumpsTyped(suffix)

      if (messageSnapshotParentCheckpointId && previous) {
        const candidateDeltaBytes =
          previous.deltaBytes + serializedPayloadBytes(serializedMessageSuffix[1])
        if (candidateDeltaBytes > MAX_CHECKPOINT_MESSAGE_DELTA_BYTES) {
          messageSnapshotParentCheckpointId = null
          messageSnapshotPrefixLength = 0
          serializedMessageSuffix = await this.serde.dumpsTyped(messages)
          nextSnapshotDepth = 1
          nextDeltaBytes = 0
          shouldPruneMessageSnapshots = true
        } else {
          nextSnapshotDepth = previous.snapshotDepth + 1
          nextDeltaBytes = candidateDeltaBytes
        }
      } else {
        nextSnapshotDepth = 1
        nextDeltaBytes = 0
        // A saver reopened by the LRU has no in-memory `previous`, but this
        // authoritative base can still supersede a persisted snapshot chain.
        // Collect only this affected namespace after the commit.
        shouldPruneMessageSnapshots = true
      }
    } else {
      const persistedSnapshot = database.exec(
        `SELECT 1 FROM checkpoint_message_snapshots
         WHERE thread_id = ? AND checkpoint_ns = ? LIMIT 1`,
        [thread_id, checkpoint_ns]
      )
      shouldPruneMessageSnapshots =
        this.checkpointMessageWriteStates.has(namespaceKey) ||
        Boolean(persistedSnapshot[0]?.values.length)
    }

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

    try {
      database.run("BEGIN")
      if (serializedMessageSuffix) {
        database.run(
          `INSERT OR REPLACE INTO checkpoint_message_snapshots
           (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, prefix_length,
            message_count, type, suffix)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            thread_id,
            checkpoint_ns,
            checkpoint.id,
            messageSnapshotParentCheckpointId,
            messageSnapshotPrefixLength,
            externalMessageCount,
            serializedMessageSuffix[0],
            serializedMessageSuffix[1]
          ]
        )
      } else {
        database.run(
          `DELETE FROM checkpoint_message_snapshots
           WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
          [thread_id, checkpoint_ns, checkpoint.id]
        )
      }

      database.run(
        `INSERT OR REPLACE INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint,
          metadata, checkpoint_ts, fork_boundary_marker)
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
      database.run("COMMIT")
    } catch (error) {
      database.run("ROLLBACK")
      throw error
    }

    if (Array.isArray(messages)) {
      this.checkpointMessageWriteStates.set(namespaceKey, {
        checkpointId: checkpoint.id,
        messages,
        ...captureCheckpointMessageSentinels(messages),
        hasExternalSnapshot: true,
        snapshotDepth: nextSnapshotDepth,
        deltaBytes: nextDeltaBytes
      })
      this.rememberHydratedCheckpointMessages(
        checkpointMessageCacheKey(thread_id, checkpoint_ns, checkpoint.id),
        {
          messages,
          snapshotDepth: nextSnapshotDepth,
          deltaBytes: nextDeltaBytes
        }
      )
    } else {
      this.checkpointMessageWriteStates.delete(namespaceKey)
    }

    this.pruneOldCheckpoints(thread_id, checkpoint_ns, database)
    if (shouldPruneMessageSnapshots) {
      this.pruneUnreachableMessageSnapshots(thread_id, checkpoint_ns, database)
    }

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
    const database = this.db

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

    const stmt = database.prepare(sql)
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

    database.run(
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
    return nextMetadata
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")
    const database = this.db

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.")
    }

    if (!config.configurable?.thread_id) {
      throw new Error("Missing thread_id field in config.configurable.")
    }

    if (!config.configurable?.checkpoint_id) {
      throw new Error("Missing checkpoint_id field in config.configurable.")
    }

    const serializedWrites = await Promise.all(
      writes.map(async (write) => ({ write, serialized: await this.serde.dumpsTyped(write[1]) }))
    )
    try {
      database.run("BEGIN")
      for (let idx = 0; idx < serializedWrites.length; idx += 1) {
        const { write, serialized } = serializedWrites[idx]
        database.run(
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
            serialized[0],
            serialized[1]
          ]
        )
      }
      database.run("COMMIT")
    } catch (error) {
      database.run("ROLLBACK")
      throw error
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")

    this.db.run(`DELETE FROM checkpoints WHERE thread_id = ?`, [threadId])
    this.db.run(`DELETE FROM writes WHERE thread_id = ?`, [threadId])
    this.db.run(`DELETE FROM checkpoint_message_snapshots WHERE thread_id = ?`, [threadId])

    const cachePrefix = `${threadId}\u0000`
    for (const key of this.checkpointMessageWriteStates.keys()) {
      if (key.startsWith(cachePrefix)) this.checkpointMessageWriteStates.delete(key)
    }
    for (const key of this.hydratedCheckpointMessages.keys()) {
      if (key.startsWith(cachePrefix)) this.hydratedCheckpointMessages.delete(key)
    }

  }

  /**
   * Permanently close for thread deletion. Unlike close() (reusable shutdown:
   * flushes pending state, and a later initialize() may legitimately reopen),
   * retire() poisons the instance first — in-flight writes are awaited, the
   * final checkpoint is skipped (the file is about to be deleted), and every future
   * initialize()/mutation is refused. Call this, not close(), whenever the backing
   * file is being removed from disk.
   */
  async retire(): Promise<void> {
    this.retired = true
    await this.close()
  }

  /** Close the database after a final WAL checkpoint. */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    const closePromise = (async () => {
      const pendingInitialize = this.initializePromise
      if (pendingInitialize) {
        try {
          await pendingInitialize
        } catch {
          // The initialize caller receives the original failure; still release any handle.
        }
      }
      const pendingFlush = this.flushPromise
      if (pendingFlush) await pendingFlush
      const database = this.db
      let failure: unknown
      if (database) {
        this.db = null
        this.isSetup = false
        try {
          database.close({ checkpoint: !this.retired })
        } catch (error) {
          failure ??= error
        }
      }
      this.checkpointMessageWriteStates.clear()
      this.hydratedCheckpointMessages.clear()
      if (failure) throw failure
    })().finally(() => {
      if (this.closePromise === closePromise) this.closePromise = null
    })
    this.closePromise = closePromise
    return closePromise
  }
}
