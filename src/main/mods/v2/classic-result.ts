import { isDeepStrictEqual } from "node:util"
import type { ModJson } from "../../../shared/mods/types"
import { isModObject } from "../../../shared/mods/v2/contracts"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"

// Host-only provenance: guest fields and publication rewrites cannot forge feedback ownership.
const feedbackChanges = new WeakMap<object, boolean>()

export function copyClassicResult(value: ModJson): ModJson {
  return parseModJson(encodeModJson(value)) as ModJson
}

export function sameClassicResult(value: ModJson, core: ModJson | undefined): boolean {
  return core !== undefined && isDeepStrictEqual(value, core)
}

function context(value: ModJson | undefined): string | undefined {
  if (!isModObject(value)) return undefined
  const text = value.additionalContext
  if (typeof text === "string") return text.trim() || undefined
  if (Array.isArray(text) && text.every((part) => typeof part === "string"))
    return text.join("\n").trim() || undefined
  return undefined
}

export function changedClassicFeedback(value: ModJson, core: ModJson | undefined): boolean {
  const feedback = context(value)
  return feedback !== undefined && feedback !== context(core)
}

export function recordClassicFeedback(value: object, changed: boolean): void {
  feedbackChanges.set(value, changed)
}

export function contributedClassicFeedback(value: ModJson, core: ModJson | undefined): boolean {
  return (
    (isModObject(value) ? feedbackChanges.get(value) : undefined) ??
    changedClassicFeedback(value, core)
  )
}
