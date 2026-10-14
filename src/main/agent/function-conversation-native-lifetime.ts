import { AsyncLocalStorage } from "node:async_hooks"
import { types } from "node:util"
import type { BaseMessage } from "@langchain/core/messages"
import { CompiledStateGraph } from "@langchain/langgraph"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { captureNativePartialMetadata } from "./native-message-capture"
import { readFunctionConversationNativeNodeCompletion,
  assertFunctionConversationNativeNodeSlotStructure,
  type FunctionConversationNativeNodeSlot } from "./function-conversation-native-node"
import { claimFunctionConversationSharedNativeObserverSeal,
  isFunctionConversationSharedNativeObserverSealRequest,
  type SharedNativeObserverSealRequest } from "./native-agent-factory"
import {
  assertFunctionConversationSharedNativeStreamPreflightDispatch,
  assertFunctionConversationSharedNativeStreamIteratorEntry
} from "./function-conversation-shared-native-stream-state"

export interface FunctionConversationNativeStreamShape {
  readonly modes: readonly string[]
  readonly multiple: boolean
  readonly subgraphs: boolean
}
const sseSourceBrand = Symbol("function-native-sse-source")
/** Source identity only; this token grants no target, partial or completed-message authority. */
export interface FunctionConversationNativeSseSource {
  readonly [sseSourceBrand]: true
}
const diagnosticBrand = Symbol("function-native-stream-diagnostic")
const throwIfAborted = AbortSignal.prototype.throwIfAborted
const nativeWeakGet = WeakMap.prototype.get, nativeWeakSet = WeakMap.prototype.set
const nativeWeakHas = WeakSet.prototype.has, nativeWeakAdd = WeakSet.prototype.add
function weakData<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return Reflect.apply(nativeWeakGet, map, [key]) as V | undefined
}
function writeWeak<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
  Reflect.apply(nativeWeakSet, map, [key, value])
}
export interface FunctionNativeStreamDiagnostic { readonly [diagnosticBrand]: true }
export interface FunctionNativeStreamDiagnosticView {
  readonly source: FunctionConversationNativeSseSource
  readonly graph: object
  readonly runtime: object
  readonly signal: AbortSignal
  readonly message: object
  readonly metadata: object
  readonly namespace: readonly string[] | undefined
  readonly expiresAtNs: bigint
  run<T>(work: () => T): T
  assertCurrent(): void
  assertDataCurrent(): void
}

interface Source {
  readonly graph: object
  readonly assertCurrent: () => void
  readonly active: Map<object, () => Promise<void>>
  readonly settle: () => void
  readonly completions: WeakMap<BaseMessage, Completion>
  readonly writers: WeakMap<BaseMessage, FunctionNativeSuccessfulWriter>
  readonly emitted: WeakSet<BaseMessage>
  readonly sseSource: FunctionConversationNativeSseSource
  readonly invocation?: Readonly<{ runtime: object; signal: AbortSignal }>
  readonly diagnostics: WeakMap<object, FunctionNativeStreamDiagnostic>
  opening: boolean
  draining: boolean
  shape?: FunctionConversationNativeStreamShape
  actualShape?: FunctionConversationNativeStreamShape
  encoding?: "text/event-stream"
  streamCaptured: boolean
}

interface Completion {
  readonly slot: FunctionConversationNativeNodeSlot
  readonly metadata: Readonly<Record<string, unknown>>
  readonly namespace: readonly string[]
}

export interface FunctionConversationNativeCompletionFrame {
  readonly message: BaseMessage
  readonly metadata: Readonly<Record<string, unknown>>
  readonly namespace: readonly string[]
}

/** A writer observation belongs to the exact original iterator, never a replayed public frame. */
export interface FunctionNativeSuccessfulWriter {
  readonly message: BaseMessage
  readonly slot: FunctionConversationNativeNodeSlot
  assertCurrent(): void
  assertDataCurrent(): void
}

