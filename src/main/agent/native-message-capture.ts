import { types } from "node:util"
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages"
import {
  readFunctionConversationNativeNodeSlot,
  readFunctionConversationNativeNodeSlotData,
  readFunctionConversationNativeNodeModelName,
  type FunctionConversationNativeNodeModelName, type FunctionConversationNativeNodeSlot
} from "./function-conversation-native-node"
import { readFunctionNativeModelPartial, readFunctionNativeCompletedPartial,
  selectFunctionNativeCompletedPartial, readFunctionNativeCompletedModelReturn,
  type FunctionNativeModelAttempt, type FunctionNativeModelPartial,
  type FunctionNativeCompletedPartialCandidate }
  from "./function-conversation-native-calls"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import type { FunctionConversationNativeSseSource } from "./function-conversation-native-lifetime"
import { captureMessage, fail, nonProxy, own,
  type CapturedNativeMessage, type OriginalModelName } from "./native-message-capture-data"

export { captureNativeMessage, captureNativeMessageForOccurrence, captureNativePartialMetadata,
  constructCapturedNativeMessage, NATIVE_CAPTURE_MAX_EXPANDED_NODES } from
  "./native-message-capture-data"
export type { CapturedNativeType, CapturedNativeMessage } from "./native-message-capture-data"

/** Only the original node's private completed output address can enable the chunk copy path. */
export function captureCompletedNativeNodeData(slot: FunctionConversationNativeNodeSlot,
  stableUuid: string, assertBoundedWork?: () => void): Readonly<{
    snapshot: CapturedNativeMessage
    originalId?: string
    originalDigest: string
  }> {
  if (typeof stableUuid !== "string" || !stableUuid) fail()
  const view = readFunctionConversationNativeNodeSlot(slot)
  if (view.node !== "model_request") fail("MODS_NATIVE_CAPTURE_COMPLETED_INVALID")
  const guardSource = () => {
    assertBoundedWork?.()
    const current = readFunctionConversationNativeNodeSlot(slot)
    if (current !== view || current.message !== view.message)
      fail("MODS_NATIVE_CAPTURE_COMPLETED_INVALID")
  }
  guardSource()
  // This traversal is synchronous, descriptor-only and never calls provider code. The actual
  // slot is checked on both sides; per-field work checks only the caller's original cut/signal.
  const captured = captureMessage(view.message, assertBoundedWork, stableUuid, "completed")
  guardSource()
  return captured
}

/** Only a genuine completed model Slot grants this digest-only internal chunk traversal. */
export function captureCompletedNativeNodeRawData(slot: FunctionConversationNativeNodeSlot,
  stableUuid: string, assertBoundedWork?: () => void): Readonly<{ originalDigest: string }> {
  if (typeof stableUuid !== "string" || !stableUuid) fail()
  const view = readFunctionConversationNativeNodeSlotData(slot)
  if (view.node !== "model_request" || types.isProxy(view.message) ||
    Object.getPrototypeOf(view.message) !== AIMessageChunk.prototype)
    fail("MODS_NATIVE_CAPTURE_COMPLETED_INVALID")
  assertBoundedWork?.()
  const captured = captureMessage(view.message, assertBoundedWork, stableUuid, "completed")
  if (captured.snapshot.executionSuppressed ||
    readFunctionConversationNativeNodeSlotData(slot) !== view)
    fail("MODS_NATIVE_CAPTURE_COMPLETED_INVALID")
  assertBoundedWork?.()
  return Object.freeze({ originalDigest: captured.originalDigest })
}

