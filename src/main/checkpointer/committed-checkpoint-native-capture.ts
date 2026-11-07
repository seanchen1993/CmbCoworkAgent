import * as crypto from "node:crypto"
import { types } from "node:util"
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from
  "@langchain/core/messages"
import type { CheckpointTuple } from "@langchain/langgraph-checkpoint"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import * as nativeCapture from "../agent/native-message-capture-data"
import * as nativeCodec from "../agent/function-conversation-native-message"
import { isFunctionConversationNativeCheckpointStore,
  type FunctionConversationRef, type FunctionConversationStore } from
  "../db/function-conversation-store"
import * as storeModule from "../db/function-conversation-store"
import * as canonical from "./function-conversation-canonical-display-worker"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import { isFunctionConversationNativeMainRuntime } from "../mods/native-conversation-policy-source"
import * as runtimeIdentity from "../mods/native-conversation-policy-source"
import type { FunctionConversationDeliveryBinding } from "./function-conversation-delivery"
import type { FunctionConversationMembershipAdmission } from "./function-conversation-checkpoint-membership"
import { SqlJsSaver } from "./sqljs-saver"

const own = Object.getOwnPropertyDescriptor, keys = Reflect.ownKeys
const prototype = Object.getPrototypeOf, define = Object.defineProperty, create = Object.create
const same = Object.is, apply = Reflect.apply, isProxy = types.isProxy
const dateTime = Date.prototype.getTime
type Field = readonly [PropertyKey, PropertyDescriptor]
type Shape = { object: object; prototype: object | null; fields: readonly Field[]; time?: number }

function fields(object: object): Field[] {
  return keys(object).map(key => [key, own(object, key)!])
}
function shape(object: object): Shape {
  const parent = prototype(object)
  return { object, prototype: parent, fields: fields(object),
    ...(parent === Date.prototype ? { time: apply(dateTime, object, []) as number } : {}) }
}
function sameDescriptor(a: PropertyDescriptor | undefined, b: PropertyDescriptor): boolean {
  return !!a && a.enumerable === b.enumerable && a.configurable === b.configurable &&
    (("value" in a) === ("value" in b)) && ("value" in b
      ? same(a.value, b.value) && a.writable === b.writable : a.get === b.get && a.set === b.set)
}
function current(record: Shape): boolean {
  if (isProxy(record.object) || prototype(record.object) !== record.prototype) return false
  const names = keys(record.object)
  if (names.length !== record.fields.length) return false
  for (let index = 0; index < names.length; index++) {
    const [key, descriptor] = record.fields[index]
    if (names[index] !== key || !sameDescriptor(own(record.object, key), descriptor)) return false
  }
  return record.time === undefined || apply(dateTime, record.object, []) === record.time
}

// The pure data capture alone does not prove that SDK serialization is still native. Include
// its complete inherited dispatch, as well as the intrinsics used by capture and serialization.
const constructors = { Object, Array, Function, Reflect, JSON, Number, String, Boolean, Symbol,
  Map, Set, WeakMap, WeakSet, Date, Uint8Array, ArrayBuffer, Buffer, AbortSignal }
const globalFields = keys(constructors).map(name => [name, own(globalThis, name)!] as const)
const dispatch: Shape[] = []
const registered = new Set<object>()
function register(object: object | null): void {
  while (object && !registered.has(object)) {
    registered.add(object)
    dispatch.push(shape(object))
    const instancePrototype = own(object, "prototype")?.value as unknown
    if (instancePrototype && typeof instancePrototype === "object") register(instancePrototype)
    object = prototype(object)
  }
}
for (const value of Object.values(constructors)) register(value)
for (const value of [BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage,
  SqlJsSaver, crypto.Hash, types]) register(value)
const originalDigest = canonical.canonicalCheckpointValueDigest
const originalStoreQualification = isFunctionConversationNativeCheckpointStore
const originalRuntimeQualification = isFunctionConversationNativeMainRuntime
const moduleFields = [
  [crypto, "createHash"], [canonical, "canonicalCheckpointValueDigest"],
  [nativeCapture, "captureNativeMessageForOccurrence"],
  [nativeCodec, "serializeFunctionConversationNativeMessage"],
  [storeModule, "isFunctionConversationNativeCheckpointStore"],
  [runtimeIdentity, "isFunctionConversationNativeMainRuntime"]
] as const
const moduleDescriptors = moduleFields.map(([module, name]) => own(module, name)!)

function dispatchCurrent(): boolean {
  for (const [name, descriptor] of globalFields)
    if (!sameDescriptor(own(globalThis, name), descriptor)) return false
  for (let index = 0; index < moduleFields.length; index++) {
    const [module, name] = moduleFields[index]
    if (!sameDescriptor(own(module, name), moduleDescriptors[index])) return false
  }
  for (let index = 0; index < dispatch.length; index++) if (!current(dispatch[index])) return false
  return true
}

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_CHECKPOINT_CHANGED") }

