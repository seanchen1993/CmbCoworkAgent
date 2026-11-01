import type { ModObject } from "../types"
import { isModObject, ModFunctionError } from "./contracts"
import { validatePromptDecorations, type FunctionPromptDecoration } from "./prompt-edit"
import { PROMPT_COMPOSER_MAX_BYTES } from "./prompt-composer"

export interface FunctionPromptPaintArgs {
  text?: string
  decorations: FunctionPromptDecoration[]
}
export interface FunctionPromptPaintResult {
  isPainted: boolean
  text: string
  cursor: number
}

export function validatePromptPaintArgs(value: unknown): asserts value is FunctionPromptPaintArgs {
  if (
    !isModObject(value) ||
    Object.keys(value).some((key) => !["text", "decorations"].includes(key)) ||
    (value.text !== undefined &&
      (typeof value.text !== "string" ||
        new TextEncoder().encode(value.text).length > PROMPT_COMPOSER_MAX_BYTES)) ||
    !Array.isArray(value.decorations) ||
    (value.decorations.length > 0 && typeof value.text !== "string")
  )
    throw new ModFunctionError("MODS_PROMPT_PAINT_ARGUMENTS")
  validatePromptDecorations(value.decorations, (value.text as string | undefined) ?? "")
}

export function validatePromptPaintResult(
  value: unknown
): asserts value is FunctionPromptPaintResult {
  if (
    !isModObject(value) ||
    Object.keys(value).some((key) => !["isPainted", "text", "cursor"].includes(key)) ||
    typeof value.isPainted !== "boolean" ||
    typeof value.text !== "string" ||
    new TextEncoder().encode(value.text).length > PROMPT_COMPOSER_MAX_BYTES ||
    !Number.isSafeInteger(value.cursor) ||
    Number(value.cursor) < 0 ||
    Number(value.cursor) > value.text.length
  )
    throw new ModFunctionError("MODS_PROMPT_PAINT_RESULT")
}

/** A display-only operation cannot introduce an editable value through hook metadata. */
export function promptPaintInput(value: ModObject): FunctionPromptPaintArgs {
  const input = {
    ...(value.text === undefined ? {} : { text: value.text }),
    decorations: value.decorations
  }
  validatePromptPaintArgs(input)
  return input
}
