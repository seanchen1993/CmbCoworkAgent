import { AsyncLocalStorage } from "node:async_hooks"
import { types } from "node:util"
import type { RunnableConfig } from "@langchain/core/runnables"
import type { BaseMessage } from "@langchain/core/messages"
import {
  readNativeRunnableStreamBoundary,
  readNativeRunnableStreamSettlement,
  type NativeRunnableStreamBoundary,
  type NativeRunnableStreamSettlement
} from "@langchain/core/native-stream-origin"
import {
  createNativePregelStreamOperation,
  executeNativePregelStreamOperation,
  readNativePregelStreamOperation,
  readNativePregelStreamSettlement,
  type NativePregelStreamExecutionFacts,
  type NativePregelStreamOperation,
  type NativePregelStreamSettlement
} from "@langchain/langgraph/native-stream-origin"
import {
  createNativeStreamOperation,
  executeNativeStreamOperation,
  readNativeStreamBoundary,
  type NativeStreamBoundary,
  type NativeStreamOperation
} from "langchain/native-stream-origin"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import {
  readFunctionConversationSharedCheckpointOpeningCurrent,
  readFunctionConversationSharedCheckpointPreflightReceipt,
  runFunctionConversationSharedCheckpointPreflight,
  runFunctionConversationSharedCheckpointPreflightOperation,
  type FunctionConversationSharedCheckpointOpeningCurrent,
  type FunctionConversationSharedCheckpointPreflightReceipt,
  type FunctionConversationSharedCheckpointScope
} from "../mods/v2/conversation-shared-checkpointer"
import {
  readFunctionConversationNativeAgentDerivation,
  readFunctionConversationNativeAgentPreflightOrigin,
  readFunctionConversationNativeStandardCancellationSignal,
  type FunctionNativeAgentDerivation,
  type FunctionNativeAgentPreflightOrigin
} from "./native-agent-factory"
import {
  readFunctionConversationNativeSourceObserverInstallation,
  readFunctionConversationNativeSourceObserverDispatch,
  type FunctionConversationNativeSourceObserverInstallation
} from "./function-conversation-native-lifetime"
import {
  readFunctionConversationSharedNativeFactory,
  readSharedNativeFactoryOriginalCapture,
  type FunctionConversationSharedNativeFactory
} from "./function-conversation-shared-native-domain"
import { captureNativeSharedOrdinaryMessageData } from "./native-shared-ordinary-message-data"

// Execution facts only. No Desktop, Host, producer, ready state or frame is created here.
const weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set
const contextGet = AsyncLocalStorage.prototype.getStore
const contextRun = AsyncLocalStorage.prototype.run
const signalThrow = AbortSignal.prototype.throwIfAborted
const promiseThen = Promise.prototype.then
const installers = new WeakMap<object, Installer>()
const operations = new WeakMap<NativeStreamOperation, Pending>()
const active = new AsyncLocalStorage<Pending>()

interface Installer {
  readonly agent: object
  readonly graph: object
  readonly source: FunctionNativeAgentDerivation
  readonly origin: FunctionNativeAgentPreflightOrigin
  readonly capture: () => FunctionConversationSharedCheckpointScope | undefined
  readonly adapter: (config: RunnableConfig) => Promise<unknown>
  factory: FunctionConversationSharedNativeFactory | undefined
  observer: FunctionConversationNativeSourceObserverInstallation | undefined
  field: PropertyDescriptor | undefined
  finished: boolean
  failed: boolean
}
interface Pending {
  readonly installer: Installer
  readonly input: unknown
  readonly config: RunnableConfig
  readonly checkInput: () => void
  readonly checkConfig: () => void
  scope: FunctionConversationSharedCheckpointScope | undefined
  opening: FunctionConversationSharedCheckpointOpeningCurrent | undefined
  operation: NativeStreamOperation | undefined
  signal: AbortSignal | undefined
  preflight: NativeStreamBoundary | undefined
  dispatch: NativeStreamBoundary | undefined
  originalRead: (() => Promise<unknown>) | undefined
  receipt: FunctionConversationSharedCheckpointPreflightReceipt | undefined
  value: unknown
  stop: ModFunctionError | undefined
  readonly inner: boolean
  readonly streaming: boolean
  graphOperation: NativePregelStreamOperation | undefined
  graphFacts: NativePregelStreamExecutionFacts | undefined
  coreBoundary: NativeRunnableStreamBoundary | undefined
  iteratorClaimed: boolean
  reading: boolean
  failed: boolean
  failure: unknown
}