/** Internal partial path: its source token never enables the ordinary or completed entry point. */
export function capturePartialNativeModelData(token: FunctionNativeModelPartial,
  assertBoundedWork?: () => void): Readonly<{
    message: AIMessageChunk
    snapshot: CapturedNativeMessage
    originalDigest: string
    assertDataCurrent(): void
    assertCompletedDataCurrent(candidate: FunctionNativeCompletedPartialCandidate,
      name?: FunctionConversationNativeNodeModelName): void
  }> {
  const source = readFunctionNativeModelPartial(token)
  const raw = source.message as BaseMessage
  const original = captureMessage(raw, assertBoundedWork, source.uuid, "partial")
  if (original.snapshot.executionSuppressed) fail("MODS_NATIVE_CAPTURE_PARTIAL_INVALID")
  const originalName = captureModelNameBaseline(raw)
  const data = original.snapshot.data
  const message = new AIMessageChunk({ content: "", tool_call_chunks: [] })
  // The known empty constructor does not parse or concatenate any uncompleted provider args.
  const fields = ["id", "content", "additional_kwargs", "response_metadata", "name",
    "tool_calls", "invalid_tool_calls", "tool_call_chunks", "usage_metadata"]
  for (let index = 0; index < fields.length; index++)
    Object.defineProperty(message, fields[index], { value: data[fields[index]], enumerable: true,
      writable: true, configurable: true })
  Object.defineProperty(message, "lc_kwargs", { value: { ...data }, enumerable: true,
    writable: true, configurable: true })
  const normalized = captureMessage(message, assertBoundedWork, source.uuid, "partial")
  if (normalized.snapshot.digest !== original.snapshot.digest ||
    normalized.snapshot.executionSuppressed) fail("MODS_NATIVE_CAPTURE_PARTIAL_INVALID")
  source.assertCurrent()
  const assertDataCurrent = () => {
    if (captureMessage(raw, assertBoundedWork, source.uuid, "partial").originalDigest !==
      original.originalDigest ||
      captureMessage(message, assertBoundedWork, source.uuid, "partial").snapshot.digest !==
      original.snapshot.digest) fail("MODS_NATIVE_CAPTURE_PARTIAL_INVALID")
    source.assertTail()
  }
  assertDataCurrent()
  const assertCompletedDataCurrent = (candidate: FunctionNativeCompletedPartialCandidate,
    name?: FunctionConversationNativeNodeModelName) => {
    const completed = selectFunctionNativeCompletedPartial(candidate)
    if (completed.chunk !== raw || completed.uuid !== source.uuid ||
      completed.policy !== source.policy || completed.source !== source.sseSource) fail()
    const restored = name ? originalName.restore(candidate, name) : undefined
    if (captureMessage(raw, assertBoundedWork, source.uuid, "partial", restored).originalDigest !==
      original.originalDigest ||
      captureMessage(message, assertBoundedWork, source.uuid, "partial").snapshot.digest !==
      original.snapshot.digest) fail("MODS_NATIVE_CAPTURE_PARTIAL_INVALID")
    completed.assertDataCurrent()
  }
  return Object.freeze({ message, snapshot: normalized.snapshot,
    originalDigest: original.originalDigest, assertDataCurrent, assertCompletedDataCurrent })
}
/** A name transition keeps every original container fact and restores only two known fields. */
function captureModelNameBaseline(raw: BaseMessage): {
  restore(candidate: FunctionNativeCompletedPartialCandidate,
    proof: FunctionConversationNativeNodeModelName): OriginalModelName
} {
  const fields = own(raw, "lc_kwargs")
  if (!fields || typeof fields !== "object") fail()
  nonProxy(fields)
  const capture = (value: object) => ({ value, prototype: Object.getPrototypeOf(value),
    keys: Reflect.ownKeys(value), descriptors: Object.getOwnPropertyDescriptors(value) })
  const root = capture(raw), kwargs = capture(fields)
  const firstName = Object.getOwnPropertyDescriptor(raw, "name")
  const hadKwargsName = Object.hasOwn(fields, "name")
  const check = (baseline: ReturnType<typeof capture>, expectedName: string) => {
    nonProxy(baseline.value)
    if (Object.getPrototypeOf(baseline.value) !== baseline.prototype) fail()
    const old = Object.getOwnPropertyDescriptor(baseline.descriptors, "name")?.value as
      PropertyDescriptor | undefined
    let expectedKeys = baseline.keys
    if (!old) {
      expectedKeys = []
      for (let index = 0; index < baseline.keys.length; index++) {
        const key = baseline.keys[index]
        if (typeof key === "string") expectedKeys[expectedKeys.length] = key
      }
      expectedKeys[expectedKeys.length] = "name"
      for (let index = 0; index < baseline.keys.length; index++) {
        const key = baseline.keys[index]
        if (typeof key === "symbol") expectedKeys[expectedKeys.length] = key
      }
    }
    const keys = Reflect.ownKeys(baseline.value)
    if (keys.length !== expectedKeys.length) fail()
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (key !== expectedKeys[index]) fail()
      const current = Object.getOwnPropertyDescriptor(baseline.value, key)
      if (!current || !("value" in current)) fail()
      const original = Object.getOwnPropertyDescriptor(baseline.descriptors, key)?.value as
        PropertyDescriptor | undefined
      if (key === "name") {
        if (current.value !== expectedName || (original
          ? current.enumerable !== original.enumerable || current.writable !== original.writable ||
            current.configurable !== original.configurable
          : !current.enumerable || !current.writable || !current.configurable)) fail()
      } else if (!original || current.value !== original.value ||
        current.enumerable !== original.enumerable || current.writable !== original.writable ||
        current.configurable !== original.configurable) fail()
    }
  }
  return { restore(candidate, proof) {
    const completed = selectFunctionNativeCompletedPartial(candidate)
    const name = readFunctionConversationNativeNodeModelName(proof)
    if (completed.chunk !== raw || completed.returnedMessage !== raw || name.message !== raw ||
      name.runtime !== completed.runtime || own(raw, "lc_kwargs") !== fields) fail()
    const config = name.config.configurable, actual = completed.configurable
    if (!config) fail()
    const configKeys = ["__pregel_task_id", "__pregel_read", "checkpoint_ns", "thread_id"]
    for (let index = 0; index < configKeys.length; index++) {
      const key = configKeys[index]
      if (own(config, key) !== own(actual, key)) fail()
    }
    check(root, name.name); check(kwargs, name.name)
    name.assertDataCurrent(); completed.assertDataCurrent()
    return { name: firstName?.value, hadKwargsName }
  } }
}

