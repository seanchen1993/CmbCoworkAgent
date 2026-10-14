import type { ModJson, ModObject } from "../types"
import { encodeModJson } from "../validation"
import { ModFunctionError, isModObject } from "./contracts"

export type FunctionPromptEvent = "prompt.section" | "prompt.compose" | "prompt.context" |
  "prompt.attachment"
export type FunctionPromptCore = (input: ModObject, signal: AbortSignal) => Promise<ModObject>

const traits = new Set([
  "bare",
  "lean",
  "sdk-preset",
  "teammate",
  "analysis",
  "print",
  "skills",
  "send-user-message"
])
const surfaces = new Set(["terminal", "desktop", "mobile", "vscode"])
export const PROMPT_COMPOSITION_MAX_BYTES = 512 * 1024

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length <= PROMPT_COMPOSITION_MAX_BYTES
}

export function validatePromptCompositionInput(event: string, value: ModObject): void {
  if (event === "prompt.section") {
    if (
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 256 ||
      (value.text !== null && !boundedText(value.text)) ||
      Object.keys(value).some((key) => key !== "name" && key !== "text")
    )
      throw new ModFunctionError("MODS_PROMPT_SECTION_INPUT")
  } else if (event === "prompt.compose") {
    if (
      typeof value.model !== "string" ||
      !value.model.trim() ||
      value.model.length > 256 ||
      typeof value.promptModel !== "string" ||
      !value.promptModel.trim() ||
      !Array.isArray(value.surfaces) ||
      value.surfaces.some((s) => typeof s !== "string" || !surfaces.has(s)) ||
      !Array.isArray(value.tools) ||
      value.tools.length > 2048 ||
      value.tools.some((tool) => typeof tool !== "string" || !tool || tool.length > 256) ||
      !Array.isArray(value.traits) ||
      value.traits.some((t) => typeof t !== "string" || !traits.has(t)) ||
      (value.outputStyle !== null &&
        (!isModObject(value.outputStyle) ||
          typeof value.outputStyle.name !== "string" ||
          typeof value.outputStyle.isKeepingCodingInstructions !== "boolean" ||
          Object.keys(value.outputStyle).some(
            (k) => k !== "name" && k !== "isKeepingCodingInstructions"
          ))) ||
      Object.keys(value).some(
        (k) => !["model", "promptModel", "surfaces", "tools", "outputStyle", "traits"].includes(k)
      )
    )
      throw new ModFunctionError("MODS_PROMPT_COMPOSE_INPUT")
  } else return
  if (new TextEncoder().encode(encodeModJson(value)).length > PROMPT_COMPOSITION_MAX_BYTES)
    throw new ModFunctionError("MODS_PROMPT_COMPOSITION_LIMIT")
}

/** Validate each Hook, so the dispatcher can keep a valid next or skip exactly once. */
export function validatePromptCompositionResult(event: string, value: ModJson): void {
  if (event !== "prompt.section" && event !== "prompt.compose") return
  if (!isModObject(value)) throw new ModFunctionError("MODS_PROMPT_COMPOSITION_RESULT")
  if (event === "prompt.section") {
    if (
      (value.text !== null && !boundedText(value.text)) ||
      Object.keys(value).some((k) => k !== "text")
    )
      throw new ModFunctionError("MODS_PROMPT_SECTION_RESULT")
  } else {
    if (
      !Array.isArray(value.sections) ||
      value.sections.length > 256 ||
      Object.keys(value).some((k) => k !== "sections")
    )
      throw new ModFunctionError("MODS_PROMPT_COMPOSE_RESULT")
    const ids = new Set<string>()
    let sessionSeen = false
    for (const section of value.sections) {
      if (
        !isModObject(section) ||
        typeof section.id !== "string" ||
        !section.id.trim() ||
        section.id.length > 256 ||
        ids.has(section.id) ||
        !boundedText(section.text) ||
        (section.scope !== "shared" && section.scope !== "session") ||
        (sessionSeen && section.scope === "shared") ||
        Object.keys(section).some((k) => !["id", "text", "scope"].includes(k))
      )
        throw new ModFunctionError("MODS_PROMPT_COMPOSE_SECTION")
      ids.add(section.id)
      sessionSeen ||= section.scope === "session"
    }
  }
  if (new TextEncoder().encode(encodeModJson(value)).length > PROMPT_COMPOSITION_MAX_BYTES)
    throw new ModFunctionError("MODS_PROMPT_COMPOSITION_LIMIT")
}
