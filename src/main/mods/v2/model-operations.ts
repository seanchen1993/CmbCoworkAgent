import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

export interface FunctionModelClassifyRequest {
  text: string
  labels: string[]
  model: string
  maxTokens?: number
}

export interface FunctionModelForkRequest {
  prompt: string
  maxTokens?: number
}

/** A sanitized host snapshot; provider messages, tool definitions and credentials never enter it. */
export interface FunctionModelForkSnapshot {
  messages: readonly { role: "system" | "user" | "assistant"; text: string }[]
  /** Optional host policy supplied separately from the captured transcript. */
  system?: string
  model: string
  assertLive?(): void
  release?(): void
}

export interface FunctionModelUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface FunctionModelForkReply {
  text: string
  usage?: FunctionModelUsage
}

function modelName(value: unknown, field: string): string {
  if (value === undefined) return "default"
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw new ModFunctionError("MODS_MODEL_ARGUMENTS", `${field} must be a bounded model name`)
  return value
}

function maxTokens(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 4096)
    throw new ModFunctionError("MODS_MODEL_ARGUMENTS", "maxTokens must be between 1 and 4096")
  return value
}

/** Validate the object passed through the model.classify capability boundary. */
export function functionModelClassifyRequest(input: ModObject): FunctionModelClassifyRequest {
  if (
    Object.keys(input).some(
      (key) => !["text", "labels", "options", "model", "maxTokens"].includes(key)
    )
  )
    throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
  if (typeof input.text !== "string" || input.text.length > 32000)
    throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
  if (
    !Array.isArray(input.labels) ||
    input.labels.length < 2 ||
    input.labels.length > 64 ||
    input.labels.some((label) => typeof label !== "string" || !label.trim() || label.length > 256)
  )
    throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
  const labels = [...input.labels] as string[]
  if (new Set(labels).size !== labels.length) throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
  const options = input.options
  if (
    options !== undefined &&
    (options === null ||
      Array.isArray(options) ||
      typeof options !== "object" ||
      Object.keys(options).some((key) => !["model", "maxTokens"].includes(key)))
  )
    throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
  const optionModel =
    options && typeof options === "object" ? (options as ModObject).model : undefined
  const optionTokens =
    options && typeof options === "object" ? (options as ModObject).maxTokens : undefined
  const tokens = maxTokens(input.maxTokens ?? optionTokens)
  return {
    text: input.text,
    labels,
    model: modelName(input.model ?? optionModel, "model"),
    ...(tokens === undefined ? {} : { maxTokens: tokens })
  }
}

/** Validate the object passed through the model.fork capability boundary. */
export function functionModelForkRequest(input: ModObject): FunctionModelForkRequest {
  if (Object.keys(input).some((key) => !["prompt", "maxTokens"].includes(key)))
    throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
  if (typeof input.prompt !== "string" || !input.prompt.length || input.prompt.length > 32000)
    throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
  const tokens = maxTokens(input.maxTokens)
  return {
    prompt: input.prompt,
    ...(tokens === undefined ? {} : { maxTokens: tokens })
  }
}

export function classifyLabel(text: string, labels: readonly string[]): string | undefined {
  if (!text.trim()) throw new ModFunctionError("MODS_MODEL_EMPTY")
  const candidate = text.trim().replace(/^['"`]|['"`]$/g, "")
  return labels.find((label) => label === candidate)
}
