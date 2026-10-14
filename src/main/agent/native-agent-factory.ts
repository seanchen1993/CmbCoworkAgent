import { types } from "node:util"
import { createAgent } from "langchain"
import { CompiledStateGraph } from "@langchain/langgraph"
import { mergeConfigs, type RunnableConfig } from "@langchain/core/runnables"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { readFunctionConversationNativeSourceObserverOrigin,
  sealFunctionConversationNativeSourceObserverInstallation,
  type FunctionConversationNativeSourceObserverInstallation,
  type FunctionConversationNativeSourceObserverOrigin } from "./function-conversation-native-lifetime"

export interface FunctionNativeAgentDerivation {
  readonly graph: object
  readonly hasDefaultCancellation: boolean
  assertStructure(): void
  derive(config: RunnableConfig): object
  /** Cancellation data only; a genuine Main installation selects this private-cap route. */
  deriveCancellation(config: RunnableConfig): object
  resolve(config: RunnableConfig): RunnableConfig
  resolveCancellation(signal: AbortSignal): AbortSignal
}

interface OriginalAgent {
  readonly agent: object
  readonly prototype: object
  readonly graph: object
  readonly method: PropertyDescriptor
  readonly invokeMethod: PropertyDescriptor
  readonly graphInvoke: NativeMethodAddress
  readonly graphStream: NativeMethodAddress
  readonly graphIterator: NativeMethodAddress
  readonly graphGetState: NativeMethodAddress | undefined
  readonly graphGetter: PropertyDescriptor
  readonly options: PropertyDescriptor
  readonly defaults: RunnableConfig
  readonly defaultSignal?: AbortSignal
  readonly source: FunctionNativeAgentDerivation
  deriving?: { failed: boolean; reading: boolean; reads: number }
  dispatch?: {
    readonly graphInvoke: NativeMethodAddress
    readonly graphStream: NativeMethodAddress
    readonly graphIterator: NativeMethodAddress
    readonly invoke: (input: unknown, config: RunnableConfig) => Promise<unknown>
  }
}
interface NativeMethodAddress {
  readonly key: "invoke" | "stream" | "_streamIterator" | "getState"
  readonly path: readonly object[]
  readonly descriptor: PropertyDescriptor
}
const agents = new WeakMap<object, OriginalAgent>()
const agentWeakGet = WeakMap.prototype.get, agentWeakHas = WeakMap.prototype.has
const agentWeakSet = WeakMap.prototype.set
// Capture the SDK inheritance before any actual Factory options or constructor callbacks.
const originalGraphGetState = captureMethod(CompiledStateGraph.prototype, "getState")
export interface FunctionNativeAgentPreflightOrigin {
  readonly graph: object
  readonly original: (config: RunnableConfig) => unknown
  readonly path: readonly object[]
  readonly descriptor: Readonly<PropertyDescriptor>
  assertOriginalDataCurrent(): void
}
interface PreflightOriginRecord {
  readonly original: OriginalAgent
  readonly parent: PreflightOriginRecord | undefined
  readonly address: NativeMethodAddress | undefined
  readonly view: FunctionNativeAgentPreflightOrigin | undefined
  failed: boolean
}
const preflightOrigins = new WeakMap<OriginalAgent, PreflightOriginRecord>()
const observerSealBrand = Symbol("shared-native-observer-seal")
export interface SharedNativeObserverSealRequest { readonly [observerSealBrand]: true }
interface ObserverSealState {
  reading: boolean
  failed: boolean
  completed: boolean
  request: SharedNativeObserverSealRequest | undefined
}
interface ObserverSealRequestRecord {
  readonly original: OriginalAgent
  readonly state: ObserverSealState
  readonly installation: FunctionConversationNativeSourceObserverInstallation
  readonly origin: FunctionConversationNativeSourceObserverOrigin
  readonly beforeStream: PropertyDescriptor
  readonly beforeIterator: PropertyDescriptor
  readonly sealedStream: PropertyDescriptor
  readonly sealedIterator: PropertyDescriptor
  claimed: boolean
  used: boolean
  failed: boolean
}
const observerSeals = new WeakMap<OriginalAgent, ObserverSealState>()
const observerSealRequests = new WeakMap<SharedNativeObserverSealRequest, ObserverSealRequestRecord>()
function sealState(original: OriginalAgent): ObserverSealState | undefined {
  return Reflect.apply(agentWeakGet, observerSeals, [original]) as ObserverSealState | undefined
}
const signalPrototype = AbortSignal.prototype
const signalAbortedDescriptor = Object.getOwnPropertyDescriptor(signalPrototype, "aborted")!
const signalReasonDescriptor = Object.getOwnPropertyDescriptor(signalPrototype, "reason")!
const signalAborted = signalAbortedDescriptor.get!
const signalAny = AbortSignal.any
function agentRecord(agent: object): OriginalAgent | undefined {
  return Reflect.apply(agentWeakGet, agents, [agent]) as OriginalAgent | undefined
}

