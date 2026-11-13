import { runCheckpointDatabaseOperation, runCheckpointDatabaseMaintenance,
  checkpointDatabaseOperationIsCurrent, checkpointDatabaseMaintenanceIsCurrent,
  checkpointDatabaseAdmissionIsCurrent,
  waitForCheckpointDatabaseOperations, retainCheckpointDatabaseOperationLifetime } from "./checkpoint-database-admission"
import { resolveCheckpointDatabaseIdentity, readCheckpointDatabaseFileIdentity,
  assertCheckpointDatabaseFileIdentity, assertCheckpointDatabasePathCurrent,
  type CheckpointDatabaseIdentity, type CheckpointDatabaseFileIdentity } from "./checkpoint-database-identity"
import { captureDefaultCheckpointMetadataCodec, prepareCheckpointMetadataBackfill }
  from "./checkpoint-metadata-codec"
import { NativeSqliteAdapter, openNativeSqliteDatabase,
  captureFunctionConversationNativeSqlitePreparedExecution,
  readFunctionConversationNativeSqliteCurrentExecution } from "../db/native-sqlite-adapter"
import { resolve } from "node:path"
import { statSync as preparedStat, realpathSync as preparedRealpath } from "node:fs"
import { types } from "node:util"
import { randomUUID, createHash } from "node:crypto"
import { CHECKPOINT_SCHEMA_MIGRATION_ID, checkpointStorageSchemaNeedsMaintenance,
  checkpointStorageMaintenanceBytes, applyCheckpointStorageSchemaMaintenance, publishCheckpointStorageSchema,
  } from "./checkpoint-storage-schema"
import { maintainCheckpointStorageInWorker } from "./checkpoint-storage-maintenance"
import { nativeConversationFairness } from "../utils/native-conversation-fairness"
import { sqliteFileSize } from "../utils/sqlite-durable-file"
import { ensureCheckpointRuntimeProjectionInWorker, readPreparedNativeDataInWorker } from "./runtime-projection-client"
import type { PreparedNativeDataSource, PreparedNativeDataFacts } from "./runtime-projection-protocol"
import { preparedNativeSourcePlanDigest, preparedNativeSnapshotRowDigest, preparedNativeStorageBytesDigest } from "./function-conversation-canonical-display-worker"
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
import type { RunnableConfig } from "@langchain/core/runnables"
import type { BaseMessage } from "@langchain/core/messages"
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

const committedCheckpointReceiptBrand = Symbol("sqljs-saver-committed-checkpoint")
const preparedCheckpointReceiptBrand = Symbol("sqljs-saver-prepared-checkpoint")
const compactionWriteBatchBrand = Symbol("sqljs-saver-compaction-write-batch")
export interface SqlJsSaverCompactionWriteBatch {
  readonly [compactionWriteBatchBrand]: true
}
export interface SqlJsSaverCompactionWritesDescriptor {
  readonly version: 1
  readonly threadId: string
  readonly namespace: string
  readonly checkpointId: string
  readonly operations: readonly {
    readonly taskId: string
    readonly rows: readonly { readonly idx: number; readonly channel: string
      readonly type: string; readonly bytesDigest: string }[]
  }[]
  readonly digest: string
}
interface CompactionWriteBatchRecord {
  readonly database: NativeSqliteAdapter
  readonly generation: number
  readonly source: { threadId: string; namespace: string; checkpointId: string }
  readonly assertSource: () => void
  readonly operations: { taskId: string; rows: { idx: number; channel: string
    type: string; value: string | Uint8Array; bytesDigest: string }[] }[]
  phase: "collecting" | "attached" | "committed" | "expired"
  descriptor?: SqlJsSaverCompactionWritesDescriptor
}

/** Callback-local receipt for the exact original Saver serialization, never JSON authority. */
export interface SqlJsSaverPreparedCheckpointReceipt {
  readonly [preparedCheckpointReceiptBrand]: true
}
export interface SqlJsSaverPreparedCheckpointDescriptor {
  readonly threadId: string
  readonly namespace: string
  readonly checkpointId: string
  readonly parentCheckpointId: string | null
  readonly checkpointType: string
  readonly checkpointBytesDigest: string
  readonly metadataType: string
  readonly metadataBytesDigest: string
  readonly channels: Readonly<Record<string, string>>
}
export type SqlJsSaverPreparedCheckpointObserver =
  (receipt: SqlJsSaverPreparedCheckpointReceipt) => void | Promise<void>
interface PreparedCheckpointRecord {
  readonly database: NativeSqliteAdapter
  readonly generation: number
  readonly descriptor?: SqlJsSaverPreparedCheckpointDescriptor
  readonly destinationExisted: boolean
  active: boolean
  sourceWrites?: CompactionWriteBatchRecord
  data?: {
    readonly tuple: CheckpointTuple
    readonly source: PreparedNativeDataSource
    readonly planDigest: string
    readonly assertCurrent: () => void
    readonly assertRaw: (facts: PreparedNativeDataFacts) => void
    facts?: PreparedNativeDataFacts
  }
}

function checkpointBytesDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(typeof value === "string" ? "text:" : "blob:")
    .update(value).digest("hex")
}

/** Host-only, callback-local identity; its visible shape is never a commit proof. */
export interface SqlJsSaverCommittedCheckpointReceipt {
  readonly [committedCheckpointReceiptBrand]: true
}

export type SqlJsSaverCommitObserver = (
  receipt: SqlJsSaverCommittedCheckpointReceipt
) => void | Promise<void>

interface CommittedCheckpointRecord {
  database: NativeSqliteAdapter
  generation: number
  config: RunnableConfig
  tuple: CheckpointTuple
  active: boolean
  prepared?: SqlJsSaverPreparedCheckpointDescriptor
  sourceWrites?: SqlJsSaverCompactionWritesDescriptor
}

const functionRecoveryReceiptBrand = Symbol("sqljs-saver-function-recovery")
/** Exact existing native row, valid only during its original recovery and repair. */
export interface SqlJsSaverFunctionConversationRecoveryReceipt {
  readonly [functionRecoveryReceiptBrand]: true
}
export interface SqlJsSaverFunctionConversationRecoveryCheckpoint {
  readonly config: RunnableConfig
  readonly checkpoint: Checkpoint
  readonly parentCheckpointId: string | null
  readonly expectedMessageCount: number
}
interface FunctionRecoveryRecord {
  readonly database: NativeSqliteAdapter
  readonly generation: number
  readonly row: CheckpointRow
  readonly checkpoint: Checkpoint
  readonly expectedMessageCount: number
  readonly verifications: Set<(messages?: readonly BaseMessage[]) => void>
  repairedRow?: CheckpointRow
  active: boolean
}

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

export interface SqlJsSaverSharedConversationRead {
  readonly tuple: CheckpointTuple | undefined
  readonly pendingNamespace?: {
    readonly checkpointId: string
    readonly rawByteCount: number
    readonly writes: readonly { checkpointId: string; taskId: string; index: number
      channel: string; type: string; value: unknown }[]
    assertAdmissionCurrent(): void
    revalidateAdmissionCurrent(): Promise<void>
    assertInputDataCurrent(): void
  }
}
interface SharedCheckpointRawRead {
  row?: CheckpointRow
  writes: WriteRow[]
  snapshots: CheckpointMessageSnapshotRow[]
  bytes: number
  pending: boolean
}
const SHARED_CHECKPOINT_SOURCE_BYTES = 64 * 1024 * 1024
function sharedCheckpointChanged(): never { throw Error("SQLJS_SAVER_SHARED_SOURCE_CHANGED") }
function sharedRawDigest(value: object): string {
  const hash = sharedCreateHash("sha256"), keys = sharedObjectKeys(value)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index], field = sharedDescriptor(value, key)
    if (!field || !("value" in field)) sharedCheckpointChanged()
    const data: unknown = field.value, kind = typeof data
    sharedApply(sharedHashUpdate, hash, [key + "\0"])
    if (sharedIsUint8Array(data)) {
      sharedApply(sharedHashUpdate, hash, ["bytes:"])
      sharedApply(sharedHashUpdate, hash, [data])
    } else if (data === null || kind === "string" || kind === "number" || kind === "boolean" ||
      kind === "bigint" || kind === "undefined")
      sharedApply(sharedHashUpdate, hash, [kind + ":" + sharedString(data)])
    else sharedCheckpointChanged()
    sharedApply(sharedHashUpdate, hash, ["\0"])
  }
  return sharedApply(sharedHashDigest, hash, ["hex"]) as string
}
const sharedDescriptor = Object.getOwnPropertyDescriptor, sharedPrototype = Object.getPrototypeOf
const sharedOwnKeys = Reflect.ownKeys, sharedIsArray = Array.isArray, sharedIsProxy = types.isProxy
const sharedObjectKeys = Object.keys, sharedString = String
const sharedApply = Reflect.apply, sharedIsUint8Array = types.isUint8Array
const preparedWeakMap = WeakMap
const preparedWeakGet = WeakMap.prototype.get, preparedWeakSet = WeakMap.prototype.set,
  preparedWeakDelete = WeakMap.prototype.delete
