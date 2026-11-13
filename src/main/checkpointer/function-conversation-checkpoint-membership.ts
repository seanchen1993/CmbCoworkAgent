import { createHash } from "node:crypto"
import { createNativeCheckpointMessageDigest } from "./function-conversation-canonical-display-worker"
import { readFunctionConversationBridgePreparation, type FunctionConversationDeliveryBridge,
  type FunctionConversationPreparedCheckpoint } from "./function-conversation-delivery"
import { BaseMessage, ToolMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import type { CheckpointTuple } from "@langchain/langgraph-checkpoint"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import {
  hasInvalidFunctionConversationTranscriptStamp,
  readFunctionConversationTranscriptStamp,
  sameFunctionConversationTranscriptStamp,
  validateFunctionConversationTranscriptStamp,
  type FunctionConversationTranscriptStamp
} from "../../shared/mods/v2/conversation-transcript"
import { deserializeFunctionConversationNativeMessage,
  serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import type {
  FunctionConversationRef, FunctionConversationRow, FunctionConversationStore
} from "../db/function-conversation-store"
import type { ThreadIncarnation } from "../services/thread-incarnation"
import { SqlJsSaver, type SqlJsSaverCommittedCheckpointReceipt,
  type SqlJsSaverFunctionConversationRecoveryReceipt,
  type SqlJsSaverPreparedCheckpointReceipt,
  readSqlJsSaverPreparedConversationData,
  readSqlJsSaverPreparedConversationDataFacts } from "./sqljs-saver"
import { isNativeCommittedMembershipAdmission, prepareNativeCommittedCheckpointCapture } from
  "./committed-checkpoint-native-capture"

export interface FunctionConversationCanonicalCut {
  readonly highWater: number
  readonly lineage: readonly { readonly branchId: string; readonly cut: number }[]
  readonly lineageDigest: string
}

export interface FunctionConversationCheckpointMember {
  readonly ordinal: number
  readonly uuid: string
  readonly sequence: number
  readonly branchId: string
  readonly rowReceiptId: string
  readonly rowDigest: string
  readonly stampDigest: string
  readonly nativeDigest: string
  readonly createdAt: number
}

/** Durable selection facts, never a runtime authority or a public checkpoint receipt. */
export interface FunctionConversationCheckpointMembershipSnapshot {
  readonly checkpointThreadId: string
  readonly checkpointIncarnation: string
  readonly namespace: string
  readonly checkpointId: string
  readonly parentCheckpointId: string | null
  readonly checkpointTs: string
  readonly stateDigest: string
  readonly frontier: number
  readonly cut: FunctionConversationCanonicalCut
  readonly nativeSnapshotDigest: string
  readonly nativeMessageCount: number
  readonly members: readonly FunctionConversationCheckpointMember[]
  readonly snapshotDigest: string
}

const brand = Symbol("function-conversation-native-membership")
export interface FunctionConversationCheckpointMembershipProof { readonly [brand]: true }
const proofs = new WeakMap<object, {
  readonly role: "committed" | "prepared-data"
  store: FunctionConversationStore
  target: FunctionConversationRef
  snapshot: FunctionConversationCheckpointMembershipSnapshot
  assertCurrent: () => void
}>()
const originalBridgePreparation = readFunctionConversationBridgePreparation
const originalPreparedData = readSqlJsSaverPreparedConversationData
const originalPreparedFacts = readSqlJsSaverPreparedConversationDataFacts
const membershipStringify = JSON.stringify, membershipKeys = Object.keys
const membershipCreateHash = createHash, membershipApply = Reflect.apply
const membershipHashPrototype = Object.getPrototypeOf(createHash("sha256"))
const membershipUpdate = membershipHashPrototype.update, membershipDigest = membershipHashPrototype.digest
const membershipOwn = Object.getOwnPropertyDescriptor
const membershipPrototype = Object.getPrototypeOf
const membershipFreeze = Object.freeze
const originalNativeMessageDigest = createNativeCheckpointMessageDigest
const membershipDefine = Object.defineProperty
const membershipSetHas = Set.prototype.has, membershipSetAdd = Set.prototype.add
function appendMembershipData<T>(array: T[], value: T): void {
  const descriptor = { __proto__: null, value, writable: true, enumerable: true, configurable: true }
  membershipDefine(array, array.length, descriptor)
}
const originalObjectPrototype = Object.prototype, originalArrayPrototype = Array.prototype
function assertMembershipJsonDispatch(): void {
  if (membershipOwn(originalObjectPrototype, "toJSON") || membershipOwn(originalArrayPrototype, "toJSON") ||
    membershipPrototype(originalArrayPrototype) !== originalObjectPrototype) fail()
}
const nativeCommittedProofs = new WeakSet<FunctionConversationCheckpointMembershipProof>()
const nativeProofHas = WeakSet.prototype.has, nativeProofAdd = WeakSet.prototype.add
const proofGet = WeakMap.prototype.get, proofSet = WeakMap.prototype.set, proofApply = Reflect.apply
const missingMessages = new WeakMap<FunctionConversationCheckpointMembershipProof, {
  messages: readonly BaseMessage[]
  verify: (messages?: readonly BaseMessage[]) => void
}>()

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP") }
export function functionConversationMembershipDigest(value: unknown): string {
  assertMembershipJsonDispatch()
  const hash = membershipCreateHash("sha256")
  membershipApply(membershipUpdate, hash, [membershipStringify(value)])
  return membershipApply(membershipDigest, hash, ["hex"]) as string
}
export function functionConversationRowDigest(row: FunctionConversationRow): string {
  return functionConversationMembershipDigest(row)
}
export function functionConversationCanonicalStamp(target: FunctionConversationRef,
  row: FunctionConversationRow): FunctionConversationTranscriptStamp {
  const stamp = { conversationId: target.conversationId, branchId: row.branchId,
    uuid: row.uuid, sequence: row.sequence, door: row.door, messageType: row.message.type,
    ...(row.message.isMeta === true ? { isMeta: true as const } : {}), origin: row.origin }
  validateFunctionConversationTranscriptStamp(stamp)
  return stamp
}

export interface FunctionConversationMembershipAdmission {
  readonly target: FunctionConversationRef
  readonly checkpointThreadId: string
  readonly checkpointIncarnation: ThreadIncarnation
  readonly cut: FunctionConversationCanonicalCut
  readonly frontier: number
  readonly stateDigest: string
  readonly assertCurrent: () => void
}

function calculateTupleSnapshot(store: FunctionConversationStore, tuple: CheckpointTuple,
  admission: FunctionConversationMembershipAdmission, nativeGuard: () => void, batchRows = false,
  assertNativeCopy?: () => void, preparedData = false
): { snapshot: FunctionConversationCheckpointMembershipSnapshot; assertCurrent: () => void
  stamps: readonly FunctionConversationTranscriptStamp[] } {
  const freeze: typeof Object.freeze = preparedData ? membershipFreeze : value => Object.freeze(value)
  const target = admission.target
  let cut = admission.cut
  if (preparedData) {
    const lineage: Array<{ readonly branchId: string; readonly cut: number }> = []
    for (let index = 0; index < cut.lineage.length; index++) {
      const entry = cut.lineage[index]
      appendMembershipData(lineage, membershipFreeze({ branchId: entry.branchId, cut: entry.cut }))
    }
    const copied = {} as { highWater: number; lineage: FunctionConversationCanonicalCut["lineage"];
      lineageDigest: string }
    const keys = membershipKeys(cut)
    if (keys.length !== 3) fail()
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (key !== "highWater" && key !== "lineage" && key !== "lineageDigest") fail()
      const value = key === "lineage" ? membershipFreeze(lineage) : cut[key]
      const descriptor = { __proto__: null, value, writable: false, configurable: false, enumerable: true }
      membershipDefine(copied, key, descriptor)
    }
    cut = membershipFreeze(copied)
  }
  const guard = () => {
    nativeGuard(); admission.assertCurrent(); store.assertCurrent(target)
    // A real source callback may mutate the tuple or dispatch. Recheck after its final call,
    // before the synchronous batch can consume a private copy under changed qualifications.
    assertNativeCopy?.()
  }
  guard()
  if (tuple.config.configurable?.thread_id !== admission.checkpointThreadId ||
    (tuple.config.configurable?.checkpoint_ns ?? "") !== target.checkpointNamespace ||
    tuple.config.configurable?.checkpoint_id !== tuple.checkpoint.id ||
    typeof tuple.checkpoint.id !== "string" || !tuple.checkpoint.id ||
    typeof tuple.checkpoint.ts !== "string" || !tuple.checkpoint.ts) fail()
  const state = tuple.checkpoint.channel_values.cmbFunctionConversation
  if (!state || typeof state !== "object" || Array.isArray(state)) fail()
  const actualState = state as Record<string, unknown>
  if (actualState.version !== 1 || actualState.logicalSessionId !== target.logicalSessionId ||
    actualState.conversationId !== target.conversationId || actualState.branchId !== target.branchId ||
    actualState.frontier !== admission.frontier ||
    functionConversationMembershipDigest({ version: actualState.version,
      logicalSessionId: actualState.logicalSessionId, conversationId: actualState.conversationId,
      branchId: actualState.branchId, frontier: actualState.frontier }) !== admission.stateDigest) fail()
  store.assertCheckpointCanonicalCut(target, cut)
  const messages: unknown = tuple.checkpoint.channel_values.messages ?? []
  if (!Array.isArray(messages)) fail()
  const members: FunctionConversationCheckpointMember[] = [], native = preparedData ? originalNativeMessageDigest() : createNativeCheckpointMessageDigest()
  const stamps: FunctionConversationTranscriptStamp[] = []
  const seen = new Set<string>()
  // Full display captures verify their original tuple in the source guard. Keep that
  // expensive guard at the two boundaries of one synchronous native-row batch.
  const batch = batchRows ? new Map(store.readRowsAtCut(target, messages.flatMap(message => {
    const stamp = readFunctionConversationTranscriptStamp(message)
    return stamp ? [stamp.uuid] : []
  }), { frontier: cut.highWater }, guard, preparedData).map(row => [row.uuid, row])) : undefined
  for (let ordinal = 0; ordinal < messages.length; ordinal += 1) {
    const message: unknown = messages[ordinal]
    if (!BaseMessage.isInstance(message) || hasInvalidFunctionConversationTranscriptStamp(message)) fail()
    const stamp = readFunctionConversationTranscriptStamp(message)
    if (!stamp) { native.append(membershipStringify(message.toDict())); continue }
    const payload = serializeFunctionConversationNativeMessage(message)
    native.append(payload)
    if (stamp.conversationId !== target.conversationId || message.id !== stamp.uuid ||
      (preparedData ? membershipApply(membershipSetHas, seen, [stamp.uuid]) : seen.has(stamp.uuid))) fail()
    const type = message.getType()
    if ((stamp.messageType === "user" && type !== "human" && !ToolMessage.isInstance(message)) ||
      (stamp.messageType === "assistant" && type !== "ai") ||
      (stamp.messageType === "system" && type !== "system")) fail()
    if (preparedData) membershipApply(membershipSetAdd, seen, [stamp.uuid])
    else seen.add(stamp.uuid)
    const row = batch ? batch.get(stamp.uuid) :
      store.readRowAtCut(target, stamp.uuid, { frontier: cut.highWater }, guard)
    if (!row) fail()
    if (stamp.messageType === "user" && ToolMessage.isInstance(message)) {
      const content = row.message.content
      if (!["tool-result", "tool-message"].includes(row.door) || row.message.isMeta === true ||
        row.message.role !== "user" || !Array.isArray(content) || content.length !== 1 ||
        !content[0] || typeof content[0] !== "object" || Array.isArray(content[0]) ||
        content[0].type !== "tool_result" || content[0].tool_use_id !== message.tool_call_id)
        fail()
    }
    const expected = functionConversationCanonicalStamp(target, row)
    if (!(preparedData ? samePreparedStamp(stamp, expected) :
      sameFunctionConversationTranscriptStamp(stamp, expected)) || payload !== row.nativePayload) fail()
    appendMembershipData(stamps, freeze({ ...expected, origin: freeze({ ...expected.origin }) }))
    appendMembershipData(members, freeze({ ordinal, uuid: row.uuid, sequence: row.sequence,
      branchId: row.branchId, rowReceiptId: row.receiptId,
      rowDigest: functionConversationRowDigest(row), stampDigest: functionConversationMembershipDigest(expected),
      nativeDigest: functionConversationMembershipDigest(payload), createdAt: row.createdAt }))
  }
  const incarnation = admission.checkpointIncarnation
  const checkpointIncarnation = JSON.stringify(incarnation.token === null
    ? ["legacy", incarnation.legacyCreatedAt] : ["token", incarnation.token])
  if ((incarnation.token !== null && (typeof incarnation.token !== "string" || !incarnation.token)) ||
    !Number.isSafeInteger(incarnation.legacyCreatedAt) || incarnation.legacyCreatedAt < 0) fail()
  const values = { checkpointThreadId: admission.checkpointThreadId, checkpointIncarnation,
    namespace: target.checkpointNamespace, checkpointId: tuple.checkpoint.id,
    parentCheckpointId: typeof tuple.parentConfig?.configurable?.checkpoint_id === "string"
      ? tuple.parentConfig.configurable.checkpoint_id : null,
    checkpointTs: tuple.checkpoint.ts, stateDigest: admission.stateDigest, frontier: admission.frontier,
    cut, nativeSnapshotDigest: native.finish(), nativeMessageCount: messages.length,
    members: freeze(members) }
  const snapshot = freeze({ ...values, snapshotDigest: functionConversationMembershipDigest(values) })
  guard()
  return { snapshot, assertCurrent: guard, stamps: freeze(stamps) }
}

function captureTuple(store: FunctionConversationStore, tuple: CheckpointTuple,
  admission: FunctionConversationMembershipAdmission, nativeGuard: () => void, batchRows = false,
  assertNativeCopy?: () => void): FunctionConversationCheckpointMembershipProof {
  const actual = calculateTupleSnapshot(store, tuple, admission, nativeGuard, batchRows, assertNativeCopy)
  const proof = Object.freeze({ [brand]: true as const })
  proofApply(proofSet, proofs, [proof, { role: "committed", store, target: admission.target,
    snapshot: actual.snapshot, assertCurrent: actual.assertCurrent }])
  return proof
}

/** Same complete stamp semantics; only the actually used key reader is fixed for this seal. */
function samePreparedStamp(first: ReturnType<typeof functionConversationCanonicalStamp>,
  second: ReturnType<typeof functionConversationCanonicalStamp>): boolean {
  if (first.conversationId !== second.conversationId || first.branchId !== second.branchId ||
    first.uuid !== second.uuid || first.sequence !== second.sequence || first.door !== second.door ||
    first.messageType !== second.messageType || first.isMeta !== second.isMeta) return false
  const keys = membershipKeys(first.origin), expected = membershipKeys(second.origin)
  if (keys.length !== expected.length) return false
  for (let index = 0; index < keys.length; index++)
    if (first.origin[keys[index]] !== second.origin[keys[index]]) return false
  return true
}

/** Neither an admission DTO nor a caller tuple can create a prepared membership record. */
export async function capturePreparedConversationMembership(bridge: FunctionConversationDeliveryBridge,
  observer: object, prepared: FunctionConversationPreparedCheckpoint, saver: SqlJsSaver,
  receipt: SqlJsSaverPreparedCheckpointReceipt): Promise<SqlJsSaverPreparedCheckpointReceipt> {
  const joined = originalBridgePreparation(bridge, observer, prepared, saver)
  const tuple = originalPreparedData(saver, receipt)
  const verify = () => {
    const current = originalBridgePreparation(bridge, observer, prepared, saver)
    if (current.binding !== joined.binding || current.state !== joined.state || current.cut !== joined.cut ||
      originalPreparedData(saver, receipt) !== tuple) fail()
  }
  const candidate = calculateTupleSnapshot(joined.store, tuple, joined.admission, verify, true,
    undefined, true)
  const facts = await originalPreparedFacts(saver, receipt, joined.binding.signal)
  verify(); candidate.assertCurrent()
  const snapshot = candidate.snapshot
  if (facts.checkpointId !== snapshot.checkpointId || facts.parentCheckpointId !== snapshot.parentCheckpointId ||
    facts.checkpointTs !== snapshot.checkpointTs || facts.stateDigest !== snapshot.stateDigest ||
    facts.state.frontier !== snapshot.frontier || facts.nativeMessageCount !== snapshot.nativeMessageCount ||
    facts.nativeSnapshotDigest !== snapshot.nativeSnapshotDigest || facts.stamped.length !== snapshot.members.length)
    fail()
  for (let index = 0; index < facts.stamped.length; index++) {
    const actual = facts.stamped[index], expected = snapshot.members[index]
    if (actual.ordinal !== expected.ordinal || actual.stamp.uuid !== expected.uuid ||
      !samePreparedStamp(actual.stamp, candidate.stamps[index])) fail()
  }
  verify(); candidate.assertCurrent()
  proofApply(proofSet, proofs, [receipt, { role: "prepared-data", store: joined.store, target: joined.admission.target,
    snapshot, assertCurrent: () => { verify(); candidate.assertCurrent() } }])
  return receipt
}

/** Store-only data path. It can never mint a committed/delivery proof. */
export function readPreparedFunctionConversationCheckpointMembership(receipt: SqlJsSaverPreparedCheckpointReceipt,
  store: FunctionConversationStore, target: FunctionConversationRef): FunctionConversationCheckpointMembershipSnapshot {
  const record = proofApply(proofGet, proofs, [receipt]) as ReturnType<typeof proofs.get>
  if (!record || record.role !== "prepared-data" || record.store !== store || record.target !== target) fail()
  record.assertCurrent()
  return record.snapshot
}

/** Only the actual native callback token can read the cached exact committed tuple. */
export function captureCommittedConversationMembership(store: FunctionConversationStore,
  saver: SqlJsSaver, receipt: SqlJsSaverCommittedCheckpointReceipt,
  admission: FunctionConversationMembershipAdmission
): FunctionConversationCheckpointMembershipProof {
  const read = () => SqlJsSaver.prototype.readCommittedCheckpoint.call(saver, receipt)
  const tuple = read()
  if (isNativeCommittedMembershipAdmission(admission, store)) {
    const captured = prepareNativeCommittedCheckpointCapture(store, admission.target, tuple,
      { target: admission.target, cut: admission.cut, incarnation: admission.checkpointIncarnation })
    if (captured) {
      const verify = () => {
        if (!isNativeCommittedMembershipAdmission(admission, store)) fail()
        captured.assertCurrent()
      }
      const proof = captureTuple(store, captured.tuple, admission,
        () => { if (read() !== tuple) fail() }, true, verify)
      proofApply(nativeProofAdd, nativeCommittedProofs, [proof])
      return proof
    }
  }
  return captureTuple(store, tuple, admission, () => { if (read() !== tuple) fail() })
}

/** Classification only. These proofs retain the full live original/copy verifier after a pause. */
export function isNativeCommittedConversationMembership(proof: FunctionConversationCheckpointMembershipProof,
  store: FunctionConversationStore, target: FunctionConversationRef): boolean {
  const actual = proofApply(proofGet, proofs, [proof]) as ReturnType<typeof proofs.get>
  return proofApply(nativeProofHas, nativeCommittedProofs, [proof]) === true &&
    actual?.role === "committed" && actual.store === store && actual.target === target
}

/** Exact native read only. The caller's real binding is checked on both sides of the await. */
export async function captureConversationCheckpointRead(store: FunctionConversationStore,
  saver: SqlJsSaver, config: RunnableConfig,
  admit: (tuple: CheckpointTuple) => FunctionConversationMembershipAdmission | undefined,
  assertCurrent: () => void,
  // Opt in only when assertCurrent checks the full original tuple at both batch boundaries.
  batchRows = false
): Promise<{ proof?: FunctionConversationCheckpointMembershipProof; tuple: CheckpointTuple }> {
  const fixed = { ...config, configurable: { ...config.configurable } }
  if (typeof fixed.configurable.checkpoint_id !== "string" || !fixed.configurable.checkpoint_id) fail()
  assertCurrent()
  await SqlJsSaver.prototype.initialize.call(saver)
  assertCurrent()
  const assertLifetime = SqlJsSaver.prototype.captureReadLifetime.call(saver)
  const guard = () => { assertLifetime(); assertCurrent(); assertLifetime() }
  guard()
  const tuple = await SqlJsSaver.prototype.getTuple.call(saver, fixed)
  guard()
  if (!tuple || tuple.checkpoint.id !== fixed.configurable.checkpoint_id)
    throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_NOT_COMMITTED")
  const admission = admit(tuple)
  return { proof: admission ? captureTuple(store, tuple, admission, guard, batchRows) : undefined, tuple }
}

/** Store-only authentication: copying a brand, JSON or a valid UUID collection does not work. */
export function readFunctionConversationCheckpointMembership(
  proof: FunctionConversationCheckpointMembershipProof, store: FunctionConversationStore,
  target: FunctionConversationRef
): FunctionConversationCheckpointMembershipSnapshot {
  const actual = proofApply(proofGet, proofs, [proof]) as ReturnType<typeof proofs.get>
  if (!actual || actual.role !== "committed" || actual.store !== store || actual.target !== target) fail()
  actual.assertCurrent()
  return actual.snapshot
}

/** The original raw-row callback authenticates this path; it never performs a nested getTuple. */
export function captureMissingConversationCheckpointMembership(store: FunctionConversationStore,
  saver: SqlJsSaver, receipt: SqlJsSaverFunctionConversationRecoveryReceipt,
  binding: { readonly target: FunctionConversationRef; readonly checkpointThreadId: string;
    readonly checkpointIncarnation: ThreadIncarnation; readonly signal: AbortSignal; assertCurrent(): void }
): FunctionConversationCheckpointMembershipProof {
  const target = binding.target, incarnation = Object.freeze({ ...binding.checkpointIncarnation })
  const read = () => SqlJsSaver.prototype.readFunctionConversationRecoveryCheckpoint.call(saver, receipt)
  const guard = () => { read(); binding.signal.throwIfAborted(); binding.assertCurrent(); store.assertCurrent(target) }
  guard()
  const raw = read(), config = raw.config
  if (config.configurable?.thread_id !== binding.checkpointThreadId ||
    config.configurable?.checkpoint_ns !== target.checkpointNamespace ||
    config.configurable?.checkpoint_id !== raw.checkpoint.id) fail()
  const state = raw.checkpoint.channel_values.cmbFunctionConversation as Record<string, unknown>
  if (!state || state.logicalSessionId !== target.logicalSessionId || state.conversationId !== target.conversationId ||
    state.branchId !== target.branchId || typeof state.frontier !== "number") fail()
  const selection = { checkpointThreadId: binding.checkpointThreadId,
    checkpointIncarnation: incarnation, checkpointId: raw.checkpoint.id }
  const kept = store.readCheckpointRecoverySnapshot(target, selection, guard), expected = kept.snapshot
  const stateDigest = functionConversationMembershipDigest({ version: state.version,
    logicalSessionId: state.logicalSessionId, conversationId: state.conversationId,
    branchId: state.branchId, frontier: state.frontier })
  if (expected.checkpointId !== raw.checkpoint.id || expected.namespace !== target.checkpointNamespace ||
    expected.checkpointThreadId !== binding.checkpointThreadId || expected.checkpointTs !== raw.checkpoint.ts ||
    expected.parentCheckpointId !== raw.parentCheckpointId || expected.frontier !== state.frontier ||
    expected.stateDigest !== stateDigest ||
    !Number.isSafeInteger(expected.nativeMessageCount) || expected.nativeMessageCount < 0 ||
    expected.nativeMessageCount !== raw.expectedMessageCount || expected.members.length !== expected.nativeMessageCount ||
    kept.rows.length !== expected.members.length || expected.members.some((member, index) => member.ordinal !== index)) fail()
  const messages = kept.rows.map(row => {
    const message = deserializeFunctionConversationNativeMessage(row.nativePayload)
    message.additional_kwargs = { ...message.additional_kwargs,
      function_row: functionConversationCanonicalStamp(target, row) }
    return message
  })
  const tuple: CheckpointTuple = { config, checkpoint: { ...raw.checkpoint,
    channel_values: { ...raw.checkpoint.channel_values, messages } }, metadata: { source: "loop", step: 0, parents: {} },
    ...(raw.parentCheckpointId ? { parentConfig: { configurable: {
      thread_id: binding.checkpointThreadId, checkpoint_ns: target.checkpointNamespace,
      checkpoint_id: raw.parentCheckpointId } } } : {}) }
  const proof = captureTuple(store, tuple, { target, checkpointThreadId: binding.checkpointThreadId,
    checkpointIncarnation: incarnation, cut: expected.cut, frontier: expected.frontier,
    stateDigest: expected.stateDigest, assertCurrent: guard }, guard)
  if (readFunctionConversationCheckpointMembership(proof, store, target).snapshotDigest !== expected.snapshotDigest) fail()
  const verify = (returned: readonly BaseMessage[] = messages) => {
    guard()
    const current = store.readCheckpointRecoverySnapshot(target, selection, guard)
    if (current.snapshot.snapshotDigest !== expected.snapshotDigest || returned.length !== expected.nativeMessageCount) fail()
    const native: string[] = []
    for (let index = 0; index < returned.length; index += 1) {
      const message = returned[index], row = current.rows[index]
      const stamp = readFunctionConversationTranscriptStamp(message)
      if (!BaseMessage.isInstance(message) || hasInvalidFunctionConversationTranscriptStamp(message) ||
        !stamp || !sameFunctionConversationTranscriptStamp(stamp,
          functionConversationCanonicalStamp(target, row))) fail()
      const payload = serializeFunctionConversationNativeMessage(message)
      if (payload !== row.nativePayload) fail()
      native.push(payload)
    }
    if (functionConversationMembershipDigest(native) !== expected.nativeSnapshotDigest) fail()
    guard()
  }
  verify()
  SqlJsSaver.prototype.bindFunctionConversationRecoveryVerification.call(saver, receipt, verify)
  missingMessages.set(proof, { messages, verify })
  return proof
}

export function restoreMissingConversationCheckpointMessages(proof: FunctionConversationCheckpointMembershipProof):
  readonly BaseMessage[] {
  const actual = missingMessages.get(proof)
  if (!actual) fail()
  actual.verify()
  return actual.messages.slice()
}