function fail(): never {
  throw new ModFunctionError("MODS_CONVERSATION_NATIVE_GRAPH_DERIVATION_INVALID")
}
function sameDescriptor(current: PropertyDescriptor | undefined, original: PropertyDescriptor) {
  return (
    !!current &&
    current.value === original.value &&
    current.get === original.get &&
    current.set === original.set &&
    current.writable === original.writable &&
    current.enumerable === original.enumerable &&
    current.configurable === original.configurable
  )
}
function captureMethod(value: object, key: NativeMethodAddress["key"]): NativeMethodAddress {
  const path: object[] = []
  let current: object | null = value
  while (current) {
    if (types.isProxy(current) || path.length >= 64) fail()
    path[path.length] = current
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function" ||
        types.isProxy(descriptor.value)) fail()
      return Object.freeze({ key, path: Object.freeze(path),
        descriptor: Object.freeze(descriptor) })
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  fail()
}
function assertMethod(address: NativeMethodAddress, first = 0): void {
  for (let index = first; index < address.path.length; index++) {
    const current = address.path[index]
    if (types.isProxy(current)) fail()
    const descriptor = Object.getOwnPropertyDescriptor(current, address.key)
    if (index === address.path.length - 1) {
      if (!sameDescriptor(descriptor, address.descriptor)) fail()
    } else if (descriptor || Object.getPrototypeOf(current) !== address.path[index + 1]) fail()
  }
}
function sameInheritedMethod(current: NativeMethodAddress, original: NativeMethodAddress): boolean {
  if (current.path.length !== original.path.length ||
    !sameDescriptor(current.descriptor, original.descriptor)) return false
  for (let index = 1; index < current.path.length; index++) {
    if (current.path[index] !== original.path[index]) return false
  }
  return true
}
function assertOriginalPrototypeMethod(address: NativeMethodAddress): void {
  if (address.path.length < 2 || Object.getPrototypeOf(address.path[0]) !== address.path[1]) fail()
  assertMethod(address, 1)
}
function matchesGetStateBaseline(address: NativeMethodAddress): boolean {
  if (address.path.length !== originalGraphGetState.path.length + 1 ||
    !sameDescriptor(address.descriptor, originalGraphGetState.descriptor)) return false
  for (let index = 0; index < originalGraphGetState.path.length; index++) {
    if (address.path[index + 1] !== originalGraphGetState.path[index]) return false
  }
  return true
}
function captureGetStateOrigin(graph: object): NativeMethodAddress | undefined {
  try {
    const address = captureMethod(graph, "getState")
    if (!matchesGetStateBaseline(address)) return undefined
    assertMethod(originalGraphGetState)
    return address
  } catch { return undefined }
}
function preflightRecord(original: OriginalAgent): PreflightOriginRecord | undefined {
  return Reflect.apply(agentWeakGet, preflightOrigins, [original]) as
    PreflightOriginRecord | undefined
}
function assertPreflightOrigin(record: PreflightOriginRecord): void {
  let current: PreflightOriginRecord | undefined = record
  let depth = 0
  try {
    while (current) {
      if (++depth > 64 || current.failed || preflightRecord(current.original) !== current ||
        !current.address || !current.view || current.original.graphGetState !== current.address ||
        current.address.path[0] !== current.original.graph ||
        !matchesGetStateBaseline(current.address)) fail()
      try {
        assertStructure(current.original)
        // A later own adapter is not certified here. Only the fixed inherited origin is read.
        assertOriginalPrototypeMethod(current.address)
        assertMethod(originalGraphGetState)
      } catch (error) { current.failed = true; throw error }
      const parent: PreflightOriginRecord | undefined = current.parent
      if (parent && (parent.original.graph === current.original.graph || !parent.address ||
        !sameInheritedMethod(current.address, parent.address))) fail()
      current = parent
    }
  } catch (error) { record.failed = true; throw error }
}
function registerPreflightOrigin(original: OriginalAgent, parent: OriginalAgent | undefined): void {
  const parentOrigin = parent ? preflightRecord(parent) : undefined
  const address = original.graphGetState
  const view: FunctionNativeAgentPreflightOrigin | undefined = address && Object.freeze({
    graph: original.graph,
    original: address.descriptor.value as (config: RunnableConfig) => unknown,
    path: address.path,
    descriptor: address.descriptor,
    assertOriginalDataCurrent: () => assertPreflightOrigin(record)
  })
  const record: PreflightOriginRecord = { original, parent: parentOrigin, address, view,
    failed: !address || !!parent && (!parentOrigin || parentOrigin.failed ||
      !parentOrigin.address || !sameInheritedMethod(address, parentOrigin.address)) }
  Reflect.apply(agentWeakSet, preflightOrigins, [original, record])
}
function assertStructure(original: OriginalAgent): void {
  if (sealState(original)?.failed) fail()
  if (
    agentRecord(original.agent) !== original ||
    Object.getPrototypeOf(original.agent) !== original.prototype ||
    Object.hasOwn(original.agent, "withConfig") ||
    Object.hasOwn(original.agent, "invoke") ||
    Object.hasOwn(original.agent, "graph") ||
    !sameDescriptor(
      Object.getOwnPropertyDescriptor(original.prototype, "withConfig"),
      original.method
    ) ||
    !sameDescriptor(
      Object.getOwnPropertyDescriptor(original.prototype, "invoke"),
      original.invokeMethod
    ) ||
    !sameDescriptor(
      Object.getOwnPropertyDescriptor(original.prototype, "graph"),
      original.graphGetter
    ) ||
    !sameDescriptor(Object.getOwnPropertyDescriptor(original.agent, "options"), original.options) ||
    Reflect.apply(original.graphGetter.get!, original.agent, []) !== original.graph
  )
    fail()
  assertMethod(original.dispatch?.graphInvoke ?? original.graphInvoke)
  if (original.dispatch) assertMethod(original.dispatch.graphIterator)
}