/** Digest only. Completion of this actual callback cannot mint a partial or full display. */
export function captureNativeCompletedPartialData(candidate: FunctionNativeCompletedPartialCandidate,
  assertBoundedWork?: () => void): Readonly<{ originalDigest: string; assertDataCurrent(): void }> {
  const source = readFunctionNativeCompletedPartial(candidate)
  const raw = source.chunk as BaseMessage
  const first = captureMessage(raw, assertBoundedWork, source.uuid, "partial")
  if (first.snapshot.executionSuppressed) fail("MODS_NATIVE_CAPTURE_PARTIAL_INVALID")
  const originalDigest = first.originalDigest
  source.assertCurrent()
  const assertDataCurrent = () => {
    source.assertDataCurrent()
    if (captureMessage(raw, assertBoundedWork, source.uuid, "partial").originalDigest !==
      originalDigest) fail("MODS_NATIVE_CAPTURE_PARTIAL_INVALID")
    source.assertDataCurrent()
  }
  assertDataCurrent()
  return Object.freeze({ originalDigest, assertDataCurrent })
}

/** The genuine completed provider return only supplies its complete raw data digest. */
export function captureNativeCompletedModelReturnData(attempt: FunctionNativeModelAttempt,
  runtime: FunctionNativeConversationRuntime, source?: FunctionConversationNativeSseSource,
  assertBoundedWork?: () => void): Readonly<{ originalDigest: string; assertDataCurrent(): void }> {
  const actual = readFunctionNativeCompletedModelReturn(attempt, runtime, source)
  const message = actual.message
  nonProxy(message)
  const prototype = Object.getPrototypeOf(message)
  if (prototype !== AIMessage.prototype && prototype !== AIMessageChunk.prototype) fail()
  const kind = prototype === AIMessageChunk.prototype ? "completed" : undefined
  const first = captureMessage(message, assertBoundedWork, actual.uuid, kind)
  if (first.snapshot.executionSuppressed) fail()
  const originalDigest = first.originalDigest
  actual.assertCurrent()
  let failed = false
  const assertDataCurrent = () => {
    try {
      if (failed) fail()
      actual.assertDataCurrent()
      if (captureMessage(message, assertBoundedWork, actual.uuid, kind).originalDigest !==
        originalDigest) fail()
      actual.assertDataCurrent()
    } catch (error) { failed = true; throw error }
  }
  assertDataCurrent()
  return Object.freeze({ originalDigest, assertDataCurrent })
}
