import { randomUUID } from "node:crypto"
import { types } from "node:util"
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage,
  type BaseMessage } from "@langchain/core/messages"
import { mergeConfigs, type RunnableConfig } from "@langchain/core/runnables"
import { createMiddleware } from "langchain"
import { CompiledStateGraph } from "@langchain/langgraph"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import { readFunctionConversationNativePolicySource,
  readFunctionConversationNativeSharedPolicySource,
  type FunctionConversationNativePolicySource } from "../mods/native-conversation-policy-source"
import type { FunctionConversationStore } from "../db/function-conversation-store"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { FunctionConversationNativeCalls, readFunctionNativeModelPartial,
  readFunctionNativeCompletedPartial, selectFunctionNativeCompletedPartial,
  type FunctionNativeCompletedPartialCandidate,
  type FunctionNativeCompletedPartialView, type FunctionNativeModelAttempt }
  from "./function-conversation-native-calls"
import { createFunctionConversationNativeAdoption } from "./function-conversation-native-adoption"
import { createFunctionConversationNativeInputRetention } from "./function-conversation-native-input-retention"
import type { FunctionConversationNativeInputReceipt } from "./function-conversation-native-input"
import { assertFunctionConversationNativeToolsBinding, installFunctionConversationNativeTools,
  type FunctionConversationNativeTools } from "./function-conversation-native-tools"
import { readCurrentFunctionConversationSharedNativeDomain,
  type FunctionConversationSharedNativeFactory } from "./function-conversation-shared-native-domain"
import { FunctionConversationNativeKeeper } from "./function-conversation-native-keeper"
import { FunctionNativeMessageProtector } from "./native-message-protector"
import { createNativeConversationStreamProjection,
  type NativeConversationStreamProjectionSharedSource } from "./native-conversation-stream-projection"
import { captureNativeMessage, captureNativeMessageForOccurrence,
  captureCompletedNativeNodeData, capturePartialNativeModelData,
  captureNativeCompletedPartialData, captureNativeCompletedModelReturnData, captureNativePartialMetadata,
  constructCapturedNativeMessage } from "./native-message-capture"
import { selectFunctionNativeStreamDiagnostic, readFunctionNativeSuccessfulWriter,
  currentFunctionConversationNativeSseSource,
  type FunctionNativeStreamDiagnostic,
  type FunctionNativeStreamDiagnosticView, type FunctionConversationNativeSseSource }
  from "./function-conversation-native-lifetime"
import { createNativeSseDiagnosticOwner, nativeSseDiagnosticFailure, readNativeSseCompletedDiagnostic,
  type FunctionNativeProtectedDiagnostic }
  from "./native-sse-diagnostic"
import { captureNativeMessageForCompletedOccurrence } from "./completed-native-message-capture"
import { captureFunctionConversationNativeModelCurrent,
  captureFunctionConversationNativeSharedToolCurrent } from "./native-model-current"
import { projectFunctionConversationNativePartial, readFunctionConversationNativePartialCompletion }
  from "./partial-native-message-capture"
import { captureFunctionConversationNativeToolHuman, readFunctionConversationNativeToolHuman }
  from "./function-conversation-native-tool-human"
import { captureFunctionConversationNativeToolSide, readFunctionConversationNativeToolSide,
  captureFunctionConversationNativeToolSideCurrent }
  from "./function-conversation-native-tool-side"
import { captureFunctionNativeToolSideProjection } from
  "../db/function-conversation-native-tool-side-projection"
import { captureFunctionConversationNativeToolHumanPresentation,
  functionConversationNativeHumanProjection, registerFunctionConversationNativeHumanProtection }
  from "./function-conversation-native-human-presentation"
import { installFunctionConversationNativeNode, readFunctionConversationNativeNodeSlot,
  captureFunctionConversationNativeNodeModelName,
  captureCurrentFunctionConversationNativeNodeWorkModelName,
  readFunctionConversationNativeNodeWorkModelName,
  assertFunctionConversationNativeNodeSlotStructure, assertFunctionConversationNativeNodeInstallation,
  type FunctionConversationNativeNodeModelName,
  type FunctionConversationNativeNodeSlot } from "./function-conversation-native-node"
import { MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY, MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY }
  from "../../shared/message-role-collision"

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_NATIVE_SOURCE_INVALID") }
const nativeWeakGet = WeakMap.prototype.get, nativeWeakSet = WeakMap.prototype.set
const nativeWeakHas = WeakMap.prototype.has, nativeWeakSetHas = WeakSet.prototype.has
const nativeMapGet = Map.prototype.get, nativeMapSet = Map.prototype.set
const nativeMapHas = Map.prototype.has, nativeMapDelete = Map.prototype.delete
const nativeMapValues = Map.prototype.values
const nativeMapNext = Object.getPrototypeOf(new Map().values()).next as
  (this: Iterator<unknown>) => IteratorResult<unknown>
function weakData<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return Reflect.apply(nativeWeakGet, map, [key]) as V | undefined
}
function writeWeak<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
  Reflect.apply(nativeWeakSet, map, [key, value])
}
function mapData<K, V>(map: Map<K, V>, key: K): V | undefined {
  return Reflect.apply(nativeMapGet, map, [key]) as V | undefined
}
function writeMap<K, V>(map: Map<K, V>, key: K, value: V): void {
  Reflect.apply(nativeMapSet, map, [key, value])
}
function mapValues<K, V>(map: Map<K, V>): V[] {
  const iterator = Reflect.apply(nativeMapValues, map, []) as Iterator<V>, output: V[] = []
  while (true) {
    const next = Reflect.apply(nativeMapNext, iterator, []) as IteratorResult<V>
    if (next.done) return output
    output.push(next.value)
  }
}

function nativeClass(value: unknown): object {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  return Object.getPrototypeOf(value) as object
}

interface NativeGraphInstallation {
  readonly graph: object
  readonly nodes: Array<ReturnType<typeof installFunctionConversationNativeNode>>
  ledger?: FunctionConversationNativeTools
  policy?: FunctionConversationNativePolicySource
  phase: "installing" | "ready" | "failed"
}
export interface FunctionNativeDerivedOperation {
  assertCurrent(): void
  install(graph: object): void
  publish(graph: object): void
  dispose(): void
}
export interface FunctionNativeDerivedInstallation { begin(): FunctionNativeDerivedOperation }
const derivedHosts = new WeakMap<object, {
  readonly runtime: object
  read(graph: object): FunctionNativeDerivedInstallation | undefined
  assertInstalled(graph: object): void
}>()

