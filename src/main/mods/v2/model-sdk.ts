import type {
  FunctionModelProtocol,
  FunctionModelApiError,
  FunctionModelResult,
  FunctionModelUsageResult
} from "../../../shared/mods/v2/model-protocol"
import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

export interface FunctionModelRequest {
  model: string
  prompt: string
  system?: string
  maxTokens?: number
  timeoutMs?: number
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
}

export interface FunctionModelReply {
  text: string
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  /** Host-only, normalized API usage; accounting still uses total inputTokens above. */
  uncachedInputTokens?: number
  failure?:
    | { reason: "api-error"; status: number | null; error: FunctionModelApiError }
    | { reason: "aborted" }
}

export function assertFunctionModelEffort(model: string, effort?: FunctionModelRequest["effort"]): void {
  if (effort !== undefined && (!/deepseek/i.test(model) || !["low", "high", "max"].includes(effort)))
    throw new ModFunctionError("MODS_MODEL_EFFORT_UNSUPPORTED")
}

/** Only model selection and text are guest inputs; endpoints and credentials belong to the host. */
export function functionModelRequest(
  input: ModObject,
  protocol: FunctionModelProtocol = "legacy-v1"
): FunctionModelRequest {
  if (
    input.effort !== undefined &&
    !["low", "medium", "high", "xhigh", "max"].includes(input.effort as string)
  )
    throw new ModFunctionError("MODS_MODEL_EFFORT_UNSUPPORTED")
  if (
    input.timeoutMs !== undefined &&
    (protocol !== "result-v1" ||
      !Number.isSafeInteger(input.timeoutMs) ||
      Number(input.timeoutMs) < 1 ||
      Number(input.timeoutMs) > 2147483647)
  )
    throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "model",
          "prompt",
          "system",
          "maxTokens",
          "effort",
          ...(protocol === "result-v1" ? ["timeoutMs"] : [])
        ].includes(key)
    ) ||
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
    ...(input.effort === undefined
      ? {}
      : { effort: input.effort as FunctionModelRequest["effort"] }),
    ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
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

/** Only constructed inside the real provider boundary, never from host policy errors. */
export class FunctionModelProviderFailure extends Error {
  constructor(readonly failure: NonNullable<FunctionModelReply["failure"]>) {
    super("MODS_MODEL_PROVIDER_FAILURE")
  }
}

export function functionModelUsage(reply: FunctionModelReply): FunctionModelUsageResult {
  return {
    input_tokens: reply.uncachedInputTokens ?? reply.inputTokens ?? 0,
    output_tokens: reply.outputTokens ?? 0,
    cache_read_input_tokens: reply.cacheReadInputTokens ?? 0,
    cache_creation_input_tokens: reply.cacheCreationInputTokens ?? 0
  }
}

export function functionModelResult(reply: FunctionModelReply): FunctionModelResult {
  const usage = functionModelUsage(reply)
  if (reply.failure) return { isAnswered: false, ...reply.failure, usage }
  return reply.text.length
    ? { isAnswered: true, text: reply.text, usage }
    : { isAnswered: false, reason: "empty-reply", usage }
}
