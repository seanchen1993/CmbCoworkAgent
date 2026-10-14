import { createHash } from "node:crypto"
import { types } from "node:util"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { ThreadMessageWrite } from "../types"
import { NATIVE_CAPTURE_MAX_EXPANDED_NODES } from "./native-message-capture"

type Primitive = null | undefined | string | boolean | number
type Node = { readonly kind: "primitive"; readonly value: Primitive }
  | { readonly kind: "date"; readonly time: number }
  | { readonly kind: "object"; readonly prototype: object | null; readonly array: boolean;
    readonly fields: readonly Field[] }
interface Field {
  readonly key: string
  readonly enumerable: boolean
  readonly configurable: boolean
  readonly writable: boolean
  node: Node
}
const getTime = Date.prototype.getTime
const apply = Reflect.apply
const stringify = JSON.stringify
const allowed = new Set(["id", "role", "content", "provider_source_id", "provider_occurrence",
  "content_priority", "recovery_integrity", "reasoning", "tool_calls", "tool_call_id", "name",
  "status", "is_error", "goal_id", "active_window_id", "created_at", "start_at", "end_at",
  "content_mode", "tool_calls_mode", "reasoning_mode"])

function fail(): never { throw new ModFunctionError("MODS_CONVERSATION_INPUT_TRANSCRIPT_INVALID") }
function own(value: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field || !field.enumerable || !("value" in field)) fail()
  return field.value
}
function date(value: object): number {
  if (Object.getPrototypeOf(value) !== Date.prototype || Reflect.ownKeys(value).length) fail()
  const time: unknown = apply(getTime, value, [])
  if (typeof time !== "number" || !Number.isSafeInteger(time) || time < 0) fail()
  return time
}