export interface FunctionConversationSharedStreamPreflightFacts {
  readonly scope: FunctionConversationSharedCheckpointScope
  readonly operation: NativeStreamOperation
  readonly actualConfig: object
  readonly value: unknown
  readonly receipt: FunctionConversationSharedCheckpointPreflightReceipt
  assertDataCurrent(): void
}
export interface FunctionConversationSharedStreamIteratorFacts extends
  FunctionConversationSharedStreamPreflightFacts {
  readonly graphConfig: object
  readonly iteratorConfig: object
  readonly graphSettlement: NativePregelStreamSettlement
  readonly coreSettlement: NativeRunnableStreamSettlement
}

function fail(): never {
  throw new ModFunctionError("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
}
function get<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return Reflect.apply(weakGet, map, [key]) as V | undefined
}
function set<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
  Reflect.apply(weakSet, map, [key, value])
}
function sameField(current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor | undefined): boolean {
  return current === undefined ? expected === undefined : !!expected &&
    "value" in current && "value" in expected && current.value === expected.value &&
    current.enumerable === expected.enumerable && current.writable === expected.writable &&
    current.configurable === expected.configurable
}
function data(value: object, key: string): unknown {
  if (types.isProxy(value)) fail()
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (field && !("value" in field)) fail()
  return field?.value
}
function captureObject(value: object): () => void {
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
        !sameField(Object.getOwnPropertyDescriptor(value, keys[index]), fields[index])) fail()
  }
}
function captureConfig(config: RunnableConfig): () => void {
  if (!config || typeof config !== "object" || types.isProxy(config) ||
    Object.getPrototypeOf(config) !== Object.prototype) fail()
  const root = captureObject(config), nested: Array<() => void> = []
  for (const key of ["configurable", "metadata", "tags"] as const) {
    const value = data(config, key)
    if (value !== undefined) {
      if (!value || typeof value !== "object" || types.isProxy(value)) fail()
      nested[nested.length] = captureObject(value)
      if (key === "configurable") {
        const map = data(value, "checkpoint_map")
        if (map !== undefined) {
          if (!map || typeof map !== "object" || types.isProxy(map)) fail()
          nested[nested.length] = captureObject(map)
        }
      }
    }
  }
  return () => {
    root()
    for (let index = 0; index < nested.length; index++) nested[index]()
    root()
  }
}
function captureInput(input: unknown): () => void {
  if (!input || typeof input !== "object" || types.isProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype) fail()
  const root = captureObject(input), messages = data(input, "messages")
  if (!Array.isArray(messages) || types.isProxy(messages)) fail()
  const array = captureObject(messages)
  const length = Object.getOwnPropertyDescriptor(messages, "length")
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) ||
    length.value < 0 || Reflect.ownKeys(messages).length !== length.value + 1) fail()
  const checks: Array<() => void> = []
  for (let index = 0; index < length.value; index++) {
    const item = Object.getOwnPropertyDescriptor(messages, String(index))
    if (!item || !("value" in item)) fail()
    checks[index] = captureNativeSharedOrdinaryMessageData(item.value as BaseMessage)
      .assertOriginalDataCurrent
  }
  return () => {
    root(); array()
    for (let index = 0; index < checks.length; index++) checks[index]()
    array(); root()
  }
}
function assertInstaller(record: Installer): void {
  if (record.failed || !record.finished || !record.factory || !record.observer ||
    get(installers, record.graph) !== record) fail()
  try {
    if (readFunctionConversationNativeAgentDerivation(record.agent) !== record.source ||
      readFunctionConversationNativeAgentPreflightOrigin(record.agent) !== record.origin ||
      readFunctionConversationSharedNativeFactory(record.graph) !== record.factory ||
      readSharedNativeFactoryOriginalCapture(record.factory, record.agent, record.graph) !==
        record.capture ||
      !sameField(Object.getOwnPropertyDescriptor(record.graph, "getState"), record.field)) fail()
    record.source.assertStructure()
    record.origin.assertOriginalDataCurrent()
    readFunctionConversationNativeSourceObserverInstallation(record.observer, record.graph)
  } catch (error) { record.failed = true; throw error }
}
function reject(pending: Pending, reason: unknown): never {
  if (!pending.failed) { pending.failed = true; pending.failure = reason }
  throw pending.failure
}
function invalid(pending: Pending): never {
  return reject(pending, new ModFunctionError("MODS_CONVERSATION_NATIVE_SOURCE_INVALID"))
}
function current(): Pending | undefined {
  return Reflect.apply(contextGet, active, []) as Pending | undefined
}
function assertPending(pending: Pending): void {
  if (pending.failed) throw pending.failure
  try {
    assertInstaller(pending.installer)
    pending.checkInput()
    pending.checkConfig()
    if (!pending.scope || !pending.opening || !pending.operation ||
      get(operations, pending.operation) !== pending ||
      readFunctionConversationSharedCheckpointOpeningCurrent(pending.scope) !== pending.opening)
      fail()
    if (!pending.signal) fail()
    readFunctionConversationNativeStandardCancellationSignal(pending.signal)
    Reflect.apply(signalThrow, pending.signal, [])
    pending.opening.assertDataCurrent()
  } catch (error) { reject(pending, error) }
}

