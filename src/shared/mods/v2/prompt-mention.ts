import type { ModJson, ModObject } from "../types"
import { encodeModJson } from "../validation"
import { isModObject, ModFunctionError } from "./contracts"

export type FunctionPromptMentionType = "file" | "already_read_file" | "pdf_reference" | null
export const PROMPT_MENTION_CONTEXT_ITEM_CHARS = 100000
export const PROMPT_MENTION_CONTEXT_TOTAL_CHARS = 200000

function own(value: ModObject, key: string): ModJson | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return undefined
  if (!("value" in descriptor)) throw new ModFunctionError("MODS_PROMPT_MENTION_ACCESSOR")
  return descriptor.value
}

export function validatePromptMentionInput(value: ModObject): void {
  encodeModJson(value)
  const mention = own(value, "mention"), path = own(value, "path")
  const offset = own(value, "offset"), limit = own(value, "limit")
  const agentId = own(value, "agentId")
  let controls = false
  if (typeof path === "string") {
    for (let index = 0; index < path.length; index++) {
      if (path.charCodeAt(index) <= 31) { controls = true; break }
    }
  }
  if (typeof mention !== "string" || !mention || mention.length > 8192 ||
    typeof path !== "string" || !path || path.length > 8192 ||
    !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path) || controls ||
    (offset !== undefined && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 1)) ||
    (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1)) ||
    (agentId !== undefined && (typeof agentId !== "string" || !agentId || agentId.length > 256)) ||
    Object.keys(value).some(key => !["mention", "path", "offset", "limit", "agentId"].includes(key)))
    throw new ModFunctionError("MODS_PROMPT_MENTION_INPUT")
}

export function validatePromptMentionResult(value: ModJson): asserts value is ModObject {
  encodeModJson(value)
  if (!isModObject(value)) throw new ModFunctionError("MODS_PROMPT_MENTION_RESULT")
  const deny = own(value, "deny"), type = own(value, "type"), context = own(value, "context")
  if (deny !== undefined) {
    if (typeof deny !== "string" || deny.length > 8000 || type !== undefined || context !== undefined)
      throw new ModFunctionError("MODS_PROMPT_MENTION_RESULT")
    return
  }
  if (type !== null && type !== "file" && type !== "already_read_file" && type !== "pdf_reference")
    throw new ModFunctionError("MODS_PROMPT_MENTION_RESULT")
  if (context !== undefined && (!Array.isArray(context) ||
    context.some(item => typeof item !== "string" || !item.length)))
    throw new ModFunctionError("MODS_PROMPT_MENTION_CONTEXT")
}

/** Only a Hook's actual settled next supplies the context it must retain. */
export function synchronizePromptMentionResult(value: ModJson, baseline: ModJson): ModObject {
  validatePromptMentionResult(value)
  if (own(value, "deny") !== undefined) return value
  const context = own(value, "context") as string[] | undefined
  if (context?.some(item => item.length > PROMPT_MENTION_CONTEXT_ITEM_CHARS) ||
    (context?.reduce((sum, item) => sum + item.length, 0) ?? 0) >
      PROMPT_MENTION_CONTEXT_TOTAL_CHARS)
    throw new ModFunctionError("MODS_PROMPT_MENTION_CONTEXT_ARTIFACT_UNAVAILABLE")
  if (!isModObject(baseline) || !Object.hasOwn(baseline, "type")) return value
  validatePromptMentionResult(baseline)
  if (own(baseline, "deny") !== undefined) return baseline
  const previous = own(baseline, "context") as string[] | undefined
  const available = new Map<string, number>()
  for (const item of context ?? []) available.set(item, (available.get(item) ?? 0) + 1)
  for (const item of previous ?? []) {
    const count = available.get(item) ?? 0
    if (!count) throw new ModFunctionError("MODS_PROMPT_MENTION_CONTEXT_REMOVED")
    available.set(item, count - 1)
  }
  return value
}
