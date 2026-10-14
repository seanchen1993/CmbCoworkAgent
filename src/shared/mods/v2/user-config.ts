import type { ModObject } from "../types"
import { encodeModJson } from "../validation"
import { ModFunctionError, isModObject } from "./contracts"
import type { FunctionConfigValue } from "./config"

export type FunctionUserConfigField = {
  type: "string" | "number" | "boolean" | "directory" | "file"
  title: string
  description: string
  required?: boolean
  default?: FunctionConfigValue
  options?: string[]
  multiple?: boolean
  sensitive?: boolean
  min?: number
  max?: number
}
export type FunctionUserConfig = Record<string, FunctionUserConfigField>
const fieldKeys = new Set([
  "type",
  "title",
  "description",
  "required",
  "default",
  "options",
  "multiple",
  "sensitive",
  "min",
  "max"
])

function failure(key: string): never {
  // A field name may be diagnostic data; never include its stored/default value.
  throw new ModFunctionError(
    "MODS_USER_CONFIG_INVALID",
    `Invalid plugin configuration field: ${key}`
  )
}

export function validateFunctionUserConfigValue(
  key: string,
  field: FunctionUserConfigField,
  value: unknown
): asserts value is FunctionConfigValue {
  if (value === "") {
    if (field.required) failure(key)
    return
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") failure(key)
  } else if (field.type === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (field.min !== undefined && value < field.min) ||
      (field.max !== undefined && value > field.max)
    )
      failure(key)
  } else if (field.type === "string" && field.multiple && Array.isArray(value)) {
    if (value.length > 256 || value.some((item) => typeof item !== "string" || item.length > 32768))
      failure(key)
  } else if (
    typeof value !== "string" ||
    value.length > 32768 ||
    (field.options && !field.options.includes(value))
  )
    failure(key)
}

/** Immutable schema only: missing required values are checked before actual module loading. */
export function parseFunctionUserConfig(value: unknown): FunctionUserConfig | undefined {
  if (value === undefined) return undefined
  let bytes: number
  try {
    bytes = new TextEncoder().encode(encodeModJson(value)).length
  } catch {
    failure("manifest")
  }
  if (!isModObject(value) || Object.keys(value).length > 64 || bytes > 64 * 1024)
    failure("manifest")
  const entries = Object.entries(value).map(([key, item]) => {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
      !isModObject(item) ||
      Object.keys(item).some((name) => !fieldKeys.has(name)) ||
      typeof item.type !== "string" ||
      !["string", "number", "boolean", "directory", "file"].includes(String(item.type)) ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      item.title.length > 256 ||
      typeof item.description !== "string" ||
      item.description.length > 4096
    )
      failure(key)
    for (const flag of ["required", "multiple", "sensitive"])
      if (item[flag] !== undefined && typeof item[flag] !== "boolean") failure(key)
    if (item.multiple === true && item.type !== "string") failure(key)
    if (item.min !== undefined || item.max !== undefined) {
      if (
        item.type !== "number" ||
        (item.min !== undefined && (typeof item.min !== "number" || !Number.isFinite(item.min))) ||
        (item.max !== undefined && (typeof item.max !== "number" || !Number.isFinite(item.max))) ||
        (typeof item.min === "number" && typeof item.max === "number" && item.min > item.max)
      )
        failure(key)
    }
    if (
      item.options !== undefined &&
      (item.type !== "string" ||
        item.multiple ||
        item.sensitive ||
        !Array.isArray(item.options) ||
        !item.options.length ||
        item.options.length > 64 ||
        item.options.some(
          (option) => typeof option !== "string" || !option.length || option.length > 64
        ) ||
        new Set(item.options).size !== item.options.length)
    )
      failure(key)
    if (
      Array.isArray(item.options) &&
      (Object.hasOwn(item, "default")
        ? typeof item.default !== "string" || !item.options.includes(item.default)
        : item.required !== true)
    )
      failure(key)
    const field = structuredClone(item) as unknown as FunctionUserConfigField
    if (Object.hasOwn(item, "default")) validateFunctionUserConfigValue(key, field, item.default)
    return [key, field] as const
  })
  return Object.fromEntries(entries)
}

/** Optional unset is empty text, including booleans/numbers; false and zero remain valid. */
export function resolveFunctionUserConfig(schema: FunctionUserConfig, stored: unknown): ModObject {
  if (!isModObject(stored)) failure("stored-options")
  try {
    encodeModJson(stored)
  } catch {
    failure("stored-options")
  }
  const entries = Object.entries(schema).map(([key, field]) => {
    let value: unknown = Object.hasOwn(stored, key) ? stored[key] : undefined
    if (
      field.options &&
      value !== undefined &&
      (typeof value !== "string" || !field.options.includes(value))
    )
      value = undefined
    if (value === undefined) value = field.default ?? (field.required ? undefined : "")
    validateFunctionUserConfigValue(key, field, value)
    return [key, structuredClone(value)] as const
  })
  const result = Object.fromEntries(entries) as ModObject
  if (new TextEncoder().encode(encodeModJson(result)).length > 256 * 1024) failure("options-size")
  return result
}

export function ordinaryFunctionUserConfig(field: FunctionUserConfigField): boolean {
  return !field.sensitive && !field.multiple
}

/** Native parameter forms also edit lists, which never become ordinary config rows. */
export function writableFunctionUserConfig(field: FunctionUserConfigField): boolean {
  return !field.sensitive
}
