import type { ModJson, ModObject } from "../../../shared/mods/types"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { PROMPT_COMPOSER_MAX_BYTES } from "../../../shared/mods/v2/prompt-composer"
import { validatePromptDecorations } from "../../../shared/mods/v2/prompt-edit"

function validText(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= PROMPT_COMPOSER_MAX_BYTES
}

export function validatePromptFillEventResult(method: string, value: ModJson): void {
  if (method !== "prompt.fill") return
  if (
    !isModObject(value) ||
    typeof value.isFilled !== "boolean" ||
    Object.keys(value).some((key) => !["isFilled", "refusal"].includes(key)) ||
    (value.refusal !== undefined &&
      (value.isFilled || !["no_composer", "dialog"].includes(String(value.refusal))))
  )
    throw new ModFunctionError("MODS_PROMPT_FILL_EVENT_RESULT")
}

export function validatePromptInput(method: string, input: ModObject): void {
  if (method === "prompt.read" && Object.keys(input).length)
    throw new ModFunctionError("MODS_PROMPT_INPUT_INVALID")
  if (method !== "prompt.fill") return
  if (
    !validText(input.text) ||
    (input.mode !== undefined && !["replace", "append", "insert"].includes(String(input.mode))) ||
    !isModObject(input.origin) ||
    input.origin.kind !== "plugin" ||
    typeof input.origin.name !== "string" ||
    Object.keys(input).some((key) => !["text", "mode", "origin", "decorations"].includes(key))
  )
    throw new ModFunctionError("MODS_PROMPT_INPUT_INVALID")
  if (input.decorations !== undefined) validatePromptDecorations(input.decorations, input.text as string)
}

export function validatePromptResult(method: string, value: ModJson | undefined): void {
  if (method !== "prompt.read" && method !== "prompt.fill") return
  if (
    !isModObject(value) ||
    !validText(value.text) ||
    !Number.isSafeInteger(value.cursor) ||
    Number(value.cursor) < 0 ||
    Number(value.cursor) > value.text.length
  )
    throw new ModFunctionError("MODS_PROMPT_RESULT_INVALID")
  const allowed =
    method === "prompt.read" ? ["text", "cursor"] : ["text", "cursor", "isFilled", "refusal"]
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    (method === "prompt.fill" &&
      (typeof value.isFilled !== "boolean" ||
        (value.refusal !== undefined &&
          (value.isFilled || !["no_composer", "dialog"].includes(String(value.refusal))))))
  )
    throw new ModFunctionError("MODS_PROMPT_RESULT_INVALID")
}
