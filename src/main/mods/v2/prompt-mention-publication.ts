import type { ModJson, ModObject } from "../../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { validatePromptMentionResult } from "../../../shared/mods/v2/prompt-mention"

function copyRecord(value: ModJson): ModObject {
  const copied = parseModJson(encodeModJson(value))
  if (!isModObject(copied)) throw new ModFunctionError("MODS_PROMPT_MENTION_RESULT")
  return copied
}

/** Mention's type is protocol metadata; every other field still passes the original policy. */
export async function publishPromptMentionResult(
  value: ModJson,
  publish: (payload: ModObject) => Promise<ModJson | undefined>
): Promise<ModObject> {
  validatePromptMentionResult(value)
  const payload = copyRecord(value)
  const type = Object.getOwnPropertyDescriptor(payload, "type")
  // Only this validated top-level field is metadata. Nested media remains in the policy payload.
  if (type) delete payload.type
  const protectedValue = await publish(payload)
  if (protectedValue === undefined) throw new ModFunctionError("MODS_PROMPT_MENTION_RESULT")
  const result = copyRecord(protectedValue)
  if (type) Object.defineProperty(result, "type", {
    value: type.value, writable: true, configurable: true, enumerable: true
  })
  validatePromptMentionResult(result)
  return result
}