const preparedPlanDigest = preparedNativeSourcePlanDigest, preparedRowDigest = preparedNativeSnapshotRowDigest
const preparedBytesDigest = preparedNativeStorageBytesDigest
const preparedWorkerRead = readPreparedNativeDataInWorker
const preparedNativeExecution = captureFunctionConversationNativeSqlitePreparedExecution
const preparedStatSync = preparedStat, preparedRealpathSync = preparedRealpath
const preparedLower = String.prototype.toLowerCase, preparedSafeInteger = Number.isSafeInteger
const preparedSort = Array.prototype.sort
const preparedWindows = process.platform === "win32"
const preparedDefine = Object.defineProperty, preparedFreeze = Object.freeze
function appendPreparedData<T>(array: T[], value: T): void {
  const descriptor = { __proto__: null, value, writable: true, enumerable: true, configurable: true }
  preparedDefine(array, array.length, descriptor)
}
const sharedArrayPrototype = Array.prototype, sharedCreateHash = createHash
const sharedHashPrototype = sharedPrototype(sharedCreateHash("sha256"))
const sharedHashUpdate = sharedDescriptor(sharedHashPrototype, "update")!.value
const sharedHashDigest = sharedDescriptor(sharedHashPrototype, "digest")!.value
function sharedSameField(actual: PropertyDescriptor | undefined, expected: PropertyDescriptor | undefined): boolean {
  if (!actual || !expected) return actual === expected
  if (actual.enumerable !== expected.enumerable || actual.configurable !== expected.configurable) return false
  return "value" in actual ? "value" in expected && actual.value === expected.value &&
    actual.writable === expected.writable : !("value" in expected) && actual.get === expected.get && actual.set === expected.set
}
function sharedContainerData(value: unknown): () => void {
  if (!value || typeof value !== "object" || sharedIsProxy(value)) sharedCheckpointChanged()
  const prototype = sharedPrototype(value), keys = sharedOwnKeys(value)
  const fields: PropertyDescriptor[] = []
  for (let index = 0; index < keys.length; index++) {
    const field = sharedDescriptor(value, keys[index])
    if (!field || !("value" in field)) sharedCheckpointChanged()
    appendPreparedData(fields, field)
  }
  return () => {
    if (sharedIsProxy(value) || sharedPrototype(value) !== prototype) sharedCheckpointChanged()
    const actual = sharedOwnKeys(value)
    if (actual.length !== keys.length) sharedCheckpointChanged()
    for (let index = 0; index < keys.length; index++) {
      const field = sharedDescriptor(value, keys[index]), expected = fields[index]
      if (actual[index] !== keys[index] || !field || !("value" in field) ||
        field.value !== expected.value || field.writable !== expected.writable ||
        field.enumerable !== expected.enumerable || field.configurable !== expected.configurable)
        sharedCheckpointChanged()
    }
  }
}
function sharedArrayData(value: unknown): () => void {
  if (value === undefined) return () => undefined
  if (!sharedIsArray(value) || sharedIsProxy(value) || sharedPrototype(value) !== sharedArrayPrototype)
    sharedCheckpointChanged()
  return sharedContainerData(value)
}
function sharedSourceBytes(raw: SharedCheckpointRawRead, bytes: number): void {
  raw.bytes += bytes
  if (!Number.isSafeInteger(raw.bytes) || raw.bytes > SHARED_CHECKPOINT_SOURCE_BYTES)
    sharedCheckpointChanged()
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
function canonicalCheckpointDatabaseKey(dbPath: string): string {
  const absolute = resolve(dbPath)
  return process.platform === "win32" ? absolute.toLowerCase() : absolute
}


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
  /** Size threshold used by explicit/background runMaintenance() calls. */
  maxDatabaseBytes?: number
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
  /** Native conversation recovery only; never falls back to a UI transcript or latest ID. */
  recoverFunctionConversationMessages?: (
    receipt: SqlJsSaverFunctionConversationRecoveryReceipt
  ) => Promise<readonly BaseMessage[]>
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
function preparedOwnData(value: unknown, key: PropertyKey): unknown {
  if (!value || typeof value !== "object" || sharedIsProxy(value))
    throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
  const field = sharedDescriptor(value, key)
  if (!field || !("value" in field)) throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
  return field.value
}
function preparedCompactionBindings(record: CompactionWriteBatchRecord,
  expected: SqlJsSaverCompactionWritesDescriptor | undefined): readonly (readonly unknown[])[] {
  const source = preparedOwnData(record, "source"), operations = preparedOwnData(record, "operations")
  if (!expected || preparedOwnData(record, "phase") !== "attached" ||
    preparedOwnData(source, "threadId") !== expected.threadId ||
    preparedOwnData(source, "namespace") !== expected.namespace ||
    preparedOwnData(source, "checkpointId") !== expected.checkpointId)
    throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
  if (!sharedIsArray(operations)) throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
  const result: (readonly unknown[])[] = []
  const operationCount = preparedOwnData(operations, "length")
  if (typeof operationCount !== "number" || !preparedSafeInteger(operationCount) || operationCount < 0 ||
    operationCount !== expected.operations.length)
    throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
  for (let index = 0; index < operationCount; index++) {
    const operation = preparedOwnData(operations, index), rows = preparedOwnData(operation, "rows")
    const expectedOperation = expected.operations[index]
    if (!sharedIsArray(rows) || preparedOwnData(operation, "taskId") !== expectedOperation.taskId)
      throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
    const rowCount = preparedOwnData(rows, "length")
    if (typeof rowCount !== "number" || !preparedSafeInteger(rowCount) || rowCount < 0 ||
      rowCount !== expectedOperation.rows.length)
      throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
    for (let item = 0; item < rowCount; item++) {
      const row = preparedOwnData(rows, item), value = preparedOwnData(row, "value")
      const expectedRow = expectedOperation.rows[item]
      if (!(typeof value === "string" || sharedIsUint8Array(value)) ||
        preparedOwnData(row, "idx") !== expectedRow.idx ||
        preparedOwnData(row, "channel") !== expectedRow.channel ||
        preparedOwnData(row, "type") !== expectedRow.type ||
        preparedOwnData(row, "bytesDigest") !== expectedRow.bytesDigest ||
        preparedBytesDigest(value) !== expectedRow.bytesDigest)
        throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
      appendPreparedData(result, [preparedOwnData(source, "threadId"), preparedOwnData(source, "namespace"),
        preparedOwnData(source, "checkpointId"), preparedOwnData(operation, "taskId"),
        preparedOwnData(row, "idx"), preparedOwnData(row, "channel"), preparedOwnData(row, "type"),
        value])
    }
  }
  return result
}

interface PreparedDataWindow {
  assertCurrent(): void
  assertRaw(facts: PreparedNativeDataFacts): void
  run(sql: string, bindings?: readonly unknown[]): void
  readParent(checkpointId: string): { count: unknown; generation: unknown } | undefined
}
let originalPreparedWindow: (saver: SqlJsSaver, database: NativeSqliteAdapter,
  threadId: string, namespace: string) => PreparedDataWindow
let originalPreparedLifetime: (saver: SqlJsSaver) => () => void

type SqlJsSaverCloseOutcome =
  | { state: "checkpointed" | "idle" }
  | { state: "skipped"; reason: unknown }

export class SqlJsSaver extends BaseCheckpointSaver {
  static {
    const window = this.prototype.prepareNativeDataWindow, lifetime = this.prototype.captureReadLifetime
    originalPreparedWindow = (saver, database, threadId, namespace) =>
      sharedApply(window, saver, [database, threadId, namespace]) as PreparedDataWindow
    originalPreparedLifetime = saver => sharedApply(lifetime, saver, []) as () => void
  }
  private db: NativeSqliteAdapter | null = null
  private dbPath: string
  private readonly logicalDbPath: string
  private isSetup = false
  private initializePromise: Promise<void> | null = null
  private flushPromise: Promise<unknown | null> | null = null
  private closePromise: Promise<SqlJsSaverCloseOutcome> | null = null
  private commitObserverGeneration = 0
  private readonly committedCheckpointReceipts = new WeakMap<
    SqlJsSaverCommittedCheckpointReceipt, CommittedCheckpointRecord
  >()
  readonly #preparedCheckpointReceipts = new preparedWeakMap<
    SqlJsSaverPreparedCheckpointReceipt, PreparedCheckpointRecord
  >()
  private readonly compactionWriteBatches = new WeakMap<
    SqlJsSaverCompactionWriteBatch, CompactionWriteBatchRecord
  >()
  private activeCompactionWriteBatch?: SqlJsSaverCompactionWriteBatch
  private readonly functionRecoveryReceipts = new WeakMap<
    SqlJsSaverFunctionConversationRecoveryReceipt, FunctionRecoveryRecord
  >()
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
  private recoverFunctionConversationMessages?: SqlJsSaverOptions["recoverFunctionConversationMessages"]
  private checkpointDatabaseKey: string
  private databaseIdentity?: CheckpointDatabaseIdentity
  private pinnedFile?: CheckpointDatabaseFileIdentity
  private schemaWait?: AbortController
  private readonly defaultMetadataSerializer: SerializerProtocol
  private readonly defaultMetadataCodec: () => boolean

  constructor(dbPath: string, serde?: SerializerProtocol, options: SqlJsSaverOptions = {}) {
    super(serde)
    this.defaultMetadataSerializer = this.serde
    this.defaultMetadataCodec = captureDefaultCheckpointMetadataCodec(this.serde)
    this.dbPath = resolve(dbPath)
    this.logicalDbPath = this.dbPath
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
    this.recoverFunctionConversationMessages = options.recoverFunctionConversationMessages
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
    if (this.retired) throw new Error(`[SqlJsSaver] Saver is retired (thread deleted): ${this.dbPath}`)
    if (this.closePromise) throw new Error("SQLJS_SAVER_CLOSING")
    if (checkpointDatabaseMaintenanceIsCurrent(this.checkpointDatabaseKey))
      throw new Error("SQLJS_SAVER_OPERATION_DURING_MAINTENANCE")
    if (this.db && this.isSetup) return
    if (this.initializePromise) return this.initializePromise
    const schemaWait = new AbortController()
    this.schemaWait = schemaWait
    const initializePromise = (async () => {
      const identity = await resolveCheckpointDatabaseIdentity(this.logicalDbPath)
      this.databaseIdentity = identity
      this.dbPath = identity.path
      this.checkpointDatabaseKey = identity.key
      await runCheckpointDatabaseMaintenance(identity.key, async () => {
        if (this.retired) throw new Error(`[SqlJsSaver] Saver is retired (thread deleted): ${this.dbPath}`)
        await assertCheckpointDatabasePathCurrent(identity)
        if (identity.capturedFile) {
          await assertCheckpointDatabaseFileIdentity(identity.path, identity.capturedFile)
        }
        const { database, recovered } = openNativeSqliteDatabase(identity.path, "SqlJsSaver")
        this.db = database
        this.isSetup = false
        try {
          if (identity.capturedFile && !recovered)
            await assertCheckpointDatabaseFileIdentity(identity.path, identity.capturedFile)
          const actual = await resolveCheckpointDatabaseIdentity(identity.path)
          if (actual.key !== identity.key) throw new Error("SQLJS_SAVER_DATABASE_IDENTITY_CHANGED")
          await this.setup()
          await assertCheckpointDatabasePathCurrent(identity)
          // Backup recovery may legitimately replace the original file only during initialization.
          this.pinnedFile = await readCheckpointDatabaseFileIdentity(identity.path)
          if (this.retired) throw new Error(`[SqlJsSaver] Saver is retired (thread deleted): ${this.dbPath}`)
        } catch (error) {
          if (this.db === database) { this.db = null; this.isSetup = false; this.pinnedFile = undefined }
          database.close({ checkpoint: false })
          throw error
        }
      })
    })().finally(() => {
      if (this.initializePromise === initializePromise) this.initializePromise = null
    })
    this.initializePromise = initializePromise
    return initializePromise
  }

  /** The actual DB must be fully ready before joining any namespace's work. */
  private async withDatabaseOperation<T>(
    work: () => Promise<T>,
    exclusive = false,
    ordinaryPutNamespace?: Readonly<{ threadId: string; namespace: string }>,
    onClosing?: (closing: Promise<SqlJsSaverCloseOutcome>) => T
  ): Promise<T> {
    if (exclusive && checkpointDatabaseAdmissionIsCurrent(this.checkpointDatabaseKey))
      throw new Error("SQLJS_SAVER_MAINTENANCE_INSIDE_OPERATION")
    if (this.retired) throw new Error("SQLJS_SAVER_OPERATION_EXPIRED: saver retired")
    if (this.closePromise) throw new Error("SQLJS_SAVER_OPERATION_EXPIRED")
    if (checkpointDatabaseMaintenanceIsCurrent(this.checkpointDatabaseKey))
      throw new Error("SQLJS_SAVER_OPERATION_DURING_MAINTENANCE")
    const entryGeneration = this.commitObserverGeneration
    const releaseLifetime = retainCheckpointDatabaseOperationLifetime(this)
    try {
    await this.initialize()
    const generation = this.commitObserverGeneration, database = this.db, file = this.pinnedFile
    const admittedWork = async () => {
      if (!file) throw new Error("SQLJS_SAVER_DATABASE_IDENTITY_CHANGED")
      const releaseNamespace = ordinaryPutNamespace
        ? await this.acquireCheckpointNamespace(ordinaryPutNamespace.threadId, ordinaryPutNamespace.namespace)
        : undefined
      try {
        // The DB lease and this ordinary put's namespace must precede the final async stat.
        // A later put in the same namespace cannot overtake this filesystem wait.
        await assertCheckpointDatabaseFileIdentity(this.dbPath, file)
        const closing = this.closePromise
        if (onClosing && closing && !this.retired && database && this.db === database &&
          this.pinnedFile === file && this.isSetup &&
          this.commitObserverGeneration === entryGeneration + 1)
          return onClosing(closing)
        if (this.retired || closing || generation !== this.commitObserverGeneration ||
          !database || this.db !== database || this.pinnedFile !== file || !this.isSetup)
          throw new Error("SQLJS_SAVER_OPERATION_EXPIRED")
        return await work()
      } finally { releaseNamespace?.() }
    }
    return exclusive
      ? await runCheckpointDatabaseMaintenance(this.checkpointDatabaseKey, admittedWork)
      : await runCheckpointDatabaseOperation(this.checkpointDatabaseKey, admittedWork, this)
    } finally { releaseLifetime() }
  }

  private retentionLimitForNamespace(checkpointNs: string): number {
    return checkpointNs === "" ? this.maxRootCheckpoints : this.maxNonRootCheckpoints
  }

  private storageWorkerGuard(database: NativeSqliteAdapter,
    file: import("./checkpoint-database-identity").CheckpointDatabaseFileIdentity): () => Promise<void> {
    const generation = this.commitObserverGeneration, identity = this.databaseIdentity
    return async () => {
      const check = () => {
        if (this.retired || this.closePromise || this.db !== database ||
          generation !== this.commitObserverGeneration) throw new Error("SQLJS_SAVER_OPERATION_EXPIRED")
      }
      check()
      if (identity) { await assertCheckpointDatabasePathCurrent(identity); check() }
      await assertCheckpointDatabaseFileIdentity(this.dbPath, file)
      check()
    }
  }

  private async migrateCheckpointSchemaOnce(database: NativeSqliteAdapter): Promise<boolean> {
    database.run(`CREATE TABLE IF NOT EXISTS checkpoint_schema_migrations (
      migration_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    if (!checkpointStorageSchemaNeedsMaintenance(database)) return true
    const applied = database.exec("SELECT 1 FROM checkpoint_schema_migrations WHERE migration_id=?",
      [CHECKPOINT_SCHEMA_MIGRATION_ID])[0]?.values.length
    const nativeCodec = this.serde === this.defaultMetadataSerializer && this.defaultMetadataCodec()
    const backfill = applied || nativeCodec ? [] : await prepareCheckpointMetadataBackfill(database,
      this.serde, () => {
        if (this.retired) throw new Error("SQLJS_SAVER_OPERATION_EXPIRED: saver retired")
        if (this.db !== database) throw new Error("SQLJS_SAVER_OPERATION_EXPIRED")
      })
    const rows = Number(database.exec("SELECT COUNT(*) FROM checkpoints")[0]?.values[0]?.[0] ?? 0)
    if ((nativeCodec && rows > 0) || checkpointStorageMaintenanceBytes(database) > 1024 * 1024) {
      const file = await readCheckpointDatabaseFileIdentity(this.dbPath)
      await maintainCheckpointStorageInWorker(this.dbPath, backfill, nativeCodec && !applied, file,
        this.storageWorkerGuard(database, file), this.schemaWait!.signal)
      await assertCheckpointDatabaseFileIdentity(this.dbPath, file)
      if (checkpointStorageSchemaNeedsMaintenance(database)) throw new Error("CHECKPOINT_STORAGE_MAINTENANCE_INCOMPLETE")
    } else applyCheckpointStorageSchemaMaintenance(database, backfill)
    if (this.retired || this.db !== database) throw new Error("SQLJS_SAVER_OPERATION_EXPIRED")
    return true
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
  ): boolean {
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
    if (checkpointDatabaseAdmissionIsCurrent(this.checkpointDatabaseKey))
      throw new Error("SQLJS_SAVER_MAINTENANCE_INSIDE_OPERATION")
    if (this.retired) throw new Error("SQLJS_SAVER_OPERATION_EXPIRED: saver retired")
    if (this.closePromise) throw new Error("SQLJS_SAVER_CLOSING")
    const releaseLifetime = retainCheckpointDatabaseOperationLifetime(this)
    try {
    await this.initialize()
    const generation = this.commitObserverGeneration
    return await runCheckpointDatabaseMaintenance(this.checkpointDatabaseKey, async () => {
      const file = this.pinnedFile
      if (!file) throw new Error("SQLJS_SAVER_DATABASE_IDENTITY_CHANGED")
      await assertCheckpointDatabaseFileIdentity(this.dbPath, file)
      if (this.retired || this.closePromise || generation !== this.commitObserverGeneration)
        throw new Error("SQLJS_SAVER_OPERATION_EXPIRED")

    if (!this.db || !this.isSetup) throw new Error("Database not initialized")

    const beforeBytes = sqliteFileSize(this.dbPath)
    if (beforeBytes === null || beforeBytes <= this.maxDatabaseBytes) {
      return {
        attempted: false,
        compacted: false,
        beforeBytes,
        afterBytes: beforeBytes
      }
    }

    const compacted = this.compactOversizedLiveDatabase(this.db, beforeBytes)
    return {
      attempted: true,
      compacted,
      beforeBytes,
      afterBytes: sqliteFileSize(this.dbPath)
    }
  
    })
    } finally { releaseLifetime() }
  }

  private async setup(): Promise<void> {
    if (this.isSetup || !this.db) return
    const database = this.db
    if (!checkpointStorageSchemaNeedsMaintenance(database)) { this.isSetup = true; return }
    const nativeCodec = this.serde === this.defaultMetadataSerializer && this.defaultMetadataCodec()
    const hasCheckpoints = database.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoints'")[0]?.values.length
    const rows = hasCheckpoints ? Number(database.exec("SELECT COUNT(*) FROM checkpoints")[0]?.values[0]?.[0] ?? 0) : 0
    if (nativeCodec && rows > 0) {
      const file = await readCheckpointDatabaseFileIdentity(this.dbPath)
      await maintainCheckpointStorageInWorker(this.dbPath, [], true, file,
        this.storageWorkerGuard(database, file), this.schemaWait!.signal)
      await assertCheckpointDatabaseFileIdentity(this.dbPath, file)
      if (checkpointStorageSchemaNeedsMaintenance(database)) throw new Error("CHECKPOINT_STORAGE_MAINTENANCE_INCOMPLETE")
    } else {
      publishCheckpointStorageSchema(database)
      await this.migrateCheckpointSchemaOnce(database)
    }
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
    checkpointId: string,
    sharedRead?: SharedCheckpointRawRead
  ): Promise<HydratedCheckpointMessages> {
    if (!this.db) throw new Error("Database not initialized")

    const targetKey = checkpointMessageCacheKey(threadId, checkpointNs, checkpointId)
    const cachedTarget = this.hydratedCheckpointMessages.get(targetKey)
    if (
      !sharedRead && cachedTarget &&
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
      if (!sharedRead && cached && this.checkpointMessageCacheIsCurrent(threadId, checkpointNs, cursor, cached)) {
        base = cached
        this.rememberHydratedCheckpointMessages(cursorKey, cached)
        break
      }
      if (cached) this.hydratedCheckpointMessages.delete(cursorKey)

      if (sharedRead) {
        if (sharedRead.snapshots.length >= MAX_CHECKPOINT_MESSAGE_SNAPSHOT_DEPTH) sharedCheckpointChanged()
        const header = this.db.prepareReadOne(`SELECT length(CAST(suffix AS BLOB)) AS bytes
          FROM checkpoint_message_snapshots WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`)(
          [threadId, checkpointNs, cursor])
        if (!header) sharedCheckpointChanged()
        sharedSourceBytes(sharedRead, Number(header.bytes))
      }
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
      if (sharedRead) sharedRead.snapshots.push(row)
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
      if (sharedRead) sharedCheckpointChanged()
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
    allowBoundedHistoryRecovery = false,
    sharedRead?: SharedCheckpointRawRead
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
        row.checkpoint_id,
        sharedRead
      )
    } catch (error) {
      if (sharedRead || !(error instanceof MissingCheckpointMessageSnapshotError)) throw error
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

  private isExactFunctionRecoveryRow(row: CheckpointRow, database: NativeSqliteAdapter): boolean {
    return Boolean(database.exec(`SELECT 1 FROM checkpoints
      WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? AND parent_checkpoint_id IS ?
      AND type IS ? AND checkpoint=? AND metadata=? AND COALESCE(fork_boundary_marker,0)=?`, [
      row.thread_id, row.checkpoint_ns, row.checkpoint_id, row.parent_checkpoint_id,
      row.type, row.checkpoint, row.metadata, Number(row.fork_boundary_marker) === 1 ? 1 : 0
    ])[0]?.values.length)
  }

  private assertFunctionRecoveryRecord(receipt: SqlJsSaverFunctionConversationRecoveryReceipt):
    FunctionRecoveryRecord {
    const record = this.functionRecoveryReceipts.get(receipt)
    if (!record) throw new Error("SQLJS_SAVER_RECOVERY_RECEIPT_INVALID")
    if (!record.active || this.retired || this.closePromise || this.db !== record.database ||
      this.commitObserverGeneration !== record.generation ||
      !this.isExactFunctionRecoveryRow(record.repairedRow ?? record.row, record.database))
      throw new Error("SQLJS_SAVER_RECOVERY_RECEIPT_EXPIRED")
    return record
  }

  /** Data copy from the original selected row; never getTuple, initialize or a latest selection. */
  readFunctionConversationRecoveryCheckpoint(receipt: SqlJsSaverFunctionConversationRecoveryReceipt):
    SqlJsSaverFunctionConversationRecoveryCheckpoint {
    const record = this.assertFunctionRecoveryRecord(receipt)
    return { config: { configurable: { thread_id: record.row.thread_id,
      checkpoint_ns: record.row.checkpoint_ns, checkpoint_id: record.row.checkpoint_id } },
      checkpoint: structuredClone(record.checkpoint), parentCheckpointId: record.row.parent_checkpoint_id,
      expectedMessageCount: record.expectedMessageCount }
  }

  /** Native helper's original binding/full-content guard remains live through serde and repair. */
  bindFunctionConversationRecoveryVerification(receipt: SqlJsSaverFunctionConversationRecoveryReceipt,
    verify: (messages?: readonly BaseMessage[]) => void): void {
    const record = this.assertFunctionRecoveryRecord(receipt)
    if (typeof verify !== "function") throw new Error("SQLJS_SAVER_RECOVERY_VERIFICATION_INVALID")
    const returned: unknown = verify()
    if (returned && typeof (returned as { then?: unknown }).then === "function")
      throw new Error("SQLJS_SAVER_RECOVERY_VERIFICATION_ASYNC")
    record.verifications.add(verify)
    this.assertFunctionRecoveryRecord(receipt)
  }

  private async performFunctionConversationMessageRecovery(row: CheckpointRow, checkpoint: Checkpoint,
    expectedMessageCount: number, missing: MissingCheckpointMessageSnapshotError
  ): Promise<HydratedCheckpointMessages> {
    const recover = this.recoverFunctionConversationMessages, database = this.db
    const state = checkpoint.channel_values.cmbFunctionConversation
    if (!recover || !database || !state || typeof state !== "object" || Array.isArray(state))
      throw new CheckpointMessageSnapshotRecoveryError(row.checkpoint_id, { cause: missing })
    const data = state as Record<string, unknown>
    if (Object.keys(data).some(key => !["version", "logicalSessionId", "conversationId", "branchId", "frontier"].includes(key)) ||
      data.version !== 1 || [data.logicalSessionId, data.conversationId, data.branchId].some(value =>
        typeof value !== "string" || !value) || typeof data.frontier !== "number" ||
      !Number.isSafeInteger(data.frontier) || data.frontier < 0 || !Number.isSafeInteger(expectedMessageCount) ||
      expectedMessageCount < 0 || checkpoint.id !== row.checkpoint_id || typeof checkpoint.ts !== "string")
      throw new CheckpointMessageSnapshotRecoveryError(row.checkpoint_id, { cause: missing })
    const receipt = Object.freeze({ [functionRecoveryReceiptBrand]: true as const })
    const record: FunctionRecoveryRecord = { database, generation: this.commitObserverGeneration,
      row: { ...row, checkpoint: typeof row.checkpoint === "string" ? row.checkpoint : row.checkpoint.slice(),
        metadata: typeof row.metadata === "string" ? row.metadata : row.metadata.slice() },
      checkpoint: structuredClone(checkpoint), expectedMessageCount, verifications: new Set(), active: true }
    this.functionRecoveryReceipts.set(receipt, record)
    let verifiedMessages: readonly BaseMessage[] | undefined
    const verify = () => {
      this.assertFunctionRecoveryRecord(receipt)
      if (record.verifications.size === 0) throw new Error("SQLJS_SAVER_RECOVERY_VERIFICATION_REQUIRED")
      for (const guard of record.verifications) {
        const returned: unknown = guard(verifiedMessages)
        if (returned && typeof (returned as { then?: unknown }).then === "function")
          throw new Error("SQLJS_SAVER_RECOVERY_VERIFICATION_ASYNC")
      }
      this.assertFunctionRecoveryRecord(receipt)
    }
    try {
      this.assertFunctionRecoveryRecord(receipt)
      const returned = await recover(receipt)
      if (!Array.isArray(returned) || returned.length !== expectedMessageCount)
        throw new CheckpointMessageSnapshotRecoveryError(row.checkpoint_id, { cause: missing })
      const messages = Array.from(returned)
      verifiedMessages = messages
      verify()
      const preparedCheckpoint = { ...record.checkpoint, channel_values: {
        ...record.checkpoint.channel_values, messages: buildExternalMessagesReference(messages.length)
      } }
      const [[messageType, serializedMessages], [checkpointType, serializedCheckpoint]] = await Promise.all([
        this.serde.dumpsTyped(messages), this.serde.dumpsTyped(preparedCheckpoint)
      ])
      verify()
      const recoveryGeneration = randomUUID()
      try {
        database.run("BEGIN IMMEDIATE")
        verify()
        database.run(`INSERT INTO checkpoint_message_snapshots
          (thread_id,checkpoint_ns,checkpoint_id,parent_checkpoint_id,prefix_length,message_count,generation,type,suffix)
          VALUES (?,?,?,NULL,0,?,?,?,?) ON CONFLICT(thread_id,checkpoint_ns,checkpoint_id) DO UPDATE SET
          parent_checkpoint_id=NULL,prefix_length=0,message_count=excluded.message_count,
          generation=excluded.generation,type=excluded.type,suffix=excluded.suffix`, [
          row.thread_id, row.checkpoint_ns, row.checkpoint_id, messages.length,
          recoveryGeneration, messageType, serializedMessages
        ])
        database.run(`UPDATE checkpoints SET type=?,checkpoint=?
          WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? AND parent_checkpoint_id IS ?
          AND type IS ? AND checkpoint=? AND metadata=? AND COALESCE(fork_boundary_marker,0)=?`, [
          checkpointType, serializedCheckpoint, row.thread_id, row.checkpoint_ns, row.checkpoint_id,
          record.row.parent_checkpoint_id, record.row.type, record.row.checkpoint, record.row.metadata,
          Number(record.row.fork_boundary_marker) === 1 ? 1 : 0
        ])
        if (database.getRowsModified() !== 1) throw new Error("SQLJS_SAVER_RECOVERY_ROW_CHANGED")
        record.repairedRow = { ...record.row, type: checkpointType, checkpoint: serializedCheckpoint }
        verify()
        database.run("COMMIT")
      } catch (error) {
        try { database.run("ROLLBACK") } catch { /* Preserve the original repair failure. */ }
        throw error
      }
      verify()
      const hydrated = { messages, snapshotDepth: 1, deltaBytes: 0, snapshotGeneration: recoveryGeneration }
      this.rememberHydratedCheckpointMessages(
        checkpointMessageCacheKey(row.thread_id, row.checkpoint_ns, row.checkpoint_id), hydrated)
      this.pruneUnreachableMessageSnapshots(row.thread_id, row.checkpoint_ns, database)
      return hydrated
    } catch (error) {
      if (error instanceof CheckpointMessageSnapshotRecoveryError) throw error
      throw new CheckpointMessageSnapshotRecoveryError(row.checkpoint_id, { cause: error })
    } finally {
      record.active = false
      this.functionRecoveryReceipts.delete(receipt)
    }
  }

  private async performMissingCheckpointMessageRecovery(
    row: CheckpointRow,
    checkpoint: Checkpoint,
    expectedMessageCount: number,
    missing: MissingCheckpointMessageSnapshotError,
    allowBoundedHistoryRecovery: boolean
  ): Promise<HydratedCheckpointMessages> {
    if (checkpoint.channel_values.cmbFunctionConversation !== undefined) {
      return this.performFunctionConversationMessageRecovery(row, checkpoint, expectedMessageCount, missing)
    }
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
        checkpointTs: checkpoint.ts
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
      messages: buildExternalMessagesReference(messages.length)
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

  private pruneRootCheckpoints(threadId: string, database: NativeSqliteAdapter): void {
    let transactionStarted = false
    try {
      // The retention snapshot and its deletes must share one writer
      // transaction. Otherwise another saver can commit a new checkpoint after
      // keepIds is computed and the stale NOT IN set will delete that new row.
      database.run("BEGIN IMMEDIATE")
      transactionStarted = true
      const result = database.exec(
        `WITH RECURSIVE snapshot_sizes AS MATERIALIZED (
           SELECT checkpoint_id, parent_checkpoint_id, LENGTH(COALESCE(suffix, '')) AS payload_bytes
           FROM checkpoint_message_snapshots
           WHERE thread_id = ? AND checkpoint_ns = ''
         ), message_chain(
           root_checkpoint_id, checkpoint_id, parent_checkpoint_id, payload_bytes
         ) AS (
           SELECT checkpoint.checkpoint_id,
                  snapshot.checkpoint_id,
                  snapshot.parent_checkpoint_id,
                  snapshot.payload_bytes
           FROM checkpoints AS checkpoint
           JOIN snapshot_sizes AS snapshot
             ON snapshot.checkpoint_id = checkpoint.checkpoint_id
           WHERE checkpoint.thread_id = ? AND checkpoint.checkpoint_ns = ''
           UNION
           SELECT chain.root_checkpoint_id,
                  parent.checkpoint_id,
                  parent.parent_checkpoint_id,
                  parent.payload_bytes
           FROM message_chain AS chain
           JOIN snapshot_sizes AS parent
             ON parent.checkpoint_id = chain.parent_checkpoint_id
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
      if (rows.length <= this.maxRootCheckpoints) {
        database.run("COMMIT")
        transactionStarted = false
        return
      }

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

      if (keepIds.size >= rows.length) {
        database.run("COMMIT")
        transactionStarted = false
        return
      }
      const placeholders = Array.from(keepIds, () => "?").join(", ")
      const params = [threadId, ...keepIds]

      database.run(
        `DELETE FROM writes
         WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id NOT IN (${placeholders})
           AND EXISTS (
             SELECT 1 FROM checkpoints AS checkpoint
             WHERE checkpoint.thread_id = writes.thread_id
               AND checkpoint.checkpoint_ns = writes.checkpoint_ns
               AND checkpoint.checkpoint_id = writes.checkpoint_id
           )`,
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

  flush(): Promise<void> {
    return this.flushCheckpoint(false)
  }

  flushStrict(): Promise<void> {
    return this.flushCheckpoint(true)
  }

  private async flushCheckpoint(strict: boolean): Promise<void> {
    if (checkpointDatabaseMaintenanceIsCurrent(this.checkpointDatabaseKey))
      throw new Error("SQLJS_SAVER_OPERATION_DURING_MAINTENANCE")
    if (this.retired) {
      if (!strict && !this.closePromise && !this.db && !this.initializePromise) return
      throw new Error("SQLJS_SAVER_OPERATION_EXPIRED")
    }
    let closing = this.closePromise
    let generation = this.commitObserverGeneration
    if (!closing) {
      if (!this.db && !this.initializePromise) return
      const result = await this.withDatabaseOperation<
        { closing: Promise<SqlJsSaverCloseOutcome>; generation: number } | undefined
      >(async () => {
        if (strict) while (this.flushPromise) await this.flushPromise
        const failure = await this.ensureFlushCheckpoint()
        if (strict && failure) throw failure
        return undefined
      }, true, undefined, close => ({ closing: close, generation: this.commitObserverGeneration }))
      // The wrapper lets the exclusive gate and physical owner release before joining close.
      if (!result) return
      closing = result.closing
      generation = result.generation
    } else if (checkpointDatabaseAdmissionIsCurrent(this.checkpointDatabaseKey)) {
      throw new Error("SQLJS_SAVER_MAINTENANCE_INSIDE_OPERATION")
    }
    const result = await closing.then(outcome => ({ outcome }), (error: unknown) => ({ error }))
    if (this.retired || generation !== this.commitObserverGeneration)
      throw new Error("SQLJS_SAVER_OPERATION_EXPIRED")
    if ("error" in result) {
      if (strict) throw result.error
      // Best effort: the caller that started close still observes its actual failure.
    } else if (result.outcome.state === "skipped") throw result.outcome.reason
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
        AND projection.checkpoint_ts = COALESCE(checkpoint.checkpoint_ts, checkpoint.checkpoint_id)
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
    const threadId = config.configurable?.thread_id
    const checkpointNs = config.configurable?.checkpoint_ns ?? ""
    if (checkpointDatabaseMaintenanceIsCurrent(this.checkpointDatabaseKey))
      throw new Error("SQLJS_SAVER_OPERATION_DURING_MAINTENANCE")
    if (this.retired || this.closePromise) throw new Error("SQLJS_SAVER_OPERATION_EXPIRED")
    const inheritedAdmission = checkpointDatabaseAdmissionIsCurrent(this.checkpointDatabaseKey)
    const releaseLifetime = retainCheckpointDatabaseOperationLifetime(this)
    const decode = async (row: CheckpointRuntimeProjectionRow): Promise<CheckpointTuple> => {
      const assertCurrent = this.captureReadLifetime()
      const checkpoint = await this.serde.loadsTyped(row.type ?? "json", row.runtime_checkpoint) as Checkpoint
      assertCurrent()
      return {
      config: { configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns,
        checkpoint_id: row.checkpoint_id } },
      checkpoint,
      parentConfig: row.parent_checkpoint_id ? { configurable: {
        thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns,
        checkpoint_id: row.parent_checkpoint_id } } : undefined
      }
    }
    try {
      const selected = await this.withDatabaseOperation(async () => {
        if (typeof threadId !== "string" || !threadId)
          return { complete: true as const, value: undefined }
        const row = this.readLatestRuntimeProjection(threadId, checkpointNs)
        if (row) return { complete: true as const, value: await decode(row) }
        const exists = this.db!.prepareReadOne(`SELECT checkpoint_id FROM checkpoints
          WHERE thread_id=? AND checkpoint_ns=? LIMIT 1`)([threadId, checkpointNs])
        if (!exists) return { complete: true as const, value: undefined }
        if (!this.databaseIdentity || !this.pinnedFile)
          throw new Error("SQLJS_SAVER_DATABASE_IDENTITY_CHANGED")
        return { complete: false as const, threadId, checkpointNs, source: {
          identity: this.databaseIdentity, file: this.pinnedFile,
          assertCurrent: this.captureReadLifetime()
        } }
      })
      if (selected.complete) return selected.value
      // The caller's shared lease cannot be upgraded. Our own short read has already ended;
      // an actual Worker build joins the exclusive database gate with the captured old source.
      if (inheritedAdmission) throw new Error("SQLJS_SAVER_MAINTENANCE_INSIDE_OPERATION")
      await ensureCheckpointRuntimeProjectionInWorker(this.dbPath, selected.threadId,
        selected.checkpointNs, selected.source)
      selected.source.assertCurrent()
      return await this.withDatabaseOperation(async () => {
        selected.source.assertCurrent()
        const row = this.readLatestRuntimeProjection(selected.threadId, selected.checkpointNs)
        if (row) return decode(row)
        const exists = this.db!.prepareReadOne(`SELECT checkpoint_id FROM checkpoints
          WHERE thread_id=? AND checkpoint_ns=? LIMIT 1`)([selected.threadId, selected.checkpointNs])
        if (exists) throw new Error("CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY")
        return undefined
      })
    } finally { releaseLifetime() }
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.withDatabaseOperation(async () => {
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
  
    })
  }

  /** One original SDK read plus bounded pending-source facts; these facts grant no target. */
  async getTupleForSharedConversation(config: RunnableConfig): Promise<SqlJsSaverSharedConversationRead> {
    const configurable = config.configurable
    const threadId = configurable?.thread_id, namespace = configurable?.checkpoint_ns ?? ""
    const checkpointId = configurable?.checkpoint_id
    const fixed = { configurable: { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: checkpointId } }
    return this.withDatabaseOperation(async () => {
      if (typeof threadId !== "string" || !threadId || typeof namespace !== "string")
        return { tuple: await this.getTupleUnlocked(fixed) }
      const release = await this.acquireCheckpointNamespace(threadId, namespace)
      try {
        const database = this.db, file = this.pinnedFile
        if (!database || !file) sharedCheckpointChanged()
        const lifetime = SqlJsSaver.prototype.captureReadLifetime.call(this)
        const fileCurrent = this.storageWorkerGuard(database, file)
        const lifeKeys = ["db", "pinnedFile", "isSetup", "retired", "closePromise", "commitObserverGeneration", "serde"] as const
        const lifeFields = lifeKeys.map(key => {
          const field = sharedDescriptor(this, key)
          if (!field || !("value" in field)) sharedCheckpointChanged()
          return field
        })
        const nativeSerializer = this.serde === this.defaultMetadataSerializer && this.defaultMetadataCodec()
        const serializerData = nativeSerializer ? sharedContainerData(this.serde) : () => undefined
        const serializerPrototypeData = nativeSerializer
          ? sharedContainerData(sharedPrototype(this.serde)) : () => undefined
        const checkLifetimeData = () => {
          for (let index = 0; index < lifeKeys.length; index++)
            if (!sharedSameField(sharedDescriptor(this, lifeKeys[index]), lifeFields[index])) sharedCheckpointChanged()
          lifetime()
        }
        const checkPendingCodec = () => {
          if (!nativeSerializer) sharedCheckpointChanged()
          serializerData(); serializerPrototypeData()
        }
        const raw: SharedCheckpointRawRead = { row: undefined, writes: [], snapshots: [], bytes: 0, pending: false }
        const tuple = await this.getTupleUnlocked(fixed, false, raw)
        checkLifetimeData()
        if (!tuple || !raw.pending) return { tuple }
        if (!raw.row) sharedCheckpointChanged()
        checkPendingCodec()
        const execution = preparedNativeExecution(database)
        if (!execution) sharedCheckpointChanged()
        execution.assertDataCurrent(true)
        const sourceRow = raw.row, selected = tuple.checkpoint.id
        const rowSql = `SELECT thread_id,checkpoint_ns,checkpoint_id,parent_checkpoint_id,type,
          checkpoint,metadata,fork_boundary_marker FROM main.checkpoints
          WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`
        const writesSql = `SELECT checkpoint_id,task_id,idx,channel,type,value FROM main.writes
          WHERE thread_id=? AND checkpoint_ns=? ORDER BY checkpoint_id,task_id,idx`
        const counts = execution.prepareReadOne(`SELECT
          (SELECT COUNT(*) FROM main.checkpoints WHERE thread_id=? AND checkpoint_ns=?) AS points,
          COUNT(*) AS count,COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes
          FROM main.writes WHERE thread_id=? AND checkpoint_ns=?`)
        const summary = counts([threadId, namespace, threadId, namespace])
        if (!summary || summary.points !== 1 || typeof summary.count !== "number" ||
          !preparedSafeInteger(summary.count) || summary.count < 0 || summary.count > 64 ||
          typeof summary.bytes !== "number" || !preparedSafeInteger(summary.bytes) || summary.bytes < 0)
          sharedCheckpointChanged()
        sharedSourceBytes(raw, summary.bytes)
        const namespaceRead = execution.prepareReadOne(writesSql + " LIMIT 1 OFFSET ?")
        const records: Record<string, unknown>[] = [], originalWrites: string[] = []
        const selectedDigests: string[] = [], decodedDigests: string[] = []
        const writeDigest = (value: Record<string, unknown>) => sharedRawDigest({
          task_id: value.task_id, channel: value.channel, type: value.type, value: value.value })
        for (let index = 0; index < summary.count; index++) {
          const row = namespaceRead([threadId, namespace, index])
          if (!row) sharedCheckpointChanged()
          appendPreparedData(records, row)
          appendPreparedData(originalWrites, sharedRawDigest(row))
          if (row.checkpoint_id === selected) appendPreparedData(selectedDigests, writeDigest(row))
        }
        for (let index = 0; index < raw.writes.length; index++)
          appendPreparedData(decodedDigests, writeDigest(raw.writes[index] as unknown as Record<string, unknown>))
        sharedApply(preparedSort, selectedDigests, [])
        sharedApply(preparedSort, decodedDigests, [])
        if (selectedDigests.length !== decodedDigests.length) sharedCheckpointChanged()
        for (let index = 0; index < selectedDigests.length; index++)
          if (selectedDigests[index] !== decodedDigests[index]) sharedCheckpointChanged()
        const rowRead = execution.prepareReadOne(rowSql)
        const snapshotRead = execution.prepareReadOne(
          `SELECT checkpoint_id,parent_checkpoint_id,prefix_length,message_count,generation,type,suffix
          FROM main.checkpoint_message_snapshots WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`)
        const snapshots: { checkpointId: string; digest: string }[] = []
        for (let index = 0; index < raw.snapshots.length; index++) {
          const row = raw.snapshots[index]
          appendPreparedData(snapshots, { checkpointId: row.checkpoint_id, digest: sharedRawDigest(row) })
        }
        const originalRowDigest = sharedRawDigest(sourceRow)
        const assertAdmissionCurrent = () => {
          checkLifetimeData(); checkPendingCodec()
          execution.assertDataCurrent(true)
          const current = rowRead([threadId, namespace, selected])
          const currentSummary = counts([threadId, namespace, threadId, namespace])
          if (!current || sharedRawDigest(current) !== originalRowDigest || !currentSummary ||
            currentSummary.points !== 1 || currentSummary.count !== records.length ||
            currentSummary.bytes !== summary.bytes) sharedCheckpointChanged()
          for (let index = 0; index < records.length; index++) {
            const value = namespaceRead([threadId, namespace, index])
            if (!value || sharedRawDigest(value) !== originalWrites[index]) sharedCheckpointChanged()
          }
          for (let index = 0; index < snapshots.length; index++) {
            const snapshot = snapshots[index]
            const currentSnapshot = snapshotRead([threadId, namespace, snapshot.checkpointId])
            if (!currentSnapshot || sharedRawDigest(currentSnapshot) !== snapshot.digest) sharedCheckpointChanged()
          }
          checkLifetimeData(); checkPendingCodec()
        }
        assertAdmissionCurrent()
        const decoded = [] as { checkpointId: string; taskId: string; index: number
          channel: string; type: string; value: unknown }[]
        for (let index = 0; index < records.length; index++) {
          const row = records[index]
          if (typeof row.checkpoint_id !== "string" || typeof row.task_id !== "string" ||
            typeof row.channel !== "string" || typeof row.idx !== "number" ||
            !(typeof row.value === "string" || sharedIsUint8Array(row.value))) sharedCheckpointChanged()
          let existing: NonNullable<CheckpointTuple["pendingWrites"]>[number] | undefined
          if (row.checkpoint_id === selected && tuple.pendingWrites) {
            for (let item = 0; item < tuple.pendingWrites.length; item++) {
              const candidate = tuple.pendingWrites[item]
              if (candidate[0] === row.task_id && candidate[1] === row.channel) { existing = candidate; break }
            }
          }
          const value = existing ? existing[2] : await this.serde.loadsTyped(
            typeof row.type === "string" ? row.type : "json", row.value)
          appendPreparedData(decoded, preparedFreeze({ checkpointId: row.checkpoint_id,
            taskId: row.task_id, index: row.idx, channel: row.channel,
            type: typeof row.type === "string" ? row.type : "json", value }))
        }
        assertAdmissionCurrent()
        const savedCheckpoint = tuple.checkpoint, savedChannels = savedCheckpoint.channel_values
        const savedMessages = savedChannels.messages, pending = tuple.pendingWrites
        const arrays = [sharedContainerData(tuple), sharedContainerData(savedCheckpoint),
          sharedContainerData(savedChannels), sharedArrayData(savedMessages), sharedArrayData(pending)]
        if (pending) for (let index = 0; index < pending.length; index++) {
          const pair = pending[index]
          appendPreparedData(arrays, sharedArrayData(pair))
          if (sharedIsArray(pair[2])) appendPreparedData(arrays, sharedArrayData(pair[2]))
        }
        const assertInputDataCurrent = () => {
          for (let index = 0; index < arrays.length; index++) arrays[index]()
        }
        return { tuple, pendingNamespace: preparedFreeze({ checkpointId: selected, rawByteCount: raw.bytes,
          writes: preparedFreeze(decoded), assertAdmissionCurrent,
          assertInputDataCurrent, revalidateAdmissionCurrent: async () => {
            checkLifetimeData(); await fileCurrent(); assertAdmissionCurrent(); assertInputDataCurrent()
          } }) }
      } finally { release() }
    })
  }

  /** Cold legacy migration must authenticate disk history, not an exposed mutable read cache. */
  async getExactTupleForLegacyMigration(config: RunnableConfig): Promise<{
    tuple: CheckpointTuple | undefined; assertCurrent(): void
  }> {
    const fixed = { ...config, configurable: { ...config.configurable } }
    const { thread_id: threadId, checkpoint_id: checkpointId, checkpoint_ns: namespace = "" } =
      fixed.configurable
    if (typeof threadId !== "string" || !threadId ||
      typeof checkpointId !== "string" || !checkpointId)
      throw new Error("SQLJS_SAVER_LEGACY_CHECKPOINT_REQUIRED")
    return this.withDatabaseOperation(async () => {
    const release = await this.acquireCheckpointNamespace(threadId, namespace)
    try {
      await this.initialize()
      const lifetime = SqlJsSaver.prototype.captureReadLifetime.call(this)
      const execution = readFunctionConversationNativeSqliteCurrentExecution(this.db)
      if (!execution) throw new Error("SQLJS_SAVER_LEGACY_CHECKPOINT_CHANGED")
      const read = execution.prepareReadOne(`SELECT total_changes() AS changes,
        (SELECT data_version FROM pragma_data_version) AS version`)
      const before = read()
      const assertCurrent = () => {
        lifetime()
        execution.assertDataCurrent()
        const after = read()
        if (!before || !after || after.changes !== before.changes || after.version !== before.version)
          throw new Error("SQLJS_SAVER_LEGACY_CHECKPOINT_CHANGED")
        lifetime()
      }
      this.hydratedCheckpointMessages.clear()
      const tuple = await this.getTupleUnlocked(fixed)
      assertCurrent()
      return { tuple, assertCurrent }
    } finally { release() }
  
    })
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
    return this.withDatabaseOperation(async () => {
    const release = await this.acquireCheckpointNamespace(threadId, "")
    try {
      return await this.getTupleUnlocked(
        { configurable: { thread_id: threadId, checkpoint_ns: "" } },
        true
      )
    } finally {
      release()
    }
  
    })
  }

  private async getTupleUnlocked(
    config: RunnableConfig,
    allowBoundedHistoryRecovery = false,
    sharedRead?: SharedCheckpointRawRead
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
    if (sharedRead) sharedRead.row = row

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
      if (sharedRead) sharedRead.writes.push(write)
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
    if (sharedRead) {
      sharedRead.pending = serializedCheckpoint.channel_values.cmbFunctionConversation === undefined &&
        pendingWrites.some(([, channel]) => channel === "cmbFunctionConversation")
      if (sharedRead.pending) {
        if (this.serde !== this.defaultMetadataSerializer || !this.defaultMetadataCodec()) sharedCheckpointChanged()
        sharedSourceBytes(sharedRead, serializedPayloadBytes(row.checkpoint) + serializedPayloadBytes(row.metadata))
      }
    }
    const checkpoint = await this.hydrateCheckpointMessages(
      row,
      serializedCheckpoint,
      allowBoundedHistoryRecovery,
      sharedRead?.pending ? sharedRead : undefined
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

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const tuples = await this.withDatabaseOperation(async () => {
      const collected: CheckpointTuple[] = []
      for await (const tuple of this.listWithinDatabaseOperation(config, options)) collected.push(tuple)
      return collected
    })
    yield* tuples
  }

  private async *listWithinDatabaseOperation(
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
    const configurable = config.configurable
    const threadId = configurable?.thread_id
    if (typeof threadId !== "string" || !threadId)
      return this.withDatabaseOperation(() => this.putUnlocked(config, checkpoint, metadata))
    // The namespace lease and its SQL use the same routing fields captured before any await.
    const namespace = configurable?.checkpoint_ns ?? ""
    const fixedConfig: RunnableConfig = { configurable: {
      thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: configurable?.checkpoint_id
    } }
    return this.withDatabaseOperation(() => this.putUnlocked(fixedConfig, checkpoint, metadata),
      false, { threadId, namespace })
  }

  /**
   * One native namespace admission through COMMIT, exact read and actual observer finally.
   * Ordinary put intentionally keeps its existing path and cost.
   */
  async putWithCommitObserver(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    observer: SqlJsSaverCommitObserver,
    assertCurrent?: () => void,
    onCommitted?: () => void,
    onPrepared?: SqlJsSaverPreparedCheckpointObserver,
    onPreparedData?: SqlJsSaverPreparedCheckpointObserver
  ): Promise<RunnableConfig> {
    const configurable = { ...config.configurable }
    const threadId = configurable.thread_id
    const namespace = configurable.checkpoint_ns ?? ""
    const parentId = configurable.checkpoint_id
    const snapshot = copyCheckpoint(checkpoint)
    const checkpointId = snapshot.id
    if (typeof threadId !== "string" || !threadId || typeof namespace !== "string" ||
      (parentId !== undefined && (typeof parentId !== "string" || !parentId)) ||
      typeof checkpointId !== "string" || !checkpointId || typeof observer !== "function")
      throw new Error("SQLJS_SAVER_COMMIT_SCOPE_INVALID")
    // Preserve native message objects while fixing channel containers before the first await.
    for (const [key, value] of Object.entries(snapshot.channel_values)) {
      if (Array.isArray(value)) snapshot.channel_values[key] = value.slice()
      else if (value && typeof value === "object" &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
        snapshot.channel_values[key] = { ...value }
    }
    const fixedConfig: RunnableConfig = { ...config, configurable: {
      ...configurable, thread_id: threadId, checkpoint_ns: namespace
    } }
    const fixedMetadata = { ...metadata, parents: { ...metadata.parents } }
    const generation = this.commitObserverGeneration
    if (this.retired || this.closePromise) throw new Error("SQLJS_SAVER_COMMIT_RECEIPT_EXPIRED")
    assertCurrent?.()
    return this.withDatabaseOperation(async () => {
    const release = await this.acquireCheckpointNamespace(threadId, namespace)
    let receipt: SqlJsSaverCommittedCheckpointReceipt | undefined
    let record: CommittedCheckpointRecord | undefined
    const assertDatabase = (database?: NativeSqliteAdapter) => {
      if (this.retired || this.closePromise || generation !== this.commitObserverGeneration ||
        (database && this.db !== database))
        throw new Error("SQLJS_SAVER_COMMIT_RECEIPT_EXPIRED")
    }
    const yieldPhase = nativeConversationFairness(undefined, () => assertDatabase())
    try {
      assertDatabase()
      await this.initialize()
      assertDatabase()
      const database = this.db
      if (!database) throw new Error("SQLJS_SAVER_COMMIT_RECEIPT_EXPIRED")
      let preparedDescriptor: SqlJsSaverPreparedCheckpointDescriptor | undefined
      let preparedWrites: SqlJsSaverCompactionWritesDescriptor | undefined
      const preparing = onPrepared ? async (receipt: SqlJsSaverPreparedCheckpointReceipt) => {
        const original = SqlJsSaver.prototype.readPreparedCheckpoint.call(this, receipt)
        await onPrepared(receipt)
        if (SqlJsSaver.prototype.readPreparedCheckpoint.call(this, receipt) !== original)
          throw new Error("SQLJS_SAVER_PREPARED_RECEIPT_INVALID")
        preparedDescriptor = original
        preparedWrites = (sharedApply(preparedWeakGet, this.#preparedCheckpointReceipts, [receipt]) as PreparedCheckpointRecord | undefined)?.sourceWrites?.descriptor
      } : undefined
      const result = await this.putUnlocked(fixedConfig, snapshot, fixedMetadata, assertCurrent,
        onCommitted, preparing, onPreparedData)
      // COMMIT and bookkeeping are complete. Keep the gate through the pause and observer;
      // cancellation after COMMIT must not skip its ACK. Always yield here: a fast put can
      // precede an expensive observer, whose work is outside this operation's budget check.
      await yieldPhase(true)
      assertDatabase(database)
      if (result.configurable?.thread_id !== threadId ||
        (result.configurable?.checkpoint_ns ?? "") !== namespace ||
        result.configurable?.checkpoint_id !== checkpointId)
        throw new Error("SQLJS_SAVER_COMMIT_SCOPE_INVALID")
      const exact: RunnableConfig = Object.freeze({ configurable: Object.freeze({
        thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: checkpointId
      }) })
      // Public getTuple would acquire our own held gate and deadlock.
      const tuple = await this.getTupleUnlocked(exact)
      assertDatabase(database)
      if (!tuple || tuple.checkpoint.id !== checkpointId ||
        tuple.config.configurable?.thread_id !== threadId ||
        (tuple.config.configurable?.checkpoint_ns ?? "") !== namespace ||
        tuple.config.configurable?.checkpoint_id !== checkpointId)
        throw new Error("SQLJS_SAVER_COMMIT_CHECKPOINT_MISSING")
      receipt = Object.freeze({ [committedCheckpointReceiptBrand]: true as const })
      record = { database, generation, config: exact, tuple, active: true,
        prepared: preparedDescriptor, sourceWrites: preparedWrites }
      this.committedCheckpointReceipts.set(receipt, record)
      await observer(receipt)
      SqlJsSaver.prototype.readCommittedCheckpoint.call(this, receipt)
      return result
    } finally {
      if (record) record.active = false
      if (receipt) this.committedCheckpointReceipts.delete(receipt)
      release()
    }
  
    })
  }

  /** Exact cached tuple only; never accepts an ID/config or borrows a later database. */
  readCommittedCheckpoint(receipt: SqlJsSaverCommittedCheckpointReceipt): CheckpointTuple {
    const record = this.committedCheckpointReceipts.get(receipt)
    if (!record) throw new Error("SQLJS_SAVER_COMMIT_RECEIPT_INVALID")
    if (!record.active || this.retired || this.closePromise || this.db !== record.database ||
      this.commitObserverGeneration !== record.generation)
      throw new Error("SQLJS_SAVER_COMMIT_RECEIPT_EXPIRED")
    if (record.tuple.checkpoint.id !== record.config.configurable?.checkpoint_id ||
      record.tuple.config !== record.config)
      throw new Error("SQLJS_SAVER_COMMIT_SCOPE_INVALID")
    return record.tuple
  }

  /** Only the actual Saver's active pre-COMMIT callback can read its sealed serialization. */
  readPreparedCheckpoint(receipt: SqlJsSaverPreparedCheckpointReceipt): SqlJsSaverPreparedCheckpointDescriptor {
    const record = (sharedApply(preparedWeakGet, this.#preparedCheckpointReceipts, [receipt]) as PreparedCheckpointRecord | undefined)
    if (!record || !record.active || this.retired || this.closePromise ||
      this.db !== record.database || this.commitObserverGeneration !== record.generation)
      throw new Error("SQLJS_SAVER_PREPARED_RECEIPT_INVALID")
    if (!record.descriptor) throw new Error("SQLJS_SAVER_PREPARED_RECEIPT_INVALID")
    return record.descriptor
  }

  /** Only the active data callback may inspect its own fixed input, never a supplied tuple. */
  readPreparedConversationData(receipt: SqlJsSaverPreparedCheckpointReceipt): CheckpointTuple {
    const record = (sharedApply(preparedWeakGet, this.#preparedCheckpointReceipts, [receipt]) as PreparedCheckpointRecord | undefined)
    if (!record?.active || !record.data) throw Error("SQLJS_SAVER_PREPARED_DATA_INVALID")
    // The original record first verifies own-data lifetime fields without invoking a getter.
    record.data.assertCurrent()
    if (this.db !== record.database || this.retired || this.closePromise ||
      this.commitObserverGeneration !== record.generation) throw Error("SQLJS_SAVER_PREPARED_DATA_INVALID")
    return record.data.tuple
  }

  /** Isolated original-codec facts; the client waits its real physical final/exit on every path. */
  async readPreparedConversationDataFacts(receipt: SqlJsSaverPreparedCheckpointReceipt, signal?: AbortSignal):
    Promise<PreparedNativeDataFacts> {
    readSqlJsSaverPreparedConversationData(this, receipt)
    const record = (sharedApply(preparedWeakGet, this.#preparedCheckpointReceipts, [receipt]) as PreparedCheckpointRecord | undefined)!, data = record.data!
    const identity = this.databaseIdentity, file = this.pinnedFile
    if (!identity || !file) throw Error("SQLJS_SAVER_PREPARED_DATA_INVALID")
    const current = () => {
      if ((sharedApply(preparedWeakGet, this.#preparedCheckpointReceipts, [receipt]) as PreparedCheckpointRecord | undefined) !== record)
        throw Error("SQLJS_SAVER_PREPARED_DATA_INVALID")
      readSqlJsSaverPreparedConversationData(this, receipt)
    }
    const config = data.tuple.config.configurable!
    const facts = await preparedWorkerRead(identity.path, sharedString(config.thread_id),
      sharedString(config.checkpoint_ns ?? ""), data.tuple.checkpoint.id, {
        checkpointSource: { identity, file, assertCurrent: current }, signal,
        readSource: () => data.source
      })
    current()
    if (facts.sealedPlanDigest !== data.planDigest) throw Error("SQLJS_SAVER_PREPARED_DATA_CHANGED")
    data.assertRaw(facts)
    record.data!.facts = facts
    return facts
  }

  /** The ordinary Saver still permits overwrites. Host compaction requires a fresh destination. */
  assertPreparedCheckpointFreshDestination(receipt: SqlJsSaverPreparedCheckpointReceipt): void {
    SqlJsSaver.prototype.readPreparedCheckpoint.call(this, receipt)
    if ((sharedApply(preparedWeakGet, this.#preparedCheckpointReceipts, [receipt]) as PreparedCheckpointRecord | undefined)!.destinationExisted)
      throw Error("SQLJS_SAVER_COMPACTION_DESTINATION_EXISTS")
  }

  /** One private idle SDK transaction. Ordinary putWrites never enters this staging area. */
  createCompactionWriteBatch(config: RunnableConfig, assertSource: () => void): SqlJsSaverCompactionWriteBatch {
    const point = config.configurable
    if (!this.db || !this.isSetup || this.retired || this.closePromise ||
      this.activeCompactionWriteBatch || typeof point?.thread_id !== "string" ||
      typeof point.checkpoint_id !== "string" || !point.checkpoint_id ||
      typeof (point.checkpoint_ns ?? "") !== "string")
      throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
    assertSource()
    const batch = Object.freeze({ [compactionWriteBatchBrand]: true as const })
    this.compactionWriteBatches.set(batch, { database: this.db, generation: this.commitObserverGeneration,
      source: { threadId: point.thread_id, namespace: point.checkpoint_ns ?? "",
        checkpointId: point.checkpoint_id }, assertSource, operations: [], phase: "collecting", descriptor: undefined })
    this.activeCompactionWriteBatch = batch
    return batch
  }

  private compactionBatch(batch: SqlJsSaverCompactionWriteBatch): CompactionWriteBatchRecord {
    const record = this.compactionWriteBatches.get(batch)
    if (!record || record.phase === "expired" || this.activeCompactionWriteBatch !== batch ||
      this.retired || this.closePromise || this.db !== record.database ||
      this.commitObserverGeneration !== record.generation)
      throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
    return record
  }

  async stageCompactionWrites(batch: SqlJsSaverCompactionWriteBatch, config: RunnableConfig,
    writes: PendingWrite[], taskId: string): Promise<void> {
    const point = { ...config.configurable }, fixed = writes.map(([channel, value]) => [channel, value] as const)
    const record = this.compactionBatch(batch)
    if (record.phase !== "collecting" || typeof taskId !== "string" ||
      point.thread_id !== record.source.threadId || (point.checkpoint_ns ?? "") !== record.source.namespace ||
      point.checkpoint_id !== record.source.checkpointId)
      throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
    record.assertSource()
    await this.withDatabaseOperation(async () => {
      const release = await this.acquireCheckpointNamespace(record.source.threadId, record.source.namespace)
      try {
        const serialized = await Promise.allSettled(fixed.map(async ([channel, value], idx) => {
          record.assertSource()
          const [type, raw] = await this.serde.dumpsTyped(value)
          this.compactionBatch(batch)
          record.assertSource()
          const owned = typeof raw === "string" ? raw : Uint8Array.from(raw)
          return { idx, channel, type, value: owned, bytesDigest: checkpointBytesDigest(owned) }
        }))
        const failed = serialized.find(result => result.status === "rejected")
        if (failed?.status === "rejected") throw failed.reason
        const rows = serialized.map(result => {
          if (result.status !== "fulfilled") throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
          return result.value
        })
        this.compactionBatch(batch)
        record.assertSource()
        if (record.phase !== "collecting") throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
        record.operations.push({ taskId, rows })
      } finally { release() }
    })
  }

  /** The installed SDK has no read between source putWrites and destination put. Fail closed
   * if a future SDK tries to interpret staged rows as already committed native evidence. */
  assertCompactionWriteBatchReadable(batch: SqlJsSaverCompactionWriteBatch): void {
    const record = this.compactionWriteBatches.get(batch)
    if (!record) throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
    if ((record.phase === "collecting" || record.phase === "attached") && record.operations.length)
      throw Error("SQLJS_SAVER_COMPACTION_STAGED_READ")
  }

  bindPreparedCompactionWrites(receipt: SqlJsSaverPreparedCheckpointReceipt,
    batch: SqlJsSaverCompactionWriteBatch): SqlJsSaverCompactionWritesDescriptor {
    const checkpoint = SqlJsSaver.prototype.readPreparedCheckpoint.call(this, receipt)
    const record = this.compactionBatch(batch)
    if (record.phase !== "collecting" || checkpoint.threadId !== record.source.threadId ||
      checkpoint.namespace !== record.source.namespace || checkpoint.parentCheckpointId !== record.source.checkpointId)
      throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
    record.assertSource()
    const actualOperations = preparedOwnData(record, "operations")
    if (!sharedIsArray(actualOperations)) throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
    const operationCount = preparedOwnData(actualOperations, "length")
    if (typeof operationCount !== "number" || !preparedSafeInteger(operationCount) || operationCount < 0)
      throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
    const operations: SqlJsSaverCompactionWritesDescriptor["operations"][number][] = []
    for (let index = 0; index < operationCount; index++) {
      const actual = preparedOwnData(actualOperations, index), actualRows = preparedOwnData(actual, "rows")
      const taskId = preparedOwnData(actual, "taskId")
      if (!sharedIsArray(actualRows) || typeof taskId !== "string")
        throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
      const rowCount = preparedOwnData(actualRows, "length")
      if (typeof rowCount !== "number" || !preparedSafeInteger(rowCount) || rowCount < 0)
        throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
      const rows: SqlJsSaverCompactionWritesDescriptor["operations"][number]["rows"][number][] = []
      for (let item = 0; item < rowCount; item++) {
        const row = preparedOwnData(actualRows, item), idx = preparedOwnData(row, "idx")
        const channel = preparedOwnData(row, "channel"), type = preparedOwnData(row, "type")
        const bytesDigest = preparedOwnData(row, "bytesDigest")
        if (typeof idx !== "number" || !preparedSafeInteger(idx) || typeof channel !== "string" ||
          typeof type !== "string" || typeof bytesDigest !== "string")
          throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
        appendPreparedData(rows, preparedFreeze({ idx, channel, type, bytesDigest }))
      }
      appendPreparedData(operations, preparedFreeze({ taskId, rows: preparedFreeze(rows) }))
    }
    const source = preparedOwnData(record, "source"), threadId = preparedOwnData(source, "threadId")
    const namespace = preparedOwnData(source, "namespace"), checkpointId = preparedOwnData(source, "checkpointId")
    if (typeof threadId !== "string" || typeof namespace !== "string" || typeof checkpointId !== "string")
      throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
    const content = { version: 1 as const, threadId, namespace, checkpointId,
      operations: preparedFreeze(operations) }
    record.descriptor = preparedFreeze({ ...content,
      digest: createHash("sha256").update(JSON.stringify(content)).digest("hex") })
    record.phase = "attached"
    const destinationRecord = sharedApply(preparedWeakGet, this.#preparedCheckpointReceipts,
      [receipt]) as PreparedCheckpointRecord
    destinationRecord.sourceWrites = record
    return record.descriptor
  }

  releaseCompactionWriteBatch(batch: SqlJsSaverCompactionWriteBatch): void {
    const record = this.compactionWriteBatches.get(batch)
    if (!record) throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
    record.phase = "expired"
    record.operations.length = 0
    if (this.activeCompactionWriteBatch === batch) this.activeCompactionWriteBatch = undefined
  }

  readCommittedCompactionWrites(receipt: SqlJsSaverCommittedCheckpointReceipt):
    SqlJsSaverCompactionWritesDescriptor {
    SqlJsSaver.prototype.readCommittedCheckpoint.call(this, receipt)
    const descriptor = this.committedCheckpointReceipts.get(receipt)?.sourceWrites
    if (!descriptor) throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
    return descriptor
  }

  captureCommittedCheckpointDataFence(receipt: SqlJsSaverCommittedCheckpointReceipt): () => void {
    SqlJsSaver.prototype.readCommittedCheckpoint.call(this, receipt)
    const lifetime = SqlJsSaver.prototype.captureReadLifetime.call(this)
    const execution = readFunctionConversationNativeSqliteCurrentExecution(this.db)
    if (!execution) throw Error("SQLJS_SAVER_COMMIT_SCOPE_INVALID")
    const read = execution.prepareReadOne(`SELECT total_changes() AS changes,
      (SELECT data_version FROM pragma_data_version) AS version`), before = read()
    return () => {
      lifetime()
      execution.assertDataCurrent()
      const after = read()
      if (!before || !after || before.changes !== after.changes || before.version !== after.version)
        throw Error("SQLJS_SAVER_COMMIT_SCOPE_INVALID")
    }
  }

  /** Actual row readback, not a replay. A retained source must have precisely the original
   * OR REPLACE result; legitimate retention may remove both the source and its writes. */
  async verifyCompactionWrites(descriptor: SqlJsSaverCompactionWritesDescriptor,
    source: SqlJsSaverPreparedCheckpointDescriptor,
    receipt?: SqlJsSaverCommittedCheckpointReceipt): Promise<void> {
    if (!descriptor || descriptor.version !== 1 || !Array.isArray(descriptor.operations) ||
      descriptor.operations.some(operation => !operation || typeof operation.taskId !== "string" ||
        !Array.isArray(operation.rows) || operation.rows.some(row => !row ||
          !Number.isSafeInteger(row.idx) || row.idx < 0 || typeof row.channel !== "string" ||
          typeof row.type !== "string" || typeof row.bytesDigest !== "string")))
      throw Error("SQLJS_SAVER_COMPACTION_WRITES_CHANGED")
    const fixed = JSON.parse(JSON.stringify(descriptor)) as SqlJsSaverCompactionWritesDescriptor
    const sourceFixed = JSON.parse(JSON.stringify(source)) as SqlJsSaverPreparedCheckpointDescriptor
    const { digest, ...content } = fixed
    if (fixed.version !== 1 || fixed.threadId !== source.threadId || fixed.namespace !== source.namespace ||
      fixed.checkpointId !== source.checkpointId || createHash("sha256").update(JSON.stringify(content))
        .digest("hex") !== digest) throw Error("SQLJS_SAVER_COMPACTION_WRITES_CHANGED")
    await this.withDatabaseOperation(async () => {
      let release: (() => void) | undefined
      if (receipt) {
        SqlJsSaver.prototype.readCommittedCheckpoint.call(this, receipt)
        const committed = this.committedCheckpointReceipts.get(receipt)
        if (!committed?.prepared || committed.config.configurable?.thread_id !== fixed.threadId ||
          (committed.config.configurable?.checkpoint_ns ?? "") !== fixed.namespace ||
          committed.prepared.parentCheckpointId !== fixed.checkpointId ||
          JSON.stringify(committed.sourceWrites) !== JSON.stringify(fixed))
          throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
      } else release = await this.acquireCheckpointNamespace(fixed.threadId, fixed.namespace)
      try {
      const execution = readFunctionConversationNativeSqliteCurrentExecution(this.db)
      if (!execution) throw Error("SQLJS_SAVER_COMPACTION_WRITES_CHANGED")
      const lifetime = this.captureReadLifetime()
      const read = execution.prepareReadOne(`SELECT total_changes() AS changes,
        (SELECT data_version FROM pragma_data_version) AS version`), before = read()
      const assertSource = () => {
        lifetime()
        execution.assertDataCurrent()
        if (receipt) SqlJsSaver.prototype.readCommittedCheckpoint.call(this, receipt)
        const after = read()
        if (!before || !after || before.changes !== after.changes || before.version !== after.version)
          throw Error("SQLJS_SAVER_COMPACTION_WRITES_CHANGED")
      }
      const rows = this.db!.exec(`SELECT task_id,idx,channel,type,value FROM writes
        WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`,
      [fixed.threadId, fixed.namespace, fixed.checkpointId])[0]?.values ?? []
      const actualSource = this.db!.exec(`SELECT parent_checkpoint_id,type,checkpoint,metadata
        FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`,
      [fixed.threadId, fixed.namespace, fixed.checkpointId])[0]?.values[0]
      if (!actualSource) {
        if (rows.length) throw Error("SQLJS_SAVER_COMPACTION_WRITES_CHANGED")
        assertSource()
        return
      }
      if (actualSource[0] !== sourceFixed.parentCheckpointId || actualSource[1] !== sourceFixed.checkpointType ||
        !(typeof actualSource[2] === "string" || actualSource[2] instanceof Uint8Array) ||
        !(typeof actualSource[3] === "string" || actualSource[3] instanceof Uint8Array) ||
        checkpointBytesDigest(actualSource[2] as string | Uint8Array) !== sourceFixed.checkpointBytesDigest ||
        checkpointBytesDigest(actualSource[3] as string | Uint8Array) !== sourceFixed.metadataBytesDigest)
        throw Error("SQLJS_SAVER_COMPACTION_WRITES_CHANGED")
      const expected = new Map<string, { channel: string; type: string; bytesDigest: string }>()
      for (const operation of fixed.operations) for (const row of operation.rows)
        expected.set(JSON.stringify([operation.taskId, row.idx]), row)
      if (rows.length !== expected.size || rows.some(row => {
        const wanted = expected.get(JSON.stringify([row[0], row[1]]))
        return !wanted || row[2] !== wanted.channel || row[3] !== wanted.type ||
          !(typeof row[4] === "string" || row[4] instanceof Uint8Array) ||
          checkpointBytesDigest(row[4] as string | Uint8Array) !== wanted.bytesDigest
      })) throw Error("SQLJS_SAVER_COMPACTION_WRITES_CHANGED")
      // Source pending writes are separately verified above and remain unapplied. Its
      // external message marker alone cannot prove the original snapshot-chain bytes.
      this.hydratedCheckpointMessages.clear()
      const original = await this.getTupleUnlocked({ configurable: { thread_id: fixed.threadId,
        checkpoint_ns: fixed.namespace, checkpoint_id: fixed.checkpointId } })
      assertSource()
      if (!original) throw Error("SQLJS_SAVER_COMPACTION_WRITES_CHANGED")
      const channels = await this.digestCheckpointChannels(original.checkpoint.channel_values, assertSource)
      if (Object.keys(channels).length !== Object.keys(sourceFixed.channels).length ||
        Object.entries(channels).some(([key, value]) => value !== sourceFixed.channels[key]))
        throw Error("SQLJS_SAVER_COMPACTION_WRITES_CHANGED")
      assertSource()
      } finally { release?.() }
    })
  }

  /** Comparison data under the original codec, including its supported non-JSON values. */
  async digestCompactionChannels(values: Readonly<Record<string, unknown>>,
    assertCurrent?: () => void): Promise<Readonly<Record<string, string>>> {
    const fixed = { ...values }
    return this.withDatabaseOperation(() => this.digestCheckpointChannels(fixed, assertCurrent))
  }

  private async digestCheckpointChannels(values: Readonly<Record<string, unknown>>,
    assertCurrent?: () => void): Promise<Readonly<Record<string, string>>> {
    const database = this.db, generation = this.commitObserverGeneration
    const guard = () => {
      if (!database || this.db !== database || this.retired || this.closePromise ||
        generation !== this.commitObserverGeneration) throw Error("SQLJS_SAVER_OPERATION_EXPIRED")
      assertCurrent?.()
    }
    const entries: Array<[string, string]> = []
    for (const [key, value] of Object.entries(values)) {
      guard()
      const [type, bytes] = await this.serde.dumpsTyped(value)
      guard()
      entries.push([key, createHash("sha256").update(JSON.stringify(type)).update("\0")
        .update(checkpointBytesDigest(bytes)).digest("hex")])
    }
    guard()
    return Object.freeze(Object.fromEntries(entries))
  }

  /** Join the original active operation, then compare actual SQL bytes before journal ACK. */
  async readCommittedCheckpointDescriptor(receipt: SqlJsSaverCommittedCheckpointReceipt):
    Promise<SqlJsSaverPreparedCheckpointDescriptor> {
    SqlJsSaver.prototype.readCommittedCheckpoint.call(this, receipt)
    return this.withDatabaseOperation(async () => {
      const tuple = SqlJsSaver.prototype.readCommittedCheckpoint.call(this, receipt)
      const descriptor = this.committedCheckpointReceipts.get(receipt)?.prepared
      if (!descriptor) throw Error("SQLJS_SAVER_PREPARED_RECEIPT_INVALID")
      const execution = readFunctionConversationNativeSqliteCurrentExecution(this.db)
      if (!execution) throw Error("SQLJS_SAVER_COMMIT_SCOPE_INVALID")
      const read = execution.prepareReadOne(`SELECT total_changes() AS changes,
        (SELECT data_version FROM pragma_data_version) AS version`), before = read()
      const assertData = () => {
        execution.assertDataCurrent()
        const after = read()
        if (!before || !after || before.changes !== after.changes || before.version !== after.version)
          throw Error("SQLJS_SAVER_COMMIT_SCOPE_INVALID")
        SqlJsSaver.prototype.readCommittedCheckpoint.call(this, receipt)
      }
      const values = this.db!.exec(`SELECT parent_checkpoint_id,type,checkpoint,metadata
        FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`,
      [descriptor.threadId, descriptor.namespace, descriptor.checkpointId])[0]?.values[0]
      if (!values || values[0] !== descriptor.parentCheckpointId || values[1] !== descriptor.checkpointType ||
        !(typeof values[2] === "string" || values[2] instanceof Uint8Array) ||
        !(typeof values[3] === "string" || values[3] instanceof Uint8Array) ||
        checkpointBytesDigest(values[2]) !== descriptor.checkpointBytesDigest ||
        checkpointBytesDigest(values[3]) !== descriptor.metadataBytesDigest)
        throw Error("SQLJS_SAVER_COMMIT_SCOPE_INVALID")
      assertData()
      const channels = await this.digestCheckpointChannels(tuple.checkpoint.channel_values, assertData)
      if (JSON.stringify(Object.keys(channels).sort()) !== JSON.stringify(Object.keys(descriptor.channels).sort()) ||
        Object.entries(channels).some(([key, value]) => value !== descriptor.channels[key]))
        throw Error("SQLJS_SAVER_COMMIT_SCOPE_INVALID")
      SqlJsSaver.prototype.readCommittedCheckpoint.call(this, receipt)
      return descriptor
    })
  }

  /** Exact native data for host compaction reconciliation; this does not mint a write receipt. */
  async readCompactionCheckpoint(config: RunnableConfig): Promise<{
    tuple: CheckpointTuple
    descriptor: SqlJsSaverPreparedCheckpointDescriptor
    assertCurrent(): void
  } | undefined> {
    const fixed = { ...config, configurable: { ...config.configurable } }
    return this.withDatabaseOperation(async () => {
      const captured = await SqlJsSaver.prototype.getExactTupleForLegacyMigration.call(this, fixed)
      captured.assertCurrent()
      if (!captured.tuple) return undefined
      if (captured.tuple.pendingWrites?.length) throw Error("SQLJS_SAVER_COMPACTION_PENDING_WRITES")
      const values = this.db!.exec(`SELECT parent_checkpoint_id,type,checkpoint,metadata
        FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`, [
        String(fixed.configurable.thread_id), String(fixed.configurable.checkpoint_ns ?? ""),
        String(fixed.configurable.checkpoint_id)
      ])[0]?.values[0]
      captured.assertCurrent()
      if (!values || typeof values[1] !== "string" ||
        !(typeof values[2] === "string" || values[2] instanceof Uint8Array) ||
        !(typeof values[3] === "string" || values[3] instanceof Uint8Array))
        throw Error("SQLJS_SAVER_COMPACTION_RAW_CHECKPOINT_INVALID")
      const tuple = captured.tuple
      const channels = await this.digestCheckpointChannels(tuple.checkpoint.channel_values, captured.assertCurrent)
      const descriptor = Object.freeze({ threadId: String(fixed.configurable.thread_id),
        namespace: String(fixed.configurable.checkpoint_ns ?? ""), checkpointId: tuple.checkpoint.id,
        parentCheckpointId: typeof values[0] === "string" ? values[0] : null,
        checkpointType: values[1], checkpointBytesDigest: checkpointBytesDigest(values[2]),
        metadataType: values[1], metadataBytesDigest: checkpointBytesDigest(values[3]),
        channels })
      captured.assertCurrent()
      return { tuple, descriptor, assertCurrent: captured.assertCurrent }
    })
  }

  /** Metadata-only exact-current check. Never loads latest history as a recovery fallback. */
  async isCompactionCheckpointLatest(config: RunnableConfig): Promise<boolean> {
    const fixed = { ...config.configurable }
    return this.withDatabaseOperation(async () => {
      const id = this.db!.exec(`SELECT checkpoint_id FROM checkpoints
        WHERE thread_id=? AND checkpoint_ns=? ORDER BY checkpoint_ts DESC,checkpoint_id DESC LIMIT 1`,
      [String(fixed.thread_id), String(fixed.checkpoint_ns ?? "")])[0]?.values[0]?.[0]
      return typeof fixed.checkpoint_id === "string" && id === fixed.checkpoint_id
    })
  }

  /** Host-only read lifecycle. Never initializes or borrows a replacement database. */
  captureReadLifetime(): () => void {
    const database = this.db, generation = this.commitObserverGeneration
    if (!database || !this.isSetup || this.retired || this.closePromise)
      throw new Error("SQLJS_SAVER_READ_LIFETIME_EXPIRED")
    return () => {
      if (this.db !== database || !this.isSetup || this.retired || this.closePromise ||
        this.commitObserverGeneration !== generation)
        throw new Error("SQLJS_SAVER_READ_LIFETIME_EXPIRED")
    }
  }

  private prepareNativeDataWindow(database: NativeSqliteAdapter, threadId: string, namespace: string) {
    if (sharedIsProxy(this)) throw Error("SQLJS_SAVER_PREPARED_DATA_INVALID")
    const lifeKeys = ["db", "pinnedFile", "databaseIdentity", "isSetup", "retired", "closePromise",
      "commitObserverGeneration", "serde", "defaultMetadataSerializer"] as const
    const lifeFields: PropertyDescriptor[] = []
    for (let index = 0; index < lifeKeys.length; index++) {
      const field = sharedDescriptor(this, lifeKeys[index])
      if (!field || !("value" in field)) throw Error("SQLJS_SAVER_PREPARED_DATA_INVALID")
      appendPreparedData(lifeFields, field)
    }
    if (this.serde !== this.defaultMetadataSerializer || !this.defaultMetadataCodec())
      throw Error("SQLJS_SAVER_PREPARED_CODEC_UNSUPPORTED")
    const serializerData = sharedContainerData(this.serde)
    const serializerPrototypeData = sharedContainerData(sharedPrototype(this.serde))
    const generation = this.commitObserverGeneration, identity = this.databaseIdentity,
      file = this.pinnedFile, lifetime = originalPreparedLifetime(this)
    const execution = preparedNativeExecution(database)
    if (!execution || !identity || !file) throw Error("SQLJS_SAVER_PREPARED_DATA_INVALID")
    const identityData = sharedContainerData(identity), fileData = sharedContainerData(file)
    const schema = execution.prepareReadOne("SELECT rowid,rootpage,sql,type FROM main.sqlite_schema WHERE name=? COLLATE NOCASE")
    const temporary = execution.prepareReadOne(`SELECT COUNT(*) AS count FROM temp.sqlite_schema
      WHERE (lower(name) IN ('checkpoints','writes','checkpoint_message_snapshots','checkpoint_runtime_projections')
        AND type IN ('table','view')) OR (type='trigger' AND lower(tbl_name) IN
        ('checkpoints','writes','checkpoint_message_snapshots','checkpoint_runtime_projections'))`)
    const triggers = execution.prepareReadOne(`SELECT COUNT(*) AS count FROM main.sqlite_schema
      WHERE type='trigger' AND lower(tbl_name) IN
        ('checkpoints','writes','checkpoint_message_snapshots','checkpoint_runtime_projections')`)
    const names = ["checkpoints", "writes", "checkpoint_message_snapshots", "checkpoint_runtime_projections"]
    const definitions: NonNullable<ReturnType<typeof schema>>[] = []
    for (let index = 0; index < names.length; index++) {
      const row = schema([names[index]])
      if (!row || row.type !== "table" || typeof row.sql !== "string")
        throw Error("SQLJS_SAVER_PREPARED_SCHEMA_UNSUPPORTED")
      appendPreparedData(definitions, row)
    }
    const changes = execution.prepareReadOne("SELECT total_changes() AS changes")
    const version = execution.prepareReadOne("PRAGMA main.data_version")
    const beforeChanges = changes()?.changes, beforeVersion = version()?.data_version
    const row = execution.prepareReadOne(`SELECT parent_checkpoint_id,prefix_length,message_count,
      generation,type,suffix FROM main.checkpoint_message_snapshots
      WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`)
    const assertCurrent = () => {
      for (let index = 0; index < lifeKeys.length; index++)
        if (!sharedSameField(sharedDescriptor(this, lifeKeys[index]), lifeFields[index]))
          throw Error("SQLJS_SAVER_PREPARED_DATA_CHANGED")
      serializerData(); serializerPrototypeData(); identityData(); fileData()
      lifetime(); execution.assertDataCurrent()
      if (this.db !== database || this.databaseIdentity !== identity || this.pinnedFile !== file ||
        this.commitObserverGeneration !== generation || this.serde !== this.defaultMetadataSerializer)
        throw Error("SQLJS_SAVER_PREPARED_DATA_CHANGED")
      const actual = preparedStatSync(identity.path, { bigint: true })
      const path = preparedRealpathSync(identity.logicalPath)
      const samePath = preparedWindows
        ? sharedApply(preparedLower, path, []) === sharedApply(preparedLower, identity.path, []) : path === identity.path
      if (!samePath || actual.nlink > 1n || sharedString(actual.dev) !== file.dev ||
        sharedString(actual.ino) !== file.ino || sharedString(actual.birthtimeNs) !== file.birthtime)
        throw Error("SQLJS_SAVER_DATABASE_IDENTITY_CHANGED")
      if (temporary()?.count !== 0 || triggers()?.count !== 0)
        throw Error("SQLJS_SAVER_PREPARED_SCHEMA_UNSUPPORTED")
      for (let index = 0; index < names.length; index++) {
        const value = schema([names[index]]), original = definitions[index]!
        if (!value || value.type !== original.type || value.rowid !== original.rowid ||
          value.rootpage !== original.rootpage || value.sql !== original.sql)
          throw Error("SQLJS_SAVER_PREPARED_SCHEMA_UNSUPPORTED")
      }
      execution.assertDataCurrent(); lifetime()
    }
    const parent = execution.prepareReadOne(`SELECT message_count,generation
      FROM main.checkpoint_message_snapshots WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`)
    assertCurrent()
    return { assertCurrent,
      run: (sql: string, bindings?: readonly unknown[]) => execution.run(sql, bindings),
      readParent: (checkpointId: string) => {
        execution.assertDataCurrent()
        const actual = parent([threadId, namespace, checkpointId])
        return actual ? { count: actual.message_count, generation: actual.generation } : undefined
      },
      assertRaw: (facts: PreparedNativeDataFacts) => {
      assertCurrent()
      if (changes()?.changes === beforeChanges && version()?.data_version === beforeVersion) return
      for (let index = 0; index < facts.chainSeal.length; index++) {
        const item = facts.chainSeal[index]
        const data = row([threadId, namespace, item.checkpointId])
        if (!data || typeof data.type !== "string" || typeof data.generation !== "string" ||
          !(data.parent_checkpoint_id === null || typeof data.parent_checkpoint_id === "string") ||
          typeof data.prefix_length !== "number" || !preparedSafeInteger(data.prefix_length) || data.prefix_length < 0 ||
          typeof data.message_count !== "number" || !preparedSafeInteger(data.message_count) || data.message_count < 0 ||
          !(typeof data.suffix === "string" || sharedIsUint8Array(data.suffix)) ||
          preparedRowDigest({ checkpointId: item.checkpointId,
            parentCheckpointId: data.parent_checkpoint_id, prefixLength: data.prefix_length,
            messageCount: data.message_count, generation: data.generation,
            type: data.type, bytes: data.suffix }) !== item.rawDigest)
          throw Error("SQLJS_SAVER_PREPARED_SOURCE_CHANGED")
      }
      assertCurrent()
    } }
  }

  private async putUnlocked(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    assertCurrent?: () => void,
    onCommitted?: () => void,
    onPrepared?: SqlJsSaverPreparedCheckpointObserver,
    onPreparedData?: SqlJsSaverPreparedCheckpointObserver
  ): Promise<RunnableConfig> {
    await this.initialize()
    assertCurrent?.()
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

    const dataWindow = onPreparedData && this.serde === this.defaultMetadataSerializer && this.defaultMetadataCodec()
      ? originalPreparedWindow(this, database, sharedString(thread_id), sharedString(checkpoint_ns)) : undefined
    const inputCheckpointData = dataWindow ? sharedContainerData(checkpoint) : undefined
    const inputMetadataData = dataWindow ? sharedContainerData(metadata) : undefined
    const inputMetadataParents = dataWindow ? sharedContainerData(metadata.parents) : undefined
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
      const previous = this.checkpointMessageWriteStates.get(namespaceKey)
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
        messages: buildExternalMessagesReference(messages.length)
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

    let dataFacts: PreparedNativeDataFacts | undefined
    const prepareData = dataWindow && onPreparedData ? async () => {
      if (!this.databaseIdentity || !this.pinnedFile || !dataWindow)
        throw Error("SQLJS_SAVER_PREPARED_DATA_INVALID")
      const source: PreparedNativeDataSource = preparedFreeze({ file: preparedFreeze({ ...this.pinnedFile }),
        parentCheckpointId: typeof parent_checkpoint_id === "string" ? parent_checkpoint_id : null,
        checkpoint: preparedFreeze({ type: type1, bytes: serializedCheckpoint }),
        metadata: preparedFreeze({ type: type2, bytes: serializedMetadata }),
        messages: serializedMessageSuffix ? preparedFreeze({ type: serializedMessageSuffix[0],
          bytes: serializedMessageSuffix[1], parentCheckpointId: messageSnapshotParentCheckpointId,
          prefixLength: messageSnapshotPrefixLength, messageCount: externalMessageCount!,
          expectedParentCount: messageSnapshotExpectedParentCount,
          expectedParentGeneration: messageSnapshotExpectedParentGeneration }) : null })
      const exact = preparedFreeze({ configurable: preparedFreeze({ thread_id,
        checkpoint_ns, checkpoint_id: checkpoint.id }) })
      const tuple: CheckpointTuple = { config: exact, checkpoint, metadata,
        ...(typeof parent_checkpoint_id === "string" ? { parentConfig: { configurable: {
          thread_id, checkpoint_ns, checkpoint_id: parent_checkpoint_id } } } : {}) }
      const digest = preparedPlanDigest(source)
      const checkpointData = sharedContainerData(checkpoint)
      const tupleData = sharedContainerData(tuple)
      const fixedPoint = checkpoint.id, fixedTimestamp = checkpoint.ts
      let facts: PreparedNativeDataFacts | undefined
      const current = () => {
        dataWindow.assertCurrent()
        inputCheckpointData?.(); inputMetadataData?.(); inputMetadataParents?.()
        checkpointData(); tupleData()
        if (checkpoint.id !== fixedPoint || checkpoint.ts !== fixedTimestamp ||
          preparedPlanDigest(source) !== digest)
          throw Error("SQLJS_SAVER_PREPARED_DATA_CHANGED")
      }
      const receipt = preparedFreeze({ [preparedCheckpointReceiptBrand]: true as const })
      const record: PreparedCheckpointRecord = { database, generation: this.commitObserverGeneration,
        destinationExisted: false, active: true, descriptor: undefined, sourceWrites: undefined,
        data: { tuple, source, planDigest: digest, assertCurrent: current, facts: undefined,
          assertRaw: facts => dataWindow.assertRaw(facts) } }
      sharedApply(preparedWeakSet, this.#preparedCheckpointReceipts, [receipt, record])
      try {
        await onPreparedData(receipt)
        readSqlJsSaverPreparedConversationData(this, receipt)
        facts = record.data!.facts
        if (!facts) throw Error("SQLJS_SAVER_PREPARED_DATA_UNVERIFIED")
      } finally {
        record.active = false
        sharedApply(preparedWeakDelete, this.#preparedCheckpointReceipts, [receipt])
      }
      dataFacts = facts
      return current
    } : undefined
    // This seal stays owned by this put after its callback-local receipt expires.
    let assertSealedData: (() => void) | undefined
    let sourceWrites: CompactionWriteBatchRecord | undefined
    let sourceWritesDescriptor: SqlJsSaverCompactionWritesDescriptor | undefined
    let legacyPrepared = false
    const prepareLegacy = async () => {
    if (onPrepared && !legacyPrepared) {
      const generation = this.commitObserverGeneration
      const channels = await this.digestCheckpointChannels(checkpoint.channel_values, assertCurrent)
      const descriptor: SqlJsSaverPreparedCheckpointDescriptor = Object.freeze({
        threadId: String(thread_id), namespace: String(checkpoint_ns), checkpointId: checkpoint.id,
        parentCheckpointId: typeof parent_checkpoint_id === "string" ? parent_checkpoint_id : null,
        checkpointType: type1, checkpointBytesDigest: checkpointBytesDigest(serializedCheckpoint),
        metadataType: type2, metadataBytesDigest: checkpointBytesDigest(serializedMetadata),
        channels
      })
      const receipt = Object.freeze({ [preparedCheckpointReceiptBrand]: true as const })
      const destinationExisted = Boolean(database.exec(`SELECT 1 FROM checkpoints
        WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? LIMIT 1`,
      [String(thread_id), String(checkpoint_ns), checkpoint.id])[0]?.values.length)
      if (database.exec(`SELECT 1 FROM writes
        WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? LIMIT 1`,
      [String(thread_id), String(checkpoint_ns), checkpoint.id])[0]?.values.length)
        throw Error("SQLJS_SAVER_COMPACTION_PENDING_WRITES")
      const record: PreparedCheckpointRecord = { database, generation, descriptor, destinationExisted,
        active: true, data: undefined, sourceWrites: undefined }
      sharedApply(preparedWeakSet, this.#preparedCheckpointReceipts, [receipt, record])
      try {
        await onPrepared(receipt)
        SqlJsSaver.prototype.readPreparedCheckpoint.call(this, receipt)
        sourceWrites = record.sourceWrites
        sourceWritesDescriptor = sourceWrites?.descriptor
      } finally {
        record.active = false
        sharedApply(preparedWeakDelete, this.#preparedCheckpointReceipts, [receipt])
      }
      legacyPrepared = true
    }
    }

    const checkpointTs =
      typeof preparedCheckpoint.ts === "string" ? preparedCheckpoint.ts : preparedCheckpoint.id
    const forkBoundaryMarker = checkpointMetadataHasForkBoundaryMarker(metadata) ? 1 : 0
    const nextSnapshotGeneration = serializedMessageSuffix ? randomUUID() : null

    const parentChanged = () => {
      if (!messageSnapshotParentCheckpointId) return false
      const parent = dataWindow!.readParent(messageSnapshotParentCheckpointId)
      return !parent || parent.count !== messageSnapshotExpectedParentCount ||
        parent.generation !== messageSnapshotExpectedParentGeneration
    }
    const rebaseMessages = async () => {
      messageSnapshotParentCheckpointId = null
      messageSnapshotExpectedParentCount = null
      messageSnapshotExpectedParentGeneration = null
      messageSnapshotPrefixLength = 0
      if (!Array.isArray(messages))
        throw Error("Checkpoint message delta parent exists without an array payload")
      serializedMessageSuffix = await this.serde.dumpsTyped(messages)
      nextSnapshotDepth = 1
      nextDeltaBytes = 0
      shouldPruneMessageSnapshots = true
      assertSealedData = undefined
    }
    const transaction = dataWindow ?? database
    let committed = false
    while (!committed) {
      if (prepareData && !assertSealedData) {
        try { assertSealedData = await prepareData() }
        catch (error) {
          // Only the original stale-parent condition may use the existing base reserialization.
          // A codec/raw/schema/data-seal error is never converted into a retry.
          if (error instanceof Error && error.message === "PREPARED_NATIVE_PREFIX_CHANGED" && parentChanged()) {
            await rebaseMessages()
            continue
          }
          throw error
        }
      }
      if (onPrepared) await prepareLegacy()
      let transactionStarted = false
      try {
        // Recheck after namespace admission and every asynchronous serialization/rebase.
        // This host-only guard must run before any durable mutation, not just its observer.
        assertCurrent?.()
        transaction.run("BEGIN IMMEDIATE")
        transactionStarted = true

        if (messageSnapshotParentCheckpointId) {
          const fixedParent = dataWindow?.readParent(messageSnapshotParentCheckpointId)
          const parentResult = dataWindow ? undefined : database.exec(
            `SELECT message_count, generation FROM checkpoint_message_snapshots
             WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
             LIMIT 1`,
            [thread_id, checkpoint_ns, messageSnapshotParentCheckpointId]
          )
          const persistedParentCount = dataWindow ? fixedParent?.count : Number(parentResult?.[0]?.values[0]?.[0])
          const persistedParentGeneration = dataWindow ? fixedParent?.generation : parentResult?.[0]?.values[0]?.[1]
          if (
            !(dataWindow ? typeof persistedParentCount === "number" && preparedSafeInteger(persistedParentCount)
              : Number.isSafeInteger(persistedParentCount)) ||
            persistedParentCount !== messageSnapshotExpectedParentCount ||
            persistedParentGeneration !== messageSnapshotExpectedParentGeneration
          ) {
            // A different saver may have rebased and collected this parent while
            // serde was suspended. Release the writer lock before the expensive
            // full serialization, then retry as an independent base snapshot.
            transaction.run("ROLLBACK")
            transactionStarted = false
            await rebaseMessages()
            continue
          }
        }

        let preparedWrites: readonly (readonly unknown[])[] | undefined
        if (sourceWrites) {
          if (sourceWrites.phase !== "attached" || sourceWrites.database !== database ||
            sourceWrites.generation !== this.commitObserverGeneration || this.retired || this.closePromise)
            throw Error("SQLJS_SAVER_COMPACTION_BATCH_INVALID")
          // This is the final source check, after every await and after the writer lock.
          // Parent rebase has already succeeded; no staged write precedes a retry.
          sourceWrites.assertSource()
          if (dataWindow) assertCurrent?.()
        }
        if (dataWindow) {
          assertSealedData?.()
          if (!dataFacts) throw Error("SQLJS_SAVER_PREPARED_DATA_UNVERIFIED")
          dataWindow.assertRaw(dataFacts)
          if (sourceWrites) preparedWrites = preparedCompactionBindings(sourceWrites, sourceWritesDescriptor)
        }
        if (preparedWrites) {
          for (let index = 0; index < preparedWrites.length; index++)
            transaction.run(`INSERT OR REPLACE INTO writes
              (thread_id,checkpoint_ns,checkpoint_id,task_id,idx,channel,type,value)
              VALUES (?,?,?,?,?,?,?,?)`, preparedWrites[index])
        } else if (sourceWrites) {
          for (const operation of sourceWrites.operations) for (const row of operation.rows)
            transaction.run(`INSERT OR REPLACE INTO writes
              (thread_id,checkpoint_ns,checkpoint_id,task_id,idx,channel,type,value)
              VALUES (?,?,?,?,?,?,?,?)`, [sourceWrites.source.threadId, sourceWrites.source.namespace,
              sourceWrites.source.checkpointId, operation.taskId, row.idx, row.channel, row.type, row.value])
        }

        if (serializedMessageSuffix) {
          transaction.run(
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
          transaction.run(
            `DELETE FROM checkpoint_message_snapshots
             WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`,
            [thread_id, checkpoint_ns, checkpoint.id]
          )
        }

        transaction.run(
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
        transaction.run(
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
        transaction.run("COMMIT")
        transactionStarted = false
        committed = true
        if (sourceWrites) sourceWrites.phase = "committed"
        // A host mutation must retain this fact even if a post-COMMIT read/observer fails.
        onCommitted?.()
      } catch (error) {
        if (transactionStarted) {
          try {
            transaction.run("ROLLBACK")
          } catch {
            // Preserve the put/serialization failure.
          }
        }
        throw error
      }
    }

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
    return this.withDatabaseOperation(async () => {
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
  
    })
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

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string,
    assertCurrent?: () => void): Promise<void> {
    assertCurrent?.()
    const configurable = config.configurable
    const threadId = configurable?.thread_id
    if (typeof threadId !== "string" || !threadId) {
      return this.withDatabaseOperation(() => this.putWritesUnlocked(config, writes, taskId, assertCurrent))
    }
    const checkpointNs = configurable?.checkpoint_ns ?? ""
    // The private writer consumes only these addresses, not public config brands or extra fields.
    const fixedConfig: RunnableConfig = { configurable: {
      thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: configurable?.checkpoint_id
    } }
    let intentKey = this.checkpointNamespaceQueueKey(threadId, checkpointNs)
    const releaseIntent = (key: string) => {
      const remaining = (checkpointNamespacePendingWriteIntents.get(key) ?? 1) - 1
      if (remaining > 0) checkpointNamespacePendingWriteIntents.set(key, remaining)
      else checkpointNamespacePendingWriteIntents.delete(key)
    }
    // A warm caller's intent is visible while initialization, admission or file checks await.
    checkpointNamespacePendingWriteIntents.set(
      intentKey,
      (checkpointNamespacePendingWriteIntents.get(intentKey) ?? 0) + 1
    )
    try {
      return await this.withDatabaseOperation(async () => {
        // Initialization may resolve a logical alias to a different physical database key.
        const physicalKey = this.checkpointNamespaceQueueKey(threadId, checkpointNs)
        if (physicalKey !== intentKey) {
          checkpointNamespacePendingWriteIntents.set(
            physicalKey,
            (checkpointNamespacePendingWriteIntents.get(physicalKey) ?? 0) + 1
          )
          releaseIntent(intentKey)
          intentKey = physicalKey
        }
        const release = await this.acquireCheckpointNamespace(threadId, checkpointNs)
        try {
          await this.putWritesUnlocked(fixedConfig, writes, taskId, assertCurrent)
        } finally { release() }
      })
    } finally { releaseIntent(intentKey) }
  }

  private async putWritesUnlocked(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    assertCurrent?: () => void
  ): Promise<void> {
    await this.initialize()
    assertCurrent?.()
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
      assertCurrent?.()
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

  async deleteThread(threadId: string): Promise<void> {
    return this.withDatabaseOperation(async () => {
    await this.initialize()
    if (!this.db) throw new Error("Database not initialized")

    this.db.run(`DELETE FROM checkpoints WHERE thread_id = ?`, [threadId])
    this.db.run(`DELETE FROM writes WHERE thread_id = ?`, [threadId])
    this.db.run(`DELETE FROM checkpoint_message_snapshots WHERE thread_id = ?`, [threadId])
    this.db.run(`DELETE FROM checkpoint_runtime_projections WHERE thread_id = ?`, [threadId])

    const cachePrefix = `${threadId}\u0000`
    for (const key of this.checkpointMessageWriteStates.keys()) {
      if (key.startsWith(cachePrefix)) this.checkpointMessageWriteStates.delete(key)
    }
    for (const key of this.hydratedCheckpointMessages.keys()) {
      if (key.startsWith(cachePrefix)) this.hydratedCheckpointMessages.delete(key)
    }

  
    })
  }

  /**
   * Permanently close for thread deletion. Unlike close() (reusable shutdown:
   * flushes pending state, and a later initialize() may legitimately reopen),
   * retire() poisons the instance first — in-flight writes are awaited, the
   * final checkpoint is skipped (the file is about to be deleted), and every future
   * initialize()/mutation is refused. Call this, not close(), whenever the backing
   * file is being removed from disk.
   */
  private assertExternalClose(): void {
    if (checkpointDatabaseOperationIsCurrent(this) ||
      checkpointDatabaseAdmissionIsCurrent(this.checkpointDatabaseKey))
      throw new Error("SQLJS_SAVER_CLOSE_INSIDE_OPERATION")
  }

  async retire(): Promise<void> {
    this.assertExternalClose()
    this.retired = true
    await this.close()
  }

  /** First revoke continuation authority, then wait for every actual owner/worker to finish. */
  async close(): Promise<void> {
    this.assertExternalClose()
    if (this.closePromise) {
      await this.closePromise
      return
    }
    this.commitObserverGeneration += 1
    this.schemaWait?.abort(new Error("SQLJS_SAVER_CLOSING"))
    const closePromise = (async (): Promise<SqlJsSaverCloseOutcome> => {
      const initializing = this.initializePromise
      let initializationFailure: { reason: unknown } | undefined
      if (initializing) {
        try { await initializing }
        catch (reason) { initializationFailure = { reason } }
      }
      await waitForCheckpointDatabaseOperations(this)
      if (this.flushPromise) await this.flushPromise
      return runCheckpointDatabaseMaintenance<SqlJsSaverCloseOutcome>(this.checkpointDatabaseKey, async () => {
        const database = this.db
        const file = this.pinnedFile
        let skipped = initializationFailure
        if (database && !this.retired) {
          try {
            if (!file || !this.isSetup) throw new Error("SQLJS_SAVER_DATABASE_IDENTITY_CHANGED")
            await assertCheckpointDatabaseFileIdentity(this.dbPath, file)
          } catch (reason) { skipped = { reason } }
        }
        if (this.retired) skipped = { reason: new Error("SQLJS_SAVER_OPERATION_EXPIRED") }
        this.db = null
        this.isSetup = false
        this.pinnedFile = undefined
        this.checkpointMessageWriteStates.clear()
        this.hydratedCheckpointMessages.clear()
        this.checkpointMessageRecoveryRequests.clear()
        if (database) {
          try { if (!skipped) database.flush("TRUNCATE") }
          finally { database.close({ checkpoint: false }) }
        }
        if (skipped) return { state: "skipped", reason: skipped.reason }
        return { state: database ? "checkpointed" : "idle" }
      })
    })().finally(() => {
      if (this.closePromise === closePromise) this.closePromise = null
    })
    this.closePromise = closePromise
    await closePromise
  }
}

// Fixed private-data dispatch: a host callback cannot replace the actual Saver reader.
const originalPreparedDataReader = SqlJsSaver.prototype.readPreparedConversationData
const originalPreparedFactsReader = SqlJsSaver.prototype.readPreparedConversationDataFacts
export function readSqlJsSaverPreparedConversationData(saver: SqlJsSaver,
  receipt: SqlJsSaverPreparedCheckpointReceipt): CheckpointTuple {
  return sharedApply(originalPreparedDataReader, saver, [receipt]) as CheckpointTuple
}
export function readSqlJsSaverPreparedConversationDataFacts(saver: SqlJsSaver,
  receipt: SqlJsSaverPreparedCheckpointReceipt, signal?: AbortSignal): Promise<PreparedNativeDataFacts> {
  return sharedApply(originalPreparedFactsReader, saver, [receipt, signal]) as Promise<PreparedNativeDataFacts>
}
