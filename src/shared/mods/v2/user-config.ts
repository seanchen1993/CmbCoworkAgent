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
const allowedFieldKeys = [
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
] as const
const fieldKeys = new Set<string>(allowedFieldKeys)
const declarationReasons = {
  "invalid-json": "Use plain finite JSON without unsafe keys, prototypes, accessors or cycles.",
  "expected-object": "Declare userConfig as an object of field declarations.",
  "schema-limit": "Keep userConfig within 64 fields and 64 KiB of encoded JSON.",
  "invalid-field-name": "Use an ASCII identifier of 1 to 128 characters for each field name.",
  "expected-field-object": "Declare the field as an object.",
  "unsupported-key": "Remove unsupported field properties; numeric bounds use min and max.",
  "invalid-type": "Use string, number, boolean, directory or file as the field type.",
  "invalid-title": "Provide a nonblank title of at most 256 characters.",
  "invalid-description": "Provide description as a string of at most 4096 characters.",
  "invalid-flag": "Use a boolean for required, multiple and sensitive when declared.",
  "invalid-multiple": "Use multiple only for string fields.",
  "invalid-bounds": "Use finite min and max only for number fields, with min no greater than max.",
  "invalid-options":
    "Use 1 to 64 distinct nonempty strings of at most 64 characters as options, only for a non-sensitive single string field.",
  "choice-requires-default-or-required":
    "Give an options field a matching default or set required to true.",
  "invalid-default":
    "Use a default matching the field type, required flag, options and numeric bounds."
} as const
type FunctionUserConfigDeclarationReason = keyof typeof declarationReasons
type FunctionUserConfigProperty = (typeof allowedFieldKeys)[number]
type FunctionUserConfigDeclarationDiagnostic = Readonly<{
  /** JSON Pointer relative to userConfig; unsafe field names are never reflected. */
  path: string
  reason: FunctionUserConfigDeclarationReason
  message: string
  allowedKeys?: readonly FunctionUserConfigProperty[]
}>

/** Only native declaration failures carry safe repair metadata; stored values retain their errors. */
export class FunctionUserConfigDeclarationError extends ModFunctionError {
  readonly diagnostic: FunctionUserConfigDeclarationDiagnostic

  constructor(
    reason: FunctionUserConfigDeclarationReason,
    key?: string,
    property?: FunctionUserConfigProperty
  ) {
    const safeKey =
      key !== undefined &&
      /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) &&
      !["__proto__", "prototype", "constructor"].includes(key)
        ? key
        : undefined
    super(
      "MODS_USER_CONFIG_INVALID",
      `Invalid plugin configuration field: ${safeKey ?? "manifest"}`
    )
    this.diagnostic = Object.freeze({
      path: safeKey ? `/${safeKey}${property ? `/${property}` : ""}` : "",
      reason,
      message: declarationReasons[reason],
      ...(reason === "unsupported-key" ? { allowedKeys: Object.freeze([...allowedFieldKeys]) } : {})
    })
    Object.defineProperty(this, "diagnostic", { writable: false, configurable: false })
  }
}

function declarationFailure(
  reason: FunctionUserConfigDeclarationReason,
  key?: string,
  property?: FunctionUserConfigProperty
): never {
  throw new FunctionUserConfigDeclarationError(reason, key, property)
}

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
    declarationFailure("invalid-json")
  }
  if (!isModObject(value)) declarationFailure("expected-object")
  if (Object.keys(value).length > 64 || bytes > 64 * 1024) declarationFailure("schema-limit")
  const entries = Object.entries(value).map(([key, item]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) declarationFailure("invalid-field-name")
    if (!isModObject(item)) declarationFailure("expected-field-object", key)
    if (Object.keys(item).some((name) => !fieldKeys.has(name)))
      declarationFailure("unsupported-key", key)
    if (
      typeof item.type !== "string" ||
      !["string", "number", "boolean", "directory", "file"].includes(String(item.type))
    )
      declarationFailure("invalid-type", key, "type")
    if (typeof item.title !== "string" || !item.title.trim() || item.title.length > 256)
      declarationFailure("invalid-title", key, "title")
    if (typeof item.description !== "string" || item.description.length > 4096)
      declarationFailure("invalid-description", key, "description")
    for (const flag of ["required", "multiple", "sensitive"] as const)
      if (item[flag] !== undefined && typeof item[flag] !== "boolean")
        declarationFailure("invalid-flag", key, flag)
    if (item.multiple === true && item.type !== "string")
      declarationFailure("invalid-multiple", key, "multiple")
    if (item.min !== undefined || item.max !== undefined) {
      if (
        item.type !== "number" ||
        (item.min !== undefined && (typeof item.min !== "number" || !Number.isFinite(item.min))) ||
        (item.max !== undefined && (typeof item.max !== "number" || !Number.isFinite(item.max))) ||
        (typeof item.min === "number" && typeof item.max === "number" && item.min > item.max)
      )
        declarationFailure("invalid-bounds", key)
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
      declarationFailure("invalid-options", key, "options")
    if (
      Array.isArray(item.options) &&
      (Object.hasOwn(item, "default")
        ? typeof item.default !== "string" || !item.options.includes(item.default)
        : item.required !== true)
    )
      declarationFailure(
        Object.hasOwn(item, "default") ? "invalid-default" : "choice-requires-default-or-required",
        key,
        Object.hasOwn(item, "default") ? "default" : "options"
      )
    const field = structuredClone(item) as unknown as FunctionUserConfigField
    if (Object.hasOwn(item, "default")) {
      try {
        validateFunctionUserConfigValue(key, field, item.default)
      } catch {
        declarationFailure("invalid-default", key, "default")
      }
    }
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
