import { AIMessageChunk } from "@langchain/core/messages"
import { types } from "node:util"
import { registerNativePartialPersistence } from "./native-partial-persistence"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY, MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY }
  from "../../shared/message-role-collision"
import { snapshotFunctionNativeDeployment, readFunctionConversationNativeMainPolicySource }
  from "../mods/native-conversation-policy-source"
import { readFunctionNativeModelPartial, selectFunctionNativeCompletedPartial,
  type FunctionNativeModelPartial, type FunctionNativeCompletedPartialCandidate }
  from "./function-conversation-native-calls"
import { captureNativePartialMetadata, capturePartialNativeModelData }
  from "./native-message-capture"
import { currentFunctionConversationNativeSseSource } from
  "./function-conversation-native-lifetime"
import { readFunctionConversationNativeNodeWorkModelName,
  type FunctionConversationNativeNodeModelName } from "./function-conversation-native-node"

const serialize = AIMessageChunk.prototype.toJSON
const stringify = JSON.stringify
const apply = Reflect.apply
const throwIfAborted = AbortSignal.prototype.throwIfAborted
const weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set
function writeWeak<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
  Reflect.apply(weakSet, map, [key, value])
}
export interface FunctionConversationNativePartialSseData {
  readonly data: Readonly<Record<string, unknown>>
  readonly originalMessage: object
  readonly originalMetadata: object
  /** Pure original data/policy/attempt/source tail, without a physical source callback. */
  assertDataCurrent(): void
}
const sseWires = new WeakMap<object, { readonly metadata: object;
  read(): FunctionConversationNativePartialSseData
  completed(candidate: FunctionNativeCompletedPartialCandidate,
    name?: FunctionConversationNativeNodeModelName): Readonly<{ assertDataCurrent(): void }>
}>()

function fail(): never { throw new ModFunctionError("MODS_NATIVE_CAPTURE_PARTIAL_INVALID") }
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail()
  return descriptor.value
}

function optionalName(value: object): unknown {
  if (types.isProxy(value)) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, "name")
  if (!descriptor) return undefined
  if (!("value" in descriptor)) fail()
  return descriptor.value
}

