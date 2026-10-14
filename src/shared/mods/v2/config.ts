import type { ModJson, ModObject } from "../types"
import { ModFunctionError, isModObject, type ModOrigin } from "./contracts"

export type FunctionConfigValue = string | boolean | number | string[]
export type FunctionConfigOrigin =
  | { kind: "composer" }
  | { kind: "bridge" }
  | { kind: "plugin"; name: string }
export type FunctionConfigRow = {
  key: string
  label: string
  description?: string
  kind: "boolean" | "choice" | "text" | "number"
  value: FunctionConfigValue
  options?: string[]
  provider: ModOrigin
  isLocked: boolean
}
export type FunctionConfigSetResult = { value: FunctionConfigValue } | { deny: string }

export function isFunctionConfigValue(value: unknown): value is FunctionConfigValue {
  return (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= 32768) ||
    (Array.isArray(value) &&
      value.length <= 256 &&
      value.every((item) => typeof item === "string" && item.length <= 32768))
  )
}

function validOrigin(value: unknown): boolean {
  if (!isModObject(value)) return false
  if (value.kind === "plugin")
    return (
      typeof value.name === "string" &&
      !!value.name &&
      Object.keys(value).every((key) => key === "kind" || key === "name")
    )
  return (value.kind === "composer" || value.kind === "bridge") && Object.keys(value).length === 1
}

function validProvider(value: unknown): boolean {
  return (
    isModObject(value) &&
    typeof value.plugin === "string" &&
    !!value.plugin &&
    typeof value.tier === "string" &&
    ["core", "prepend", "user", "append", "builtin"].includes(String(value.tier)) &&
    Object.keys(value).every((key) => key === "plugin" || key === "tier")
  )
}

export function validateFunctionConfigSetInput(input: ModObject): void {
  if (
    typeof input.key !== "string" ||
    !input.key ||
    input.key.length > 256 ||
    !isFunctionConfigValue(input.value) ||
    !isFunctionConfigValue(input.previous) ||
    !validProvider(input.provider) ||
    !validOrigin(input.origin) ||
    Object.keys(input).some(
      (key) => !["key", "value", "previous", "provider", "origin"].includes(key)
    )
  )
    throw new ModFunctionError("MODS_CONFIG_SET_INPUT")
}

export function validateFunctionConfigSetResult(value: ModJson): void {
  if (
    !isModObject(value) ||
    Object.keys(value).length !== 1 ||
    !(
      (typeof value.deny === "string" && value.deny.length <= 4096) ||
      isFunctionConfigValue(value.value)
    )
  )
    throw new ModFunctionError("MODS_CONFIG_SET_RESULT")
}

export function validateFunctionConfigDescription(value: ModJson, input = false): void {
  if (
    !isModObject(value) ||
    typeof value.label !== "string" ||
    !value.label.trim() ||
    value.label.length > 256 ||
    typeof value.isHidden !== "boolean" ||
    (value.description !== undefined &&
      (typeof value.description !== "string" || value.description.length > 4096)) ||
    (input &&
      (typeof value.key !== "string" ||
        !value.key ||
        value.key.length > 256 ||
        !validProvider(value.provider))) ||
    Object.keys(value).some(
      (key) =>
        !["label", "description", "isHidden", ...(input ? ["key", "provider"] : [])].includes(key)
    )
  )
    throw new ModFunctionError("MODS_CONFIG_DESCRIBE")
}

export function validateFunctionConfigRows(value: ModJson): void {
  if (!Array.isArray(value) || value.length > 1024)
    throw new ModFunctionError("MODS_CONFIG_LIST_RESULT")
  const keys = new Set<string>()
  for (const row of value) {
    if (
      !isModObject(row) ||
      typeof row.key !== "string" ||
      !row.key ||
      row.key.length > 256 ||
      keys.has(row.key) ||
      typeof row.label !== "string" ||
      !row.label.trim() ||
      row.label.length > 256 ||
      typeof row.kind !== "string" ||
      !["boolean", "choice", "text", "number"].includes(row.kind) ||
      !isFunctionConfigValue(row.value) ||
      !validProvider(row.provider) ||
      typeof row.isLocked !== "boolean" ||
      (row.description !== undefined &&
        (typeof row.description !== "string" || row.description.length > 4096)) ||
      (row.options !== undefined &&
        (!Array.isArray(row.options) ||
          row.options.length > 64 ||
          row.options.some((item) => typeof item !== "string" || !item || item.length > 32768))) ||
      Object.keys(row).some(
        (key) =>
          ![
            "key",
            "label",
            "description",
            "kind",
            "value",
            "options",
            "provider",
            "isLocked"
          ].includes(key)
      )
    )
      throw new ModFunctionError("MODS_CONFIG_LIST_RESULT")
    keys.add(row.key)
  }
}
