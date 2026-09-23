import type { ModObject } from "../types"
import { ModFunctionError } from "./contracts"

export type FunctionFeedbackMethod = "ui.toast" | "ui.status"
export interface FunctionFeedbackEntry {
  id: string
  plugin: string
  kind: "toast" | "status"
  text: string
  expiresAt?: number
}

export function validateFunctionFeedback(method: FunctionFeedbackMethod, input: ModObject): void {
  const keys = method === "ui.toast" ? ["text", "timeoutMs"] : ["text"]
  if (
    Object.keys(input).some((key) => !keys.includes(key)) ||
    (input.text === undefined
      ? method !== "ui.status"
      : typeof input.text !== "string" || input.text.length > 10000) ||
    (input.timeoutMs !== undefined &&
      (typeof input.timeoutMs !== "number" ||
        !Number.isSafeInteger(input.timeoutMs) ||
        input.timeoutMs < 0 ||
        input.timeoutMs > 60000))
  )
    throw new ModFunctionError("MODS_UI_FEEDBACK_ARGUMENTS")
}