const deferredPartialBrand = Symbol("native-sse-deferred-partial")
const partialOmissionBrand = Symbol("native-sse-partial-omission")
export interface FunctionNativeSseDeferredPartial { readonly [deferredPartialBrand]: true }
export interface FunctionNativeSsePartialOmission { readonly [partialOmissionBrand]: true }
const deferredPartials = new WeakMap<FunctionNativeSseDeferredPartial, {
  readonly source: FunctionConversationNativeSseSource
  assertDataCurrent(): void
}>()
const partialOmissions = new WeakMap<FunctionNativeSsePartialOmission, {
  readonly source: FunctionConversationNativeSseSource
  assertDataCurrent(): void
}>()

/** Private disposition only; no safe DTO or permission to publish a partial is returned. */
export function readFunctionNativeSseDeferredPartial(token: FunctionNativeSseDeferredPartial,
  source: FunctionConversationNativeSseSource): void {
  const original = weakData(deferredPartials, token)
  if (!original || original.source !== source) fail()
  original.assertDataCurrent()
}

export function readFunctionNativeSsePartialOmission(token: FunctionNativeSsePartialOmission,
  source: FunctionConversationNativeSseSource): void {
  const original = weakData(partialOmissions, token)
  if (!original || original.source !== source) fail()
  original.assertDataCurrent()
}

/** Only the actual Host's successful base installation can supply this same-runtime seam. */
export function readFunctionConversationNativeDerivedInstallation(host: object, graph: object,
  runtime: object): FunctionNativeDerivedInstallation | undefined {
  const actual = weakData(derivedHosts, host)
  return actual?.runtime === runtime ? actual.read(graph) : undefined
}

/** A genuine Host must finish its exact installation before any graph checkpoint can start. */
export function assertFunctionConversationNativeHostInstallation(host: object, graph: object,
  runtime: object): void {
  const actual = weakData(derivedHosts, host)
  if (!actual) return
  if (actual.runtime !== runtime) fail()
  actual.assertInstalled(graph)
}