/** Provisional adapter only. Actual Shared publication below is required before use. */
export function prepareFunctionConversationSharedNativeStreamPreflight(
  agent: object, capture: () => FunctionConversationSharedCheckpointScope | undefined
): Readonly<{ graph: object; adapter: Installer["adapter"] }> {
  const source = readFunctionConversationNativeAgentDerivation(agent)
  const origin = readFunctionConversationNativeAgentPreflightOrigin(agent)
  if (!source || !origin || source.graph !== origin.graph || get(installers, source.graph) ||
    Object.getOwnPropertyDescriptor(source.graph, "getState") !== undefined) fail()
  source.assertStructure()
  const record: Installer = { agent, graph: source.graph, source, origin, capture,
    adapter: config => readPreflight(record, config), factory: undefined, observer: undefined,
    field: undefined, finished: false, failed: false }
  set(installers, record.graph, record)
  return Object.freeze({ graph: record.graph, adapter: record.adapter })
}

/** Only the actual published Shared graph and its actual immutable observer complete this fact. */
export function finishFunctionConversationSharedNativeStreamPreflight(agent: object,
  factory: FunctionConversationSharedNativeFactory,
  observer: FunctionConversationNativeSourceObserverInstallation): void {
  const source = readFunctionConversationNativeAgentDerivation(agent)
  const record = source && get(installers, source.graph)
  if (!record || record.agent !== agent || record.source !== source || record.finished ||
    record.failed) fail()
  try {
    const field = Object.getOwnPropertyDescriptor(record.graph, "getState")
    if (!field || !("value" in field) || field.value !== record.adapter ||
      field.writable !== false || field.configurable !== false ||
      readFunctionConversationSharedNativeFactory(record.graph) !== factory ||
      readSharedNativeFactoryOriginalCapture(factory, agent, record.graph) !== record.capture) fail()
    readFunctionConversationNativeSourceObserverInstallation(observer, record.graph)
    record.factory = factory
    record.observer = observer
    record.field = Object.freeze(field)
    record.finished = true
    assertInstaller(record)
  } catch (error) { record.failed = true; throw error }
}

