import { types } from "node:util"
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, BaseMessage } from
  "@langchain/core/messages"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { captureNativeMessage, captureNativePartialMetadata, constructCapturedNativeMessage }
  from "./native-message-capture"
import { currentFunctionConversationNativeSseSource } from "./function-conversation-native-lifetime"
import type { FunctionNativeStreamDiagnostic } from "./function-conversation-native-lifetime"
import { readNativeSseProtectedDiagnostic, type FunctionNativeProtectedDiagnostic }
  from "./native-sse-diagnostic"
import { readFunctionConversationNativePartialSse } from "./partial-native-message-capture"
import { projectNativeConversationMessageForStream, serializeNativeConversationStreamData }
  from "./native-conversation-stream-projection"

const stringify = JSON.stringify
const toDict = BaseMessage.prototype.toDict
const throwIfAborted = AbortSignal.prototype.throwIfAborted
const ancestorHas = WeakSet.prototype.has, ancestorAdd = WeakSet.prototype.add
const ancestorDelete = WeakSet.prototype.delete
const nativePrototypes = new Set([AIMessage.prototype, HumanMessage.prototype,
  SystemMessage.prototype, ToolMessage.prototype])
const maximumNodes = 1_000_000

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE") }
function own(value: object, key: PropertyKey): unknown {
  if (types.isProxy(value)) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !("value" in descriptor)) fail()
  return descriptor.value
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail()
  return value as Record<string, unknown>
}
function array(value: unknown): readonly unknown[] {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail()
  const length = own(value, "length")
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
    length > maximumNodes || Reflect.ownKeys(value).length !== length + 1) fail()
  const result: unknown[] = []
  for (let index = 0; index < length; index++) result[index] = own(value, String(index))
  return result
}

/** Exact descriptor-only JSON data. This copy is not itself a policy or publication proof. */
function copy(value: unknown, bounded: () => void): unknown {
  let nodes = 0
  const ancestors = new WeakSet<object>()
  const visit = (item: unknown, depth = 0): unknown => {
    bounded()
    if (++nodes > maximumNodes || depth > 128) fail()
    if (item === null || item === undefined || typeof item === "string" ||
      typeof item === "boolean") return item
    if (typeof item === "number") { if (!Number.isFinite(item)) fail(); return item }
    if (!item || typeof item !== "object" || types.isProxy(item) ||
      Reflect.apply(ancestorHas, ancestors, [item])) fail()
    Reflect.apply(ancestorAdd, ancestors, [item])
    try {
      if (Array.isArray(item)) {
        const values = array(item), result: unknown[] = []
        for (let index = 0; index < values.length; index++)
          result[index] = visit(values[index], depth + 1)
        return result
      }
      const original = record(item), result: Record<string, unknown> = {}
      const keys = Reflect.ownKeys(original)
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]
        if (typeof key !== "string") fail()
        const descriptor = Object.getOwnPropertyDescriptor(original, key)
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail()
        Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true,
          writable: true, configurable: true })
      }
      return result
    } finally { Reflect.apply(ancestorDelete, ancestors, [item]) }
  }
  return visit(value)
}

const metadataKeys = new Set(["tags", "name", "thread_id", "checkpoint_ns", "langgraph_step",
  "langgraph_node", "langgraph_triggers", "langgraph_path", "langgraph_checkpoint_ns",
  "ls_provider", "ls_model_type", "ls_model_name", "ls_temperature", "ls_max_tokens", "ls_stop",
  "ls_integration", "__pregel_task_id", "versions"])
const protocolNames = new Set(["model_request", "tools", "ChatOpenAI", "ChatAnthropic",
  "ChatGoogleGenerativeAI", "ChatBedrockConverse", "ModBoundaryChatModel", "LocalModel"])