type ActualIterator = AsyncGenerator<unknown, unknown, unknown>
type IteratorFactory = (input: unknown, options?: Record<string, unknown>) => ActualIterator
type StreamFactory = (input: unknown, options?: Record<string, unknown>) => Promise<unknown>
const observerBrand = Symbol("function-native-source-observer")
/** Method provenance only. It grants no Source, runtime, target or message authority. */
export interface FunctionConversationNativeSourceObserverInstallation {
  readonly [observerBrand]: true
}
interface ObserverMethod {
  readonly key: "stream" | "_streamIterator"
  readonly path: readonly object[]
  readonly prototypes: readonly (object | null)[]
  readonly fields: readonly (PropertyDescriptor | undefined)[]
  readonly original: IteratorFactory | StreamFactory
}
interface ObserverRecord {
  readonly graph: object
  readonly prototype: object | null
  readonly stream: ObserverMethod
  readonly iterator: ObserverMethod
  streamField: PropertyDescriptor
  iteratorField: PropertyDescriptor
  readonly origin: FunctionConversationNativeSourceObserverOrigin
  readonly view: Readonly<{ graph: object; assertDataCurrent(): void }>
  sealing: boolean
  sealed: boolean
  failed: boolean
}
export interface FunctionConversationNativeSourceObserverOrigin {
  readonly graph: object
  readonly stream: ObserverMethod
  readonly iterator: ObserverMethod
  readonly streamField: PropertyDescriptor
  readonly iteratorField: PropertyDescriptor
}
export interface FunctionConversationNativeSourceObserverDispatch {
  readonly graph: object
  readonly iterator: IteratorFactory
  readonly owner: object
  readonly descriptor: Readonly<PropertyDescriptor>
  assertDataCurrent(): void
}
const scopes = new AsyncLocalStorage<Source>()
const observerGraphs = new WeakMap<object, FunctionConversationNativeSourceObserverInstallation>()
const observerRecords = new WeakMap<FunctionConversationNativeSourceObserverInstallation, ObserverRecord>()
const diagnostics = new WeakMap<FunctionNativeStreamDiagnostic, FunctionNativeStreamDiagnosticView>()
const sources = new WeakMap<FunctionConversationNativeSseSource, Source>()

function fail(): never {
  throw new ModFunctionError("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
}

function own(value: object, key: PropertyKey): unknown {
  if (types.isProxy(value)) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor && !("value" in descriptor)) fail()
  return descriptor?.value
}

function sameObserverField(actual: PropertyDescriptor | undefined,
  expected: PropertyDescriptor | undefined): boolean {
  return actual === undefined ? expected === undefined : expected !== undefined &&
    "value" in actual && "value" in expected && actual.value === expected.value &&
    actual.enumerable === expected.enumerable && actual.writable === expected.writable &&
    actual.configurable === expected.configurable
}

function captureObserverMethod(graph: object, key: ObserverMethod["key"]): ObserverMethod {
  const path: object[] = [], prototypes: Array<object | null> = []
  const fields: Array<PropertyDescriptor | undefined> = []
  let current: object | null = graph
  while (current) {
    if (types.isProxy(current)) fail()
    const field = Object.getOwnPropertyDescriptor(current, key)
    const prototype = Object.getPrototypeOf(current) as object | null
    if (prototype && types.isProxy(prototype)) fail()
    path[path.length] = current
    prototypes[prototypes.length] = prototype
    fields[fields.length] = field && Object.freeze(field)
    if (field) {
      if (!("value" in field) || typeof field.value !== "function" || types.isProxy(field.value)) fail()
      return Object.freeze({ key, path: Object.freeze(path), prototypes: Object.freeze(prototypes),
        fields: Object.freeze(fields),
        original: field.value as IteratorFactory | StreamFactory })
    }
    current = prototype
  }
  return fail()
}

function assertObserverMethod(record: ObserverRecord, method: ObserverMethod,
  installed: PropertyDescriptor): void {
  let current: object | null = record.graph
  for (let index = 0; index < method.path.length; index++) {
    if (current !== method.path[index] || types.isProxy(current)) fail()
    const field = Object.getOwnPropertyDescriptor(current, method.key)
    if (!sameObserverField(field, index === 0 ? installed : method.fields[index])) fail()
    current = Object.getPrototypeOf(current) as object | null
    if (current !== method.prototypes[index]) fail()
  }
}

function assertObserverData(record: ObserverRecord): void {
  if (record.failed) fail()
  try {
    if (types.isProxy(record.graph) || Object.getPrototypeOf(record.graph) !== record.prototype) fail()
    assertObserverMethod(record, record.stream, record.streamField)
    assertObserverMethod(record, record.iterator, record.iteratorField)
  } catch (error) { record.failed = true; throw error }
}

/** Only this module's actual installation can supply the observed method addresses. */
export function readFunctionConversationNativeSourceObserverInstallation(
  installation: FunctionConversationNativeSourceObserverInstallation, graph: object
): ObserverRecord["view"] {
  const record = weakData(observerRecords, installation)
  if (!record || record.graph !== graph) fail()
  assertObserverData(record)
  return record.view
}

/** First installation provenance only; current flags never replace this original baseline. */
export function readFunctionConversationNativeSourceObserverOrigin(
  installation: FunctionConversationNativeSourceObserverInstallation, graph: object
): FunctionConversationNativeSourceObserverOrigin {
  const record = weakData(observerRecords, installation)
  if (!record || record.graph !== graph) fail()
  assertObserverData(record)
  return record.origin
}