function readPreflight(record: Installer, config: RunnableConfig): Promise<unknown> {
  const boundary = readNativeStreamBoundary(record.graph, config, "preflight")
  const pending = current()
  if (!boundary) {
    if (pending?.installer === record) invalid(pending)
    // The existing ordinary invoke path still captures and runs preflight exactly once.
    const scope = Reflect.apply(record.capture, undefined, []) as
      FunctionConversationSharedCheckpointScope | undefined
    const read = () => Promise.resolve(Reflect.apply(record.origin.original, record.graph, [config]))
    return scope ? scope.preflight(config, read) : read()
  }
  const actual = get(operations, boundary.operation)
  if (!actual || actual !== pending || actual.installer !== record) {
    if (pending?.installer === record) invalid(pending)
    return fail()
  }
  if (actual.reading || actual.preflight || boundary.agent !== record.agent ||
    boundary.graph !== record.graph || boundary.actualConfig !== config ||
    boundary.initializationSkipped) invalid(actual)
  actual.reading = true
  actual.preflight = boundary
  const read = () => Promise.resolve(Reflect.apply(record.origin.original, record.graph, [config]))
  actual.originalRead = read
  try {
    assertPending(actual)
    boundary.assertDataCurrent()
    const execution = runFunctionConversationSharedCheckpointPreflight(actual.scope!,
      actual.operation!, config, read)
    return Reflect.apply(promiseThen, execution, [(outcome: Awaited<typeof execution>) => {
      actual.reading = false
      assertPending(actual)
      boundary.assertDataCurrent()
      const receipt = readFunctionConversationSharedCheckpointPreflightReceipt(outcome.receipt,
        actual.scope!, actual.operation!, config)
      if (!receipt || receipt.originalRead !== read) invalid(actual)
      actual.receipt = outcome.receipt
      actual.value = outcome.value
      return outcome.value
    }, (error: unknown) => {
      actual.reading = false
      return reject(actual, error)
    }]) as Promise<unknown>
  } catch (error) { actual.reading = false; return reject(actual, error) }
}

/** Lifetime calls this at the original observed stream's synchronous entry, before any dispatch. */
export function assertFunctionConversationSharedNativeStreamPreflightDispatch(
  graph: object, state: unknown, config: object | undefined
): Readonly<{ promise: Promise<unknown> }> | undefined {
  const record = get(installers, graph)
  if (!record) return
  const boundary = config && readNativeStreamBoundary(graph, config, "dispatch")
  const pending = current()
  if (!boundary) {
    if (pending?.installer === record) invalid(pending)
    return
  }
  const actual = get(operations, boundary.operation)
  if (!actual || actual !== pending || actual.installer !== record) {
    if (pending?.installer === record) invalid(pending)
    return fail()
  }
  if (actual.reading || actual.dispatch || boundary.agent !== record.agent ||
    boundary.actualState !== state || boundary.actualConfig !== config ||
    !actual.preflight || actual.preflight.actualConfig !== config || !actual.receipt)
    invalid(actual)
  actual.dispatch = boundary
  assertPending(actual)
  boundary.assertDataCurrent()
  const receipt = readFunctionConversationSharedCheckpointPreflightReceipt(actual.receipt,
    actual.scope!, actual.operation!, config as RunnableConfig)
  if (!receipt || receipt.originalRead !== actual.originalRead) invalid(actual)
  receipt.assertDataCurrent()
  // The complete stream uses the normal Scope lifecycle. Its original observer
  // handles dispatch; the foundation-only modes below keep their private stops.
  if (actual.streaming) return
  if (actual.inner) {
    try {
      const observer = readFunctionConversationNativeSourceObserverDispatch(record.observer!, graph)
      const operation = createNativePregelStreamOperation(graph, state, config)
      actual.graphOperation = operation
      const facts = readNativePregelStreamOperation(operation, graph, state, config)
      if (!facts || facts.graph !== graph || facts.input !== state || facts.options !== config ||
        facts.selectedIterator !== observer.iterator || facts.iteratorOwner !== observer.owner ||
        !sameField(facts.iteratorDescriptor, observer.descriptor) ||
        observer.descriptor.writable !== false || observer.descriptor.configurable !== false)
        invalid(actual)
      actual.graphFacts = facts
      facts.assertDataCurrent()
      observer.assertDataCurrent()
      assertPending(actual)
      return Object.freeze({ promise: executeNativePregelStreamOperation(operation) })
    } catch (error) { return reject(actual, error) }
  }
  // The first foundation stops here. No iterable, model, admission or frame is started.
  actual.stop = new ModFunctionError("MODS_CONVERSATION_SHARED_STREAM_PREFLIGHT_ONLY")
  throw actual.stop
}

