import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { types } from "node:util"
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import type { BaseMessage } from "@langchain/core/messages"
import type { LLMResult } from "@langchain/core/outputs"
import type { Serialized } from "@langchain/core/load/serializable"
import type { HandleLLMNewTokenCallbackFields } from "@langchain/core/callbacks/base"
import type { NewTokenIndices } from "@langchain/core/callbacks/base"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import { readFunctionConversationNativeSharedPolicySource } from
  "../mods/native-conversation-policy-source"
import type { FunctionConversationGraphRuntime } from "./mods-conversation"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { currentFunctionConversationNativeSseSource,
  type FunctionConversationNativeSseSource } from "./function-conversation-native-lifetime"
import { readFunctionConversationNativeNodeWorkModelName,
  type FunctionConversationNativeNodeWorkModelName } from "./function-conversation-native-node"

const callBrand = Symbol("native-model-call")
const attemptBrand = Symbol("native-model-attempt")
const partialBrand = Symbol("native-model-partial")
const completedPartialBrand = Symbol("native-model-completed-partial")
const nativeWeakGet = WeakMap.prototype.get, nativeWeakSet = WeakMap.prototype.set
const nativeMapGet = Map.prototype.get, nativeSetHas = Set.prototype.has
const nativeSetAdd = Set.prototype.add
const nativeSetValues = Set.prototype.values
const nativeSetNext = Object.getPrototypeOf(new Set().values()).next as
  (this: Iterator<unknown>) => IteratorResult<unknown>
function weakData<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return Reflect.apply(nativeWeakGet, map, [key]) as V | undefined
}
function mapData<K, V>(map: Map<K, V>, key: K): V | undefined {
  return Reflect.apply(nativeMapGet, map, [key]) as V | undefined
}
let selectActual: (owner: FunctionConversationNativeCalls, values: Set<Attempt> | undefined,
  call?: Call) => Attempt | undefined = () => fail()
export interface FunctionNativeModelCall { readonly [callBrand]: true }
export interface FunctionNativeModelAttempt { readonly [attemptBrand]: true }
export interface FunctionNativeModelPartial { readonly [partialBrand]: true }
export interface FunctionNativeCompletedPartialCandidate { readonly [completedPartialBrand]: true }

export interface FunctionNativeCompletedPartialView {
  readonly runtime: FunctionNativeConversationRuntime
  readonly call: FunctionNativeModelCall
  readonly attempt: FunctionNativeModelAttempt
  readonly chunk: object
  readonly returnedMessage: BaseMessage
  readonly uuid: string
  readonly policy: ReturnType<FunctionNativeConversationRuntime["capturePolicy"]>
  readonly signal: AbortSignal
  readonly source: FunctionConversationNativeSseSource
  readonly configurable: NonNullable<FunctionConversationGraphRuntime["configurable"]>
  assertCurrent(): void
  assertDataCurrent(): void
}
export interface FunctionNativeCompletedModelReturnView {
  readonly runtime: FunctionNativeConversationRuntime
  readonly source?: FunctionConversationNativeSseSource
  readonly message: BaseMessage
  readonly uuid: string
  assertCurrent(): void
  assertDataCurrent(): void
}
const completedReturnReaders = new WeakMap<FunctionNativeModelAttempt, {
  readonly runtime: FunctionNativeConversationRuntime
  readonly source?: FunctionConversationNativeSseSource
  read(): FunctionNativeCompletedModelReturnView
}>()

/** The actual returned aggregate is a data source, not a live/full message capability. */
export function readFunctionNativeCompletedModelReturn(attempt: FunctionNativeModelAttempt,
  runtime: FunctionNativeConversationRuntime, source?: FunctionConversationNativeSseSource):
  FunctionNativeCompletedModelReturnView {
  const actual = weakData(completedReturnReaders, attempt)
  if (!actual || actual.runtime !== runtime || actual.source !== source) fail()
  return actual.read()
}
const completedPartials = new WeakMap<FunctionNativeCompletedPartialCandidate,
  FunctionNativeCompletedPartialView>()
