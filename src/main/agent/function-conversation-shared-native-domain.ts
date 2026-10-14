import { AsyncLocalStorage } from "node:async_hooks"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { ModRuntimeAuthority } from "../mods/runtime-instance"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import type { FunctionConversationStore } from "../db/function-conversation-store"
import type { FunctionConversationSharedProducerView } from "../mods/v2/conversation-shared-restore"
import type { FunctionConversationSharedCheckpointScope } from "../mods/v2/conversation-shared-checkpointer"
import type { FunctionConversationNativeHost } from "./function-conversation-native-host"
import type { installFunctionConversationNativeNode } from "./function-conversation-native-node"
import type { FunctionConversationNativeTools } from "./function-conversation-native-tools"
import type { RunnableConfig } from "@langchain/core/runnables"
import { readFunctionConversationNativeAgentDerivation,
  type FunctionNativeAgentDerivation } from "./native-agent-factory"
import { currentFunctionConversationNativeNodeWorkRuntime } from
  "./function-conversation-native-node"
import { types } from "node:util"
import type { BaseMessage } from "@langchain/core/messages"

// Routing facts only. This module has no desktop imports, producer mint, policy or SDK grants.
// Only the known createAgent factory populates these facts after actual shared Saver admission.
const factoryBrand = Symbol("function-conversation-shared-native-factory")
const domainBrand = Symbol("function-conversation-shared-native-domain")
export interface FunctionConversationSharedNativeFactory { readonly [factoryBrand]: true }
export interface FunctionConversationSharedNativeDomain { readonly [domainBrand]: true }
export interface FunctionConversationSharedNativeDomainView {
  readonly factory: FunctionConversationSharedNativeFactory
  readonly domain: FunctionConversationSharedNativeDomain
  readonly runtime: FunctionNativeConversationRuntime
  readonly host: FunctionConversationNativeHost
  readonly captureReturnHistorySource?: (message: BaseMessage) =>
    Readonly<{ assertDataCurrent(): void }> | undefined
  readonly assertReturnHistoryCurrent?: () => void
  readonly assertReturnHistoryData?: () => void
  assertCurrent(): void
  assertDataCurrent(): void
}
export interface FunctionConversationSharedNativeOptions {
  readonly store: FunctionConversationStore
  readonly agentId: string
  readonly model: string
  captureRuntime(authority: ModRuntimeAuthority): FunctionNativeConversationRuntime | undefined
  flush(runtime: FunctionNativeConversationRuntime, uuid: string): void | Promise<void>
}
export interface SharedNativeFactoryRecord {
  readonly token: FunctionConversationSharedNativeFactory
  readonly options: FunctionConversationSharedNativeOptions
  readonly nodes: Array<ReturnType<typeof installFunctionConversationNativeNode>>
  graph?: object
  tools?: FunctionConversationNativeTools
}
export interface SharedNativeDomainRecord {
  readonly token: FunctionConversationSharedNativeDomain
  readonly factory: SharedNativeFactoryRecord
  readonly scope: FunctionConversationSharedCheckpointScope
  phase: "created" | "preparing" | "ready" | "closing" | "closed" | "failed"
  original?: FunctionConversationSharedProducerView
  view?: FunctionConversationSharedNativeDomainView
}
const factories = new WeakMap<FunctionConversationSharedNativeFactory, SharedNativeFactoryRecord>()
const graphs = new WeakMap<object, SharedNativeFactoryRecord>()
const domains = new WeakMap<FunctionConversationSharedNativeDomain, SharedNativeDomainRecord>()
const families = new WeakMap<SharedNativeFactoryRecord, object>()
const agents = new WeakMap<SharedNativeFactoryRecord, FunctionNativeAgentDerivation>()
const captures = new WeakMap<SharedNativeFactoryRecord,
  () => FunctionConversationSharedCheckpointScope | undefined>()