/** One real createAgent factory owns callbacks, completed node slots and native adoption. */
export function createFunctionConversationNativeHost(input: {
  readonly runtime: FunctionNativeConversationRuntime
  readonly store: FunctionConversationStore
  readonly agentId: string
  readonly model: string
  readonly nativeInput?: FunctionConversationNativeInputReceipt
  readonly sharedSource?: NativeConversationStreamProjectionSharedSource
  flush(uuid: string): void | Promise<void>
  completed?(message: AIMessage): void
}) {
  const runtime = input.runtime, store = input.store
  const flush = input.flush.bind(input), completed = input.completed?.bind(input)
  const calls = new FunctionConversationNativeCalls(runtime)
  const projection = createNativeConversationStreamProjection({ runtime, store,
    sharedSource: input.sharedSource })
  const nativeInput = createFunctionConversationNativeInputRetention({
    source: input.nativeInput, runtime, store, agentId: input.agentId, flush,
    register: projection.register
  })
  const producer = Object.freeze({})
  const keepers = new WeakMap<FunctionConversationNativeNodeSlot, FunctionConversationNativeKeeper>()
  const finalized = new WeakMap<FunctionConversationNativeNodeSlot, {
    readonly message: BaseMessage
    readonly signal: AbortSignal
    readonly expiresAtNs: bigint
  }>()
  const modelAcks = new WeakMap<FunctionNativeModelAttempt, {
    readonly slot: FunctionConversationNativeNodeSlot
    readonly returnedMessage: BaseMessage
    readonly returnedData: ReturnType<typeof captureNativeCompletedModelReturnData>
    readonly source: FunctionConversationNativeSseSource
    readonly message: BaseMessage
    readonly signal: AbortSignal
    readonly expiresAtNs: bigint
  }>()
  const modelNames = new WeakMap<FunctionNativeModelAttempt, {
    readonly returnedMessage: BaseMessage
    readonly source: FunctionConversationNativeSseSource
    readonly proof: FunctionConversationNativeNodeModelName
  }>()
  interface DeferredRecord {
    readonly token: FunctionNativeSseDeferredPartial
    readonly candidate: FunctionNativeCompletedPartialCandidate
    readonly view: FunctionNativeStreamDiagnosticView
    readonly receipt?: FunctionNativeProtectedDiagnostic
    readonly projected?: readonly unknown[]
    completed?: FunctionNativeCompletedPartialView
    policySource?: FunctionConversationNativePolicySource
    raw?: ReturnType<typeof captureNativeCompletedPartialData>
    readonly extraTails: Array<() => void>
    ready: boolean
    reading: boolean
    failed: boolean
    omission?: FunctionNativeSsePartialOmission
    assertDataCurrent(): void
  }
  interface DeferredSource {
    readonly records: Map<FunctionNativeModelAttempt, DeferredRecord>
    readonly settled: WeakMap<FunctionNativeModelAttempt, DeferredRecord>
    readonly tokens: WeakMap<FunctionNativeStreamDiagnostic, DeferredRecord>
    count: number
    closed: boolean
    failed: boolean
  }
  const deferredSources = new Map<FunctionConversationNativeSseSource, DeferredSource>()
  const active = new Set<FunctionConversationNativeKeeper>()
  const nativeNodes: Array<ReturnType<typeof installFunctionConversationNativeNode>> = []
  const installedGraphs = new WeakSet<object>()
  const graphInstallations = new WeakMap<object, NativeGraphInstallation>()
  const diagnosticOwners = new Map<FunctionConversationNativeSseSource,
    ReturnType<typeof createNativeSseDiagnosticOwner>>()
  const diagnosticMessages = new WeakMap<FunctionNativeStreamDiagnosticView, {
    full(): void; tail(): void
    readonly originalDigest?: string
    completed?(candidate: FunctionNativeCompletedPartialCandidate,
      name?: FunctionConversationNativeNodeModelName): void
  }>()
  const nativeTools = new WeakMap<object, FunctionConversationNativeTools>()
  const toolLedgers = new Set<FunctionConversationNativeTools>()
  const sharedToolLedgers = new Set<FunctionConversationNativeTools>()
  const toolOccurrences = new Map<string, number>()
  const sourceLatch = { failed: false }
  let deriving: { failed: boolean; published: boolean; graph?: object } | undefined
  let closed = false
  const assertCurrent = () => { if (closed) fail(); runtime.assertCurrent() }
  const throwIfDiagnosticAborted = AbortSignal.prototype.throwIfAborted
  const diagnosticBoundData = (view: FunctionNativeStreamDiagnosticView) => {
    if (closed || view.runtime !== runtime || !Reflect.apply(nativeWeakSetHas, installedGraphs, [view.graph])) fail()
    Reflect.apply(throwIfDiagnosticAborted, view.signal, [])
    if (process.hrtime.bigint() >= view.expiresAtNs) fail()
    weakData(diagnosticMessages, view)?.tail()
  }
  const diagnosticBound = (view: FunctionNativeStreamDiagnosticView) => {
    diagnosticBoundData(view)
    assertCurrent()
    let proof = weakData(diagnosticMessages, view)
    if (!proof) {
      const bounded = () => {
        Reflect.apply(throwIfDiagnosticAborted, view.signal, [])
        if (closed || process.hrtime.bigint() >= view.expiresAtNs) fail()
      }
      if (nativeClass(view.message) === AIMessageChunk.prototype) {
        const token = calls.capturePartial(view.message)
        if (!token) fail()
        const original = readFunctionNativeModelPartial(token)
        if (original.sseSource !== view.source || original.message !== view.message) fail()
        const copied = capturePartialNativeModelData(token, bounded)
        proof = Object.freeze({ full: original.assertCurrent, originalDigest: copied.originalDigest,
          completed: copied.assertCompletedDataCurrent,
          tail() {
          original.assertTail()
          copied.assertDataCurrent()
          bounded()
        } })
      } else {
        // A Source identity does not make an unknown/foreign Base an owned canonical message.
        const owned = projection.captureOwnedMessage(view.message as BaseMessage)
        const copied = captureNativeMessage(view.message as BaseMessage, bounded)
        proof = Object.freeze({ full() {
          owned.assertCurrent()
        }, tail() {
          owned.assertDataCurrent()
          if (captureNativeMessage(view.message as BaseMessage, bounded).digest !== copied.digest)
            fail()
          bounded()
        } })
      }
      if (Reflect.apply(nativeWeakHas, diagnosticMessages, [view])) fail()
      writeWeak(diagnosticMessages, view, proof)
    }
    proof.full()
    diagnosticBoundData(view)
  }
  const prepareSseDiagnostic = async (token: FunctionNativeStreamDiagnostic):
    Promise<FunctionNativeProtectedDiagnostic> => {
    try {
      // Selection is pure; the owner's shared reservation precedes the first full callback.
      const view = selectFunctionNativeStreamDiagnostic(token)
      if (closed || view.runtime !== runtime || !Reflect.apply(nativeWeakSetHas, installedGraphs, [view.graph])) fail()
      let owner = mapData(diagnosticOwners, view.source)
      if (!owner) {
        owner = createNativeSseDiagnosticOwner({ runtime, source: view.source,
          assertBound: diagnosticBound, assertBoundData: diagnosticBoundData })
        writeMap(diagnosticOwners, view.source, owner)
      }
      try { return await owner.prepare(token) }
      finally { await owner.whenDrained() }
    } catch (error) { throw nativeSseDiagnosticFailure(error) }
  }
  const deferCompletedSsePartial = (token: FunctionNativeStreamDiagnostic,
    receipt?: FunctionNativeProtectedDiagnostic, projectedTuple?: readonly unknown[]):
    FunctionNativeSseDeferredPartial | undefined => {
    try {
      let projected: readonly unknown[] | undefined
      if (projectedTuple !== undefined) {
        if (types.isProxy(projectedTuple) || !Array.isArray(projectedTuple) ||
          Object.getPrototypeOf(projectedTuple) !== Array.prototype) fail()
        const length = Object.getOwnPropertyDescriptor(projectedTuple, "length")
        const first = Object.getOwnPropertyDescriptor(projectedTuple, "0")
        const second = Object.getOwnPropertyDescriptor(projectedTuple, "1")
        if (!length || !("value" in length) || length.value !== 2 ||
          Reflect.ownKeys(projectedTuple).length !== 3 || !first || !("value" in first) ||
          !second || !("value" in second)) fail()
        projected = Object.freeze([first.value, second.value])
      }
      const view = selectFunctionNativeStreamDiagnostic(token)
      if (closed || view.runtime !== runtime || !Reflect.apply(nativeWeakSetHas, installedGraphs, [view.graph])) fail()
      const candidate = calls.selectCompletedPartial(view.message, view.source)
      if (!candidate) return undefined
      let book = mapData(deferredSources, view.source)
      if (!book) {
        book = { records: new Map(), settled: new WeakMap(), tokens: new WeakMap(), count: 0,
          closed: false, failed: false }
        writeMap(deferredSources, view.source, book)
      }
      if (book.closed || book.failed) fail()
      const previous = weakData(book.tokens, token)
      if (previous) {
        if (!previous.ready || previous.reading) { previous.failed = true; book.failed = true; fail() }
        if (previous.receipt !== receipt || previous.projected?.[0] !== projected?.[0] ||
          previous.projected?.[1] !== projected?.[1]) fail()
        previous.assertDataCurrent()
        return previous.token
      }
      const selected = selectFunctionNativeCompletedPartial(candidate)
      if (book.count >= 1_000_000 ||
        !Reflect.apply(nativeMapHas, book.records, [selected.attempt]) && !Reflect.apply(nativeWeakHas, book.settled, [selected.attempt]) &&
          book.records.size >= 256) fail()
      book.count++
      const pending: FunctionNativeSseDeferredPartial = Object.freeze({
        [deferredPartialBrand]: true as const })
      const currentBook = book
      const bounded = () => {
        Reflect.apply(throwIfDiagnosticAborted, view.signal, [])
        if (closed || currentBook.closed || currentBook.failed ||
          mapData(deferredSources, view.source) !== currentBook ||
          process.hrtime.bigint() >= view.expiresAtNs) fail()
      }
      const record: DeferredRecord = { token: pending, candidate, view, receipt, projected, ready: false,
        reading: true, failed: false, extraTails: [], assertDataCurrent() {
          try {
            bounded()
            if (!record.ready || record.failed || !record.completed || !record.raw ||
              !record.policySource ||
              weakData(currentBook.tokens, token) !== record) fail()
            view.assertDataCurrent()
            record.completed.assertDataCurrent()
            record.raw.assertDataCurrent()
            for (let index = 0; index < record.extraTails.length; index++) record.extraTails[index]()
            record.policySource.assertTail()
            bounded()
          } catch (error) { record.failed = true; currentBook.failed = true; throw error }
        } }
      // First real source callback comes after this immutable token and sticky admission latch.
      writeWeak(currentBook.tokens, token, record)
      writeWeak(deferredPartials, pending, { source: view.source, assertDataCurrent: record.assertDataCurrent })
      try {
        const completed = readFunctionNativeCompletedPartial(candidate, runtime, view.source)
        if (completed.chunk !== view.message) fail()
        record.completed = completed
        const policySource = readFunctionConversationNativePolicySource(completed.policy, runtime)
        if (!policySource) fail()
        record.policySource = policySource
        const old = mapData(currentBook.records, completed.attempt) ??
          weakData(currentBook.settled, completed.attempt)
        if (old && (old.failed || old.candidate === candidate && old.view === view)) fail()
        if (!old) writeMap(currentBook.records, completed.attempt, record)
        const raw = captureNativeCompletedPartialData(candidate, bounded)
        const nameRecord = weakData(modelNames, completed.attempt)
        const name = completed.returnedMessage === completed.chunk ? nameRecord?.proof : undefined
        if (nameRecord && (nameRecord.returnedMessage !== completed.returnedMessage ||
          nameRecord.source !== view.source)) fail()
        const originalProof = weakData(diagnosticMessages, view)
        if (originalProof?.completed) {
          originalProof.completed(candidate, name)
          record.extraTails.push(() => originalProof.completed!(candidate, name))
        } else if (originalProof?.originalDigest !== undefined &&
          originalProof.originalDigest !== raw.originalDigest) fail()
        record.raw = raw
        const metadata = captureNativePartialMetadata(view.metadata, bounded)
        record.extraTails.push(() => {
          if (captureNativePartialMetadata(view.metadata, bounded).digest !== metadata.digest) fail()
        })
        view.assertCurrent()
        completed.assertCurrent()
        policySource.assertCurrent()
        if (receipt) record.extraTails.push(readNativeSseCompletedDiagnostic(receipt, token,
          candidate, view.source).assertDataCurrent)
        if (projected) {
          record.extraTails.push(readFunctionConversationNativePartialCompletion(
            projected[0], projected[1], candidate, name).assertDataCurrent)
        }
        record.ready = true
        record.assertDataCurrent()
        // One first observation per Attempt is retained. Later queued frames are checked now,
        // do not replace that baseline, and have no raw/wire body list in the Source book.
        if (old) {
          old.assertDataCurrent()
          writeWeak(currentBook.tokens, token, old)
          return old.token
        }
        return pending
      } catch (error) { record.failed = true; currentBook.failed = true; throw error }
      finally { record.reading = false }
    } catch (error) { throw nativeSseDiagnosticFailure(error) }
  }
  const confirmSsePartialOmissions = (source: FunctionConversationNativeSseSource,
    finished = false): readonly FunctionNativeSsePartialOmission[] => {
    try {
      const book = mapData(deferredSources, source)
      if (!book) return []
      if (closed || book.closed || book.failed) fail()
      const ready: Array<{ record: DeferredRecord;
        ack: NonNullable<ReturnType<typeof modelAcks.get>>;
        writer: NonNullable<ReturnType<typeof readFunctionNativeSuccessfulWriter>>;
        owned: ReturnType<typeof projection.captureOwnedMessage> }> = []
      const iterator = Reflect.apply(nativeMapValues, book.records, []) as Iterator<DeferredRecord>
      while (true) {
        const next = Reflect.apply(nativeMapNext, iterator, []) as IteratorResult<DeferredRecord>
        if (next.done) break
        const record = next.value
        if (record.omission) continue
        if (record.reading || record.failed || !record.completed) { book.failed = true; fail() }
        record.reading = true
        try {
          record.assertDataCurrent()
          const completed = record.completed
          completed.assertCurrent()
          record.view.assertCurrent()
          const ack = weakData(modelAcks, completed.attempt)
          if (!ack) { if (finished) fail(); continue }
          if (ack.returnedMessage !== completed.returnedMessage || ack.source !== source) fail()
          ack.returnedData.assertDataCurrent()
          const writer = readFunctionNativeSuccessfulWriter(source, ack.slot, ack.message)
          if (!writer) { if (finished) fail(); continue }
          writer.assertCurrent()
          const owned = projection.captureOwnedMessage(ack.message)
          owned.assertCurrent()
          record.assertDataCurrent()
          ready.push({ record, ack, writer, owned })
        } catch (error) { record.failed = true; book.failed = true; throw error }
        finally { record.reading = false }
      }
      // No source callback follows this entire batch's last full check. Every own new ACK
      // receives a fresh complete 23-column/presentation/ledger A/B, then all pure tails.
      for (const { ack } of ready) projection.assertFinalizedData(ack.message)
      for (const { record, ack, writer, owned } of ready) {
        record.assertDataCurrent()
        writer.assertDataCurrent()
        owned.assertDataCurrent()
        ack.returnedData.assertDataCurrent()
        Reflect.apply(throwIfDiagnosticAborted, ack.signal, [])
        if (closed || book.closed || book.failed || weakData(modelAcks, record.completed!.attempt) !== ack ||
          process.hrtime.bigint() >= ack.expiresAtNs) fail()
      }
      const output: FunctionNativeSsePartialOmission[] = []
      for (const { record, ack, writer, owned } of ready) {
        const omission: FunctionNativeSsePartialOmission = Object.freeze({
          [partialOmissionBrand]: true as const })
        const assertDataCurrent = () => {
          record.assertDataCurrent(); writer.assertDataCurrent(); owned.assertDataCurrent()
          ack.returnedData.assertDataCurrent()
          Reflect.apply(throwIfDiagnosticAborted, ack.signal, [])
          if (record.omission !== omission || book.closed || book.failed || closed ||
            weakData(modelAcks, record.completed!.attempt) !== ack ||
            process.hrtime.bigint() >= ack.expiresAtNs) fail()
        }
        record.omission = omission
        writeWeak(partialOmissions, omission, { source, assertDataCurrent })
        assertDataCurrent()
        Reflect.apply(nativeMapDelete, book.records, [record.completed!.attempt])
        writeWeak(book.settled, record.completed!.attempt, record)
        output.push(omission)
      }
      return Object.freeze(output)
    } catch (error) { throw nativeSseDiagnosticFailure(error) }
  }
  const assertFinalizedData = (slot: FunctionConversationNativeNodeSlot, message: BaseMessage) => {
    const original = weakData(finalized, slot)
    if (!original || original.message !== message || closed) fail()
    Reflect.apply(throwIfDiagnosticAborted, original.signal, [])
    if (process.hrtime.bigint() >= original.expiresAtNs)
      throw new ModFunctionError("MODS_NATIVE_PROTECTION_TIMEOUT")
    projection.assertFinalizedData(message)
    Reflect.apply(throwIfDiagnosticAborted, original.signal, [])
    if (closed || weakData(finalized, slot) !== original || process.hrtime.bigint() >= original.expiresAtNs)
      fail()
  }
  const middleware = createMiddleware({ name: "nativeConversationProducer",
    wrapModelCall: async (request, handler) => {
      const configurable = types.isProxy(request.runtime) ? undefined :
        Object.getOwnPropertyDescriptor(request.runtime, "configurable")
      const requestConfigurable = configurable && "value" in configurable ? configurable.value : undefined
      const modelName = captureCurrentFunctionConversationNativeNodeWorkModelName(
        runtime, requestConfigurable)
      const assertActorData = () => {
        if (!modelName) return
        const actor = readFunctionConversationNativeNodeWorkModelName(
          modelName, runtime, requestConfigurable)
        const installation = weakData(graphInstallations, actor.graph)
        if (!installation) fail()
        graphData(installation)
        actor.assertDataCurrent()
      }
      assertActorData()
      assertCurrent()
      assertActorData()
      const token = calls.capture(request.runtime, modelName)
      assertActorData()
      return calls.run(token, async () => {
        const result = await handler(request)
        const type = nativeClass(result)
        if (type !== AIMessage.prototype && type !== AIMessageChunk.prototype) fail()
        return result as AIMessage
      })
    }
  })
  const finalizeToolHuman = async (slot: FunctionConversationNativeNodeSlot,
    ledger: FunctionConversationNativeTools): Promise<BaseMessage> => {
    const returned = ledger.read(slot)
    const token = captureFunctionConversationNativeToolHuman({ receipt: returned.receipt, slot, runtime })
    const source = readFunctionConversationNativeToolHuman(token)
    const protector = new FunctionNativeMessageProtector()
    const presentation = captureFunctionConversationNativeToolHumanPresentation({ source: token,
      protector, producer })
    const boundedWork = () => {
      source.signal.throwIfAborted()
      if (process.hrtime.bigint() >= source.expiresAtNs)
        throw new ModFunctionError("MODS_NATIVE_PROTECTION_TIMEOUT")
    }
    const guard = () => {
      if (closed) fail()
      functionConversationNativeHumanProjection(presentation)
      boundedWork()
    }
    const captured = captureNativeMessageForOccurrence(source.message, source.uuid, boundedWork)
    const safeInput = constructCapturedNativeMessage(captured.snapshot.type, captured.snapshot.data)
    const seal = () => { guard(); ledger.seal(source.receipt) }
    const adoption = createFunctionConversationNativeAdoption({ runtime, store, producer,
      occurrence: source.occurrence, nativeHumanPresentation: presentation,
      assertCurrent: guard, seal, flush: () => flush(source.uuid),
      facts: { uuid: source.uuid, role: "user", providerSourceId: source.uuid, providerOccurrence: 1 } })
    const keeper = new FunctionConversationNativeKeeper(runtime, protector)
    keepers.set(slot, keeper)
    active.add(keeper)
    let retained = 0
    try {
      const saved = await keeper.retain({ producer, occurrence: source.occurrence, message: safeInput,
        door: source.door, origin: source.origin, agentId: input.agentId,
        signal: source.signal, expiresAtNs: source.expiresAtNs, policy: source.policy.value,
        assertCurrent: guard, seal, captureProjection: adoption.captureProjection,
        prepare: adoption.prepare,
        retainActualWork() {
          retained++
          let released = false
          return () => { if (released) fail(); released = true; retained-- }
        },
        assertExecutionFacts(original, safe) {
          guard()
          const a = captureNativeMessage(original, boundedWork)
          const b = captureNativeMessage(safe, boundedWork)
          if (a.type !== "human" || b.type !== "human" || a.data.id !== b.data.id ||
            JSON.stringify(a.data.name) !== JSON.stringify(b.data.name)) fail()
          guard()
        },
        inheritPresentation() { /* This actual tool return owns its separate presentation. */ },
        onProtected: result => registerFunctionConversationNativeHumanProtection(presentation, result)
      })
      guard()
      projection.register(saved.message, saved.row)
      writeWeak(finalized, slot, Object.freeze({ message: saved.message, signal: source.signal,
        expiresAtNs: source.expiresAtNs }))
      return saved.message
    } finally {
      await keeper.whenDrained()
      if (retained) fail()
      active.delete(keeper)
      keeper.close()
      const saved = weakData(finalized, slot)
      if (saved) assertFinalizedData(slot, saved.message)
    }
  }
  const finalize = async (slot: FunctionConversationNativeNodeSlot): Promise<BaseMessage> => {
    assertCurrent()
    const view = readFunctionConversationNativeNodeSlot(slot)
    const raw = view.message
    const model = view.node === "model_request"
    const toolLedger = model ? undefined : nativeTools.get(view.bound)
    const tool = toolLedger?.read(slot)
    if (!model && (!tool || tool.message !== raw)) fail()
    const type = nativeClass(raw)
    if (!model && type === HumanMessage.prototype) {
      if (!toolLedger) fail()
      return finalizeToolHuman(slot, toolLedger)
    }
    const toolSide = !model && (type === AIMessage.prototype || type === SystemMessage.prototype)
      ? captureFunctionConversationNativeToolSide({ receipt: tool!.receipt, slot, runtime }) : undefined
    const sideSource = toolSide ? readFunctionConversationNativeToolSide(toolSide) : undefined
    const sideProjection = toolSide ? captureFunctionNativeToolSideProjection({
      source: toolSide, producer }) : undefined
    if (model ? type !== AIMessage.prototype && type !== AIMessageChunk.prototype
      : type !== ToolMessage.prototype && !sideSource) fail()
    const attempt = model ? calls.returned(view.config.configurable) : undefined
    const sseSource = currentFunctionConversationNativeSseSource()
    // The original AgentNode may replace a completed response with its own step-limit notice.
    // A completed aggregate chunk, however, must still be the exact provider return object.
    if (Object.getPrototypeOf(raw) === AIMessageChunk.prototype && attempt?.message !== raw) fail()
    if (attempt && sseSource && attempt.message === raw &&
      Object.getPrototypeOf(raw) === AIMessageChunk.prototype) {
      if (Reflect.apply(nativeWeakHas, modelNames, [attempt.attempt])) fail()
      writeWeak(modelNames, attempt.attempt, { returnedMessage: raw, source: sseSource,
        proof: captureFunctionConversationNativeNodeModelName(slot, runtime) })
    }
    const uuid = attempt?.uuid ?? tool?.uuid ?? randomUUID()
    const policy = attempt?.policy ?? sideSource?.policy ?? tool?.policy ?? runtime.capturePolicy()
    const policySource = readFunctionConversationNativePolicySource(policy, runtime)
    const signal = sideSource?.signal ?? AbortSignal.any([runtime.signal, runtime.target.signal,
      ...(view.config.signal ? [view.config.signal] : [])])
    // One absolute native protection cut covers all copies and both protections for this output.
    // Copying another field or revisiting an admission never renews the original budget.
    const expiresAtNs = sideSource?.expiresAtNs ?? process.hrtime.bigint() + 30_000_000_000n
    const returnedData = attempt && sseSource ? captureNativeCompletedModelReturnData(
      attempt.attempt, runtime, sseSource, () => {
        Reflect.apply(throwIfDiagnosticAborted, signal, [])
        if (closed || process.hrtime.bigint() >= expiresAtNs) fail()
      }) : undefined
    const boundedWork = () => {
      signal.throwIfAborted()
      if (process.hrtime.bigint() >= expiresAtNs)
        throw new ModFunctionError("MODS_NATIVE_PROTECTION_TIMEOUT")
    }
    const baseGuard = () => {
      if (sideSource) {
        // This genuine ToolReturn already includes the original Work, slot and policy callbacks.
        // It is independent of model Attempt IDs and has its own original cancellation cut.
        assertFunctionConversationNativeNodeSlotStructure(slot)
        sideSource.assertCurrent()
        assertFunctionConversationNativeNodeSlotStructure(slot)
        policySource?.assertTail()
        sideSource.assertDataCurrent()
      } else if (policySource) {
        // Only the original Manager's private policy/runtime pair can share its full physical
        // check. The exact node/task and original Manager facts still bracket that callback.
        assertFunctionConversationNativeNodeSlotStructure(slot)
        policySource.assertCurrent()
        assertFunctionConversationNativeNodeSlotStructure(slot)
        policySource.assertTail()
      } else {
        // Generic native hosts retain both independent full checks.
        view.assertCurrent()
        policy.assertCurrent()
      }
      if (closed) fail()
      if (!sideSource) tool?.assertCurrent()
      boundedWork()
    }
    baseGuard()
    const chunk = Object.getPrototypeOf(raw) === AIMessageChunk.prototype
    const captured = chunk ? captureNativeMessageForCompletedOccurrence(slot, uuid, boundedWork)
      : captureNativeMessageForOccurrence(raw, uuid, boundedWork)
    baseGuard()
    if (captured.snapshot.executionSuppressed) fail()
    if (returnedData && attempt?.message === raw &&
      returnedData.originalDigest !== captured.originalDigest) fail()
    const modelCurrent = model ? captureFunctionConversationNativeModelCurrent({
      slot, runtime, policy, uuid, originalDigest: captured.originalDigest,
      signal, expiresAtNs, hostLatch: sourceLatch
    }) : undefined
    const sharedToolPolicy = !model && tool?.door === "tool-result" && tool.message === raw &&
      type === ToolMessage.prototype && policySource &&
      readFunctionConversationNativeSharedPolicySource(tool.policy, runtime) === policySource
      ? policySource : undefined
    const sharedToolCurrent = sharedToolPolicy ? captureFunctionConversationNativeSharedToolCurrent({
      slot, runtime, policy, uuid, originalDigest: captured.originalDigest,
      signal, expiresAtNs, hostLatch: sourceLatch, toolReceipt: tool!.receipt
    }) : undefined
    const boundedSharedTool = () => {
      if (closed || sourceLatch.failed) fail()
      Reflect.apply(throwIfDiagnosticAborted, signal, [])
      if (process.hrtime.bigint() >= expiresAtNs)
        throw new ModFunctionError("MODS_NATIVE_PROTECTION_TIMEOUT")
    }
    const sharedToolTail = () => {
      assertFunctionConversationNativeNodeSlotStructure(slot)
      tool!.assertTail()
      sharedToolPolicy!.assertTail()
      boundedSharedTool()
    }
    const guard = toolSide ? captureFunctionConversationNativeToolSideCurrent(toolSide, sourceLatch)
      : modelCurrent ?? sharedToolCurrent ?? (() => {
        if (sharedToolPolicy) sharedToolTail()
        else baseGuard()
        const current = chunk ? captureCompletedNativeNodeData(slot, uuid, boundedWork)
          : captureNativeMessageForOccurrence(raw, uuid, boundedWork)
        if (current.snapshot.executionSuppressed || current.originalDigest !== captured.originalDigest) fail()
        baseGuard()
        if (sharedToolPolicy) {
          const final = captureNativeMessageForOccurrence(raw, uuid, boundedSharedTool)
          if (final.snapshot.executionSuppressed || final.originalDigest !== captured.originalDigest) fail()
          sharedToolTail()
        }
      })
    const sourceId = attempt?.providerSourceId ?? captured.originalId ?? uuid
    const role = model || sideSource?.nativeType === "ai" ? "assistant"
      : sideSource?.nativeType === "system" ? "system" : "tool"
    let providerOccurrence = attempt?.providerOccurrence
    if (providerOccurrence === undefined) {
      const rows = runtime.database.exec(`SELECT MAX(COALESCE(provider_occurrence,1)) AS n
        FROM thread_messages WHERE thread_id=? AND role=?
        AND COALESCE(provider_source_id,message_id)=?`, [runtime.destination.threadId, role, sourceId])[0]
      const prior: unknown = rows?.values[0]?.[0] ?? 0
      if (typeof prior !== "number" || !Number.isSafeInteger(prior) || prior < 0) fail()
      const providerKey = JSON.stringify([role, sourceId])
      providerOccurrence = Math.max(prior, toolOccurrences.get(providerKey) ?? 0) + 1
      if (!Number.isSafeInteger(providerOccurrence)) fail()
      toolOccurrences.set(providerKey, providerOccurrence)
    }
    const safeInput = constructCapturedNativeMessage(captured.snapshot.type, {
      ...captured.snapshot.data, additional_kwargs: {
        ...(captured.snapshot.data.additional_kwargs as Record<string, unknown>),
        [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: sourceId,
        [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: providerOccurrence
      }
    })
    guard()
    const seal = () => {
      guard()
      if (attempt) calls.seal(attempt.call)
      if (tool) toolLedger!.seal(tool.receipt)
    }
    const adoption = createFunctionConversationNativeAdoption({ runtime, store, producer,
      occurrence: sideSource?.occurrence ?? slot, assertCurrent: guard, seal, flush: () => flush(uuid),
      ...(sideProjection ? { nativeToolSideProjection: sideProjection } : {}),
      facts: { uuid, role, providerSourceId: sourceId,
        providerOccurrence, ...(ToolMessage.isInstance(safeInput) ? {
          toolCallId: safeInput.tool_call_id,
          ...(safeInput.status !== undefined ? { status: safeInput.status } : {}),
          ...(safeInput.name !== undefined ? { name: safeInput.name } : {})
        } : safeInput.name === undefined ? {} : { name: safeInput.name }) } })
    const keeper = new FunctionConversationNativeKeeper(runtime, new FunctionNativeMessageProtector())
    keepers.set(slot, keeper); active.add(keeper)
    let retained = 0
    try {
      const saved = await keeper.retain({ producer, occurrence: sideSource?.occurrence ?? slot,
        message: safeInput,
        door: model ? "response" : tool!.door,
        origin: model ? { kind: "model", model: input.model }
          : tool!.origin, agentId: input.agentId,
        signal, expiresAtNs, policy: policy.value, assertCurrent: guard, seal,
        captureProjection: adoption.captureProjection, prepare: adoption.prepare,
        retainActualWork() {
          retained++
          let released = false
          return () => { if (released) fail(); released = true; retained-- }
        },
        assertExecutionFacts(original, safe) {
          guard()
          const a = captureNativeMessage(original, boundedWork)
          guard()
          const b = captureNativeMessage(safe, boundedWork)
          guard()
          if (a.type !== b.type || a.data.id !== b.data.id) fail()
          const keys = a.type === "ai" ? ["tool_calls", "invalid_tool_calls", "tool_call_chunks",
            "usage_metadata", "name"] : a.type === "system" ? ["name"]
              : ["tool_call_id", "status", "name"]
          for (const key of keys) if (JSON.stringify(a.data[key]) !== JSON.stringify(b.data[key])) fail()
        },
        inheritPresentation() { /* No public error override exists before the actual native result. */ }
      })
      guard()
      projection.register(saved.message, saved.row)
      writeWeak(finalized, slot, Object.freeze({ message: saved.message, signal, expiresAtNs }))
      if (model) {
        if (!AIMessage.isInstance(saved.message)) fail()
        completed?.(saved.message)
      }
      return saved.message
    } finally {
      // Public cancellation cannot let the original writers outrun an ignored flush or Worker.
      await keeper.whenDrained()
      if (retained) fail()
      active.delete(keeper)
      keeper.close()
      const saved = weakData(finalized, slot)
      if (saved) {
        assertFinalizedData(slot, saved.message)
        if (attempt && sseSource) {
          if (!returnedData || Reflect.apply(nativeWeakHas, modelAcks, [attempt.attempt])) fail()
          returnedData.assertDataCurrent()
          writeWeak(modelAcks, attempt.attempt, Object.freeze({ slot,
            returnedMessage: attempt.message, message: saved.message, signal, expiresAtNs,
            returnedData, source: sseSource }))
        }
      }
    }
  }
  const configure = <T extends RunnableConfig>(config: T): T => {
    assertCurrent()
    return mergeConfigs(config, { callbacks: [calls.callback] }) as T
  }
  const message = (value: unknown): unknown | undefined => {
    if (!Array.isArray(value) || !value[0] || typeof value[0] !== "object") return value
    if (projection.omitMessage(value[0])) return undefined
    const observed = calls.chunk(value[0])
    if (!observed) {
      // The model's onLLMEnd message has not passed the completed node finalizer yet.
      if (calls.completed(value[0])) return undefined
      return value
    }
    if (observed.sealed) return undefined
    observed.assertCurrent()
    if (observed.policy.value.protected) return undefined
    const partial = calls.capturePartial(value[0])
    if (!partial) fail()
    return projectFunctionConversationNativePartial(partial, value[1])
  }
  const lifetimeSignal = AbortSignal.any([runtime.signal, runtime.target.signal])
  const close = () => {
    if (closed) return
    sourceLatch.failed = true
    closed = true
    lifetimeSignal.removeEventListener("abort", close)
    calls.close()
    const owners = Reflect.apply(nativeMapValues, diagnosticOwners, []) as
      Iterator<ReturnType<typeof createNativeSseDiagnosticOwner>>
    while (true) {
      const next = Reflect.apply(nativeMapNext, owners, []) as
        IteratorResult<ReturnType<typeof createNativeSseDiagnosticOwner>>
      if (next.done) break
      next.value.close()
    }
    projection.close()
    for (const node of nativeNodes) node.close()
    for (const tools of toolLedgers) tools.close()
    nativeInput?.close()
    for (const keeper of active) keeper.close()
  }
  lifetimeSignal.addEventListener("abort", close, { once: true })
  if (lifetimeSignal.aborted) close()
  const whenFinalized = (slot: FunctionConversationNativeNodeSlot) =>
    keepers.get(slot)?.whenDrained() ?? Promise.resolve()
  const nodeCallbacks = Object.freeze({ assertCurrent, finalize, assertFinalizedData,
    whenFinalized, configure })
  const graphData = (original: NativeGraphInstallation) => {
    if (closed || sourceLatch.failed || original.phase !== "ready" ||
      weakData(graphInstallations, original.graph) !== original || !Reflect.apply(nativeWeakSetHas, installedGraphs, [original.graph])) fail()
    for (let index = 0; index < original.nodes.length; index++)
      assertFunctionConversationNativeNodeInstallation(original.nodes[index], original.graph)
    if (original.ledger) assertFunctionConversationNativeToolsBinding(original.ledger, original.graph)
    original.policy?.assertTail()
  }
  const abandonGraph = (graph: object) => {
    const original = weakData(graphInstallations, graph)
    if (!original) return
    original.phase = "failed"
    installedGraphs.delete(graph)
    // Keep every original resource in the Host drain groups until its real physical settlement.
    for (const node of original.nodes) node.close()
    original.ledger?.close()
  }
  const installGraph = (graph: object) => {
    if (!graph || types.isProxy(graph) || !(graph instanceof CompiledStateGraph)) fail()
    const previous = weakData(graphInstallations, graph)
    if (previous) {
      if (previous.phase === "installing") previous.phase = "failed"
      fail()
    }
    const original: NativeGraphInstallation = { graph, nodes: [], ledger: undefined,
      policy: undefined, phase: "installing" }
    writeWeak(graphInstallations, graph, original)
    try {
      assertCurrent()
      original.policy = readFunctionConversationNativePolicySource(runtime.capturePolicy(), runtime)
      if (original.phase !== "installing" || closed || sourceLatch.failed) fail()
      if ((graph as { nodes?: Record<string, unknown> }).nodes?.tools) {
        const ledger = installFunctionConversationNativeTools({ graph, runtime })
        original.ledger = ledger
        toolLedgers.add(ledger)
        const nodes = Object.getOwnPropertyDescriptor(graph, "nodes")?.value as object
        const tools = Object.getOwnPropertyDescriptor(nodes, "tools")?.value as object
        const bound: unknown = Object.getOwnPropertyDescriptor(tools, "bound")?.value
        if (!bound || typeof bound !== "object") fail()
        nativeTools.set(bound, ledger)
      }
      for (const node of ["model_request", "tools"] as const) {
        if (!(graph as { nodes?: Record<string, unknown> }).nodes?.[node]) continue
        const control = installFunctionConversationNativeNode({ graph, node, runtime,
          assertCurrent, finalize, assertFinalizedData, whenFinalized })
        original.nodes.push(control)
        nativeNodes.push(control)
      }
      assertCurrent()
      if (original.phase !== "installing" || closed || sourceLatch.failed) fail()
      original.phase = "ready"
      installedGraphs.add(graph)
      graphData(original)
    } catch (error) {
      abandonGraph(graph)
      throw error
    }
  }
  const host = Object.freeze({ middleware, nodeCallbacks,
    attachSharedTools(factory: FunctionConversationSharedNativeFactory, domain: object,
      graph: object, ledger: FunctionConversationNativeTools) {
      const current = readCurrentFunctionConversationSharedNativeDomain(factory, graph)
      if (!current || current.domain !== domain || current.host !== host || current.runtime !== runtime)
        fail()
      assertCurrent()
      const bound = assertFunctionConversationNativeToolsBinding(ledger, graph, factory)
      const final = readCurrentFunctionConversationSharedNativeDomain(factory, graph)
      if (closed || !final || final.domain !== domain || final.host !== host || final.runtime !== runtime)
        fail()
      const previous = nativeTools.get(bound)
      if (previous && previous !== ledger) fail()
      nativeTools.set(bound, ledger)
      sharedToolLedgers.add(ledger)
    },
    install: installGraph, configure, message, validate: projection.validate, prepareSseDiagnostic,
    deferCompletedSsePartial, confirmSsePartialOmissions,
    closeSseDiagnosticSource(source: FunctionConversationNativeSseSource) {
      mapData(diagnosticOwners, source)?.close()
      const book = mapData(deferredSources, source)
      if (book) { book.closed = true; book.records.clear(); Reflect.apply(nativeMapDelete, deferredSources, [source]) }
    },
    retainInput: nativeInput.retainInput,
    registerHistorical: projection.registerHistorical,
    captureReturnMessageSource: projection.captureReturnMessageSource,
    registerIntake: projection.registerIntake,
    close,
    async whenDrained() {
      const drains = [
        ...nativeNodes.map(node => () => node.whenDrained()),
        ...[...active].map(keeper => () => keeper.whenDrained()),
        ...[...toolLedgers].map(tools => () => tools.whenDrained()),
        ...[...sharedToolLedgers].map(tools => () => tools.whenDrainedForRuntime(runtime)),
        ...mapValues(diagnosticOwners).map(owner => () => owner.whenDrained()),
        ...(nativeInput ? [() => nativeInput.whenDrained()] : [])
      ]
      // A failed earlier resource must not prevent observation of the other actual work.
      const results = await Promise.allSettled(drains.map(drain => Promise.resolve().then(drain)))
      for (const result of results) if (result.status === "rejected") throw result.reason
    }
  })
  writeWeak(derivedHosts, host, { runtime, assertInstalled(graph) {
    const original = weakData(graphInstallations, graph)
    if (!original) fail()
    graphData(original)
  }, read(graph) {
    const base = weakData(graphInstallations, graph)
    if (!base || base.phase !== "ready" || !base.policy) return undefined
    graphData(base)
    return Object.freeze({ begin() {
      // Occupy this synchronous Host operation before any full source guard or constructor.
      if (deriving) { deriving.failed = true; fail() }
      const operation = { failed: false, published: false, graph: undefined as object | undefined }
      deriving = operation
      const data = () => {
        if (operation.failed || deriving !== operation) fail()
        graphData(base)
        if (operation.graph) {
          const child = weakData(graphInstallations, operation.graph)
          if (!child || !child.policy) fail()
          graphData(child)
        }
      }
      const attempt = (run: () => void) => {
        try { run() }
        catch (error) { operation.failed = true; throw error }
      }
      return Object.freeze({
        assertCurrent() { attempt(() => { data(); base.policy!.assertCurrent(); data() }) },
        install(child: object) { attempt(() => {
          data()
          if (operation.graph || child === graph ||
            Reflect.apply(nativeWeakHas, graphInstallations, [child])) fail()
          operation.graph = child
          installGraph(child)
          data()
        }) },
        publish(child: object) { attempt(() => {
          if (operation.graph !== child || operation.published) fail()
          data()
          operation.published = true
        }) },
        dispose() {
          if (deriving !== operation) { operation.failed = true; fail() }
          deriving = undefined
          if (operation.graph && (operation.failed || !operation.published))
            abandonGraph(operation.graph)
        }
      })
    } })
  } })
  return host
}

export type FunctionConversationNativeHost = ReturnType<typeof createFunctionConversationNativeHost>
