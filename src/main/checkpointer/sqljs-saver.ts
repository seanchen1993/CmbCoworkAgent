import { NativeSqliteAdapter, openNativeSqliteDatabase } from "../db/native-sqlite-adapter"
import {
  ensureMessageSnapshotGeneration,
  MESSAGE_SNAPSHOT_GENERATION_MIGRATION
} from "./message-snapshot-schema"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { sqliteFileSize } from "../utils/sqlite-durable-file"
import { clearCheckpointSummarizationState } from "../../shared/context-compaction-messages"
import {
  applyForkReplayMessages,
  buildVisibleForkableCheckpointList,
  FORK_DURABLE_TAIL_KEY,
  isCompletedLegacyGraphCheckpoint,
  isLegacyCheckpointBeforeTurn,
  isUserInterruptedForkBoundary,
  readForkBoundaryMarker,
  readForkDurableTail,
  readInterruptedTurnUserId
} from "../../shared/checkpoint-forkability"
import { getCheckpointGraphInputUserId } from "../../shared/checkpoint-transcript"
import { readGraphInputForkReplay } from "./fork-replay-proof"
import { ensureCheckpointRuntimeProjectionInWorker } from "./runtime-projection-client"
import { LEGACY_TOOL_REPLAY_SOURCE_BYTE_BUDGET } from "./runtime-projection-protocol"
import {
  buildCheckpointRuntimeProjection,
  CHECKPOINT_RUNTIME_PROJECTION_VERSION
} from "./runtime-projection"

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
const CHECKPOINT_LINEAGE_SPAN = 128
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
  generation: string
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
  snapshotGeneration: string | null
}

interface CheckpointMessageSentinel {
  index: number
  value: unknown
}

interface HydratedCheckpointMessages {
  messages: unknown[]
  snapshotDepth: number
  deltaBytes: number
  snapshotGeneration: string | null
}

export interface CheckpointMessageRecoveryContext {
  threadId: string
  checkpointNs: string
  checkpointId: string
  missingCheckpointId: string
  expectedMessageCount: number
  hasInterrupt: boolean
  /** Interrupts, pending sends, and pending writes require an exact transcript. */
  requiresExactRecovery: boolean
  /** Durable transcript rows after this checkpoint must not be folded into it. */
  checkpointTs: string
  transcriptRevision?: string
}

export interface CheckpointMessageRecoveryResult {
  messages: readonly unknown[]
  /** True only when every durable row was returned without a bounded preview. */
  complete: boolean
  /** True only when complete=false solely because older complete rows remain. */
  boundedByHistory?: boolean
}

export const LOCAL_CHECKPOINT_MESSAGE_RECOVERY_ERROR =
  "LOCAL_CHECKPOINT_MESSAGE_RECOVERY_FAILED"

export class CheckpointMessageSnapshotRecoveryError extends Error {
  readonly code = LOCAL_CHECKPOINT_MESSAGE_RECOVERY_ERROR

  constructor(checkpointId: string, options?: ErrorOptions) {
    super(
      "本地会话消息索引不完整，自动恢复失败；已保存的会话消息没有被删除。" +
        "请重启应用后重试，如仍失败请导出日志。" +
        `（checkpoint: ${checkpointId}）`,
      options
    )
    this.name = "CheckpointMessageSnapshotRecoveryError"
  }
}

class MissingCheckpointMessageSnapshotError extends Error {
  constructor(readonly checkpointId: string) {
    super(`[SqlJsSaver] Missing checkpoint message snapshot: ${checkpointId}`)
    this.name = "MissingCheckpointMessageSnapshotError"
  }
}

const EXTERNAL_MESSAGES_MARKER = "__cmb_sqljs_external_messages_v1"
const MAX_HYDRATED_MESSAGE_SNAPSHOTS = 8

/**
 * A replacement run can construct a second saver for the same thread before the
 * predecessor's slow serde finishes. Keep the FIFO module-wide (not saver-wide)
 * so those two instances cannot invalidate each other's selected message parent.
 * Cross-process writers are still fenced by the SQLite transaction checks.
 */
const checkpointNamespaceQueues = new Map<string, Promise<void>>()
const checkpointNamespacePendingWriteIntents = new Map<string, number>()
const checkpointDatabaseSetupQueues = new Map<string, Promise<void>>()

function canonicalCheckpointDatabaseKey(dbPath: string): string {
  const absolute = resolve(dbPath)
  return process.platform === "win32" ? absolute.toLowerCase() : absolute
}

async function acquireCheckpointDatabaseSetup(databaseKey: string): Promise<() => void> {
  const previous = checkpointDatabaseSetupQueues.get(databaseKey) ?? Promise.resolve()
  let releaseGate: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  const tail = previous.catch(() => {}).then(() => gate)
  checkpointDatabaseSetupQueues.set(databaseKey, tail)
  await previous.catch(() => {
    // A failed predecessor must not poison later setup attempts for this file.
  })

  let released = false
  return () => {
    if (released) return
    released = true
    releaseGate()
    void tail.finally(() => {
      if (checkpointDatabaseSetupQueues.get(databaseKey) === tail) {
        checkpointDatabaseSetupQueues.delete(databaseKey)
      }
    })
  }
}

interface CheckpointForkBoundaryBackfill {
  threadId: string
  checkpointNs: string
  checkpointId: string
  metadataType: string | null
  metadataPayload: string | Uint8Array
}

interface ExternalMessagesReference {
  [EXTERNAL_MESSAGES_MARKER]: true
  messageCount: number
  transcriptRevision?: string
}