const retired = new WeakSet<SharedNativeFactoryRecord>()
const modelBounds = new WeakMap<SharedNativeFactoryRecord, object>()
interface DataFacts {
  readonly prototype: object | null
  fields: Array<readonly [PropertyKey, PropertyDescriptor]>
  failed: boolean
}
const factoryFacts = new WeakMap<SharedNativeFactoryRecord, DataFacts>()
const domainFacts = new WeakMap<SharedNativeDomainRecord, DataFacts & {
  readonly factory: SharedNativeFactoryRecord
  view?: FunctionConversationSharedNativeDomainView
}>()
const weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set
const weakHas = WeakMap.prototype.has, weakDelete = WeakMap.prototype.delete
const retiredHas = WeakSet.prototype.has, retiredAdd = WeakSet.prototype.add
function get<K extends object, V>(table: WeakMap<K, V>, key: K): V | undefined {
  return Reflect.apply(weakGet, table, [key]) as V | undefined
}
function set<K extends object, V>(table: WeakMap<K, V>, key: K, value: V): void {
  Reflect.apply(weakSet, table, [key, value])
}
function fields(value: object): DataFacts {
  const keys = Reflect.ownKeys(value), output: DataFacts["fields"] = []
  if (types.isProxy(value)) fail()
  for (let index = 0; index < keys.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, keys[index])
    if (!field || !("value" in field)) fail()
    output[index] = [keys[index], field]
  }
  return { prototype: Object.getPrototypeOf(value), fields: output, failed: false }
}
function sameFields(value: object, original?: DataFacts, exact = true): boolean {
  if (!original || original.failed) return false
  if (types.isProxy(value) || Object.getPrototypeOf(value) !== original.prototype ||
    (exact && Reflect.ownKeys(value).length !== original.fields.length)) {
    original.failed = true
    return false
  }
  for (let index = 0; index < original.fields.length; index++) {
    const key = original.fields[index][0], field = original.fields[index][1]
    const current = Object.getOwnPropertyDescriptor(value, key)
    if (!current || !("value" in current) || current.value !== field.value ||
      current.enumerable !== field.enumerable || current.writable !== field.writable ||
      current.configurable !== field.configurable) {
      original.failed = true
      return false
    }
  }
  return true
}
function dataObject(value: object, key: string): object {
  if (types.isProxy(value)) fail()
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field || !("value" in field) || !field.value ||
    typeof field.value !== "object" || types.isProxy(field.value)) fail()
  return field.value as object
}
const local = new AsyncLocalStorage<SharedNativeDomainRecord>()
function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_NATIVE_SOURCE_INVALID") }