const providers = new Set(["openai", "OpenAI", "anthropic", "Anthropic", "google-genai",
  "GoogleGenerativeAI", "bedrock", "BedrockConverse", "LocalModel"])
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const uuidValue = new RegExp(`^${uuid}$`, "i")
const taskNamespace = new RegExp(`^(?:(?:model_request|tools):${uuid})(?:\\|(?:model_request|tools):${uuid})*$`, "i")
const nodeNames = new Set(["model_request", "tools"])
function metadata(value: unknown, bounded: () => void): unknown {
  const data = record(copy(record(value), bounded))
  for (const [key, item] of Object.entries(data)) {
    if (!metadataKeys.has(key)) fail()
    if (item === undefined) continue
    // Freely configured diagnostic strings still need their own actual policy adapter.
    // An alphanumeric literal can be a secret; a regex does not make it policy-safe.
    if (key === "ls_model_name" || key === "ls_stop") fail()
    if (["langgraph_step", "ls_max_tokens"].includes(key)) {
      if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) fail()
    } else if (key === "ls_temperature") {
      if (typeof item !== "number" || !Number.isFinite(item)) fail()
    } else if (key === "tags") {
      if (!Array.isArray(item) || item.some(part => typeof part !== "string" ||
        !["nostream", "langsmith:nostream", "langsmith:hidden"].includes(part) &&
        !/^seq:step:[0-9]+$/.test(part))) fail()
    } else if (key === "langgraph_triggers") {
      if (!Array.isArray(item) || item.some(part => typeof part !== "string" ||
        !["__start__", "model_request", "tools", "branch:to:model_request", "branch:to:tools"].includes(part))) fail()
    } else if (key === "langgraph_path") {
      if (!Array.isArray(item) || item.some(part => !(typeof part === "string" &&
        ["__pregel_pull", "__pregel_push", "model_request", "tools"].includes(part)) &&
        !(typeof part === "number" && Number.isSafeInteger(part) && part >= 0))) fail()
    } else if (key === "name") { if (typeof item !== "string" || !protocolNames.has(item)) fail() }
    else if (key === "langgraph_node") { if (item !== "model_request" && item !== "tools") fail() }
    else if (key === "ls_provider") { if (typeof item !== "string" || !providers.has(item)) fail() }
    else if (key === "ls_model_type") { if (item !== "chat") fail() }
    else if (key === "ls_integration") {
      if (item !== "langchain_create_agent" && item !== "langchain_chat_model") fail()
    }
    else if (key === "__pregel_task_id") {
      // ensureConfig copies the actual task primitive into metadata. It is still just data,
      // never the source/slot proof; its value must agree with that task's display namespace.
      const namespace = data.langgraph_checkpoint_ns
      if (typeof item !== "string" || !uuidValue.test(item) || typeof namespace !== "string" ||
        !taskNamespace.test(namespace) || namespace.split("|").at(-1)?.split(":")[1] !== item) fail()
    }
    else if (key === "versions") {
      const versions = record(item), keys = Object.keys(versions)
      // The installed BaseLangChain constructor itself adds this exact public constant.
      // Other integrations/version maps need their actual adapter; arbitrary semver is unsafe.
      if (keys.length !== 1 || keys[0] !== "@langchain/core" ||
        versions[keys[0]] !== "1.1.36") fail()
    }
    else if (key === "thread_id") {
      if (typeof item !== "string" || !uuidValue.test(item)) fail()
    } else if (key === "checkpoint_ns" || key === "langgraph_checkpoint_ns") {
      if (typeof item !== "string" || item !== "" && !taskNamespace.test(item)) fail()
    } else fail()
  }
  return data
}

interface MessagePlan { readonly data: unknown; readonly message: unknown; check(): void }

