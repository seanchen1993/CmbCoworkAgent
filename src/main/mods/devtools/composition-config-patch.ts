import type { ModObject, ModJson } from "../../../shared/mods/types"
import { isModObject } from "../../../shared/mods/v2/contracts"

const reserved = new Set(["__proto__", "prototype", "constructor"])
/** Objects merge recursively, arrays replace as a whole, null remains a literal value. */
export function patchCompositionConfig(
  previous: ModObject,
  patch: ModObject,
  removePaths: readonly string[] = []
): ModObject {
  const merge = (old: ModObject, next: ModObject, depth: number): ModObject => {
    if (depth > 24) throw Error("COMPOSITION_CONFIG_DEPTH")
    const result: ModObject = structuredClone(old)
    for (const [key, value] of Object.entries(next)) {
      if (reserved.has(key)) throw Error("COMPOSITION_CONFIG_PATH_INVALID")
      result[key] = isModObject(value)
        ? merge(isModObject(result[key]) ? result[key] : {}, value, depth + 1)
        : structuredClone(value)
    }
    return result
  }
  const result = merge(previous, patch, 0)
  for (const pointer of removePaths) {
    if (!pointer.startsWith("/") || pointer.length > 1024 || /~(?![01])/.test(pointer))
      throw Error("COMPOSITION_CONFIG_PATH_INVALID")
    const parts = pointer
      .slice(1)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    if (parts.length > 24 || parts.some((part) => !part || reserved.has(part)))
      throw Error("COMPOSITION_CONFIG_PATH_INVALID")
    let target: ModJson = result
    for (const part of parts.slice(0, -1)) {
      if (!isModObject(target) || !Object.hasOwn(target, part))
        throw Error("COMPOSITION_CONFIG_PATH_MISSING")
      target = target[part]
    }
    if (!isModObject(target) || !Object.hasOwn(target, parts.at(-1)!))
      throw Error("COMPOSITION_CONFIG_PATH_MISSING")
    delete target[parts.at(-1)!]
  }
  return result
}
