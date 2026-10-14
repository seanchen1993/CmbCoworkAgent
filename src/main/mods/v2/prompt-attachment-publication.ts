import type { ModJson, ModObject } from "../../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { validatePromptAttachmentInput } from "../../../shared/mods/v2/prompt-attachment"

function copyInput(value: ModJson): ModObject {
  const copied = parseModJson(encodeModJson(value))
  if (!isModObject(copied)) throw new ModFunctionError("MODS_PROMPT_ATTACHMENT_INPUT")
  return copied
}

/** Standard attachment labels are metadata; their complete body still passes the original policy. */
export async function publishPromptAttachmentInput(
  value: ModJson,
  publish: (payload: ModObject) => Promise<ModJson | undefined>
): Promise<ModObject> {
  const payload = copyInput(value)
  validatePromptAttachmentInput(payload)
  const typeField = Object.getOwnPropertyDescriptor(payload, "type")
  if (!typeField || typeof typeField.value !== "string")
    throw new ModFunctionError("MODS_PROMPT_ATTACHMENT_INPUT")
  const type = typeField.value
  const metadata = type === "image" || type === "image_url" || type === "audio" ||
    type === "file" || type === "resource"
  // Custom labels remain in the policy payload, including any sensitive text in the label itself.
  if (metadata) delete payload.type
  const protectedValue = await publish(payload)
  if (protectedValue === undefined) throw new ModFunctionError("MODS_PROMPT_ATTACHMENT_INPUT")
  const result = copyInput(protectedValue)
  if (metadata) Object.defineProperty(result, "type", {
    value: type, writable: true, configurable: true, enumerable: true
  })
  validatePromptAttachmentInput(result)
  return result
}
