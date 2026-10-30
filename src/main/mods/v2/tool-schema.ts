import type { ModJson, ModObject } from "../../../shared/mods/types"
import { encodeModJson } from "../../../shared/mods/validation"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"

const types = ["object", "array", "string", "number", "integer", "boolean", "null"]
const annotations = ["title", "description", "default", "examples", "$comment"]
const counts = ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]
const numbers = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]
const keywords = new Set([
  ...annotations,
  ...counts,
  ...numbers,
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "allOf",
  "oneOf",
  "not",
  "uniqueItems"
])

/** A bounded, non-executable JSON Schema profile. Unsupported keywords fail at registration. */
export function validateToolSchema(schema: ModObject): void {
  if (
    encodeModJson(schema).length > 16000 ||
    (schema.type !== undefined && schema.type !== "object")
  )
    throw new ModFunctionError("MODS_TOOL_SCHEMA")
  let nodes = 0
  const visit = (value: ModJson, depth: number): void => {
    if (++nodes > 256 || depth > 12) throw new ModFunctionError("MODS_TOOL_SCHEMA_LIMIT")
    if (typeof value === "boolean") return
    if (!isModObject(value)) throw new ModFunctionError("MODS_TOOL_SCHEMA")
    for (const key of Object.keys(value))
      if (!keywords.has(key))
        throw new ModFunctionError(
          "MODS_TOOL_SCHEMA_UNSUPPORTED",
          `MODS_TOOL_SCHEMA_UNSUPPORTED: ${key}`
        )
    if (value.type !== undefined) {
      const declared = Array.isArray(value.type) ? value.type : [value.type]
      if (
        !declared.length ||
        declared.some((type) => typeof type !== "string" || !types.includes(type))
      )
        throw new ModFunctionError("MODS_TOOL_SCHEMA")
    }
    if (value.properties !== undefined) {
      if (!isModObject(value.properties)) throw new ModFunctionError("MODS_TOOL_SCHEMA")
      for (const child of Object.values(value.properties)) visit(child, depth + 1)
    }
    if (
      value.required !== undefined &&
      (!Array.isArray(value.required) ||
        value.required.some((key) => typeof key !== "string") ||
        new Set(value.required).size !== value.required.length)
    )
      throw new ModFunctionError("MODS_TOOL_SCHEMA")
    for (const key of ["items", "additionalProperties", "not"])
      if (value[key] !== undefined) visit(value[key], depth + 1)
    for (const key of ["anyOf", "oneOf", "allOf"])
      if (value[key] !== undefined) {
        const children = value[key]
        if (!Array.isArray(children) || !children.length)
          throw new ModFunctionError("MODS_TOOL_SCHEMA")
        for (const child of children) visit(child, depth + 1)
      }
    for (const key of counts)
      if (
        value[key] !== undefined &&
        (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0)
      )
        throw new ModFunctionError("MODS_TOOL_SCHEMA")
    for (const key of numbers)
      if (
        value[key] !== undefined &&
        (typeof value[key] !== "number" ||
          !Number.isFinite(value[key]) ||
          (key === "multipleOf" && value[key] <= 0))
      )
        throw new ModFunctionError("MODS_TOOL_SCHEMA")
    if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length))
      throw new ModFunctionError("MODS_TOOL_SCHEMA")
    if (value.uniqueItems !== undefined && typeof value.uniqueItems !== "boolean")
      throw new ModFunctionError("MODS_TOOL_SCHEMA")
  }
  visit(schema, 0)
  const properties = schema.properties
  if (
    ["tool", "tool_use_id", "agentId"].some(
      (key) =>
        (isModObject(properties) && Object.hasOwn(properties, key)) ||
        (Array.isArray(schema.required) && schema.required.includes(key))
    )
  )
    throw new ModFunctionError("MODS_TOOL_SCHEMA_RESERVED")
}

function equal(a: ModJson, b: ModJson, tick: () => void): boolean {
  tick()
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, index) => equal(value, b[index], tick))
  if (!isModObject(a) || !isModObject(b)) return false
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key], tick))
  )
}

