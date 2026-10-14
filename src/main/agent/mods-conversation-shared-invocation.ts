import type { RunnableConfig } from "@langchain/core/runnables"
import { Command, isCommand } from "@langchain/langgraph"
import { createAgent } from "langchain"
import { types } from "node:util"
import type { BaseMessage } from "@langchain/core/messages"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { ModRuntimeAuthority } from "../mods/runtime-instance"
import { readFunctionConversationSharedProducer,
  type FunctionConversationSharedProducer } from "../mods/v2/conversation-shared-restore"
import { createFunctionConversationNativeHost } from "./function-conversation-native-host"
import { normalizeModelMessageIdentity } from "./model-message-identity"
import { installFunctionConversationNativeNode } from "./function-conversation-native-node"
import { installFunctionConversationNativeTools } from "./function-conversation-native-tools"
import { readFunctionConversationNativePolicySource } from "../mods/native-conversation-policy-source"
import { FUNCTION_CONVERSATION_CHANNEL } from "../checkpointer/function-conversation-delivery"
import type { FunctionConversationSharedCheckpointScope } from
  "../mods/v2/conversation-shared-checkpointer"
import { createFunctionConversationNativeAgent,
  readFunctionConversationNativeAgentDerivation, readFunctionConversationNativeAgentInvoke,
  sealFunctionConversationSharedNativeAgentDispatch } from "./native-agent-factory"
import { captureNativeMessage, constructCapturedNativeMessage } from "./native-message-capture"
import { captureNativeSharedOrdinaryMessageData,
  type NativeSharedOrdinaryMessageData } from "./native-shared-ordinary-message-data"
import { installFunctionConversationNativeSourceObserver } from
  "./function-conversation-native-lifetime"
import { prepareFunctionConversationSharedNativeStreamPreflight,
  finishFunctionConversationSharedNativeStreamPreflight,
  readFunctionConversationSharedNativeStreamObserver,
  runFunctionConversationSharedNativeStream } from
  "./function-conversation-shared-native-stream-state"
import { readFunctionConversationSharedCheckpointOpeningCurrent } from
  "../mods/v2/conversation-shared-checkpointer"
import { createSharedNativeStreamDriver, notifySharedNativeStreamAdmission,
  projectSharedNativeStreamEvent, routeSharedNativeStreamFrame } from
  "./function-conversation-shared-native-stream-driver"

import { createSharedNativeFactoryRecord, publishSharedNativeFactoryGraph,
  deriveSharedNativeFactoryRecord, readCurrentSharedNativeFamilyDomain,
  retireSharedNativeFactoryRecord,
  setSharedNativeDomainPhase, publishSharedNativeDomainView, readSharedNativeDomainCleanupView,
  isSharedNativeFactoryCurrent, isSharedNativeDomainCurrent, runSharedNativeFactoryDomain,
  currentSharedNativeDomainRecord,
  type SharedNativeFactoryRecord, type SharedNativeDomainRecord,
  type FunctionConversationSharedNativeDomainView,
  type FunctionConversationSharedNativeOptions } from "./function-conversation-shared-native-domain"
export { readCurrentFunctionConversationSharedNativeDomain,
  readFunctionConversationSharedNativeFactory } from "./function-conversation-shared-native-domain"
export type { FunctionConversationSharedNativeFactory, FunctionConversationSharedNativeDomain,
  FunctionConversationSharedNativeDomainView } from "./function-conversation-shared-native-domain"
function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_NATIVE_SOURCE_INVALID") }
const retiringInstallations = new Set<SharedNativeFactoryRecord>()
const returnMapGet = Map.prototype.get, returnMapSet = Map.prototype.set
interface NativeReturnData { assertDataCurrent(): void }
interface NativeReturnSources {
  capture(message: BaseMessage): NativeReturnData | undefined
  assertOriginalDataCurrent(): void
  assertDataCurrent(): void
}

function captureReturnContainer(value: object): () => void {
  if (types.isProxy(value)) fail()
  const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
  const fields: PropertyDescriptor[] = []
  for (let index = 0; index < keys.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, keys[index])
    if (!field || !("value" in field)) fail()
    fields[index] = field
  }
  return () => {
    if (types.isProxy(value) || Object.getPrototypeOf(value) !== prototype) fail()
    const current = Reflect.ownKeys(value)
    if (current.length !== keys.length) fail()
    for (let index = 0; index < keys.length; index++)
      if (current[index] !== keys[index] ||
        !sameReturnField(Object.getOwnPropertyDescriptor(value, keys[index]), fields[index])) fail()
  }
}

function captureReturnArray(value: unknown): { values: unknown[]; check(): void } {
  if (!Array.isArray(value) || types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype) fail()
  const length = Object.getOwnPropertyDescriptor(value, "length")
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 ||
    length.value > 1_000_000 || Reflect.ownKeys(value).length !== length.value + 1) fail()
  const check = captureReturnContainer(value), values: unknown[] = []
  for (let index = 0; index < length.value; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    if (!field || !("value" in field)) fail()
    values[index] = field.value
  }
  return { values, check }
}

