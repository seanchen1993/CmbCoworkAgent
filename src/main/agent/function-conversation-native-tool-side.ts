import { AIMessage, SystemMessage } from "@langchain/core/messages"
import { types } from "node:util"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import { readFunctionConversationNativePolicySource, snapshotFunctionNativeDeployment } from
  "../mods/native-conversation-policy-source"
import { captureNativeMessageForOccurrence } from "./native-message-capture"
import { readFunctionConversationNativeToolReturn, type FunctionNativeToolReturn } from
  "./function-conversation-native-tools"
import type { FunctionConversationNativeNodeSlot } from "./function-conversation-native-node"

const brand = Symbol("function-native-tool-side")
export interface FunctionNativeToolSideReceipt { readonly [brand]: true }
export interface FunctionNativeToolSideCapture {
  readonly receipt: FunctionNativeToolReturn
  readonly slot: FunctionConversationNativeNodeSlot
  readonly runtime: FunctionNativeConversationRuntime
}
export interface FunctionNativeToolSideSource {
  readonly receipt: FunctionNativeToolReturn
  readonly slot: FunctionConversationNativeNodeSlot
  readonly runtime: FunctionNativeConversationRuntime
  readonly occurrence: FunctionNativeToolReturn
  readonly message: AIMessage | SystemMessage
  readonly nativeType: "ai" | "system"
  readonly uuid: string
  readonly door: "tool-message"
  readonly origin: Readonly<{ kind: "tool"; tool: string }>
  readonly policy: ReturnType<FunctionNativeConversationRuntime["capturePolicy"]>
  readonly signal: AbortSignal
  readonly expiresAtNs: bigint
  assertCurrent(): void
  /** Full original data and private identity only; no source or policy callback. */
  assertDataCurrent(): void
}
const captured = new WeakMap<FunctionNativeToolReturn, { failed: boolean }>()
const sources = new WeakMap<FunctionNativeToolSideReceipt, FunctionNativeToolSideSource>()
interface HostLatch {
  readonly value: object
  readonly descriptor: Readonly<PropertyDescriptor>
}
interface CurrentSource {
  readonly token: FunctionNativeToolSideReceipt
  readonly source: FunctionNativeToolSideSource
  latch?: HostLatch
  current?: () => void
  preparing: boolean
  reading: boolean
  failed: boolean
}
const currents = new WeakMap<FunctionNativeToolSideReceipt, CurrentSource>()
const currentSources = new WeakMap<() => void, CurrentSource>()
export interface FunctionNativeToolSideCurrentSource {
  /** Full original source data only, after the certified current and other callbacks. */
  assertTail(): void
}
const stringify = JSON.stringify
function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_TOOL_SIDE_INVALID") }
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field || !field.enumerable || !("value" in field)) fail()
  return field.value
}
function policyFacts(policy: FunctionNativeToolSideSource["policy"]): string {
  const value = own(policy, "value"), epoch = own(value, "epoch"), digest = own(value, "digest")
  const protectedValue = own(value, "protected")
  if (!Number.isSafeInteger(epoch) || typeof epoch !== "number" || epoch < 0 ||
    typeof digest !== "string" || typeof protectedValue !== "boolean") fail()
  return stringify({ epoch, digest, protected: protectedValue,
    deployment: snapshotFunctionNativeDeployment(own(value, "deployment")) })
}
function hostLatch(value: unknown): HostLatch {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 1) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, "failed")
  if (!descriptor || !("value" in descriptor) || descriptor.value !== false ||
    !descriptor.enumerable) fail()
  return Object.freeze({ value, descriptor: Object.freeze(descriptor) })
}
function assertCurrentSource(record: CurrentSource): void {
  const latch = record.latch
  if (record.failed || currents.get(record.token) !== record ||
    sources.get(record.token) !== record.source || !record.current || !latch ||
    types.isProxy(latch.value) || Object.getPrototypeOf(latch.value) !== Object.prototype ||
    Reflect.ownKeys(latch.value).length !== 1) fail()
  const current = Object.getOwnPropertyDescriptor(latch.value, "failed")
  if (!current || !("value" in current) || current.value !== false ||
    current.enumerable !== latch.descriptor.enumerable ||
    current.writable !== latch.descriptor.writable ||
    current.configurable !== latch.descriptor.configurable) fail()
}

