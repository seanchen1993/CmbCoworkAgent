import type { RunnableConfig } from "@langchain/core/runnables"
import type { CheckpointTuple } from "@langchain/langgraph-checkpoint"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { readFunctionConversationStoreCurrentExecution, FunctionConversationStore }
  from "../db/function-conversation-store"
import { assertStoredProjectionReceipt } from "../db/function-conversation-projection-seal"
import { ModControlStore } from "../mods/control-store"
import { captureConversationCheckpointRead, functionConversationMembershipDigest,
  readFunctionConversationCheckpointMembership,
  type FunctionConversationCheckpointMembershipSnapshot } from "./function-conversation-checkpoint-membership"
import type { FunctionConversationCanonicalCut } from "./function-conversation-checkpoint-membership"
import { readFunctionConversationState, assertFunctionConversationState,
  type FunctionConversationDeliveryBinding } from "./function-conversation-delivery"
import { SqlJsSaver, type SqlJsSaverPreparedCheckpointReceipt,
  type SqlJsSaverCommittedCheckpointReceipt, type SqlJsSaverPreparedCheckpointDescriptor,
  type SqlJsSaverCompactionWriteBatch } from "./sqljs-saver"
import type { PendingWrite } from "@langchain/langgraph-checkpoint"
import { FunctionConversationCompactionJournal, type CompactionCommitRecord }
  from "./function-conversation-compaction-journal"
import { randomUUID } from "node:crypto"
import { prepareCompactionMessageIdentities } from "./compaction-message-identities"

interface Host {
  readonly saver: SqlJsSaver
  readonly store: FunctionConversationStore
  readonly control: ModControlStore
  readonly database: NativeSqliteAdapter
  readonly binding: FunctionConversationDeliveryBinding
}
const sourceBrand = Symbol("host-compaction-source")
export interface FunctionConversationCompactionSource { readonly [sourceBrand]: true }
interface Boundary {
  readonly version: 1
  readonly target: string
  readonly sourceCheckpointId: string
  readonly sourceSnapshotDigest: string
  readonly destinationCheckpointId: string
  readonly destinationSnapshotDigest: string
  readonly destinationCheckpointDigest: string
  readonly uuid: string
  readonly rowDigest: string
  readonly rowReceiptId: string
  readonly projectionDigest: string
}
const sources = new WeakMap<FunctionConversationCompactionSource, {
  host: Host
  source: FunctionConversationCheckpointMembershipSnapshot
  boundary: Omit<Boundary, "destinationCheckpointId" | "destinationSnapshotDigest" | "destinationCheckpointDigest">
  descriptor: SqlJsSaverPreparedCheckpointDescriptor
  commit?: FunctionConversationCompactionCommit
}>()
const commitBrand = Symbol("host-compaction-commit")
export interface FunctionConversationCompactionCommit { readonly [commitBrand]: true }
interface CommitAttempt {
  readonly source: FunctionConversationCompactionSource
  readonly host: Host
  readonly sourceDescriptor: SqlJsSaverPreparedCheckpointDescriptor
  readonly assertSource: () => void
  readonly expectedChannels: Readonly<Record<string, string>>
  readonly expectedUpdateDigest: string
  readonly intentId: string
  readonly journal: FunctionConversationCompactionJournal
  readonly writeBatch: SqlJsSaverCompactionWriteBatch
  assertCommitted?: () => void
  record?: CompactionCommitRecord
  settled: boolean
}
const commits = new WeakMap<FunctionConversationCompactionCommit, CommitAttempt>()
const attempts = new Map<string, { active?: CommitAttempt; settled: boolean }>()
const writerBoot = randomUUID()
const weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set
const weakDelete = WeakMap.prototype.delete, apply = Reflect.apply
const getSetting = ModControlStore.prototype.getSetting
const setSetting = ModControlStore.prototype.setSetting
function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_COMPACTION_BOUNDARY") }
const targetKey = ({ binding: { target } }: Host) => JSON.stringify({
  threadId: target.threadId, workspace: target.workspace, incarnation: target.incarnation,
  checkpointNamespace: target.checkpointNamespace, logicalSessionId: target.logicalSessionId,
  conversationId: target.conversationId, branchId: target.branchId, kind: target.kind
})
const settingKey = (host: Host) => `host-compaction-boundary:${host.binding.checkpointThreadId}`
function guard(host: Host): void {
  host.binding.signal.throwIfAborted()
  host.binding.assertCurrent()
  host.store.assertCurrent(host.binding.target)
  host.binding.signal.throwIfAborted()
}
async function verified(host: Host, config: RunnableConfig) {
  guard(host)
  const { binding, store } = host
  const incarnation = binding.checkpointIncarnation ?? binding.target.incarnation
  let saved: ReturnType<FunctionConversationStore["readCheckpointRecoverySnapshot"]> | undefined
  const captured = await captureConversationCheckpointRead(store, host.saver, config, tuple => {
    const state = readFunctionConversationState(tuple.checkpoint.channel_values.cmbFunctionConversation)
    assertFunctionConversationState(binding.target, state)
    saved = store.readCheckpointRecoverySnapshot(binding.target, {
      checkpointThreadId: binding.checkpointThreadId, checkpointIncarnation: incarnation,
      checkpointId: tuple.checkpoint.id
    }, () => guard(host))
    return { target: binding.target, checkpointThreadId: binding.checkpointThreadId,
      checkpointIncarnation: incarnation, cut: saved.snapshot.cut, frontier: state.frontier,
      stateDigest: functionConversationMembershipDigest(state), assertCurrent: () => guard(host) }
  }, () => guard(host))
  if (!captured.proof || !captured.tuple || !saved) fail()
  const snapshot = readFunctionConversationCheckpointMembership(captured.proof, store, binding.target)
  if (functionConversationMembershipDigest(snapshot) !== functionConversationMembershipDigest(saved.snapshot)) fail()
  guard(host)
  return { tuple: captured.tuple, snapshot, rows: saved.rows }
}
function projectionDigest(host: Host, uuid: string): string {
  const columns = assertStoredProjectionReceipt(host.database, {
    threadId: host.binding.checkpointThreadId,
    incarnation: host.binding.checkpointIncarnation ?? host.binding.target.incarnation,
    messageId: uuid, assertCurrent: () => guard(host)
  })
  if (columns.message_id !== uuid || !["user", "assistant"].includes(String(columns.role))) fail()
  return functionConversationMembershipDigest(columns)
}