function captureCommandReturnSources(value: object): NativeReturnSources {
  const check = captureReturnContainer(value), checks: Array<() => void> = [check]
  const children: NativeReturnSources[] = []
  const update = Object.getOwnPropertyDescriptor(value, "update")
  if (!update || !("value" in update)) fail()
  const add = (messages: unknown): void => {
    children[children.length] = captureNativeReturnSources({
      messages: Array.isArray(messages) ? messages : [messages] })
  }
  if (update.value !== undefined) {
    if (Array.isArray(update.value)) {
      const array = captureReturnArray(update.value)
      checks[checks.length] = array.check
      for (let index = 0; index < array.values.length; index++) {
        const pair = captureReturnArray(array.values[index])
        if (pair.values.length !== 2 || typeof pair.values[0] !== "string") fail()
        checks[checks.length] = pair.check
        if (pair.values[0] === "messages") add(pair.values[1])
      }
    } else {
      const state: unknown = update.value
      if (!state || typeof state !== "object" || types.isProxy(state) ||
        (Object.getPrototypeOf(state) !== Object.prototype && Object.getPrototypeOf(state) !== null)) fail()
      checks[checks.length] = captureReturnContainer(state)
      const messages = Object.getOwnPropertyDescriptor(state, "messages")
      if (messages && !("value" in messages)) fail()
      if (messages?.value !== undefined) add(messages.value)
    }
  }
  const goto = Object.getOwnPropertyDescriptor(value, "goto")
  if (!goto || !("value" in goto)) fail()
  if (Array.isArray(goto.value)) checks[checks.length] = captureReturnArray(goto.value).check
  let failed = false
  const assertData = (original: boolean): void => {
    try {
      if (failed) fail()
      for (let index = 0; index < checks.length; index++) checks[index]()
      for (let index = 0; index < children.length; index++) {
        if (original) children[index].assertOriginalDataCurrent()
        else children[index].assertDataCurrent()
      }
    } catch (error) { failed = true; throw error }
  }
  return Object.freeze({ assertOriginalDataCurrent: () => assertData(true),
    assertDataCurrent: () => assertData(false), capture(message: BaseMessage) {
      try {
        if (failed) fail()
        for (let index = 0; index < checks.length; index++) checks[index]()
        for (let index = 0; index < children.length; index++) {
          const source = children[index].capture(message)
          if (source) return source
        }
        return undefined
      } catch (error) { failed = true; throw error }
    } })
}

/** The actual admitted input or initial tuple supplies addresses, never the returned state. */
function captureNativeReturnSources(value: unknown): NativeReturnSources {
  const sources = new Map<BaseMessage, NativeSharedOrdinaryMessageData>()
  const baselines: NativeSharedOrdinaryMessageData[] = []
  let check = (): void => undefined
  if (value !== null && typeof value === "object") {
    if (types.isProxy(value)) fail()
    const prototype = Object.getPrototypeOf(value)
    if (prototype === Command.prototype) return captureCommandReturnSources(value)
    if (prototype !== Object.prototype && prototype !== null) fail()
    const container = captureReturnContainer(value)
    const field = Object.getOwnPropertyDescriptor(value, "messages")
    if (field && !("value" in field)) fail()
    if (field?.value !== undefined) {
      const messages: unknown = field.value
      if (!Array.isArray(messages) || types.isProxy(messages) ||
        Object.getPrototypeOf(messages) !== Array.prototype) fail()
      const length = Object.getOwnPropertyDescriptor(messages, "length")
      if (!length || !("value" in length) || !Number.isSafeInteger(length.value) ||
        length.value < 0 || length.value > 1_000_000 ||
        Reflect.ownKeys(messages).length !== length.value + 1) fail()
      const fields: PropertyDescriptor[] = []
      for (let index = 0; index < length.value; index++) {
        const item = Object.getOwnPropertyDescriptor(messages, String(index))
        if (!item || !("value" in item)) fail()
        fields[index] = item
        const baseline = captureNativeSharedOrdinaryMessageData(item.value as BaseMessage)
        baselines[index] = baseline
        Reflect.apply(returnMapSet, sources, [baseline.message, baseline])
      }
      check = () => {
        container()
        if (types.isProxy(value) || Object.getPrototypeOf(value) !== prototype ||
          !sameReturnField(Object.getOwnPropertyDescriptor(value, "messages"), field) ||
          types.isProxy(messages) || Object.getPrototypeOf(messages) !== Array.prototype ||
          Reflect.ownKeys(messages).length !== length.value + 1 ||
          !sameReturnField(Object.getOwnPropertyDescriptor(messages, "length"), length)) fail()
        for (let index = 0; index < fields.length; index++)
          if (!sameReturnField(Object.getOwnPropertyDescriptor(messages, String(index)),
            fields[index])) fail()
      }
    } else {
      check = () => {
        container()
        const current = Object.getOwnPropertyDescriptor(value, "messages")
        if (types.isProxy(value) || Object.getPrototypeOf(value) !== prototype ||
          (field ? !sameReturnField(current, field) : current !== undefined)) fail()
      }
    }
  }
  let failed = false
  const assertData = (original: boolean): void => {
    try {
      if (failed) fail()
      check()
      for (let index = 0; index < baselines.length; index++) {
        if (original) baselines[index].assertOriginalDataCurrent()
        else baselines[index].assertInitialDataCurrent()
      }
      check()
    } catch (error) { failed = true; throw error }
  }
  return Object.freeze({ assertOriginalDataCurrent: () => assertData(true),
    assertDataCurrent: () => assertData(false), capture(message: BaseMessage) {
    try {
      if (failed) fail()
      check()
      const baseline = Reflect.apply(returnMapGet, sources, [message]) as
        NativeSharedOrdinaryMessageData | undefined
      return baseline?.captureCurrentData()
    } catch (error) { failed = true; throw error }
  } })
}

