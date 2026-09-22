import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { ModJson, ModObject } from "../../../shared/mods/types"

function usage(value: ModJson | undefined): void {
  if (
    !isModObject(value) ||
    typeof value.model !== "string" ||
    ![
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens"
    ].every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
  )
    throw new ModFunctionError("MODS_TURN_USAGE_INVALID")
}

export function validateFunctionTurnInput(event: string, value: ModObject): void {
  if (!["turn.start", "turn.complete", "turn.abort"].includes(event)) return
  if (typeof value.turnId !== "string" || !value.turnId || value.turnId.length > 1024)
    throw new ModFunctionError("MODS_TURN_ID_INVALID")
  if (event === "turn.start" && typeof value.text !== "string")
    throw new ModFunctionError("MODS_TURN_START_INVALID")
  if (event !== "turn.complete") return
  if (
    typeof value.answer !== "string" ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    typeof value.isAborted !== "boolean" ||
    !["answer", "aborted", "refusal", "error"].includes(String(value.reason)) ||
    (value.agentId !== undefined && typeof value.agentId !== "string")
  )
    throw new ModFunctionError("MODS_TURN_COMPLETE_INVALID")
  if (
    value.reason === "refusal" &&
    (!isModObject(value.refusal) ||
      !["category", "explanation"].every(
        (key) => value.refusal![key] === null || typeof value.refusal![key] === "string"
      ))
  )
    throw new ModFunctionError("MODS_TURN_REFUSAL_INVALID")
  if (value.usage !== undefined) usage(value.usage)
}

export function validateFunctionTurnStepInput(value: ModObject): void {
  if (
    typeof value.turnId !== "string" ||
    !value.turnId ||
    value.turnId.length > 1024 ||
    !Number.isSafeInteger(value.index) ||
    Number(value.index) < 0 ||
    !Number.isSafeInteger(value.messageCount) ||
    Number(value.messageCount) < 0 ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    value.model.length > 256 ||
    (value.agentId !== undefined &&
      (typeof value.agentId !== "string" || !value.agentId || value.agentId.length > 256))
  )
    throw new ModFunctionError("MODS_TURN_STEP_INVALID")
}

export function validateFunctionTurnResult(event: string, value: ModJson): void {
  if (event === "turn.start" && (!isModObject(value) || typeof value.turnId !== "string"))
    throw new ModFunctionError("MODS_TURN_START_RESULT")
  if (event === "turn.complete") {
    if (!isModObject(value) || typeof value.text !== "string")
      throw new ModFunctionError("MODS_TURN_COMPLETE_RESULT")
    if (value.usage !== undefined) usage(value.usage)
  }
}