/** Full data capture only. No source, writer, disposition or persistence authority is minted. */
export function captureNativeInputTranscriptData(value: unknown, uuid: string): Readonly<{
  digest: string
  copy(): ThreadMessageWrite
  matches(actual: unknown): boolean
}> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    fail()
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== "string" || !allowed.has(key))) fail()
  if (!uuid || own(value, "id") !== uuid || own(value, "role") !== "user") fail()
  const content = own(value, "content")
  if (!(typeof content === "string" || Array.isArray(content))) fail()
  const created = own(value, "created_at")
  if (!created || typeof created !== "object" || types.isProxy(created)) fail()
  date(created)
  for (const key of ["start_at", "end_at"] as const) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (field) {
      const time = own(value, key)
      if (!time || typeof time !== "object" || types.isProxy(time)) fail()
      date(time)
    }
  }
  for (const key of ["content_mode", "tool_calls_mode", "reasoning_mode"] as const)
    if (Object.hasOwn(value, key) && own(value, key) !== "snapshot") fail()
  const root: { node?: Node } = {}
  type Task = { value: unknown; put(node: Node): void } | { exit: object }
  const tasks: Task[] = [{ value, put: node => { root.node = node } }]
  const ancestors = new Set<object>()
  let remaining = NATIVE_CAPTURE_MAX_EXPANDED_NODES - 1
  while (tasks.length) {
    const task = tasks.pop()
    if (!task) fail()
    if ("exit" in task) { ancestors.delete(task.exit); continue }
    const input = task.value
    if (input === null || input === undefined || typeof input === "string" ||
      typeof input === "boolean" || typeof input === "number" && Number.isFinite(input)) {
      task.put(Object.freeze({ kind: "primitive", value: input })); continue
    }
    if (!input || typeof input !== "object" || types.isProxy(input) || ancestors.has(input)) fail()
    const prototype = Object.getPrototypeOf(input)
    if (prototype === Date.prototype) {
      task.put(Object.freeze({ kind: "date", time: date(input) })); continue
    }
    const array = Array.isArray(input)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      fail()
    const names = Reflect.ownKeys(input)
    const length: unknown = array ? Object.getOwnPropertyDescriptor(input, "length")?.value : undefined
    if (array && (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
      names.length !== length + 1 || length > remaining)) fail()
    if (names.length > remaining) fail()
    remaining -= names.length
    const fields: Field[] = []
    for (let index = 0; index < names.length; index++) {
      const key = names[index]
      if (typeof key !== "string" || array && key !== "length" &&
        (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= Number(length))) fail()
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (!descriptor || !("value" in descriptor) ||
        (!descriptor.enumerable && !(array && key === "length"))) fail()
      fields.push({ key, enumerable: descriptor.enumerable === true,
        configurable: descriptor.configurable === true, writable: descriptor.writable === true,
        node: { kind: "primitive", value: undefined } })
    }
    task.put(Object.freeze({ kind: "object", prototype, array, fields }))
    ancestors.add(input); tasks.push({ exit: input })
    for (let index = names.length - 1; index >= 0; index--) {
      const field = fields[index], descriptor = Object.getOwnPropertyDescriptor(input, field.key)
      if (!descriptor || !("value" in descriptor)) fail()
      tasks.push({ value: descriptor.value, put: node => { field.node = node } })
    }
  }
  const tree = root.node
  if (!tree) fail()
  const matches = (actual: unknown): boolean => {
    const pending: Array<readonly [unknown, Node]> = [[actual, tree]]
    while (pending.length) {
      const pair = pending.pop()
      if (!pair) fail()
      const [input, node] = pair
      if (node.kind === "primitive") { if (!Object.is(input, node.value)) return false; continue }
      if (!input || typeof input !== "object" || types.isProxy(input)) return false
      if (node.kind === "date") {
        if (Object.getPrototypeOf(input) !== Date.prototype || Reflect.ownKeys(input).length ||
          apply(getTime, input, []) !== node.time) return false
        continue
      }
      if (Object.getPrototypeOf(input) !== node.prototype || Array.isArray(input) !== node.array)
        return false
      const names = Reflect.ownKeys(input)
      if (names.length !== node.fields.length) return false
      for (let index = 0; index < names.length; index++) {
        const field = node.fields[index]
        if (names[index] !== field.key) return false
        const descriptor = Object.getOwnPropertyDescriptor(input, field.key)
        if (!descriptor || !("value" in descriptor) ||
          descriptor.enumerable !== field.enumerable || descriptor.configurable !== field.configurable ||
          descriptor.writable !== field.writable) return false
        pending.push([descriptor.value, field.node])
      }
    }
    return true
  }
  const copy = (): ThreadMessageWrite => {
    let output: unknown
    const pending: Array<{ node: Node; put(value: unknown): void }> =
      [{ node: tree, put: value => { output = value } }]
    while (pending.length) {
      const task = pending.pop()
      if (!task) fail()
      const node = task.node
      if (node.kind === "primitive") { task.put(node.value); continue }
      if (node.kind === "date") { task.put(new Date(node.time)); continue }
      const result: object = node.array ? [] : Object.create(node.prototype)
      task.put(result)
      for (let index = node.fields.length - 1; index >= 0; index--) {
        const field = node.fields[index]
        if (node.array && field.key === "length") continue
        pending.push({ node: field.node, put: value => {
          Object.defineProperty(result, field.key, { value, enumerable: field.enumerable,
            writable: field.writable, configurable: field.configurable })
        } })
      }
    }
    return output as ThreadMessageWrite
  }
  // Encode the private tree, including undefined/-0/descriptors/Date, never a raw method.
  const encoded: unknown[] = [], pending: Node[] = [tree]
  while (pending.length) {
    const node = pending.pop()
    if (!node) fail()
    if (node.kind === "primitive") encoded.push(["primitive", typeof node.value,
      typeof node.value === "number" && Object.is(node.value, -0) ? "-0" : node.value])
    else if (node.kind === "date") encoded.push(["date", node.time])
    else {
      encoded.push([node.array ? "array" : node.prototype === null ? "null" : "object",
        node.fields.map(field => [field.key, field.enumerable, field.configurable, field.writable])])
      for (let index = node.fields.length - 1; index >= 0; index--) pending.push(node.fields[index].node)
    }
  }
  const digest = createHash("sha256").update(stringify(encoded)).digest("hex")
  if (!matches(value)) fail()
  return Object.freeze({ digest, copy, matches })
}
