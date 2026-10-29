import { randomUUID } from "node:crypto"
import { types } from "node:util"
import { AsyncLocalStorage } from "node:async_hooks"
import { AIMessage, BaseMessage, HumanMessage, RemoveMessage, SystemMessage, ToolMessage } from
  "@langchain/core/messages"
import { Runnable, type RunnableConfig } from "@langchain/core/runnables"
import { Command, CompiledStateGraph } from "@langchain/langgraph"
import { readFunctionConversationNativeWithdrawal, isFunctionNativeGuestWithdrawalError,
  type FunctionNativeConversationRuntime } from "../mods/manager"
import type { ModRuntimeAuthority } from "../mods/runtime-instance"
import { withFunctionTransportExecution } from "../mods/v2/host-call"
import {
  readFunctionConversationNativePolicySource,
  readFunctionConversationNativeSharedPolicySource
} from "../mods/native-conversation-policy-source"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import {
  assertFunctionConversationNativeNodeWorkSlot,
  assertFunctionConversationNativeNodeWorkSlotStructure,
  assertFunctionConversationNativeNodeSlotStructure,
  captureCurrentFunctionConversationNativeNodeWork,
  currentFunctionConversationNativeNodeWorkRuntime,
  readFunctionConversationNativeNodeSlot,
  readFunctionConversationNativeNodeWork,
  readFunctionConversationNativeNodeWorkRuntime,
  type FunctionConversationNativeNodeSlot,
  type FunctionConversationNativeNodeWork
} from "./function-conversation-native-node"
import type { FunctionConversationSharedNativeFactory } from
  "./function-conversation-shared-native-domain"

const requestBrand = Symbol("function-native-tool-request")
const returnBrand = Symbol("function-native-tool-return")
export interface FunctionNativeToolRequest { readonly [requestBrand]: true }
export interface FunctionNativeToolReturn { readonly [returnBrand]: true }
type Policy = ReturnType<FunctionNativeConversationRuntime["capturePolicy"]>

export interface FunctionNativeToolReturnView {
  readonly receipt: FunctionNativeToolReturn
  readonly request: FunctionNativeToolRequest
  readonly message: ToolMessage | HumanMessage | AIMessage | SystemMessage
  readonly door: "tool-result" | "tool-message"
  readonly origin: Readonly<{ kind: "tool"; tool: string }>
  readonly uuid: string
  readonly originalCallId?: string
  readonly policy: Policy
  /** Original completed node invocation cut, independently of the runtime's physical signal. */
  readonly signal?: AbortSignal
  assertCurrent(): void
  /** Original private address/Work/slot checks only; never a runtime or policy callback. */
  assertTail(): void
}
const returnSources = new WeakMap<FunctionNativeToolReturn, {
  readonly runtime: object
  read(slot: FunctionConversationNativeNodeSlot): FunctionNativeToolReturnView
  /** Only this original ToolNode factory records its already-complete private read. */
  readonly readChecked?: (slot: FunctionConversationNativeNodeSlot) => FunctionNativeToolReturnView
  reading: boolean
  failed: boolean
}>()

/** Exact native factory receipt; equal configs or a caller-created ledger cannot mint it. */
export function readFunctionConversationNativeToolReturn(receipt: FunctionNativeToolReturn,
  slot: FunctionConversationNativeNodeSlot,
  originalRuntime: FunctionNativeConversationRuntime): FunctionNativeToolReturnView {
  const record = returnSources.get(receipt)
  if (!record || record.runtime !== originalRuntime) fail()
  if (record.reading) { record.failed = true; fail() }
  if (record.failed) fail()
  record.reading = true
  try {
    const view = (record.readChecked ?? record.read)(slot)
    if (view.receipt !== receipt) fail()
    const certificate = readFunctionConversationNativePolicySource(view.policy, originalRuntime)
    if (!certificate) fail()
    if (!record.readChecked) {
      // Unknown/private legacy records keep all independent full checks. A data label cannot
      // certify that the original Work, slot and policy callbacks have already run.
      certificate.assertCurrent()
      view.assertCurrent()
    }
    certificate.assertTail()
    view.assertTail()
    if (record.failed || !record.reading || returnSources.get(receipt) !== record ||
      record.runtime !== originalRuntime || view.receipt !== receipt) fail()
    return view
  } catch (error) { record.failed = true; throw error }
  finally { record.reading = false }
}
type ToolRuntime = Pick<FunctionNativeConversationRuntime, "assertCurrent" | "capturePolicy">
export type FunctionConversationNativeToolsOptions = {
  /** Only the actual createAgent factory installs this on its original tools runnable. */
  readonly graph: object
} & ({ readonly runtime: ToolRuntime; readonly sharedFactory?: never } |
  { readonly runtime?: never; readonly sharedFactory: FunctionConversationSharedNativeFactory })

