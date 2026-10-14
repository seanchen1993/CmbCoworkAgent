import type { ModJson, ModObject } from "../types"
import { isModObject, ModFunctionError, MOD_TIERS, type ModTier } from "./contracts"

export type FunctionPresentationEvent = "skill.prompt" | "tool.describe"
export const FUNCTION_PRESENTATION_MAX_BYTES = 262144
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).length <= FUNCTION_PRESENTATION_MAX_BYTES
  )
}
export function validatePresentationInput(event: string, value: ModObject): void {
  if (
    event === "skill.prompt" &&
    (typeof value.skill !== "string" ||
      !value.skill ||
      !text(value.text) ||
      Object.keys(value).some((key) => !["skill", "text"].includes(key)))
  )
    throw new ModFunctionError("MODS_SKILL_PROMPT_INPUT")
  if (
    event === "tool.describe" &&
    (typeof value.tool !== "string" ||
      !value.tool ||
      !text(value.description) ||
      !isModObject(value.provider) ||
      typeof value.provider.plugin !== "string" ||
      !MOD_TIERS.includes(value.provider.tier as ModTier) ||
      (value.isDeferred !== undefined && typeof value.isDeferred !== "boolean") ||
      Object.keys(value).some(
        (key) => !["tool", "description", "provider", "isDeferred"].includes(key)
      ))
  )
    throw new ModFunctionError("MODS_TOOL_DESCRIPTION_INPUT")
}
export function validatePresentationResult(event: string, value: ModJson, input?: ModObject): void {
  if ((event === "skill.prompt" || event === "tool.describe") && isModObject(value) && input) {
    for (const key of event === "skill.prompt" ? ["skill"] : ["tool", "provider"]) {
      if (Object.hasOwn(value, key) && JSON.stringify(value[key]) !== JSON.stringify(input[key]))
        throw new ModFunctionError("MODS_PRESENTATION_IDENTITY")
    }
  }
  if (
    event === "skill.prompt" &&
    (!isModObject(value) ||
      !text(value.text) ||
      Object.keys(value).some((key) => !["text", "skill"].includes(key)))
  )
    throw new ModFunctionError("MODS_SKILL_PROMPT_RESULT")
  if (
    event === "tool.describe" &&
    (!isModObject(value) ||
      !text(value.description) ||
      (value.isDeferred !== undefined && typeof value.isDeferred !== "boolean") ||
      Object.keys(value).some(
        (key) => !["description", "isDeferred", "tool", "provider"].includes(key)
      ))
  )
    throw new ModFunctionError("MODS_TOOL_DESCRIPTION_RESULT")
}
