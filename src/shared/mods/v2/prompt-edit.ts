import type { ModJson, ModObject } from "../types"
import { isModObject, ModFunctionError } from "./contracts"
import { PROMPT_COMPOSER_MAX_BYTES } from "./prompt-composer"

export type FunctionPromptBox = { text: string; cursor: number }
export type FunctionPromptKey = { key: string; ctrl?: true; shift?: true; meta?: true }
export type FunctionPromptDecoration = {
  start: number
  end: number
  color?: string
  backgroundColor?: string
  dimColor?: boolean
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
}
export type FunctionPromptEditInput = FunctionPromptBox & {
  origin: { kind: "composer" }
  key?: FunctionPromptKey
  start: number
  end: number
  inputText: string
}
export type FunctionPromptEditResult = FunctionPromptBox & {
  decorations?: FunctionPromptDecoration[]
}
export type FunctionPromptSuggestInput = {
  text: string
  origin: { kind: "suggestion" } | { kind: "plugin"; name: string }
}

const validText = (value: unknown): value is string =>
  typeof value === "string" && new TextEncoder().encode(value).length <= PROMPT_COMPOSER_MAX_BYTES
const offset = (value: unknown, text: string) =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= text.length
const box = (value: ModObject) => validText(value.text) && offset(value.cursor, value.text)

export function validatePromptEditInput(input: ModObject): void {
  if (
    !box(input) ||
    !isModObject(input.origin) ||
    input.origin.kind !== "composer" ||
    Object.keys(input.origin).some((key) => key !== "kind") ||
    !offset(input.start, input.text as string) ||
    !offset(input.end, input.text as string) ||
    Number(input.end) < Number(input.start) ||
    !validText(input.inputText) ||
    Object.keys(input).some(
      (key) => !["origin", "key", "text", "cursor", "start", "end", "inputText"].includes(key)
    )
  )
    throw new ModFunctionError("MODS_PROMPT_EDIT_INPUT")
  if (
    Object.hasOwn(input, "key") &&
    (!isModObject(input.key) ||
      typeof input.key.key !== "string" ||
      !input.key.key ||
      input.key.key.length > 64 ||
      Object.keys(input.key).some(
        (key) =>
          key !== "key" && (!["ctrl", "shift", "meta"].includes(key) || input.key![key] !== true)
      ))
  )
    throw new ModFunctionError("MODS_PROMPT_EDIT_KEY")
}

export function validatePromptDecorations(value: ModJson, text: string): void {
  if (!Array.isArray(value) || value.length > 256)
    throw new ModFunctionError("MODS_PROMPT_DECORATIONS")
  const boolean = ["dimColor", "bold", "italic", "underline", "strikethrough"]
  for (const span of value) {
    if (
      !isModObject(span) ||
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      Object.keys(span).some(
        (key) => !["start", "end", "color", "backgroundColor", ...boolean].includes(key)
      ) ||
      boolean.some((key) => span[key] !== undefined && typeof span[key] !== "boolean") ||
      ["color", "backgroundColor"].some(
        (key) => span[key] !== undefined && (typeof span[key] !== "string" || span[key].length > 80)
      )
    )
      throw new ModFunctionError("MODS_PROMPT_DECORATIONS")
  }
  if (!validText(text)) throw new ModFunctionError("MODS_PROMPT_EDIT_LIMIT")
}

export function validatePromptEditResult(value: ModJson): void {
  if (
    !isModObject(value) ||
    !box(value) ||
    Object.keys(value).some((key) => !["text", "cursor", "decorations"].includes(key))
  )
    throw new ModFunctionError("MODS_PROMPT_EDIT_RESULT")
  if (value.decorations !== undefined)
    validatePromptDecorations(value.decorations, value.text as string)
}

export function applyPromptEdit(input: FunctionPromptEditInput): FunctionPromptEditResult {
  validatePromptEditInput(input as ModObject)
  return {
    text: input.text.slice(0, input.start) + input.inputText + input.text.slice(input.end),
    cursor: input.start + input.inputText.length
  }
}

/** UTF-16 splice from the last confirmed box, including every unconfirmed optimistic edit. */
export function cumulativePromptEdit(
  before: FunctionPromptBox,
  after: FunctionPromptBox,
  key?: FunctionPromptKey
): FunctionPromptEditInput {
  let start = 0,
    suffix = 0
  while (
    start < before.text.length &&
    start < after.text.length &&
    before.text[start] === after.text[start]
  )
    start++
  while (
    suffix < before.text.length - start &&
    suffix < after.text.length - start &&
    before.text[before.text.length - 1 - suffix] === after.text[after.text.length - 1 - suffix]
  )
    suffix++
  // A textual diff may guess the wrong occurrence of repeated characters. A merged
  // edit whose splice cannot explain the actual cursor is an honest whole-box edit.
  if (before.text !== after.text && start + after.text.length - suffix - start !== after.cursor) {
    start = 0
    suffix = 0
  }
  if (before.text === after.text) start = after.cursor
  const input: FunctionPromptEditInput = {
    origin: { kind: "composer" },
    ...before,
    start,
    end: before.text === after.text ? start : before.text.length - suffix,
    inputText:
      before.text === after.text ? "" : after.text.slice(start, after.text.length - suffix),
    ...(key ? { key: { ...key } } : {})
  }
  validatePromptEditInput(input as ModObject)
  return input
}

export function validatePromptSuggestInput(input: ModObject): void {
  const origin = input.origin
  if (
    !validText(input.text) ||
    !isModObject(origin) ||
    !["suggestion", "plugin"].includes(String(origin.kind)) ||
    (origin.kind === "plugin" && (typeof origin.name !== "string" || !origin.name)) ||
    Object.keys(origin).some(
      (key) => key !== "kind" && !(origin.kind === "plugin" && key === "name")
    ) ||
    Object.keys(input).some((key) => !["origin", "text"].includes(key))
  )
    throw new ModFunctionError("MODS_PROMPT_SUGGEST_INPUT")
}
export function validatePromptSuggestResult(value: ModJson): void {
  if (
    !isModObject(value) ||
    typeof value.isShown !== "boolean" ||
    Object.keys(value).some((key) => key !== "isShown")
  )
    throw new ModFunctionError("MODS_PROMPT_SUGGEST_RESULT")
}
