import { createHash } from "node:crypto"
import { types } from "node:util"
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from "@langchain/core/messages"
import { ModFunctionError } from "../../shared/mods/v2/contracts"

export type CapturedNativeType = "human" | "ai" | "system" | "tool"
// This native adapter bounds expanded data nodes, independently of public ModJSON byte limits.
export const NATIVE_CAPTURE_MAX_EXPANDED_NODES = 1_000_000
export interface CapturedNativeMessage {
  readonly type: CapturedNativeType
  readonly data: Readonly<Record<string, unknown>>
  readonly digest: string
  readonly executionSuppressed: boolean
}

const prototypes = new Map<object, CapturedNativeType>([
  [HumanMessage.prototype, "human"], [AIMessage.prototype, "ai"],
  [SystemMessage.prototype, "system"], [ToolMessage.prototype, "tool"]
])
const nativeSymbol = Symbol.for("langchain.message")
const captureMapGet = Map.prototype.get, captureMapSet = Map.prototype.set
const captureMapEntries = Map.prototype.entries
const captureMapIteratorNext = Object.getPrototypeOf(new Map().entries()).next as
  (this: Iterator<unknown>) => IteratorResult<unknown>
const captureSetHas = Set.prototype.has, captureSetAdd = Set.prototype.add
const captureSetDelete = Set.prototype.delete

function mapData<K, V>(map: Map<K, V>, key: K): V | undefined {
  return Reflect.apply(captureMapGet, map, [key]) as V | undefined
}
function mapEntries<K, V>(map: Map<K, V>): Array<[K, V]> {
  const iterator = Reflect.apply(captureMapEntries, map, []) as Iterator<[K, V]>
  const values: Array<[K, V]> = []
  while (true) {
    const next = Reflect.apply(captureMapIteratorNext, iterator, []) as IteratorResult<[K, V]>
    if (next.done) return values
    values[values.length] = next.value
  }
}
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, "buffer")?.get
const typedOffset = Object.getOwnPropertyDescriptor(typedPrototype, "byteOffset")?.get
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, "byteLength")?.get
const dataBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer")?.get
const dataOffset = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset")?.get
const dataLength = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")?.get
const typedKinds: ReadonlyArray<readonly [(value: unknown) => boolean, string]> = [
  [types.isUint8Array, "u8"], [types.isUint8ClampedArray, "u8c"], [types.isInt8Array, "i8"],
  [types.isUint16Array, "u16"], [types.isInt16Array, "i16"], [types.isUint32Array, "u32"],
  [types.isInt32Array, "i32"], [types.isFloat32Array, "f32"], [types.isFloat64Array, "f64"],
  [types.isBigInt64Array, "i64"], [types.isBigUint64Array, "u64"]
]

function fail(code = "MODS_NATIVE_CAPTURE_INVALID"): never {
  throw new ModFunctionError(code)
}

function nonProxy(value: object): void {
  if (types.isProxy(value)) fail("MODS_NATIVE_CAPTURE_PROXY")
}

function own(object: object, name: PropertyKey): unknown {
  const property = Object.getOwnPropertyDescriptor(object, name)
  if (!property) return undefined
  if (!("value" in property)) fail("MODS_NATIVE_CAPTURE_ACCESSOR")
  return property.value
}

/** This is a typed capture, not raw JSON serialization or a publication permission. */
export function captureNativeMessage(
  message: BaseMessage, assertBoundedWork?: () => void
): CapturedNativeMessage {
  return captureMessage(message, assertBoundedWork).snapshot
}

/** Pure typed copy only. The UUID must come from a native occurrence, not a public message. */
export function captureNativeMessageForOccurrence(message: BaseMessage, stableUuid: string,
  assertBoundedWork?: () => void): Readonly<{
    snapshot: CapturedNativeMessage
    originalId?: string
    originalDigest: string
  }> {
  if (typeof stableUuid !== "string" || !stableUuid) fail()
  return captureMessage(message, assertBoundedWork, stableUuid)
}

export interface OriginalModelName {
  readonly name: unknown
  readonly hadKwargsName: boolean
}