/** Only a genuine checkpoint/member read can mint a source; SDK JSON cannot create this token. */
export async function captureFunctionConversationCompactionSource(
  host: Host, config: RunnableConfig
): Promise<FunctionConversationCompactionSource> {
  const original = await verified(host, config)
  const actual = await SqlJsSaver.prototype.readCompactionCheckpoint.call(host.saver, config)
  guard(host)
  if (!actual) fail()
  const channels = await SqlJsSaver.prototype.digestCompactionChannels.call(host.saver,
    original.tuple.checkpoint.channel_values, () => { guard(host); actual.assertCurrent() })
  if (!sameChannels(channels, actual.descriptor.channels)) fail()
  actual.assertCurrent()
  const member = original.snapshot.members.at(-1)
  // An unrepresented trailing native/legacy message has no trustworthy SQL boundary.
  if (!member || member.ordinal !== original.snapshot.nativeMessageCount - 1) fail()
  const row = original.rows.at(-1)
  if (!row || row.uuid !== member.uuid || row.receiptId !== member.rowReceiptId ||
    row.message.isMeta === true || !["user", "assistant"].includes(String(row.message.type))) fail()
  const source = Object.freeze({ [sourceBrand]: true as const })
  apply(weakSet, sources, [source, { host, source: original.snapshot, boundary: {
    version: 1, target: targetKey(host), sourceCheckpointId: original.snapshot.checkpointId,
    sourceSnapshotDigest: original.snapshot.snapshotDigest, uuid: row.uuid,
    rowDigest: member.rowDigest, rowReceiptId: row.receiptId,
    projectionDigest: projectionDigest(host, row.uuid)
  }, descriptor: actual.descriptor }])
  return source
}

