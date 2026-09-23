import type { ModJson, ModObject } from "../types"
import { isModObject, ModFunctionError } from "./contracts"

export type FunctionFeedbackMethod = "ui.toast" | "ui.status"
export interface FunctionFeedbackEntry {
  id: string
  plugin: string
  kind: "toast" | "status" | "notice"
  text: string
  expiresAt?: number
  requestId?: string
  toolUseId?: string
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

/** Publication may redact/remove a line, never change its dialog binding or attribution. */
export function functionFeedbackSnapshot(
  value: ModJson,
  original: FunctionFeedbackEntry[]
): FunctionFeedbackEntry[] {
  if (!Array.isArray(value) || value.length > original.length)
    throw new ModFunctionError("MODS_UI_FEEDBACK_SNAPSHOT")
  const rows = new Map<string, string>()
  const fixed = ["id", "plugin", "kind", "expiresAt", "requestId", "toolUseId"] as const
  for (const row of value) {
    const before = isModObject(row) ? original.find((entry) => entry.id === row.id) : undefined
    if (
      !isModObject(row) ||
      !before ||
      typeof row.id !== "string" ||
      rows.has(row.id) ||
      typeof row.text !== "string" ||
      row.text.length > 10000 ||
      Object.keys(row).some((key) => ![...fixed, "text"].includes(key)) ||
      fixed.some((key) => row[key] !== before[key])
    )
      throw new ModFunctionError("MODS_UI_FEEDBACK_SNAPSHOT")
    rows.set(row.id, row.text)
  }
  return original
    .filter((row) => rows.has(row.id))
    .map((row) => ({ ...row, text: rows.get(row.id)! }))
}
