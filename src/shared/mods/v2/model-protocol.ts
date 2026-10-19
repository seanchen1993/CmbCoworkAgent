import { isModObject, ModFunctionError } from "./contracts"

export type FunctionModelProtocol = "legacy-v1" | "result-v1"
export const MODEL_API_ERRORS = [
  "rate_limit",
  "overloaded",
  "invalid_request",
  "authentication_failed",
  "server_error",
  "unknown"
] as const
export type FunctionModelApiError = (typeof MODEL_API_ERRORS)[number]
export type FunctionModelUsageResult = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}
export type FunctionModelResult =
  | { isAnswered: true; text: string; usage: FunctionModelUsageResult }
  | { isAnswered: false; reason: "empty-reply" | "aborted"; usage: FunctionModelUsageResult }
  | {
      isAnswered: false
      reason: "api-error"
      status: number | null
      error: FunctionModelApiError
      usage: FunctionModelUsageResult
    }
export type FunctionForkResult =
  | FunctionModelResult
  | { isAnswered: false; reason: "nothing-to-fork" }

export function parseFunctionModelProtocol(value: unknown): FunctionModelProtocol {
  if (value === undefined) return "result-v1"
  if (
    !isModObject(value) ||
    Object.keys(value).some((key) => !["modelProtocol", "userConfigMigrations"].includes(key)) ||
    (value.userConfigMigrations !== undefined && value.userConfigMigrations !== "v1") ||
    (value.modelProtocol !== "legacy-v1" && value.modelProtocol !== "result-v1")
  )
    throw new ModFunctionError("MODS_MODEL_PROTOCOL_MANIFEST")
  return value.modelProtocol as FunctionModelProtocol
}

/** Validates every observer boundary; no provider error text is part of this protocol. */
export function validateFunctionModelResult(value: unknown, fork = false): void {
  const fail = () => {
    throw new ModFunctionError("MODS_MODEL_RESULT_LIMIT")
  }
  if (!isModObject(value)) return fail()
  let fields: string[]
  if (value.isAnswered === true) {
    fields = ["isAnswered", "text", "usage"]
    if (
      typeof value.text !== "string" ||
      !value.text.length ||
      new TextEncoder().encode(value.text).length > 64000
    )
      return fail()
  } else if (value.isAnswered === false) {
    if (value.reason === "nothing-to-fork" && fork) {
      if (Object.keys(value).some((key) => !["isAnswered", "reason"].includes(key))) fail()
      return
    }
    fields = ["isAnswered", "reason", "usage"]
    if (value.reason === "api-error") {
      fields.push("status", "error")
      if (
        value.status !== null &&
        (!Number.isSafeInteger(value.status) ||
          Number(value.status) < 100 ||
          Number(value.status) > 599)
      )
        return fail()
      if (!MODEL_API_ERRORS.includes(value.error as FunctionModelApiError)) return fail()
    } else if (value.reason !== "empty-reply" && value.reason !== "aborted") return fail()
  } else return fail()
  if (Object.keys(value).some((key) => !fields.includes(key))) return fail()
  const usage = value.usage
  const keys = [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens"
  ]
  if (
    !isModObject(usage) ||
    Object.keys(usage).length !== 4 ||
    keys.some((key) => !Number.isSafeInteger(usage[key]) || Number(usage[key]) < 0)
  )
    fail()
}