function sameChannels(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key =>
    Object.hasOwn(b, key) && typeof a[key] === "string" && a[key] === b[key])
}
function sourceWitness(host: Host, boundary: CompactionCommitRecord["source"]):
  FunctionConversationCheckpointMembershipSnapshot {
  guard(host)
  const saved = host.store.readCheckpointRecoverySnapshot(host.binding.target, {
    checkpointThreadId: host.binding.checkpointThreadId,
    checkpointIncarnation: host.binding.checkpointIncarnation ?? host.binding.target.incarnation,
    checkpointId: boundary.sourceCheckpointId
  }, () => guard(host))
  const member = saved.snapshot.members.at(-1)
  if (boundary.target !== targetKey(host) || saved.snapshot.snapshotDigest !== boundary.sourceSnapshotDigest ||
    !member || member.ordinal !== saved.snapshot.nativeMessageCount - 1 ||
    member.uuid !== boundary.uuid || member.rowDigest !== boundary.rowDigest ||
    member.rowReceiptId !== boundary.rowReceiptId || projectionDigest(host, boundary.uuid) !== boundary.projectionDigest)
    fail()
  guard(host)
  return saved.snapshot
}
function nativeJournal(host: Host): FunctionConversationCompactionJournal {
  const execution = readFunctionConversationStoreCurrentExecution(host.store, host.database)
  if (!execution) fail()
  return new FunctionConversationCompactionJournal(host.database, targetKey(host), () => {
    execution.assertDataCurrent()
    guard(host)
  })
}
function attempt(commit: FunctionConversationCompactionCommit): CommitAttempt {
  const value = apply(weakGet, commits, [commit]) as CommitAttempt | undefined
  if (!value || value.settled || attempts.get(value.intentId)?.active !== value) fail()
  guard(value.host)
  return value
}