/** A callback-owned partial display, never a completed output or a persistence receipt. */
export function projectFunctionConversationNativePartial(token: FunctionNativeModelPartial,
  metadata: unknown): readonly [Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>] {
  const source = readFunctionNativeModelPartial(token)
  const policy = own(source.policy, "value")
  const identity = own(policy, "identity"), epoch = own(policy, "epoch")
  const digest = own(policy, "digest"), protectedValue = own(policy, "protected")
  if (!identity || typeof identity !== "object" || types.isProxy(identity) ||
    typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0 ||
    typeof digest !== "string" || protectedValue !== false) fail()
  const deployment = stringify(snapshotFunctionNativeDeployment(own(policy, "deployment")))
  const deadline = performance.now() + 30_000
  const bounded = () => {
    apply(throwIfAborted, source.signal, [])
    if (performance.now() >= deadline) fail()
  }
  const captured = capturePartialNativeModelData(token, bounded)
  const copiedMetadata = captureNativePartialMetadata(metadata, bounded)
  if (copiedMetadata.data.langgraph_checkpoint_ns !== source.namespace) fail()
  const additional = captured.snapshot.data.additional_kwargs
  if (!additional || typeof additional !== "object" || Array.isArray(additional) ||
    Object.hasOwn(additional, "function_row") ||
    Object.hasOwn(additional, "function_row_invalid")) fail()
  const data = captured.snapshot.data
  if (Object.hasOwn(data, "contentBlocks")) {
    const response = data.response_metadata
    if (!response || typeof response !== "object" ||
      Object.getOwnPropertyDescriptor(response, "output_version")?.value !== "v1" ||
      !Array.isArray(data.content) || stringify(data.contentBlocks) !== stringify(data.content)) fail()
  }
  // Only the safe empty-seed class invokes this known native serializer. No original raw
  // constructor, contentBlocks getter, toDict, toJSON or provider translator is called.
  const serialized = apply(serialize, captured.message, []) as unknown
  const kwargs = own(serialized, "kwargs")
  if (!kwargs || typeof kwargs !== "object" || types.isProxy(kwargs) || Array.isArray(kwargs)) fail()
  Object.defineProperty(kwargs, "additional_kwargs", {
    value: { ...(own(kwargs, "additional_kwargs") as Record<string, unknown>),
      [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: source.providerSourceId,
      [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: source.providerOccurrence },
    enumerable: true, writable: true, configurable: true
  })
  const wire = captureNativePartialMetadata(serialized, bounded)
  const mainPolicy = source.modelName && !source.sseSource &&
    !currentFunctionConversationNativeSseSource()
    ? readFunctionConversationNativeMainPolicySource(source.policy, source.runtime) : undefined
  const actor = mainPolicy && source.modelName
    ? readFunctionConversationNativeNodeWorkModelName(
      source.modelName, source.runtime, source.configurable) : undefined
  const assertActorData = () => {
    if (!actor) return
    if (source.sseSource || currentFunctionConversationNativeSseSource() ||
      readFunctionConversationNativeMainPolicySource(source.policy, source.runtime) !== mainPolicy)
      fail()
    actor.assertDataCurrent()
    const kwargs = own(source.message, "lc_kwargs")
    if (!kwargs || typeof kwargs !== "object" || types.isProxy(kwargs)) fail()
    const rootName = optionalName(source.message), kwargsName = optionalName(kwargs)
    if ((rootName !== undefined && rootName !== actor.name) ||
      (kwargsName !== undefined && kwargsName !== actor.name)) fail()
  }
  if (actor) {
    assertActorData()
    const wireKwargs = own(wire.data, "kwargs")
    if (!wireKwargs || typeof wireKwargs !== "object" || types.isProxy(wireKwargs)) fail()
    const existing = optionalName(wireKwargs)
    if (existing !== undefined && existing !== actor.name) fail()
    Object.defineProperty(wireKwargs, "name", {
      value: actor.name, enumerable: true, writable: true, configurable: true
    })
  }
  const wireCopyDigest = captureNativePartialMetadata(wire.data, bounded).digest
  const metadataCopyDigest = captureNativePartialMetadata(copiedMetadata.data, bounded).digest
  const assertDataTail = () => {
    // Everything below is pure typed/data/owner validation. The last original callback cannot
    // mutate the raw chunk, metadata, safe class or generated wire and still return this frame.
    captured.assertDataCurrent()
    if (captureNativePartialMetadata(metadata, bounded).digest !== copiedMetadata.digest ||
      captureNativePartialMetadata(serialized, bounded).digest !== wire.digest ||
      captureNativePartialMetadata(wire.data, bounded).digest !== wireCopyDigest ||
      captureNativePartialMetadata(copiedMetadata.data, bounded).digest !== metadataCopyDigest ||
      own(source.policy, "value") !== policy || own(policy, "identity") !== identity ||
      own(policy, "epoch") !== epoch || own(policy, "digest") !== digest ||
      own(policy, "protected") !== protectedValue ||
      stringify(snapshotFunctionNativeDeployment(own(policy, "deployment"))) !== deployment) fail()
    source.assertTail()
    assertActorData()
    bounded()
  }
  source.assertCurrent()
  assertDataTail()
  const frame: readonly [Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>] =
    [wire.data, copiedMetadata.data]
  const sseSource = currentFunctionConversationNativeSseSource()
  if (sseSource && source.sseSource !== sseSource) fail()
  if (sseSource) writeWeak(sseWires, wire.data, { metadata: copiedMetadata.data, completed(candidate, name) {
    const completed = selectFunctionNativeCompletedPartial(candidate)
    if (completed.source !== sseSource || completed.chunk !== source.message ||
      completed.policy !== source.policy || completed.uuid !== source.uuid) fail()
    const assertDataCurrent = () => {
      if (currentFunctionConversationNativeSseSource() !== sseSource) fail()
      captured.assertCompletedDataCurrent(candidate, name)
      if (captureNativePartialMetadata(metadata, bounded).digest !== copiedMetadata.digest ||
        captureNativePartialMetadata(serialized, bounded).digest !== wire.digest ||
        captureNativePartialMetadata(wire.data, bounded).digest !== wireCopyDigest ||
        captureNativePartialMetadata(copiedMetadata.data, bounded).digest !== metadataCopyDigest ||
        own(source.policy, "value") !== policy || own(policy, "identity") !== identity ||
        own(policy, "epoch") !== epoch || own(policy, "digest") !== digest ||
        own(policy, "protected") !== protectedValue ||
        stringify(snapshotFunctionNativeDeployment(own(policy, "deployment"))) !== deployment) fail()
      completed.assertDataCurrent()
      bounded()
    }
    assertDataCurrent()
    return Object.freeze({ assertDataCurrent })
  }, read() {
    if (currentFunctionConversationNativeSseSource() !== sseSource) fail()
    source.assertCurrent()
    assertDataTail()
    const flat = captureNativePartialMetadata({ ...own(wire.data, "kwargs") as object,
      type: "ai" }, bounded)
    const flatDigest = captureNativePartialMetadata(flat.data, bounded).digest
    // The last physical/policy callback precedes every pure raw/safe/wire/metadata/DTO check.
    source.assertCurrent()
    assertDataTail()
    const assertDataCurrent = () => {
      assertDataTail()
      if (currentFunctionConversationNativeSseSource() !== sseSource ||
        captureNativePartialMetadata(flat.data, bounded).digest !== flatDigest) fail()
    }
    assertDataCurrent()
    return Object.freeze({ data: flat.data, originalMessage: source.message,
      originalMetadata: metadata as object, assertDataCurrent })
  } })
  if (!sseSource) {
    registerNativePartialPersistence(token, frame)
    // Registration checks the original source callback; keep its raw/data tail last.
    assertDataTail()
  }
  return Object.freeze(frame)
}

/** Same-source typed DTO only. Public lc/kwargs, cloning and another invocation cannot mint it. */
export function readFunctionConversationNativePartialSse(wire: unknown, metadata: unknown):
  FunctionConversationNativePartialSseData | undefined {
  if (!wire || typeof wire !== "object") return undefined
  const record = Reflect.apply(weakGet, sseWires, [wire]) as
    ReturnType<typeof sseWires.get>
  if (!record) return undefined
  if (record.metadata !== metadata) fail()
  return record.read()
}

/** An omission-only pure check cannot turn a sealed callback into a live display. */
export function readFunctionConversationNativePartialCompletion(wire: unknown, metadata: unknown,
  candidate: FunctionNativeCompletedPartialCandidate,
  name?: FunctionConversationNativeNodeModelName): Readonly<{ assertDataCurrent(): void }> {
  if (!wire || typeof wire !== "object") fail()
  const record = Reflect.apply(weakGet, sseWires, [wire]) as
    ReturnType<typeof sseWires.get>
  if (!record || record.metadata !== metadata) fail()
  return record.completed(candidate, name)
}