/** Copy own configuration data while preserving the original callback and tag addresses. */
function snapshotConfig(config: RunnableConfig, copyConfigurable = true): RunnableConfig {
  if (
    !config ||
    types.isProxy(config) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(config))
  )
    fail()
  const fields = Object.getOwnPropertyDescriptors(config)
  const keys = Reflect.ownKeys(fields)
  if (keys.length > 1_000_000) fail()
  for (const key of keys) {
    const field = fields[key as string]
    if (!field || !("value" in field)) fail()
    if (copyConfigurable && key === "configurable" && field.value !== undefined)
      field.value = snapshotConfig(field.value as RunnableConfig, false)
  }
  return Object.freeze(Object.create(Object.getPrototypeOf(config), fields)) as RunnableConfig
}
function projection(config: RunnableConfig): RunnableConfig {
  const output: Record<string, unknown> = {}
  for (const key of ["configurable", "streamMode", "subgraphs", "encoding"] as const) {
    const value = Object.getOwnPropertyDescriptor(config, key)
    if (value && "value" in value && value.enumerable)
      Object.defineProperty(output, key, { value: value.value, enumerable: true })
  }
  return output
}
function cancellationSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  try { Reflect.apply(signalAborted, value, []) }
  catch { fail() }
  // Node's original any() reads these public properties. Keep that original ordering
  // only for standard Signals; an intrinsic brand alone cannot make late getters safe.
  if (Object.getPrototypeOf(value) !== signalPrototype ||
    Object.getOwnPropertyDescriptor(value, "aborted") ||
    Object.getOwnPropertyDescriptor(value, "reason") ||
    !sameDescriptor(Object.getOwnPropertyDescriptor(signalPrototype, "aborted"),
      signalAbortedDescriptor) ||
    !sameDescriptor(Object.getOwnPropertyDescriptor(signalPrototype, "reason"),
      signalReasonDescriptor)) fail()
  return value as AbortSignal
}

