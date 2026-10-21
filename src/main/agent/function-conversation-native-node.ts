import { types } from "node:util"
import { AsyncLocalStorage } from "node:async_hooks"
import { BaseMessage, RemoveMessage } from "@langchain/core/messages"
import { Runnable, type RunnableConfig } from "@langchain/core/runnables"
import { Command, CompiledStateGraph } from "@langchain/langgraph"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { recordFunctionConversationNativeCompletion } from
  "./function-conversation-native-lifetime"
import type { FunctionNativeConversationRuntime } from "../mods/manager"
import { readCurrentFunctionConversationSharedNativeDomain,
  type FunctionConversationSharedNativeFactory,
  type FunctionConversationSharedNativeDomain,
  type FunctionConversationSharedNativeDomainView } from "./function-conversation-shared-native-domain"

const slotBrand = Symbol("function-conversation-native-node-slot")
const workBrand = Symbol("function-conversation-native-original-work")
const modelNameBrand = Symbol("function-conversation-native-model-name")
const workModelNameBrand = Symbol("function-conversation-native-work-model-name")
export interface FunctionConversationNativeNodeWorkModelName {
  readonly [workModelNameBrand]: true
}
export interface FunctionConversationNativeNodeWorkModelNameData {
  readonly work: FunctionConversationNativeNodeWork
  readonly graph: object
  readonly bound: object
  readonly runtime: FunctionNativeConversationRuntime
  readonly configurable: object
  readonly name: string
  assertDataCurrent(): void
}
export interface FunctionConversationNativeNodeModelName {
  readonly [modelNameBrand]: true
}
export interface FunctionConversationNativeNodeModelNameView {
  readonly slot: FunctionConversationNativeNodeSlot
  readonly message: BaseMessage
  readonly config: Readonly<RunnableConfig>
  readonly runtime: FunctionNativeConversationRuntime
  readonly name: string
  assertDataCurrent(): void
}

/** Only an installed native node can mint this completed output address. */
export interface FunctionConversationNativeNodeSlot {
  readonly [slotBrand]: true
}

/** Only the installed bound's actual invoke can enter this private original-work context. */
export interface FunctionConversationNativeNodeWork {
  readonly [workBrand]: true
}
export interface FunctionConversationNativeNodeWorkView {
  readonly node: FunctionConversationNativeNodeName
  readonly bound: Runnable<unknown, unknown>
  readonly input: unknown
  readonly config: Readonly<RunnableConfig>
  assertCurrent(): void
}

export type FunctionConversationNativeNodeName = "model_request" | "tools"
export type FunctionConversationNativeNodePath = readonly (string | number)[]

export interface FunctionConversationNativeNodeSlotView {
  readonly node: FunctionConversationNativeNodeName
  readonly bound: Runnable<unknown, unknown>
  readonly input: unknown
  readonly output: unknown
  readonly message: BaseMessage
  readonly path: FunctionConversationNativeNodePath
  /** A repeated actual message object is retained once and reconnected at all these addresses. */
  readonly paths: readonly FunctionConversationNativeNodePath[]
  /** Native objects/functions are retained. This config is never a JSON source receipt. */
  readonly config: Readonly<RunnableConfig>
  assertCurrent(): void
}

export interface FunctionConversationNativeNodeOptions {
  readonly graph: object
  readonly node: FunctionConversationNativeNodeName
  readonly runtime?: FunctionNativeConversationRuntime
  readonly sharedFactory?: FunctionConversationSharedNativeFactory
  assertCurrent(): void
  finalize(slot: FunctionConversationNativeNodeSlot): Promise<BaseMessage>
  /** Actual per-occurrence work, independent of a public cancellation or expired SDK guard. */
  whenFinalized?(slot: FunctionConversationNativeNodeSlot): Promise<void>
  /** Actual factory ACK data only, after all callbacks and drains, before original writers. */
  assertFinalizedData?(slot: FunctionConversationNativeNodeSlot, message: BaseMessage): void
}