const throwIfAborted = AbortSignal.prototype.throwIfAborted

/** A completed callback address is only an omission candidate, never a live display token. */
export function readFunctionNativeCompletedPartial(candidate: FunctionNativeCompletedPartialCandidate,
  runtime?: FunctionNativeConversationRuntime,
  source?: FunctionConversationNativeSseSource): FunctionNativeCompletedPartialView {
  const view = weakData(completedPartials, candidate)
  if (!view || (runtime !== undefined && view.runtime !== runtime) ||
    (source !== undefined && view.source !== source)) fail()
  view.assertCurrent()
  return view
}

/** Pure private lookup for the final data tail; this does not execute a source callback. */
export function selectFunctionNativeCompletedPartial(candidate: FunctionNativeCompletedPartialCandidate):
  FunctionNativeCompletedPartialView {
  const view = weakData(completedPartials, candidate)
  if (!view) fail()
  view.assertDataCurrent()
  return view
}

export interface FunctionNativeModelPartialView {
  readonly runtime: FunctionNativeConversationRuntime
  readonly configurable: object
  readonly modelName: FunctionConversationNativeNodeWorkModelName | undefined
  readonly message: object
  readonly uuid: string
  readonly namespace: string
  readonly signal: AbortSignal
  readonly policy: ReturnType<FunctionNativeConversationRuntime["capturePolicy"]>
  readonly providerSourceId: string
  readonly providerOccurrence: number
  /** Fixed by the real model-start callback, never by a later wire projection. */
  readonly sseSource?: FunctionConversationNativeSseSource
  assertCurrent(): void
  /** Pure original-owner checks only; this does not run a source or policy callback. */
  assertTail(): void
}
const partials = new WeakMap<FunctionNativeModelPartial, FunctionNativeModelPartialView>()

export function readFunctionNativeModelPartial(
  token: FunctionNativeModelPartial
): FunctionNativeModelPartialView {
  const view = weakData(partials, token)
  if (!view) fail()
  view.assertCurrent()
  return view
}

interface Call {
  readonly owner: FunctionConversationNativeCalls
  readonly token: FunctionNativeModelCall
  readonly configurable: NonNullable<FunctionConversationGraphRuntime["configurable"]>
  readonly taskId: string
  readonly namespace: string
  readonly read: object
  readonly signal: AbortSignal
  readonly policy: ReturnType<FunctionNativeConversationRuntime["capturePolicy"]>
  readonly modelName: FunctionConversationNativeNodeWorkModelName | undefined
  readonly assertActorData: (() => void) | undefined
  readonly attempts: Map<string, Attempt>
  running: boolean
  returned?: { message: BaseMessage; attempt: Attempt }
}
interface Attempt {
  readonly call: Call
  readonly token: FunctionNativeModelAttempt
  readonly runId: string
  readonly parentRunId?: string
  readonly uuid: string
  readonly sseSource?: FunctionConversationNativeSseSource
  status: "running" | "completed" | "failed"
  sealed: boolean
  provider?: Readonly<{ sourceId: string; occurrence: number }>
}
interface AttemptView {
  readonly uuid: string
  readonly call: FunctionNativeModelCall
  readonly attempt: FunctionNativeModelAttempt
  readonly signal: AbortSignal
  readonly policy: ReturnType<FunctionNativeConversationRuntime["capturePolicy"]>
  readonly completed: boolean
  readonly sealed: boolean
  readonly providerSourceId: string
  readonly providerOccurrence: number
  assertCurrent(): void
}

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_NATIVE_CALL_INVALID") }
function own(value: unknown, key: PropertyKey): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !("value" in descriptor)) fail()
  return descriptor.value
}
function task(configurable: FunctionConversationGraphRuntime["configurable"]) {
  if (!configurable) fail()
  const taskId = own(configurable, "__pregel_task_id")
  const namespace = own(configurable, "checkpoint_ns")
  const read = own(configurable, "__pregel_read")
  if (typeof taskId !== "string" || !taskId || typeof namespace !== "string" || !namespace ||
    typeof read !== "function") fail()
  return { taskId, namespace, read }
}