/** Only the true Core selected iterator entry can consume this pending's Graph child. */
export function assertFunctionConversationSharedNativeStreamIteratorEntry(
  graph: object, state: unknown, config: object | undefined
): void {
  const record = get(installers, graph), pending = current()
  if (!record || pending?.installer !== record) return
  if (pending.streaming) {
    if (!config || !pending.dispatch || pending.iteratorClaimed) invalid(pending)
    pending.iteratorClaimed = true
    assertPending(pending)
    const receipt = readFunctionConversationSharedCheckpointPreflightReceipt(pending.receipt!,
      pending.scope!, pending.operation!, pending.dispatch.actualConfig as RunnableConfig)
    if (!receipt || receipt.originalRead !== pending.originalRead) invalid(pending)
    receipt.assertDataCurrent()
    return
  }
  if (!pending.inner || !config || !pending.dispatch || !pending.graphOperation ||
    pending.iteratorClaimed) invalid(pending)
  pending.iteratorClaimed = true
  try {
    const boundary = readNativeRunnableStreamBoundary(graph, config)
    if (!boundary) invalid(pending)
    const facts = readNativePregelStreamOperation(pending.graphOperation, graph,
      pending.dispatch.actualState, pending.dispatch.actualConfig)
    if (!facts || facts.operation !== pending.graphOperation || facts.graph !== graph ||
      facts.input !== state || facts.input !== pending.dispatch.actualState ||
      facts.options !== pending.dispatch.actualConfig || !facts.actualConfig ||
      facts.coreOperation !== boundary.operation || boundary.receiver !== graph ||
      boundary.input !== state || boundary.options !== facts.actualConfig ||
      boundary.actualConfig !== config) invalid(pending)
    pending.graphFacts = facts
    pending.coreBoundary = boundary
    assertPending(pending)
    const receipt = readFunctionConversationSharedCheckpointPreflightReceipt(pending.receipt!,
      pending.scope!, pending.operation!, pending.dispatch.actualConfig as RunnableConfig)
    if (!receipt || receipt.originalRead !== pending.originalRead) invalid(pending)
    receipt.assertDataCurrent()
    const observer = readFunctionConversationNativeSourceObserverDispatch(record.observer!, graph)
    if (facts.selectedIterator !== observer.iterator || boundary.selectedIterator !== observer.iterator ||
      facts.iteratorOwner !== observer.owner || boundary.iteratorOwner !== observer.owner ||
      !sameField(facts.iteratorDescriptor, observer.descriptor) ||
      !sameField(boundary.iteratorDescriptor, observer.descriptor) ||
      observer.descriptor.writable !== false || observer.descriptor.configurable !== false)
      invalid(pending)
    facts.assertDataCurrent()
    boundary.assertDataCurrent()
    observer.assertDataCurrent()
    assertPending(pending)
  } catch (error) { return reject(pending, error) }
  pending.stop = new ModFunctionError("MODS_CONVERSATION_SHARED_STREAM_ITERATOR_ONLY")
  throw pending.stop
}