interface ToolRequest {
  readonly token: FunctionNativeToolRequest
  readonly work: FunctionConversationNativeNodeWork
  readonly call: object
  readonly config: RunnableConfig
  readonly name: string
  readonly callId?: string
  readonly args: unknown
  readonly history: ReadonlySet<BaseMessage>
  readonly result: Promise<unknown>
  readonly runtime: ToolRuntime
  policy?: Policy
  returned: boolean
  failed: boolean
  sealed: boolean
  completionClaimed?: boolean
  assertCurrent(): void
}
const nativeToolScope = new AsyncLocalStorage<ToolRequest>()
const nativeToolGetStore = AsyncLocalStorage.prototype.getStore
const nativeToolExit = AsyncLocalStorage.prototype.exit
/** A new independent Host child never inherits its parent's ToolNode completion receipt. */
export function withoutFunctionNativeToolCompletion<T>(run: () => T): T {
  return Reflect.apply(nativeToolExit, nativeToolScope, [run]) as T
}
const nativeToolRequests = new WeakSet<ToolRequest>()
const nativeToolHas = WeakSet.prototype.has, nativeToolAdd = WeakSet.prototype.add
export interface FunctionNativeToolCompletion {
  isWithdrawn(): boolean
  publish<T>(value: T): Promise<T>
  runTail<T>(handler: () => Promise<T>): Promise<T>
  run<T>(handler: () => Promise<T>): Promise<T>
  /** Undefined means no certified, fulfilled native result is available. */
  recover(error: unknown): Readonly<{ value: unknown }> | undefined
}
/** Only the exact original ToolNode call can claim its once-only native completion. */
export function captureCurrentFunctionNativeToolCompletion(
  authority: ModRuntimeAuthority, call: { name?: string; id?: string; args?: unknown }
): FunctionNativeToolCompletion | undefined {
  const request = Reflect.apply(nativeToolGetStore, nativeToolScope, []) as ToolRequest | undefined
  if (!request) return undefined
  if (!Reflect.apply(nativeToolHas, nativeToolRequests, [request])) fail()
  const source = readFunctionConversationNativeWithdrawal(request.runtime)
  if (!source) return undefined
  if (types.isProxy(call) || source.authority !== authority || request.name !== own(call, "name") ||
    request.callId !== own(call, "id") || request.args !== own(call, "args") ||
    request.completionClaimed) fail()
  request.completionClaimed = true
  let phase: "not-started" | "running" | "fulfilled" | "rejected" = "not-started"
  let tailClaimed = false
  let value: unknown
  const assertCurrent = () => {
    if (Reflect.apply(nativeToolGetStore, nativeToolScope, []) !== request ||
      request.returned || request.failed) fail()
    request.assertCurrent()
  }
  assertCurrent()
  return Object.freeze({
    isWithdrawn() { assertCurrent(); return source.isWithdrawn() },
    async publish<T>(value: T): Promise<T> {
      assertCurrent()
      const result = await source.publish(value, request.callId)
      assertCurrent()
      return result
    },
    async runTail<T>(handler: () => Promise<T>): Promise<T> {
      if (phase !== "running" || tailClaimed) fail()
      tailClaimed = true
      assertCurrent()
      const owner = source.authority
      return withFunctionTransportExecution({ workspace: owner.workspace, threadId: owner.threadId,
        agentId: owner.agentId, turnId: owner.turnId, runtimeAuthority: owner,
        userInitiated: false, leased: true, immediate: false }, async () => {
        assertCurrent()
        const result = await handler()
        assertCurrent()
        return result
      })
    },
    async run<T>(handler: () => Promise<T>): Promise<T> {
      if (phase !== "not-started") fail()
      phase = "running"
      try {
        assertCurrent()
        const result = await handler()
        assertCurrent()
        const published = await source.publish(result, request.callId)
        assertCurrent()
        value = published
        phase = "fulfilled"
        return published
      } catch (error) { phase = "rejected"; throw error }
    },
    recover(error) {
      if (phase !== "fulfilled" || !isFunctionNativeGuestWithdrawalError(error)) return undefined
      assertCurrent()
      if (!source.isWithdrawn()) return undefined
      assertCurrent()
      return Object.freeze({ value })
    }
  })
}
interface Returned {
  readonly owner: ToolRequest
  readonly token: FunctionNativeToolReturn
  readonly message: ToolMessage | HumanMessage | AIMessage | SystemMessage
  readonly output: unknown
  readonly door: "tool-result" | "tool-message"
  readonly paths: readonly (readonly (string | number)[])[]
  readonly uuid: string
}
type Path = readonly (string | number)[]
const toolBindingWeakGet = WeakMap.prototype.get, toolBindingWeakSet = WeakMap.prototype.set
const toolBindings = new WeakMap<object, {
  readonly graph: object
  readonly bound: object
  readonly factory?: FunctionConversationSharedNativeFactory
  assertStructure(): void
}>()

