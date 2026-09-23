import type { ModJson, ModObject } from "../types"
import { isModObject, ModFunctionError } from "./contracts"

export interface FunctionLogEntry {
  id: string
  plugin: string
  text: string
}

export function validateFunctionLog(input: ModObject): void {
  if (
    Object.keys(input).some((key) => !["text", "to"].includes(key)) ||
    typeof input.text !== "string" ||
    input.text.length > 10000 ||
    !["transcript", "debug"].includes(String(input.to))
  )
    throw new ModFunctionError("MODS_UI_LOG_ARGUMENTS")
}

/** Publication may redact or remove text, but must not invent rows or their attribution. */
export function functionLogSnapshot(
  value: ModJson,
  original: FunctionLogEntry[]
): FunctionLogEntry[] {
  if (!Array.isArray(value) || value.length > original.length)
    throw new ModFunctionError("MODS_UI_LOG_SNAPSHOT")
  const rows = new Map<string, string>()
  for (const row of value) {
    if (
      !isModObject(row) ||
      typeof row.id !== "string" ||
      rows.has(row.id) ||
      typeof row.text !== "string" ||
      row.text.length > 10000 ||
      Object.keys(row).some((key) => !["id", "plugin", "text"].includes(key)) ||
      !original.some((entry) => entry.id === row.id && entry.plugin === row.plugin)
    )
      throw new ModFunctionError("MODS_UI_LOG_SNAPSHOT")
    rows.set(row.id, row.text)
  }
  return original
    .filter((row) => rows.has(row.id))
    .map((row) => ({ ...row, text: rows.get(row.id)! }))
}