/** Internal display-data copy; no serialization method, permission or message token is created. */
export function captureNativePartialMetadata(value: unknown, assertBoundedWork?: () => void):
  Readonly<{ data: Readonly<Record<string, unknown>>; digest: string }> {
  if (!value || typeof value !== "object") fail("MODS_NATIVE_CAPTURE_PARTIAL_INVALID")
  nonProxy(value)
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail("MODS_NATIVE_CAPTURE_TYPE")
  const hash = createHash("sha256").update("partial-metadata;")
  const result = captureData(value, hash, false, assertBoundedWork)
  if (!result.value || typeof result.value !== "object" || Array.isArray(result.value)) fail()
  return Object.freeze({ data: result.value as Record<string, unknown>, digest: hash.digest("hex") })
}

function captureMessage(message: BaseMessage, assertBoundedWork?: () => void,
  stableUuid?: string, chunkKind?: "completed" | "partial" | "checkpoint", originalName?: OriginalModelName): Readonly<{
    snapshot: CapturedNativeMessage
    originalId?: string
    originalDigest: string
  }> {
  assertBoundedWork?.()
  nonProxy(message)
  const prototype: unknown = Object.getPrototypeOf(message)
  if (!prototype || typeof prototype !== "object") fail()
  nonProxy(prototype)
  const type = chunkKind
    ? prototype === AIMessageChunk.prototype ? "ai" : undefined
    : mapData(prototypes, prototype)
  if (!type || own(message, "type") !== type || own(message, nativeSymbol) !== true) fail()
  const messageKeys = Reflect.ownKeys(message)
  for (let index = 0; index < messageKeys.length; index++) {
    const key = messageKeys[index]
    if (typeof key === "symbol" && key !== nativeSymbol) fail()
    const keyName = String(key)
    if (keyName === "toJSON" || keyName === "toDict" || keyName === "getType" ||
      keyName === "_getType" || keyName === "lc_aliases" || keyName === "lc_secrets" ||
      keyName === "lc_attributes") fail("MODS_NATIVE_CAPTURE_TYPE")
    const value = own(message, key)
    if (typeof value === "function" || typeof value === "symbol") fail()
  }
  const fields = own(message, "lc_kwargs")
  if (!fields || typeof fields !== "object") fail()
  nonProxy(fields)
  if (Array.isArray(fields)) fail()
  const fieldsPrototype: unknown = Object.getPrototypeOf(fields)
  if (fieldsPrototype !== null && fieldsPrototype !== Object.prototype) fail()
  const raw: Record<string, unknown> = Object.create(null)
  const fieldKeys = Reflect.ownKeys(fields)
  for (let index = 0; index < fieldKeys.length; index++) {
    const key = fieldKeys[index]
    if (typeof key !== "string") fail()
    const property = Object.getOwnPropertyDescriptor(fields, key)
    if (!property || !("value" in property)) fail("MODS_NATIVE_CAPTURE_ACCESSOR")
    if (!property.enumerable) continue
    const actual = Object.getOwnPropertyDescriptor(message, key)
    if (actual && !("value" in actual)) fail("MODS_NATIVE_CAPTURE_ACCESSOR")
    if (key === "name" && originalName && !originalName.hadKwargsName) continue
    raw[key] = key === "name" && originalName ? originalName.name
      : actual ? actual.value : property.value
  }
  const commonKeys = ["id", "content", "additional_kwargs", "response_metadata", "name"]
  for (let index = 0; index < commonKeys.length; index++) {
    const key = commonKeys[index]
    raw[key] = key === "name" && originalName ? originalName.name : own(message, key)
  }
  if (type === "ai") {
    const keys = ["tool_calls", "invalid_tool_calls", "usage_metadata"]
    for (let index = 0; index < keys.length; index++) raw[keys[index]] = own(message, keys[index])
  }
  if (chunkKind) {
    const chunks = Object.getOwnPropertyDescriptor(message, "tool_call_chunks")
    if (!chunks || !("value" in chunks) || !Array.isArray(chunks.value)) fail()
    raw.tool_call_chunks = chunks.value
  }
  if (type === "tool") {
    const keys = ["tool_call_id", "status", "artifact", "metadata"]
    for (let index = 0; index < keys.length; index++) raw[keys[index]] = own(message, keys[index])
  }
  if (raw.content && typeof raw.content === "object") nonProxy(raw.content)
  if ((stableUuid === undefined ? typeof raw.id !== "string" || !raw.id
    : raw.id !== undefined && (typeof raw.id !== "string" || !raw.id)) ||
    !(typeof raw.content === "string" || Array.isArray(raw.content)) ||
    (type === "tool" && (typeof raw.tool_call_id !== "string" || !raw.tool_call_id))) fail()
  const hash = createHash("sha256").update(type)
  if (chunkKind) hash.update(`${chunkKind}-ai-chunk;`)
  if (stableUuid !== undefined) hash.update(`idOwn:${Object.hasOwn(message, "id")};`)
  const result = captureData(raw, hash, type === "ai", assertBoundedWork)
  if (!result.value || typeof result.value !== "object" || Array.isArray(result.value)) fail()
  const originalDigest = hash.digest("hex")
  let data = result.value as Record<string, unknown>, digest = originalDigest
  if (stableUuid !== undefined) {
    const normalizedHash = createHash("sha256").update(type)
    const normalized = captureData({ ...data, id: stableUuid }, normalizedHash,
      type === "ai", assertBoundedWork)
    if (!normalized.value || typeof normalized.value !== "object" || Array.isArray(normalized.value)) fail()
    data = normalized.value as Record<string, unknown>
    digest = normalizedHash.digest("hex")
  }
  return Object.freeze({ snapshot: Object.freeze({ type, data, digest,
    executionSuppressed: result.executionSuppressed }), originalDigest,
    ...(typeof raw.id === "string" ? { originalId: raw.id } : {}) })
}

