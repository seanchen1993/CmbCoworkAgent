import { HumanMessage } from "@langchain/core/messages"
import { types } from "node:util"
import { NATIVE_CAPTURE_MAX_EXPANDED_NODES } from "./native-message-capture"

type Primitive = string | number | boolean | null | undefined
type Value = { readonly primitive: Primitive } | {
  readonly prototype: object | null
  readonly properties: Property[]
}
interface Property {
  readonly key: PropertyKey
  readonly enumerable: boolean
  readonly configurable: boolean
  readonly writable: boolean
  value?: Value
}
const ineligible = Symbol("native-input-value-ineligible")
const nativeSymbol = Symbol.for("langchain.message")
const ignored = new Set(["__proto__", "constructor", "prototype"])
const media = new Set(["image", "image_url", "audio", "file", "resource"])

function reject(): never { throw ineligible }
function primitive(value: unknown): value is Primitive {
  return value === null || value === undefined || typeof value === "string" ||
    typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)
}
function shape(value: object, root: boolean, remaining: number, assertBoundedWork: () => void): {
  prototype: object | null
  properties: Property[]
  values: unknown[]
} {
  if (types.isProxy(value)) reject()
  const prototype: unknown = Object.getPrototypeOf(value)
  const array = Array.isArray(value)
  if (root ? prototype !== HumanMessage.prototype : array ? prototype !== Array.prototype
    : prototype !== null && prototype !== Object.prototype) reject()
  const keys = Reflect.ownKeys(value)
  if (keys.length > remaining) reject()
  const properties: Property[] = [], values: unknown[] = []
  let length = 0
  if (array) {
    const entry = Object.getOwnPropertyDescriptor(value, "length")
    if (!entry || !("value" in entry) || typeof entry.value !== "number" ||
      !Number.isSafeInteger(entry.value) || entry.value < 0 ||
      entry.value > NATIVE_CAPTURE_MAX_EXPANDED_NODES || keys.length !== entry.value + 1) reject()
    length = entry.value
  }
  let steps = 0
  for (const key of keys) {
    if (++steps % 1024 === 0) assertBoundedWork()
    if (typeof key !== "string" ? !root || key !== nativeSymbol : ignored.has(key)) reject()
    if (array && key !== "length" && (typeof key !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) reject()
    const entry = Object.getOwnPropertyDescriptor(value, key)
    if (!entry || !("value" in entry)) reject()
    if (key === "type" && typeof entry.value === "string" && media.has(entry.value) ||
      key === "truncated" && entry.value === true || key === nativeSymbol && entry.value !== true)
      reject()
    properties.push({ key, enumerable: entry.enumerable === true,
      configurable: entry.configurable === true, writable: entry.writable === true })
    values.push(entry.value)
  }
  if (root && !keys.includes(nativeSymbol)) reject()
  return { prototype: prototype as object | null, properties, values }
}

/** Pure lossless data only. An ineligible original keeps the ordinary full typed-hash path. */
export function captureNativeInputCompleteValues(message: HumanMessage,
  assertBoundedWork: () => void): (() => boolean) | undefined {
  type Task = { input: unknown; parent: Property; root: boolean } | { exit: object }
  const holder: Property = { key: "root", enumerable: true, configurable: false, writable: false }
  const tasks: Task[] = [{ input: message, parent: holder, root: true }]
  const ancestors = new Set<object>()
  let remaining = NATIVE_CAPTURE_MAX_EXPANDED_NODES - 1, steps = 0
  try {
    assertBoundedWork()
    while (tasks.length) {
      if (++steps % 1024 === 0) assertBoundedWork()
      const task = tasks.pop()
      if (!task) reject()
      if ("exit" in task) { ancestors.delete(task.exit); continue }
      const value = task.input
      if (primitive(value)) { task.parent.value = { primitive: value }; continue }
      if (!value || typeof value !== "object" || types.isProxy(value) || ancestors.has(value))
        reject()
      const captured = shape(value, task.root, remaining, assertBoundedWork)
      // Count repeated references as expanded occurrences; a sparse/large array cannot allocate
      // an unbounded child worklist before this reservation is known to fit the original limit.
      remaining -= captured.properties.length
      task.parent.value = { prototype: captured.prototype, properties: captured.properties }
      ancestors.add(value); tasks.push({ exit: value })
      for (let index = captured.properties.length - 1; index >= 0; index--)
        tasks.push({ input: captured.values[index], parent: captured.properties[index], root: false })
    }
    assertBoundedWork()
  } catch (error) {
    if (error === ineligible) return undefined
    throw error
  }
  const fixed = holder.value
  if (!fixed) return undefined
  return () => {
    const pending: Array<{ input: unknown; fixed: Value; root: boolean }> = [
      { input: message, fixed, root: true }
    ]
    let remaining = NATIVE_CAPTURE_MAX_EXPANDED_NODES - 1, steps = 0
    try {
      assertBoundedWork()
      while (pending.length) {
        if (++steps % 1024 === 0) assertBoundedWork()
        const task = pending.pop()
        if (!task) reject()
        if ("primitive" in task.fixed) {
          if (!primitive(task.input) || !Object.is(task.input, task.fixed.primitive)) return false
          continue
        }
        if (!task.input || typeof task.input !== "object" || types.isProxy(task.input)) return false
        const actual = shape(task.input, task.root, remaining, assertBoundedWork)
        const properties = task.fixed.properties
        if (actual.prototype !== task.fixed.prototype || actual.properties.length !== properties.length)
          return false
        remaining -= properties.length
        for (let index = properties.length - 1; index >= 0; index--) {
          const expected = properties[index], observed = actual.properties[index]
          if (!expected.value || observed.key !== expected.key ||
            observed.enumerable !== expected.enumerable ||
            observed.configurable !== expected.configurable || observed.writable !== expected.writable)
            return false
          pending.push({ input: actual.values[index], fixed: expected.value, root: false })
        }
      }
      assertBoundedWork()
      return true
    } catch (error) {
      if (error === ineligible) return false
      throw error
    }
  }
}