/** Current approved dispatch facts, selected only through both original installation tables. */
export function readFunctionConversationNativeSourceObserverDispatch(
  installation: FunctionConversationNativeSourceObserverInstallation, graph: object
): FunctionConversationNativeSourceObserverDispatch {
  const record = weakData(observerRecords, installation)
  if (!record || record.graph !== graph || weakData(observerGraphs, graph) !== installation) fail()
  assertObserverData(record)
  const descriptor = record.iteratorField
  const assertDataCurrent = () => {
    if (weakData(observerRecords, installation) !== record ||
      weakData(observerGraphs, graph) !== installation || record.iteratorField !== descriptor) fail()
    assertObserverData(record)
  }
  return Object.freeze({ graph, iterator: descriptor.value as IteratorFactory, owner: graph,
    descriptor, assertDataCurrent })
}

/** Only the Factory's exact once request permits this installation's immutable transition. */
export function sealFunctionConversationNativeSourceObserverInstallation(
  installation: FunctionConversationNativeSourceObserverInstallation,
  request: SharedNativeObserverSealRequest
): Readonly<{ invalidate(): void }> {
  const record = weakData(observerRecords, installation)
  if (!record) fail()
  if (!isFunctionConversationSharedNativeObserverSealRequest(request, installation, record.graph))
    fail()
  try {
    const original = claimFunctionConversationSharedNativeObserverSeal(request, installation,
      record.graph)
    if (record.sealing || record.sealed) fail()
    record.sealing = true
    assertObserverData(record)
    original.assertBeforeDataCurrent()
    const streamField = Object.freeze({ ...record.streamField,
      writable: false, configurable: false })
    const iteratorField = Object.freeze({ ...record.iteratorField,
      writable: false, configurable: false })
    if (!Reflect.defineProperty(record.graph, "stream", streamField) ||
      !Reflect.defineProperty(record.graph, "_streamIterator", iteratorField)) fail()
    record.streamField = streamField
    record.iteratorField = iteratorField
    assertObserverData(record)
    original.assertSealedDataCurrent()
    record.sealed = true
    // A later Factory dispatch failure must also permanently retire this actual installation.
    return Object.freeze({ invalidate() { record.failed = true } })
  } catch (error) { record.failed = true; throw error }
  finally { record.sealing = false }
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !types.isProxy(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function values(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return [value]
  if (types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) fail()
  const length = own(value, "length")
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
    length > 1_000_000) fail()
  return Array.from({ length }, (_, index) => own(value, String(index)))
}

function arrayTopology(value: unknown): () => void {
  if (!Array.isArray(value) || types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype) fail()
  const keys = Reflect.ownKeys(value), descriptors = keys.map(key =>
    Object.getOwnPropertyDescriptor(value, key))
  if (keys.length !== value.length + 1 || descriptors.some(field => !field || !("value" in field)))
    fail()
  return () => {
    if (types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) fail()
    const current = Reflect.ownKeys(value)
    if (current.length !== keys.length) fail()
    for (let index = 0; index < keys.length; index++) {
      const actual = Object.getOwnPropertyDescriptor(value, keys[index]), expected = descriptors[index]
      if (current[index] !== keys[index] || !actual || !expected || !("value" in actual) ||
        actual.value !== expected.value || actual.enumerable !== expected.enumerable ||
        actual.writable !== expected.writable || actual.configurable !== expected.configurable) fail()
    }
  }
}

function metadataTopology(value: object, bounded: () => void): () => void {
  const checks: Array<() => void> = [], pending: unknown[] = [value]
  let remaining = 999_999
  while (pending.length) {
    bounded()
    const current = pending.pop()
    if (!current || typeof current !== "object") continue
    if (types.isProxy(current)) fail()
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Array.prototype && prototype !== Object.prototype && prototype !== null) fail()
    const keys = Reflect.ownKeys(current), fields = keys.map(key =>
      Object.getOwnPropertyDescriptor(current, key))
    if (keys.some(key => typeof key !== "string") ||
      fields.some(field => !field || !("value" in field))) fail()
    const children = Array.isArray(current) ? keys.length - 1 : keys.length
    if (children > remaining) fail()
    remaining -= children
    for (let index = 0; index < fields.length; index++)
      if (fields[index] && !(Array.isArray(current) && keys[index] === "length"))
        pending.push(fields[index]!.value)
    checks.push(() => {
      bounded()
      if (types.isProxy(current) || Object.getPrototypeOf(current) !== prototype) fail()
      const actualKeys = Reflect.ownKeys(current)
      if (actualKeys.length !== keys.length) fail()
      for (let index = 0; index < keys.length; index++) {
        const actual = Object.getOwnPropertyDescriptor(current, keys[index]), expected = fields[index]
        if (actualKeys[index] !== keys[index] || !actual || !expected || !("value" in actual) ||
          !Object.is(actual.value, expected.value) || actual.enumerable !== expected.enumerable ||
          actual.writable !== expected.writable || actual.configurable !== expected.configurable) fail()
      }
    })
  }
  return () => {
    for (let index = 0; index < checks.length; index++) checks[index]()
  }
}