type CaptureHash = ReturnType<typeof createHash>
type Task = { value: unknown; parent: Record<string, unknown> | unknown[]; key: string | number;
  depth: number; structured: boolean }
  | { exit: object }

function binaryBytes(value: object): { bytes: Uint8Array; kind: string } | undefined {
  if (types.isSharedArrayBuffer(value)) fail("MODS_NATIVE_CAPTURE_TYPE")
  if (types.isArrayBuffer(value)) return { bytes: new Uint8Array(value as ArrayBuffer), kind: "buffer" }
  if (!ArrayBuffer.isView(value)) return undefined
  const view = types.isDataView(value)
  const getBuffer = view ? dataBuffer : typedBuffer
  const getOffset = view ? dataOffset : typedOffset
  const getLength = view ? dataLength : typedLength
  if (!getBuffer || !getOffset || !getLength) fail()
  const buffer: unknown = getBuffer.call(value)
  const offset: unknown = getOffset.call(value)
  const length: unknown = getLength.call(value)
  if (!buffer || typeof buffer !== "object" || types.isSharedArrayBuffer(buffer) ||
    !types.isArrayBuffer(buffer) || typeof offset !== "number" || typeof length !== "number") fail()
  let kind = view ? "data-view" : undefined
  if (!view) for (let index = 0; index < typedKinds.length; index++) {
    const entry = typedKinds[index]
    if (entry[0](value)) { kind = entry[1]; break }
  }
  if (typeof kind !== "string") fail("MODS_NATIVE_CAPTURE_TYPE")
  return { bytes: new Uint8Array(buffer as ArrayBuffer, offset, length), kind }
}

function assign(parent: Record<string, unknown> | unknown[], key: string | number, value: unknown): void {
  Object.defineProperty(parent, key, { value, enumerable: true, configurable: true, writable: true })
}