function isMultiple(value: number, divisor: number): boolean {
  // Compare the JSON decimal values exactly; an epsilon accepts small non-multiples of 1.
  const decimal = (number: number): [bigint, number] => {
    const [mantissa, exponent = "0"] = String(number).split("e")
    const fraction = mantissa.split(".")[1]?.length ?? 0
    return [BigInt(mantissa.replace(".", "")), Number(exponent) - fraction]
  }
  const [left, leftPower] = decimal(value)
  const [right, rightPower] = decimal(divisor)
  const power = leftPower - rightPower
  return power >= 0
    ? (left * 10n ** BigInt(power)) % right === 0n
    : left % (right * 10n ** BigInt(-power)) === 0n
}

/** No coercion, defaults, regex, external resolution or unbounded recursive references. */
export function validateRegisteredToolInput(schema: ModObject, input: ModObject): void {
  if (encodeModJson(input).length > 64000) throw new ModFunctionError("MODS_TOOL_INPUT_LIMIT")
  let work = 0
  const tick = () => {
    if (++work > 20000) throw new ModFunctionError("MODS_TOOL_VALIDATION_LIMIT")
  }
  const matches = (s: ModJson, value: ModJson, depth = 0): boolean => {
    tick()
    if (depth > 32) throw new ModFunctionError("MODS_TOOL_VALIDATION_LIMIT")
    if (typeof s === "boolean") return s
    const rule = s as ModObject
    if (rule.type !== undefined) {
      const declared = Array.isArray(rule.type) ? rule.type : [rule.type]
      if (
        !declared.some((type) =>
          type === "null"
            ? value === null
            : type === "object"
              ? isModObject(value)
              : type === "array"
                ? Array.isArray(value)
                : type === "integer"
                  ? typeof value === "number" && Number.isInteger(value)
                  : typeof value === type
        )
      )
        return false
    }
    if (Object.hasOwn(rule, "const") && !equal(value, rule.const, tick)) return false
    if (Array.isArray(rule.enum) && !rule.enum.some((choice) => equal(value, choice, tick)))
      return false
    if (Array.isArray(rule.allOf) && !rule.allOf.every((child) => matches(child, value, depth + 1)))
      return false
    if (Array.isArray(rule.anyOf) && !rule.anyOf.some((child) => matches(child, value, depth + 1)))
      return false
    if (
      Array.isArray(rule.oneOf) &&
      rule.oneOf.filter((child) => matches(child, value, depth + 1)).length !== 1
    )
      return false
    if (rule.not !== undefined && matches(rule.not, value, depth + 1)) return false
    const bounded = (n: number, min: string, max: string) =>
      (typeof rule[min] !== "number" || n >= rule[min]) &&
      (typeof rule[max] !== "number" || n <= rule[max])
    if (typeof value === "string" && !bounded([...value].length, "minLength", "maxLength"))
      return false
    if (typeof value === "number") {
      if (
        !bounded(value, "minimum", "maximum") ||
        (typeof rule.exclusiveMinimum === "number" && value <= rule.exclusiveMinimum) ||
        (typeof rule.exclusiveMaximum === "number" && value >= rule.exclusiveMaximum)
      )
        return false
      if (typeof rule.multipleOf === "number") {
        if (!isMultiple(value, rule.multipleOf)) return false
      }
    }
    if (Array.isArray(value)) {
      if (!bounded(value.length, "minItems", "maxItems")) return false
      if (rule.items !== undefined && !value.every((item) => matches(rule.items, item, depth + 1)))
        return false
      if (rule.uniqueItems === true)
        for (let i = 0; i < value.length; i++)
          for (let j = 0; j < i; j++) {
            if (equal(value[i], value[j], tick)) return false
          }
    }
    if (isModObject(value)) {
      if (!bounded(Object.keys(value).length, "minProperties", "maxProperties")) return false
      if (
        Array.isArray(rule.required) &&
        rule.required.some((key) => !Object.hasOwn(value, key as string))
      )
        return false
      const properties = isModObject(rule.properties) ? rule.properties : {}
      for (const [key, entry] of Object.entries(value)) {
        const child = Object.hasOwn(properties, key) ? properties[key] : rule.additionalProperties
        if (child !== undefined && !matches(child, entry, depth + 1)) return false
      }
    }
    return true
  }
  if (!matches(schema, input)) throw new ModFunctionError("MODS_REGISTERED_TOOL_INPUT")
}