function readIteratorSettlements(pending: Pending): Readonly<{
  graph: NativePregelStreamSettlement; core: NativeRunnableStreamSettlement
}> {
  const facts = pending.graphFacts, boundary = pending.coreBoundary
  if (!pending.iteratorClaimed || !pending.graphOperation || !facts || !boundary ||
    !pending.dispatch || !pending.stop) invalid(pending)
  // These readers report failures; they cannot refresh either failed execution capability.
  const graph = readNativePregelStreamSettlement(pending.graphOperation)
  const core = readNativeRunnableStreamSettlement(boundary.operation)
  if (!graph || !core || graph.operation !== pending.graphOperation ||
    graph.graph !== pending.installer.graph || graph.input !== facts.input ||
    graph.options !== pending.dispatch.actualConfig || graph.actualConfig !== facts.actualConfig ||
    graph.coreOperation !== boundary.operation || graph.selectedIterator !== facts.selectedIterator ||
    graph.iteratorOwner !== facts.iteratorOwner ||
    !sameField(graph.iteratorDescriptor, facts.iteratorDescriptor) ||
    graph.status !== "rejected" || graph.reason !== pending.stop || graph.value !== undefined ||
    !graph.entered || !graph.partialEntered || core.operation !== boundary.operation ||
    core.receiver !== pending.installer.graph || core.input !== facts.input ||
    core.options !== facts.actualConfig || core.actualConfig !== boundary.actualConfig ||
    core.actualSignal !== boundary.actualSignal || core.selectedIterator !== boundary.selectedIterator ||
    core.iteratorOwner !== boundary.iteratorOwner ||
    !sameField(core.iteratorDescriptor, boundary.iteratorDescriptor) ||
    core.status !== "rejected" || core.reason !== pending.stop || core.value !== undefined ||
    !core.entered || !core.iteratorEntered) invalid(pending)
  return Object.freeze({ graph, core })
}

function runFoundation(graph: object, input: unknown, config: RunnableConfig,
  inner: false): Promise<FunctionConversationSharedStreamPreflightFacts>
function runFoundation(graph: object, input: unknown, config: RunnableConfig,
  inner: true): Promise<FunctionConversationSharedStreamIteratorFacts>
/** Only the two fixed module entries choose this execution mode. */
async function runFoundation(graph: object, input: unknown, config: RunnableConfig,
  inner: boolean): Promise<FunctionConversationSharedStreamPreflightFacts |
    FunctionConversationSharedStreamIteratorFacts> {
  // Both baselines precede the existing capture/full callbacks.
  const checkInput = captureInput(input), checkConfig = captureConfig(config)
  const installer = get(installers, graph)
  if (!installer) fail()
  assertInstaller(installer)
  const parent = current()
  if (parent?.installer === installer) invalid(parent)
  const pending: Pending = { installer, input, config, checkInput, checkConfig,
    scope: undefined, opening: undefined, operation: undefined, signal: undefined,
    preflight: undefined,
    dispatch: undefined, originalRead: undefined, receipt: undefined, value: undefined,
    stop: undefined, inner, streaming: false,
    graphOperation: undefined, graphFacts: undefined, coreBoundary: undefined,
    iteratorClaimed: false, reading: false, failed: false, failure: undefined }
  return Reflect.apply(contextRun, active, [pending, async () => {
    const callSignal = readFunctionConversationNativeStandardCancellationSignal(data(config, "signal"))
    const scope = Reflect.apply(installer.capture, undefined, []) as
      FunctionConversationSharedCheckpointScope | undefined
    if (!scope) fail()
    const opening = readFunctionConversationSharedCheckpointOpeningCurrent(scope)
    if (!opening) fail()
    checkInput(); checkConfig(); assertInstaller(installer)
    const signal = callSignal ?? opening.controllerSignal
    readFunctionConversationNativeStandardCancellationSignal(signal)
    Reflect.apply(signalThrow, signal, [])
    const fixed = { ...config, signal, configurable: { ...config.configurable,
      __pregel_checkpointer: scope.checkpointer } }
    const operation = createNativeStreamOperation(installer.agent as {
      stream: (input: unknown, config: RunnableConfig) => Promise<unknown>
    }, input, fixed)
    pending.scope = scope
    pending.opening = opening
    pending.operation = operation
    pending.signal = signal
    set(operations, operation, pending)
    assertPending(pending)
    let stopped = false
    try { await runFunctionConversationSharedCheckpointPreflightOperation(scope, operation, () => {
      assertPending(pending)
      return executeNativeStreamOperation(operation)
    }) }
    catch (error) {
      if (pending.failed) throw pending.failure
      if (error !== pending.stop || pending.stop === undefined) throw error
      stopped = true
    }
    if (!stopped || !pending.receipt || !pending.preflight || !pending.dispatch) invalid(pending)
    const assertDataCurrent = () => {
      assertPending(pending)
      const receipt = readFunctionConversationSharedCheckpointPreflightReceipt(pending.receipt!,
        scope, operation, pending.preflight!.actualConfig as RunnableConfig)
      if (!receipt || receipt.originalRead !== pending.originalRead) invalid(pending)
      receipt.assertDataCurrent()
      if (inner) readIteratorSettlements(pending)
    }
    assertDataCurrent()
    if (inner) {
      const settlements = readIteratorSettlements(pending)
      return Object.freeze({ scope, operation, actualConfig: pending.preflight.actualConfig,
        value: pending.value, receipt: pending.receipt, assertDataCurrent,
        graphConfig: pending.graphFacts!.actualConfig!, iteratorConfig: pending.coreBoundary!.actualConfig,
        graphSettlement: settlements.graph, coreSettlement: settlements.core })
    }
    return Object.freeze({ scope, operation, actualConfig: pending.preflight.actualConfig,
      value: pending.value, receipt: pending.receipt, assertDataCurrent })
  }]) as Promise<FunctionConversationSharedStreamPreflightFacts |
    FunctionConversationSharedStreamIteratorFacts>
}