/** Only a completed original Tool Command can provide a provider-bearing AI/System side. */
export function captureFunctionConversationNativeToolSide(input: FunctionNativeToolSideCapture):
  FunctionNativeToolSideReceipt {
  const expiresAtNs = process.hrtime.bigint() + 30_000_000_000n
  const receipt = own(input, "receipt") as FunctionNativeToolReturn
  if (!receipt || typeof receipt !== "object" || types.isProxy(receipt)) fail()
  const previous = captured.get(receipt)
  if (previous) { previous.failed = true; fail() }
  const state = { failed: false, reading: false }
  captured.set(receipt, state)
  try {
    const slot = own(input, "slot") as FunctionConversationNativeNodeSlot
    const runtime = own(input, "runtime") as FunctionNativeConversationRuntime
    const view = readFunctionConversationNativeToolReturn(receipt, slot, runtime)
    if (view.door !== "tool-message" || types.isProxy(view.message)) fail()
    const prototype = Object.getPrototypeOf(view.message)
    if (prototype !== AIMessage.prototype && prototype !== SystemMessage.prototype) fail()
    const message = view.message as AIMessage | SystemMessage
    const nativeType = prototype === AIMessage.prototype ? "ai" : "system"
    const signal = AbortSignal.any([runtime.signal, runtime.target.signal,
      ...(view.signal ? [view.signal] : [])])
    const bounded = () => {
      signal.throwIfAborted()
      if (process.hrtime.bigint() >= expiresAtNs)
        throw new ModFunctionError("MODS_CONVERSATION_TOOL_SIDE_DEADLINE")
    }
    const original = captureNativeMessageForOccurrence(message, view.uuid, bounded)
    const additional = original.snapshot.data.additional_kwargs
    if (original.snapshot.type !== nativeType || original.snapshot.executionSuppressed ||
      !additional || typeof additional !== "object" || Array.isArray(additional) ||
      ["function_row", "function_row_invalid", "cmb_visible_user_message",
        "cmb_coordinator_augmented_user_message"].some(key => Object.hasOwn(additional, key))) fail()
    const certificate = readFunctionConversationNativePolicySource(view.policy, runtime)
    if (!certificate) fail()
    const policyValue = own(view.policy, "value"), policyIdentity = own(policyValue, "identity")
    const fixedPolicy = policyFacts(view.policy)
    const assertDataCurrent = () => {
      if (state.failed) fail()
      bounded()
      view.assertTail()
      if (Object.getPrototypeOf(message) !== prototype ||
        own(view.policy, "value") !== policyValue || own(policyValue, "identity") !== policyIdentity ||
        policyFacts(view.policy) !== fixedPolicy ||
        captureNativeMessageForOccurrence(message, view.uuid, bounded).originalDigest !==
          original.originalDigest) fail()
      certificate.assertTail()
      view.assertTail()
      bounded()
    }
    const assertCurrent = () => {
      if (state.reading) { state.failed = true; fail() }
      if (state.failed) fail()
      state.reading = true
      try {
        assertDataCurrent()
        view.assertCurrent()
        assertDataCurrent()
        if (state.failed || !state.reading || view.receipt !== receipt || view.message !== message)
          fail()
      } catch (error) { state.failed = true; throw error }
      finally { state.reading = false }
    }
    assertCurrent()
    const token: FunctionNativeToolSideReceipt = Object.freeze({ [brand]: true as const })
    sources.set(token, Object.freeze({ receipt, slot, runtime, occurrence: receipt, message,
      nativeType, uuid: view.uuid, door: "tool-message" as const, origin: view.origin,
      policy: view.policy, signal, expiresAtNs, assertCurrent, assertDataCurrent }))
    return token
  } catch (error) { state.failed = true; throw error }
}

export function readFunctionConversationNativeToolSide(token: FunctionNativeToolSideReceipt):
  FunctionNativeToolSideSource {
  const source = sources.get(token)
  if (!source) fail()
  source.assertCurrent()
  return source
}

/** This factory constructs the complete same-source callback; the host latch can only revoke it. */
export function captureFunctionConversationNativeToolSideCurrent(token: FunctionNativeToolSideReceipt,
  originalHostLatch: object): () => void {
  // Select the original fact and occupy its once latch before any source callback can reenter.
  const source = sources.get(token), previous = currents.get(token)
  if (previous) { previous.failed = true; fail() }
  if (!source) fail()
  const record: CurrentSource = { token, source, preparing: true, reading: false, failed: false }
  currents.set(token, record)
  try {
    record.latch = hostLatch(originalHostLatch)
    const current = () => {
      if (record.preparing || record.reading || record.failed) { record.failed = true; fail() }
      record.reading = true
      try {
        assertCurrentSource(record)
        source.assertCurrent()
        source.assertDataCurrent()
        assertCurrentSource(record)
        if (!record.reading) fail()
      } catch (error) { record.failed = true; throw error }
      finally { record.reading = false }
    }
    record.current = current
    assertCurrentSource(record)
    source.assertCurrent()
    source.assertDataCurrent()
    assertCurrentSource(record)
    record.preparing = false
    currentSources.set(current, record)
    return current
  } catch (error) { record.failed = true; throw error }
}

/** Only this factory's exact callback can certify its original runtime's complete source check. */
export function readFunctionConversationNativeToolSideCurrent(current: unknown,
  runtime: object): FunctionNativeToolSideCurrentSource | undefined {
  if (typeof current !== "function" || types.isProxy(current)) return undefined
  const record = currentSources.get(current as () => void)
  if (!record || record.source.runtime !== runtime) return undefined
  const identity = () => {
    if (record.preparing || record.reading || record.current !== current ||
      currentSources.get(current as () => void) !== record || record.source.runtime !== runtime) {
      record.failed = true
      fail()
    }
    assertCurrentSource(record)
  }
  try { identity() }
  catch (error) { record.failed = true; throw error }
  return Object.freeze({ assertTail() {
    try {
      identity()
      record.source.assertDataCurrent()
      identity()
    } catch (error) { record.failed = true; throw error }
  } })
}
