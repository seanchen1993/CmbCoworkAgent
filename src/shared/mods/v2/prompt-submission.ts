import type { ModObject, ModJson } from "../types"
import { ModFunctionError, isModObject } from "./contracts"
import { isFunctionPluginPromptOrigin } from "./plugin-prompt"

export function samePromptSubmissionOrigin(left: ModJson, right: ModJson): boolean {
  if (!isModObject(left) || !isModObject(right)) return false
  return left.kind === right.kind && left.name === right.name && left.asUser === right.asUser &&
    Object.keys(left).length === Object.keys(right).length
}

export interface PlainComposerSubmission {
  kind: "plain-text"
  text: string
}

export function isPlainComposerSubmission(
  value: unknown,
  message: string
): value is PlainComposerSubmission {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => key === "kind" || key === "text") &&
    (value as PlainComposerSubmission).kind === "plain-text" &&
    (value as PlainComposerSubmission).text === message &&
    message.trim().length > 0 &&
    message.length <= 32000
  )
}

export function validatePromptSubmissionInput(value: ModObject): void {
  if (
    typeof value.text !== "string" ||
    value.text.length > 32000 ||
    !isModObject(value.origin) ||
    !((value.origin.kind === "composer" &&
      Object.keys(value.origin).every((key) => key === "kind")) ||
      isFunctionPluginPromptOrigin(value.origin)) ||
    typeof value.wait !== "boolean" ||
    (value.turnId !== undefined && typeof value.turnId !== "string") ||
    (value.context !== undefined &&
      (!Array.isArray(value.context) ||
        value.context.length > 32 ||
        value.context.some((v) => typeof v !== "string" || !v.length) ||
        JSON.stringify(value.context).length > 64000)) ||
    Object.keys(value).some((key) => !["text", "origin", "wait", "turnId", "context"].includes(key))
  )
    throw new ModFunctionError("MODS_PROMPT_SUBMIT_INPUT")
}

export function validatePromptSubmissionResult(value: ModJson, input: ModObject): void {
  if (!isModObject(value)) throw new ModFunctionError("MODS_PROMPT_SUBMIT_RESULT")
  if (typeof value.drop === "string") {
    if (
      !value.drop.trim() ||
      value.drop.length > 32000 ||
      Object.keys(value).some((key) => key !== "drop")
    )
      throw new ModFunctionError("MODS_PROMPT_SUBMIT_RESULT")
    return
  }
  validatePromptSubmissionInput({ ...value, origin: value.origin ?? input.origin, wait: false })
  if (value.origin !== undefined && !samePromptSubmissionOrigin(value.origin, input.origin))
    throw new ModFunctionError("MODS_PROMPT_SUBMIT_RESULT")
  if (Object.keys(value).some((key) => !["text", "context", "origin"].includes(key)))
    throw new ModFunctionError("MODS_PROMPT_SUBMIT_RESULT")
}