function captureData(value: unknown, hash: CaptureHash, hasAiExecution: boolean,
  assertBoundedWork?: () => void):
  { value: unknown; executionSuppressed: boolean } {
  const result: Record<string, unknown> = Object.create(null)
  let remainingNodes = NATIVE_CAPTURE_MAX_EXPANDED_NODES - 1
  function reserveChildren(count: number): void {
    assertBoundedWork?.()
    if (!Number.isSafeInteger(count) || count < 0 || count > remainingNodes)
      fail("MODS_NATIVE_CAPTURE_EXPANSION")
    remainingNodes -= count
  }
  const tasks: Task[] = [{ value, parent: result, key: "value", depth: 0, structured: false }]
  const seen = new Set<object>()
  let executionSuppressed = false
  let steps = 0
  while (tasks.length) {
    if (++steps % 1024 === 0) assertBoundedWork?.()
    const task = tasks[tasks.length - 1]
    tasks.length--
    if (!task) fail()
    if ("exit" in task) {
      hash.update("}")
      Reflect.apply(captureSetDelete, seen, [task.exit])
      continue
    }
    const input = task.value
    if (input === null || input === undefined) {
      if (task.structured && input === undefined && Array.isArray(task.parent))
        executionSuppressed = true
      hash.update(input === null ? "null;" : "undefined;")
      assign(task.parent, task.key, input === null ? null : undefined)
      continue
    }
    if (typeof input === "string") {
      hash.update(`s${input.length}:`).update(input, "utf16le")
      assign(task.parent, task.key, input)
      continue
    }
    if (typeof input === "boolean" || typeof input === "number") {
      if (task.structured && typeof input === "number" && !Number.isFinite(input))
        executionSuppressed = true
      hash.update(typeof input === "boolean" ? `b${input};`
        : Object.is(input, -0) ? "n-0;" : `n${input};`)
      assign(task.parent, task.key, typeof input === "number" && !Number.isFinite(input) ? null : input)
      continue
    }
    if (typeof input !== "object") fail("MODS_NATIVE_CAPTURE_TYPE")
    nonProxy(input)
    const prototype: unknown = Object.getPrototypeOf(input)
    if (prototype && typeof prototype === "object") nonProxy(prototype)
    const bytes = binaryBytes(input)
    if (bytes) {
      if (task.structured) executionSuppressed = true
      hash.update(`bytes:${bytes.kind}:${bytes.bytes.byteLength}:`).update(bytes.bytes)
      assign(task.parent, task.key, "[Binary output suppressed]")
      continue
    }
    if (Reflect.apply(captureSetHas, seen, [input])) fail("MODS_NATIVE_CAPTURE_CYCLE")
    if (!Array.isArray(input) && prototype !== null && prototype !== Object.prototype)
      fail("MODS_NATIVE_CAPTURE_TYPE")
    const array = Array.isArray(input)
    let arrayLength = 0
    if (array) {
      if (prototype !== Array.prototype) fail("MODS_NATIVE_CAPTURE_TYPE")
      const length = own(input, "length")
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) fail()
      // Include holes before allocating an output array or even one child task.
      reserveChildren(length)
      arrayLength = length
    }
    Reflect.apply(captureSetAdd, seen, [input])
    hash.update(array ? "array{" : "object{")
    tasks[tasks.length] = { exit: input }
    const descriptors = new Map<string, PropertyDescriptor>()
    const inputKeys = Reflect.ownKeys(input)
    for (let index = 0; index < inputKeys.length; index++) {
      const name = inputKeys[index]
      if (++steps % 1024 === 0) assertBoundedWork?.()
      if (typeof name !== "string") fail("MODS_NATIVE_CAPTURE_TYPE")
      const property = Object.getOwnPropertyDescriptor(input, name)
      if (!property || !("value" in property)) fail("MODS_NATIVE_CAPTURE_ACCESSOR")
      if (typeof property.value === "function" || typeof property.value === "symbol")
        fail("MODS_NATIVE_CAPTURE_TYPE")
      if (!array && property.enumerable) reserveChildren(1)
      Reflect.apply(captureMapSet, descriptors, [name, property])
    }
    if (array) {
      const entries = mapEntries(descriptors)
      for (let index = 0; index < entries.length; index++) {
        const name = entries[index][0]
        if (name !== "length" && (!/^(?:0|[1-9][0-9]*)$/.test(name) ||
          !Number.isSafeInteger(Number(name)) || Number(name) >= arrayLength))
          fail("MODS_NATIVE_CAPTURE_TYPE")
      }
      const output: unknown[] = new Array(arrayLength)
      assign(task.parent, task.key, output)
      for (let index = arrayLength - 1; index >= 0; index--) {
        if (++steps % 1024 === 0) assertBoundedWork?.()
        tasks[tasks.length] = { value: mapData(descriptors, String(index))?.value,
          parent: output, key: index, depth: task.depth + 1, structured: task.structured }
      }
      continue
    }
    const kind = mapData(descriptors, "type")?.value
    if (kind === "image" || kind === "image_url" || kind === "audio" || kind === "file" ||
      kind === "resource") {
      if (task.structured) executionSuppressed = true
      assign(task.parent, task.key, { type: "text", text: "[Non-text output suppressed by project policy]" })
      // Still capture every original field for mutation/type checks, without publishing it.
      const ignored: Record<string, unknown> = Object.create(null)
      const entries = mapEntries(descriptors)
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index], name = entry[0], property = entry[1]
        if (!property.enumerable) continue
        if (++steps % 1024 === 0) assertBoundedWork?.()
        hash.update(`k${name.length}:`).update(name, "utf16le")
        tasks[tasks.length] = { value: property.value, parent: ignored, key: name,
          depth: task.depth + 1, structured: task.structured }
      }
      continue
    }
    const output: Record<string, unknown> = Object.create(null)
    assign(task.parent, task.key, output)
    if (mapData(descriptors, "truncated")?.value === true) {
      if (task.structured) executionSuppressed = true
      output.exitCode = mapData(descriptors, "exitCode")?.value ?? null
      output.output = "[Incomplete output suppressed by project policy]"
      output.truncated = true
    }
    const ignored: Record<string, unknown> = Object.create(null)
    const entries = mapEntries(descriptors)
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index], name = entry[0], property = entry[1]
      if (!property.enumerable) continue
      if (++steps % 1024 === 0) assertBoundedWork?.()
      hash.update(`k${name.length}:`).update(name, "utf16le")
      const skip = name === "__proto__" || name === "constructor" || name === "prototype" ||
        (mapData(descriptors, "truncated")?.value === true && name !== "exitCode")
      if (task.structured && skip) executionSuppressed = true
      tasks[tasks.length] = { value: property.value, parent: skip ? ignored : output, key: name,
        depth: task.depth + 1, structured: task.structured || (hasAiExecution && task.depth === 0 &&
          (name === "tool_calls" || name === "invalid_tool_calls" || name === "tool_call_chunks" ||
            name === "usage_metadata")) }
    }
  }
  assertBoundedWork?.()
  return { value: result.value, executionSuppressed }
}

