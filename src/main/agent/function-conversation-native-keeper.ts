import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { types } from "node:util"
import { nativeConversationFairness } from "./function-conversation-native-fairness"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { FunctionSessionAppendDoor, FunctionSessionAppendOrigin,
  FunctionSessionAppendResult } from "../../shared/mods/v2/session-append"
import type { FunctionConversationRow } from "../db/function-conversation-store"
import type { FunctionConversationTranscriptNativeCapture,
  FunctionConversationTranscriptProjection } from "../db/function-conversation-transcript"
import { FunctionConversationFinalExecutions,
  type FunctionNativeFinalExecutionReceipt } from "../db/function-conversation-final-execution"
import { readFunctionConversationNativeMutationGuard,
  type FunctionConversationTarget } from "../mods/v2/conversation-registry"
import type { FunctionSessionAppendCommitPlan, FunctionSessionAppendTicket }
  from "../mods/v2/session-append-ticket"
import { functionConversationCanonicalStamp } from "../checkpointer/function-conversation-checkpoint-membership"
import { FunctionConversationNativeRetainer, type FunctionNativeRetentionCandidate,
  type FunctionRetainedNativeMessage } from "./function-conversation-native-retainer"
import { FunctionConversationNativeRendering } from "./function-conversation-native-rendering"
import { FunctionNativeMessageProtector, type FunctionNativeProtectionPolicy,
  type FunctionNativeProtectionAdmission, type FunctionProtectedNativeMessage }
  from "./native-message-protector"
import { deserializeFunctionConversationNativeMessage,
  serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { readFunctionConversationNativeModelCurrent,
  readFunctionConversationNativeSharedToolCurrent } from "./native-model-current"
import { readFunctionConversationNativeInputCurrent } from "./function-conversation-native-input-retention"
import { readFunctionConversationNativeToolSideCurrent } from "./function-conversation-native-tool-side"

/** Installed by the actual graph factory. Guest/configuration authority is not a native owner. */
export interface FunctionConversationNativeKeeperRuntime {
  readonly owner: object
  readonly target: FunctionConversationTarget
  readonly destination: FunctionConversationTranscriptProjection
  readonly run: object
  readonly signal: AbortSignal
  assertCurrent(): void
  dispatch(ticket: FunctionSessionAppendTicket): Promise<FunctionSessionAppendResult>
  runMutation<T>(producer: object, occurrence: object,
    run: (signal: AbortSignal, assertCurrent: () => void) => Promise<T>): Promise<T>
}

/** A concrete producer address. It is never created from message role, JSON or a public stamp. */
export interface FunctionConversationNativeKeeperAdmission {
  readonly producer: object
  readonly occurrence: object
  readonly message: BaseMessage
  readonly door: Exclude<FunctionSessionAppendDoor, "note">
  readonly origin: FunctionSessionAppendOrigin
  readonly agentId?: string
  readonly signal: AbortSignal
  readonly policy: FunctionNativeProtectionPolicy
  readonly expiresAtNs?: bigint
  assertCurrent(): void
  seal(): void
  captureProjection(finalExecution?: (row: FunctionConversationRow) =>
    FunctionNativeFinalExecutionReceipt): Promise<FunctionConversationTranscriptNativeCapture>
  prepare(candidate: FunctionNativeRetentionCandidate,
    projection: FunctionConversationTranscriptNativeCapture,
    signal: AbortSignal, assertCurrent: () => void): Promise<FunctionSessionAppendCommitPlan>
  retainActualWork(): () => void
  assertExecutionFacts(original: BaseMessage, safe: BaseMessage): void
  inheritPresentation(original: BaseMessage, safe: BaseMessage): void
  /** Actual producer presentation receives only a result certified by this exact protector. */
  onProtected?(result: FunctionProtectedNativeMessage): void
}

function fail(code = "MODS_CONVERSATION_NATIVE_KEEPER_INVALID"): never {
  throw new ModFunctionError(code)
}
const nativeThen = Promise.prototype.then
const keeperBind = Function.prototype.bind, keeperWeakGet = WeakMap.prototype.get
const keeperWeakSet = WeakMap.prototype.set
const keeperSetHas = Set.prototype.has, keeperThrowIfAborted = AbortSignal.prototype.throwIfAborted
interface FixedFields {
  readonly prototype: object | null
  readonly fields: ReadonlyArray<readonly [PropertyKey, PropertyDescriptor]>
}
function fixedFields(value: object, keys?: readonly PropertyKey[]): FixedFields | undefined {
  if (types.isProxy(value)) return undefined
  const fields: Array<readonly [PropertyKey, PropertyDescriptor]> = []
  for (const key of keys ?? Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || !("value" in field)) return undefined
    fields.push([key, field])
  }
  return { prototype: Object.getPrototypeOf(value), fields }
}
function assertFixedFields(value: object, original: FixedFields): void {
  if (types.isProxy(value) || Object.getPrototypeOf(value) !== original.prototype) fail()
  for (const [key, field] of original.fields) {
    const current = Object.getOwnPropertyDescriptor(value, key)
    if (!current || !("value" in current) || current.value !== field.value ||
      current.enumerable !== field.enumerable || current.writable !== field.writable ||
      current.configurable !== field.configurable) fail()
  }
}
function synchronous(value: unknown): void {
  if (value === undefined) return
  if (value && typeof value === "object" && !types.isProxy(value) && types.isPromise(value) &&
    Object.getPrototypeOf(value) === Promise.prototype &&
    !Object.getOwnPropertyDescriptor(value, "constructor"))
    void nativeThen.call(value, undefined, () => undefined)
  fail("MODS_CONVERSATION_NATIVE_KEEPER_SYNC_REQUIRED")
}
function identity(value: unknown): asserts value is object {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
}
function deferred<T>() {
  let resolve: (value: T) => void = () => fail()
  let reject: (error: unknown) => void = () => fail()
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => { /* A source can close before the caller attaches. */ })
  return { promise, resolve, reject }
}
function sameDestination(runtime: FunctionConversationNativeKeeperRuntime): boolean {
  const a = runtime.target.ref, b = runtime.destination.conversation
  return a.logicalSessionId === b.logicalSessionId && a.conversationId === b.conversationId &&
    a.branchId === b.branchId && a.threadId === b.threadId && a.workspace === b.workspace &&
    a.kind === b.kind && a.checkpointNamespace === b.checkpointNamespace &&
    a.incarnation.token === b.incarnation.token &&
    a.incarnation.legacyCreatedAt === b.incarnation.legacyCreatedAt
}

