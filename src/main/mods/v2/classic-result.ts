import { isDeepStrictEqual } from "node:util"
import type { ModJson } from "../../../shared/mods/types"
import { isModObject } from "../../../shared/mods/v2/contracts"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"

// Host-only provenance: guest fields and publication rewrites cannot forge these facts.
const classicProvenance = new WeakMap<object, { feedbackChanged: boolean; participated: boolean }>()

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

export function recordClassicFeedback(
  value: object,
  changed: boolean,
  participated = false
): void {
  classicProvenance.set(value, { feedbackChanged: changed, participated })
}

export function participatedClassicHandler(value: ModJson): boolean {
  return isModObject(value) && classicProvenance.get(value)?.participated === true
}

export function contributedClassicFeedback(value: ModJson, core: ModJson | undefined): boolean {
  return (
    (isModObject(value) ? classicProvenance.get(value)?.feedbackChanged : undefined) ??
    changedClassicFeedback(value, core)
  )
}