function buildExternalMessagesReference(
  messageCount: number,
  transcriptRevision?: string
): ExternalMessagesReference {
  return {
    [EXTERNAL_MESSAGES_MARKER]: true,
    messageCount,
    ...(transcriptRevision ? { transcriptRevision } : {})
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
  /** Size threshold used by explicit/background runMaintenance() calls. */
  maxDatabaseBytes?: number
  /** Historical import checkpoints still needed to prove exact tool replays. */
  readLegacyToolReplaySources?: (threadId: string) => ReadonlySet<string>
  /** @deprecated Native SQLite no longer loads the whole file into memory. */
  maxOversizedRecoveryBytes?: number
  /**
   * Cold-path repair for a historical external-message chain whose snapshot row
   * is missing. The runtime implementation reads a bounded durable transcript in
   * a Worker; normal checkpoint reads and writes never call it.
   */
  recoverMissingCheckpointMessages?: (
    context: CheckpointMessageRecoveryContext
  ) => Promise<CheckpointMessageRecoveryResult | null>
}

interface CheckpointRuntimeProjectionRow {
  thread_id: string
  checkpoint_ns: string
  checkpoint_id: string
  parent_checkpoint_id: string | null
  type: string | null
  runtime_checkpoint: string | Uint8Array
}

export interface SqlJsSaverMaintenanceResult {
  attempted: boolean
  compacted: boolean
  beforeBytes: number | null
  afterBytes: number | null
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
  /** Coalesce concurrent readers of the same broken checkpoint into one Worker/CAS repair. */
  private checkpointMessageRecoveryRequests = new Map<
    string,
    Promise<HydratedCheckpointMessages>
  >()

  /** Root checkpoints are for runtime state and recent fork boundaries. User-visible
   * transcript history lives in the main database, so checkpoint retention can stay small.
   * Non-root namespaces are internal/tool subgraphs and can still grow quickly. */
  private maxRootCheckpoints = 1
  private maxRootForkBoundaryCheckpoints = DEFAULT_MAX_ROOT_FORK_BOUNDARY_CHECKPOINTS
  private maxRootForkBoundaryBytes = DEFAULT_MAX_ROOT_FORK_BOUNDARY_BYTES
  private maxNonRootCheckpoints = 1
  private maxDatabaseBytes = DEFAULT_MAX_DB_SIZE_BYTES
  private recoverMissingCheckpointMessages?: SqlJsSaverOptions["recoverMissingCheckpointMessages"]
  private readonly readLegacyToolReplaySources?: SqlJsSaverOptions["readLegacyToolReplaySources"]
  private readonly checkpointDatabaseKey: string

  constructor(dbPath: string, serde?: SerializerProtocol, options: SqlJsSaverOptions = {}) {
    super(serde)
    this.dbPath = dbPath
    this.checkpointDatabaseKey = canonicalCheckpointDatabaseKey(dbPath)
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
    this.recoverMissingCheckpointMessages = options.recoverMissingCheckpointMessages
    this.readLegacyToolReplaySources = options.readLegacyToolReplaySources
  }

  private async acquireCheckpointNamespace(
    threadId: string,
    checkpointNs: string
  ): Promise<() => void> {
    const key = this.checkpointNamespaceQueueKey(threadId, checkpointNs)
    const previous = checkpointNamespaceQueues.get(key) ?? Promise.resolve()
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const tail = previous.catch(() => {}).then(() => gate)
    checkpointNamespaceQueues.set(key, tail)
    await previous.catch(() => {
      // A failed predecessor releases, rather than poisons, the namespace.
    })

    let released = false
    return () => {
      if (released) return
      released = true
      releaseGate()
      void tail.finally(() => {
        if (checkpointNamespaceQueues.get(key) === tail) {
          checkpointNamespaceQueues.delete(key)
        }
      })
    }
  }

  private checkpointNamespaceQueueKey(threadId: string, checkpointNs: string): string {
    return `${this.checkpointDatabaseKey}\u0000${checkpointMessageNamespaceKey(threadId, checkpointNs)}`
  }

  private hasPendingWriteIntent(threadId: string, checkpointNs: string): boolean {
    const key = this.checkpointNamespaceQueueKey(threadId, checkpointNs)
    return (checkpointNamespacePendingWriteIntents.get(key) ?? 0) > 0
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
      const releaseSetup = await acquireCheckpointDatabaseSetup(this.checkpointDatabaseKey)
      try {
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
        } catch (error) {
          if (this.db === database) {
            this.db = null
            this.isSetup = false
          }
          database.close({ checkpoint: false })
          throw error
        }
      } finally {
        releaseSetup()
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

  private async prepareCheckpointForkBoundaryMarkerBackfill(
    database: NativeSqliteAdapter
  ): Promise<CheckpointForkBoundaryBackfill[]> {
    const result = database.exec(
      `SELECT thread_id, checkpoint_ns, checkpoint_id, type, metadata FROM checkpoints`
    )
    const rows = result[0]?.values ?? []
    const backfill: CheckpointForkBoundaryBackfill[] = []

    for (const row of rows) {
      try {
        const metadataPayload = row[4]
        if (!(typeof metadataPayload === "string" || metadataPayload instanceof Uint8Array)) {
          continue
        }
        const metadataType = typeof row[3] === "string" ? row[3] : null
        const metadata = (await this.serde.loadsTyped(
          metadataType ?? "json",
          metadataPayload
        )) as CheckpointMetadata
        if (!checkpointMetadataHasForkBoundaryMarker(metadata)) continue
        backfill.push({
          threadId: String(row[0] ?? ""),
          checkpointNs: String(row[1] ?? ""),
          checkpointId: String(row[2] ?? ""),
          metadataType,
          metadataPayload
        })
      } catch (error) {
        console.warn("[SqlJsSaver] Failed to backfill checkpoint fork marker:", error)
      }
    }
    return backfill
  }

  /**
   * Schema upgrades and the legacy metadata decode are cold, one-time work.
   * Keep the marker in the same transaction as the data changes so a crash can
   * only expose either the complete migration or an empty marker that retries.
   */
  private async migrateCheckpointSchemaOnce(database: NativeSqliteAdapter): Promise<boolean> {
    database.run(`
      CREATE TABLE IF NOT EXISTS checkpoint_schema_migrations (
        migration_id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `)
    const applied = database.exec(
      `SELECT migration_id FROM checkpoint_schema_migrations WHERE migration_id IN (?, ?)`,
      [CHECKPOINT_SCHEMA_MIGRATION_ID, MESSAGE_SNAPSHOT_GENERATION_MIGRATION]
    )
    const appliedIds = new Set(applied[0]?.values.map((row) => row[0]))
    if (appliedIds.has(CHECKPOINT_SCHEMA_MIGRATION_ID)) {
      return appliedIds.has(MESSAGE_SNAPSHOT_GENERATION_MIGRATION)
    }

    // Metadata decoding can yield. Finish it before acquiring SQLite's writer
    // lock so another connection can never synchronously busy-wait while this
    // main-thread continuation is unable to resume and commit.
    const forkBoundaryBackfill = await this.prepareCheckpointForkBoundaryMarkerBackfill(database)

    let migrationStarted = false
    try {
      database.run("BEGIN IMMEDIATE")
      migrationStarted = true

      // Another process may have completed the migration while metadata was
      // decoded. Recheck both the marker and live schema under the writer lock.
      const concurrentlyApplied = database.exec(
        `SELECT 1 FROM checkpoint_schema_migrations WHERE migration_id = ? LIMIT 1`,
        [CHECKPOINT_SCHEMA_MIGRATION_ID]
      )
      if (concurrentlyApplied[0]?.values.length) {
        database.run("COMMIT")
        migrationStarted = false
        return false
      }

      const tableInfo = database.exec("PRAGMA table_info(checkpoints)")
      const columns = new Set((tableInfo[0]?.values ?? []).map((row) => String(row[1] ?? "")))
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
      for (const candidate of forkBoundaryBackfill) {
        database.run(
          `UPDATE checkpoints
           SET fork_boundary_marker = 1
           WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
             AND fork_boundary_marker = 0 AND type IS ? AND metadata = ?`,
          [
            candidate.threadId,
            candidate.checkpointNs,
            candidate.checkpointId,
            candidate.metadataType,
            candidate.metadataPayload
          ]
        )
      }
      database.run(
        `INSERT INTO checkpoint_schema_migrations (migration_id, applied_at) VALUES (?, ?)`,
        [CHECKPOINT_SCHEMA_MIGRATION_ID, Date.now()]
      )
      database.run("COMMIT")
      migrationStarted = false
    } catch (error) {
      if (migrationStarted) {
        try {
          database.run("ROLLBACK")
        } catch {
          // Preserve the migration error; a failed BEGIN has no transaction.
        }
      }
      throw error
    }
    return false
  }

  private async pruneAllCheckpointNamespaces(database: NativeSqliteAdapter): Promise<void> {
    const namespaces = database.exec(
      `SELECT thread_id, checkpoint_ns FROM checkpoints GROUP BY thread_id, checkpoint_ns`
    )
    for (const row of namespaces[0]?.values ?? []) {
      const threadId = typeof row[0] === "string" ? row[0] : String(row[0] ?? "")
      const checkpointNs = typeof row[1] === "string" ? row[1] : String(row[1] ?? "")
      if (!threadId) continue
      await this.pruneOldCheckpoints(threadId, checkpointNs, database)
    }
  }

  private async compactOversizedLiveDatabase(
    database: NativeSqliteAdapter,
    liveSize: number
  ): Promise<boolean> {
    try {
      await this.pruneAllCheckpointNamespaces(database)
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
      return true
    } catch (error) {
      console.warn("[SqlJsSaver] Failed to compact oversized database:", error)
      return false
    }
  }

  /**
   * Explicit cold-path maintenance. Callers must schedule this outside thread
   * hydration and active graph runs (for example in a maintenance worker): the
   * namespace scan and VACUUM are intentionally synchronous within this method.
   */
  async runMaintenance(): Promise<SqlJsSaverMaintenanceResult> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")

    const beforeBytes = sqliteFileSize(this.dbPath)
    if (beforeBytes === null || beforeBytes <= this.maxDatabaseBytes) {
      return {
        attempted: false,
        compacted: false,
        beforeBytes,
        afterBytes: beforeBytes
      }
    }

    const compacted = await this.compactOversizedLiveDatabase(this.db, beforeBytes)
    return {
      attempted: true,
      compacted,
      beforeBytes,
      afterBytes: sqliteFileSize(this.dbPath)
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

    this.db.run(`CREATE TABLE IF NOT EXISTS checkpoint_lineage (
      thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
      parent_checkpoint_id TEXT, conflicting_parent INTEGER NOT NULL DEFAULT 0,
      lineage_depth INTEGER, ancestor_span_id TEXT, ancestor_span_depth INTEGER,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
    )`)
    const lineageColumns = this.db.exec("PRAGMA table_info(checkpoint_lineage)")[0]?.values ?? []
    for (const [name, type] of [
      ["lineage_depth", "INTEGER"], ["ancestor_span_id", "TEXT"], ["ancestor_span_depth", "INTEGER"]
    ]) {
      if (!lineageColumns.some((column) => column[1] === name))
        this.db.run(`ALTER TABLE checkpoint_lineage ADD COLUMN ${name} ${type}`)
    }
    this.db.run(`CREATE INDEX IF NOT EXISTS checkpoint_lineage_conflicts
      ON checkpoint_lineage(thread_id, checkpoint_ns, lineage_depth) WHERE conflicting_parent = 1`)
    this.db.run(`INSERT INTO checkpoint_lineage
      (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, lineage_depth)
      SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
        CASE WHEN parent_checkpoint_id IS NULL THEN 0 END FROM checkpoints WHERE 1
      ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET conflicting_parent = 1
      WHERE checkpoint_lineage.parent_checkpoint_id IS NOT excluded.parent_checkpoint_id`)
    const recordLineage = `INSERT INTO checkpoint_lineage
      (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, lineage_depth, ancestor_span_id, ancestor_span_depth)
      SELECT NEW.thread_id, NEW.checkpoint_ns, NEW.checkpoint_id, NEW.parent_checkpoint_id, COALESCE(parent.lineage_depth + 1, 0),
        CASE WHEN parent.lineage_depth % ${CHECKPOINT_LINEAGE_SPAN} = 0 THEN parent.checkpoint_id ELSE parent.ancestor_span_id END,
        CASE WHEN parent.lineage_depth % ${CHECKPOINT_LINEAGE_SPAN} = 0 THEN parent.lineage_depth ELSE parent.ancestor_span_depth END
      FROM (SELECT 1) LEFT JOIN checkpoint_lineage AS parent ON parent.thread_id = NEW.thread_id
        AND parent.checkpoint_ns = NEW.checkpoint_ns AND parent.checkpoint_id = NEW.parent_checkpoint_id
      WHERE 1
      ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET conflicting_parent = 1
      WHERE checkpoint_lineage.parent_checkpoint_id IS NOT excluded.parent_checkpoint_id;`
    this.db.run(`CREATE TRIGGER IF NOT EXISTS checkpoint_lineage_insert AFTER INSERT ON checkpoints
      BEGIN ${recordLineage} END`)
    this.db.run(`CREATE TRIGGER IF NOT EXISTS checkpoint_lineage_parent_update
      AFTER UPDATE OF parent_checkpoint_id, checkpoint_id ON checkpoints
      WHEN NEW.parent_checkpoint_id IS NOT OLD.parent_checkpoint_id OR NEW.checkpoint_id IS NOT OLD.checkpoint_id
      BEGIN ${recordLineage} END`)

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
      CREATE TABLE IF NOT EXISTS checkpoint_legacy_fork_candidates (
        thread_id TEXT PRIMARY KEY NOT NULL,
        checkpoint_ids TEXT NOT NULL
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
        generation TEXT NOT NULL DEFAULT '',
        type TEXT,
        suffix BLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )
    `)

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_checkpoint_message_snapshot_parent
      ON checkpoint_message_snapshots (thread_id, checkpoint_ns, parent_checkpoint_id)
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS checkpoint_runtime_projections (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        checkpoint_ts TEXT NOT NULL,
        projection_version INTEGER NOT NULL DEFAULT 1,
        type TEXT NOT NULL,
        runtime_checkpoint BLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns)
      )
    `)
    const runtimeProjectionColumns = this.db.exec(
      "PRAGMA table_info(checkpoint_runtime_projections)"
    )
    const hasRuntimeProjectionVersion = (runtimeProjectionColumns[0]?.values ?? []).some(
      (column) => column[1] === "projection_version"
    )
    if (!hasRuntimeProjectionVersion) {
      // Rows written by the pre-projection-version implementation are not
      // trusted as bounded; the worker rebuilds them from the authoritative
      // checkpoint before Electron main reads the payload.
      this.db.run(
        "ALTER TABLE checkpoint_runtime_projections ADD COLUMN projection_version INTEGER NOT NULL DEFAULT 0"
      )
    }
    // Publish every table needed by the projection worker before the first
    // asynchronous legacy decode. A worker may observe the database while that
    // cold migration yields; at that point it must see a complete base schema.
    const generationReady = await this.migrateCheckpointSchemaOnce(this.db)
    if (!generationReady) ensureMessageSnapshotGeneration(this.db)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_checkpoints_fork_scan
      ON checkpoints (thread_id, checkpoint_ns, fork_boundary_marker, checkpoint_id, parent_checkpoint_id)
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

  private checkpointMessageCacheIsCurrent(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
    cached: HydratedCheckpointMessages
  ): boolean {
    if (!this.db || !cached.snapshotGeneration) return false
    const result = this.db.exec(
      `SELECT message_count, generation FROM checkpoint_message_snapshots
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
       LIMIT 1`,
      [threadId, checkpointNs, checkpointId]
    )
    const row = result[0]?.values[0]
    return Number(row?.[0]) === cached.messages.length && row?.[1] === cached.snapshotGeneration
  }

  private async loadCheckpointMessages(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
  ): Promise<HydratedCheckpointMessages> {
    if (!this.db) throw new Error("Database not initialized")

    const targetKey = checkpointMessageCacheKey(threadId, checkpointNs, checkpointId)
    const cachedTarget = this.hydratedCheckpointMessages.get(targetKey)
    if (
      cachedTarget &&
      this.checkpointMessageCacheIsCurrent(threadId, checkpointNs, checkpointId, cachedTarget)
    ) {
      this.rememberHydratedCheckpointMessages(targetKey, cachedTarget)
      return cachedTarget
    }
    if (cachedTarget) this.hydratedCheckpointMessages.delete(targetKey)

    const pendingRows: CheckpointMessageSnapshotRow[] = []
    const visited = new Set<string>()
    let cursor: string | null = checkpointId
    let base: HydratedCheckpointMessages = {
      messages: [],
      snapshotDepth: 0,
      deltaBytes: 0,
      snapshotGeneration: null
    }

    while (cursor) {
      if (visited.has(cursor)) {
        throw new Error(`[SqlJsSaver] Cyclic checkpoint message snapshot: ${cursor}`)
      }
      visited.add(cursor)

      const cursorKey = checkpointMessageCacheKey(threadId, checkpointNs, cursor)
      const cached = this.hydratedCheckpointMessages.get(cursorKey)
      if (cached && this.checkpointMessageCacheIsCurrent(threadId, checkpointNs, cursor, cached)) {
        base = cached
        this.rememberHydratedCheckpointMessages(cursorKey, cached)
        break
      }
      if (cached) this.hydratedCheckpointMessages.delete(cursorKey)

      const stmt = this.db.prepare(`
        SELECT checkpoint_id, parent_checkpoint_id, prefix_length, message_count,
               generation, type, suffix
        FROM checkpoint_message_snapshots
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
      `)
      stmt.bind([threadId, checkpointNs, cursor])
      if (!stmt.step()) {
        stmt.free()
        throw new MissingCheckpointMessageSnapshotError(cursor)
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
    const targetGeneration = pendingRows[0]?.generation
    const hydrated = {
      messages,
      snapshotDepth,
      deltaBytes,
      snapshotGeneration:
        typeof targetGeneration === "string" && targetGeneration
          ? targetGeneration
          : base.snapshotGeneration
    }

    // Heal databases created before depth/byte bounds existed. The first legacy
    // recovery may traverse the old chain once; all subsequent restores start
    // from this full base and stay bounded.
    if (
      snapshotDepth > MAX_CHECKPOINT_MESSAGE_SNAPSHOT_DEPTH ||
      deltaBytes > MAX_CHECKPOINT_MESSAGE_DELTA_BYTES
    ) {
      const [type, suffix] = await this.serde.dumpsTyped(messages)
      const generation = randomUUID()
      this.db.run(
        `UPDATE checkpoint_message_snapshots
         SET parent_checkpoint_id = NULL, prefix_length = 0, message_count = ?,
             generation = ?, type = ?, suffix = ?
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
        [messages.length, generation, type, suffix, threadId, checkpointNs, checkpointId]
      )
      hydrated.snapshotDepth = 1
      hydrated.deltaBytes = 0
      hydrated.snapshotGeneration = generation
      this.pruneUnreachableMessageSnapshots(threadId, checkpointNs, this.db)
    }

    this.rememberHydratedCheckpointMessages(targetKey, hydrated)
    return hydrated
  }

  private async hydrateCheckpointMessages(
    row: CheckpointRow,
    checkpoint: Checkpoint,
    allowBoundedHistoryRecovery = false
  ): Promise<Checkpoint> {
    const channelValues = checkpoint.channel_values as Record<string, unknown>
    const storedMessages = channelValues.messages
    if (!isExternalMessagesReference(storedMessages)) return checkpoint

    let hydrated: HydratedCheckpointMessages
    let expectedHydratedMessageCount = storedMessages.messageCount
    try {
      hydrated = await this.loadCheckpointMessages(
        row.thread_id,
        row.checkpoint_ns,
        row.checkpoint_id
      )
    } catch (error) {
      if (!(error instanceof MissingCheckpointMessageSnapshotError)) throw error
      hydrated = await this.recoverMissingCheckpointMessageSnapshot(
        row,
        checkpoint,
        storedMessages.messageCount,
        error,
        allowBoundedHistoryRecovery
      )
      // Recovery atomically replaces the historical marker with a bounded,
      // self-contained base whose authoritative count is the recovered count.
      expectedHydratedMessageCount = hydrated.messages.length
    }
    const messages = hydrated.messages
    if (messages.length !== expectedHydratedMessageCount) {
      throw new Error(`[SqlJsSaver] External checkpoint message count mismatch: ${row.checkpoint_id}`)
    }
    checkpoint.channel_values = {
      ...checkpoint.channel_values,
      messages
    }
    return checkpoint
  }

  private checkpointHasInterrupt(checkpoint: Checkpoint): boolean {
    const interrupt = (checkpoint.channel_values as Record<string, unknown>).__interrupt__
    return Array.isArray(interrupt) ? interrupt.length > 0 : Boolean(interrupt)
  }

  private checkpointHasPendingWrites(row: CheckpointRow, database: NativeSqliteAdapter): boolean {
    const result = database.exec(
      `SELECT 1 FROM writes
       WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
       LIMIT 1`,
      [row.thread_id, row.checkpoint_ns, row.checkpoint_id]
    )
    return Boolean(result[0]?.values.length)
  }

  private isExactLatestCheckpointRow(
    row: CheckpointRow,
    database: NativeSqliteAdapter
  ): boolean {
    const result = database.exec(
      `SELECT 1
       FROM checkpoints AS source
       WHERE source.thread_id = ? AND source.checkpoint_ns = ? AND source.checkpoint_id = ?
         AND source.type IS ? AND source.checkpoint = ?
         AND COALESCE(source.fork_boundary_marker, 0) = ?
         AND NOT EXISTS (
           SELECT 1 FROM checkpoints AS newer
           WHERE newer.thread_id = source.thread_id
             AND newer.checkpoint_ns = source.checkpoint_ns
             AND (
               COALESCE(newer.checkpoint_ts, newer.checkpoint_id) >
                 COALESCE(source.checkpoint_ts, source.checkpoint_id)
               OR (
                 COALESCE(newer.checkpoint_ts, newer.checkpoint_id) =
                   COALESCE(source.checkpoint_ts, source.checkpoint_id)
                 AND newer.checkpoint_id > source.checkpoint_id
               )
             )
         )
       LIMIT 1`,
      [
        row.thread_id,
        row.checkpoint_ns,
        row.checkpoint_id,
        row.type,
        row.checkpoint,
        Number(row.fork_boundary_marker) === 1 ? 1 : 0
      ]
    )
    return Boolean(result[0]?.values.length)
  }

  private async recoverMissingCheckpointMessageSnapshot(
    row: CheckpointRow,
    checkpoint: Checkpoint,
    expectedMessageCount: number,
    missing: MissingCheckpointMessageSnapshotError,
    allowBoundedHistoryRecovery: boolean
  ): Promise<HydratedCheckpointMessages> {
    const key = checkpointMessageCacheKey(row.thread_id, row.checkpoint_ns, row.checkpoint_id)
    const existing = this.checkpointMessageRecoveryRequests.get(key)
    if (existing) return existing

    const request = this.performMissingCheckpointMessageRecovery(
      row,
      checkpoint,
      expectedMessageCount,
      missing,
      allowBoundedHistoryRecovery
    ).finally(() => {
      if (this.checkpointMessageRecoveryRequests.get(key) === request) {
        this.checkpointMessageRecoveryRequests.delete(key)
      }
    })
    this.checkpointMessageRecoveryRequests.set(key, request)
    return request
  }

  private async performMissingCheckpointMessageRecovery(
    row: CheckpointRow,
    checkpoint: Checkpoint,
    expectedMessageCount: number,
    missing: MissingCheckpointMessageSnapshotError,
    allowBoundedHistoryRecovery: boolean
  ): Promise<HydratedCheckpointMessages> {
    const recover = this.recoverMissingCheckpointMessages
    const database = this.db
    // The durable transcript represents the current conversation. Applying it
    // to a historical checkpoint would inject future turns into an old fork.
    if (!recover || !database || !this.isExactLatestCheckpointRow(row, database)) {
      throw new CheckpointMessageSnapshotRecoveryError(row.checkpoint_id, { cause: missing })
    }

    const hasInterrupt = this.checkpointHasInterrupt(checkpoint)
    const pendingSends = (checkpoint as Checkpoint & { pending_sends?: unknown }).pending_sends
    const hasPendingSends = Array.isArray(pendingSends) && pendingSends.length > 0
    const requiresExactRecovery =
      !allowBoundedHistoryRecovery ||
      hasInterrupt ||
      hasPendingSends ||
      this.checkpointHasPendingWrites(row, database) ||
      this.hasPendingWriteIntent(row.thread_id, row.checkpoint_ns)
    const reference = (checkpoint.channel_values as Record<string, unknown>).messages
    const transcriptRevision = isExternalMessagesReference(reference) &&
      typeof reference.transcriptRevision === "string" ? reference.transcriptRevision : undefined
    let recovered: CheckpointMessageRecoveryResult | null
    try {
      recovered = await recover({
        threadId: row.thread_id,
        checkpointNs: row.checkpoint_ns,
        checkpointId: row.checkpoint_id,
        missingCheckpointId: missing.checkpointId,
        expectedMessageCount,
        hasInterrupt,
        requiresExactRecovery,
        checkpointTs: checkpoint.ts,
        ...(transcriptRevision ? { transcriptRevision } : {})
      })
    } catch (error) {
      console.warn("[SqlJsSaver] Checkpoint message recovery source failed:", error)
      throw new CheckpointMessageSnapshotRecoveryError(row.checkpoint_id, { cause: error })
    }
    // A bounded tail is safe for an ordinary completed turn, but an interrupt
    // can refer to an older tool-call message. Keep the broken state fail-closed
    // unless the Worker proved that it returned the complete durable transcript.
    if (
      !recovered ||
      !Array.isArray(recovered.messages) ||
      recovered.messages.length > expectedMessageCount ||
      (recovered.complete && recovered.messages.length !== expectedMessageCount) ||
      (!recovered.complete && recovered.boundedByHistory !== true) ||
      (requiresExactRecovery &&
        (!recovered.complete || recovered.messages.length !== expectedMessageCount))
    ) {
      throw new CheckpointMessageSnapshotRecoveryError(row.checkpoint_id, { cause: missing })
    }

    const messages = Array.from(recovered.messages)
    // Preserve legacy/forward-compatible top-level state such as pending_sends;
    // copyCheckpoint() intentionally drops fields unknown to its current type.
    const preparedCheckpoint = { ...checkpoint }
    preparedCheckpoint.channel_values = {
      ...preparedCheckpoint.channel_values,
      messages: buildExternalMessagesReference(messages.length,
        recovered.complete ? transcriptRevision : randomUUID())
    }
    if (!recovered.complete) {
      // A bounded recovery replaces the raw prefix, so old summary offsets no
      // longer refer to the messages that summary covers.
      clearCheckpointSummarizationState(preparedCheckpoint.channel_values)
    }
    const [[messageType, serializedMessages], [checkpointType, serializedCheckpoint]] =
      await Promise.all([
        this.serde.dumpsTyped(messages),
        this.serde.dumpsTyped(preparedCheckpoint)
      ])
    const recoveryGeneration = randomUUID()

    if (!this.db) {
      throw new CheckpointMessageSnapshotRecoveryError(row.checkpoint_id, { cause: missing })
    }
    try {
      database.run("BEGIN IMMEDIATE")
      if (!this.isExactLatestCheckpointRow(row, database)) {
        database.run("ROLLBACK")
        throw new CheckpointMessageSnapshotRecoveryError(row.checkpoint_id, { cause: missing })
      }
      const stillRequiresExactRecovery =
        !allowBoundedHistoryRecovery ||
        hasInterrupt ||
        hasPendingSends ||
        this.checkpointHasPendingWrites(row, database) ||
        this.hasPendingWriteIntent(row.thread_id, row.checkpoint_ns)
      if (
        stillRequiresExactRecovery &&
        (!recovered.complete || messages.length !== expectedMessageCount)
      ) {
        database.run("ROLLBACK")
        throw new CheckpointMessageSnapshotRecoveryError(row.checkpoint_id, { cause: missing })
      }
      database.run(
        `INSERT INTO checkpoint_message_snapshots
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, prefix_length,
          message_count, generation, type, suffix)
         VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?)
         ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET
           parent_checkpoint_id = excluded.parent_checkpoint_id,
           prefix_length = excluded.prefix_length,
           message_count = excluded.message_count,
           generation = excluded.generation,
           type = excluded.type,
           suffix = excluded.suffix`,
        [
          row.thread_id,
          row.checkpoint_ns,
          row.checkpoint_id,
          messages.length,
          recoveryGeneration,
          messageType,
          serializedMessages
        ]
      )
      database.run(
        `UPDATE checkpoints SET type = ?, checkpoint = ?
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
      database.run("COMMIT")
    } catch (error) {
      try {
        database.run("ROLLBACK")
      } catch {
        // Preserve the recovery/CAS failure.
      }
      if (error instanceof CheckpointMessageSnapshotRecoveryError) throw error
      throw new CheckpointMessageSnapshotRecoveryError(row.checkpoint_id, { cause: error })
    }

    const hydrated = {
      messages,
      snapshotDepth: 1,
      deltaBytes: 0,
      snapshotGeneration: recoveryGeneration
    }
    if (!recovered.complete) clearCheckpointSummarizationState(checkpoint.channel_values)
    this.rememberHydratedCheckpointMessages(
      checkpointMessageCacheKey(row.thread_id, row.checkpoint_ns, row.checkpoint_id),
      hydrated
    )
    // This now-full base supersedes the broken orphan chain. Collection itself
    // uses an atomic reachability snapshot, so a concurrent Worker writer cannot
    // turn one of the rows selected for deletion into a live ancestor mid-GC.
    this.pruneUnreachableMessageSnapshots(row.thread_id, row.checkpoint_ns, database)
    return hydrated
  }

  private pruneUnreachableMessageSnapshots(
    threadId: string,
    checkpointNs: string,
    database: NativeSqliteAdapter
  ): void {
    let staleIds: string[] = []
    let transactionStarted = false
    try {
      database.run("BEGIN IMMEDIATE")
      transactionStarted = true
      const snapshotTable = database.exec(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'checkpoint_message_snapshots'`
      )
      if (snapshotTable[0]?.values.length) {
        const checkpointResult = database.exec(
          `SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?`,
          [threadId, checkpointNs]
        )
        const reachable = new Set<string>(
          (checkpointResult[0]?.values ?? [])
            .map((row) => String(row[0] ?? ""))
            .filter(Boolean)
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

        staleIds = Array.from(parents.keys()).filter((id) => !reachable.has(id))
        for (
          let offset = 0;
          offset < staleIds.length;
          offset += MESSAGE_SNAPSHOT_DELETE_BATCH_SIZE
        ) {
          const batch = staleIds.slice(offset, offset + MESSAGE_SNAPSHOT_DELETE_BATCH_SIZE)
          const placeholders = batch.map(() => "?").join(", ")
          database.run(
            `DELETE FROM checkpoint_message_snapshots
             WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id IN (${placeholders})`,
            [threadId, checkpointNs, ...batch]
          )
        }
      }
      database.run("COMMIT")
      transactionStarted = false
    } catch (error) {
      if (transactionStarted) {
        try {
          database.run("ROLLBACK")
        } catch {
          // Keep GC best-effort; the already committed checkpoint stays valid.
        }
      }
      console.warn("[SqlJsSaver] Failed to prune unreachable message snapshots:", error)
      return
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
  private async pruneOldCheckpoints(
    threadId: string,
    checkpointNs: string,
    database: NativeSqliteAdapter | null = this.db
  ): Promise<void> {
    if (!database) return
    if (checkpointNs === "") {
      await this.pruneRootCheckpoints(threadId, database)
      return
    }

    const limit = this.retentionLimitForNamespace(checkpointNs)
    let transactionStarted = false
    try {
      database.run("BEGIN IMMEDIATE")
      transactionStarted = true
      const countResult = database.exec(
        `SELECT COUNT(*) FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ?`,
        [threadId, checkpointNs]
      )
      const total = countResult[0]?.values[0]?.[0] as number
      if (total <= limit) {
        database.run("COMMIT")
        transactionStarted = false
        return
      }

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
      transactionStarted = false
    } catch (e) {
      if (transactionStarted) {
        try {
          database.run("ROLLBACK")
        } catch {
          // Retention can retry after the next successful checkpoint write.
        }
      }
      console.warn("[SqlJsSaver] Failed to prune old checkpoints:", e)
    }
  }

  private forkArchiveBoundaryCache?: {
    threadId: string
    checkpointId: string
    stamp: string
    excludedLegacyIds?: ReadonlySet<string>
    verifiedLegacyIds?: ReadonlySet<string>
    enrichedMetadata?: Uint8Array
  }

  private forkArchiveMarkerCache = new Map<string, { revision: string; stamp: string; eligible: boolean }>()
  private checkedGraphForkInputs = new Set<string>()

  private async loadRootCheckpointTranscript(
    threadId: string,
    id: string,
    type: string,
    data: string | Uint8Array
  ): Promise<Checkpoint> {
    const checkpoint = (await this.serde.loadsTyped(type, data)) as Checkpoint
    if (isExternalMessagesReference(checkpoint.channel_values.messages)) {
      const snapshot = await this.loadCheckpointMessages(threadId, "", id)
      checkpoint.channel_values.messages = snapshot.messages
    }
    return checkpoint
  }

  /** Retain the graph input replay IDs and payload digests before that row ages out. */
  private async preserveRootGraphForkReplays(
    threadId: string,
    database: NativeSqliteAdapter
  ): Promise<void> {
    const inputs =
      database.exec(
        `SELECT child.checkpoint_id, child.parent_checkpoint_id, snapshot.generation,
              parent_snapshot.generation
       FROM checkpoints AS child INDEXED BY idx_checkpoints_fork_scan
       JOIN checkpoints AS parent ON parent.thread_id = child.thread_id
         AND parent.checkpoint_ns = '' AND parent.checkpoint_id = child.parent_checkpoint_id
       LEFT JOIN checkpoint_message_snapshots AS snapshot ON snapshot.thread_id = child.thread_id
         AND snapshot.checkpoint_ns = '' AND snapshot.checkpoint_id = child.checkpoint_id
       LEFT JOIN checkpoint_message_snapshots AS parent_snapshot ON parent_snapshot.thread_id = parent.thread_id
         AND parent_snapshot.checkpoint_ns = '' AND parent_snapshot.checkpoint_id = parent.checkpoint_id
       WHERE child.thread_id = ? AND child.checkpoint_ns = '' AND child.fork_boundary_marker = 0
         AND child.parent_checkpoint_id IS NOT NULL
         AND CASE WHEN json_valid(CAST(child.metadata AS TEXT))
           THEN json_extract(CAST(child.metadata AS TEXT), '$.source') = 'input' ELSE 0 END
         AND CASE WHEN json_valid(CAST(parent.metadata AS TEXT))
           THEN json_type(CAST(parent.metadata AS TEXT), '$.${FORK_DURABLE_TAIL_KEY}') IS NULL
           ELSE 0 END
       ORDER BY COALESCE(child.checkpoint_ts, child.checkpoint_id) DESC, child.checkpoint_id DESC`,
        [threadId]
      )[0]?.values ?? []
    const checked = new Set<string>()
    for (const [id, parentId, generation, originalParentGeneration] of inputs) {
      if (typeof id !== "string" || typeof parentId !== "string") continue
      const key = JSON.stringify([threadId, id, generation, originalParentGeneration])
      if (this.checkedGraphForkInputs.has(key)) {
        checked.add(key)
        continue
      }
      try {
        const [inputType, inputData] =
          database.exec(
            "SELECT type, checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?",
            [threadId, id]
          )[0]?.values[0] ?? []
        if (typeof inputData !== "string" && !(inputData instanceof Uint8Array)) continue
        const input = (await this.serde.loadsTyped(
          String(inputType ?? "json"),
          inputData
        )) as Checkpoint
        const evidence = readGraphInputForkReplay(input)
        if (evidence.length === 0) {
          checked.add(key)
          continue
        }
        const [parentType, parentData, parentMetadata, pending, parentGeneration] =
          database.exec(
            `SELECT type, checkpoint, metadata,
                EXISTS (SELECT 1 FROM writes WHERE thread_id = ? AND checkpoint_ns = ''
                  AND checkpoint_id = ?),
                (SELECT generation FROM checkpoint_message_snapshots
                 WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?)
         FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`,
            [threadId, parentId, threadId, parentId, threadId, parentId]
          )[0]?.values[0] ?? []
        if (
          !(typeof parentData === "string" || parentData instanceof Uint8Array) ||
          !(typeof parentMetadata === "string" || parentMetadata instanceof Uint8Array)
        )
          continue
        const type = String(parentType ?? "json")
        const metadata = (await this.serde.loadsTyped(type, parentMetadata)) as CheckpointMetadata
        if (readForkDurableTail(metadata)) continue
        const checkpoint = await this.loadRootCheckpointTranscript(
          threadId,
          parentId,
          type,
          parentData
        )
        const replay = applyForkReplayMessages(
          {
            config: {
              configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: parentId }
            },
            checkpoint,
            metadata,
            ...(pending === 1 && { pendingWrites: [["", "", null]] })
          },
          evidence.map(({ message }) => message)
        )
        if (
          !replay ||
          buildVisibleForkableCheckpointList([replay], {
            activeRun: false,
            pendingApproval: false,
            legacyFallbackMode: "all"
          }).length === 0
        ) {
          continue
        }
        const [encodedType, encoded] = await this.serde.dumpsTyped({
          ...metadata,
          [FORK_DURABLE_TAIL_KEY]: evidence.map(({ id, digest }) => ({ id, digest }))
        })
        if (encodedType !== type) continue
        database.run(
          `UPDATE checkpoints SET metadata = ?
         WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?
           AND type IS ? AND metadata = ? AND checkpoint = ?
           AND (SELECT generation FROM checkpoint_message_snapshots
                WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?) IS ?
           AND EXISTS (SELECT 1 FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ''
             AND checkpoint_id = ? AND parent_checkpoint_id = ? AND checkpoint = ?)`,
          [
            encoded,
            threadId,
            parentId,
            parentType ?? null,
            parentMetadata,
            parentData,
            threadId,
            parentId,
            parentGeneration ?? null,
            threadId,
            id,
            parentId,
            inputData
          ]
        )
        this.forkArchiveMarkerCache.delete(threadId + "\u0000" + parentId)
      } catch (error) {
        if (
          error instanceof MissingCheckpointMessageSnapshotError ||
          error instanceof CheckpointMessageSnapshotRecoveryError ||
          error instanceof SyntaxError
        ) {
          checked.add(key)
        }
        console.warn("[SqlJsSaver] Could not preserve graph replay evidence:", id, error)
      }
    }
    this.checkedGraphForkInputs = checked
  }

  private async readForkArchiveMarkerEligibility(
    database: NativeSqliteAdapter,
    threadId: string,
    dataVersion: unknown
  ): Promise<Map<string, { stamp: string; eligible: boolean }>> {
    const rows = database.exec(
      `SELECT cp.checkpoint_id, snapshot.generation, cp.rowid
       FROM checkpoints AS cp INDEXED BY idx_checkpoints_fork_scan
       LEFT JOIN checkpoint_message_snapshots AS snapshot
         ON snapshot.thread_id = cp.thread_id AND snapshot.checkpoint_ns = ''
        AND snapshot.checkpoint_id = cp.checkpoint_id
       WHERE cp.thread_id = ? AND cp.checkpoint_ns = '' AND cp.fork_boundary_marker = 1`,
      [threadId]
    )[0]?.values ?? []
    const eligibility = new Map<string, { stamp: string; eligible: boolean }>()
    const nextCache: typeof this.forkArchiveMarkerCache = new Map()
    for (const [id, generation, rowId] of rows) {
      if (typeof id !== "string") continue
      const key = threadId + "\u0000" + id
      const revision = JSON.stringify([rowId, generation, dataVersion])
      const cached = this.forkArchiveMarkerCache.get(key)
      if (cached?.revision === revision) {
        eligibility.set(id, cached)
        nextCache.set(key, cached)
        continue
      }
      const [encodedType, encodedMetadata] = database.exec(
        "SELECT type, metadata FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?",
        [threadId, id]
      )[0]?.values[0] ?? []
      const stamp = this.forkArchiveBoundaryStamp(encodedMetadata, generation, rowId, dataVersion)
      let eligible = true
      try {
        const type = typeof encodedType === "string" ? encodedType : "json"
        if (typeof encodedMetadata === "string" || encodedMetadata instanceof Uint8Array) {
          const metadata = await this.serde.loadsTyped(type, encodedMetadata) as CheckpointMetadata
          if (
            isUserInterruptedForkBoundary(readForkBoundaryMarker(metadata)) &&
            !readForkDurableTail(metadata)
          ) {
            const data = database.exec(
              "SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?",
              [threadId, id]
            )[0]?.values[0]?.[0]
            if (typeof data === "string" || data instanceof Uint8Array) {
              const checkpoint = await this.loadRootCheckpointTranscript(threadId, id, type, data)
              eligible = buildVisibleForkableCheckpointList([{
                config: { configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: id } },
                checkpoint,
                metadata
              }], { activeRun: false, pendingApproval: false }).length > 0
            }
          }
        }
        nextCache.set(key, { revision, stamp, eligible })
      } catch {
        // Preserve the marker for this write and try to verify it next time.
      }
      eligibility.set(id, { stamp, eligible })
    }
    this.forkArchiveMarkerCache = nextCache
    return eligibility
  }

  private readLegacyForkCheckpointIds(
    database: NativeSqliteAdapter,
    threadId: string
  ): ReadonlySet<string> | undefined {
    const encoded = database.exec(
      "SELECT checkpoint_ids FROM checkpoint_legacy_fork_candidates WHERE thread_id = ?",
      [threadId]
    )[0]?.values[0]?.[0]
    return typeof encoded === "string" ? new Set<string>(JSON.parse(encoded)) : undefined
  }

  async getLegacyForkCheckpointIds(threadId: string): Promise<ReadonlySet<string> | undefined> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")
    return this.readLegacyForkCheckpointIds(this.db, threadId)
  }

  async captureLegacyForkCheckpointIds(
    threadId: string,
    beforeTurnUserId?: string | null,
    ownsRun: () => boolean = () => true,
    materialize: (tuples: CheckpointTuple[]) => CheckpointTuple[] = (tuples) => tuples
  ): Promise<void> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")
    const database = this.db
    if (this.readLegacyForkCheckpointIds(database, threadId) !== undefined) return
    const hasMarker = database.exec(
      `SELECT 1 FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ''
       AND fork_boundary_marker = 1 LIMIT 1`,
      [threadId]
    )[0]?.values.length
    if (hasMarker) return
    await this.preserveRootGraphForkReplays(threadId, database)

    const tuples: CheckpointTuple[] = []
    if (ownsRun()) {
      const ids = database.exec(
        `SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ''
         ORDER BY COALESCE(checkpoint_ts, checkpoint_id) DESC, checkpoint_id DESC`,
        [threadId]
      )[0]?.values ?? []
      for (const [id] of ids) {
        if (!ownsRun()) return
        if (typeof id !== "string") continue
        try {
          const tuple = await this.getTuple({
            configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: id }
          })
          if (
            tuple &&
            (beforeTurnUserId === null
              ? isCompletedLegacyGraphCheckpoint(
                  tuple.checkpoint, tuple.metadata?.source, (tuple.pendingWrites?.length ?? 0) > 0
                )
              : !beforeTurnUserId || isLegacyCheckpointBeforeTurn(tuple.checkpoint, beforeTurnUserId))
          ) {
            tuples.push(tuple)
          }
        } catch (error) {
          console.warn("[SqlJsSaver] Could not verify legacy fork checkpoint:", id, error)
        }
      }
    }
    const checkpointIds = buildVisibleForkableCheckpointList(materialize(tuples), {
      activeRun: false,
      pendingApproval: false,
      legacyFallbackMode: "all"
    }).map(({ checkpointId }) => checkpointId)
    if (!ownsRun()) return
    // Store only forkable snapshots. Unsettled legacy checkpoints must not
    // compete with them for the archive quota while the first marked run writes.
    database.run(
      `INSERT OR IGNORE INTO checkpoint_legacy_fork_candidates (thread_id, checkpoint_ids)
       SELECT ?, ? WHERE NOT EXISTS (
         SELECT 1 FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = '' AND fork_boundary_marker = 1
       )`,
      [threadId, JSON.stringify(checkpointIds), threadId]
    )
  }

  async recordCopiedLegacyForkCheckpointIds(
    threadId: string,
    checkpointIds: readonly string[]
  ): Promise<void> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")
    this.db.run(
      `INSERT OR IGNORE INTO checkpoint_legacy_fork_candidates (thread_id, checkpoint_ids)
       VALUES (?, ?)`,
      [threadId, JSON.stringify(checkpointIds)]
    )
  }

  async getForkTurnUserId(threadId: string, checkpointId: string): Promise<string | undefined> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")
    return this.readForkTurnUserId(this.db, threadId, checkpointId)
  }

  private async readForkTurnUserId(
    database: NativeSqliteAdapter,
    threadId: string,
    checkpointId: string
  ): Promise<string | undefined> {
    const readHeader = database.prepare(
      `SELECT parent_checkpoint_id, type, metadata FROM checkpoints
       WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
    )
    let id: string | null = checkpointId
    try {
      const visited = new Set<string>()
      while (id && !visited.has(id) && visited.size < MAX_CHECKPOINT_MESSAGE_SNAPSHOT_DEPTH) {
        visited.add(id)
        readHeader.bind([threadId, id])
        if (!readHeader.step()) return undefined
        const row = readHeader.getAsObject() as unknown as Pick<
          CheckpointRow,
          "parent_checkpoint_id" | "type" | "metadata"
        >
        readHeader.reset()
        const metadata = await this.serde.loadsTyped(row.type ?? "json", row.metadata) as CheckpointMetadata
        if (id !== checkpointId && readForkBoundaryMarker(metadata)) return undefined
        if (metadata.source === "input") {
          const payload = database.exec(
            "SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?",
            [threadId, id]
          )[0]?.values[0]?.[0]
          if (typeof payload !== "string" && !(payload instanceof Uint8Array)) return undefined
          const checkpoint = await this.serde.loadsTyped(row.type ?? "json", payload) as Checkpoint
          if (checkpoint.channel_values.__start__ != null) {
            return getCheckpointGraphInputUserId(checkpoint)
          }
        }
        id = row.parent_checkpoint_id
      }
      return undefined
    } catch {
      // The origin is optional fork proof. Older records can be unreadable
      // even when the checkpoint that the graph will resume is intact.
      console.warn(`[SqlJsSaver] Cannot read fork turn origin at checkpoint ${id}`)
      return undefined
    } finally {
      readHeader.free()
    }
  }

  private forkArchiveBoundaryStamp(
    metadata: unknown,
    generation: unknown,
    rowId: unknown,
    dataVersion: unknown
  ): string {
    const encoded =
      typeof metadata === "string"
        ? metadata
        : metadata instanceof Uint8Array
          ? Buffer.from(metadata).toString("utf8")
          : ""
    // Inline checkpoints have no snapshot generation. `put` replaces the
    // SQLite row, and data_version detects changes by another connection.
    return JSON.stringify([generation, rowId, dataVersion, encoded])
  }

  private async readRootForkArchiveBoundary(
    threadId: string,
    database: NativeSqliteAdapter,
    dataVersion: unknown
  ): Promise<SqlJsSaver["forkArchiveBoundaryCache"]> {
    const stmt = database.prepare(
      `SELECT cp.checkpoint_id, cp.type, cp.metadata, snapshot.generation,
              COALESCE(cp.checkpoint_ts, cp.checkpoint_id) AS sort_key, cp.rowid AS row_id
       FROM checkpoints AS cp
       LEFT JOIN checkpoint_message_snapshots AS snapshot
         ON snapshot.thread_id = cp.thread_id AND snapshot.checkpoint_ns = cp.checkpoint_ns
        AND snapshot.checkpoint_id = cp.checkpoint_id
       WHERE cp.thread_id = ? AND cp.checkpoint_ns = '' AND cp.fork_boundary_marker = 1
       ORDER BY COALESCE(cp.checkpoint_ts, cp.checkpoint_id), cp.checkpoint_id LIMIT 1`
    )
    let row: Pick<CheckpointRow, "checkpoint_id" | "type" | "metadata"> & {
      generation?: string
      sort_key: string
      row_id: number
    }
    try {
      stmt.bind([threadId])
      if (!stmt.step()) return undefined
      row = stmt.getAsObject() as typeof row
    } finally {
      stmt.free()
    }
    const stamp = this.forkArchiveBoundaryStamp(row.metadata, row.generation, row.row_id, dataVersion)
    const cached = this.forkArchiveBoundaryCache
    if (
      cached?.threadId === threadId &&
      cached.checkpointId === row.checkpoint_id &&
      cached.stamp === stamp
    ) {
      return cached
    }
    let excludedLegacyIds: Set<string> | undefined
    let verifiedLegacyIds: Set<string> | undefined
    let enrichedMetadata: Uint8Array | undefined
    try {
      const type = row.type ?? "json"
      const metadata = (await this.serde.loadsTyped(type, row.metadata)) as CheckpointMetadata
      const marker = readForkBoundaryMarker(metadata)
      const interrupted = isUserInterruptedForkBoundary(marker)
      let userId: string | undefined
      if (marker && interrupted) {
        const data = database.exec(
          "SELECT checkpoint FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?",
          [threadId, row.checkpoint_id]
        )[0]?.values[0]?.[0]
        if (!(typeof data === "string" || data instanceof Uint8Array)) return undefined
        const checkpoint = await this.loadRootCheckpointTranscript(
          threadId,
          row.checkpoint_id,
          type,
          data
        )
        const existingUserId = readInterruptedTurnUserId(checkpoint, marker)
        userId =
          existingUserId ??
          readInterruptedTurnUserId(
            checkpoint,
            marker,
            await this.readForkTurnUserId(database, threadId, row.checkpoint_id)
          )
        if (userId && !existingUserId) {
          const [encodedType, encoded] = await this.serde.dumpsTyped({
            ...metadata,
            cmb_fork_boundary: { ...marker, turnUserMessageId: userId }
          })
          if (encodedType !== type) return undefined
          enrichedMetadata = encoded
        }
      }
      if (marker) {
        if (userId) excludedLegacyIds = new Set()
        verifiedLegacyIds = new Set()
        const siblings =
          database.exec(
            `SELECT cp.checkpoint_id, cp.type, cp.checkpoint, cp.metadata,
                  EXISTS (SELECT 1 FROM writes WHERE thread_id = cp.thread_id
                    AND checkpoint_ns = '' AND checkpoint_id = cp.checkpoint_id)
           FROM checkpoints AS cp
           WHERE cp.thread_id = ? AND cp.checkpoint_ns = '' AND cp.fork_boundary_marker = 0
             AND (COALESCE(cp.checkpoint_ts, cp.checkpoint_id), cp.checkpoint_id) < (?, ?)`,
            [threadId, row.sort_key, row.checkpoint_id]
          )[0]?.values ?? []
        for (const [id, type, data, encodedMetadata, hasPendingWrites] of siblings) {
          if (typeof id !== "string" || !(typeof data === "string" || data instanceof Uint8Array))
            continue
          try {
            const codec = typeof type === "string" ? type : "json"
            const candidate = await this.loadRootCheckpointTranscript(threadId, id, codec, data)
            if (typeof encodedMetadata !== "string" && !(encodedMetadata instanceof Uint8Array))
              continue
            const candidateMetadata = (await this.serde.loadsTyped(
              codec,
              encodedMetadata
            )) as CheckpointMetadata
            const pending = hasPendingWrites === 1
            const verifiedReplay = !!readForkDurableTail(candidateMetadata)
            if (userId) {
              if (!isLegacyCheckpointBeforeTurn(candidate, userId)) {
                excludedLegacyIds?.add(id)
                continue
              }
            } else if (
              interrupted &&
              !isCompletedLegacyGraphCheckpoint(candidate, candidateMetadata.source, pending)
            ) {
              continue
            }
            if (
              !pending &&
              (verifiedReplay ||
                buildVisibleForkableCheckpointList(
                  [
                    {
                      config: {
                        configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: id }
                      },
                      checkpoint: candidate,
                      metadata: candidateMetadata
                    }
                  ],
                  { activeRun: false, pendingApproval: false, legacyFallbackMode: "all" }
                ).length > 0)
            ) {
              verifiedLegacyIds.add(id)
            }
          } catch {
            // Retention does not discard a checkpoint when its origin is unreadable.
          }
        }
      }
    } catch (error) {
      console.warn("[SqlJsSaver] Could not read interrupted turn origin for retention:", error)
    }
    const boundary = {
      threadId,
      checkpointId: row.checkpoint_id,
      stamp,
      excludedLegacyIds,
      verifiedLegacyIds,
      enrichedMetadata
    }
    this.forkArchiveBoundaryCache = boundary
    return boundary
  }

  private async pruneRootCheckpoints(
    threadId: string,
    database: NativeSqliteAdapter
  ): Promise<void> {
    let transactionStarted = false
    try {
      if (this.maxRootForkBoundaryCheckpoints > 0) {
        await this.preserveRootGraphForkReplays(threadId, database)
      }
      let legacyIds = this.maxRootForkBoundaryCheckpoints > 0
        ? this.readLegacyForkCheckpointIds(database, threadId)
        : undefined
      const dataVersion = this.maxRootForkBoundaryCheckpoints > 0
        ? database.exec("PRAGMA data_version")[0]?.values[0]?.[0]
        : undefined
      const boundary = this.maxRootForkBoundaryCheckpoints > 0 && legacyIds === undefined
        ? await this.readRootForkArchiveBoundary(threadId, database, dataVersion)
        : undefined
      const markerEligibility = this.maxRootForkBoundaryCheckpoints > 0
        ? await this.readForkArchiveMarkerEligibility(database, threadId, dataVersion)
        : undefined
      // The retention snapshot and its deletes must share one writer
      // transaction. Otherwise another saver can commit a new checkpoint after
      // keepIds is computed and the stale NOT IN set will delete that new row.
      database.run("BEGIN IMMEDIATE")
      transactionStarted = true
      const transactionDataVersion = markerEligibility
        ? database.exec("PRAGMA data_version")[0]?.values[0]?.[0]
        : undefined
      if (this.maxRootForkBoundaryCheckpoints > 0 && legacyIds === undefined) {
        legacyIds = this.readLegacyForkCheckpointIds(database, threadId)
      }
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
           -- Keep the recursive row outermost so SQLite looks up its parent by
           -- primary key instead of rescanning every snapshot in the namespace.
           CROSS JOIN checkpoint_message_snapshots AS parent
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
                  COALESCE(message_payload.payload_bytes, 0) AS payload_bytes,
                snapshot.generation,
                CASE WHEN checkpoint.fork_boundary_marker = 1 THEN checkpoint.metadata END,
                checkpoint.rowid
         FROM checkpoints AS checkpoint
         LEFT JOIN message_payload
           ON message_payload.root_checkpoint_id = checkpoint.checkpoint_id
         LEFT JOIN checkpoint_message_snapshots AS snapshot
           ON snapshot.thread_id = checkpoint.thread_id
          AND snapshot.checkpoint_ns = checkpoint.checkpoint_ns
          AND snapshot.checkpoint_id = checkpoint.checkpoint_id
         WHERE checkpoint.thread_id = ? AND checkpoint.checkpoint_ns = ''
         ORDER BY COALESCE(checkpoint.checkpoint_ts, checkpoint.checkpoint_id) DESC,
                  checkpoint.checkpoint_id DESC`,
        [threadId, threadId, threadId]
      )
      const rawRows = result[0]?.values ?? []
      const rows = rawRows.map((row) => ({
        checkpoint_id: typeof row[0] === "string" ? row[0] : String(row[0] ?? ""),
        fork_boundary_marker: typeof row[1] === "number" ? row[1] : Number(row[1] ?? 0),
        payload_bytes: typeof row[2] === "number" ? row[2] : Number(row[2] ?? 0)
      })) as RootCheckpointRetentionRow[]
      if (rows.length <= this.maxRootCheckpoints) {
        database.run("COMMIT")
        transactionStarted = false
        return
      }

      const keepIds = new Set<string>()
      for (const row of rows.slice(0, this.maxRootCheckpoints)) {
        if (row.checkpoint_id) keepIds.add(row.checkpoint_id)
      }
      const legacySources = this.readLegacyToolReplaySources?.(threadId)
      if (legacySources?.size) {
        let retainedSources = 0
        let sourceBytes = 0
        for (const row of rows.slice(this.maxRootCheckpoints)) {
          if (!legacySources.has(row.checkpoint_id)) continue
          if (sourceBytes + row.payload_bytes > LEGACY_TOOL_REPLAY_SOURCE_BYTE_BUDGET) continue
          keepIds.add(row.checkpoint_id)
          sourceBytes += row.payload_bytes
          if (++retainedSources === 4) break
        }
      }

      // Use the same boundary as the fork picker, including markers in the live window.
      // Unmarked rows between explicit markers are not legacy fork points.
      const oldestMarkerIndex = rows.reduce(
        (oldestIndex, row, index) => (row.fork_boundary_marker === 1 ? index : oldestIndex),
        -1
      )
      const markerRow = rawRows[oldestMarkerIndex]
      if (
        this.maxRootForkBoundaryCheckpoints > 0 && legacyIds === undefined &&
        (rows[oldestMarkerIndex]?.checkpoint_id !== boundary?.checkpointId ||
          (boundary && markerRow && boundary.stamp !== this.forkArchiveBoundaryStamp(
            markerRow[4], markerRow[3], markerRow[5], transactionDataVersion
          )))
      ) {
        // The oldest marker changed while reading its transcript. Retry with
        // that marker on the next write rather than pruning with stale proof.
        database.run("ROLLBACK")
        transactionStarted = false
        return
      }
      let archivedCount = 0
      let archivedBytes = 0

      const archiveRows = rows.slice(this.maxRootCheckpoints).map((row, offset) => ({
        row, index: offset + this.maxRootCheckpoints
      }))
      if (boundary?.verifiedLegacyIds?.size) {
        const preferred = (row: RootCheckpointRetentionRow): number =>
          row.fork_boundary_marker === 1 || boundary.verifiedLegacyIds?.has(row.checkpoint_id) ? 1 : 0
        archiveRows.sort((a, b) => preferred(b.row) - preferred(a.row))
      }
      for (const { row, index } of archiveRows) {
        const markerStatus = markerEligibility?.get(row.checkpoint_id)
        const [, , , generation, metadata, rowId] = rawRows[index]
        if (
          markerEligibility && row.fork_boundary_marker === 1 &&
          markerStatus?.stamp !== this.forkArchiveBoundaryStamp(
            metadata, generation, rowId, transactionDataVersion
          )
        ) {
          this.forkArchiveMarkerCache.delete(threadId + "\u0000" + row.checkpoint_id)
          database.run("ROLLBACK")
          transactionStarted = false
          return
        }
        const isForkBoundary = row.fork_boundary_marker === 1 && markerStatus?.eligible !== false
        const isLegacyCandidate = legacyIds?.has(row.checkpoint_id) ??
          (row.fork_boundary_marker !== 1 &&
            index > oldestMarkerIndex && !boundary?.excludedLegacyIds?.has(row.checkpoint_id))
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
      }

      if (keepIds.size >= rows.length) {
        database.run("COMMIT")
        transactionStarted = false
        return
      }
      if (legacyIds === undefined && boundary?.enrichedMetadata && keepIds.has(boundary.checkpointId)) {
        // Keep the recovered origin before retention drops the linked input.
        database.run(
          `UPDATE checkpoints SET metadata = ?
           WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`,
          [boundary.enrichedMetadata, threadId, boundary.checkpointId]
        )
      }
      if (
        legacyIds === undefined && boundary?.verifiedLegacyIds?.size &&
        !keepIds.has(boundary.checkpointId)
      ) {
        database.run(
          `INSERT OR IGNORE INTO checkpoint_legacy_fork_candidates (thread_id, checkpoint_ids)
           VALUES (?, ?)`,
          [threadId, JSON.stringify([...boundary.verifiedLegacyIds].filter((id) => keepIds.has(id)))]
        )
      }
      const placeholders = Array.from(keepIds, () => "?").join(", ")
      const params = [threadId, ...keepIds]

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
      transactionStarted = false
    } catch (e) {
      if (transactionStarted) {
        try {
          database.run("ROLLBACK")
        } catch {
          // Retention can retry after the next successful checkpoint write.
        }
      }
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

  private readLatestRuntimeProjection(
    threadId: string,
    checkpointNs: string
  ): CheckpointRuntimeProjectionRow | undefined {
    if (!this.db) return undefined
    const stmt = this.db.prepare(`
      SELECT projection.thread_id, projection.checkpoint_ns, projection.checkpoint_id,
             projection.parent_checkpoint_id, projection.type, projection.runtime_checkpoint
      FROM checkpoint_runtime_projections AS projection
      JOIN checkpoints AS checkpoint
        ON checkpoint.thread_id = projection.thread_id
       AND checkpoint.checkpoint_ns = projection.checkpoint_ns
       AND checkpoint.checkpoint_id = projection.checkpoint_id
      WHERE projection.thread_id = ? AND projection.checkpoint_ns = ?
        AND projection.projection_version = ?
        AND NOT EXISTS (
          SELECT 1 FROM checkpoints AS newer
          WHERE newer.thread_id = checkpoint.thread_id
            AND newer.checkpoint_ns = checkpoint.checkpoint_ns
            AND (
              COALESCE(newer.checkpoint_ts, newer.checkpoint_id) >
                COALESCE(checkpoint.checkpoint_ts, checkpoint.checkpoint_id)
              OR (
                COALESCE(newer.checkpoint_ts, newer.checkpoint_id) =
                  COALESCE(checkpoint.checkpoint_ts, checkpoint.checkpoint_id)
                AND newer.checkpoint_id > checkpoint.checkpoint_id
              )
            )
        )
      LIMIT 1
    `)
    stmt.bind([threadId, checkpointNs, CHECKPOINT_RUNTIME_PROJECTION_VERSION])
    if (!stmt.step()) {
      stmt.free()
      return undefined
    }
    const row = stmt.getAsObject() as unknown as CheckpointRuntimeProjectionRow
    stmt.free()
    return row
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

    let row = this.readLatestRuntimeProjection(threadId, checkpointNs)
    if (!row) {
      try {
        await ensureCheckpointRuntimeProjectionInWorker(this.dbPath, threadId, checkpointNs)
      } catch (error) {
        // Never fall back to parsing the full checkpoint on Electron main. A
        // missing legacy runtime affordance is recoverable; freezing the whole
        // application on a multi-megabyte compatibility row is not.
        console.warn("[SqlJsSaver] Failed to build checkpoint runtime projection:", error)
      }
      row = this.readLatestRuntimeProjection(threadId, checkpointNs)
    }
    if (!row) return undefined

    const runtimeCheckpoint = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.runtime_checkpoint
    )) as Checkpoint

    return {
      config: {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id
        }
      },
      checkpoint: runtimeCheckpoint,
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

  async hasCheckpoint(threadId: string, checkpointId: string, checkpointNs = ""): Promise<boolean> {
    const release = await this.acquireCheckpointNamespace(threadId, checkpointNs)
    try {
      await this.initialize()
      if (!this.db) throw new Error("Database not initialized")
      const stmt = this.db.prepare(
        "SELECT 1 FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?"
      )
      try {
        stmt.bind([threadId, checkpointNs, checkpointId])
        return stmt.step()
      } finally {
        stmt.free()
      }
    } finally {
      release()
    }
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id
    if (typeof threadId !== "string" || !threadId) return this.getTupleUnlocked(config)
    const release = await this.acquireCheckpointNamespace(
      threadId,
      config.configurable?.checkpoint_ns ?? ""
    )
    try {
      return await this.getTupleUnlocked(config)
    } finally {
      release()
    }
  }

  /**
   * Recovery-only latest-root read used after the invoke path has proven that
   * the predecessor run settled. It is deliberately not a RunnableConfig flag,
   * so fork/export/general graph reads cannot opt into bounded salvage.
   */
  async getLatestTupleForDurableTailRecovery(
    threadId: string
  ): Promise<CheckpointTuple | undefined> {
    if (!threadId) return undefined
    const release = await this.acquireCheckpointNamespace(threadId, "")
    try {
      return await this.getTupleUnlocked(
        { configurable: { thread_id: threadId, checkpoint_ns: "" } },
        true
      )
    } finally {
      release()
    }
  }

  private async getTupleUnlocked(
    config: RunnableConfig,
    allowBoundedHistoryRecovery = false
  ): Promise<CheckpointTuple | undefined> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")

    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {}

    let sql: string
    let params: (string | undefined)[]

    if (checkpoint_id) {
      sql = `
        SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint,
               metadata, fork_boundary_marker
        FROM checkpoints
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
      `
      params = [thread_id, checkpoint_ns, checkpoint_id]
    } else {
      sql = `
        SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint,
               metadata, fork_boundary_marker
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
    const checkpoint = await this.hydrateCheckpointMessages(
      row,
      serializedCheckpoint,
      allowBoundedHistoryRecovery
    )

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
          deltaBytes: hydrated?.deltaBytes ?? 0,
          snapshotGeneration: hydrated?.snapshotGeneration ?? null
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
    const threadId = config.configurable?.thread_id
    if (typeof threadId !== "string" || !threadId) {
      yield* this.listUnlocked(config, options)
      return
    }
    const release = await this.acquireCheckpointNamespace(
      threadId,
      config.configurable?.checkpoint_ns ?? ""
    )
    const tuples: CheckpointTuple[] = []
    try {
      for await (const tuple of this.listUnlocked(config, options)) tuples.push(tuple)
    } finally {
      // Never retain the namespace gate across a consumer-controlled yield.
      // A loop body is allowed to call get/put for the same namespace.
      release()
    }
    yield* tuples
  }

  private async *listUnlocked(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")

    const { limit, before } = options ?? {}
    const thread_id = config.configurable?.thread_id
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? ""

    let sql = `
      SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint,
             metadata, fork_boundary_marker
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
    const threadId = config.configurable?.thread_id
    if (typeof threadId !== "string" || !threadId) {
      return this.putUnlocked(config, checkpoint, metadata)
    }
    const release = await this.acquireCheckpointNamespace(
      threadId,
      config.configurable?.checkpoint_ns ?? ""
    )
    try {
      return await this.putUnlocked(config, checkpoint, metadata)
    } finally {
      release()
    }
  }

  private async putUnlocked(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    restoreThread = false
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
    let messageSnapshotExpectedParentCount: number | null = null
    let messageSnapshotExpectedParentGeneration: string | null = null
    let messageSnapshotPrefixLength = 0
    let externalMessageCount: number | undefined
    let serializedMessageSuffix: [string, string | Uint8Array] | undefined
    let nextSnapshotDepth = 0
    let nextDeltaBytes = 0
    let shouldPruneMessageSnapshots = false

    if (Array.isArray(messages)) {
      externalMessageCount = messages.length
      const previous = restoreThread ? undefined : this.checkpointMessageWriteStates.get(namespaceKey)
      if (
        previous?.hasExternalSnapshot &&
        previous.snapshotGeneration &&
        parent_checkpoint_id === previous.checkpointId &&
        previous.snapshotDepth < MAX_CHECKPOINT_MESSAGE_SNAPSHOT_DEPTH
      ) {
        messageSnapshotPrefixLength = commonMessageReferencePrefix(previous, messages)
        if (messageSnapshotPrefixLength > 0) {
          messageSnapshotParentCheckpointId = previous.checkpointId
          messageSnapshotExpectedParentCount = previous.messageCount
          messageSnapshotExpectedParentGeneration = previous.snapshotGeneration
        }
      }

      const suffix = messages.slice(messageSnapshotPrefixLength)
      preparedCheckpoint.channel_values = {
        ...preparedCheckpoint.channel_values,
        messages: buildExternalMessagesReference(messages.length, randomUUID())
      }
      serializedMessageSuffix = await this.serde.dumpsTyped(suffix)

      if (messageSnapshotParentCheckpointId && previous) {
        const candidateDeltaBytes =
          previous.deltaBytes + serializedPayloadBytes(serializedMessageSuffix[1])
        if (candidateDeltaBytes > MAX_CHECKPOINT_MESSAGE_DELTA_BYTES) {
          messageSnapshotParentCheckpointId = null
          messageSnapshotExpectedParentCount = null
          messageSnapshotExpectedParentGeneration = null
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

    const runtimeCheckpoint = buildCheckpointRuntimeProjection(preparedCheckpoint)
    const [
      [type1, serializedCheckpoint],
      [type2, serializedMetadata],
      [runtimeType, serializedRuntimeCheckpoint]
    ] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata),
      this.serde.dumpsTyped(runtimeCheckpoint)
    ])

    if (type1 !== type2) {
      throw new Error("Failed to serialize checkpoint and metadata to the same type.")
    }

    const checkpointTs =
      typeof preparedCheckpoint.ts === "string" ? preparedCheckpoint.ts : preparedCheckpoint.id
    const forkBoundaryMarker = checkpointMetadataHasForkBoundaryMarker(metadata) ? 1 : 0
    const nextSnapshotGeneration = serializedMessageSuffix ? randomUUID() : null

    let committed = false
    while (!committed) {
      let transactionStarted = false
      try {
        database.run("BEGIN IMMEDIATE")
        transactionStarted = true
        if (restoreThread) this.clearCheckpointRows(database, thread_id)

        if (messageSnapshotParentCheckpointId) {
          const parentResult = database.exec(
            `SELECT message_count, generation FROM checkpoint_message_snapshots
             WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
             LIMIT 1`,
            [thread_id, checkpoint_ns, messageSnapshotParentCheckpointId]
          )
          const persistedParentCount = Number(parentResult[0]?.values[0]?.[0])
          const persistedParentGeneration = parentResult[0]?.values[0]?.[1]
          if (
            !Number.isSafeInteger(persistedParentCount) ||
            persistedParentCount !== messageSnapshotExpectedParentCount ||
            persistedParentGeneration !== messageSnapshotExpectedParentGeneration
          ) {
            // A different saver may have rebased and collected this parent while
            // serde was suspended. Release the writer lock before the expensive
            // full serialization, then retry as an independent base snapshot.
            database.run("ROLLBACK")
            transactionStarted = false
            messageSnapshotParentCheckpointId = null
            messageSnapshotExpectedParentCount = null
            messageSnapshotExpectedParentGeneration = null
            messageSnapshotPrefixLength = 0
            if (!Array.isArray(messages)) {
              throw new Error("Checkpoint message delta parent exists without an array payload")
            }
            serializedMessageSuffix = await this.serde.dumpsTyped(messages)
            nextSnapshotDepth = 1
            nextDeltaBytes = 0
            shouldPruneMessageSnapshots = true
            continue
          }
        }

        if (serializedMessageSuffix) {
          database.run(
            `INSERT INTO checkpoint_message_snapshots
             (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, prefix_length,
              message_count, generation, type, suffix)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET
               parent_checkpoint_id = excluded.parent_checkpoint_id,
               prefix_length = excluded.prefix_length,
               message_count = excluded.message_count,
               generation = excluded.generation,
               type = excluded.type,
               suffix = excluded.suffix`,
            [
              thread_id,
              checkpoint_ns,
              checkpoint.id,
              messageSnapshotParentCheckpointId,
              messageSnapshotPrefixLength,
              externalMessageCount,
              nextSnapshotGeneration,
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
        database.run(
          `INSERT INTO checkpoint_runtime_projections
           (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
            checkpoint_ts, projection_version, type, runtime_checkpoint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(thread_id, checkpoint_ns) DO UPDATE SET
             checkpoint_id = excluded.checkpoint_id,
             parent_checkpoint_id = excluded.parent_checkpoint_id,
             checkpoint_ts = excluded.checkpoint_ts,
             projection_version = excluded.projection_version,
             type = excluded.type,
             runtime_checkpoint = excluded.runtime_checkpoint
           WHERE excluded.checkpoint_ts > checkpoint_runtime_projections.checkpoint_ts
              OR (
                excluded.checkpoint_ts = checkpoint_runtime_projections.checkpoint_ts
                AND excluded.checkpoint_id >= checkpoint_runtime_projections.checkpoint_id
              )`,
          [
            thread_id,
            checkpoint_ns,
            checkpoint.id,
            parent_checkpoint_id ?? null,
            checkpointTs,
            CHECKPOINT_RUNTIME_PROJECTION_VERSION,
            runtimeType,
            serializedRuntimeCheckpoint
          ]
        )
        database.run("COMMIT")
        transactionStarted = false
        committed = true
      } catch (error) {
        if (transactionStarted) {
          try {
            database.run("ROLLBACK")
          } catch {
            // Preserve the put/serialization failure.
          }
        }
        throw error
      }
    }

    if (restoreThread) this.clearCheckpointCaches(thread_id)
    if (Array.isArray(messages)) {
      this.checkpointMessageWriteStates.set(namespaceKey, {
        checkpointId: checkpoint.id,
        messages,
        ...captureCheckpointMessageSentinels(messages),
        hasExternalSnapshot: true,
        snapshotDepth: nextSnapshotDepth,
        deltaBytes: nextDeltaBytes,
        snapshotGeneration: nextSnapshotGeneration
      })
      this.rememberHydratedCheckpointMessages(
        checkpointMessageCacheKey(thread_id, checkpoint_ns, checkpoint.id),
        {
          messages,
          snapshotDepth: nextSnapshotDepth,
          deltaBytes: nextDeltaBytes,
          snapshotGeneration: nextSnapshotGeneration
        }
      )
    } else {
      this.checkpointMessageWriteStates.delete(namespaceKey)
    }

    await this.pruneOldCheckpoints(thread_id, checkpoint_ns, database)
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
    const threadId = config.configurable?.thread_id
    if (typeof threadId !== "string" || !threadId) {
      return this.updateCheckpointMetadataUnlocked(config, updater)
    }
    const release = await this.acquireCheckpointNamespace(
      threadId,
      config.configurable?.checkpoint_ns ?? ""
    )
    try {
      return await this.updateCheckpointMetadataUnlocked(config, updater)
    } finally {
      release()
    }
  }

  private async updateCheckpointMetadataUnlocked(
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
        SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint,
               metadata, fork_boundary_marker
        FROM checkpoints
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
      `
      params = [thread_id, checkpoint_ns, checkpoint_id]
    } else {
      sql = `
        SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint,
               metadata, fork_boundary_marker
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

    let transactionStarted = false
    try {
      database.run("BEGIN IMMEDIATE")
      transactionStarted = true
      const updated = database.exec(
        `UPDATE checkpoints AS source
         SET metadata = ?, fork_boundary_marker = ?
         WHERE source.thread_id = ? AND source.checkpoint_ns = ? AND source.checkpoint_id = ?
           AND source.type IS ? AND source.checkpoint = ? AND source.metadata = ?
           AND COALESCE(source.fork_boundary_marker, 0) = ?
           AND NOT EXISTS (
             SELECT 1 FROM checkpoints AS newer
             WHERE newer.thread_id = source.thread_id
               AND newer.checkpoint_ns = source.checkpoint_ns
               AND (
                 COALESCE(newer.checkpoint_ts, newer.checkpoint_id) >
                   COALESCE(source.checkpoint_ts, source.checkpoint_id)
                 OR (
                   COALESCE(newer.checkpoint_ts, newer.checkpoint_id) =
                     COALESCE(source.checkpoint_ts, source.checkpoint_id)
                   AND newer.checkpoint_id > source.checkpoint_id
                 )
               )
           )
         RETURNING checkpoint_id`,
        [
          serializedMetadata,
          checkpointMetadataHasForkBoundaryMarker(nextMetadata) ? 1 : 0,
          row.thread_id,
          row.checkpoint_ns,
          row.checkpoint_id,
          row.type,
          row.checkpoint,
          row.metadata,
          Number(row.fork_boundary_marker) === 1 ? 1 : 0
        ]
      )
      if (!updated[0]?.values.length) {
        database.run("ROLLBACK")
        transactionStarted = false
        return undefined
      }
      database.run("COMMIT")
      transactionStarted = false
      this.forkArchiveMarkerCache.delete(row.thread_id + "\u0000" + row.checkpoint_id)
      return nextMetadata
    } catch (error) {
      if (transactionStarted) {
        try {
          database.run("ROLLBACK")
        } catch {
          // Preserve the metadata CAS/serialization failure.
        }
      }
      throw error
    }
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = config.configurable?.thread_id
    if (typeof threadId !== "string" || !threadId) {
      return this.putWritesUnlocked(config, writes, taskId)
    }
    const checkpointNs = config.configurable?.checkpoint_ns ?? ""
    const intentKey = this.checkpointNamespaceQueueKey(threadId, checkpointNs)
    checkpointNamespacePendingWriteIntents.set(
      intentKey,
      (checkpointNamespacePendingWriteIntents.get(intentKey) ?? 0) + 1
    )
    let release: (() => void) | null = null
    try {
      release = await this.acquireCheckpointNamespace(threadId, checkpointNs)
      await this.putWritesUnlocked(config, writes, taskId)
    } finally {
      release?.()
      const remaining = (checkpointNamespacePendingWriteIntents.get(intentKey) ?? 1) - 1
      if (remaining > 0) checkpointNamespacePendingWriteIntents.set(intentKey, remaining)
      else checkpointNamespacePendingWriteIntents.delete(intentKey)
    }
  }

  private async putWritesUnlocked(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
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
    let transactionStarted = false
    try {
      database.run("BEGIN IMMEDIATE")
      transactionStarted = true
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
      transactionStarted = false
    } catch (error) {
      if (transactionStarted) {
        try {
          database.run("ROLLBACK")
        } catch {
          // Preserve the pending-write persistence failure.
        }
      }
      throw error
    }
  }

  private clearCheckpointRows(database: NativeSqliteAdapter, threadId: string): void {
    for (const table of ["checkpoints", "writes", "checkpoint_message_snapshots", "checkpoint_runtime_projections", "checkpoint_legacy_fork_candidates"])
      database.run(`DELETE FROM ${table} WHERE thread_id = ?`, [threadId])
  }

  private clearCheckpointCaches(threadId: string): void {
    const cachePrefix = `${threadId}\u0000`
    for (const key of this.checkpointMessageWriteStates.keys()) {
      if (key.startsWith(cachePrefix)) this.checkpointMessageWriteStates.delete(key)
    }
    for (const key of this.hydratedCheckpointMessages.keys()) {
      if (key.startsWith(cachePrefix)) this.hydratedCheckpointMessages.delete(key)
    }
  }

  async restoreThreadCheckpoint(threadId: string, snapshot?: CheckpointTuple): Promise<void> {
    const checkpointNs = snapshot?.config.configurable?.checkpoint_ns ?? ""
    const release = await this.acquireCheckpointNamespace(threadId, checkpointNs)
    try {
      if (!snapshot?.metadata) {
        await this.deleteThread(threadId)
        return
      }
      await this.putUnlocked({
        ...snapshot.config,
        configurable: {
          ...snapshot.config.configurable,
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: snapshot.parentConfig?.configurable?.checkpoint_id
        }
      }, snapshot.checkpoint, snapshot.metadata, true)
    } finally {
      release()
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.initialize()
    const database = this.db
    if (!database) throw new Error("Database not initialized")
    database.run("BEGIN IMMEDIATE")
    try {
      this.clearCheckpointRows(database, threadId)
      database.run("DELETE FROM checkpoint_lineage WHERE thread_id = ?", [threadId])
      database.run("COMMIT")
    } catch (error) {
      database.run("ROLLBACK")
      throw error
    }
    this.clearCheckpointCaches(threadId)
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
      this.checkpointMessageRecoveryRequests.clear()
      if (failure) throw failure
    })().finally(() => {
      if (this.closePromise === closePromise) this.closePromise = null
    })
    this.closePromise = closePromise
    return closePromise
  }
}
