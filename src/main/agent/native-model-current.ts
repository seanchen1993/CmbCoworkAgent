import { types } from "node:util"
import { AIMessage, AIMessageChunk, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import {
  readFunctionConversationNativePolicySource,
  readFunctionConversationNativeSharedPolicySource,
  type FunctionConversationNativePolicySource
} from "../mods/native-conversation-policy-source"
import {
  captureNativeMessageForOccurrence,
  captureCompletedNativeNodeRawData
} from "./native-message-capture"
import {
  readFunctionConversationNativeNodeSlot,
  readFunctionConversationNativeNodeSlotRuntime,
  assertFunctionConversationNativeNodeSlotStructure,
  type FunctionConversationNativeNodeSlot
} from "./function-conversation-native-node"
import {
  readFunctionConversationNativeToolReturn,
  type FunctionNativeToolReturn,
  type FunctionNativeToolReturnView
} from "./function-conversation-native-tools"

type Admission = ReturnType<FunctionNativeConversationRuntime["capturePolicy"]>
interface Capture {
  readonly slot: FunctionConversationNativeNodeSlot
  readonly runtime: FunctionNativeConversationRuntime
  readonly policy: Admission
  readonly uuid: string
  readonly originalDigest: string
  readonly signal: AbortSignal
  readonly expiresAtNs: bigint
  readonly hostLatch: object
}
interface Record {
  readonly kind: "model" | "shared-tool"
  readonly slot: FunctionConversationNativeNodeSlot
  readonly runtime: FunctionNativeConversationRuntime
  readonly policy: FunctionConversationNativePolicySource
  readonly sharedPolicy?: FunctionConversationNativePolicySource
  readonly uuid: string
  readonly digest: string
  readonly signal: AbortSignal
  readonly expiresAtNs: bigint
  message?: BaseMessage
  tool?: FunctionNativeToolReturnView
  chunk?: boolean
  latch?: { readonly value: object; readonly descriptor: Readonly<PropertyDescriptor> }
  current?: () => void
  preparing: boolean
  reading: boolean
  failed: boolean
}
export interface FunctionNativeModelCurrentSource {
  readonly sharedRuntime?: object
  assertTail(): void
}
const captured = new WeakMap<FunctionConversationNativeNodeSlot, Record>()
const currents = new WeakMap<() => void, Record>()
const modelThrowIfAborted = AbortSignal.prototype.throwIfAborted
const modelWeakGet = WeakMap.prototype.get

function capturedRecord(slot: FunctionConversationNativeNodeSlot): Record | undefined {
  return Reflect.apply(modelWeakGet, captured, [slot]) as Record | undefined
}
function currentRecord(current: () => void): Record | undefined {
  return Reflect.apply(modelWeakGet, currents, [current]) as Record | undefined
}

function fail(): never {
  throw new ModFunctionError("MODS_CONVERSATION_NATIVE_MODEL_CURRENT_INVALID")
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail()
  return descriptor.value
}
function bounded(record: Record): void {
  Reflect.apply(modelThrowIfAborted, record.signal, [])
  if (process.hrtime.bigint() >= record.expiresAtNs)
    throw new ModFunctionError("MODS_NATIVE_PROTECTION_TIMEOUT")
}
function identity(record: Record): void {
  if (record.failed || capturedRecord(record.slot) !== record || !record.current || !record.latch)
    fail()
  const latch = record.latch
  if (
    types.isProxy(latch.value) ||
    Object.getPrototypeOf(latch.value) !== Object.prototype ||
    Reflect.ownKeys(latch.value).length !== 1
  )
    fail()
  const current = Object.getOwnPropertyDescriptor(latch.value, "failed")
  if (
    !current ||
    !("value" in current) ||
    current.value !== false ||
    current.enumerable !== latch.descriptor.enumerable ||
    current.writable !== latch.descriptor.writable ||
    current.configurable !== latch.descriptor.configurable
  )
    fail()
  bounded(record)
}
/** Descriptor-only raw capture and private facts, with no source or policy callback. */
function assertRaw(record: Record): void {
  if (!record.message) fail()
  if (record.chunk) {
    const raw = captureCompletedNativeNodeRawData(record.slot, record.uuid, () => bounded(record))
    if (raw.originalDigest !== record.digest) fail()
  } else {
    const raw = captureNativeMessageForOccurrence(record.message, record.uuid, () => bounded(record))
    if (raw.snapshot.executionSuppressed || raw.originalDigest !== record.digest) fail()
  }
}
function tail(record: Record): void {
  identity(record)
  if (record.kind === "shared-tool") {
    const tool = record.tool
    if (!tool || tool.message !== record.message ||
      readFunctionConversationNativeNodeSlotRuntime(record.slot) !== record.runtime ||
      types.isProxy(tool.message) || Object.getPrototypeOf(tool.message) !== ToolMessage.prototype ||
      record.sharedPolicy !== record.policy) fail()
    tool.assertTail()
    record.policy.assertTail()
    assertRaw(record)
    assertFunctionConversationNativeNodeSlotStructure(record.slot)
    tool.assertTail()
    record.policy.assertTail()
    identity(record)
    return
  }
  if (
    readFunctionConversationNativeNodeSlotRuntime(record.slot) !== record.runtime ||
    !record.message ||
    types.isProxy(record.message) ||
    Object.getPrototypeOf(record.message) !==
      (record.chunk ? AIMessageChunk.prototype : AIMessage.prototype)
  )
    fail()
  record.policy.assertTail()
  assertRaw(record)
  assertFunctionConversationNativeNodeSlotStructure(record.slot)
  record.policy.assertTail()
  identity(record)
}
function full(record: Record): void {
  if (record.kind === "shared-tool") {
    tail(record)
    record.tool!.assertCurrent()
    tail(record)
    return
  }
  identity(record)
  assertFunctionConversationNativeNodeSlotStructure(record.slot)
  record.policy.assertTail()
  if (record.sharedPolicy !== record.policy) {
    assertFunctionConversationNativeNodeSlotStructure(record.slot)
    record.policy.assertTail()
  }
  assertRaw(record)
  record.policy.assertCurrent()
  tail(record)
}

/** Builds its own complete guard from actual Work and genuine Manager policy, never a callback. */
export function captureFunctionConversationNativeModelCurrent(
  input: Capture
): (() => void) | undefined {
  return captureCurrent(input, "model")
}

/** Only the original Shared ToolReturn can supply a complete tool current. */
export function captureFunctionConversationNativeSharedToolCurrent(
  input: Capture & { readonly toolReceipt: FunctionNativeToolReturn }
): () => void {
  const current = captureCurrent(input, "shared-tool")
  if (!current) fail()
  return current
}

function captureCurrent(input: Capture, kind: Record["kind"]): (() => void) | undefined {
  const slot = own(input, "slot") as FunctionConversationNativeNodeSlot
  const previous = capturedRecord(slot)
  if (previous) {
    previous.failed = true
    fail()
  }
  const runtime = own(input, "runtime") as FunctionNativeConversationRuntime
  const admission = own(input, "policy") as Admission
  const actualRuntime = readFunctionConversationNativeNodeSlotRuntime(slot)
  if (!actualRuntime) return undefined
  if (actualRuntime !== runtime) fail()
  const policy = readFunctionConversationNativePolicySource(admission, runtime)
  if (!policy) return undefined
  const sharedPolicy = readFunctionConversationNativeSharedPolicySource(admission, runtime) === policy
    ? policy : undefined
  if (kind === "shared-tool" && !sharedPolicy) fail()
  const uuid = own(input, "uuid"),
    digest = own(input, "originalDigest")
  const signal = own(input, "signal"),
    expiresAtNs = own(input, "expiresAtNs")
  if (
    typeof uuid !== "string" ||
    !uuid ||
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    !signal ||
    typeof signal !== "object" ||
    types.isProxy(signal) ||
    !(signal instanceof AbortSignal) ||
    typeof expiresAtNs !== "bigint" ||
    expiresAtNs <= 0n
  )
    fail()
  // This once record precedes readSlot, whose original full callback can reenter the factory.
  const record: Record = {
    kind,
    slot,
    runtime,
    policy,
    sharedPolicy,
    uuid,
    digest,
    signal,
    expiresAtNs,
    preparing: true,
    reading: false,
    failed: false
  }
  captured.set(slot, record)
  try {
    const value = own(input, "hostLatch")
    if (
      !value ||
      typeof value !== "object" ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== 1
    )
      fail()
    const descriptor = Object.getOwnPropertyDescriptor(value, "failed")
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      descriptor.value !== false
    )
      fail()
    record.latch = { value, descriptor: Object.freeze(descriptor) }
    const current = () => {
      if (record.preparing || record.reading || record.failed) {
        record.failed = true
        fail()
      }
      record.reading = true
      try {
        full(record)
      } catch (error) {
        record.failed = true
        throw error
      } finally {
        record.reading = false
      }
    }
    record.current = current
    const view = readFunctionConversationNativeNodeSlot(slot)
    if (types.isProxy(view.message)) fail()
    const prototype = Object.getPrototypeOf(view.message)
    if (kind === "shared-tool") {
      const receipt = own(input, "toolReceipt") as FunctionNativeToolReturn
      const tool = readFunctionConversationNativeToolReturn(receipt, slot, runtime)
      if (view.node !== "tools" || prototype !== ToolMessage.prototype ||
        tool.door !== "tool-result" || tool.receipt !== receipt || tool.message !== view.message ||
        tool.uuid !== uuid || tool.policy !== admission) fail()
      record.tool = tool
    } else {
      if (view.node !== "model_request") fail()
      if (prototype !== AIMessage.prototype && prototype !== AIMessageChunk.prototype) {
        if (record.failed) fail()
        captured.delete(slot)
        return undefined
      }
    }
    record.message = view.message
    record.chunk = prototype === AIMessageChunk.prototype
    full(record)
    record.preparing = false
    currents.set(current, record)
    return current
  } catch (error) {
    record.failed = true
    throw error
  }
}