/** Mint remains local to the original iterator and the true completed-writer ledger. */
function diagnostic(source: Source, tuple: unknown, namespace?: readonly string[],
  outer?: unknown): FunctionNativeStreamDiagnostic | undefined {
  if (source.encoding !== "text/event-stream" || !source.invocation) return undefined
  const expiresAtNs = process.hrtime.bigint() + 30_000_000_000n
  const invocation = source.invocation
  const bounded = () => {
    Reflect.apply(throwIfAborted, invocation.signal, [])
    if (source.draining || process.hrtime.bigint() >= expiresAtNs) fail()
  }
  const checks = [arrayTopology(tuple)]
  if (outer !== undefined && outer !== tuple) checks.push(arrayTopology(outer))
  if (namespace !== undefined) checks.push(arrayTopology(namespace))
  const message = own(tuple as object, "0"), metadata = own(tuple as object, "1")
  if (!message || typeof message !== "object" || types.isProxy(message) || !plain(metadata) ||
    own(tuple as object, "length") !== 2) fail()
  // Full metadata is typed before a policy, serializer or source callback can observe it.
  const original = captureNativePartialMetadata(metadata, bounded)
  checks.push(metadataTopology(metadata, bounded))
  const token: FunctionNativeStreamDiagnostic = Object.freeze({ [diagnosticBrand]: true as const })
  const assertDataCurrent = () => {
    bounded()
    if (scopes.getStore() !== source || weakData(diagnostics, token) !== view ||
      source.invocation !== invocation || source.encoding !== "text/event-stream") fail()
    for (let index = 0; index < checks.length; index++) checks[index]()
    if (captureNativePartialMetadata(metadata, bounded).digest !== original.digest) fail()
    bounded()
  }
  const view: FunctionNativeStreamDiagnosticView = Object.freeze({ source: source.sseSource,
    graph: source.graph, runtime: invocation.runtime, signal: invocation.signal,
    message, metadata, namespace, expiresAtNs,
    run<T>(work: () => T): T { return scopes.run(source, work) },
    assertCurrent() { assertDataCurrent(); source.assertCurrent(); assertDataCurrent() },
    assertDataCurrent })
  writeWeak(diagnostics, token, view)
  assertDataCurrent()
  return token
}

export function readFunctionNativeStreamDiagnostic(token: FunctionNativeStreamDiagnostic,
  expectedSource: FunctionConversationNativeSseSource): FunctionNativeStreamDiagnosticView {
  const view = selectFunctionNativeStreamDiagnostic(token)
  if (view.source !== expectedSource) fail()
  view.assertCurrent()
  return view
}

/** Pure selection lets the genuine Host reserve capacity before the first source callback. */
export function selectFunctionNativeStreamDiagnostic(token: FunctionNativeStreamDiagnostic):
  FunctionNativeStreamDiagnosticView {
  const view = weakData(diagnostics, token)
  if (!view || currentFunctionConversationNativeSseSource() !== view.source) fail()
  view.assertDataCurrent()
  return view
}

/** Only NativeNode's actual accepted replacement can enter this invocation's private ledger. */
export function recordFunctionConversationNativeCompletion(
  graph: object, slot: FunctionConversationNativeNodeSlot, message: BaseMessage
): void {
  const source = scopes.getStore()
  if (!source || source.graph !== graph) return
  source.assertCurrent()
  const view = readFunctionConversationNativeNodeCompletion(slot, graph, message)
  // Preserve the original model callback's opt-out. Tool node outputs use the framework's
  // separate chain-end path, which does not apply these model-only tags.
  if (view.node === "model_request" && values(view.config.tags).some(tag =>
    tag === "nostream" || tag === "langsmith:nostream")) return
  const previous = weakData(source.completions, message)
  if (previous) {
    if (previous.slot !== slot) fail()
    return
  }
  const original = view.config.metadata
  if (original !== undefined && !plain(original)) fail()
  const metadata: Record<string, unknown> = { tags: view.config.tags, name: view.node }
  if (original) for (const key of Object.keys(original)) metadata[key] = own(original, key)
  const taskNamespace = view.config.configurable && own(view.config.configurable, "checkpoint_ns")
  if (typeof taskNamespace !== "string" ||
    metadata.langgraph_checkpoint_ns !== taskNamespace) fail()
  // This reproduces StreamMessagesHandler's display prefix, after the private task proof has
  // been checked. A graph update's prefix identifies its graph, not the producing message task.
  const namespace = Object.freeze(taskNamespace.split("|"))
  source.assertCurrent()
  writeWeak(source.completions, message, { slot, metadata: Object.freeze(metadata), namespace })
}