/** Internal known-factory installation fact. It cannot mint any native producer or policy. */
export function createSharedNativeFactoryRecord(options: FunctionConversationSharedNativeOptions,
  originalCapture: () => FunctionConversationSharedCheckpointScope | undefined) {
  const value: SharedNativeFactoryRecord = { token: Object.freeze({ [factoryBrand]: true as const }),
    options: Object.freeze({ ...options, captureRuntime: options.captureRuntime.bind(options),
      flush: options.flush.bind(options) }), nodes: [] }
  set(factories, value.token, value)
  set(captures, value, originalCapture)
  set(families, value, Object.freeze({}))
  set(factoryFacts, value, fields(value))
  return value
}
export function publishSharedNativeFactoryGraph(factory: SharedNativeFactoryRecord, graph: object,
  agent: object): void {
  if (!sameFields(factory, get(factoryFacts, factory), false) ||
    get(factories, factory.token) !== factory || Object.hasOwn(factory, "graph") ||
    Reflect.apply(weakHas, graphs, [graph])) fail()
  const keys = Reflect.ownKeys(factory)
  for (let index = 0; index < keys.length; index++) {
    if (!["token", "options", "nodes", "tools"].includes(keys[index] as string)) fail()
    const field = Object.getOwnPropertyDescriptor(factory, keys[index])
    if (!field || !("value" in field)) fail()
  }
  const source = readFunctionConversationNativeAgentDerivation(agent)
  if (!source || source.graph !== graph || !Reflect.apply(weakHas, families, [factory])) fail()
  source.assertStructure()
  if (Reflect.apply(weakHas, agents, [factory]) && get(agents, factory) !== source) fail()
  const builder = dataObject(graph, "builder"), nodes = dataObject(builder, "nodes")
  const model = dataObject(nodes, "model_request"), bound = dataObject(model, "runnable")
  set(modelBounds, factory, bound)
  set(agents, factory, source)
  factory.graph = graph
  set(factoryFacts, factory, fields(factory))
  set(graphs, graph, factory)
}
export function isSharedNativeFactoryCurrent(factory: SharedNativeFactoryRecord): boolean {
  return !Reflect.apply(retiredHas, retired, [factory]) &&
    sameFields(factory, get(factoryFacts, factory)) &&
    get(factories, factory.token) === factory && !!factory.graph &&
    get(graphs, factory.graph) === factory && get(agents, factory)?.graph === factory.graph
}
export function retireSharedNativeFactoryRecord(factory: SharedNativeFactoryRecord): void {
  Reflect.apply(retiredAdd, retired, [factory])
  const graph = get(agents, factory)?.graph
  if (graph && get(graphs, graph) === factory) Reflect.apply(weakDelete, graphs, [graph])
}
/** Only the genuine framework derivation can carry the private shared routing family. */
export function deriveSharedNativeFactoryRecord(parent: SharedNativeFactoryRecord,
  config: RunnableConfig): { agent: object; factory: SharedNativeFactoryRecord } {
  if (!isSharedNativeFactoryCurrent(parent)) fail()
  const source = get(agents, parent), family = get(families, parent)
  if (!source || !family) fail()
  source.assertStructure()
  const agent = source.derive(config)
  source.assertStructure()
  const child = readFunctionConversationNativeAgentDerivation(agent)
  if (!child || child.graph === source.graph) fail()
  child.assertStructure()
  const originalCapture = get(captures, parent)
  if (!originalCapture) fail()
  const factory = createSharedNativeFactoryRecord(parent.options, originalCapture)
  set(families, factory, family)
  set(agents, factory, child)
  return { agent, factory }
}
/** The original middleware closure follows only actual domains in its original private family. */
export function readCurrentSharedNativeFamilyDomain(factory: SharedNativeFactoryRecord):
  FunctionConversationSharedNativeDomainView | undefined {
  if (!isSharedNativeFactoryCurrent(factory)) fail()
  const actual = currentSharedNativeDomainRecord()
  if (!actual) return undefined
  if (get(families, actual.factory) !== get(families, factory) ||
    actual.phase !== "ready" || !actual.view || actual.view.factory !== actual.factory.token) fail()
  get(agents, actual.factory)?.assertStructure()
  const bound = get(modelBounds, actual.factory)
  if (!bound || currentFunctionConversationNativeNodeWorkRuntime(bound, actual.factory.token) !==
    actual.view.runtime) fail()
  actual.view.assertDataCurrent()
  return actual.view
}
export function isSharedNativeDomainCurrent(domain: SharedNativeDomainRecord): boolean {
  const original = get(domainFacts, domain)
  return sameFields(domain, original) && get(domains, domain.token) === domain &&
    isSharedNativeFactoryCurrent(original!.factory)
}
/** Phase writes are owned by the invocation, with an irreversible private failure latch. */
export function setSharedNativeDomainPhase(domain: SharedNativeDomainRecord,
  phase: SharedNativeDomainRecord["phase"]): void {
  const original = get(domainFacts, domain)
  if (!original) fail()
  sameFields(domain, original)
  for (let index = 0; index < original.fields.length; index++) {
    const pair = original.fields[index]
    if (pair[0] !== "phase") continue
    const descriptor = { ...pair[1], value: phase }
    try { Object.defineProperty(domain, "phase", descriptor) }
    catch { original.failed = true }
    original.fields[index] = ["phase", descriptor]
    return
  }
  fail()
}
export function publishSharedNativeDomainView(domain: SharedNativeDomainRecord,
  original: FunctionConversationSharedProducerView,
  view: FunctionConversationSharedNativeDomainView): void {
  if (!isSharedNativeDomainCurrent(domain) || domain.phase !== "preparing" ||
    Object.hasOwn(domain, "original") || Object.hasOwn(domain, "view")) fail()
  Object.defineProperties(domain, {
    original: { value: original, enumerable: true, writable: true, configurable: true },
    view: { value: view, enumerable: true, writable: true, configurable: true }
  })
  const previous = get(domainFacts, domain)!
  set(domainFacts, domain, { ...fields(domain), factory: previous.factory, view })
  setSharedNativeDomainPhase(domain, "ready")
}
/** Cleanup keeps the original view even if a later public field was replaced. */
export function readSharedNativeDomainCleanupView(domain: SharedNativeDomainRecord):
  FunctionConversationSharedNativeDomainView | undefined {
  return get(domainFacts, domain)?.view
}
/** Actual invocation routing only. The original producer module still owns every admission. */
export function runSharedNativeFactoryDomain<T>(factory: SharedNativeFactoryRecord,
  scope: FunctionConversationSharedCheckpointScope, run: (domain: SharedNativeDomainRecord) => T): T {
  if (!isSharedNativeFactoryCurrent(factory)) fail()
  const domain: SharedNativeDomainRecord = {
    token: Object.freeze({ [domainBrand]: true as const }), factory, scope, phase: "created" }
  set(domains, domain.token, domain)
  set(domainFacts, domain, { ...fields(domain), factory })
  return local.run(domain, () => run(domain))
}
export function currentSharedNativeDomainRecord(): SharedNativeDomainRecord | undefined {
  const domain = local.getStore()
  if (domain && !isSharedNativeDomainCurrent(domain)) fail()
  return domain
}
export function readFunctionConversationSharedNativeFactory(
  graph: object): FunctionConversationSharedNativeFactory | undefined {
  const factory = get(graphs, graph)
  return factory && isSharedNativeFactoryCurrent(factory) ? factory.token : undefined
}
/** Constructor address only. This never invokes a capture or certifies its returned Scope. */
export function readSharedNativeFactoryOriginalCapture(
  token: FunctionConversationSharedNativeFactory, agent: object, graph: object
): (() => FunctionConversationSharedCheckpointScope | undefined) | undefined {
  const factory = get(factories, token)
  if (!factory || get(graphs, graph) !== factory) return undefined
  const source = readFunctionConversationNativeAgentDerivation(agent)
  if (!source || get(agents, factory) !== source) return undefined
  if (!isSharedNativeFactoryCurrent(factory)) fail()
  if (factory.graph !== graph || source.graph !== graph) return undefined
  source.assertStructure()
  return get(captures, factory)
}
export function readCurrentFunctionConversationSharedNativeDomain(
  factory: FunctionConversationSharedNativeFactory,
  graph: object): FunctionConversationSharedNativeDomainView | undefined {
  const original = get(factories, factory)
  if (!original || !isSharedNativeFactoryCurrent(original) || original.graph !== graph) fail()
  const actual = currentSharedNativeDomainRecord()
  if (!actual) return undefined
  if (actual.factory !== original) fail()
  if (actual.phase !== "ready" || !actual.view) fail()
  actual.view.assertDataCurrent()
  return actual.view
}