function sameReturnField(current: PropertyDescriptor | undefined,
  original: PropertyDescriptor): boolean {
  return !!current && "value" in current && current.value === original.value &&
    current.enumerable === original.enumerable && current.writable === original.writable &&
    current.configurable === original.configurable
}

/** Native admission never calls SDK type guards or a constructor on caller-owned data. */
function withoutNativeConversationChannel(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (types.isProxy(value)) fail()
  const prototype = Object.getPrototypeOf(value)
  if (prototype === Command.prototype) {
    const fields = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(value)
    for (let index = 0; index < keys.length; index++)
      if (!fields[keys[index] as string] || !("value" in fields[keys[index] as string])) fail()
    const field = Object.getOwnPropertyDescriptor(value, "update")
    if (!field || !("value" in field)) fail()
    let update: unknown = field.value
    if (Array.isArray(update)) {
      const array = captureReturnArray(update), copied: unknown[] = []
      let changed = false
      for (let index = 0; index < array.values.length; index++) {
        const pair = captureReturnArray(array.values[index])
        if (pair.values.length !== 2 || typeof pair.values[0] !== "string") fail()
        if (pair.values[0] === FUNCTION_CONVERSATION_CHANNEL) changed = true
        else copied[copied.length] = array.values[index]
      }
      if (changed) update = copied
    } else update = withoutNativeConversationChannel(update)
    // The original SDK validates a Command by replacing its update in place. Only
    // the private root may receive that assignment; caller provenance stays fixed.
    if (update === field.value) return Object.create(prototype, fields)
    fields.update = { ...field, value: update }
    const commandSymbol = Symbol.for("langgraph.command")
    const argumentsField = Object.getOwnPropertyDescriptor(value, commandSymbol)
    if (!argumentsField || !("value" in argumentsField) || !argumentsField.value ||
      typeof argumentsField.value !== "object" || types.isProxy(argumentsField.value)) fail()
    const argumentsValue: object = argumentsField.value
    const argumentsFields = Object.getOwnPropertyDescriptors(argumentsValue)
    const argumentsKeys = Reflect.ownKeys(argumentsValue)
    for (let index = 0; index < argumentsKeys.length; index++) {
      const property = Object.getOwnPropertyDescriptor(argumentsValue, argumentsKeys[index])
      if (!property || !("value" in property)) fail()
    }
    const argumentsUpdate = Object.getOwnPropertyDescriptor(argumentsValue, "update")
    if (!argumentsUpdate || !("value" in argumentsUpdate) || argumentsUpdate.value !== field.value) fail()
    argumentsFields.update = { ...argumentsUpdate, value: update }
    Object.defineProperty(fields, commandSymbol, { value: { ...argumentsField,
      value: Object.create(Object.getPrototypeOf(argumentsValue), argumentsFields) }, enumerable: true,
      writable: true, configurable: true })
    return Object.create(prototype, fields)
  }
  if (prototype !== Object.prototype && prototype !== null) fail()
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value)
  for (let index = 0; index < keys.length; index++)
    if (!fields[keys[index] as string] || !("value" in fields[keys[index] as string])) fail()
  if (!Object.hasOwn(fields, FUNCTION_CONVERSATION_CHANNEL)) return value
  delete fields[FUNCTION_CONVERSATION_CHANNEL]
  return Object.create(prototype, fields)
}

/** Unknown cleanup retains only the failed new installation, never its original assistant. */
function retireSharedInstallation(factory: SharedNativeFactoryRecord): Promise<void> {
  retireSharedNativeFactoryRecord(factory)
  retiringInstallations.add(factory)
  let closeFailed = false
  try { factory.tools?.close() } catch { closeFailed = true }
  for (const node of factory.nodes) {
    try { node.close() } catch { closeFailed = true }
  }
  const cleanup = Promise.allSettled([
    ...factory.nodes.map(node => Promise.resolve().then(() => node.whenDrained())),
    Promise.resolve().then(() => factory.tools?.whenDrained())
  ]).then(results => {
    if (closeFailed || results.some(result => result.status === "rejected"))
      throw new ModFunctionError("MODS_CONVERSATION_NATIVE_NODE_DRAIN_UNKNOWN")
    retiringInstallations.delete(factory)
  })
  void cleanup.catch(() => { /* An unknown child remains retained and unavailable. */ })
  return cleanup
}

