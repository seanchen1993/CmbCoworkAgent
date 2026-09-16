import type { ModObject } from "../types"
import { encodeModJson } from "../validation"
import { ModFunctionError } from "./contracts"

/** Host-owned fields in the pinned 2.1.273 contracts; required identity fields cannot be omitted. */
const pinned: Record<string, readonly string[]> = {
  "command.run": ["command", "origin", "presentation"],
  "command.describe": ["command", "immediate", "provider"],
  "config.describe": ["key", "provider"],
  "tool.call": ["tool", "tool_use_id", "agentId"],
  "turn.step": ["turnId", "index", "messageCount", "agentId"],
  "ui.open": ["id"],
  "ui.close": ["id", "origin"],
  "ui.render": ["surface", "component", "requestId", "viewport"],
  "ui.press": ["plugin", "element", "component", "requestId", "surface"],
  "ui.input": ["plugin", "element", "component", "requestId", "surface", "kind"],
  "ui.select": ["plugin", "element", "component", "requestId", "surface"]
}
const required: Record<string, readonly string[]> = {
  "command.run": ["command", "origin"],
  "command.describe": ["command", "immediate"],
  "config.describe": ["key"],
  "turn.step": ["turnId", "index", "messageCount"]
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = Object.keys(a)
  const right = Object.keys(b)
  return (
    left.length === right.length &&
    left.every((key) => Object.hasOwn(b, key) && same((a as ModObject)[key], (b as ModObject)[key]))
  )
}

export function normalizeFunctionInput(
  event: string,
  received: ModObject,
  original: ModObject
): ModObject {
  encodeModJson(received)
  const result = { ...received }
  for (const key of pinned[event] ?? []) {
    if (
      required[event]?.includes(key) &&
      Object.hasOwn(original, key) &&
      !Object.hasOwn(received, key)
    )
      throw new ModFunctionError("MODS_PINNED_INPUT", `MODS_PINNED_INPUT: ${event}.${key}`)
    if (Object.hasOwn(received, key) && !same(received[key], original[key]))
      throw new ModFunctionError("MODS_PINNED_INPUT", `MODS_PINNED_INPUT: ${event}.${key}`)
    if (Object.hasOwn(original, key)) result[key] = original[key]
  }
  return result
}
