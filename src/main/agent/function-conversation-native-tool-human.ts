import { HumanMessage } from "@langchain/core/messages"
import { types } from "node:util"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import { readFunctionConversationNativePolicySource, snapshotFunctionNativeDeployment } from
  "../mods/native-conversation-policy-source"
import { captureNativeMessageForOccurrence } from "./native-message-capture"
import { readFunctionConversationNativeToolReturn, type FunctionNativeToolReturn } from
  "./function-conversation-native-tools"
import type { FunctionConversationNativeNodeSlot } from "./function-conversation-native-node"

const brand = Symbol("function-native-tool-human")
export interface FunctionNativeToolHumanReceipt { readonly [brand]: true }
export interface FunctionNativeToolHumanCapture {
  readonly receipt: FunctionNativeToolReturn
  readonly slot: FunctionConversationNativeNodeSlot
  readonly runtime: FunctionNativeConversationRuntime
}
export interface FunctionNativeToolHumanSource {
  readonly receipt: FunctionNativeToolReturn
  readonly slot: FunctionConversationNativeNodeSlot
  readonly runtime: FunctionNativeConversationRuntime
  readonly occurrence: object
  readonly message: HumanMessage
  readonly uuid: string
  readonly door: "tool-message"
  readonly origin: Readonly<{ kind: "tool"; tool: string }>
  readonly policy: ReturnType<FunctionNativeConversationRuntime["capturePolicy"]>
  readonly signal: AbortSignal
  /** The original first-capture cut, also used by the eventual Keeper admission. */
  readonly expiresAtNs: bigint
  /** Pure original complete data and address tail; no grant or source callback. */
  assertDataCurrent(): void
  assertCurrent(): void
}
const captured = new WeakMap<FunctionNativeToolReturn, { failed: boolean }>()
const sources = new WeakMap<FunctionNativeToolHumanReceipt, FunctionNativeToolHumanSource>()
interface CreatingState {
  readonly value: object
  readonly descriptor: PropertyDescriptor
}
interface CurrentSource {
  readonly receipt: FunctionNativeToolHumanReceipt
  readonly source: FunctionNativeToolHumanSource
  readonly states: readonly CreatingState[]
  readonly current: () => void
  reading: boolean
  failed: boolean
}
const currentSources = new WeakMap<() => void, CurrentSource>()
const stringify = JSON.stringify

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_TOOL_HUMAN_INVALID") }
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field || !field.enumerable || !("value" in field)) fail()
  return field.value
}
function creatingState(value: unknown): CreatingState {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 1) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, "failed")
  if (!descriptor || !("value" in descriptor) || descriptor.value !== false ||
    !descriptor.enumerable) fail()
  return Object.freeze({ value, descriptor: Object.freeze(descriptor) })
}
function assertCreatingState(state: CreatingState): void {
  if (types.isProxy(state.value) || Object.getPrototypeOf(state.value) !== Object.prototype ||
    Reflect.ownKeys(state.value).length !== 1) fail()
  const actual = Object.getOwnPropertyDescriptor(state.value, "failed")
  if (!actual || !("value" in actual) || actual.value !== false ||
    actual.enumerable !== state.descriptor.enumerable ||
    actual.writable !== state.descriptor.writable ||
    actual.configurable !== state.descriptor.configurable) fail()
}
function assertCurrentSource(record: CurrentSource): void {
  if (record.failed || currentSources.get(record.current) !== record ||
    sources.get(record.receipt) !== record.source) fail()
  for (const state of record.states) assertCreatingState(state)
}
function policyFacts(policy: FunctionNativeToolHumanSource["policy"]): string {
  const value = own(policy, "value")
  const epoch = own(value, "epoch"), digest = own(value, "digest")
  const protectedValue = own(value, "protected")
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0 ||
    typeof digest !== "string" || typeof protectedValue !== "boolean") fail()
  return stringify({ epoch, digest, protected: protectedValue,
    deployment: snapshotFunctionNativeDeployment(own(value, "deployment")) })
}