/** Standard cancellation data only; this grants no graph, Source or installation identity. */
export function readFunctionConversationNativeStandardCancellationSignal(value: unknown):
  AbortSignal | undefined {
  return cancellationSignal(value)
}

function combineCancellation(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  if (first) cancellationSignal(first)
  cancellationSignal(second)
  const resolved = first
    ? Reflect.apply(signalAny, AbortSignal, [[first, second]]) as AbortSignal : second
  if (first) cancellationSignal(first)
  cancellationSignal(second)
  cancellationSignal(resolved)
  return resolved
}
function deriveOriginal(original: OriginalAgent, config: RunnableConfig, cancellation: boolean): object {
  if (original.deriving) { original.deriving.failed = true; fail() }
  const operation = { failed: false, reading: false, reads: 0 }
  original.deriving = operation
  try {
    assertStructure(original)
    assertOriginalPrototypeMethod(original.graphInvoke)
    assertOriginalPrototypeMethod(original.graphStream)
    if (original.dispatch) assertOriginalPrototypeMethod(original.graphIterator)
    const fixed = snapshotConfig(config)
    const field = Object.getOwnPropertyDescriptor(fixed, "signal")
    if (!cancellation && field?.value !== undefined) fail()
    const provided = cancellation && field?.enumerable ? cancellationSignal(field.value) : undefined
    let defaultSignal = original.defaultSignal
    let frameworkConfig = fixed
    const expectedReads = cancellation && field?.enumerable ? 1 : 0
    if (expectedReads) {
      const fields = Object.getOwnPropertyDescriptors(fixed)
      fields.signal = { enumerable: true, configurable: false, get() {
        if (operation.reading || operation.failed || operation.reads !== 0 ||
          original.deriving !== operation) { operation.failed = true; fail() }
        operation.reading = true
        operation.reads++
        try {
          if (provided) defaultSignal = combineCancellation(defaultSignal, provided)
          // The original Agent's private defaults never acquire an effective signal.
          return undefined
        } catch (error) { operation.failed = true; throw error }
        finally { operation.reading = false }
      } }
      frameworkConfig = Object.freeze(Object.create(Object.getPrototypeOf(fixed), fields)) as RunnableConfig
    }
    const limited = mergeConfigs(original.defaults, projection(fixed))
    const derived: unknown = Reflect.apply(original.method.value, original.agent, [frameworkConfig])
    assertStructure(original)
    if (operation.failed || operation.reading || operation.reads !== expectedReads ||
      original.deriving !== operation || !derived || typeof derived !== "object") fail()
    register(derived, original, limited, defaultSignal)
    if (operation.failed || original.deriving !== operation) fail()
    return derived
  } finally { original.deriving = undefined }
}
function register(
  agent: object,
  parent?: OriginalAgent,
  defaults: RunnableConfig = {},
  defaultSignal?: AbortSignal
): FunctionNativeAgentDerivation {
  if (types.isProxy(agent) || Reflect.apply(agentWeakHas, agents, [agent])) fail()
  const prototype: unknown = Object.getPrototypeOf(agent)
  if (
    !prototype ||
    typeof prototype !== "object" ||
    types.isProxy(prototype) ||
    (parent && prototype !== parent.prototype) ||
    Object.hasOwn(agent, "withConfig") ||
    Object.hasOwn(agent, "invoke") ||
    Object.hasOwn(agent, "graph")
  )
    fail()
  const method = Object.getOwnPropertyDescriptor(prototype, "withConfig")
  const invokeMethod = Object.getOwnPropertyDescriptor(prototype, "invoke")
  const graphGetter = Object.getOwnPropertyDescriptor(prototype, "graph")
  const options = Object.getOwnPropertyDescriptor(agent, "options")
  if (
    !method ||
    !("value" in method) ||
    typeof method.value !== "function" ||
    types.isProxy(method.value) ||
    !invokeMethod ||
    !("value" in invokeMethod) ||
    typeof invokeMethod.value !== "function" ||
    types.isProxy(invokeMethod.value) ||
    !graphGetter ||
    typeof graphGetter.get !== "function" ||
    types.isProxy(graphGetter.get) ||
    !options ||
    !("value" in options) ||
    !options.value ||
    typeof options.value !== "object" ||
    types.isProxy(options.value) ||
    (parent &&
      (!sameDescriptor(method, parent.method) ||
        !sameDescriptor(invokeMethod, parent.invokeMethod) ||
        !sameDescriptor(graphGetter, parent.graphGetter) ||
        options.value !== parent.options.value))
  )
    fail()
  const graph: unknown = Reflect.apply(graphGetter.get, agent, [])
  if (!graph || typeof graph !== "object" || types.isProxy(graph)) fail()
  const graphInvoke = captureMethod(graph, "invoke"), graphStream = captureMethod(graph, "stream")
  const graphIterator = captureMethod(graph, "_streamIterator")
  const graphGetState = captureGetStateOrigin(graph)
  if (graphInvoke.path.length < 2 || graphStream.path.length < 2) fail()
  if (parent && (graph === parent.graph ||
    !sameInheritedMethod(graphInvoke, parent.graphInvoke) ||
    !sameInheritedMethod(graphStream, parent.graphStream) ||
    (parent.dispatch && !sameInheritedMethod(graphIterator, parent.graphIterator)))) fail()
  const source = Object.freeze({
    graph,
    hasDefaultCancellation: defaultSignal !== undefined,
    assertStructure: () => assertStructure(original),
    derive: (config: RunnableConfig) => deriveOriginal(original, config, false),
    deriveCancellation: (config: RunnableConfig) => deriveOriginal(original, config, true),
    resolve(config: RunnableConfig) {
      assertStructure(original)
      const fixed = snapshotConfig(config)
      const resolved = { ...fixed, ...mergeConfigs(original.defaults, projection(fixed)) }
      assertStructure(original)
      return resolved
    },
    resolveCancellation(signal: AbortSignal) {
      assertStructure(original)
      const resolved = combineCancellation(original.defaultSignal, signal)
      assertStructure(original)
      return resolved
    }
  })
  const original: OriginalAgent = {
    agent,
    prototype,
    graph,
    method: Object.freeze(method),
    invokeMethod: Object.freeze(invokeMethod), graphInvoke, graphStream, graphIterator, graphGetState,
    graphGetter: Object.freeze(graphGetter),
    options: Object.freeze(options),
    defaults, defaultSignal, deriving: undefined, dispatch: undefined,
    source
  }
  Reflect.apply(agentWeakSet, agents, [agent, original])
  assertStructure(original)
  registerPreflightOrigin(original, parent)
  return source
}