/** No constructors, getters, serializers or user callbacks are used to copy an eligible graph. */
function copyGraph<T extends object>(original: T): {
  value: T; originals: Shape[]; copies: Shape[]
} {
  const originals: Shape[] = [], copies: Shape[] = [], seen = new Map<object, object>()
  const pending: Array<{ source: object; destination: object }> = []
  const copy = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value
    const prior = seen.get(value)
    if (prior) return prior
    const parent = prototype(value)
    const result: object = parent === Date.prototype ? new Date(apply(dateTime, value, [])) :
      Array.isArray(value) ? [] : create(parent)
    seen.set(value, result)
    pending.push({ source: value, destination: result })
    return result
  }
  const value = copy(original) as T
  for (let index = 0; index < pending.length; index++) {
    const { source, destination } = pending[index], record = shape(source)
    originals.push(record)
    for (const [key, descriptor] of record.fields) {
      if (!("value" in descriptor)) fail()
      define(destination, key, { ...descriptor, value: copy(descriptor.value) })
    }
    copies.push(shape(destination))
  }
  return { value, originals, copies }
}

const admissions = new WeakMap<FunctionConversationMembershipAdmission, {
  runtime: FunctionNativeConversationRuntime; binding: FunctionConversationDeliveryBinding
  bindingShape: Shape; admissionShape: Shape
}>()

/** Creates the known guard itself; arbitrary caller-created admissions cannot acquire provenance. */
export function createNativeCommittedMembershipAdmission(runtime: FunctionNativeConversationRuntime,
  binding: FunctionConversationDeliveryBinding,
  data: Omit<FunctionConversationMembershipAdmission, "assertCurrent">
): FunctionConversationMembershipAdmission | undefined {
  if (!dispatchCurrent() || !originalRuntimeQualification(runtime) ||
    runtime.binding !== binding || types.isProxy(binding) ||
    Object.getPrototypeOf(binding) !== Object.prototype) return
  const original = shape(binding)
  for (const [, field] of original.fields) if (!("value" in field)) return
  if (binding.target !== data.target ||
    binding.checkpointThreadId !== data.checkpointThreadId ||
    typeof binding.assertCurrent !== "function" || isProxy(binding.signal) ||
    prototype(binding.signal) !== AbortSignal.prototype || own(binding.signal, "throwIfAborted")) return
  const assertBinding = binding.assertCurrent, signal = binding.signal
  const admission = Object.freeze({ ...data,
    assertCurrent: () => { signal.throwIfAborted(); apply(assertBinding, binding, []) } })
  admissions.set(admission, { runtime, binding, bindingShape: original, admissionShape: shape(admission) })
  return admission
}

/** Classification only: it never substitutes for the original admission guard or a live SQL read. */
export function isNativeCommittedMembershipAdmission(admission: FunctionConversationMembershipAdmission,
  store: FunctionConversationStore): boolean {
  if (!dispatchCurrent()) return false
  const record = admissions.get(admission)
  if (!record || !originalRuntimeQualification(record.runtime) ||
    record.runtime.binding !== record.binding || !current(record.bindingShape) ||
    !current(record.admissionShape) || record.binding.target !== admission.target ||
    own(store, "database")?.value !== record.runtime.database ||
    prototype(record.binding.signal) !== AbortSignal.prototype ||
    own(record.binding.signal, "throwIfAborted")) return false
  return true
}

export interface NativeCommittedCheckpointCapture {
  readonly tuple: CheckpointTuple
  assertCurrent(): void
}

/** Eligibility is not authority. The caller still checks the live receipt, admission and Store. */
export function prepareNativeCommittedCheckpointCapture(store: FunctionConversationStore,
  target: FunctionConversationRef, tuple: CheckpointTuple, facts: object = {}
): NativeCommittedCheckpointCapture | undefined {
  if (!dispatchCurrent() || !originalStoreQualification(store, target)) return
  try {
    // This existing traversal rejects executable structure and bounds expanded data. Its
    // normalized message copy is deliberately unused: committed messages need lossless fields.
    originalDigest({ tuple, facts })
  } catch (error) {
    // Only unsupported pure data falls back. Do not swallow arbitrary failures (including
    // throw undefined) or retry after a user callback has already executed.
    if (error instanceof ModFunctionError &&
      (error.code === "MODS_CONVERSATION_DISPLAY_SOURCE_INVALID" ||
        error.code.startsWith("MODS_NATIVE_CAPTURE_"))) return
    throw error
  }
  if (!dispatchCurrent() || !originalStoreQualification(store, target)) return
  const graph = copyGraph({ tuple, facts })
  const assertCurrent = () => {
    if (!dispatchCurrent() || !originalStoreQualification(store, target)) fail()
    // Compare references, key order, prototype and every descriptor flag, not only serialized
    // bytes. A same-value replacement or an enumerable flip must not evade the boundary check.
    for (const record of graph.originals) if (!current(record)) fail()
    for (const record of graph.copies) if (!current(record)) fail()
  }
  assertCurrent()
  return { tuple: graph.value.tuple, assertCurrent }
}