function streamShape(graph: object, options: Record<string, unknown> | undefined) {
  if (options?.encoding !== undefined) fail()
  const explicit = options?.streamMode
  const configurable = options?.configurable as Record<string, unknown> | undefined
  const fallback = configurable?.__pregel_task_id !== undefined
    ? ["values"] : Reflect.get(graph, "streamMode", graph) as unknown
  const modes = explicit === undefined ? fallback
    : typeof explicit === "string" ? [explicit] : explicit
  if (!Array.isArray(modes) || !modes.length || !modes.every(mode => typeof mode === "string"))
    fail()
  // Other modes contain original callback/state data with no native producer admission yet.
  // Reject before the original generator starts; a later output filter would already leak it.
  if (modes.some(mode => !["messages", "values", "updates"].includes(mode))) fail()
  // Pregel omits the mode tag for an omitted mode, even when its default is an array.
  // More than one untagged default cannot be selected without guessing its payload shape.
  if (explicit === undefined && modes.length !== 1) fail()
  return Object.freeze({ modes: Object.freeze([...modes] as string[]),
    multiple: Array.isArray(explicit), subgraphs: options?.subgraphs === true })
}

function settle(source: Source): void {
  if (!source.opening && source.active.size === 0) source.settle()
}

/** Pure same-source identity, available only after the actual merged stream enabled SSE. */
export function currentFunctionConversationNativeSseSource():
  FunctionConversationNativeSseSource | undefined {
  const source = scopes.getStore()
  return source?.encoding === "text/event-stream" && !source.draining
    ? source.sseSource : undefined
}

export function readFunctionNativeSuccessfulWriter(sourceToken: FunctionConversationNativeSseSource,
  slot: FunctionConversationNativeNodeSlot, message: BaseMessage):
  FunctionNativeSuccessfulWriter | undefined {
  const source = weakData(sources, sourceToken)
  if (!source || scopes.getStore() !== source || source.draining) fail()
  const witness = weakData(source.writers, message)
  if (!witness) return undefined
  if (witness.slot !== slot) fail()
  witness.assertDataCurrent()
  return witness
}

/** Only step() below can call this after a real original next() returns an updates address. */
function observeWriter(source: Source, frame: unknown): void {
  const shape = source.actualShape
  if (!shape || !frame || typeof frame !== "object" || types.isProxy(frame)) fail()
  const position = shape.subgraphs ? 1 : 0
  const mode = shape.multiple ? own(frame, String(position)) : shape.modes[0]
  if (mode !== "updates") return
  const checks: Array<() => void> = []
  if (shape.multiple || shape.subgraphs) checks.push(arrayTopology(frame))
  if (shape.subgraphs) checks.push(arrayTopology(own(frame, "0")))
  const payload = shape.multiple || shape.subgraphs
    ? own(frame, String(position + (shape.multiple ? 1 : 0))) : frame
  if (!plain(payload)) fail()
  const capturedObject = (value: Record<string, unknown>) => {
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    const fields = keys.map(key => Object.getOwnPropertyDescriptor(value, key))
    if (keys.some(key => typeof key !== "string") ||
      fields.some(field => !field || !("value" in field))) fail()
    checks.push(() => {
      if (types.isProxy(value) || Object.getPrototypeOf(value) !== prototype) fail()
      const next = Reflect.ownKeys(value)
      if (next.length !== keys.length) fail()
      for (let index = 0; index < keys.length; index++) {
        const actual = Object.getOwnPropertyDescriptor(value, keys[index]), expected = fields[index]
        if (next[index] !== keys[index] || !actual || !expected || !("value" in actual) ||
          actual.value !== expected.value || actual.enumerable !== expected.enumerable ||
          actual.configurable !== expected.configurable || actual.writable !== expected.writable) fail()
      }
    })
  }
  const selectedValues = (value: unknown): readonly unknown[] => {
    if (!Array.isArray(value)) return [value]
    checks.push(arrayTopology(value))
    return values(value)
  }
  capturedObject(payload)
  const metadata = own(payload, "__metadata__")
  if (metadata !== undefined) {
    if (!plain(metadata)) fail()
    capturedObject(metadata)
    const cached = own(metadata, "cached")
    if (typeof cached !== "boolean") fail()
    // A replay is an ordinary framework update, not proof of this invocation's writer.
    if (cached) {
      for (let index = 0; index < checks.length; index++) checks[index]()
      return
    }
  }
  const accepted: Array<{ message: BaseMessage; completion: Completion }> = []
  for (const node of Object.keys(payload)) {
    for (const update of selectedValues(own(payload, node))) {
      if (!plain(update)) continue
      capturedObject(update)
      for (const value of selectedValues(own(update, "messages"))) {
        if (!value || typeof value !== "object" || types.isProxy(value)) continue
        const message = value as BaseMessage, completion = weakData(source.completions, message)
        if (!completion) continue
        const view = readFunctionConversationNativeNodeCompletion(completion.slot, source.graph, message)
        if (view.node !== node) fail()
        accepted.push({ message, completion })
      }
    }
  }
  source.assertCurrent()
  for (let index = 0; index < checks.length; index++) checks[index]()
  for (let index = 0; index < accepted.length; index++) {
    const { message, completion } = accepted[index]
    if (weakData(source.completions, message) !== completion) fail()
    const previous = weakData(source.writers, message)
    if (previous) { if (previous.slot !== completion.slot) fail(); continue }
    let failed = false, reading = false
    const assertDataCurrent = () => {
      try {
        if (failed || scopes.getStore() !== source || source.draining ||
          weakData(source.writers, message) !== witness || weakData(source.completions, message) !== completion)
          fail()
        if (source.invocation) Reflect.apply(throwIfAborted, source.invocation.signal, [])
        assertFunctionConversationNativeNodeSlotStructure(completion.slot)
        for (let index = 0; index < checks.length; index++) checks[index]()
      } catch (error) { failed = true; throw error }
    }
    const witness: FunctionNativeSuccessfulWriter = Object.freeze({ message,
      slot: completion.slot, assertDataCurrent,
      assertCurrent() {
        if (reading) { failed = true; fail() }
        reading = true
        try {
          assertDataCurrent()
          source.assertCurrent()
          readFunctionConversationNativeNodeCompletion(completion.slot, source.graph, message)
          assertDataCurrent()
        } catch (error) { failed = true; throw error }
        finally { reading = false }
      } })
    writeWeak(source.writers, message, witness)
    assertDataCurrent()
  }
}