/** Internal preflight foundation, ending at the true SDK dispatch rather than a frame. */
export function runFunctionConversationSharedNativeStreamPreflight(graph: object,
  input: unknown, config: RunnableConfig = {}): Promise<FunctionConversationSharedStreamPreflightFacts> {
  return runFoundation(graph, input, config, false)
}

/** Internal iterator foundation; its exact rejection happens before generator/setup creation. */
export function runFunctionConversationSharedNativeStreamIteratorFoundation(graph: object,
  input: unknown, config: RunnableConfig = {}): Promise<FunctionConversationSharedStreamIteratorFacts> {
  return runFoundation(graph, input, config, true)
}

/** Original installed observer, reused by the Main-owned complete stream driver. */
export function readFunctionConversationSharedNativeStreamObserver(graph: object):
  FunctionConversationNativeSourceObserverInstallation {
  const installer = get(installers, graph)
  if (!installer) fail()
  assertInstaller(installer)
  return installer.observer!
}

/** Called inside the original Scope.run; its callback holds the whole iterator lifetime. */
export function runFunctionConversationSharedNativeStream<T>(graph: object, input: unknown,
  config: RunnableConfig, scope: FunctionConversationSharedCheckpointScope,
  checkInput: () => void, consume: (start: () => Promise<unknown>) => Promise<T>): Promise<T> {
  const installer = get(installers, graph)
  if (!installer) fail()
  assertInstaller(installer)
  const parent = current()
  if (parent?.installer === installer) invalid(parent)
  const opening = readFunctionConversationSharedCheckpointOpeningCurrent(scope)
  if (!opening) fail()
  const signal = readFunctionConversationNativeStandardCancellationSignal(data(config, "signal"))
  if (!signal) fail()
  const operation = createNativeStreamOperation(installer.agent as {
    stream: (input: unknown, config: RunnableConfig) => Promise<unknown>
  }, input, config)
  const pending: Pending = { installer, input, config, checkInput, checkConfig: captureConfig(config),
    scope, opening, operation, signal, preflight: undefined, dispatch: undefined,
    originalRead: undefined, receipt: undefined, value: undefined, stop: undefined,
    inner: false, streaming: true, graphOperation: undefined, graphFacts: undefined,
    coreBoundary: undefined, iteratorClaimed: false, reading: false, failed: false, failure: undefined }
  set(operations, operation, pending)
  return Reflect.apply(contextRun, active, [pending, async () => {
    assertPending(pending)
    const value = await consume(() => executeNativeStreamOperation(operation))
    if (pending.failed) throw pending.failure
    // Receipt facts intentionally end before getTuple. The original Scope and
    // admitted Domain guard their legal initializing/binding transition thereafter.
    return value
  }]) as Promise<T>
}