/** The scope is the actual merged SSE invocation. Public encoding or message IDs do not mint it. */
export function encodeFunctionConversationNativeSse(mode: string, payload: unknown,
  namespace: readonly string[] | undefined, options: Readonly<{
    signal: AbortSignal
    assertCurrent(): void
    message(value: unknown): unknown | undefined
    diagnostic?: FunctionNativeStreamDiagnostic
    protectedDiagnostic?: FunctionNativeProtectedDiagnostic
  }>): Uint8Array | undefined {
  const source = currentFunctionConversationNativeSseSource()
  if (!source || !["messages", "values", "updates"].includes(mode)) fail()
  const deadline = performance.now() + 30_000, signal = options.signal
  const bounded = () => {
    Reflect.apply(throwIfAborted, signal, [])
    if (performance.now() >= deadline) fail()
  }
  const original: Array<{ value: unknown; fingerprint: string }> = []
  const plans: MessagePlan[] = []
  const containers: Array<() => void> = []
  const diagnostic = options.diagnostic && options.protectedDiagnostic
    ? readNativeSseProtectedDiagnostic(options.protectedDiagnostic, options.diagnostic, source)
    : undefined
  if (Boolean(options.diagnostic) !== Boolean(options.protectedDiagnostic)) fail()
  const fingerprint = (value: unknown) => captureNativePartialMetadata({ value }, bounded).digest
  const topology = (value: object) => {
    if (types.isProxy(value)) fail()
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(value, key))
    if (descriptors.some(descriptor => !descriptor || !("value" in descriptor))) fail()
    containers.push(() => {
      if (types.isProxy(value) || Object.getPrototypeOf(value) !== prototype) fail()
      const currentKeys = Reflect.ownKeys(value)
      if (keys.length !== currentKeys.length) fail()
      for (let index = 0; index < keys.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]), expected = descriptors[index]
        if (currentKeys[index] !== keys[index] || !descriptor || !expected ||
          !("value" in descriptor) || descriptor.value !== expected.value ||
          descriptor.enumerable !== expected.enumerable || descriptor.writable !== expected.writable ||
          descriptor.configurable !== expected.configurable) fail()
      }
    })
  }
  const inspect = (value: unknown): unknown => {
    const captured = copy(value, bounded)
    original.push({ value, fingerprint: fingerprint(captured) })
    return captured
  }
  options.assertCurrent()
  const message = (value: unknown, tupleMetadata: unknown): unknown => {
    if (!value || typeof value !== "object" || types.isProxy(value)) fail()
    const partial = readFunctionConversationNativePartialSse(value, tupleMetadata)
    if (partial) {
      const data = copy(partial.data, bounded)
      plans.push({ data, message: value, check: partial.assertDataCurrent })
      return data
    }
    if (!nativePrototypes.has(Object.getPrototypeOf(value))) fail()
    const native = value as BaseMessage
    // Capture before any serializer or projection method. A genuine private projection is
    // required; an ordinary historical Base or public function_row is insufficient here.
    const captured = captureNativeMessage(native, bounded)
    if (captured.executionSuppressed || !projectNativeConversationMessageForStream(native)) fail()
    const safe = constructCapturedNativeMessage(captured.type, { ...captured.data })
    const dict = Reflect.apply(toDict, safe, []) as { type: string; data: unknown }
    const data = copy({ ...record(dict.data), type: dict.type }, bounded)
    const dataFingerprint = fingerprint(data)
    plans.push({ message: native, data, check() {
      if (captureNativeMessage(native, bounded).digest !== captured.digest ||
        fingerprint(copy(data, bounded)) !== dataFingerprint) fail()
    } })
    return data
  }
  const messages = (value: unknown): { display: unknown[]; batch: unknown[] } => {
    const items = array(value), display: unknown[] = []
    topology(value as object)
    for (const item of items) {
      const selected = options.message([item, {}])
      // Only the actual Host's private presentation branch can omit an authenticated row.
      const data = message(item, {})
      if (selected !== undefined) display.push(data)
    }
    return { display, batch: [...items] }
  }
  const state = (value: unknown): { display: Record<string, unknown>;
    batch: Record<string, unknown> } => {
    const body = record(value), result: Record<string, unknown> = {}, batch: Record<string, unknown> = {}
    topology(body)
    for (const key of Reflect.ownKeys(body)) {
      if (typeof key !== "string") fail()
      const item = own(body, key)
      if (key === "messages") {
        const captured = messages(item)
        result[key] = captured.display; batch[key] = captured.batch
      }
      else if (key === "remaining_steps") {
        if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) fail()
        result[key] = inspect(item)
        batch[key] = result[key]
      } else if (key === "cmbFunctionConversation") {
        const channel = record(inspect(item)), keys = Object.keys(channel)
        if (keys.length !== 5 || channel.version !== 1 ||
          !["logicalSessionId", "conversationId", "branchId"].every(name =>
            typeof channel[name] === "string" && uuidValue.test(channel[name] as string)) ||
          typeof channel.frontier !== "number" || !Number.isSafeInteger(channel.frontier) ||
          channel.frontier < 0) fail()
        result[key] = channel
        batch[key] = channel
      } else fail()
    }
    return { display: result, batch }
  }
  let dto: unknown, batch: unknown
  if (mode === "messages") {
    const tuple = array(payload)
    topology(payload as object)
    if (tuple.length !== 2) fail()
    const meta = diagnostic ? copy(diagnostic.data, bounded) : metadata(tuple[1], bounded)
    inspect(tuple[1])
    if (diagnostic) {
      const partial = readFunctionConversationNativePartialSse(tuple[0], tuple[1])
      if (partial) {
        if (partial.originalMessage !== diagnostic.originalMessage ||
          partial.originalMetadata !== diagnostic.originalMetadata) fail()
      } else if (tuple[0] !== diagnostic.originalMessage ||
        tuple[1] !== diagnostic.originalMetadata) fail()
    }
    dto = [message(tuple[0], tuple[1]), meta]
    // A copied partial wire has no canonical row. Never run JSON on its original mutable
    // object after a later canonical/source callback; its private reader supplies the tail.
    batch = [nativePrototypes.has(Object.getPrototypeOf(tuple[0] as object))
      ? tuple[0] : copy(tuple[0], bounded), meta]
  } else if (mode === "values") {
    const captured = state(payload)
    dto = captured.display; batch = captured.batch
  }
  else {
    const updates = record(payload), result: Record<string, unknown> = {}
    const batchUpdates: Record<string, unknown> = {}
    topology(updates)
    for (const key of Reflect.ownKeys(updates)) {
      if (typeof key !== "string" || !nodeNames.has(key)) fail()
      const update = own(updates, key)
      if (update === null) { result[key] = null; batchUpdates[key] = null }
      else {
        const captured = state(update)
        result[key] = captured.display; batchUpdates[key] = captured.batch
      }
    }
    dto = result; batch = batchUpdates
  }
  let copiedNamespace: string[] | undefined
  if (namespace !== undefined) {
    const parts = array(namespace)
    copiedNamespace = []
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]
      if (typeof part !== "string" || part !== "" && !taskNamespace.test(part)) fail()
      copiedNamespace[index] = part
    }
  }
  if (namespace !== undefined) {
    topology(namespace)
    inspect(namespace)
  }
  const dtoFingerprint = fingerprint(dto)
  const encodedData = stringify(dto)
  options.assertCurrent()
  // This single original projection operation covers every canonical member and all its
  // source callbacks before its complete raw/ledger B. It also validates hidden rows.
  serializeNativeConversationStreamData(mode, batch)
  diagnostic?.assertDataCurrent()
  for (let index = 0; index < plans.length; index++) plans[index].check()
  for (let index = 0; index < containers.length; index++) containers[index]()
  for (let index = 0; index < original.length; index++) {
    const item = original[index]
    if (fingerprint(copy(item.value, bounded)) !== item.fingerprint) fail()
  }
  if (currentFunctionConversationNativeSseSource() !== source ||
    fingerprint(copy(dto, bounded)) !== dtoFingerprint) fail()
  bounded()
  let event = mode
  if (copiedNamespace?.length) {
    let namespaceValue = copiedNamespace[0]
    for (let index = 1; index < copiedNamespace.length; index++)
      namespaceValue += `|${copiedNamespace[index]}`
    event += `|${namespaceValue}`
  }
  return new TextEncoder().encode(`event: ${event}\ndata: ${encodedData}\n\n`)
}