/** Original callback objects select a prior private call, never mint target/authority from IDs. */
export class FunctionConversationNativeCalls {
  private readonly local = new AsyncLocalStorage<Call>()
  private readonly calls = new WeakMap<FunctionNativeModelCall, Call>()
  private readonly attempts = new WeakMap<FunctionNativeModelAttempt, Attempt>()
  private readonly byTask = new Map<string, Call>()
  private readonly chunks = new WeakMap<object, Set<Attempt>>()
  private readonly results = new WeakMap<object, Set<Attempt>>()
  private readonly completedChunks = new WeakMap<object, FunctionNativeCompletedPartialCandidate>()
  private readonly providerOccurrences = new Map<string, number>()
  readonly callback: BaseCallbackHandler
  private closed = false

  constructor(private readonly runtime: FunctionNativeConversationRuntime) {
    const createCallback = (owner: FunctionConversationNativeCalls): BaseCallbackHandler =>
      new class extends BaseCallbackHandler {
      name = "devclaw-native-conversation"
      constructor() { super({ _awaitHandler: true, raiseError: true }) }
      handleChatModelStart(_model: Serialized, _messages: BaseMessage[][], runId: string,
        parentRunId?: string, _extra?: Record<string, unknown>, _tags?: string[],
        metadata?: Record<string, unknown>): void {
        const call = owner.local.getStore()
        if (!call) return
        const sseSource = currentFunctionConversationNativeSseSource()
        owner.assertCall(call)
        if (metadata?.langgraph_checkpoint_ns !== call.namespace || !runId ||
          call.attempts.has(runId)) fail()
        const token: FunctionNativeModelAttempt = Object.freeze({ [attemptBrand]: true as const })
        const attempt: Attempt = { call, token, runId, parentRunId, uuid: randomUUID(),
          status: "running", sealed: false, ...(sseSource ? { sseSource } : {}) }
        call.attempts.set(runId, attempt)
        owner.attempts.set(token, attempt)
        completedReturnReaders.set(token, { runtime: owner.runtime, source: sseSource,
          read: () => owner.readCompletedReturn(attempt) })
      }
      handleLLMNewToken(_token: string, _indices: NewTokenIndices, runId: string,
        _parentRunId?: string, _tags?: string[], fields?: HandleLLMNewTokenCallbackFields): void {
        const call = owner.local.getStore()
        if (!call) return
        const attempt = call.attempts.get(runId)
        if (!attempt || attempt.status !== "running") fail()
        owner.assertCall(call)
        const chunk = own(fields, "chunk")
        if (!chunk) fail()
        const message = own(chunk, "message")
        if (!message || typeof message !== "object") fail()
        owner.add(owner.chunks, message, attempt)
      }
      handleLLMEnd(output: LLMResult, runId: string): void {
        const call = owner.local.getStore()
        if (!call) return
        const attempt = call.attempts.get(runId)
        if (!attempt || attempt.status !== "running") fail()
        owner.assertCall(call)
        const generations = own(output, "generations")
        if (!Array.isArray(generations) || types.isProxy(generations)) fail()
        for (let outer = 0; outer < generations.length; outer++) {
          const row = own(generations, String(outer))
          if (!Array.isArray(row) || types.isProxy(row)) fail()
          for (let inner = 0; inner < row.length; inner++) {
            const message = own(own(row, String(inner)), "message")
            if (!message || typeof message !== "object") fail()
            owner.add(owner.results, message, attempt)
          }
        }
        attempt.status = "completed"
      }
      handleLLMError(_error: Error, runId: string): void {
        const call = owner.local.getStore()
        if (!call) return
        const attempt = call.attempts.get(runId)
        if (!attempt) fail()
        attempt.status = "failed"
        attempt.sealed = true
      }
      }()
    this.callback = createCallback(this)
  }

