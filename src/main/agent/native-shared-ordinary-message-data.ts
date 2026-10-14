import { types } from "node:util"
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from
  "@langchain/core/messages"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { NATIVE_CAPTURE_MAX_EXPANDED_NODES } from "./native-message-capture"

type Primitive = string | number | bigint | boolean | null | undefined
interface Field {
  readonly key: PropertyKey
  readonly enumerable: boolean
  readonly configurable: boolean
  readonly writable: boolean
  value?: Value
}
type Value = { readonly kind: "primitive"; readonly value: Primitive } | {
  readonly kind: "object"
  readonly prototype: object | null
  readonly fields: Field[]
  readonly bytes?: Uint8Array
}
interface Fixed {
  readonly value: Value
  readonly kwargs: object
  readonly rootId?: PropertyDescriptor
  readonly kwargsId?: PropertyDescriptor
}
export interface NativeSharedOrdinaryMessageData {
  readonly message: BaseMessage
  assertOriginalDataCurrent(): void
  assertInitialDataCurrent(): void
  captureCurrentData(): Readonly<{ assertDataCurrent(): void }>
}

const nativeSymbol = Symbol.for("langchain.message")
const prototypes = new Map<object, string>([
  [HumanMessage.prototype, "human"], [AIMessage.prototype, "ai"],
  [SystemMessage.prototype, "system"], [ToolMessage.prototype, "tool"]
])
const mapGet = Map.prototype.get, setHas = Set.prototype.has
const setAdd = Set.prototype.add, setDelete = Set.prototype.delete
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, "buffer")!.get!
const typedOffset = Object.getOwnPropertyDescriptor(typedPrototype, "byteOffset")!.get!
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, "byteLength")!.get!
const viewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer")!.get!
const viewOffset = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset")!.get!
const viewLength = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get!

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_NATIVE_SOURCE_INVALID") }
function primitive(value: unknown): value is Primitive {
  return value === null || value === undefined || typeof value === "string" ||
    typeof value === "boolean" || typeof value === "number" || typeof value === "bigint"
}
function binary(value: object): Uint8Array | undefined {
  if (types.isSharedArrayBuffer(value)) fail()
  if (types.isArrayBuffer(value)) return new Uint8Array(value as ArrayBuffer)
  if (!ArrayBuffer.isView(value)) return undefined
  const view = types.isDataView(value)
  const buffer: unknown = Reflect.apply(view ? viewBuffer : typedBuffer, value, [])
  const offset: unknown = Reflect.apply(view ? viewOffset : typedOffset, value, [])
  const length: unknown = Reflect.apply(view ? viewLength : typedLength, value, [])
  if (!buffer || typeof buffer !== "object" || types.isSharedArrayBuffer(buffer) ||
    !types.isArrayBuffer(buffer) || typeof offset !== "number" || typeof length !== "number") fail()
  return new Uint8Array(buffer as ArrayBuffer, offset, length)
}
function property(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  if (types.isProxy(value)) fail()
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (field && !("value" in field)) fail()
  return field
}
function shape(value: object, root: boolean, remaining: number): {
  prototype: object | null; fields: Field[]; values: unknown[]; bytes?: Uint8Array
} {
  if (types.isProxy(value)) fail()
  const prototype = Object.getPrototypeOf(value) as object | null
  const array = Array.isArray(value)
  const bytes = root ? undefined : binary(value)
  if (root) {
    const type = Reflect.apply(mapGet, prototypes, [prototype]) as string | undefined
    if (!type || property(value, "type")?.value !== type ||
      property(value, nativeSymbol)?.value !== true) fail()
  } else if (!bytes && (array ? prototype !== Array.prototype :
    prototype !== Object.prototype && prototype !== null)) fail()
  const keys = Reflect.ownKeys(value)
  if (keys.length > remaining) fail()
  let length = 0
  if (array) {
    const field = property(value, "length")
    if (!field || !Number.isSafeInteger(field.value) || field.value < 0 ||
      field.value > NATIVE_CAPTURE_MAX_EXPANDED_NODES || keys.length !== field.value + 1) fail()
    length = field.value
  }
  const fields: Field[] = [], values: unknown[] = []
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (typeof key !== "string" && (!root || key !== nativeSymbol)) fail()
    if (array && key !== "length" && (typeof key !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) fail()
    if (root && (key === "toJSON" || key === "toDict" || key === "getType" ||
      key === "_getType" || key === "lc_aliases" || key === "lc_attributes" ||
      key === "lc_secrets")) fail()
    const field = property(value, key)
    if (!field) fail()
    fields[index] = { key, enumerable: field.enumerable === true,
      configurable: field.configurable === true, writable: field.writable === true }
    values[index] = field.value
  }
  return { prototype, fields, values, bytes }
}
function snapshot(message: BaseMessage): Fixed {
  if (!message || typeof message !== "object" || types.isProxy(message)) fail()
  const kwargs = property(message, "lc_kwargs")?.value as unknown
  if (!kwargs || typeof kwargs !== "object" || types.isProxy(kwargs) || Array.isArray(kwargs) ||
    Object.getPrototypeOf(kwargs) !== Object.prototype && Object.getPrototypeOf(kwargs) !== null) fail()
  type Task = { input: unknown; parent: Field; root: boolean } | { exit: object }
  const holder: Field = { key: "root", enumerable: false, configurable: false, writable: false }
  const pending: Task[] = [{ input: message, parent: holder, root: true }]
  const ancestors = new Set<object>()
  let remaining = NATIVE_CAPTURE_MAX_EXPANDED_NODES - 1
  while (pending.length) {
    const task = pending[pending.length - 1]
    pending.length--
    if ("exit" in task) { Reflect.apply(setDelete, ancestors, [task.exit]); continue }
    if (primitive(task.input)) {
      task.parent.value = { kind: "primitive", value: task.input }
      continue
    }
    if (!task.input || typeof task.input !== "object" || types.isProxy(task.input) ||
      Reflect.apply(setHas, ancestors, [task.input])) fail()
    const captured = shape(task.input, task.root, remaining)
    remaining -= captured.fields.length
    task.parent.value = { kind: "object", prototype: captured.prototype, fields: captured.fields,
      ...(captured.bytes ? { bytes: new Uint8Array(captured.bytes) } : {}) }
    Reflect.apply(setAdd, ancestors, [task.input])
    pending[pending.length] = { exit: task.input }
    for (let index = captured.fields.length - 1; index >= 0; index--)
      pending[pending.length] = { input: captured.values[index], parent: captured.fields[index],
        root: false }
  }
  if (!holder.value) fail()
  return { value: holder.value, kwargs, rootId: property(message, "id"),
    kwargsId: property(kwargs, "id") }
}
function sameFlags(first: Field, second: Field): boolean {
  return first.key === second.key && first.enumerable === second.enumerable &&
    first.configurable === second.configurable && first.writable === second.writable
}
function assertSame(message: BaseMessage, fixed: Fixed, allowIdAssignment: boolean): void {
  if (property(message, "lc_kwargs")?.value !== fixed.kwargs) fail()
  const rootId = property(message, "id"), kwargsId = property(fixed.kwargs, "id")
  const initialId = fixed.rootId?.value as unknown
  const assigned = allowIdAssignment && initialId === undefined &&
    typeof rootId?.value === "string" && rootId.value.length > 0 && kwargsId?.value === rootId.value
  if (assigned && (fixed.rootId && fixed.rootId.writable !== true ||
    fixed.kwargsId && fixed.kwargsId.writable !== true)) fail()
  if (initialId !== undefined && (typeof initialId !== "string" || !initialId)) fail()
  if (initialId === undefined && fixed.kwargsId?.value !== undefined) fail()
  if (!assigned && (rootId?.value !== initialId || kwargsId?.value !== fixed.kwargsId?.value)) fail()
  const pending: Array<{ actual: unknown; expected: Value; root: boolean }> = [
    { actual: message, expected: fixed.value, root: true }
  ]
  let remaining = NATIVE_CAPTURE_MAX_EXPANDED_NODES - 1
  while (pending.length) {
    const task = pending[pending.length - 1]
    pending.length--
    if (task.expected.kind === "primitive") {
      if (!primitive(task.actual) || !Object.is(task.actual, task.expected.value)) fail()
      continue
    }
    if (!task.actual || typeof task.actual !== "object" || types.isProxy(task.actual)) fail()
    const observed = shape(task.actual, task.root, remaining), expected = task.expected.fields
    if (observed.prototype !== task.expected.prototype) fail()
    const expectedBytes = task.expected.bytes
    if (expectedBytes || observed.bytes) {
      if (!expectedBytes || !observed.bytes) fail()
      const expectedLength = Reflect.apply(typedLength, expectedBytes, []) as number
      const observedLength = Reflect.apply(typedLength, observed.bytes, []) as number
      if (expectedLength !== observedLength) fail()
      for (let index = 0; index < expectedLength; index++)
        if (expectedBytes[index] !== observed.bytes[index]) fail()
    }
    remaining -= observed.fields.length
    const idContainer = assigned && (task.root || task.actual === fixed.kwargs)
    const originalId = task.root ? fixed.rootId : fixed.kwargsId
    const addedId = idContainer && !originalId
    if (observed.fields.length !== expected.length + (addedId ? 1 : 0)) fail()
    let position = 0, idSeen = false
    for (let index = 0; index < observed.fields.length; index++) {
      const current = observed.fields[index]
      if (addedId && current.key === "id") {
        if (idSeen || current.enumerable !== true || current.configurable !== true ||
          current.writable !== true || observed.values[index] !== rootId?.value) fail()
        // A new normal string key follows all original string keys and precedes symbols.
        if (position < expected.length && typeof expected[position].key === "string") fail()
        idSeen = true
        continue
      }
      const original = expected[position++]
      if (!original || !original.value || !sameFlags(current, original)) fail()
      if (idContainer && current.key === "id") {
        if (observed.values[index] !== rootId?.value) fail()
      } else pending[pending.length] = { actual: observed.values[index],
        expected: original.value, root: false }
    }
    if (position !== expected.length || addedId && !idSeen) fail()
  }
}

/** Raw ordinary input data only: this creates no snapshot, UUID, Entry or publication grant. */
export function captureNativeSharedOrdinaryMessageData(message: BaseMessage):
  NativeSharedOrdinaryMessageData {
  const initial = snapshot(message)
  assertSame(message, initial, false)
  let failed = false, reading = false
  const read = (check: () => void): void => {
    if (failed || reading) { failed = true; fail() }
    reading = true
    try { check() }
    catch (error) { failed = true; throw error }
    finally { reading = false }
  }
  return Object.freeze({ message,
    assertOriginalDataCurrent() { read(() => assertSame(message, initial, false)) },
    assertInitialDataCurrent() { read(() => assertSame(message, initial, true)) },
    captureCurrentData() {
      let current: Fixed | undefined
      read(() => { assertSame(message, initial, true); current = snapshot(message) })
      const selected = current
      if (!selected) fail()
      return Object.freeze({ assertDataCurrent() { read(() => assertSame(message, selected, false)) } })
    }
  })
}