/** Observe only the original iterator of this actual compiled graph, in a private invocation ALS. */
export function installFunctionConversationNativeSourceObserver(graph: object):
  FunctionConversationNativeSourceObserverInstallation {
  if (types.isProxy(graph) || !(graph instanceof CompiledStateGraph)) fail()
  const existing = weakData(observerGraphs, graph)
  if (existing) {
    readFunctionConversationNativeSourceObserverInstallation(existing, graph)
    return existing
  }
  const iteratorMethod = captureObserverMethod(graph, "_streamIterator")
  const streamMethod = captureObserverMethod(graph, "stream")
  const originalStream = streamMethod.original as StreamFactory
  const observedStream: StreamFactory = function (input, options) {
    const handoff = assertFunctionConversationSharedNativeStreamPreflightDispatch(graph, input, options)
    if (handoff) return handoff.promise
    const source = scopes.getStore()
    if (!source || source.graph !== graph) return originalStream.call(graph, input, options)
    source.assertCurrent()
    if (source.streamCaptured || (options !== undefined && !plain(options))) fail()
    const copied: Record<string, unknown> = {}
    if (options) for (const key of Reflect.ownKeys(options)) {
      if (typeof key !== "string") fail()
      Object.defineProperty(copied, key, { value: own(options, key), enumerable: true,
        writable: true, configurable: true })
    }
    const encoding = copied.encoding
    if (encoding !== undefined && encoding !== "text/event-stream") fail()
    if (source.invocation && copied.signal !== source.invocation.signal) fail()
    // ReactAgent has already merged its private defaults and initialized middleware. Pregel's
    // stream shell chooses its raw encoder before _streamIterator runs, so interception must
    // happen at this exact original method. Invoke itself supplies encoding: undefined.
    copied.encoding = undefined
    streamShape(graph, copied)
    source.streamCaptured = true
    if (encoding === "text/event-stream") source.encoding = encoding
    source.assertCurrent()
    return originalStream.call(graph, input, copied)
  }
  const original = iteratorMethod.original as IteratorFactory
  const observed: IteratorFactory = function (input, options) {
    assertFunctionConversationSharedNativeStreamIteratorEntry(graph, input, options)
    const source = scopes.getStore()
    if (!source || source.graph !== graph) return original.call(graph, input, options)
    source.assertCurrent()
    const shape = streamShape(graph, options)
    source.shape ??= shape
    // Command[] node outputs are invisible to StreamMessagesHandler's shallow chain-end scan.
    // Observe the original writers' updates privately, without enabling child passthrough.
    const observeCompletion = shape.modes.includes("messages")
    const actualModes = [...new Set([...shape.modes, "updates"])]
    const actualOptions = observeCompletion ? { ...options, streamMode: actualModes } : options
    source.actualShape ??= observeCompletion ? Object.freeze({ ...shape,
      modes: Object.freeze(actualModes), multiple: true }) : shape
    const token = Object.freeze({})
    let actual: ActualIterator
    try { actual = original.call(graph, input, actualOptions) }
    catch (error) { settle(source); throw error }
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      source.active.delete(token)
      settle(source)
    }
    const step = (run: () => Promise<IteratorResult<unknown, unknown>>) => {
      let result: Promise<IteratorResult<unknown, unknown>>
      try { result = scopes.run(source, run) }
      catch (error) { finish(); throw error }
      return result.then(value => {
        if (value.done) finish()
        else if (source.encoding === "text/event-stream" && source.invocation) {
          scopes.run(source, () => observeWriter(source, value.value))
          const shape = source.actualShape
          if (!shape || !value.value || typeof value.value !== "object") fail()
          const frame = value.value, position = shape.subgraphs ? 1 : 0
          const mode = shape.multiple ? own(frame, String(position)) : shape.modes[0]
          if (mode === "messages") {
            const tuple = shape.multiple || shape.subgraphs
              ? own(frame, String(position + (shape.multiple ? 1 : 0))) : frame
            const namespace = shape.subgraphs ? own(frame, "0") : undefined
            if (namespace !== undefined && !Array.isArray(namespace)) fail()
            const token = scopes.run(source, () => diagnostic(source, tuple,
              namespace as readonly string[] | undefined, frame))
            if (token) writeWeak(source.diagnostics, frame, token)
          }
        }
        return value
      }, error => {
        // The original generator's rejection includes its actual finally/runLoopPromise.
        finish()
        throw error
      })
    }
    const iterator: ActualIterator = {
      next: (...args: [] | [unknown]) => step(() => actual.next(...args)),
      return: value => step(() => actual.return(value)),
      throw: error => step(() => actual.throw(error)),
      [Symbol.asyncIterator]() { return this },
      async [Symbol.asyncDispose]() {
        let item = await this.return(undefined)
        while (!item.done) item = await this.next()
      }
    }
    let draining: Promise<void> | undefined
    const drain = (): Promise<void> => {
      if (!draining) {
        const pending = Promise.withResolvers<void>()
        draining = pending.promise
        void (async () => {
          let item = await iterator.return(undefined)
          while (!item.done) item = await iterator.next()
        })().then(pending.resolve, pending.reject)
      }
      void draining.catch(() => undefined)
      return draining
    }
    source.active.set(token, drain)
    if (source.draining) void drain().catch(() => undefined)
    return iterator
  }
  if (!Reflect.defineProperty(graph, "_streamIterator", {
    value: observed, writable: true, configurable: true
  })) fail()
  if (!Reflect.defineProperty(graph, "stream", {
    value: observedStream, writable: true, configurable: true
  })) fail()
  const installation = Object.freeze({ [observerBrand]: true as const })
  const iteratorField = Object.getOwnPropertyDescriptor(graph, "_streamIterator")
  const streamField = Object.getOwnPropertyDescriptor(graph, "stream")
  if (!iteratorField || !streamField) fail()
  const view: ObserverRecord["view"] = Object.freeze({ graph,
    assertDataCurrent: () => assertObserverData(record) })
  const origin: FunctionConversationNativeSourceObserverOrigin = Object.freeze({ graph,
    stream: streamMethod, iterator: iteratorMethod, streamField: Object.freeze(streamField),
    iteratorField: Object.freeze(iteratorField) })
  const record: ObserverRecord = { graph, prototype: Object.getPrototypeOf(graph) as object | null,
    iterator: iteratorMethod, stream: streamMethod,
    iteratorField: Object.freeze(iteratorField), streamField: Object.freeze(streamField),
    origin, view, sealing: false, sealed: false, failed: false }
  writeWeak(observerRecords, installation, record)
  writeWeak(observerGraphs, graph, installation)
  assertObserverData(record)
  return installation
}