/** Safe copied data only. Calling native constructors cannot execute raw payload accessors. */
export function constructCapturedNativeMessage(
  type: CapturedNativeType,
  data: Record<string, unknown>
): BaseMessage {
  if (!(typeof data.content === "string" || Array.isArray(data.content)) || typeof data.id !== "string")
    fail()
  const fields = { content: data.content as BaseMessage["content"], id: data.id }
  let message: BaseMessage
  if (type === "ai") message = new AIMessage({ ...fields, tool_calls: [], invalid_tool_calls: [] })
  else if (type === "human") message = new HumanMessage(fields)
  else if (type === "system") message = new SystemMessage(fields)
  else {
    if (typeof data.tool_call_id !== "string" || !data.tool_call_id) fail()
    message = new ToolMessage({ ...fields, tool_call_id: data.tool_call_id })
  }
  // The AI constructor's v1 normalization appends tool calls to content again. Restore already
  // normalized, pure copied native fields; do not run raw methods or normalize a second time.
  for (const key of ["id", "content", "additional_kwargs", "response_metadata", "name",
    ...(type === "ai" ? ["tool_calls", "invalid_tool_calls", "usage_metadata"] : []),
    ...(type === "ai" && Object.hasOwn(data, "tool_call_chunks") ? ["tool_call_chunks"] : []),
    ...(type === "tool" ? ["tool_call_id", "status", "artifact", "metadata"] : [])])
    Object.defineProperty(message, key, { value: data[key], enumerable: true,
      writable: true, configurable: true })
  Object.defineProperty(message, "lc_kwargs", { value: { ...data }, enumerable: true,
    writable: true, configurable: true })
  return message
}

// Internal data bridge for the original Main capability wrappers; these functions mint no receipt.
export { captureMessage, fail, nonProxy, own }