/** Tool side-only. It never creates NativeInput, a saved ACK or a presentation/commit permission. */
export function captureFunctionConversationNativeToolHuman(input: FunctionNativeToolHumanCapture):
  FunctionNativeToolHumanReceipt {
  const expiresAtNs = process.hrtime.bigint() + 30_000_000_000n
  const assertDeadline = () => {
    if (process.hrtime.bigint() >= expiresAtNs)
      throw new ModFunctionError("MODS_CONVERSATION_TOOL_HUMAN_DEADLINE")
  }
  const receipt = own(input, "receipt") as FunctionNativeToolReturn
  if (!receipt || typeof receipt !== "object" || types.isProxy(receipt)) fail()
  const prior = captured.get(receipt)
  if (prior) { prior.failed = true; fail() }
  const state = { failed: false, reading: false }
  captured.set(receipt, state)
  try {
    const slot = own(input, "slot") as FunctionConversationNativeNodeSlot
    const runtime = own(input, "runtime") as FunctionNativeConversationRuntime
    assertDeadline()
    const view = readFunctionConversationNativeToolReturn(receipt, slot, runtime)
    if (view.door !== "tool-message" || types.isProxy(view.message) ||
      Object.getPrototypeOf(view.message) !== HumanMessage.prototype) fail()
    const message = view.message as HumanMessage
    const signal = AbortSignal.any([runtime.signal, runtime.target.signal,
      ...(view.signal ? [view.signal] : [])])
    const bounded = () => { signal.throwIfAborted(); assertDeadline() }
    const original = captureNativeMessageForOccurrence(message, view.uuid, bounded)
    const additional = original.snapshot.data.additional_kwargs
    if (original.snapshot.type !== "human" || original.snapshot.executionSuppressed ||
      !additional || typeof additional !== "object" || Array.isArray(additional) ||
      Object.hasOwn(additional, "function_row") || Object.hasOwn(additional, "function_row_invalid") ||
      Object.hasOwn(additional, "cmb_visible_user_message") ||
      Object.hasOwn(additional, "cmb_coordinator_augmented_user_message")) fail()
    const certificate = readFunctionConversationNativePolicySource(view.policy, runtime)
    if (!certificate) fail()
    const policyValue = own(view.policy, "value"), policyIdentity = own(policyValue, "identity")
    const fixedPolicy = policyFacts(view.policy)
    const assertDataCurrent = () => {
      if (state.failed) fail()
      bounded()
      view.assertTail()
      if (own(view.policy, "value") !== policyValue || own(policyValue, "identity") !== policyIdentity ||
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
        // The original frozen view was admitted by the genuine receipt/runtime reader above.
        // Its full closure still checks this Work, slot, source and policy on every invocation;
        // fetching another view would repeat only the same slot's preliminary full guard.
        view.assertCurrent()
        assertDataCurrent()
        if (state.failed || !state.reading || view.message !== message || view.receipt !== receipt)
          fail()
      } catch (error) { state.failed = true; throw error }
      finally { state.reading = false }
    }
    assertCurrent()
    const source: FunctionNativeToolHumanSource = Object.freeze({ receipt, slot, runtime,
      occurrence: receipt, message, uuid: view.uuid, door: "tool-message" as const,
      origin: view.origin, policy: view.policy, signal, expiresAtNs,
      assertDataCurrent, assertCurrent })
    const token: FunctionNativeToolHumanReceipt = Object.freeze({ [brand]: true as const })
    sources.set(token, source)
    return token
  } catch (error) { state.failed = true; throw error }
}

export function readFunctionConversationNativeToolHuman(receipt: FunctionNativeToolHumanReceipt):
  FunctionNativeToolHumanSource {
  const source = sources.get(receipt)
  if (!source) fail()
  source.assertCurrent()
  return source
}

/** Original Creating data only; this factory constructs the full source callback itself. */
export function captureFunctionConversationNativeToolHumanCurrent(
  receipt: FunctionNativeToolHumanReceipt,
  firstCreating: object,
  secondCreating: object
): () => void {
  const source = sources.get(receipt)
  if (!source) fail()
  const states = Object.freeze([creatingState(firstCreating), creatingState(secondCreating)])
  const current = () => {
    if (record.reading) { record.failed = true; fail() }
    if (record.failed) fail()
    record.reading = true
    try {
      assertCurrentSource(record)
      // Every independent call retains the original Work/slot/owner/policy and physical checks.
      source.assertCurrent()
      source.assertDataCurrent()
      assertCurrentSource(record)
      if (!record.reading) fail()
    } catch (error) { record.failed = true; throw error }
    finally { record.reading = false }
  }
  const record: CurrentSource = { receipt, source, states, current, reading: false, failed: false }
  currentSources.set(current, record)
  return current
}

/** Exact private factory relationship only. Unknown callbacks preserve their full sandwich. */
export function readFunctionConversationNativeToolHumanCurrent(
  receipt: FunctionNativeToolHumanReceipt,
  current: unknown
): Readonly<{ assertTail(): void }> | undefined {
  if (typeof current !== "function" || types.isProxy(current)) return undefined
  const record = currentSources.get(current as () => void)
  if (!record || record.receipt !== receipt || sources.get(receipt) !== record.source) return undefined
  return Object.freeze({ assertTail() {
    if (record.reading) { record.failed = true; fail() }
    try {
      assertCurrentSource(record)
      record.source.assertDataCurrent()
      assertCurrentSource(record)
    } catch (error) { record.failed = true; throw error }
  } })
}