interface Work {
  readonly admission: FunctionConversationNativeKeeperAdmission
  readonly onProtected?: (result: FunctionProtectedNativeMessage) => void
  readonly controller: AbortController
  readonly result: ReturnType<typeof deferred<FunctionRetainedNativeMessage>>
  readonly drain: ReturnType<typeof deferred<void>>
  readonly physical: Set<Promise<unknown>>
  retained: number
  finished: boolean
  uncertain: boolean
  reentered: boolean
  certified?: object
  output?: FunctionRetainedNativeMessage
}
interface WorkFacts {
  readonly work: Work
  readonly fields: FixedFields
  readonly admission: FunctionConversationNativeKeeperAdmission
  readonly promise: Promise<FunctionRetainedNativeMessage>
  readonly reentered: PropertyDescriptor
  readonly certified?: {
    readonly current: () => void
    readonly source: Readonly<{ assertTail(): void }>
    readonly sharedRuntime?: object
    readonly admissionFields: FixedFields
  }
  reading: boolean
  failed: boolean
}
const keeperWorkFacts = new WeakMap<Work, WorkFacts>()
function captureWorkFacts(work: Work, certified?: WorkFacts["certified"]): WorkFacts {
  const fields = fixedFields(work,
    ["admission", "controller", "result", "drain", "physical", "certified"])
  const reentered = Object.getOwnPropertyDescriptor(work, "reentered")
  if (!fields || !reentered || !("value" in reentered) || reentered.value !== false) fail()
  return { work, fields, admission: work.admission, promise: work.result.promise, reentered,
    certified, reading: false, failed: false }
}
function assertWorkFields(original: WorkFacts): void {
  assertFixedFields(original.work, original.fields)
  const field = Object.getOwnPropertyDescriptor(original.work, "reentered")
  if (!field || !("value" in field) || field.value !== false ||
    field.enumerable !== original.reentered.enumerable ||
    field.writable !== original.reentered.writable ||
    field.configurable !== original.reentered.configurable) fail()
}
// Completed occurrences are weakly remembered, while this pool counts only actual pending work.
const pending = new Set<Work>()
const keeperFacts = new WeakMap<FunctionConversationNativeKeeper, {
  readonly fields: FixedFields
  readonly once: WeakMap<object, Work>
  readonly works: Set<Work>
}>()