interface NativeNode {
  bound: Runnable<unknown, unknown>
  readonly writers: readonly Runnable<unknown, unknown>[]
}
interface TaskFacts {
  readonly threadId: string
  readonly namespace: string
  readonly taskId: string
  readonly read: object
}
interface Work {
  readonly input: unknown
  readonly facts: TaskFacts
  readonly config: Readonly<RunnableConfig>
  readonly result: Promise<unknown>
  completed: boolean
  uncertain: boolean
  domain?: FunctionConversationSharedNativeDomainView
}
interface MessageAddress {
  readonly message: BaseMessage
  readonly paths: FunctionConversationNativeNodePath[]
}
type OutputPlan = (messages: ReadonlyMap<BaseMessage, BaseMessage>) => unknown
interface SlotRecord {
  readonly view: FunctionConversationNativeNodeSlotView
  readonly graph: object
  readonly work: FunctionConversationNativeNodeWork
  assertStructure(): void
  completion?: BaseMessage
  modelName?: Readonly<{ name: string; assertDataCurrent(): void }>
}
interface OriginalWork {
  readonly token: FunctionConversationNativeNodeWork
  readonly graph: object
  readonly modelName: Readonly<{ name: string; assertDataCurrent(): void }> | undefined
  readonly view: FunctionConversationNativeNodeWorkView
  assertStructure(): void
  running: boolean
  readonly domain?: FunctionConversationSharedNativeDomainView
  readonly runtime?: FunctionNativeConversationRuntime
}
const slots = new WeakMap<FunctionConversationNativeNodeSlot, SlotRecord>()
const nodeThrowIfAborted = AbortSignal.prototype.throwIfAborted
const nodeWeakGet = WeakMap.prototype.get, nodeWeakSet = WeakMap.prototype.set
const nodeMapGet = Map.prototype.get
const originalWorks = new WeakMap<FunctionConversationNativeNodeWork, OriginalWork>()
const originalScope = new AsyncLocalStorage<OriginalWork>()
const originalScopeGetStore = AsyncLocalStorage.prototype.getStore
const installed = new WeakMap<object, Set<FunctionConversationNativeNodeName>>()
const installations = new WeakMap<object, { readonly graph: object; assertStructure(): void }>()
const modelNames = new WeakMap<FunctionConversationNativeNodeModelName,
  FunctionConversationNativeNodeModelNameView>()
const modelNamesBySlot = new WeakMap<FunctionConversationNativeNodeSlot,
  FunctionConversationNativeNodeModelName>()
const workModelNames = new WeakMap<FunctionConversationNativeNodeWorkModelName,
  FunctionConversationNativeNodeWorkModelNameData>()

/** Read-only, live original-node scope. Saving this view grants no later execution authority. */
export function currentFunctionConversationOriginalNativeWork(): Readonly<{
  runtime: FunctionNativeConversationRuntime
  node: FunctionConversationNativeNodeName
  assertCurrent(): void
}> | undefined {
  const original = Reflect.apply(originalScopeGetStore, originalScope, []) as OriginalWork | undefined
  if (!original || !original.running || !original.runtime || original.domain) return undefined
  const runtime = original.runtime
  const assertData = () => {
    if (Reflect.apply(originalScopeGetStore, originalScope, []) !== original || !original.running ||
      Reflect.apply(nodeWeakGet, originalWorks, [original.token]) !== original ||
      original.runtime !== runtime) fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
    original.assertStructure()
    if (Reflect.apply(originalScopeGetStore, originalScope, []) !== original || !original.running)
      fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  }
  const assertCurrent = () => { assertData(); runtime.assertCurrent(); assertData() }
  assertData()
  return Object.freeze({ runtime, node: original.view.node, assertCurrent })
}

/** Pure original installation facts; an arbitrary public control callback cannot certify a graph. */
export function assertFunctionConversationNativeNodeInstallation(control: object, graph: object): void {
  const actual = Reflect.apply(nodeWeakGet, installations, [control]) as
    ReturnType<typeof installations.get>
  if (!actual || actual.graph !== graph) fail("MODS_CONVERSATION_NATIVE_NODE_UNAVAILABLE")
  actual.assertStructure()
}