/** No caller-supplied Agent, method or certification callback can enter the private factory map. */
export const createFunctionConversationNativeAgent: typeof createAgent = new Proxy(createAgent, {
  apply(target, receiver, args) {
    const agent = Reflect.apply(target, receiver, args)
    register(agent)
    return agent
  }
})

export function readFunctionConversationNativeAgentDerivation(
  agent: object
): FunctionNativeAgentDerivation | undefined {
  return agentRecord(agent)?.source
}

/** Original method data only: no execution, Scope, preflight receipt or Source is granted. */
export function readFunctionConversationNativeAgentPreflightOrigin(
  agent: object
): FunctionNativeAgentPreflightOrigin | undefined {
  const original = agentRecord(agent)
  if (!original) return undefined
  const record = preflightRecord(original)
  if (!record || !record.view) fail()
  assertPreflightOrigin(record)
  return record.view
}

/** Seal only a genuine Shared graph after its actual native installers have finished. */
export function sealFunctionConversationSharedNativeAgentDispatch(agent: object,
  installation?: FunctionConversationNativeSourceObserverInstallation): void {
  const original = agentRecord(agent)
  if (!original || original.dispatch) fail()
  if (installation !== undefined) {
    sealObservedDispatch(original, installation)
    return
  }
  assertStructure(original)
  assertMethod(original.graphStream)
  if (original.graphIterator.path.length < 2) fail()
  assertMethod(original.graphIterator)
  Object.defineProperty(original.graph, "invoke", { value: original.graphInvoke.descriptor.value,
    enumerable: original.graphInvoke.descriptor.enumerable, writable: false, configurable: false })
  Object.defineProperty(original.graph, "stream", { value: original.graphStream.descriptor.value,
    enumerable: original.graphStream.descriptor.enumerable, writable: false, configurable: false })
  Object.defineProperty(original.graph, "_streamIterator", {
    value: original.graphIterator.descriptor.value,
    enumerable: original.graphIterator.descriptor.enumerable, writable: false, configurable: false })
  const graphInvoke = captureMethod(original.graph, "invoke")
  const graphStream = captureMethod(original.graph, "stream")
  const graphIterator = captureMethod(original.graph, "_streamIterator")
  const invoke = async (input: unknown, config: RunnableConfig): Promise<unknown> => {
    assertStructure(original)
    assertMethod(graphStream)
    try { return await Reflect.apply(original.invokeMethod.value, original.agent, [input, config]) }
    finally { assertStructure(original); assertMethod(graphStream) }
  }
  original.dispatch = Object.freeze({ graphInvoke, graphStream, graphIterator, invoke })
  assertStructure(original)
  assertMethod(graphStream)
}