/** Isolated keeper factory. Production input/model/tool addresses are supplied by the native host. */
export class FunctionConversationNativeKeeper {
  private readonly once = new WeakMap<object, Work>()
  private readonly rendering = new FunctionConversationNativeRendering()
  private readonly executions: FunctionConversationFinalExecutions
  private readonly runtime: FunctionConversationNativeKeeperRuntime
  private readonly originalRuntime: FunctionConversationNativeKeeperRuntime
  private readonly originalCurrent?: () => void
  private readonly works = new Set<Work>()
  private closed = false

  constructor(runtime: FunctionConversationNativeKeeperRuntime,
    private readonly protector: FunctionNativeMessageProtector) {
    identity(runtime); identity(runtime.owner); identity(runtime.run); identity(runtime.target)
    identity(runtime.destination)
    this.originalRuntime = runtime
    const current = Object.getOwnPropertyDescriptor(runtime, "assertCurrent")
    this.originalCurrent = current && "value" in current && typeof current.value === "function" &&
      !types.isProxy(current.value) ? current.value as () => void : undefined
    this.runtime = Object.freeze({ ...runtime, assertCurrent: this.originalCurrent
      ? Reflect.apply(keeperBind, this.originalCurrent, [runtime]) as () => void
      : runtime.assertCurrent.bind(runtime),
      dispatch: runtime.dispatch.bind(runtime), runMutation: runtime.runMutation.bind(runtime) })
    this.executions = new FunctionConversationFinalExecutions(protector)
    const fields = fixedFields(this,
      ["runtime", "originalRuntime", "originalCurrent", "once", "works", "closed"])
    if (!fields) fail()
    Reflect.apply(keeperWeakSet, keeperFacts, [this, { fields, once: this.once, works: this.works }])
  }

  retain(admission: FunctionConversationNativeKeeperAdmission): Promise<FunctionRetainedNativeMessage> {
    identity(admission); identity(admission.occurrence); identity(admission.producer)
    const prior = this.once.get(admission.occurrence)
    if (prior) {
      const original = Reflect.apply(keeperWeakGet, keeperWorkFacts, [prior]) as WorkFacts | undefined
      if (!original) fail()
      try { assertWorkFields(original) } catch (error) { original.failed = true; throw error }
      if (original.admission !== admission) {
        original.failed = true
        Object.defineProperty(prior, "reentered", { ...original.reentered, value: true })
        fail()
      }
      return original.promise
    }
    if (this.closed || pending.size >= 256) fail("MODS_CONVERSATION_NATIVE_KEEPER_UNAVAILABLE")
    const protectedField = Object.getOwnPropertyDescriptor(admission, "onProtected")
    if (protectedField && (!("value" in protectedField) ||
      typeof protectedField.value !== "function" || types.isProxy(protectedField.value))) fail()
    const onProtected = protectedField?.value as
      ((result: FunctionProtectedNativeMessage) => void) | undefined
    const work: Work = { admission, ...(onProtected ? {
      onProtected: onProtected.bind(admission)
    } : {}), controller: new AbortController(), result: deferred(),
      drain: deferred(), physical: new Set(), retained: 0, finished: false,
      uncertain: false, reentered: false, certified: undefined }
    this.once.set(admission.occurrence, work)
    pending.add(work); this.works.add(work)
    Reflect.apply(keeperWeakSet, keeperWorkFacts, [work, captureWorkFacts(work)])
    // Reentrant native guard/seal sees the original admission, never a second core or retain.
    let actual: Promise<unknown>
    try {
      let certified: WorkFacts["certified"]
      const current = Object.getOwnPropertyDescriptor(admission, "assertCurrent")
      if (this.originalCurrent && current && "value" in current &&
        typeof current.value === "function" && !types.isProxy(current.value)) {
        const modelSource = readFunctionConversationNativeModelCurrent(current.value, this.originalRuntime)
        const sharedToolSource = readFunctionConversationNativeSharedToolCurrent(current.value,
          this.originalRuntime)
        const source = modelSource ?? sharedToolSource ??
          readFunctionConversationNativeToolSideCurrent(current.value, this.originalRuntime) ??
          readFunctionConversationNativeInputCurrent(current.value, this.originalRuntime,
            admission.producer, admission.occurrence)
        const admissionFields = source && fixedFields(admission)
        if (source && admissionFields) {
          work.certified = Object.freeze({})
          certified = { current: current.value as () => void, source, admissionFields,
            sharedRuntime: (modelSource ?? sharedToolSource)?.sharedRuntime }
        }
      }
      if (certified) Reflect.apply(keeperWeakSet, keeperWorkFacts,
        [work, captureWorkFacts(work, certified)])
      actual = this.runtime.runMutation(admission.producer, admission.occurrence,
        (signal, guard) => this.run(work, signal, guard))
    } catch (error) {
      work.result.reject(error); work.finished = true; this.complete(work)
      return work.result.promise
    }
    void actual.then(() => {
      this.complete(work)
      if (!work.output) work.result.reject(new ModFunctionError("MODS_CONVERSATION_NATIVE_KEEPER_INVALID"))
      else work.result.resolve(work.output)
    }, error => {
      work.result.reject(error); work.finished = true; this.complete(work)
    })
    return work.result.promise
  }

