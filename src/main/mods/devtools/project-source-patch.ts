import { isDeepStrictEqual, types } from "node:util"

export const PROJECT_SOURCE_PATCH_LIMITS = Object.freeze({
  operations: 16,
  pathCharacters: 512,
  valueBytes: 16 * 1024,
  totalBytes: 32 * 1024
})
const prohibited = new Set(["__proto__", "constructor", "prototype"])
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Operation = { op: "add" | "replace" | "remove" | "test"; path: string; value?: Json }

export class ProjectSourcePatchError extends Error {
  constructor(
    code: string,
    readonly operationIndex?: number,
    readonly path?: string
  ) {
    super(`PROJECT_SOURCE_PATCH_${code}`)
    this.path = path?.slice(0, PROJECT_SOURCE_PATCH_LIMITS.pathCharacters)
  }
}

/** Read only plain JSON data: no accessors, proxies, cycles, sparse arrays or special keys. */
function jsonClone(input: unknown): Json {
  let nodes = 0
  const seen = new Set<object>()
  const clone = (value: unknown, depth: number): Json => {
    if (++nodes > 8192 || depth > 32) throw new ProjectSourcePatchError("LIMIT")
    if (value === null || typeof value === "string" || typeof value === "boolean") return value
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (!value || typeof value !== "object" || types.isProxy(value) || seen.has(value))
      throw new ProjectSourcePatchError("VALUE")
    const prototype = Object.getPrototypeOf(value)
    if (
      Array.isArray(value)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      throw new ProjectSourcePatchError("VALUE")
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
      Object.entries(descriptors).some(
        ([key, item]) =>
          !("value" in item) ||
          (!item.enumerable && !(Array.isArray(value) && key === "length")) ||
          prohibited.has(key)
      )
    )
      throw new ProjectSourcePatchError("VALUE")
    seen.add(value)
    let result: Json
    if (Array.isArray(value)) {
      if (value.length > 8192 || Object.keys(descriptors).length !== value.length + 1)
        throw new ProjectSourcePatchError("VALUE")
      result = []
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(descriptors, index)) throw new ProjectSourcePatchError("VALUE")
        result.push(clone(descriptors[index].value, depth + 1))
      }
    } else {
      result = Object.create(null) as { [key: string]: Json }
      for (const [key, descriptor] of Object.entries(descriptors))
        result[key] = clone(descriptor.value, depth + 1)
    }
    seen.delete(value)
    return result
  }
  // Parsing this validated serialization produces an independent ordinary JSON tree.
  return JSON.parse(JSON.stringify(clone(input, 0))) as Json
}

function pointer(path: string): string[] {
  if (!path.startsWith("/") || path.length > PROJECT_SOURCE_PATCH_LIMITS.pathCharacters)
    throw new ProjectSourcePatchError("POINTER")
  return path
    .slice(1)
    .split("/")
    .map((part) => {
      if (/~(?:[^01]|$)/.test(part)) throw new ProjectSourcePatchError("POINTER")
      const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~")
      if (
        prohibited.has(decoded) ||
        [".", ".."].includes(decoded) ||
        decoded.includes("\\") ||
        decoded.includes("\0")
      )
        throw new ProjectSourcePatchError("POINTER")
      return decoded
    })
}

function arrayIndex(token: string, length: number, adding: boolean): number {
  if (adding && token === "-") return length
  if (!/^(?:0|[1-9]\d*)$/.test(token)) throw new ProjectSourcePatchError("POINTER")
  const index = Number(token)
  if (!Number.isSafeInteger(index) || index > length || (!adding && index === length))
    throw new ProjectSourcePatchError("PATH_MISSING")
  return index
}

/** Fixed JSON document transform only; it never selects a file or writes a revision. */
export function patchProjectComposition(text: string, input: unknown): string {
  if (
    types.isProxy(input) ||
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > PROJECT_SOURCE_PATCH_LIMITS.operations
  )
    throw new ProjectSourcePatchError("LIMIT")
  const operations = jsonClone(input)
  if (Buffer.byteLength(JSON.stringify(operations)) > PROJECT_SOURCE_PATCH_LIMITS.totalBytes)
    throw new ProjectSourcePatchError("LIMIT")
  const document = JSON.parse(text) as Json
  for (const [operationIndex, value] of (operations as Json[]).entries()) {
    let path: string | undefined
    try {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new ProjectSourcePatchError("OPERATION")
      const operation = value as unknown as Operation
      path = typeof operation.path === "string" ? operation.path : undefined
      if (
        !["add", "replace", "remove", "test"].includes(operation.op) ||
        !path ||
        Object.keys(operation).some((key) => !["op", "path", "value"].includes(key)) ||
        Object.hasOwn(operation, "value") !== (operation.op !== "remove")
      )
        throw new ProjectSourcePatchError("OPERATION")
      if (
        operation.op !== "remove" &&
        Buffer.byteLength(JSON.stringify(operation.value)) > PROJECT_SOURCE_PATCH_LIMITS.valueBytes
      )
        throw new ProjectSourcePatchError("LIMIT")
      const segments = pointer(path)
      let parent = document
      for (const segment of segments.slice(0, -1)) {
        if (!parent || typeof parent !== "object") throw new ProjectSourcePatchError("PATH_MISSING")
        if (Array.isArray(parent)) parent = parent[arrayIndex(segment, parent.length, false)]
        else {
          if (!Object.hasOwn(parent, segment)) throw new ProjectSourcePatchError("PATH_MISSING")
          parent = parent[segment]
        }
      }
      if (!parent || typeof parent !== "object") throw new ProjectSourcePatchError("PATH_MISSING")
      const key = segments.at(-1)!
      const adding = operation.op === "add"
      const index = Array.isArray(parent) ? arrayIndex(key, parent.length, adding) : undefined
      if (!Array.isArray(parent) && (key === "-" || (!adding && !Object.hasOwn(parent, key))))
        throw new ProjectSourcePatchError("PATH_MISSING")
      const actual =
        index !== undefined ? (parent as Json[])[index] : (parent as Record<string, Json>)[key]
      if (operation.op === "test") {
        if (!isDeepStrictEqual(actual, operation.value))
          throw new ProjectSourcePatchError("TEST_FAILED")
      } else if (index !== undefined) {
        const array = parent as Json[]
        if (operation.op === "remove") array.splice(index, 1)
        else if (adding) array.splice(index, 0, operation.value!)
        else array[index] = operation.value!
      } else {
        const object = parent as Record<string, Json>
        if (operation.op === "remove") delete object[key]
        else object[key] = operation.value!
      }
    } catch (error) {
      if (!(error instanceof ProjectSourcePatchError)) throw error
      throw new ProjectSourcePatchError(
        error.message.slice("PROJECT_SOURCE_PATCH_".length),
        operationIndex,
        path
      )
    }
  }
  return JSON.stringify(document, null, 2) + "\n"
}