/** Only this factory's exact current can cover the same original runtime's full guard. */
export function readFunctionConversationNativeModelCurrent(
  current: unknown,
  runtime: object
): FunctionNativeModelCurrentSource | undefined {
  return readCurrent(current, runtime, "model")
}

/** Shared tools keep a separate reader; a model or arbitrary callback is never a tool source. */
export function readFunctionConversationNativeSharedToolCurrent(
  current: unknown,
  runtime: object
): FunctionNativeModelCurrentSource | undefined {
  return readCurrent(current, runtime, "shared-tool")
}

function readCurrent(current: unknown, runtime: object,
  kind: Record["kind"]): FunctionNativeModelCurrentSource | undefined {
  if (typeof current !== "function" || types.isProxy(current)) return undefined
  const record = currentRecord(current as () => void)
  if (!record || record.runtime !== runtime || record.kind !== kind) return undefined
  const check = () => {
    if (
      record.preparing ||
      record.reading ||
      record.current !== current ||
      currentRecord(current as () => void) !== record
    )
      fail()
    identity(record)
  }
  try {
    check()
  } catch (error) {
    record.failed = true
    throw error
  }
  return Object.freeze({
    ...(record.sharedPolicy === record.policy ? { sharedRuntime: record.runtime } : {}),
    assertTail() {
      try {
        check()
        tail(record)
        check()
      } catch (error) {
        record.failed = true
        throw error
      }
    }
  })
}