/** One captured native call. The terminal contains no public metadata or reusable authority. */
export function createFunctionConversationNativeSourceLifetime(
  graph: object, assertCurrent: () => void,
  invocation?: Readonly<{ runtime: object; signal: AbortSignal }>
) {
  const installation = installFunctionConversationNativeSourceObserver(graph)
  return createFunctionConversationNativeSourceLifetimeFromInstallation(installation, assertCurrent,
    invocation)
}

/** Create one call only; installation is never repeated and the token supplies no ready authority. */
export function createFunctionConversationNativeSourceLifetimeFromInstallation(
  installation: FunctionConversationNativeSourceObserverInstallation, assertCurrent: () => void,
  invocation?: Readonly<{ runtime: object; signal: AbortSignal }>
) {
  const record = weakData(observerRecords, installation)
  if (!record) fail()
  assertObserverData(record)
  const graph = record.graph
  let resolve: () => void = () => undefined
  const terminal = new Promise<void>(done => { resolve = done })
  const source: Source = { graph, assertCurrent, active: new Map(), settle: resolve,
    completions: new WeakMap(), writers: new WeakMap(), emitted: new WeakSet(), opening: true,
    draining: false,
    diagnostics: new WeakMap(), ...(invocation ? { invocation: Object.freeze({ ...invocation }) } : {}),
    streamCaptured: false, sseSource: Object.freeze({ [sseSourceBrand]: true as const }) }
  writeWeak(sources, source.sseSource, source)
  let draining: Promise<void> | undefined
  return Object.freeze({
    run<T>(work: () => T): T { return scopes.run(source, work) },
    finishOpening(): void { source.opening = false; settle(source) },
    shape(): FunctionConversationNativeStreamShape | undefined { return source.shape },
    actualShape(): FunctionConversationNativeStreamShape | undefined { return source.actualShape },
    encoding(): "text/event-stream" | undefined { return source.encoding },
    diagnostic(value: unknown): FunctionNativeStreamDiagnostic | undefined {
      return value && typeof value === "object" ? weakData(source.diagnostics, value) : undefined
    },
    completionDiagnostic(completion: FunctionConversationNativeCompletionFrame,
      tuple: readonly unknown[]): FunctionNativeStreamDiagnostic | undefined {
      if (source.encoding !== "text/event-stream" || !source.invocation) return undefined
      const original = weakData(source.completions, completion.message)
      if (!original || original.metadata !== completion.metadata ||
        original.namespace !== completion.namespace) fail()
      readFunctionConversationNativeNodeCompletion(original.slot, graph, completion.message)
      return scopes.run(source, () => diagnostic(source, tuple, completion.namespace))
    },
    sseSource(): FunctionConversationNativeSseSource | undefined {
      return source.encoding === "text/event-stream" ? source.sseSource : undefined
    },
    completions(value: unknown): readonly FunctionConversationNativeCompletionFrame[] {
      source.assertCurrent()
      if (!plain(value)) return []
      const output: FunctionConversationNativeCompletionFrame[] = []
      const added = new WeakSet<BaseMessage>()
      for (const node of Object.keys(value)) {
        const update = own(value, node)
        for (const item of values(update)) {
          if (!plain(item)) continue
          const field = own(item, "messages")
          for (const candidate of values(field)) {
            if (!candidate || typeof candidate !== "object") continue
            const completion = weakData(source.completions, candidate as BaseMessage)
            if (!completion || Reflect.apply(nativeWeakHas, source.emitted, [candidate as BaseMessage]) ||
              Reflect.apply(nativeWeakHas, added, [candidate as BaseMessage])) continue
            const view = readFunctionConversationNativeNodeCompletion(
              completion.slot, graph, candidate as BaseMessage)
            if (view.node !== node) continue
            Reflect.apply(nativeWeakAdd, added, [candidate as BaseMessage])
            output.push(Object.freeze({ message: candidate as BaseMessage,
              metadata: completion.metadata, namespace: completion.namespace }))
          }
        }
      }
      source.assertCurrent()
      return output
    },
    acceptMessage(value: unknown): boolean {
      source.assertCurrent()
      if (!Array.isArray(value) || types.isProxy(value)) return true
      const message = own(value, "0")
      if (!message || typeof message !== "object") return true
      const completion = weakData(source.completions, message as BaseMessage)
      if (!completion) return true
      readFunctionConversationNativeNodeCompletion(completion.slot, graph, message as BaseMessage)
      if (Reflect.apply(nativeWeakHas, source.emitted, [message as BaseMessage])) return false
      Reflect.apply(nativeWeakAdd, source.emitted, [message as BaseMessage])
      source.assertCurrent()
      return true
    },
    drain(): Promise<void> {
      source.draining = true
      if (!draining) {
        const pending = Promise.withResolvers<void>()
        draining = pending.promise
        void (async () => {
          let failure: { error: unknown } | undefined
          while (source.active.size) {
            const results = await Promise.allSettled([...source.active.values()].map(close => close()))
            for (const result of results) if (result.status === "rejected")
              failure ??= { error: result.reason }
          }
          if (failure) throw failure.error
        })().then(pending.resolve, pending.reject)
      }
      void draining.catch(() => undefined)
      return draining
    },
    whenSettled(): Promise<void> { return terminal }
  })
}