/** A real native source and the original Saver codec fix the only permitted channel delta. */
export async function prepareFunctionConversationCompactionCommit(source: FunctionConversationCompactionSource,
  updates: Readonly<Record<string, unknown>>): Promise<FunctionConversationCompactionCommit> {
  const original = apply(weakGet, sources, [source]) as ReturnType<typeof sources.get>
  if (!original || Object.hasOwn(updates, "cmbFunctionConversation")) fail()
  const host = original.host
  guard(host)
  const fixedUpdates = { ...updates }
  if (Object.hasOwn(fixedUpdates, "messages"))
    fixedUpdates.messages = prepareCompactionMessageIdentities(fixedUpdates.messages)
  const captured = await SqlJsSaver.prototype.readCompactionCheckpoint.call(host.saver, {
    configurable: { thread_id: host.binding.checkpointThreadId,
      checkpoint_ns: host.binding.target.checkpointNamespace, checkpoint_id: original.source.checkpointId }
  })
  guard(host)
  if (!captured || JSON.stringify(captured.descriptor) !== JSON.stringify(original.descriptor))
    fail()
  const updatedChannels = await SqlJsSaver.prototype.digestCompactionChannels.call(host.saver,
    fixedUpdates, () => { guard(host); captured.assertCurrent() })
  guard(host)
  captured.assertCurrent()
  sourceWitness(host, original.boundary)
  const expectedChannels = Object.freeze({ ...captured.descriptor.channels, ...updatedChannels })
  const expectedUpdateDigest = functionConversationMembershipDigest(Object.entries(updatedChannels)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  const intentId = functionConversationMembershipDigest({ target: targetKey(host),
    sourceCheckpointId: original.source.checkpointId, sourceSnapshotDigest: original.source.snapshotDigest,
    expectedUpdateDigest })
  const journal = nativeJournal(host)
  if (attempts.has(intentId) || journal.read(intentId) || journal.readActive())
    throw new ModFunctionError("MODS_CONVERSATION_COMPACTION_BUSY")
  const commit = Object.freeze({ [commitBrand]: true as const })
  const writeBatch = SqlJsSaver.prototype.createCompactionWriteBatch.call(host.saver, {
    configurable: { thread_id: host.binding.checkpointThreadId,
      checkpoint_ns: host.binding.target.checkpointNamespace, checkpoint_id: original.source.checkpointId }
  }, () => { guard(host); captured.assertCurrent() })
  const value: CommitAttempt = { source, host, sourceDescriptor: captured.descriptor,
    assertSource: captured.assertCurrent, expectedChannels, expectedUpdateDigest, intentId, journal,
    writeBatch, settled: false }
  apply(weakSet, commits, [commit, value])
  attempts.set(intentId, { active: value, settled: false })
  original.commit = commit
  return commit
}

export async function stageFunctionConversationCompactionWrites(commit: FunctionConversationCompactionCommit,
  config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
  const value = attempt(commit)
  await SqlJsSaver.prototype.stageCompactionWrites.call(value.host.saver, value.writeBatch, config, writes, taskId)
  guard(value.host)
}
export function assertFunctionConversationCompactionReadable(commit: FunctionConversationCompactionCommit): void {
  const value = apply(weakGet, commits, [commit]) as CommitAttempt | undefined
  if (!value) fail()
  SqlJsSaver.prototype.assertCompactionWriteBatchReadable.call(value.host.saver, value.writeBatch)
}
export function assertFunctionConversationCompactionWriteCurrent(commit: FunctionConversationCompactionCommit): void {
  const value = apply(weakGet, commits, [commit]) as CommitAttempt | undefined
  if (!value) fail()
  value.assertCommitted?.()
}

/** Original pre-COMMIT callback only: JSON/hash values cannot mint either required private proof. */
export function prepareFunctionConversationCompactionWrite(commit: FunctionConversationCompactionCommit,
  receipt: SqlJsSaverPreparedCheckpointReceipt): void {
  const value = attempt(commit), original = apply(weakGet, sources, [value.source]) as ReturnType<typeof sources.get>
  if (!original || value.record) fail()
  value.assertSource()
  const destination = SqlJsSaver.prototype.readPreparedCheckpoint.call(value.host.saver, receipt)
  SqlJsSaver.prototype.assertPreparedCheckpointFreshDestination.call(value.host.saver, receipt)
  if (destination.parentCheckpointId !== value.sourceDescriptor.checkpointId ||
    destination.checkpointId === value.sourceDescriptor.checkpointId ||
    destination.threadId !== value.sourceDescriptor.threadId ||
    destination.namespace !== value.sourceDescriptor.namespace ||
    !sameChannels(destination.channels, value.expectedChannels)) fail()
  sourceWitness(value.host, original.boundary)
  value.assertSource()
  const sourceWrites = SqlJsSaver.prototype.bindPreparedCompactionWrites.call(value.host.saver,
    receipt, value.writeBatch)
  const record: CompactionCommitRecord = { version: 1, intentId: value.intentId,
    target: targetKey(value.host), expectedUpdateDigest: value.expectedUpdateDigest,
    source: original.boundary, sourceDescriptor: value.sourceDescriptor, destination, sourceWrites,
    writerPid: process.pid, writerBoot, phase: "prepared", createdAt: Date.now(), updatedAt: Date.now() }
  value.journal.prepare(record)
  value.record = record
  value.assertSource()
  SqlJsSaver.prototype.readPreparedCheckpoint.call(value.host.saver, receipt)
}

/** Copy only the cut authenticated by this exact private source, never the current high water. */
export function functionConversationCompactionCanonicalCut(commit: FunctionConversationCompactionCommit):
  FunctionConversationCanonicalCut {
  const value = attempt(commit), original = apply(weakGet, sources, [value.source]) as ReturnType<typeof sources.get>
  if (!original) fail()
  value.assertSource()
  sourceWitness(value.host, original.boundary)
  const cut = original.source.cut
  // Keep the same serialized cut used by exact-point recovery.
  return Object.freeze({ ...cut,
    lineage: Object.freeze(cut.lineage.map(entry => Object.freeze({ ...entry }))) })
}

export async function observeFunctionConversationCompactionWrite(commit: FunctionConversationCompactionCommit,
  receipt: SqlJsSaverCommittedCheckpointReceipt): Promise<void> {
  const value = attempt(commit)
  if (!value.record || value.record.phase !== "prepared") fail()
  const current = SqlJsSaver.prototype.captureCommittedCheckpointDataFence.call(value.host.saver, receipt)
  const writes = SqlJsSaver.prototype.readCommittedCompactionWrites.call(value.host.saver, receipt)
  if (JSON.stringify(writes) !== JSON.stringify(value.record.sourceWrites)) fail()
  await SqlJsSaver.prototype.verifyCompactionWrites.call(value.host.saver, writes, value.sourceDescriptor, receipt)
  current()
  const actual = await SqlJsSaver.prototype.readCommittedCheckpointDescriptor.call(value.host.saver, receipt)
  current()
  guard(value.host)
  if (JSON.stringify(actual) !== JSON.stringify(value.record.destination)) fail()
  sourceWitness(value.host, value.record.source)
  value.record = value.journal.advance(value.record, "checkpoint-committed")
  value.assertCommitted = current
}

export function acknowledgeFunctionConversationCompactionWrite(commit: FunctionConversationCompactionCommit,
  database: NativeSqliteAdapter, checkpointId: string): void {
  const value = attempt(commit)
  if (!value.record || database !== value.host.database || !database.inTransaction ||
    value.record.phase !== "checkpoint-committed" || value.record.destination.checkpointId !== checkpointId) fail()
  value.record = value.journal.advanceInsideTransaction(value.record, "ack-persisted")
}

/** Called only after the SDK's actual updateState promise/finally has settled. */
export function settleFunctionConversationCompactionAttempt(commit: FunctionConversationCompactionCommit): void {
  const value = apply(weakGet, commits, [commit]) as CommitAttempt | undefined
  if (!value) fail()
  value.settled = true
  SqlJsSaver.prototype.releaseCompactionWriteBatch.call(value.host.saver, value.writeBatch)
  // Unknown physical completion facts retain no Saver, source tuple, or history arrays.
  attempts.set(value.intentId, { settled: true })
  try {
    const row = value.journal.read(value.intentId)
    if (!row || row.phase === "ready" || row.phase === "abandoned") attempts.delete(value.intentId)
  } catch { /* A revoked host cannot clean evidence, but actual SDK completion remains a fact. */ }
}

/** Only unchanged actual native storage and a settled original SDK call prove safe compensation. */
export async function functionConversationCompactionArchiveMayRollback(commit: FunctionConversationCompactionCommit):
  Promise<boolean> {
  const value = apply(weakGet, commits, [commit]) as CommitAttempt | undefined
  if (!value?.settled) return false
  try {
    guard(value.host)
    const row = value.journal.read(value.intentId)
    if (row?.phase === "abandoned") return true
    if (row && row.phase !== "prepared") return false
    await SqlJsSaver.prototype.digestCompactionChannels.call(value.host.saver, {}, () => {
      guard(value.host); value.assertSource()
    })
    value.assertSource()
    guard(value.host)
    return true
  } catch { return false }
}

function assertDestination(host: Host, record: CompactionCommitRecord,
  descriptor: SqlJsSaverPreparedCheckpointDescriptor): void {
  guard(host)
  if (record.target !== targetKey(host) || descriptor.threadId !== host.binding.checkpointThreadId ||
    descriptor.namespace !== host.binding.target.checkpointNamespace ||
    record.destination.parentCheckpointId !== record.source.sourceCheckpointId ||
    JSON.stringify(record.destination) !== JSON.stringify(descriptor)) fail()
}
function originalWriterSettled(record: CompactionCommitRecord): boolean {
  if (record.writerPid === process.pid && record.writerBoot === writerBoot)
    return attempts.get(record.intentId)?.settled === true
  if (record.writerPid === process.pid) return false
  try { process.kill(record.writerPid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" }
}
function writeLedger(host: Host, record: CompactionCommitRecord, tuple: CheckpointTuple,
  snapshot: FunctionConversationCheckpointMembershipSnapshot): void {
  guard(host)
  const ledger: Boundary = { ...record.source, destinationCheckpointId: snapshot.checkpointId,
    destinationSnapshotDigest: snapshot.snapshotDigest,
    destinationCheckpointDigest: functionConversationMembershipDigest(tuple.checkpoint) }
  const serialized = JSON.stringify(ledger)
  if (apply(getSetting, host.control, [settingKey(host), ""]) !== serialized)
    apply(setSetting, host.control, [settingKey(host), serialized])
  guard(host)
  if (apply(getSetting, host.control, [settingKey(host), ""]) !== serialized) fail()
  guard(host)
}

export type FunctionConversationCompactionReconciliation = "none" | "ready" | "abandoned" | "quarantined"
const recoveryTails = new WeakMap<NativeSqliteAdapter, Map<string, Promise<void>>>()

/** Exact native reconciliation only: never runs a graph/model/tool or substitutes the latest cut. */
export async function reconcileFunctionConversationCompaction(host: Host,
  config: Readonly<RunnableConfig>): Promise<FunctionConversationCompactionReconciliation> {
  guard(host)
  // Most conversations predate/no longer have a partial compaction: read-only journal miss.
  if (!host.database.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND " +
    "name='function_conversation_compaction_commits' LIMIT 1")[0]?.values.length) return "none"
  const point = Object.freeze({ configurable: Object.freeze({
    thread_id: config.configurable?.thread_id, checkpoint_ns: config.configurable?.checkpoint_ns ?? "",
    checkpoint_id: config.configurable?.checkpoint_id }) })
  if (point.configurable.thread_id !== host.binding.checkpointThreadId ||
    point.configurable.checkpoint_ns !== host.binding.target.checkpointNamespace ||
    typeof point.configurable.checkpoint_id !== "string" || !point.configurable.checkpoint_id) fail()
  let tails = recoveryTails.get(host.database)
  if (!tails) { tails = new Map(); recoveryTails.set(host.database, tails) }
  const key = targetKey(host), previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const done = new Promise<void>(resolve => { release = resolve })
  const tail = previous.catch(() => {}).then(() => done)
  tails.set(key, tail)
  await previous.catch(() => {})
  try {
    guard(host)
    const journal = nativeJournal(host)
    let record = journal.readActive()
    if (!record) return "none"
    if (record.phase === "quarantined") return "quarantined"
    if (point.configurable.checkpoint_id !== record.destination.checkpointId &&
      point.configurable.checkpoint_id !== record.source.sourceCheckpointId) return "none"
    if (!originalWriterSettled(record))
      throw new ModFunctionError("MODS_CONVERSATION_COMPACTION_BUSY")
    const exact = { configurable: { thread_id: host.binding.checkpointThreadId,
      checkpoint_ns: host.binding.target.checkpointNamespace,
      checkpoint_id: record.destination.checkpointId } }
    const destination = await SqlJsSaver.prototype.readCompactionCheckpoint.call(host.saver, exact)
    guard(host)
    const source = sourceWitness(host, record.source)
    if (!destination) {
      if (record.phase !== "prepared") {
        journal.advance(record, "quarantined", "destination-changed")
        return fail()
      }
      const sourceConfig = { configurable: { ...exact.configurable, checkpoint_id: record.source.sourceCheckpointId } }
      const original = await SqlJsSaver.prototype.readCompactionCheckpoint.call(host.saver, sourceConfig)
      guard(host)
      const latest = await SqlJsSaver.prototype.isCompactionCheckpointLatest.call(host.saver, sourceConfig)
      guard(host)
      if (!original || !latest || JSON.stringify(original.descriptor) !== JSON.stringify(record.sourceDescriptor)) {
        journal.advance(record, "quarantined", "source-changed")
        return fail()
      }
      original.assertCurrent()
      sourceWitness(host, record.source)
      journal.advance(record, "abandoned")
      attempts.delete(record.intentId)
      return "abandoned"
    }
    if (point.configurable.checkpoint_id !== record.destination.checkpointId) return "none"
    try { assertDestination(host, record, destination.descriptor) }
    catch (error) { journal.advance(record, "quarantined", "destination-changed"); throw error }
    if (record.sourceWrites) {
      await SqlJsSaver.prototype.verifyCompactionWrites.call(host.saver, record.sourceWrites,
        record.sourceDescriptor)
      guard(host)
      destination.assertCurrent()
    }
    const committedSource = FunctionConversationStore.prototype.captureCommittedCheckpointRecovery.call(
      host.store, host.binding.target, {
        checkpointThreadId: host.binding.checkpointThreadId,
        checkpointIncarnation: host.binding.checkpointIncarnation ?? host.binding.target.incarnation,
        checkpointId: record.source.sourceCheckpointId
      }, () => guard(host))
    if (committedSource.snapshot.snapshotDigest !== source.snapshotDigest) fail()
    const current = () => {
      guard(host)
      destination.assertCurrent()
      if (host.database.inTransaction) {
        FunctionConversationStore.prototype.assertCommittedCheckpointRecovery.call(host.store,
          committedSource.proof)
        if (projectionDigest(host, record!.source.uuid) !== record!.source.projectionDigest) fail()
      } else sourceWitness(host, record!.source)
    }
    if (record.phase === "prepared") record = journal.advance(record, "checkpoint-committed")
    if (record.phase === "checkpoint-committed") {
      const captured = await captureConversationCheckpointRead(host.store, host.saver, exact, tuple => {
        current()
        const state = readFunctionConversationState(tuple.checkpoint.channel_values.cmbFunctionConversation)
        assertFunctionConversationState(host.binding.target, state)
        if (functionConversationMembershipDigest(state) !== source.stateDigest || state.frontier !== source.frontier)
          fail()
        return { target: host.binding.target, checkpointThreadId: host.binding.checkpointThreadId,
          checkpointIncarnation: host.binding.checkpointIncarnation ?? host.binding.target.incarnation,
          cut: source.cut, frontier: state.frontier, stateDigest: source.stateDigest, assertCurrent: current }
      }, current)
      current()
      if (!captured.proof || !captured.tuple) fail()
      const snapshot = readFunctionConversationCheckpointMembership(captured.proof, host.store, host.binding.target)
      const state = readFunctionConversationState(captured.tuple.checkpoint.channel_values.cmbFunctionConversation)
      const generation = functionConversationMembershipDigest({ id: captured.tuple.checkpoint.id,
        ts: captured.tuple.checkpoint.ts, state, thread: host.binding.checkpointThreadId,
        namespace: host.binding.target.checkpointNamespace, membership: snapshot.snapshotDigest })
      const delivery = host.store.captureCheckpointDelivery(host.binding.target, {
        checkpointId: snapshot.checkpointId, generation, frontier: state.frontier
      }, current)
      const expected = record
      host.store.recordCheckpointDelivery(host.binding.target, delivery, current, captured.proof, database => {
        if (database !== host.database) fail()
        journal.advanceInsideTransaction(expected, "ack-persisted")
      })
      current()
      record = journal.read(record.intentId)
      if (!record || record.phase !== "ack-persisted") fail()
    }
    if (record.phase !== "ack-persisted") fail()
    const acknowledged = await verified(host, exact)
    current()
    if (acknowledged.snapshot.parentCheckpointId !== record.source.sourceCheckpointId) fail()
    writeLedger(host, record, acknowledged.tuple, acknowledged.snapshot)
    current()
    journal.advance(record, "ready")
    journal.retainReady(record.destination.checkpointId)
    attempts.delete(record.intentId)
    return "ready"
  } finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}

/**
 * The host calls this only after its private plan and durable summary readback both succeed.
 * A prepared journal additionally supports exact native reconciliation after a process crash.
 * Missing or changed original evidence stays unknown; a public summary marker grants nothing.
 */
export async function commitFunctionConversationCompactionBoundary(
  source: FunctionConversationCompactionSource, config: RunnableConfig
): Promise<void> {
  const original = apply(weakGet, sources, [source]) as ReturnType<typeof sources.get>
  if (!original) fail()
  const destination = await verified(original.host, config)
  if (destination.snapshot.parentCheckpointId !== original.source.checkpointId) fail()
  const record: Boundary = { ...original.boundary,
    destinationCheckpointId: destination.snapshot.checkpointId,
    destinationSnapshotDigest: destination.snapshot.snapshotDigest,
    destinationCheckpointDigest: functionConversationMembershipDigest(destination.tuple.checkpoint) }
  guard(original.host)
  let commit: { value: CommitAttempt; journal: CompactionCommitRecord; assertCurrent(): void } | undefined
  if (original.commit) {
    const value = apply(weakGet, commits, [original.commit]) as CommitAttempt | undefined
    if (!value) fail()
    const journal = value.journal.read(value.intentId)
    if (!journal || !["ack-persisted", "ready"].includes(journal.phase)) fail()
    const actual = await SqlJsSaver.prototype.readCompactionCheckpoint.call(original.host.saver, config)
    guard(original.host)
    if (!actual) fail()
    assertDestination(original.host, journal, actual.descriptor)
    actual.assertCurrent()
    commit = { value, journal, assertCurrent: actual.assertCurrent }
  }
  // mods_meta is a host-only namespace. SDK $.store is confined to mods_function_state;
  // a public summary marker or guest store key cannot manufacture a covered prefix.
  const serialized = JSON.stringify(record)
  commit?.assertCurrent()
  if (apply(getSetting, original.host.control, [settingKey(original.host), ""]) !== serialized)
    apply(setSetting, original.host.control, [settingKey(original.host), serialized])
  guard(original.host)
  if (apply(getSetting, original.host.control, [settingKey(original.host), ""]) !== serialized) fail()
  if (commit) {
    commit.assertCurrent()
    if (commit.journal.phase !== "ready") commit.value.journal.advance(commit.journal, "ready")
    commit.value.journal.retainReady(commit.journal.destination.checkpointId)
    attempts.delete(commit.value.intentId)
  }
  apply(weakDelete, sources, [source])
}

/** A host-only ledger and exact native membership authenticate a compacted SQL prefix. */
export async function readFunctionConversationCompactionBoundary(
  host: Host, tuple: CheckpointTuple
): Promise<string | undefined> {
  guard(host)
  const raw = apply(getSetting, host.control, [settingKey(host), ""]) as string
  if (!raw) return undefined
  let value: unknown
  try { value = JSON.parse(raw) } catch { return fail() }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail()
  const record = value as Boundary
  // A later ordinary checkpoint has its own visible boundary. Never apply an older anchor.
  if (record.destinationCheckpointId !== tuple.checkpoint.id) return undefined
  if (record.version !== 1 || record.target !== targetKey(host)) fail()
  const current = await verified(host, tuple.config)
  if (current.snapshot.snapshotDigest !== record.destinationSnapshotDigest ||
    functionConversationMembershipDigest(current.tuple.checkpoint) !== record.destinationCheckpointDigest ||
    functionConversationMembershipDigest(current.tuple.checkpoint) !==
      functionConversationMembershipDigest(tuple.checkpoint)) fail()
  const saved = host.store.readCheckpointRecoverySnapshot(host.binding.target, {
    checkpointThreadId: host.binding.checkpointThreadId,
    checkpointIncarnation: host.binding.checkpointIncarnation ?? host.binding.target.incarnation,
    checkpointId: record.sourceCheckpointId
  }, () => guard(host))
  const member = saved.snapshot.members.at(-1)
  if (saved.snapshot.snapshotDigest !== record.sourceSnapshotDigest ||
    current.snapshot.parentCheckpointId !== record.sourceCheckpointId ||
    !member || member.ordinal !== saved.snapshot.nativeMessageCount - 1 ||
    member.uuid !== record.uuid || member.rowReceiptId !== record.rowReceiptId ||
    member.rowDigest !== record.rowDigest || projectionDigest(host, record.uuid) !== record.projectionDigest) fail()
  guard(host)
  return record.uuid
}