/** Only the actual shared Saver admission can activate the factory's already-created domain. */
export function admitFunctionConversationSharedNativeInvocation(
  scope: FunctionConversationSharedCheckpointScope, proof: FunctionConversationSharedProducer,
  authority: ModRuntimeAuthority): void {
  const domain = currentSharedNativeDomainRecord()
  if (!domain) return
  if (!isSharedNativeDomainCurrent(domain) || domain.scope !== scope ||
    domain.phase !== "created") fail()
  setSharedNativeDomainPhase(domain, "preparing")
  let createdHost: ReturnType<typeof createFunctionConversationNativeHost> | undefined
  try {
    const original = readFunctionConversationSharedProducer(proof, authority)
    if (!isSharedNativeDomainCurrent(domain)) fail()
    const factory = domain.factory
    if (original.scope !== scope || !isSharedNativeFactoryCurrent(factory) || !factory.graph)
      fail()
    const options = factory.options
    const runtime = options.captureRuntime(authority)
    if (!isSharedNativeDomainCurrent(domain) || !isSharedNativeFactoryCurrent(factory)) fail()
    if (!runtime || runtime.target !== original.target || runtime.binding !== original.binding ||
      runtime.owner !== original.owner || runtime.run !== original.invocation ||
      runtime.database !== original.database || runtime.signal !== original.signal ||
      runtime.destination.threadId !== original.destination.destinationThreadId) fail()
    const admission = runtime.capturePolicy()
    if (!isSharedNativeDomainCurrent(domain) || !isSharedNativeFactoryCurrent(factory)) fail()
    const policy = readFunctionConversationNativePolicySource(admission, runtime)
    if (!policy) fail()
    policy.assertCurrent()
    policy.assertTail()
    original.assertDataCurrent()
    if (!isSharedNativeDomainCurrent(domain) || !isSharedNativeFactoryCurrent(factory)) fail()
    const assertDataCurrent = () => {
      if (!isSharedNativeDomainCurrent(domain) || domain.phase !== "ready" ||
        !isSharedNativeFactoryCurrent(factory) || domain.view !== view ||
        domain.original !== original) fail()
      original.assertDataCurrent()
    }
    const assertCurrent = () => {
      assertDataCurrent()
      runtime.assertCurrent()
      assertDataCurrent()
    }
    const host = createFunctionConversationNativeHost({ runtime, store: options.store,
      agentId: options.agentId, model: options.model,
      sharedSource: { proof, authority },
      flush: uuid => options.flush(runtime, uuid) })
    createdHost = host
    const history = original.history
    const historySources = history ? captureNativeReturnSources({ messages: history.messages }) :
      captureNativeReturnSources(undefined)
    if (history) {
      history.assertDataCurrent()
      host.registerHistorical(history.messages, history.membership, history.historicalTarget)
      historySources.assertDataCurrent()
      history.assertDataCurrent()
    }
    const view: FunctionConversationSharedNativeDomainView = Object.freeze({ factory: factory.token,
      domain: domain.token, runtime, host, assertCurrent, assertDataCurrent,
      captureReturnHistorySource: historySources.capture,
      assertReturnHistoryCurrent: history ? history.assertCurrent : () => undefined,
      assertReturnHistoryData: () => {
        history?.assertDataCurrent()
        historySources.assertDataCurrent()
      } })
    publishSharedNativeDomainView(domain, original, view)
    assertCurrent()
    if (factory.tools) host.attachSharedTools(factory.token, domain.token, factory.graph, factory.tools)
    assertCurrent()
    notifySharedNativeStreamAdmission(domain)
  } catch (error) {
    setSharedNativeDomainPhase(domain, "failed")
    const cleanupHost = createdHost ?? readSharedNativeDomainCleanupView(domain)?.host
    cleanupHost?.close()
    throw error
  }
}

/** Snapshot the actual ToolNode config before its invocation reaches any asynchronous work. */
export function captureFunctionConversationNativeTaskConfig(config: RunnableConfig): RunnableConfig {
  const configurable = { ...config.configurable }
  const map = configurable.checkpoint_map
  if (map && typeof map === "object" && !Array.isArray(map))
    configurable.checkpoint_map = Object.freeze({ ...map })
  return Object.freeze({ ...config, configurable: Object.freeze(configurable) })
}

/** The actual createAgent result owns this preflight address, without matching a public shape. */
export function createFunctionConversationSharedAgent(
  options: Omit<Parameters<typeof createAgent>[0], "responseFormat"> & {
    responseFormat?: Parameters<typeof createAgent>[0]["responseFormat"]
  },
  capture: () => FunctionConversationSharedCheckpointScope | undefined,
  native?: FunctionConversationSharedNativeOptions
): ReturnType<typeof createAgent> {
  const factory = native ? createSharedNativeFactoryRecord(native, capture) : undefined
  const nativeMiddleware = factory ? {
    name: "sharedNativeConversationProducer",
    wrapModelCall: (request: unknown, handler: unknown) => {
      const domain = readCurrentSharedNativeFamilyDomain(factory)
      if (!domain) return (handler as (request: unknown) => unknown)(request)
      domain.assertCurrent()
      const hook = domain.host.middleware.wrapModelCall
      if (!hook) fail()
      return Reflect.apply(hook, domain.host.middleware, [request, handler])
    }
  } : undefined
  const identityMiddleware = {
    name: "sharedFallbackModelMessageIdentity",
    wrapModelCall: async (request: unknown, handler: unknown) => {
      // Pin the actual family domain before awaiting. A revoked Native call must never
      // be reclassified as ordinary after its original provider binding was captured.
      const nativeDomain = factory ? readCurrentSharedNativeFamilyDomain(factory) : undefined
      const response = await (handler as (request: unknown) => Promise<unknown>)(request)
      if (!nativeDomain) normalizeModelMessageIdentity(response,
        (request as { state: { messages: BaseMessage[] } }).state.messages)
      return response
    }
  }
  const graph = (native ? createFunctionConversationNativeAgent : createAgent)({ ...options,
    middleware: [...(nativeMiddleware ? [nativeMiddleware] : []), ...(options.middleware ?? []),
      identityMiddleware]
  } as Parameters<typeof createAgent>[0])
  try {
    installSharedInvocationGraph(graph, capture, factory)
    return wrapSharedInvocation(graph, capture, factory)
  } catch (error) {
    if (factory) void retireSharedInstallation(factory)
    throw error
  }
}

