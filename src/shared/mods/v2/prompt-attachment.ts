import type { ModJson, ModObject } from "../types"
import { encodeModJson } from "../validation"
import { ModFunctionError, isModObject } from "./contracts"

export function validatePromptAttachmentInput(input: ModObject): void {
  const origin = input.origin
  if (
    typeof input.type !== "string" ||
    !input.type.trim() ||
    input.type.length > 256 ||
    typeof input.text !== "string" ||
    !isModObject(origin) ||
    !["engine", "hook", "plugin"].includes(String(origin.kind)) ||
    (origin.kind !== "engine" && (typeof origin.event !== "string" || !origin.event.trim())) ||
    Object.keys(origin).some(
      (key) => key !== "kind" && !(origin.kind !== "engine" && key === "event")
    ) ||
    (input.agentId !== undefined && (typeof input.agentId !== "string" || !input.agentId)) ||
    (input.detail !== undefined && !isModObject(input.detail)) ||
    Object.keys(input).some((key) => !["type", "text", "origin", "agentId", "detail"].includes(key))
  )
    throw new ModFunctionError("MODS_PROMPT_ATTACHMENT_INPUT")
  const plan = ["plan_mode", "plan_mode_reentry", "plan_mode_exit"].includes(String(input.type))
  if (plan && Object.hasOwn(input, "detail")) {
    const detail = input.detail
    const allowed =
      input.type === "plan_mode"
        ? ["reminder", "planFilePath", "hasPlan"]
        : input.type === "plan_mode_exit"
          ? ["planFilePath", "hasPlan"]
          : ["planFilePath"]
    if (
      !isModObject(detail) ||
      typeof detail.planFilePath !== "string" ||
      detail.planFilePath.length > 4096 ||
      Object.keys(detail).some((key) => !allowed.includes(key)) ||
      (input.type !== "plan_mode_reentry" && typeof detail.hasPlan !== "boolean") ||
      (input.type === "plan_mode" && !["full", "sparse"].includes(String(detail.reminder)))
    )
      throw new ModFunctionError("MODS_PROMPT_ATTACHMENT_DETAIL")
  } else if (!plan && Object.hasOwn(input, "detail")) {
    throw new ModFunctionError("MODS_PROMPT_ATTACHMENT_DETAIL")
  }
  if (new TextEncoder().encode(encodeModJson(input)).length > 512 * 1024)
    throw new ModFunctionError("MODS_PROMPT_ATTACHMENT_LIMIT")
}

export function validatePromptAttachmentResult(value: ModJson): void {
  if (
    !isModObject(value) ||
    (value.text !== null && typeof value.text !== "string") ||
    Object.keys(value).some((key) => key !== "text")
  )
    throw new ModFunctionError("MODS_PROMPT_ATTACHMENT_RESULT")
  if (new TextEncoder().encode(encodeModJson(value)).length > 512 * 1024)
    throw new ModFunctionError("MODS_PROMPT_ATTACHMENT_LIMIT")
}
