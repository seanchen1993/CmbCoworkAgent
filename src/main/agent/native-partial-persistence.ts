import { types } from "node:util"
import { readFunctionConversationNativeMainPolicySource } from "../mods/native-conversation-policy-source"
import { getDb, getThreadCore, withCanonicalThreadMessageReadScope } from "../db"
import { matchesThreadIncarnation } from "../services/thread-incarnation"
import { captureLocalThreadRunLease, getLocalThreadRunLease } from "./thread-run-lease"
import { readFunctionNativeModelPartial, type FunctionNativeModelPartial } from
  "./function-conversation-native-calls"
import { captureNativePartialMetadata } from "./native-message-capture-data"
import type { QueuedStreamTranscriptMessage } from "../ipc/stream-transcript-flush"

const get = WeakMap.prototype.get, set = WeakMap.prototype.set
type Origin = ReturnType<typeof readFunctionNativeModelPartial>
type Receipt = Readonly<{
  database: Origin["runtime"]["database"]
  incarnation: Origin["runtime"]["destination"]["incarnation"]
  uuid: string; providerSourceId: string; providerOccurrence: number
  threadId: string; runId: string; ownsLease: () => boolean; digest: string
}>
const wires = new WeakMap<object, Receipt>()
const queued = new WeakMap<object, Receipt>()
function fail(): never { throw Error("MODS_NATIVE_PARTIAL_PERSISTENCE_INVALID") }
function fingerprint(value: unknown): string {
  return captureNativePartialMetadata({ value }).digest
}
function queuedFingerprint(message: QueuedStreamTranscriptMessage): string {
  if (types.isProxy(message)) fail()
  const copy: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(message)) {
    if (typeof key !== "string") fail()
    const descriptor = Object.getOwnPropertyDescriptor(message, key)
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail()
    const value: unknown = descriptor.value
    copy[key] = value instanceof Date ? Reflect.apply(Date.prototype.getTime, value, []) : value
  }
  return fingerprint(copy)
}
function read(map: WeakMap<object, Receipt>, value: unknown): Receipt | undefined {
  return value && typeof value === "object" ? Reflect.apply(get, map, [value]) : undefined
}
function assertDestination(receipt: Receipt, threadId: string, runId: string): void {
  const lease = getLocalThreadRunLease(threadId)
  if (threadId !== receipt.threadId || runId !== receipt.runId ||
    (lease && (lease.runId !== runId || !receipt.ownsLease())) ||
    getDb() !== receipt.database ||
    !matchesThreadIncarnation(getThreadCore(threadId), receipt.incarnation)) fail()
}
function assertIdentity(receipt: Receipt, message: QueuedStreamTranscriptMessage): void {
  if (message.id !== receipt.uuid || message.role !== "assistant" ||
    message.provider_source_id !== receipt.providerSourceId ||
    message.provider_occurrence !== receipt.providerOccurrence) fail()
}

/** Called only while the real callback-owned partial is live and fully checked. */
export function registerNativePartialPersistence(token: FunctionNativeModelPartial,
  frame: readonly unknown[]): void {
  const source = readFunctionNativeModelPartial(token)
  // Only the physical Main stream enters the IPC transcript queue. Shared child streams
  // own a separate canonical projection, whose destination deliberately has no physical lease.
  if (source.sseSource ||
    !readFunctionConversationNativeMainPolicySource(source.policy, source.runtime)) return
  const threadId = source.runtime.destination.threadId
  const lease = getLocalThreadRunLease(threadId)
  const ownsLease = captureLocalThreadRunLease(threadId)
  if (!lease || !ownsLease) fail()
  const digest = fingerprint(frame)
  source.assertCurrent()
  if (fingerprint(frame) !== digest || !ownsLease()) fail()
  const receipt = Object.freeze({ database: source.runtime.database,
    incarnation: Object.freeze({ ...source.runtime.destination.incarnation }), uuid: source.uuid,
    providerSourceId: source.providerSourceId, providerOccurrence: source.providerOccurrence,
    threadId, runId: lease.runId, ownsLease, digest })
  assertDestination(receipt, threadId, lease.runId)
  Reflect.apply(set, wires, [frame, receipt])
}

/** Host serializer transfer; this is an immutable display receipt, never a new live call. */
export function serializeWithNativePartialReceipt<T extends { data: unknown }>(data: unknown,
  serialize: () => T): T {
  const receipt = read(wires, data)
  if (!receipt) return serialize()
  if (fingerprint(data) !== receipt.digest) fail()
  const result = serialize()
  if (fingerprint(data) !== receipt.digest || !result.data || typeof result.data !== "object") fail()
  const digest = fingerprint(result.data)
  Reflect.apply(set, wires, [result.data, Object.freeze({ ...receipt, digest })])
  return result
}

export function bindNativePartialQueuedMessage(payload: unknown, message: QueuedStreamTranscriptMessage,
  threadId: string, runId: string): void {
  const receipt = read(wires, payload)
  if (!receipt) return
  if (fingerprint(payload) !== receipt.digest) fail()
  assertDestination(receipt, threadId, runId)
  assertIdentity(receipt, message)
  Reflect.apply(set, queued, [message, Object.freeze({ ...receipt, digest: queuedFingerprint(message) })])
}

/** Retire only this exact authenticated partial after its full canonical seal is verified. */
export function reconcileNativePartialQueuedMessage(message: QueuedStreamTranscriptMessage,
  threadId: string, runId: string): QueuedStreamTranscriptMessage | undefined {
  return reconcileNativePartialQueuedMessages([message], threadId, runId)[0]
}

/** One synchronous read scope for the batch; final fresh-B still checks every read. */
export function reconcileNativePartialQueuedMessages(messages: readonly QueuedStreamTranscriptMessage[],
  threadId: string, runId: string): QueuedStreamTranscriptMessage[] {
  if (!messages.some(message => read(queued, message))) return [...messages]
  return withCanonicalThreadMessageReadScope(threadId, reader => {
    return messages.filter(message => {
      const receipt = read(queued, message)
      if (!receipt) return true
      if (queuedFingerprint(message) !== receipt.digest) fail()
      assertDestination(receipt, threadId, runId)
      assertIdentity(receipt, message)
      const snapshot = reader.readSnapshot(receipt.uuid)
      if (!snapshot) return true
      if (snapshot.id !== receipt.uuid || snapshot.role !== "assistant" ||
        snapshot.provider_source_id !== receipt.providerSourceId ||
        snapshot.provider_occurrence !== receipt.providerOccurrence) fail()
      return false
    })
  })
}
