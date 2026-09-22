import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

export interface FunctionModelRequest {
  model: string
  prompt: string
  system?: string
  maxTokens?: number
}

export interface FunctionModelReply {
  text: string
  inputTokens?: number
  outputTokens?: number
}

/** Only model selection and text are guest inputs; endpoints and credentials belong to the host. */
export function functionModelRequest(input: ModObject): FunctionModelRequest {
  if (
    Object.keys(input).some((key) => !["model", "prompt", "system", "maxTokens"].includes(key)) ||
    typeof input.model !== "string" ||
    !input.model.trim() ||
    input.model.length > 256 ||
    typeof input.prompt !== "string" ||
    input.prompt.length > 32000 ||
    (input.system !== undefined &&
      (typeof input.system !== "string" || input.system.length > 8000)) ||
    (input.maxTokens !== undefined &&
      (typeof input.maxTokens !== "number" ||
        !Number.isSafeInteger(input.maxTokens) ||
        input.maxTokens < 1 ||
        input.maxTokens > 4096))
  )
    throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
  return {
    model: input.model,
    prompt: input.prompt,
    ...(typeof input.system === "string" ? { system: input.system } : {}),
    ...(typeof input.maxTokens === "number" ? { maxTokens: input.maxTokens } : {})
  }
}

export function validateFunctionModelText(value: unknown): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 64000)
    throw new ModFunctionError("MODS_MODEL_RESULT_LIMIT")
}