function assertObserverOrigin(original: OriginalAgent,
  origin: FunctionConversationNativeSourceObserverOrigin): void {
  if (origin.graph !== original.graph) fail()
  const methods = [original.graphStream, original.graphIterator] as const
  const observed = [origin.stream, origin.iterator] as const
  for (let index = 0; index < methods.length; index++) {
    const method = methods[index], captured = observed[index]
    assertOriginalPrototypeMethod(method)
    if (captured.key !== method.key || captured.original !== method.descriptor.value ||
      captured.path.length !== method.path.length) fail()
    for (let position = 0; position < method.path.length; position++) {
      if (captured.path[position] !== method.path[position]) fail()
      const expected = position === method.path.length - 1 ? method.descriptor : undefined
      const field = captured.fields[position]
      if (expected ? !sameDescriptor(field, expected) : field !== undefined) fail()
      if (position + 1 < method.path.length &&
        captured.prototypes[position] !== method.path[position + 1]) fail()
    }
  }
}

/** Failed requests still identify their own installation for permanent failure cleanup only. */
export function isFunctionConversationSharedNativeObserverSealRequest(
  request: SharedNativeObserverSealRequest,
  installation: FunctionConversationNativeSourceObserverInstallation, graph: object
): boolean {
  const record = Reflect.apply(agentWeakGet, observerSealRequests, [request]) as
    ObserverSealRequestRecord | undefined
  return !!record && record.installation === installation && record.original.graph === graph
}