/** Install the full graph before publishing its routing address. A failed child stays private. */
function installSharedInvocationGraph(graph: ReturnType<typeof createAgent>,
  capture: () => FunctionConversationSharedCheckpointScope | undefined,
  factory?: SharedNativeFactoryRecord): void {
  const source = factory ? readFunctionConversationNativeAgentDerivation(graph) : undefined
  if (factory && !source) fail()
  source?.assertStructure()
  const actualGraph = graph.graph
  if (factory) {
    if (actualGraph.nodes.tools)
      factory.tools = installFunctionConversationNativeTools({ graph: actualGraph,
        sharedFactory: factory.token })
    for (const node of ["model_request", "tools"] as const) {
      if (!actualGraph.nodes[node]) continue
      factory.nodes.push(installFunctionConversationNativeNode({ graph: actualGraph, node,
        sharedFactory: factory.token, assertCurrent: fail, finalize: async () => fail() }))
    }
  }
  if (factory) {
    const prepared = prepareFunctionConversationSharedNativeStreamPreflight(graph, capture)
    if (prepared.graph !== actualGraph) fail()
    Object.defineProperty(actualGraph, "getState", { value: prepared.adapter,
      enumerable: true, writable: true, configurable: true })
    const observer = installFunctionConversationNativeSourceObserver(actualGraph)
    sealFunctionConversationSharedNativeAgentDispatch(graph, observer)
    Object.defineProperty(actualGraph, "getState", { value: prepared.adapter,
      enumerable: true, writable: false, configurable: false })
    source!.assertStructure()
    publishSharedNativeFactoryGraph(factory, actualGraph, graph)
    finishFunctionConversationSharedNativeStreamPreflight(graph, factory.token, observer)
    return
  }
  const getState = actualGraph.getState.bind(actualGraph)
  // The generic factory keeps its original preflight and capture behavior.
  actualGraph.getState = (...args: Parameters<typeof getState>) => {
    const scope = capture()
    return scope ? scope.preflight(args[0], () => getState(...args)) : getState(...args)
  }
  source?.assertStructure()
}

function assertNativeSharedInvokeConfig(config: RunnableConfig): void {
  const field = (key: string): unknown => {
    const value = Object.getOwnPropertyDescriptor(config, key)
    if (value && !("value" in value)) fail()
    return value?.value
  }
  const mode = field("streamMode"), subgraphs = field("subgraphs")
  if ((mode !== undefined && mode !== "values") ||
    (subgraphs !== undefined && subgraphs !== false) || field("encoding") !== undefined) fail()
}

function assertNativeSharedStreamDefaults(config: RunnableConfig): void {
  const field = (key: string): unknown => {
    const value = Object.getOwnPropertyDescriptor(config, key)
    if (value && !("value" in value)) fail()
    return value?.value
  }
  const mode = field("streamMode"), subgraphs = field("subgraphs")
  const allowed = (value: unknown) => value === "values" || value === "updates" || value === "messages"
  if (mode !== undefined && !allowed(mode)) {
    const modes = captureReturnArray(mode).values
    if (!modes.length) fail()
    for (let index = 0; index < modes.length; index++) if (!allowed(modes[index])) fail()
  }
  if ((subgraphs !== undefined && subgraphs !== false) || field("encoding") !== undefined) fail()
}

/** The known native factory owns this callback; neither task arguments nor SDK config select it. */
export function wrapFunctionConversationSharedInvocation<T extends object>(graph: T,
  capture: () => FunctionConversationSharedCheckpointScope | undefined
): T {
  return wrapSharedInvocation(graph, capture)
}