  private guard(work: Work, signal: AbortSignal, mutationGuard: () => void): void {
    const originalWork = Reflect.apply(keeperWeakGet, keeperWorkFacts, [work]) as WorkFacts | undefined
    if (!originalWork) fail()
    try {
      assertWorkFields(originalWork)
      if (originalWork.failed) fail("MODS_CONVERSATION_NATIVE_KEEPER_UNAVAILABLE")
      const certified = originalWork.certified, admission = originalWork.admission
      if (certified) {
        if (originalWork.reading) fail("MODS_CONVERSATION_NATIVE_KEEPER_UNAVAILABLE")
        originalWork.reading = true
        try {
          const original = Reflect.apply(keeperWeakGet, keeperFacts, [this]) as
            ReturnType<typeof keeperFacts.get>
          if (!original) fail()
          assertFixedFields(this, original.fields)
          assertFixedFields(admission, certified.admissionFields)
          const relation = readFunctionConversationNativeMutationGuard(mutationGuard,
            this.originalRuntime, admission.producer, admission.occurrence)
          if (relation) {
            Reflect.apply(keeperThrowIfAborted, signal, [])
            const destinationCurrent = !types.isProxy(this.runtime.destination)
              ? Object.getOwnPropertyDescriptor(this.runtime.destination, "assertCurrent") : undefined
            if (certified.sharedRuntime === this.originalRuntime && destinationCurrent &&
              "value" in destinationCurrent && destinationCurrent.value === this.originalCurrent) {
              // The target can run host callbacks; the genuine shared policy checks fresh authority last.
              synchronous(this.runtime.target.assertCurrent())
              synchronous(certified.current())
            } else {
              synchronous(mutationGuard()); synchronous(certified.current())
              synchronous(this.runtime.target.assertCurrent())
              synchronous(this.runtime.destination.assertCurrent())
            }
            if (!sameDestination(this.runtime)) fail()
            relation.assertTail()
            certified.source.assertTail()
            assertFixedFields(this, original.fields)
            assertFixedFields(admission, certified.admissionFields)
            assertWorkFields(originalWork)
            if (this.closed || originalWork.failed ||
              Reflect.apply(keeperWeakGet, original.once, [admission.occurrence]) !== work ||
              Reflect.apply(keeperSetHas, original.works, [work]) !== true ||
              Reflect.apply(keeperSetHas, pending, [work]) !== true) fail()
            Reflect.apply(keeperThrowIfAborted, signal, [])
            return
          }
        } finally { originalWork.reading = false }
      }
      if (this.closed) fail("MODS_CONVERSATION_NATIVE_KEEPER_UNAVAILABLE")
      signal.throwIfAborted()
      synchronous(this.runtime.assertCurrent()); synchronous(mutationGuard())
      synchronous(admission.assertCurrent()); synchronous(this.runtime.target.assertCurrent())
      synchronous(this.runtime.destination.assertCurrent())
      if (!sameDestination(this.runtime)) fail()
      assertWorkFields(originalWork)
      if (originalWork.failed) fail("MODS_CONVERSATION_NATIVE_KEEPER_UNAVAILABLE")
    } catch (error) { originalWork.failed = true; throw error }
  }