/** Only the actual Factory's in-progress seal can be consumed by the Lifetime installation. */
export function claimFunctionConversationSharedNativeObserverSeal(
  request: SharedNativeObserverSealRequest,
  installation: FunctionConversationNativeSourceObserverInstallation, graph: object
) {
  const record = Reflect.apply(agentWeakGet, observerSealRequests, [request]) as
    ObserverSealRequestRecord | undefined
  // A foreign token cannot poison another actual graph or installation.
  if (!record || record.installation !== installation || record.original.graph !== graph) fail()
  const { original, state } = record
  const reject = (): never => { record.failed = true; state.failed = true; return fail() }
  if (record.claimed || record.used || record.failed || state.failed || !state.reading ||
    state.completed || state.request !== request || sealState(original) !== state) reject()
  record.claimed = true
  const check = (sealed: boolean) => {
    try {
      if (record.failed || record.used || state.failed || !state.reading || state.completed ||
        state.request !== request || sealState(original) !== state ||
        agentRecord(original.agent) !== original) fail()
      assertStructure(original)
      assertObserverOrigin(original, record.origin)
      if (!sameDescriptor(Object.getOwnPropertyDescriptor(graph, "stream"),
        sealed ? record.sealedStream : record.beforeStream) ||
        !sameDescriptor(Object.getOwnPropertyDescriptor(graph, "_streamIterator"),
          sealed ? record.sealedIterator : record.beforeIterator)) fail()
    } catch { reject() }
  }
  check(false)
  return Object.freeze({ graph, installation,
    assertBeforeDataCurrent: () => check(false), assertSealedDataCurrent: () => check(true) })
}

function sealObservedDispatch(original: OriginalAgent,
  installation: FunctionConversationNativeSourceObserverInstallation): void {
  const prior = sealState(original)
  if (prior) { prior.failed = true; fail() }
  const state: ObserverSealState = { reading: true, failed: false, completed: false,
    request: undefined }
  Reflect.apply(agentWeakSet, observerSeals, [original, state])
  let requestRecord: ObserverSealRequestRecord | undefined
  let completion: Readonly<{ invalidate(): void }> | undefined
  try {
    assertStructure(original)
    const origin = readFunctionConversationNativeSourceObserverOrigin(installation, original.graph)
    assertObserverOrigin(original, origin)
    const request = Object.freeze({ [observerSealBrand]: true as const })
    state.request = request
    const beforeStream = origin.streamField, beforeIterator = origin.iteratorField
    requestRecord = { original, state, installation, origin, beforeStream, beforeIterator,
      sealedStream: Object.freeze({ ...beforeStream, writable: false, configurable: false }),
      sealedIterator: Object.freeze({ ...beforeIterator, writable: false, configurable: false }),
      claimed: false, used: false, failed: false }
    Reflect.apply(agentWeakSet, observerSealRequests, [request, requestRecord])
    completion = sealFunctionConversationNativeSourceObserverInstallation(installation, request)
    if (state.failed || requestRecord.failed || !requestRecord.claimed) fail()
    assertStructure(original)
    assertObserverOrigin(original, origin)
    Object.defineProperty(original.graph, "invoke", { value: original.graphInvoke.descriptor.value,
      enumerable: original.graphInvoke.descriptor.enumerable, writable: false, configurable: false })
    const graphInvoke = captureMethod(original.graph, "invoke")
    const graphStream = captureMethod(original.graph, "stream")
    const graphIterator = captureMethod(original.graph, "_streamIterator")
    const invoke = async (input: unknown, config: RunnableConfig): Promise<unknown> => {
      assertStructure(original)
      assertMethod(graphStream)
      try { return await Reflect.apply(original.invokeMethod.value, original.agent, [input, config]) }
      finally { assertStructure(original); assertMethod(graphStream) }
    }
    original.dispatch = Object.freeze({ graphInvoke, graphStream, graphIterator, invoke })
    assertStructure(original)
    assertMethod(graphStream)
    if (state.failed || requestRecord.failed) fail()
    requestRecord.used = true
    state.completed = true
  } catch (error) {
    state.failed = true
    if (requestRecord) requestRecord.failed = true
    completion?.invalidate()
    throw error
  } finally { state.reading = false }
}

/** No late property lookup, bind or caller-made method can acquire the fixed Shared dispatch. */
export function readFunctionConversationNativeAgentInvoke(agent: object):
  ((input: unknown, config: RunnableConfig) => Promise<unknown>) | undefined {
  return agentRecord(agent)?.dispatch?.invoke
}
