import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { types } from "node:util"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { FunctionConversationTarget } from "../mods/v2/conversation-registry"
import type { FunctionConversationRef } from "./function-conversation-store"
import { FunctionNativeMessageProtector,
  type FunctionProtectedNativeMessage } from "../agent/native-message-protector"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { fixedFunctionConversationNativeFacts } from "../agent/function-conversation-native-rendering"

const originalBrand = Symbol("native-original-execution")
const finalBrand = Symbol("native-final-execution")
export interface FunctionNativeOriginalExecution { readonly [originalBrand]: true }
export interface FunctionNativeFinalExecutionReceipt { readonly [finalBrand]: true }

export interface FunctionNativeExecutionSource {
  readonly producer: object
  readonly run: object
  readonly occurrence: object
  readonly target: FunctionConversationTarget
  readonly signal: AbortSignal
  assertCurrent(): void
}
export interface FunctionNativeFinalExecutionExpectation {
  readonly producer: object
  readonly run: object
  readonly occurrence: object
  readonly target: FunctionConversationRef
  readonly uuid: string
  readonly nativePayload: string
}
interface Original {
  readonly owner: FunctionConversationFinalExecutions
  readonly source: FunctionNativeExecutionSource
  readonly sourceCurrent: FunctionNativeExecutionSource["assertCurrent"]
  readonly result: FunctionProtectedNativeMessage
  readonly fixed: unknown
  readonly calls: string | null
}
interface Final {
  readonly original: Original
  readonly result: FunctionProtectedNativeMessage
  readonly payload: string
}
const originals = new WeakMap<FunctionNativeOriginalExecution, Original>()
const finals = new WeakMap<FunctionNativeFinalExecutionReceipt, Final>()
const nativeThen = Promise.prototype.then

function syncResult(value: unknown): void {
  if (value === undefined) return
  if (value && typeof value === "object" && !types.isProxy(value) && types.isPromise(value) &&
    Object.getPrototypeOf(value) === Promise.prototype &&
    !Object.getOwnPropertyDescriptor(value, "constructor"))
    void nativeThen.call(value, undefined, () => undefined)
  fail()
}
function field(value: object, name: string): unknown {
  if (types.isProxy(value)) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (!descriptor || !("value" in descriptor)) fail()
  return descriptor.value
}

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_FINAL_EXECUTION_INVALID") }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) fail()
  return value as Record<string, unknown>
}
function data(payload: string): Record<string, unknown> {
  const envelope: unknown = JSON.parse(payload)
  return object(object(object(envelope).message).data)
}
function fixed(payload: string): unknown {
  return fixedFunctionConversationNativeFacts(payload)
}
function equal(a: unknown, b: unknown): boolean {
  const pending: Array<readonly [unknown, unknown]> = [[a, b]]
  while (pending.length) {
    const pair = pending.pop()
    if (!pair) fail()
    const [left, right] = pair
    if (Object.is(left, right)) continue
    if (!left || !right || typeof left !== "object" || typeof right !== "object" ||
      Array.isArray(left) !== Array.isArray(right)) return false
    const l = left as Record<string, unknown>, r = right as Record<string, unknown>
    const keys = Object.keys(l)
    if (keys.length !== Object.keys(r).length) return false
    for (const key of keys) {
      if (!Object.hasOwn(r, key)) return false
      pending.push([l[key], r[key]])
    }
  }
  return true
}
function sameRef(a: FunctionConversationRef, b: FunctionConversationRef): boolean {
  return a.logicalSessionId === b.logicalSessionId && a.conversationId === b.conversationId &&
    a.branchId === b.branchId && a.kind === b.kind && a.threadId === b.threadId &&
    a.workspace === b.workspace && a.checkpointNamespace === b.checkpointNamespace &&
    a.incarnation.token === b.incarnation.token &&
    a.incarnation.legacyCreatedAt === b.incarnation.legacyCreatedAt
}

function calls(message: BaseMessage, payload: string): string | null {
  if (!AIMessage.isInstance(message)) fail()
  const value = data(payload)
  if (!Array.isArray(value.tool_calls)) fail()
  const ids = new Set<string>()
  const result = value.tool_calls.map(raw => {
    const call = object(raw)
    if (typeof call.id !== "string" || !call.id || ids.has(call.id) ||
      typeof call.name !== "string" || !call.name || !call.args || typeof call.args !== "object" ||
      Array.isArray(call.args)) fail()
    ids.add(call.id)
    return { id: call.id, name: call.name, args: call.args }
  })
  if (Array.isArray(value.content)) for (const raw of value.content) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const block = object(raw)
    if (block.type !== "tool_use" && block.type !== "tool_call") continue
    const call = result.find(item => item.id === block.id)
    if (!call || block.name !== call.name ||
      !equal(block.type === "tool_use" ? block.input : block.args, call.args)) fail()
  }
  return result.length ? JSON.stringify(result) : null
}

/** Only this module can mint a final receipt; public columns or a symbol clone confer no ability. */
export class FunctionConversationFinalExecutions {
  private readonly once = new WeakMap<object, {
    token: FunctionNativeOriginalExecution
    record?: Original
    failed: boolean
  }>()
  private readonly assertResult: FunctionNativeMessageProtector["assertResult"]
  private readonly matchesResultSource: FunctionNativeMessageProtector["matchesResultSource"]
  private readonly assertResultData: FunctionNativeMessageProtector["assertResultData"]
  private closed = false