function wrapSharedInvocation<T extends object>(graph: T,
  capture: () => FunctionConversationSharedCheckpointScope | undefined, factory?: SharedNativeFactoryRecord): T {
  const methods = new Map<PropertyKey, unknown>()
  const source = factory ? readFunctionConversationNativeAgentDerivation(graph) : undefined
  if (factory && (!source || source.graph !== factory.graph)) fail()
  let deriving: { failed: boolean } | undefined
  const cleanup = new Set<Promise<unknown>>()
  const derive = (config: RunnableConfig) => {
    if (deriving) { deriving.failed = true; fail() }
    const operation = { failed: false }
    deriving = operation
    let child: SharedNativeFactoryRecord | undefined
    let published = false
    try {
      source!.assertStructure()
      assertNativeSharedStreamDefaults(source!.resolve(config))
      const result = deriveSharedNativeFactoryRecord(factory!, config)
      child = result.factory
      if (operation.failed || deriving !== operation) fail()
      installSharedInvocationGraph(result.agent as ReturnType<typeof createAgent>, capture, child)
      source!.assertStructure()
      if (operation.failed || deriving !== operation) fail()
      const wrapped = wrapSharedInvocation(result.agent, capture, child)
      if (operation.failed || deriving !== operation) fail()
      published = true
      return wrapped
    } finally {
      deriving = undefined
      if (child && !published) {
        const drained = retireSharedInstallation(child)
        cleanup.add(drained)
        void drained.then(() => cleanup.delete(drained), () => cleanup.delete(drained))
      }
    }
  }
  return new Proxy(graph, { get(target, key) {
    if (key === "withConfig" && factory) return derive
    const value = key === "invoke" && factory
      ? readFunctionConversationNativeAgentInvoke(target) : Reflect.get(target, key, target)
    if (key === "invoke" && factory && typeof value !== "function") fail()
    if (typeof value !== "function") return value
    if (!methods.has(key)) {
      if (factory && (key === "stream" || key === "streamEvents")) {
        const mode = key === "stream" ? "stream" : "events"
        const start = (input: unknown, config: RunnableConfig = {}, ...rest: unknown[]) => {
          const initial = captureNativeReturnSources(input)
          const driver = createSharedNativeStreamDriver(mode, async running => {
            if (deriving) { deriving.failed = true; fail() }
            source!.assertStructure()
            const resolved = source!.resolve(config)
            // SSE keeps its separate encoder/diagnostic path. This entry returns typed data.
            if (Object.getOwnPropertyDescriptor(resolved, "encoding")?.value !== undefined)
              throw new ModFunctionError("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
            await Promise.all([...cleanup])
            source!.assertStructure()
            running.signal.throwIfAborted()
            const scope = capture()
            if (!scope || !factory.graph) fail()
            const opening = readFunctionConversationSharedCheckpointOpeningCurrent(scope)
            if (!opening) fail()
            initial.assertOriginalDataCurrent()
            const admitted = withoutNativeConversationChannel(input)
            const fixed = { ...resolved, configurable: { ...resolved.configurable,
              __pregel_checkpointer: scope.checkpointer } }
            return runSharedNativeFactoryDomain(factory, scope, domain => {
              const configured = running.attach(domain, opening,
                readFunctionConversationSharedNativeStreamObserver(factory.graph!), fixed)
              return scope.run(async () => {
                let rejected = false, reason: unknown
                try {
                  initial.assertOriginalDataCurrent()
                  if (mode === "stream") {
                    await runFunctionConversationSharedNativeStream(factory.graph!, admitted,
                      configured, scope, initial.assertOriginalDataCurrent,
                      start => running.consume(start, (frame, lifetime, view) => {
                        initial.assertDataCurrent()
                        view.assertReturnHistoryData?.()
                        const output = routeSharedNativeStreamFrame(frame, lifetime, view,
                          (selected, payload) => copySharedNativeStreamPayload(selected, payload, view, initial))
                        view.assertDataCurrent()
                        initial.assertDataCurrent()
                        return output
                      }))
                  } else {
                    await running.consume(() => Reflect.apply(value, target, [admitted, configured, ...rest]),
                      (frame, lifetime, view) => {
                        initial.assertDataCurrent()
                        view.assertReturnHistoryData?.()
                        const output = projectSharedNativeStreamEvent(frame, view, lifetime)
                        initial.assertDataCurrent()
                        return [{ value: output, assertCurrent() {
                          initial.assertDataCurrent()
                          view.assertReturnHistoryData?.()
                          view.assertDataCurrent()
                        } }]
                      })
                  }
                } catch (error) { rejected = true; reason = error }
                finally { await closeSharedNativeStreamDomain(factory, domain, scope) }
                if (rejected) throw reason
              })
            })
          })
          // ReactAgent.streamEvents is synchronous and can be returned without any pull.
          return mode === "events" ? driver.stream : driver.open()
        }
        methods.set(key, mode === "stream"
          ? async (...args: Parameters<typeof start>) => start(...args) : start)
      } else if (key === "invoke") {
        const invoke = (factory ? value : value.bind(target)) as
          (input: unknown, config: RunnableConfig) => Promise<unknown>
        methods.set(key, async (input: unknown, config: RunnableConfig = {}) => {
          let inputCapture: { sources?: NativeReturnSources; failed: boolean; reason?: unknown } | undefined
          if (factory) {
            try { inputCapture = { sources: captureNativeReturnSources(input), failed: false } }
            catch (error) { inputCapture = { failed: true, reason: error } }
          }
          if (deriving) { deriving.failed = true; fail() }
          if (source) {
            source.assertStructure()
            config = source.resolve(config)
            assertNativeSharedInvokeConfig(config)
            await Promise.all([...cleanup])
            source.assertStructure()
          }
          const scope = capture()
          if (scope && factory) {
            if (!inputCapture || inputCapture.failed || !inputCapture.sources) fail()
            inputCapture.sources.assertOriginalDataCurrent()
          }
          const admitted = scope && factory ? withoutNativeConversationChannel(input) :
            withoutConversationChannel(input)
          const fixed = { ...config, configurable: { ...config.configurable,
            ...(scope ? { __pregel_checkpointer: scope.checkpointer } : {}) } }
          if (scope && factory) {
            return runSharedNativeFactoryDomain(factory, scope, domain => {
              const initial = inputCapture?.sources
              if (!initial) fail()
              return scope.run(async () => {
              let failed = false, failure: unknown, cleanupFailed = false, output: unknown
              try {
                initial.assertOriginalDataCurrent()
                const result = await invoke(admitted, fixed)
                const view = readSharedNativeDomainCleanupView(domain)
                if (!view) fail()
                // All actual work settles before the last result authentication. Cleanup
                // cannot publish a result that was modified by a late physical callback.
                const settled = await Promise.allSettled([
                  ...factory.nodes.map(node => Promise.resolve().then(() =>
                    node.whenDrainedForSharedDomain(domain.token))),
                  Promise.resolve().then(() => view.host.whenDrained())
                ])
                if (settled.some(value => value.status === "rejected")) {
                  scope.quarantineNativeWork()
                  throw new ModFunctionError("MODS_CONVERSATION_NATIVE_NODE_DRAIN_UNKNOWN")
                }
                const returned = prepareNativeConversationReturn(result, message =>
                  view.host.captureReturnMessageSource(message) ?? initial.capture(message) ??
                  view.captureReturnHistorySource?.(message))
                view.assertReturnHistoryCurrent?.()
                view.assertCurrent()
                view.host.validate("values", result)
                view.assertDataCurrent()
                initial.assertDataCurrent()
                view.assertReturnHistoryData?.()
                output = returned.finish()
              }
              catch (error) { failed = true; failure = error }
              finally {
                try {
                  setSharedNativeDomainPhase(domain, "closing")
                  const view = readSharedNativeDomainCleanupView(domain)
                  let closeFailed = false
                  try { view?.host.close() } catch { closeFailed = true }
                  const drained = await Promise.allSettled([
                    ...factory.nodes.map(node => Promise.resolve().then(() =>
                      node.whenDrainedForSharedDomain(domain.token))),
                    Promise.resolve().then(() => view?.host.whenDrained())
                  ])
                  if (closeFailed || drained.some(result => result.status === "rejected")) {
                    cleanupFailed = true
                    setSharedNativeDomainPhase(domain, "failed")
                    scope.quarantineNativeWork()
                  } else setSharedNativeDomainPhase(domain, "closed")
                } catch {
                  cleanupFailed = true
                  try { setSharedNativeDomainPhase(domain, "failed") } catch { /* already failed */ }
                  try { scope.quarantineNativeWork() } catch { /* cleanup remains unknown */ }
                }
              }
              if (cleanupFailed)
                throw new ModFunctionError("MODS_CONVERSATION_NATIVE_NODE_DRAIN_UNKNOWN")
              if (failed) throw failure
              return output
            })
            })
          }
          const result = scope
            ? await scope.run(() => invoke(admitted, fixed)) : await invoke(admitted, fixed)
          return withoutConversationChannel(result)
        })
      } else methods.set(key, value.bind(target))
    }
    return methods.get(key)
  } })
}

async function closeSharedNativeStreamDomain(factory: SharedNativeFactoryRecord,
  domain: SharedNativeDomainRecord, scope: FunctionConversationSharedCheckpointScope): Promise<void> {
  setSharedNativeDomainPhase(domain, "closing")
  const view = readSharedNativeDomainCleanupView(domain)
  let closeFailed = false
  try { view?.host.close() } catch { closeFailed = true }
  const drained = await Promise.allSettled([
    ...factory.nodes.map(node => Promise.resolve().then(() => node.whenDrainedForSharedDomain(domain.token))),
    Promise.resolve().then(() => view?.host.whenDrained())
  ])
  if (closeFailed || drained.some(result => result.status === "rejected")) {
    setSharedNativeDomainPhase(domain, "failed")
    scope.quarantineNativeWork()
    throw new ModFunctionError("MODS_CONVERSATION_NATIVE_NODE_DRAIN_UNKNOWN")
  }
  setSharedNativeDomainPhase(domain, "closed")
}

/** Private stream copies use the same complete message authentication as invoke. */
function copySharedNativeStreamPayload(mode: string, value: unknown,
  view: FunctionConversationSharedNativeDomainView, initial: NativeReturnSources): unknown {
  const capture = (message: BaseMessage) => view.host.captureReturnMessageSource(message) ??
    initial.capture(message) ?? view.captureReturnHistorySource?.(message)
  const copy = (input: unknown): unknown => {
    if (!input || typeof input !== "object" || types.isProxy(input)) return input
    if (Array.isArray(input)) return input.map(copy)
    const messages = Object.getOwnPropertyDescriptor(input, "messages")
    if (messages && "value" in messages)
      return prepareNativeConversationReturn(input, capture).finish()
    if (Object.getPrototypeOf(input) === Command.prototype) {
      const fields = Object.getOwnPropertyDescriptors(input)
      const update = fields.update
      if (!update || !("value" in update)) fail()
      fields.update = { ...update, value: copy(update.value) }
      return Object.create(Command.prototype, fields)
    }
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) return input
    const result = Object.create(prototype) as Record<string, unknown>
    for (const key of Reflect.ownKeys(input)) {
      const field = Object.getOwnPropertyDescriptor(input, key)
      if (!field || !("value" in field)) fail()
      Object.defineProperty(result, key, { ...field, value: copy(field.value) })
    }
    return result
  }
  view.assertReturnHistoryCurrent?.()
  view.assertCurrent()
  view.host.validate(mode, value)
  const result = copy(value)
  view.assertDataCurrent()
  initial.assertDataCurrent()
  view.assertReturnHistoryData?.()
  return result
}