function fail(code = "MODS_CONVERSATION_NATIVE_NODE_UNAVAILABLE"): never {
  throw new ModFunctionError(code)
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function own(value: object, key: PropertyKey): unknown {
  if (types.isProxy(value)) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return undefined
  if (!("value" in descriptor)) fail()
  return descriptor.value
}
function array(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail()
  for (let index = 0; index < value.length; index++) own(value, String(index))
  return value
}
function nativeMessage(value: unknown): BaseMessage {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
    own(value, Symbol.for("langchain.message")) !== true || !(value instanceof BaseMessage)) fail()
  return value
}
function captureOutputContainer(value: object, checks: Array<() => void>) {
  if (types.isProxy(value)) fail()
  const prototype = Object.getPrototypeOf(value)
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>
  const keys = Reflect.ownKeys(descriptors)
  for (const key of keys) if (!("value" in descriptors[key])) fail()
  checks.push(() => {
    if (types.isProxy(value) || Object.getPrototypeOf(value) !== prototype)
      fail("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
    const currentKeys = Reflect.ownKeys(value)
    if (currentKeys.length !== keys.length) fail("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
    for (const [index, key] of keys.entries()) {
      const current = Object.getOwnPropertyDescriptor(value, key), original = descriptors[key]
      if (currentKeys[index] !== key || !current || !("value" in current) ||
        !Object.is(current.value, original.value) || current.writable !== original.writable ||
        current.enumerable !== original.enumerable || current.configurable !== original.configurable)
        fail("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
    }
  })
  return { prototype, descriptors }
}
function replaceCapturedOwn(container: ReturnType<typeof captureOutputContainer>,
  key: string, replacement: unknown): object {
  const descriptors = { ...container.descriptors }
  const original = descriptors[key]
  if (!original || !("value" in original)) fail()
  descriptors[key] = { ...original, value: replacement }
  return Object.create(container.prototype, descriptors) as object
}
function taskFacts(config: RunnableConfig): TaskFacts {
  const facts = object(own(config, "configurable"))
  const threadId = own(facts, "thread_id"), namespace = own(facts, "checkpoint_ns")
  const taskId = own(facts, "__pregel_task_id"), read = own(facts, "__pregel_read")
  if (typeof threadId !== "string" || !threadId || typeof namespace !== "string" ||
    !namespace || typeof taskId !== "string" || !taskId || typeof read !== "function" ||
    types.isProxy(read)) fail()
  return Object.freeze({ threadId, namespace, taskId, read })
}
function sameTask(first: TaskFacts, second: TaskFacts): boolean {
  return first.threadId === second.threadId && first.namespace === second.namespace &&
    first.taskId === second.taskId && first.read === second.read
}

/** Installed original Work facts only; a UI actor name never grants message ownership. */
export function captureCurrentFunctionConversationNativeNodeWorkModelName(
  runtime: FunctionNativeConversationRuntime, configurable: unknown
): FunctionConversationNativeNodeWorkModelName | undefined {
  const actual = originalScope.getStore()
  if (!actual) return undefined
  if (Reflect.apply(nodeWeakGet, originalWorks, [actual.token]) !== actual ||
    !actual.running || actual.runtime !== runtime || actual.view.node !== "model_request")
    fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  if (actual.domain) return undefined
  const modelName = actual.modelName
  if (!modelName || !configurable || typeof configurable !== "object" ||
    types.isProxy(configurable)) fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  const capturedTask = taskFacts(actual.view.config)
  const requestTask = () => taskFacts({ configurable: object(configurable) })
  if (!sameTask(capturedTask, requestTask())) fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  const proof = Object.freeze({ [workModelNameBrand]: true as const })
  let reading = false, failed = false
  const view: FunctionConversationNativeNodeWorkModelNameData = Object.freeze({
    work: actual.token, graph: actual.graph, bound: actual.view.bound, runtime, configurable,
    name: modelName.name,
    assertDataCurrent() {
      if (reading) { failed = true; fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID") }
      reading = true
      try {
        if (failed || Reflect.apply(nodeWeakGet, workModelNames, [proof]) !== view ||
          Reflect.apply(nodeWeakGet, originalWorks, [actual.token]) !== actual ||
          actual.runtime !== runtime || actual.domain !== undefined || actual.modelName !== modelName ||
          !sameTask(capturedTask, taskFacts(actual.view.config)) ||
          !sameTask(capturedTask, requestTask())) fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
        actual.assertStructure()
        modelName.assertDataCurrent()
      } catch (error) { failed = true; throw error }
      finally { reading = false }
    }
  })
  Reflect.apply(nodeWeakSet, workModelNames, [proof, view])
  view.assertDataCurrent()
  if (!actual.running || originalScope.getStore() !== actual)
    fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  return proof
}

export function readFunctionConversationNativeNodeWorkModelName(proof: unknown, runtime: object,
  configurable: object): FunctionConversationNativeNodeWorkModelNameData {
  if (!proof || typeof proof !== "object" || types.isProxy(proof))
    fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  const view = Reflect.apply(nodeWeakGet, workModelNames, [proof]) as
    FunctionConversationNativeNodeWorkModelNameData | undefined
  if (!view || view.runtime !== runtime || view.configurable !== configurable)
    fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  view.assertDataCurrent()
  return view
}

/** A slot is data plus the original node lifecycle guard, never a target/grant capability. */
export function readFunctionConversationNativeNodeSlot(
  slot: FunctionConversationNativeNodeSlot
): FunctionConversationNativeNodeSlotView {
  const record = slots.get(slot)
  if (!record) fail("MODS_CONVERSATION_NATIVE_NODE_SLOT_INVALID")
  record.view.assertCurrent()
  return record.view
}

/** Completed original Slot data only; the caller still owns the full source admission. */
export function readFunctionConversationNativeNodeSlotData(
  slot: FunctionConversationNativeNodeSlot
): FunctionConversationNativeNodeSlotView {
  const record = Reflect.apply(nodeWeakGet, slots, [slot]) as SlotRecord | undefined
  if (!record) fail("MODS_CONVERSATION_NATIVE_NODE_SLOT_INVALID")
  record.assertStructure()
  return record.view
}

/** Config equality cannot manufacture this address outside the actual original bound call. */
export function captureCurrentFunctionConversationNativeNodeWork(
  bound: object
): FunctionConversationNativeNodeWork {
  const actual = originalScope.getStore()
  if (!actual || !actual.running || actual.view.bound !== bound ||
    originalWorks.get(actual.token) !== actual)
    fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  actual.assertStructure()
  if (!actual.running || originalScope.getStore() !== actual)
    fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  return actual.token
}

export function readFunctionConversationNativeNodeWork(
  token: FunctionConversationNativeNodeWork
): FunctionConversationNativeNodeWorkView {
  const actual = originalWorks.get(token)
  if (!actual) fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  actual.assertStructure()
  return actual.view
}

/** Pure exact original Work ownership, fixed before its first source callback. */
export function readFunctionConversationNativeNodeWorkRuntime(
  token: FunctionConversationNativeNodeWork, factory: FunctionConversationSharedNativeFactory
): FunctionNativeConversationRuntime | undefined {
  const actual = Reflect.apply(nodeWeakGet, originalWorks, [token]) as OriginalWork | undefined
  if (!actual) fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  actual.assertStructure()
  const domain = actual.domain
  if (!domain) return undefined
  if (domain.factory !== factory) fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  domain.assertDataCurrent()
  return domain.runtime
}

/** Ordinary invocations have no native Work and retain their actual original tool path. */
export function currentFunctionConversationNativeNodeWorkRuntime(
  bound: object, factory: FunctionConversationSharedNativeFactory
): FunctionNativeConversationRuntime | undefined {
  const actual = originalScope.getStore()
  if (!actual || !actual.running || actual.view.bound !== bound) return undefined
  if (Reflect.apply(nodeWeakGet, originalWorks, [actual.token]) !== actual)
    fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  return readFunctionConversationNativeNodeWorkRuntime(actual.token, factory)
}

/** A completed slot must belong to the exact captured original invocation, not matching IDs. */
export function assertFunctionConversationNativeNodeWorkSlot(
  work: FunctionConversationNativeNodeWork, slot: FunctionConversationNativeNodeSlot
): void {
  const actual = originalWorks.get(work), record = slots.get(slot)
  if (!actual || !record || record.work !== work || record.view.bound !== actual.view.bound)
    fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  record.view.assertCurrent()
}

/** Exact original Work/slot structure; the caller still runs their shared physical source. */
export function assertFunctionConversationNativeNodeWorkSlotStructure(
  work: FunctionConversationNativeNodeWork,
  slot: FunctionConversationNativeNodeSlot
): void {
  const actual = Reflect.apply(nodeWeakGet, originalWorks, [work]) as OriginalWork | undefined
  const record = Reflect.apply(nodeWeakGet, slots, [slot]) as SlotRecord | undefined
  if (
    !actual || !record || record.work !== work || record.view.bound !== actual.view.bound ||
    record.view.assertCurrent !== actual.view.assertCurrent
  )
    fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  record.assertStructure()
}

/** Private address checks only. A certified host still owns the full physical source guard. */
export function assertFunctionConversationNativeNodeSlotStructure(
  slot: FunctionConversationNativeNodeSlot
): void {
  const record = Reflect.apply(nodeWeakGet, slots, [slot]) as SlotRecord | undefined
  if (!record) fail("MODS_CONVERSATION_NATIVE_NODE_SLOT_INVALID")
  record.assertStructure()
}

/** Original Work ownership only; neither copied config nor public slot data selects a runtime. */
export function readFunctionConversationNativeNodeSlotRuntime(
  slot: FunctionConversationNativeNodeSlot
): FunctionNativeConversationRuntime | undefined {
  const record = Reflect.apply(nodeWeakGet, slots, [slot]) as SlotRecord | undefined
  if (!record) fail("MODS_CONVERSATION_NATIVE_NODE_SLOT_INVALID")
  record.assertStructure()
  const actual = Reflect.apply(nodeWeakGet, originalWorks, [record.work]) as OriginalWork | undefined
  if (!actual) fail("MODS_CONVERSATION_NATIVE_NODE_WORK_INVALID")
  return actual.runtime
}

/** Original AgentNode.name facts only; this does not authorize any message publication. */
export function captureFunctionConversationNativeNodeModelName(slot: FunctionConversationNativeNodeSlot,
  runtime: FunctionNativeConversationRuntime): FunctionConversationNativeNodeModelName {
  const record = Reflect.apply(nodeWeakGet, slots, [slot]) as SlotRecord | undefined
  const original = record && Reflect.apply(nodeWeakGet, originalWorks, [record.work]) as
    OriginalWork | undefined
  if (!record || !original || record.view.node !== "model_request" ||
    original.runtime !== runtime || !record.modelName) fail()
  const previous = Reflect.apply(nodeWeakGet, modelNamesBySlot, [slot]) as
    FunctionConversationNativeNodeModelName | undefined
  if (previous) { readFunctionConversationNativeNodeModelName(previous); return previous }
  const proof = Object.freeze({ [modelNameBrand]: true as const })
  let reading = false, failed = false
  const view: FunctionConversationNativeNodeModelNameView = Object.freeze({ slot, runtime,
    message: record.view.message, config: record.view.config, name: record.modelName.name,
    assertDataCurrent() {
      if (reading) { failed = true; fail() }
      reading = true
      try {
        if (failed || Reflect.apply(nodeWeakGet, modelNames, [proof]) !== view ||
          Reflect.apply(nodeWeakGet, modelNamesBySlot, [slot]) !== proof ||
          Reflect.apply(nodeWeakGet, slots, [slot]) !== record ||
          Reflect.apply(nodeWeakGet, originalWorks, [record.work]) !== original ||
          original.runtime !== runtime) fail()
        record.assertStructure()
        record.modelName!.assertDataCurrent()
      } catch (error) { failed = true; throw error }
      finally { reading = false }
    } })
  modelNames.set(proof, view)
  modelNamesBySlot.set(slot, proof)
  view.assertDataCurrent()
  return proof
}
export function readFunctionConversationNativeNodeModelName(proof: FunctionConversationNativeNodeModelName):
  FunctionConversationNativeNodeModelNameView {
  const view = Reflect.apply(nodeWeakGet, modelNames, [proof]) as
    FunctionConversationNativeNodeModelNameView | undefined
  if (!view) fail()
  view.assertDataCurrent()
  return view
}

/** The exact replacement accepted by this actual completed bound, before its original writers. */
export function readFunctionConversationNativeNodeCompletion(
  slot: FunctionConversationNativeNodeSlot, graph: object, message: BaseMessage
): FunctionConversationNativeNodeSlotView {
  const record = slots.get(slot)
  if (!record || record.graph !== graph || record.completion !== message)
    fail("MODS_CONVERSATION_NATIVE_NODE_SLOT_INVALID")
  record.view.assertCurrent()
  return record.view
}

function outputPlan(output: unknown, history: ReadonlySet<BaseMessage>,
  addresses: Map<BaseMessage, MessageAddress>, checks: Array<() => void>): OutputPlan {
  const capturedArray = (value: unknown) => {
    const original = array(value), container = captureOutputContainer(original, checks)
    const length = container.descriptors.length?.value
    if (!Number.isSafeInteger(length) || length < 0) fail()
    const values: unknown[] = []
    for (let index = 0; index < length; index++) {
      const descriptor = container.descriptors[String(index)]
      if (!descriptor || !("value" in descriptor)) fail()
      values.push(descriptor.value)
    }
    return values
  }
  const messagePlan = (value: unknown, path: FunctionConversationNativeNodePath): OutputPlan => {
    if (Array.isArray(value)) {
      const values = capturedArray(value)
      const plans = values.map((message, index) => messagePlan(message, [...path, index]))
      return replacements => {
        const next = plans.map(plan => plan(replacements))
        return next.every((value, index) => value === values[index]) ? value : next
      }
    }
    const message = nativeMessage(value)
    if (history.has(message) || message instanceof RemoveMessage) return () => message
    let address = addresses.get(message)
    if (!address) { address = { message, paths: [] }; addresses.set(message, address) }
    address.paths.push(Object.freeze([...path]))
    return replacements => replacements.get(message) ?? message
  }
  const updatePlan = (value: unknown, path: FunctionConversationNativeNodePath): OutputPlan => {
    if (Array.isArray(value)) {
      const entries = capturedArray(value)
      const plans = entries.map((entry, index): OutputPlan => {
        const tuple = capturedArray(entry)
        if (tuple.length !== 2 || typeof tuple[0] !== "string") fail()
        if (tuple[0] !== "messages") return () => entry
        const plan = messagePlan(tuple[1], [...path, index, 1])
        return replacements => {
          const next = plan(replacements)
          return next === tuple[1] ? entry : [tuple[0], next]
        }
      })
      return replacements => {
        const next = plans.map(plan => plan(replacements))
        return next.every((value, index) => value === entries[index]) ? value : next
      }
    }
    if (value === undefined || value === null) return () => value
    const update = object(value)
    if (![Object.prototype, null].includes(Object.getPrototypeOf(update))) fail()
    const container = captureOutputContainer(update, checks)
    if (!Object.hasOwn(update, "messages")) return () => value
    const current = own(update, "messages")
    const plan = messagePlan(current, [...path, "messages"])
    return replacements => {
      const next = plan(replacements)
      return next === current ? value : replaceCapturedOwn(container, "messages", next)
    }
  }
  const plan = (value: unknown, path: FunctionConversationNativeNodePath): OutputPlan => {
    if (Array.isArray(value)) {
      const values = capturedArray(value), plans = values.map((entry, index) => plan(entry, [...path, index]))
      return replacements => {
        const next = plans.map(item => item(replacements))
        return next.every((value, index) => value === values[index]) ? value : next
      }
    }
    if (value && typeof value === "object" && types.isProxy(value)) fail()
    if (value instanceof Command) {
      // Copy own descriptors to preserve graph/resume/goto, Send identities and unknown native
      // control fields. No Command.toJSON(), reconstruction or public lg_name proof is used.
      if (Object.getPrototypeOf(value) !== Command.prototype) fail()
      const container = captureOutputContainer(value, checks)
      const update = own(value, "update"), updateResult = updatePlan(update, [...path, "update"])
      return replacements => {
        const next = updateResult(replacements)
        return next === update ? value : replaceCapturedOwn(container, "update", next)
      }
    }
    return updatePlan(value, path)
  }
  return plan(output, [])
}

/** The original Runnable stays responsible for its own state, trace, config and callbacks. */
class NativeFinalizerBound extends Runnable<unknown, unknown> {
  lc_namespace: string[]
  constructor(readonly original: Runnable<unknown, unknown>,
    private readonly run: (input: unknown, config?: RunnableConfig) => Promise<unknown>) {
    super()
    this.name = original.name
    this.lc_namespace = original.lc_namespace
  }
  invoke(input: unknown, config?: RunnableConfig): Promise<unknown> {
    try { return this.run(input, config) }
    catch (error) { return Promise.reject(error) }
  }
  getState(): unknown {
    const original = this.original as Runnable<unknown, unknown> & { getState?: () => unknown }
    return original.getState?.()
  }
  setState(state: unknown): unknown {
    const original = this.original as Runnable<unknown, unknown> & { setState?: (value: unknown) => unknown }
    if (!original.setState) fail()
    return original.setState(state)
  }
}

/** Install only on a concrete compiled createAgent node, before its original channel writers. */
export function installFunctionConversationNativeNode(options: FunctionConversationNativeNodeOptions):
  Readonly<{ close(): void; whenDrained(): Promise<void>;
    whenDrainedForSharedDomain(domain: FunctionConversationSharedNativeDomain): Promise<void> }> {
  if (!options.graph || types.isProxy(options.graph) || !(options.graph instanceof CompiledStateGraph) ||
    !["model_request", "tools"].includes(options.node)) fail()
  const graph = options.graph, nodeName = options.node, sharedFactory = options.sharedFactory
  const originalRuntime = options.runtime
  const graphNodes = object(own(graph, "nodes"))
  const nodeValue = object(own(graphNodes, nodeName))
  const originalValue = own(nodeValue, "bound"), writersValue = own(nodeValue, "writers")
  if (!originalValue || typeof originalValue !== "object" || types.isProxy(originalValue) ||
    !(originalValue instanceof Runnable) || !Array.isArray(writersValue)) fail()
  const node = nodeValue as unknown as NativeNode, original = originalValue
  const writers = [...writersValue]
  if (writers.some(writer => !(writer instanceof Runnable))) fail()
  const builder = object(own(graph, "builder")), builderNodes = object(own(builder, "nodes"))
  const builderNode = object(own(builderNodes, nodeName))
  if (own(builderNode, "runnable") !== original) fail()
  const nameDescriptor = nodeName === "model_request"
    ? Object.getOwnPropertyDescriptor(original, "name") : undefined
  const boundPrototype = Object.getPrototypeOf(original)
  if (nodeName === "model_request" && (!nameDescriptor || !("value" in nameDescriptor) ||
    typeof nameDescriptor.value !== "string" || !nameDescriptor.value)) fail()
  const modelName = nameDescriptor ? Object.freeze({ name: nameDescriptor.value as string,
    assertDataCurrent() {
      const current = Object.getOwnPropertyDescriptor(original, "name")
      if (types.isProxy(original) || Object.getPrototypeOf(original) !== boundPrototype ||
        own(graph, "builder") !== builder || own(builder, "nodes") !== builderNodes ||
        own(builderNodes, nodeName) !== builderNode || own(builderNode, "runnable") !== original ||
        !current || !("value" in current) || current.value !== nameDescriptor.value ||
        current.enumerable !== nameDescriptor.enumerable ||
        current.configurable !== nameDescriptor.configurable ||
        current.writable !== nameDescriptor.writable) fail("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
    } }) : undefined
  let names = installed.get(graph)
  if (!names) { names = new Set(); installed.set(graph, names) }
  if (names.has(nodeName)) fail()
  names.add(nodeName)
  const host = Object.freeze({ assertCurrent: options.assertCurrent.bind(options),
    finalize: options.finalize.bind(options),
    whenFinalized: options.whenFinalized?.bind(options),
    assertFinalizedData: options.assertFinalizedData?.bind(options) })
  const byRead = new WeakMap<object, Map<string, Work>>()
  const pending = new Set<Promise<unknown>>()
  const sharedPending = new WeakMap<FunctionConversationSharedNativeDomain, Set<Promise<unknown>>>()
  let closed = false
  const structure = () => {
    modelName?.assertDataCurrent()
    if (closed || own(graph, "nodes") !== graphNodes || own(graphNodes, nodeName) !== node ||
      own(node, "bound") !== wrapper || own(node, "writers") !== writersValue ||
      own(writersValue, "length") !== writers.length)
      fail("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
    for (let index = 0; index < writers.length; index++)
      if (own(writersValue, String(index)) !== writers[index])
        fail("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
  }
  const run = (input: unknown, provided?: RunnableConfig): Promise<unknown> => {
    // No external guard runs until the original task has its private once record.
    structure()
    if (!provided) fail()
    const facts = taskFacts(provided)
    const key = JSON.stringify([facts.threadId, facts.namespace, facts.taskId])
    let tasks = byRead.get(facts.read)
    if (!tasks) { tasks = new Map(); byRead.set(facts.read, tasks) }
    const previous = tasks.get(key)
    if (previous) {
      if (previous.input !== input || !sameTask(previous.facts, facts)) fail()
      if (sharedFactory && readCurrentFunctionConversationSharedNativeDomain(
        sharedFactory, graph) !== previous.domain) fail()
      return previous.result
    }
    const config = Object.freeze({ ...provided,
      configurable: Object.freeze({ ...provided.configurable }) })
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void
    const result = new Promise<unknown>((yes, no) => { resolve = yes; reject = no })
    const work: Work = { input, config, facts, result, completed: false, uncertain: false }
    tasks.set(key, work)
    pending.add(result)
    // Fix this invocation's genuine domain after its once latch, before any source callback.
    let domain: FunctionConversationSharedNativeDomainView | undefined
    try {
      domain = sharedFactory
        ? readCurrentFunctionConversationSharedNativeDomain(sharedFactory, graph) : undefined
      work.domain = domain
      if (domain) {
        let owned = sharedPending.get(domain.domain)
        if (!owned) { owned = new Set(); sharedPending.set(domain.domain, owned) }
        owned.add(result)
      }
    } catch (error) {
      tasks.delete(key)
      pending.delete(result)
      reject(error)
      return result
    }
    if (sharedFactory && !domain) {
      void original.invoke(input, provided).then(value => {
        work.completed = true
        pending.delete(result)
        resolve(value)
      }, error => {
        tasks.delete(key)
        pending.delete(result)
        reject(error)
      })
      return result
    }
    const invocationHost = domain?.host.nodeCallbacks ?? host
    // Install once before the first native invoke, guard or finalizer callback can reenter.
    const assertStructure = () => {
      structure()
      if (config.signal) Reflect.apply(nodeThrowIfAborted, config.signal, [])
      if (Reflect.apply(nodeMapGet, tasks, [key]) !== work || !sameTask(facts, taskFacts(provided)) ||
        own(provided, "signal") !== config.signal)
        fail("MODS_CONVERSATION_NATIVE_NODE_CHANGED")
      domain?.assertDataCurrent()
    }
    const assertCurrent = () => {
      assertStructure()
      structure()
      invocationHost.assertCurrent()
      structure()
      assertStructure()
    }
    const workToken: FunctionConversationNativeNodeWork = Object.freeze({
      [workBrand]: true as const
    })
    const originalWork: OriginalWork = { token: workToken, graph, modelName,
      running: false, assertStructure, domain,
      runtime: domain?.runtime ?? originalRuntime,
      view: Object.freeze({ node: nodeName, bound: original, input, config, assertCurrent }) }
    originalWorks.set(workToken, originalWork)
    const actual = async () => {
      assertCurrent()
      let output: unknown
      originalWork.running = true
      try {
        const configured = domain ? domain.host.nodeCallbacks.configure(provided) : provided
        if (domain) assertCurrent()
        output = await originalScope.run(originalWork, () => original.invoke(input, configured))
      } finally { originalWork.running = false }
      work.completed = true
      assertCurrent()
      const history = new Set<BaseMessage>()
      if (input && typeof input === "object" && !Array.isArray(input)) {
        const values = own(input, "messages")
        if (Array.isArray(values)) for (const message of array(values)) history.add(nativeMessage(message))
        else if (values !== undefined) history.add(nativeMessage(values))
      }
      const addresses = new Map<BaseMessage, MessageAddress>()
      const outputChecks: Array<() => void> = []
      const transform = outputPlan(output, history, addresses, outputChecks)
      const replacements = new Map<BaseMessage, BaseMessage>()
      const finalized: Array<{ slot: FunctionConversationNativeNodeSlot; message: BaseMessage }> = []
      for (const address of addresses.values()) {
        assertCurrent()
        const paths = Object.freeze([...address.paths])
        const path = paths[0]
        if (!path) fail()
        const slot = Object.freeze({ [slotBrand]: true as const })
        const view: FunctionConversationNativeNodeSlotView = Object.freeze({
          node: nodeName, bound: original, input, output, message: address.message,
          path, paths, config, assertCurrent
        })
        const record: SlotRecord = { view, graph, work: workToken,
          ...(modelName ? { modelName } : {}), assertStructure: () => {
          assertStructure()
          if (!work.completed || Reflect.apply(nodeWeakGet, slots, [slot]) !== record)
            fail("MODS_CONVERSATION_NATIVE_NODE_SLOT_INVALID")
        } }
        slots.set(slot, record)
        let message: BaseMessage | undefined, primary: unknown, rejected = false
        try { message = nativeMessage(await invocationHost.finalize(slot)) }
        catch (error) { primary = error; rejected = true }
        // A promptly rejected public Keeper promise is not its physical finally. The native
        // callback uses its prior slot binding without borrowing an expired SDK source guard.
        if (invocationHost.whenFinalized) {
          try { await invocationHost.whenFinalized(slot) }
          catch (error) {
            work.uncertain = true
            if (!rejected) { primary = error; rejected = true }
          }
        }
        if (rejected) throw primary
        if (!message) fail()
        assertCurrent()
        record.completion = message
        recordFunctionConversationNativeCompletion(graph, slot, message)
        replacements.set(address.message, message)
        finalized.push({ slot, message })
      }
      assertCurrent()
      for (const completion of finalized) {
        const checked: unknown = invocationHost.assertFinalizedData?.(completion.slot, completion.message)
        if (checked !== undefined) fail("MODS_CONVERSATION_ASYNC_TRANSACTION")
      }
      assertStructure()
      for (const check of outputChecks) check()
      return transform(replacements)
    }
    void actual().then(value => {
      if (domain) sharedPending.get(domain.domain)?.delete(result)
      pending.delete(result); resolve(value)
    }, error => {
      // Only a failure before the original bound completed can use the original graph retry.
      if (!work.completed && tasks.get(key) === work) tasks.delete(key)
      if (!work.uncertain) {
        if (domain) sharedPending.get(domain.domain)?.delete(result)
        pending.delete(result)
      }
      reject(error)
    })
    return result
  }
  const wrapper = new NativeFinalizerBound(original, run)
  node.bound = wrapper
  const control = Object.freeze({
    close() { closed = true },
    async whenDrainedForSharedDomain(domain: FunctionConversationSharedNativeDomain) {
      const owned = sharedPending.get(domain)
      while (owned?.size) {
        const snapshot = [...owned]
        await Promise.allSettled(snapshot)
        if (snapshot.some(result => owned.has(result)))
          fail("MODS_CONVERSATION_NATIVE_NODE_DRAIN_UNKNOWN")
      }
    },
    async whenDrained() {
      while (pending.size) {
        const snapshot = [...pending]
        await Promise.allSettled(snapshot)
        if (snapshot.some(result => pending.has(result)))
          fail("MODS_CONVERSATION_NATIVE_NODE_DRAIN_UNKNOWN")
      }
    }
  })
  Reflect.apply(nodeWeakSet, installations, [control, { graph, assertStructure: structure }])
  return control
}