/** Original installed ledger data only; a caller-created ledger cannot attach to another domain. */
export function assertFunctionConversationNativeToolsBinding(ledger: FunctionConversationNativeTools,
  graph: object, factory?: FunctionConversationSharedNativeFactory): object {
  const original = Reflect.apply(toolBindingWeakGet, toolBindings, [ledger]) as
    ReturnType<typeof toolBindings.get>
  if (!original || original.graph !== graph || original.factory !== factory) fail()
  original.assertStructure()
  return original.bound
}

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_NATIVE_TOOL_SOURCE_INVALID") }
function object(value: unknown): object {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  return value
}
function own(value: object, key: PropertyKey): unknown {
  if (types.isProxy(value)) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return undefined
  if (!("value" in descriptor)) fail()
  return descriptor.value
}
function array(value: unknown): readonly unknown[] {
  const actual = object(value)
  if (!Array.isArray(actual) || Object.getPrototypeOf(actual) !== Array.prototype) fail()
  const length = own(actual, "length")
  if (typeof length !== "number" || length < 0 || !Number.isSafeInteger(length) ||
    length > 1_000_000 ||
    Reflect.ownKeys(actual).length !== length + 1) fail()
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(actual, String(index))
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail()
  }
  return actual
}
function message(value: unknown): BaseMessage {
  const actual = object(value)
  if (!(actual instanceof BaseMessage) || own(actual, Symbol.for("langchain.message")) !== true)
    fail()
  return actual
}
function inputHistory(state: unknown): ReadonlySet<BaseMessage> {
  const values = Array.isArray(state) ? state : own(object(state), "messages")
  if (values === undefined) return new Set()
  return new Set((Array.isArray(values) ? array(values) : [values]).map(message))
}
function facts(config: RunnableConfig) {
  const data = object(own(config, "configurable"))
  const thread = own(data, "thread_id"), namespace = own(data, "checkpoint_ns")
  const task = own(data, "__pregel_task_id"), read = own(data, "__pregel_read")
  if (typeof thread !== "string" || !thread || typeof namespace !== "string" || !namespace ||
    typeof task !== "string" || !task || typeof read !== "function" || types.isProxy(read)) fail()
  return { thread, namespace, task, read, signal: own(config, "signal") }
}
function equalFacts(a: ReturnType<typeof facts>, b: ReturnType<typeof facts>): boolean {
  return a.thread === b.thread && a.namespace === b.namespace && a.task === b.task &&
    a.read === b.read && a.signal === b.signal
}
function returnedAddresses(output: unknown): Map<BaseMessage, Path[]> {
  const addresses = new Map<BaseMessage, Path[]>()
  const add = (value: unknown, path: Path) => {
    const actual = message(value), paths = addresses.get(actual) ?? []
    paths.push(Object.freeze([...path])); addresses.set(actual, paths)
  }
  if (output && typeof output === "object" && !types.isProxy(output) &&
    Object.getPrototypeOf(output) === ToolMessage.prototype) { add(output, []); return addresses }
  const command = object(output)
  if (Object.getPrototypeOf(command) !== Command.prototype) fail()
  const update = own(command, "update")
  if (update === undefined || update === null) return addresses
  if (Array.isArray(update)) {
    for (const [index, entry] of array(update).entries()) {
      const tuple = array(entry)
      if (tuple.length !== 2 || typeof tuple[0] !== "string") fail()
      if (tuple[0] !== "messages") continue
      const values = Array.isArray(tuple[1]) ? array(tuple[1]) : [tuple[1]]
      for (const [offset, value] of values.entries()) add(value,
        Array.isArray(tuple[1]) ? ["update", index, 1, offset] : ["update", index, 1])
    }
  } else {
    const data = object(update)
    if (![Object.prototype, null].includes(Object.getPrototypeOf(data))) fail()
    const values = own(data, "messages")
    if (values !== undefined) {
      if (Array.isArray(values)) for (const [index, value] of array(values).entries())
        add(value, ["update", "messages", index])
      else add(values, ["update", "messages"])
    }
  }
  return addresses
}
function at(output: unknown, path: Path): unknown {
  let current: unknown = output
  for (const key of path) current = own(object(current), key)
  return current
}