  constructor(protector: FunctionNativeMessageProtector) {
    if (!protector || types.isProxy(protector) ||
      !(protector instanceof FunctionNativeMessageProtector)) fail()
    this.assertResult = FunctionNativeMessageProtector.prototype.assertResult.bind(protector)
    this.matchesResultSource = FunctionNativeMessageProtector.prototype.matchesResultSource.bind(protector)
    this.assertResultData = FunctionNativeMessageProtector.prototype.assertResultData.bind(protector)
  }

  capture(source: FunctionNativeExecutionSource, result: FunctionProtectedNativeMessage):
    FunctionNativeOriginalExecution {
    if (this.closed || !source || types.isProxy(source) || !source.occurrence ||
      typeof source.occurrence !== "object" || types.isProxy(source.occurrence)) fail()
    const prior = this.once.get(source.occurrence)
    if (prior) {
      if (!prior.record) { prior.failed = true; fail() }
      if (prior.failed || prior.record.source.producer !== source.producer ||
        prior.record.source.run !== source.run || prior.record.source.target !== source.target ||
        prior.record.result !== result) fail()
      this.assertOriginal(prior.record)
      return prior.token
    }
    const token: FunctionNativeOriginalExecution = Object.freeze({ [originalBrand]: true as const })
    const latch = { token, record: undefined as Original | undefined, failed: false }
    this.once.set(source.occurrence, latch)
    try {
      for (const identity of [source.producer, source.run, source.target])
        if (!identity || typeof identity !== "object" || types.isProxy(identity)) fail()
      const sourceCurrent = source.assertCurrent
      const captured = Object.freeze({ ...source, assertCurrent: sourceCurrent.bind(source) })
      this.assertSource(captured)
      this.assertResult(result.receipt, result.message, captured.producer)
      const payload = serializeFunctionConversationNativeMessage(result.message)
      const record: Original = { owner: this, source: captured, sourceCurrent, result,
        fixed: fixed(payload), calls: calls(result.message, payload) }
      this.assertOriginal(record)
      if (latch.failed) fail()
      latch.record = record
      originals.set(token, record)
      return token
    } catch (error) { latch.failed = true; throw error }
  }

  bind(original: FunctionNativeOriginalExecution, result: FunctionProtectedNativeMessage):
    FunctionNativeFinalExecutionReceipt {
    const record = originals.get(original)
    if (!record || record.owner !== this) fail()
    this.assertOriginal(record)
    this.assertResult(result.receipt, result.message, record.source.producer)
    const payload = serializeFunctionConversationNativeMessage(result.message)
    if (!equal(record.fixed, fixed(payload)) || record.calls !== calls(result.message, payload)) fail()
    this.assertOriginal(record)
    const receipt: FunctionNativeFinalExecutionReceipt = Object.freeze({ [finalBrand]: true as const })
    finals.set(receipt, { original: record, result, payload })
    return receipt
  }

  private assertSource(source: FunctionNativeExecutionSource): void {
    if (this.closed) fail()
    source.signal.throwIfAborted()
    syncResult(source.assertCurrent())
    syncResult(source.target.assertCurrent())
  }

  private assertOriginal(record: Original): void {
    this.assertSource(record.source)
    this.assertResult(record.result.receipt, record.result.message, record.source.producer)
  }

  assertFinal(record: Final): void {
    if (record.original.owner !== this) fail()
    const original = record.original, source = original.source
    if (this.matchesResultSource(original.result.receipt, original.result.message, source.producer,
      original.sourceCurrent, source.signal) &&
      this.matchesResultSource(record.result.receipt, record.result.message, source.producer,
        original.sourceCurrent, source.signal)) {
      const data = () => {
        this.assertResultData(original.result.receipt, original.result.message, source.producer,
          original.sourceCurrent, source.signal)
        this.assertResultData(record.result.receipt, record.result.message, source.producer,
          original.sourceCurrent, source.signal)
      }
      this.assertSource(source)
      data()
      if (serializeFunctionConversationNativeMessage(record.result.message) !== record.payload) fail()
      // Serialization calls native SDK methods. Check the source again after those callbacks.
      this.assertSource(source)
      data()
      if (this.closed) fail()
      source.signal.throwIfAborted()
      return
    }
    this.assertOriginal(record.original)
    this.assertResult(record.result.receipt, record.result.message, record.original.source.producer)
    if (serializeFunctionConversationNativeMessage(record.result.message) !== record.payload) fail()
    this.assertSource(record.original.source)
  }

  close(): void { this.closed = true }
}

export function readFunctionNativeFinalExecution(receipt: FunctionNativeFinalExecutionReceipt,
  expected: FunctionNativeFinalExecutionExpectation): Readonly<{ tool_calls_json: string | null }> {
  const final = finals.get(receipt)
  if (!final) fail()
  if (!expected || types.isProxy(expected)) fail()
  for (const key of ["producer", "run", "occurrence", "target", "uuid", "nativePayload"])
    field(expected, key)
  if (!expected.target || types.isProxy(expected.target)) fail()
  for (const key of ["logicalSessionId", "conversationId", "branchId", "kind", "threadId",
    "workspace", "checkpointNamespace", "incarnation"]) field(expected.target, key)
  if (!expected.target.incarnation || types.isProxy(expected.target.incarnation)) fail()
  field(expected.target.incarnation, "token"); field(expected.target.incarnation, "legacyCreatedAt")
  const source = final.original.source
  if (expected.producer !== source.producer || expected.run !== source.run ||
    expected.occurrence !== source.occurrence || !sameRef(expected.target, source.target.ref) ||
    expected.uuid !== final.result.message.id || expected.nativePayload !== final.payload) fail()
  final.original.owner.assertFinal(final)
  return Object.freeze({ tool_calls_json: final.original.calls })
}