  private add(table: WeakMap<object, Set<Attempt>>, message: object, attempt: Attempt): void {
    if (types.isProxy(message)) fail()
    const existing = table.get(message) ?? new Set<Attempt>()
    existing.add(attempt)
    table.set(message, existing)
  }
  private assertCall(call: Call): void {
    if (this.closed || call.owner !== this || this.calls.get(call.token) !== call ||
      this.byTask.get(call.taskId) !== call) fail()
    const sharedPolicy = readFunctionConversationNativeSharedPolicySource(call.policy, this.runtime)
    if (!sharedPolicy) this.runtime.assertCurrent()
    call.assertActorData?.()
    call.signal.throwIfAborted()
    if (sharedPolicy) sharedPolicy.assertCurrent()
    else call.policy.assertCurrent()
    call.assertActorData?.()
    const current = task(call.configurable)
    if (current.taskId !== call.taskId || current.namespace !== call.namespace ||
      current.read !== call.read || call.configurable.thread_id !== this.runtime.binding.checkpointThreadId)
      fail()
    call.assertActorData?.()
  }

  capture(runtime: FunctionConversationGraphRuntime,
    modelName?: FunctionConversationNativeNodeWorkModelName): FunctionNativeModelCall {
    let actorData: (() => void) | undefined
    if (modelName) {
      if (types.isProxy(runtime)) fail()
      const field = Object.getOwnPropertyDescriptor(runtime, "configurable")
      const prototype = Object.getPrototypeOf(runtime)
      if (!field || !("value" in field) || !field.value || typeof field.value !== "object") fail()
      const configurable: object = field.value
      actorData = () => {
        const current = Object.getOwnPropertyDescriptor(runtime, "configurable")
        if (types.isProxy(runtime) || Object.getPrototypeOf(runtime) !== prototype ||
          !current || !("value" in current) || current.value !== configurable ||
          current.enumerable !== field.enumerable || current.writable !== field.writable ||
          current.configurable !== field.configurable) fail()
        readFunctionConversationNativeNodeWorkModelName(modelName, this.runtime, configurable)
      }
      actorData()
    }
    this.runtime.assertCurrent()
    actorData?.()
    if (this.closed) fail()
    const { taskId, namespace, read } = task(runtime.configurable)
    if (!runtime.configurable || this.byTask.has(taskId) ||
      runtime.configurable.thread_id !== this.runtime.binding.checkpointThreadId) fail()
    const token: FunctionNativeModelCall = Object.freeze({ [callBrand]: true as const })
    const call: Call = { owner: this, token, configurable: runtime.configurable,
      taskId, namespace, read,
      signal: AbortSignal.any([this.runtime.signal, ...(runtime.signal ? [runtime.signal] : [])]),
      policy: this.runtime.capturePolicy(), modelName, assertActorData: actorData,
      attempts: new Map(), running: false }
    this.calls.set(token, call)
    this.byTask.set(taskId, call)
    this.assertCall(call)
    return token
  }
  async run<T extends BaseMessage>(token: FunctionNativeModelCall,
    invoke: () => Promise<T>): Promise<T> {
    const call = this.calls.get(token)
    if (!call) fail()
    this.assertCall(call)
    if (call.running || call.returned) fail()
    call.running = true
    let response: T
    try { response = await this.local.run(call, invoke) }
    catch (error) {
      // Only an unfinished original handler can admit the framework's ordinary retry. A
      // completed output is permanently owned by its finalizer, including commit failures.
      for (const attempt of call.attempts.values()) attempt.sealed = true
      if (this.byTask.get(call.taskId) === call) this.byTask.delete(call.taskId)
      throw error
    } finally { call.running = false }
    this.assertCall(call)
    const attempt = selectActual(this, this.results.get(response), call)
    if (!attempt || attempt.status !== "completed" || call.returned) fail()
    this.bindProvider(attempt, response)
    call.returned = { message: response, attempt }
    return response
  }
  private select(values: Set<Attempt> | undefined, call?: Call): Attempt | undefined {
    const eligible: Attempt[] = []
    if (values) {
      const iterator = Reflect.apply(nativeSetValues, values, []) as Iterator<Attempt>
      while (true) {
        const next = Reflect.apply(nativeSetNext, iterator, []) as IteratorResult<Attempt>
        if (next.done) break
        if (!call || next.value.call === call) eligible[eligible.length] = next.value
      }
    }
    if (!eligible.length) return undefined
    // A real nested model can expose the same message at several layers. Select only its unique
    // actual outer ancestor, never the last callback or an equal provider message ID.
    // Constructing a Set from an iterable reads its current add method. Keep the original
    // insertion order without invoking a later prototype getter during the data-only tail.
    const ids = new Set<string>()
    for (let index = 0; index < eligible.length; index++)
      Reflect.apply(nativeSetAdd, ids, [eligible[index].runId])
    const roots: Attempt[] = []
    for (let index = 0; index < eligible.length; index++) {
      const value = eligible[index]
      if (!value.parentRunId || !Reflect.apply(nativeSetHas, ids, [value.parentRunId]))
        roots[roots.length] = value
    }
    if (roots.length !== 1) fail()
    for (let index = 0; index < eligible.length; index++)
      if (eligible[index].call !== roots[0].call) fail()
    return roots[0]
  }
  private view(attempt: Attempt): AttemptView {
    if (!attempt.provider && !attempt.sealed) fail()
    return Object.freeze({ uuid: attempt.uuid, call: attempt.call.token, attempt: attempt.token,
      signal: attempt.call.signal, policy: attempt.call.policy,
      providerSourceId: attempt.provider?.sourceId ?? attempt.uuid,
      providerOccurrence: attempt.provider?.occurrence ?? 1,
      completed: attempt.status === "completed", sealed: attempt.sealed,
      assertCurrent: () => this.assertCall(attempt.call) })
  }
  private readonly returnViews = new WeakMap<FunctionNativeModelAttempt,
    FunctionNativeCompletedModelReturnView>()
  private readCompletedReturn(attempt: Attempt): FunctionNativeCompletedModelReturnView {
    const previous = weakData(this.returnViews, attempt.token)
    if (previous) { previous.assertCurrent(); return previous }
    const call = attempt.call, returned = call.returned, source = attempt.sseSource
    if (!returned || returned.attempt !== attempt || attempt.status !== "completed") fail()
    let reading = false, failed = false
    const assertDataCurrent = () => {
      try {
        if (failed || this.closed || weakData(this.returnViews, attempt.token) !== view ||
          weakData(this.calls, call.token) !== call || mapData(this.byTask, call.taskId) !== call ||
          call.owner !== this || weakData(this.attempts, attempt.token) !== attempt ||
          mapData(call.attempts, attempt.runId) !== attempt || attempt.status !== "completed" ||
          call.returned !== returned || returned.attempt !== attempt ||
          selectActual(this, weakData(this.results, returned.message), call) !== attempt ||
          (source !== undefined && currentFunctionConversationNativeSseSource() !== source)) fail()
        Reflect.apply(throwIfAborted, call.signal, [])
        const current = task(call.configurable)
        if (current.taskId !== call.taskId || current.namespace !== call.namespace ||
          current.read !== call.read ||
          own(call.configurable, "thread_id") !== this.runtime.binding.checkpointThreadId) fail()
      } catch (error) { failed = true; throw error }
    }
    const view: FunctionNativeCompletedModelReturnView = Object.freeze({ runtime: this.runtime,
      source, message: returned.message, uuid: attempt.uuid, assertDataCurrent,
      assertCurrent: () => {
        if (reading) { failed = true; fail() }
        reading = true
        try { assertDataCurrent(); this.assertCall(call); assertDataCurrent() }
        catch (error) { failed = true; throw error }
        finally { reading = false }
      } })
    // Install the original address and sticky latch before this reader's first source callback.
    Reflect.apply(nativeWeakSet, this.returnViews, [attempt.token, view])
    view.assertCurrent()
    return view
  }
  chunk(message: object): Readonly<AttemptView> | undefined {
    const attempt = selectActual(this, this.chunks.get(message))
    if (attempt && !attempt.sealed) this.bindProvider(attempt, message)
    return attempt && this.view(attempt)
  }
  /** Only the original callback's exact chunk address can open a partial-only typed copy. */
  capturePartial(message: object): FunctionNativeModelPartial | undefined {
    const attempt = selectActual(this, this.chunks.get(message))
    if (!attempt) return undefined
    if (attempt.sealed || attempt.status === "failed") fail()
    this.bindProvider(attempt, message)
    const provider = attempt.provider
    if (!provider) fail()
    const call = attempt.call
    const assertTail = () => {
      if (this.closed || selectActual(this, weakData(this.chunks, message)) !== attempt ||
        call.owner !== this || weakData(this.calls, call.token) !== call ||
        mapData(this.byTask, call.taskId) !== call || weakData(this.attempts, attempt.token) !== attempt ||
        mapData(call.attempts, attempt.runId) !== attempt || attempt.provider !== provider ||
        attempt.sealed || attempt.status === "failed") fail()
      Reflect.apply(throwIfAborted, call.signal, [])
      const current = task(call.configurable)
      if (current.taskId !== call.taskId || current.namespace !== call.namespace ||
        current.read !== call.read ||
        own(call.configurable, "thread_id") !== this.runtime.binding.checkpointThreadId) fail()
      call.assertActorData?.()
    }
    const assertCurrent = () => {
      assertTail()
      this.assertCall(call)
      // An original guard may synchronously seal/close this attempt without aborting the run.
      assertTail()
    }
    assertCurrent()
    const token: FunctionNativeModelPartial = Object.freeze({ [partialBrand]: true as const })
    partials.set(token, Object.freeze({ runtime: this.runtime, configurable: call.configurable,
      modelName: call.modelName, message, uuid: attempt.uuid, namespace: call.namespace,
      signal: call.signal, policy: call.policy, providerSourceId: provider.sourceId,
      providerOccurrence: provider.occurrence, sseSource: attempt.sseSource,
      assertCurrent, assertTail }))
    return token
  }
  /** Pure selection at an explicit async boundary; failed live reads never enter this path. */
  selectCompletedPartial(message: object, source: FunctionConversationNativeSseSource):
    FunctionNativeCompletedPartialCandidate | undefined {
    const attempt = selectActual(this, weakData(this.chunks, message))
    if (!attempt) return undefined
    if (this.closed || currentFunctionConversationNativeSseSource() !== source ||
      attempt.sseSource !== source || attempt.status === "failed") fail()
    if (!attempt.sealed) return undefined
    const call = attempt.call, returned = call.returned, provider = attempt.provider
    if (attempt.status !== "completed" || !returned || returned.attempt !== attempt || !provider ||
      selectActual(this, weakData(this.results, returned.message), call) !== attempt) fail()
    const previous = weakData(this.completedChunks, message)
    if (previous) {
      const view = weakData(completedPartials, previous)
      if (!view || view.attempt !== attempt.token || view.returnedMessage !== returned.message) fail()
      view.assertDataCurrent()
      return previous
    }
    const candidate: FunctionNativeCompletedPartialCandidate = Object.freeze({
      [completedPartialBrand]: true as const })
    let reading = false, failed = false
    const checkDataCurrent = () => {
      if (failed || this.closed || currentFunctionConversationNativeSseSource() !== source ||
        weakData(this.completedChunks, message) !== candidate || weakData(completedPartials, candidate) !== view ||
        selectActual(this, weakData(this.chunks, message)) !== attempt || call.owner !== this ||
        weakData(this.calls, call.token) !== call || mapData(this.byTask, call.taskId) !== call ||
        weakData(this.attempts, attempt.token) !== attempt || mapData(call.attempts, attempt.runId) !== attempt ||
        attempt.provider !== provider || !attempt.sealed || attempt.status !== "completed" ||
        call.returned !== returned || returned.attempt !== attempt ||
        selectActual(this, weakData(this.results, returned.message), call) !== attempt) fail()
      Reflect.apply(throwIfAborted, call.signal, [])
      const current = task(call.configurable)
      if (current.taskId !== call.taskId || current.namespace !== call.namespace ||
        current.read !== call.read ||
        own(call.configurable, "thread_id") !== this.runtime.binding.checkpointThreadId) fail()
    }
    const assertDataCurrent = () => {
      try { checkDataCurrent() }
      catch (error) { failed = true; throw error }
    }
    const view: FunctionNativeCompletedPartialView = Object.freeze({ runtime: this.runtime,
      call: call.token, attempt: attempt.token, chunk: message,
      returnedMessage: returned.message, uuid: attempt.uuid, policy: call.policy,
      signal: call.signal, source, configurable: call.configurable, assertDataCurrent,
      assertCurrent: () => {
        if (reading) { failed = true; fail() }
        reading = true
        try { assertDataCurrent(); this.assertCall(call); assertDataCurrent() }
        catch (error) { failed = true; throw error }
        finally { reading = false }
      } })
    // No callback precedes these exact private addresses and the first reading latch.
    Reflect.apply(nativeWeakSet, completedPartials, [candidate, view])
    Reflect.apply(nativeWeakSet, this.completedChunks, [message, candidate])
    assertDataCurrent()
    return candidate
  }
  completed(message: object): Readonly<AttemptView> | undefined {
    const attempt = selectActual(this, this.results.get(message))
    if (attempt) this.bindProvider(attempt, message)
    return attempt && this.view(attempt)
  }
  returned(configurable: FunctionConversationGraphRuntime["configurable"]):
    Readonly<AttemptView> & { readonly message: BaseMessage } {
    const facts = task(configurable), call = this.byTask.get(facts.taskId)
    if (!call || call.namespace !== facts.namespace || call.read !== facts.read ||
      !call.returned) fail()
    this.assertCall(call)
    return Object.freeze({ ...this.view(call.returned.attempt), message: call.returned.message })
  }
  seal(token: FunctionNativeModelCall): void {
    const call = this.calls.get(token)
    if (!call?.returned) fail()
    this.assertCall(call)
    call.returned.attempt.sealed = true
  }
  private bindProvider(attempt: Attempt, message: object): void {
    this.assertCall(attempt.call)
    if (types.isProxy(message)) fail()
    const descriptor = Object.getOwnPropertyDescriptor(message, "id")
    if (descriptor && !("value" in descriptor)) fail()
    const id: unknown = descriptor?.value
    if (id !== undefined && (typeof id !== "string" || !id)) fail()
    const sourceId = typeof id === "string" ? id : attempt.uuid
    if (attempt.provider) {
      if (attempt.provider.sourceId !== sourceId) fail()
      return
    }
    const result = this.runtime.database.exec(`SELECT MAX(COALESCE(provider_occurrence,1)) AS n
      FROM thread_messages WHERE thread_id=? AND role='assistant'
      AND COALESCE(provider_source_id,message_id)=?`, [this.runtime.destination.threadId, sourceId])[0]
    const prior: unknown = result?.values[0]?.[0] ?? 0
    if (typeof prior !== "number" || !Number.isSafeInteger(prior) || prior < 0) fail()
    const occurrence = Math.max(prior, this.providerOccurrences.get(sourceId) ?? 0) + 1
    if (!Number.isSafeInteger(occurrence)) fail()
    attempt.provider = Object.freeze({ sourceId, occurrence })
    this.providerOccurrences.set(sourceId, occurrence)
    this.assertCall(attempt.call)
  }
  close(): void { this.closed = true; this.byTask.clear(); this.providerOccurrences.clear() }
  static {
    const select = this.prototype.select
    selectActual = (owner, values, call) => Reflect.apply(select, owner, [values, call]) as
      Attempt | undefined
  }
}