/** Private value copies are never registered as a producer, ACK or publication permission. */
function prepareNativeConversationReturn(value: unknown,
  captureSource: (message: BaseMessage) => NativeReturnData | undefined): { finish(): unknown } {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail()
  const prototype = Object.getPrototypeOf(value)
  const keys = Reflect.ownKeys(value), output = Object.create(prototype) as object
  const descriptors: PropertyDescriptor[] = []
  const field = Object.getOwnPropertyDescriptor(value, "messages")
  if (!field || !("value" in field) || !Array.isArray(field.value) || types.isProxy(field.value) ||
    Object.getPrototypeOf(field.value) !== Array.prototype) fail()
  const messages = field.value as BaseMessage[]
  const length = Object.getOwnPropertyDescriptor(messages, "length")
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) ||
    length.value < 0 || length.value > 1_000_000 ||
    Reflect.ownKeys(messages).length !== length.value + 1) fail()
  const originals: Array<{ field: PropertyDescriptor; digest: string; copy: BaseMessage }> = []
  const copied: BaseMessage[] = []
  const sources: NativeReturnData[] = []
  for (let index = 0; index < length.value; index++) {
    const item = Object.getOwnPropertyDescriptor(messages, String(index))
    if (!item || !("value" in item)) fail()
    const source = captureSource(item.value as BaseMessage)
    if (!source) fail()
    sources[index] = source
  }
  for (let index = 0; index < length.value; index++) {
    const item = Object.getOwnPropertyDescriptor(messages, String(index))
    if (!item || !("value" in item)) fail()
    const captured = captureNativeMessage(item.value as BaseMessage)
    if (captured.executionSuppressed) fail()
    const copy = constructCapturedNativeMessage(captured.type, captured.data)
    if (captureNativeMessage(copy).digest !== captured.digest) fail()
    originals[index] = { field: item, digest: captured.digest, copy }
    Object.defineProperty(copied, String(index), { ...item, value: copy })
  }
  Object.defineProperty(copied, "length", length)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index], field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || !("value" in field)) fail()
    descriptors[index] = field
    if (key !== FUNCTION_CONVERSATION_CHANNEL)
      Object.defineProperty(output, key, key === "messages" ? { ...field, value: copied } : field)
  }
  return { finish() {
    if (types.isProxy(value) || Object.getPrototypeOf(value) !== prototype) fail()
    const currentKeys = Reflect.ownKeys(value)
    if (currentKeys.length !== keys.length) fail()
    for (let index = 0; index < keys.length; index++) {
      if (currentKeys[index] !== keys[index] ||
        !sameReturnField(Object.getOwnPropertyDescriptor(value, keys[index]), descriptors[index])) fail()
    }
    if (types.isProxy(messages) || Object.getPrototypeOf(messages) !== Array.prototype ||
      Reflect.ownKeys(messages).length !== length.value + 1 ||
      !sameReturnField(Object.getOwnPropertyDescriptor(messages, "length"), length)) fail()
    for (let index = 0; index < originals.length; index++) {
      const original = originals[index]
      sources[index].assertDataCurrent()
      if (!sameReturnField(Object.getOwnPropertyDescriptor(messages, String(index)), original.field) ||
        captureNativeMessage(original.field.value as BaseMessage).digest !== original.digest ||
        captureNativeMessage(original.copy).digest !== original.digest) fail()
    }
    return output
  } }
}

/** Preserve native Command routing and all other task state, while isolating each graph's inbox. */
export function withoutConversationChannel(value: unknown): unknown {
  if (isCommand(value)) {
    const command = value as Command
    const original = command.update
    const update = Array.isArray(original)
      ? original.some(pair => pair[0] === FUNCTION_CONVERSATION_CHANNEL)
        ? original.filter(pair => pair[0] !== FUNCTION_CONVERSATION_CHANNEL) : original
      : withoutConversationChannel(original)
    if (update === command.update) return value
    return new Command({ update: update as typeof command.update,
      ...(command.graph !== undefined ? { graph: command.graph } : {}),
      ...(command.resume !== undefined ? { resume: command.resume } : {}),
      ...(command.goto !== undefined ? { goto: command.goto } : {}) })
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    !Object.hasOwn(value, FUNCTION_CONVERSATION_CHANNEL)) return value
  const result = { ...value }
  delete result[FUNCTION_CONVERSATION_CHANNEL]
  return result
}