/** Records the actual known ToolNode method; no class-name/deep-import/JSON source claim. */
export function installFunctionConversationNativeTools(options: FunctionConversationNativeToolsOptions) {
  const graph = object(options.graph)
  if (!(graph instanceof CompiledStateGraph)) fail()
  const nodes = object(own(graph, "nodes")), node = object(own(nodes, "tools"))
  const builder = object(own(graph, "builder")), builderNodes = object(own(builder, "nodes"))
  const bound = object(own(node, "bound"))
  if (!(bound instanceof Runnable) ||
    own(object(own(builderNodes, "tools")), "runnable") !== bound ||
    Object.hasOwn(bound, "runTool") || Object.hasOwn(bound, "run")) fail()
  const prototype = object(Object.getPrototypeOf(bound))
  const original = own(prototype, "runTool"), run = own(prototype, "run")
  const tools = own(bound, "tools")
  if (typeof original !== "function" || types.isProxy(original) ||
    typeof run !== "function" || types.isProxy(run)) fail()
  const originalTools = [...array(tools)]
  const originalRuntime = options.runtime, sharedFactory = options.sharedFactory
  if ((originalRuntime === undefined) === (sharedFactory === undefined)) fail()
  // Ordinary/generic installation keeps its original method snapshot. Shared work obtains an
  // exact private runtime before any callback and snapshots that request's own methods below.
  const originalMethods = originalRuntime ? Object.freeze({
    assertCurrent: originalRuntime.assertCurrent.bind(originalRuntime),
    capturePolicy: originalRuntime.capturePolicy.bind(originalRuntime)
  }) : undefined
  const requests = new WeakMap<FunctionNativeToolRequest, ToolRequest>()
  const byWork = new WeakMap<FunctionConversationNativeNodeWork, WeakMap<object, ToolRequest>>()
  const returned = new WeakMap<object, Set<Returned>>()
  const receipts = new WeakMap<FunctionNativeToolReturn, Returned>()
  const pending = new Set<Promise<unknown>>()
  const runtimePending = new WeakMap<object, Set<Promise<unknown>>>()
  let closed = false
  const structure = () => {
    if (closed || own(graph, "nodes") !== nodes || own(nodes, "tools") !== node ||
      own(graph, "builder") !== builder || own(builder, "nodes") !== builderNodes ||
      own(object(own(builderNodes, "tools")), "runnable") !== bound ||
      Object.getPrototypeOf(bound) !== prototype || own(bound, "runTool") !== wrapper ||
      own(prototype, "runTool") !== original || own(prototype, "run") !== run ||
      Object.hasOwn(bound, "run") || own(bound, "tools") !== tools ||
      own(object(tools), "length") !== originalTools.length ||
      originalTools.some((tool, index) => own(object(tools), String(index)) !== tool)) fail()
  }
  const readReturn = (entry: Returned, slot: FunctionConversationNativeNodeSlot):
    FunctionNativeToolReturnView => {
    structure()
    const view = readFunctionConversationNativeNodeSlot(slot)
    if (view.node !== "tools" || view.bound !== bound || view.message !== entry.message) fail()
    const entries = returned.get(view.message), owner = entry.owner
    const address = () => {
      structure()
      readFunctionConversationNativeNodeWork(owner.work)
      assertFunctionConversationNativeNodeSlotStructure(slot)
      if (!entries || receipts.get(entry.token) !== entry || returned.get(view.message) !== entries ||
        entries.size !== 1 || !entries.has(entry) || !owner.returned || owner.failed ||
        !owner.policy || view.message !== entry.message ||
        entry.paths.some(path => at(entry.output, path) !== entry.message)) fail()
    }
    const current = () => {
      address()
      if (
        sharedFactory && owner.policy &&
        readFunctionConversationNativeSharedPolicySource(owner.policy, owner.runtime)
      )
        assertFunctionConversationNativeNodeWorkSlotStructure(owner.work, slot)
      else assertFunctionConversationNativeNodeWorkSlot(owner.work, slot)
      owner.assertCurrent()
      address()
    }
    current()
    if (!owner.policy) fail()
    const signal = own(view.config, "signal")
    if (signal !== undefined && (types.isProxy(signal) || !(signal instanceof AbortSignal))) fail()
    return Object.freeze({ receipt: entry.token, request: owner.token, message: entry.message,
      door: entry.door, origin: Object.freeze({ kind: "tool" as const, tool: owner.name }),
      uuid: entry.uuid, ...(owner.callId === undefined ? {} : { originalCallId: owner.callId }),
      ...(signal === undefined ? {} : { signal }),
      policy: owner.policy, assertCurrent: current, assertTail: address })
  }
  const wrapper = (rawCall: unknown, config: RunnableConfig, state: unknown): Promise<unknown> => {
    structure()
    const requestRuntime = sharedFactory
      ? currentFunctionConversationNativeNodeWorkRuntime(bound, sharedFactory) : originalRuntime
    // A known shared graph can also run ordinary unowned work. It acquires no native receipt,
    // including an ancestor task's completion receipt inherited across the child invocation.
    // The installed factory/Work check above selects this entry; identity mismatches in an
    // owned request still fail closed. exit restores the parent's scope after this call.
    if (!requestRuntime) return Reflect.apply(nativeToolExit, nativeToolScope, [
      () => Reflect.apply(original, bound, [rawCall, config, state])
    ])
    const runtime = originalMethods ?? Object.freeze({
      assertCurrent: requestRuntime.assertCurrent.bind(requestRuntime),
      capturePolicy: requestRuntime.capturePolicy.bind(requestRuntime)
    })
    const call = object(rawCall)
    // This lookup is structural only: install the once latch before any host guard can reenter.
    const work = captureCurrentFunctionConversationNativeNodeWork(bound)
    const source = readFunctionConversationNativeNodeWork(work)
    if (source.node !== "tools" || source.bound !== bound) fail()
    let calls = byWork.get(work)
    if (!calls) { calls = new WeakMap(); byWork.set(work, calls) }
    const previous = calls.get(call)
    if (previous) {
      if (previous.config !== config) { previous.failed = true; fail() }
      return previous.result
    }
    const name = own(call, "name"), callId = own(call, "id"), args = own(call, "args")
    if (typeof name !== "string" || !name.trim() || name.trim() !== name ||
      (callId !== undefined && (typeof callId !== "string" || !callId))) fail()
    const capturedFacts = facts(config)
    if (!equalFacts(capturedFacts, facts(source.config))) fail()
    const history = inputHistory(state)
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void
    const result = new Promise<unknown>((yes, no) => { resolve = yes; reject = no })
    void result.catch(() => { /* A synchronous parent guard can reject before original await. */ })
    const token: FunctionNativeToolRequest = Object.freeze({ [requestBrand]: true as const })
    const request: ToolRequest = { token, work, call, config, name, runtime: requestRuntime,
      ...(callId === undefined ? {} : { callId }), args, history, result,
      returned: false, failed: false, sealed: false,
      assertCurrent() {
        const actual = () => {
          structure()
          readFunctionConversationNativeNodeWork(work)
          if (request.failed || requests.get(token) !== request || calls?.get(call) !== request ||
            (sharedFactory && readFunctionConversationNativeNodeWorkRuntime(work, sharedFactory) !==
              requestRuntime) ||
            own(call, "name") !== name || own(call, "id") !== callId || own(call, "args") !== args ||
            !equalFacts(capturedFacts, facts(config))) fail()
        }
        actual()
        // Preserve the original Node source callback even for certified Manager runtimes.
        source.assertCurrent()
        const certificate = request.policy &&
          readFunctionConversationNativePolicySource(request.policy, requestRuntime)
        if (certificate) {
          certificate.assertCurrent()
          actual()
          certificate.assertTail()
        } else {
          // Capture-before-policy and generic/foreign objects keep all independent checks.
          runtime.assertCurrent()
          request.policy?.assertCurrent()
        }
        actual()
      }
    }
    requests.set(token, request); calls.set(call, request); pending.add(result)
    Reflect.apply(nativeToolAdd, nativeToolRequests, [request])
    let ownPending = runtimePending.get(requestRuntime)
    if (!ownPending) { ownPending = new Set(); runtimePending.set(requestRuntime, ownPending) }
    const actualPending = ownPending
    actualPending.add(result)
    const actual = async () => {
      request.assertCurrent()
      request.policy = runtime.capturePolicy()
      request.assertCurrent()
      const output: unknown = await nativeToolScope.run(request, () =>
        Reflect.apply(original, bound, [rawCall, config, state]))
      request.returned = true
      try {
        request.assertCurrent()
        const addresses = returnedAddresses(output)
        const additions: Returned[] = []
        for (const [actual, paths] of addresses) {
          if (history.has(actual) || actual instanceof RemoveMessage) continue
          const type = Object.getPrototypeOf(actual)
          if (![ToolMessage.prototype, HumanMessage.prototype, AIMessage.prototype,
            SystemMessage.prototype].includes(type)) fail()
          if (type === AIMessage.prototype || type === SystemMessage.prototype) {
            const originalId = own(actual, "id")
            if (typeof originalId === "string" && originalId &&
              [...history].some(prior => own(prior, "id") === originalId)) fail()
          }
          if (type === ToolMessage.prototype && (!callId || own(actual, "tool_call_id") !== callId))
            fail()
          const receipt: FunctionNativeToolReturn = Object.freeze({ [returnBrand]: true as const })
          additions.push({ token: receipt, owner: request,
            message: actual as ToolMessage | HumanMessage | AIMessage | SystemMessage, output,
            door: type === ToolMessage.prototype ? "tool-result" : "tool-message",
            paths: Object.freeze([...paths]), uuid: randomUUID() })
        }
        if (additions.filter(value => value.door === "tool-result").length > 1) fail()
        request.assertCurrent()
        // No callback between the exact-address conflict check and publishing this private batch.
        for (const value of additions) {
          const existing = returned.get(value.message)
          if (existing?.size) {
            for (const prior of existing) prior.owner.failed = true
            fail()
          }
          if (value.paths.some(path => at(output, path) !== value.message)) fail()
        }
        for (const value of additions) {
          returned.set(value.message, new Set([value])); receipts.set(value.token, value)
          const readChecked = (slot: FunctionConversationNativeNodeSlot) => readReturn(value, slot)
          returnSources.set(value.token, { runtime: requestRuntime, read: readChecked,
            readChecked, reading: false, failed: false })
        }
      } catch {
        // Original execution has completed. Its known Node must cache that completion before
        // rejecting source admission; throwing here would turn a keeper failure into tool retry.
        request.failed = true
      }
      return output
    }
    void actual().then(value => {
      pending.delete(result); actualPending.delete(result); resolve(value)
    }, error => {
      request.failed = true; pending.delete(result); actualPending.delete(result); reject(error)
    })
    return result
  }
  Object.defineProperty(bound, "runTool", { value: wrapper, enumerable: true,
    configurable: true, writable: true })
  const ledger = Object.freeze({
    read(slot: FunctionConversationNativeNodeSlot): FunctionNativeToolReturnView {
      structure()
      const view = readFunctionConversationNativeNodeSlot(slot)
      if (view.node !== "tools" || view.bound !== bound) fail()
      const entries = returned.get(view.message)
      if (!entries || entries.size !== 1) fail()
      return readReturn([...entries][0], slot)
    },
    seal(receipt: FunctionNativeToolReturn) {
      const actual = receipts.get(receipt)
      if (!actual || actual.owner.failed || !actual.owner.returned) fail()
      actual.owner.assertCurrent()
      if (closed || receipts.get(receipt) !== actual || actual.owner.failed ||
        actual.paths.some(path => at(actual.output, path) !== actual.message)) fail()
      actual.owner.sealed = true
    },
    close() { closed = true },
    async whenDrained() { while (pending.size) await Promise.allSettled([...pending]) },
    async whenDrainedForRuntime(runtime: object) {
      const ownPending = runtimePending.get(runtime)
      while (ownPending?.size) await Promise.allSettled([...ownPending])
    }
  })
  Reflect.apply(toolBindingWeakSet, toolBindings, [ledger, { graph, bound,
    ...(sharedFactory ? { factory: sharedFactory } : {}), assertStructure: structure }])
  return ledger
}

export type FunctionConversationNativeTools = ReturnType<typeof installFunctionConversationNativeTools>