  private retainWork(work: Work): () => void {
    work.retained++
    let release: unknown
    try { release = work.admission.retainActualWork() }
    catch (error) { work.uncertain = true; throw error }
    if (typeof release !== "function" || types.isProxy(release)) {
      work.uncertain = true
      // Observe only an actual native Promise; never call a factory's then/getter.
      synchronous(release)
      fail()
    }
    const actualRelease = release
    let called = false
    return () => {
      if (called) fail()
      called = true
      try { synchronous(actualRelease()); work.retained-- }
      catch (error) { work.uncertain = true; throw error }
      if (work.finished) this.complete(work)
    }
  }

  private observe<T>(work: Work, value: Promise<T>): Promise<T> {
    work.physical.add(value)
    void value.then(() => { work.physical.delete(value) }, () => { work.physical.delete(value) })
    return value
  }

  private async run(work: Work, mutationSignal: AbortSignal, mutationGuard: () => void): Promise<void> {
    const admission = work.admission
    const signal = AbortSignal.any([mutationSignal, this.runtime.signal, this.runtime.target.signal,
      admission.signal, work.controller.signal])
    const guard = () => this.guard(work, signal, mutationGuard)
    const yieldPhase = nativeConversationFairness(signal, guard)
    const abort = () => work.result.reject(signal.reason ?? new ModFunctionError("MODS_CANCELLED"))
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    const results = new WeakMap<BaseMessage, FunctionProtectedNativeMessage>()
    const finalReceipts = new Map<string, FunctionNativeFinalExecutionReceipt>()
    let projection: FunctionConversationTranscriptNativeCapture | undefined
    let originalExecution: ReturnType<FunctionConversationFinalExecutions["capture"]> | undefined
    const protect = (message: BaseMessage): Promise<FunctionProtectedNativeMessage> => {
      guard()
      const existing = results.get(message)
      if (existing) {
        this.protector.assertResult(existing.receipt, message, admission.producer)
        return Promise.resolve(existing)
      }
      const input: FunctionNativeProtectionAdmission = { message, producer: admission.producer,
        signal, policy: admission.policy, expiresAtNs: admission.expiresAtNs, assertCurrent: guard,
        retainActualWork: () => this.retainWork(work),
        assertExecutionFacts: admission.assertExecutionFacts.bind(admission),
        inheritPresentation: (raw, safe) => {
          synchronous(admission.inheritPresentation(raw, safe))
          this.rendering.inheritPresentation(raw, safe)
        } }
      // Raw native data is captured here before any codec or Retainer constructor.
      const policy = input.policy
      const protectedField = !types.isProxy(policy)
        ? Object.getOwnPropertyDescriptor(policy, "protected") : undefined
      const facts = Reflect.apply(keeperWeakGet, keeperWorkFacts, [work]) as WorkFacts | undefined
      const fixedProtected = !!facts?.certified && !!protectedField &&
        "value" in protectedField && protectedField.value === true &&
        protectedField.writable === false && protectedField.configurable === false
      const capture = this.protector.capture(input)
      return this.observe(work, this.protector.protect(capture).then(result => {
        guard()
        if (fixedProtected)
          this.protector.assertProtected(result.receipt, result.message, admission.producer)
        else {
          this.protector.assertResult(result.receipt, result.message, admission.producer)
          if (admission.policy.protected)
            this.protector.assertProtected(result.receipt, result.message, admission.producer)
        }
        if (work.onProtected) {
          synchronous(work.onProtected(result))
          guard()
          if (fixedProtected)
            this.protector.assertProtected(result.receipt, result.message, admission.producer)
          else {
            this.protector.assertResult(result.receipt, result.message, admission.producer)
            if (admission.policy.protected)
              this.protector.assertProtected(result.receipt, result.message, admission.producer)
          }
        }
        results.set(result.message, result)
        return result
      }))
    }
    try {
      guard(); synchronous(admission.seal()); guard()
      // capture() is synchronous in protect(): source sealing and typed capture precede flush.
      const first = protect(admission.message)
      const captured = this.observe(work, admission.captureProjection(AIMessage.isInstance(admission.message)
        ? row => {
          guard()
          const receipt = finalReceipts.get(row.nativePayload)
          if (!receipt) fail("MODS_CONVERSATION_FINAL_EXECUTION_INVALID")
          return receipt
        } : undefined))
      const [safe, actualProjection] = await Promise.all([first, captured])
      await yieldPhase()
      projection = actualProjection
      guard()
      if (AIMessage.isInstance(safe.message)) {
        originalExecution = this.executions.capture({ producer: admission.producer, run: this.runtime.run,
          occurrence: admission.occurrence, target: this.runtime.target, signal, assertCurrent: guard }, safe)
        finalReceipts.set(serializeFunctionConversationNativeMessage(safe.message),
          this.executions.bind(originalExecution, safe))
      }
      const retainer = new FunctionConversationNativeRetainer({ message: safe.message,
        target: this.runtime.target, producer: admission.producer, signal, door: admission.door,
        origin: admission.origin, agentId: admission.agentId, assertCurrent: guard,
        host: {
          captureProjection: () => { guard(); return actualProjection },
          protectNative: async message => {
            const result = await protect(message)
            guard()
            if (originalExecution) finalReceipts.set(serializeFunctionConversationNativeMessage(result.message),
              this.executions.bind(originalExecution, result))
            return result.message
          },
          project: message => this.rendering.project(message),
          apply: (message, rendering) => this.rendering.apply(message, rendering),
          dispatch: ticket => this.runtime.dispatch(ticket),
          prepare: async (candidate, candidateSignal, candidateGuard) => {
            await yieldPhase()
            candidateSignal.throwIfAborted(); candidateGuard()
            if (!projection || candidate.projectionOwner !== projection ||
              candidate.target !== this.runtime.target || candidate.producer !== admission.producer) fail()
            const result = results.get(candidate.native)
            if (!result) fail()
            this.protector.assertResult(result.receipt, candidate.native, admission.producer)
            const plan = await admission.prepare(candidate, projection, candidateSignal, candidateGuard)
            return plan
          }
        } })
      const retained = await retainer.retain()
      guard()
      const graphMessage = deserializeFunctionConversationNativeMessage(retained.row.nativePayload)
      if (Object.hasOwn(graphMessage.additional_kwargs, "function_row") ||
        Object.hasOwn(graphMessage.additional_kwargs, "function_row_invalid")) fail()
      graphMessage.additional_kwargs = { ...graphMessage.additional_kwargs,
        function_row: functionConversationCanonicalStamp(this.runtime.target.ref, retained.row) }
      if (serializeFunctionConversationNativeMessage(graphMessage) !== retained.row.nativePayload) fail()
      guard()
      work.output = { ...retained, message: graphMessage }
    } catch (error) {
      work.result.reject(error)
      work.controller.abort(error)
    } finally {
      signal.removeEventListener("abort", abort)
      // A strict flush or Worker can ignore cancellation. The Registry callback stays occupied.
      await Promise.allSettled([...work.physical])
      work.finished = true
      if (work.uncertain) {
        work.drain.reject(new ModFunctionError("MODS_NATIVE_PROTECTION_DRAIN_UNKNOWN"))
        await new Promise<never>(() => { /* Unknown physical work cannot release mutation credit. */ })
      }
      if (work.retained) await work.drain.promise
    }
  }

  private complete(work: Work): void {
    if (!work.finished || work.retained || work.uncertain || work.physical.size) return
    pending.delete(work); this.works.delete(work)
    work.drain.resolve()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const work of this.works) work.controller.abort(new ModFunctionError("MODS_CANCELLED"))
    this.executions.close()
    this.protector.close()
  }

  async whenDrained(): Promise<void> {
    await this.protector.whenDrained()
    await Promise.all([...this.works].map(work => work.drain.promise))
  }
}
