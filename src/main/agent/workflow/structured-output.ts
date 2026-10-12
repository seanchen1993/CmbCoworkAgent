import { DynamicStructuredTool, ToolInputParsingException } from "@langchain/core/tools"
import { NodeInterrupt } from "@langchain/langgraph"
import { validateJsonSchemaValue } from "./json-schema"
import { WORKFLOW_STRUCTURED_OUTPUT_MAX_ATTEMPTS } from "./types"
import { STRUCTURED_OUTPUT_FATAL_ERROR } from "./structured-output-error"

/** Shared verbatim structured-output normalization, schema validation and bounded
 * repair policy. Desktop and Bot subagents use this same tool implementation. */
const STRUCTURED_OUTPUT_RECORDED_MESSAGE =
  "Structured output recorded successfully. End your turn now — no further text is needed."
const STRUCTURED_OUTPUT_SIGNATURE_MAX_CHARS = 8_192
const STRUCTURED_OUTPUT_HINT_JSON_MAX_CHARS = 200
const STRUCTURED_OUTPUT_HINT_PARSE_MAX_CHARS = 20_000
const STRUCTURED_OUTPUT_HINT_MAX_NODES = 512
const STRUCTURED_OUTPUT_EXAMPLE_ARRAY_MAX_ITEMS = 16
const STRUCTURED_OUTPUT_EXAMPLE_MAX_NODES = 256
const STRUCTURED_OUTPUT_EXAMPLE_MAX_CHARS = 4_000
const STRUCTURED_OUTPUT_STRINGIFY_MAX_OBJECT_KEYS = 256
const STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE = Symbol("structured_output_example_unavailable")
const STRUCTURED_OUTPUT_NO_SINGLE_VALUE = Symbol("structured_output_no_single_value")
const PROVIDER_SCHEMA_DROPPED_ANNOTATIONS = new Set([
  "default",
  "examples",
  "format",
  "$schema",
  "$id",
  "$comment",
  "readOnly",
  "writeOnly",
  "deprecated"
])

interface StructuredOutputLogContext {
  runId: string
  agentIndex: number
  label: string
  attempt: number
  threadId: string
}

export function structuredOutputFailureError(message: string): Error {
  // ToolNode converts ordinary tool throws into ToolMessage(status:"error").
  // NodeInterrupt is a GraphInterrupt, so both ToolNode and our runtime error
  // middleware bubble it instead of feeding another retry prompt to the model.
  const error = new NodeInterrupt(message)
  Object.defineProperty(error, STRUCTURED_OUTPUT_FATAL_ERROR, { value: true })
  return error
}

function logStructuredOutputEvent(
  context: StructuredOutputLogContext | undefined,
  event: string,
  details: Record<string, unknown> = {},
  level: "info" | "warn" = "info"
): void {
  if (!context) return
  if (level === "info" && process.env.CMB_WORKFLOW_STRUCTURED_OUTPUT_DEBUG !== "1") return
  const firstError =
    typeof details.firstError === "string" ? details.firstError.slice(0, 300) : details.firstError
  const payload = {
    event,
    runId: context.runId,
    agentIndex: context.agentIndex,
    label: context.label,
    attempt: context.attempt,
    threadId: context.threadId,
    ...details,
    ...(firstError === undefined ? {} : { firstError })
  }
  console[level]("[Workflow][structured_output]", payload)
}

export function createStructuredOutputTool(
  schema: Record<string, unknown>,
  capture: { value: unknown; called: boolean },
  logContext?: StructuredOutputLogContext
): DynamicStructuredTool {
  let attempts = 0
  let lastInvalidSignature: string | undefined
  let repeatedInvalidAttempts = 0
  const toolInputSchema = structuredOutputToolInputSchema(schema)
  const recordValidOutput = (candidate: unknown): string => {
    capture.called = true
    if (
      capture.value !== undefined &&
      validateJsonSchemaValue(schema, capture.value).length === 0
    ) {
      logStructuredOutputEvent(logContext, "valid-after-success-ignored", {
        toolAttempt: attempts + 1
      })
      return STRUCTURED_OUTPUT_RECORDED_MESSAGE
    }
    capture.value = candidate
    logStructuredOutputEvent(logContext, "succeeded", { toolAttempt: attempts + 1 })
    return STRUCTURED_OUTPUT_RECORDED_MESSAGE
  }
  const registerInvalidAttempt = (input: unknown, errors: string[]): string => {
    if (
      capture.value !== undefined &&
      validateJsonSchemaValue(schema, capture.value).length === 0
    ) {
      capture.called = true
      logStructuredOutputEvent(logContext, "invalid-after-success-ignored", {
        toolAttempt: attempts + 1,
        errorCount: errors.length
      })
      return STRUCTURED_OUTPUT_RECORDED_MESSAGE
    }
    attempts += 1
    capture.called = true
    const modelErrors = buildStructuredOutputRepairErrors(schema, input, errors)
    const inputSignature = stableStringifyWithMetadata(input)
    const invalidSignature = inputSignature.truncated
      ? undefined
      : `${inputSignature.value}\n${modelErrors.join("\n")}`
    if (invalidSignature === undefined) {
      repeatedInvalidAttempts = 1
      lastInvalidSignature = undefined
    } else {
      repeatedInvalidAttempts =
        invalidSignature === lastInvalidSignature ? repeatedInvalidAttempts + 1 : 1
      lastInvalidSignature = invalidSignature
    }
    logStructuredOutputEvent(
      logContext,
      "invalid",
      {
        toolAttempt: attempts,
        repeatedInvalidAttempts,
        errorCount: modelErrors.length,
        firstError: modelErrors[0]
      },
      "warn"
    )
    if (attempts >= WORKFLOW_STRUCTURED_OUTPUT_MAX_ATTEMPTS) {
      logStructuredOutputEvent(
        logContext,
        "fatal-max-attempts",
        {
          toolAttempt: attempts,
          errorCount: modelErrors.length,
          firstError: modelErrors[0]
        },
        "warn"
      )
      throw structuredOutputFailureError(
        `structured_output schema validation failed after ${attempts} attempts:\n${modelErrors.join("\n")}`
      )
    }
    if (repeatedInvalidAttempts >= 3) {
      logStructuredOutputEvent(
        logContext,
        "fatal-identical-attempts",
        {
          toolAttempt: attempts,
          repeatedInvalidAttempts,
          errorCount: modelErrors.length,
          firstError: modelErrors[0]
        },
        "warn"
      )
      throw structuredOutputFailureError(
        `structured_output schema validation failed after ${repeatedInvalidAttempts} identical invalid attempts:\n${modelErrors.join("\n")}`
      )
    }
    return `StructuredOutput schema mismatch:\n${modelErrors.join("\n")}\nRead the errors and call structured_output again with a corrected input.`
  }
  const structuredTool = new DynamicStructuredTool({
    name: "structured_output",
    description:
      "Return the final machine-readable answer for this task. Call it exactly once with input matching this tool's JSON Schema. Do not stringify arrays or objects; pass them as real JSON values.",
    schema: cloneJsonSchema(toolInputSchema),
    func: async (input: unknown) => {
      capture.called = true
      logStructuredOutputEvent(logContext, "called", {
        toolAttempt: attempts + 1,
        alreadyCaptured: capture.value !== undefined
      })
      // Tool args always arrive as a JSON object. Mid-tier models often wrap
      // the real answer one level deep. Scalar/array/wide schemas prefer the
      // unwrapped value; shaped object schemas also unwrap conventional wrapper
      // keys when that key is not a declared business field.
      const candidates = structuredOutputCandidates(input, schema)
      let errors: string[] | undefined
      for (const candidate of candidates) {
        const candidateErrors = validateJsonSchemaValue(schema, candidate)
        errors = chooseStructuredOutputErrors(input, candidate, schema, errors, candidateErrors)
        if (candidateErrors.length === 0) {
          return recordValidOutput(candidate)
        }
      }
      return registerInvalidAttempt(input, errors ?? [])
    }
  }) as DynamicStructuredTool
  restoreStructuredToolSchema(structuredTool, toolInputSchema)
  const originalInvoke = structuredTool.invoke.bind(structuredTool)
  structuredTool.invoke = async (...args: Parameters<typeof structuredTool.invoke>) => {
    try {
      return await originalInvoke(...args)
    } catch (error) {
      if (!(error instanceof ToolInputParsingException)) throw error
      logStructuredOutputEvent(
        logContext,
        "tool-input-parsing-fallback",
        { toolAttempt: attempts + 1 },
        "warn"
      )
      const rawInput = toolInputFromParsingError(error, args[0])
      const candidates = structuredOutputCandidates(rawInput, schema)
      let errors: string[] | undefined
      for (const candidate of candidates) {
        const candidateErrors = validateJsonSchemaValue(schema, candidate)
        errors = chooseStructuredOutputErrors(rawInput, candidate, schema, errors, candidateErrors)
        if (candidateErrors.length === 0) {
          return recordValidOutput(candidate) as Awaited<ReturnType<typeof structuredTool.invoke>>
        }
      }
      return registerInvalidAttempt(
        rawInput,
        errors && errors.length > 0
          ? errors
          : ["Tool input did not match the required JSON Schema."]
      ) as Awaited<ReturnType<typeof structuredTool.invoke>>
    }
  }
  return structuredTool
}

function cloneJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
}

function restoreStructuredToolSchema(
  tool: DynamicStructuredTool,
  schema: Record<string, unknown>
): void {
  // DynamicStructuredTool's constructor normalizes JSON-schema booleans to `{}`.
  // That is useful for provider-incompatible boolean subschemas, but
  // `additionalProperties:false` is a provider-facing constraint we want models
  // to see. Reattach our normalized schema after construction; local validation
  // still remains the source of truth inside `func`.
  ;(tool as { schema: Record<string, unknown> }).schema = schema
  const kwargs = (tool as { lc_kwargs?: { schema?: unknown } }).lc_kwargs
  if (kwargs) kwargs.schema = schema
}

function chooseStructuredOutputErrors(
  input: unknown,
  candidate: unknown,
  schema: Record<string, unknown>,
  current: string[] | undefined,
  candidateErrors: string[]
): string[] {
  if (shouldPreferUnwrappedErrors(input, candidate, schema)) return candidateErrors
  if (shouldPreferSemanticSingleValueErrors(input, candidate, schema)) return candidateErrors
  return current ?? candidateErrors
}

function shouldPreferUnwrappedErrors(
  input: unknown,
  candidate: unknown,
  schema: Record<string, unknown>
): boolean {
  if (candidate === input) return false
  if (!schemaRootIsObject(schema)) return false
  if (!isPlainRecord(input)) return false
  const single = singleOwnEntry(input)
  return (
    single !== null &&
    isStructuredOutputWrapperKey(single.key) &&
    !rootSchemaCoversProperty(schema, single.key)
  )
}

function rootSchemaCoversProperty(schema: Record<string, unknown>, key: string): boolean {
  if (
    isPlainRecord(schema.properties) &&
    Object.prototype.hasOwnProperty.call(schema.properties, key)
  ) {
    return true
  }
  if (schema.additionalProperties === true || isPlainRecord(schema.additionalProperties))
    return true
  return rootSchemaVariants(schema).some((variant) => rootSchemaCoversProperty(variant, key))
}

function rootSchemaDeclaresProperty(schema: Record<string, unknown>, key: string): boolean {
  if (
    isPlainRecord(schema.properties) &&
    Object.prototype.hasOwnProperty.call(schema.properties, key)
  ) {
    return true
  }
  return rootSchemaVariants(schema).some((variant) => rootSchemaDeclaresProperty(variant, key))
}

function rootSchemaHasObjectShape(schema: Record<string, unknown>): boolean {
  const propertyCount = isPlainRecord(schema.properties) ? Object.keys(schema.properties).length : 0
  const requiredCount = Array.isArray(schema.required) ? schema.required.length : 0
  return propertyCount > 0 || requiredCount > 0
}

function shouldPreferSemanticSingleValueErrors(
  input: unknown,
  candidate: unknown,
  schema: Record<string, unknown>
): boolean {
  if (schemaRootIsObject(schema)) return false
  if (!isPlainRecord(input)) return false
  const single = singleOwnEntry(input)
  return single !== null && single.value === candidate
}

function structuredOutputCandidates(input: unknown, schema: Record<string, unknown>): unknown[] {
  const unwrapped = unwrapToolInput(input)
  if (shouldTreatAsAccidentalObjectWrapper(input, unwrapped, schema)) {
    return [unwrapped]
  }
  const ordered = shouldPreferUnwrappedStructuredOutput(input, unwrapped, schema)
    ? [unwrapped, input]
    : [input, unwrapped]
  if (!schemaRootIsObject(schema)) {
    const semanticValue = singleToolInputValue(input)
    if (semanticValue !== STRUCTURED_OUTPUT_NO_SINGLE_VALUE) ordered.push(semanticValue)
  }
  return ordered.filter((candidate, index, all) => all.indexOf(candidate) === index)
}

function shouldTreatAsAccidentalObjectWrapper(
  input: unknown,
  unwrapped: unknown,
  schema: Record<string, unknown>
): boolean {
  if (!schemaRootIsObject(schema)) return false
  if (unwrapped === input || !isPlainRecord(input)) return false
  const single = singleOwnEntry(input)
  return (
    single !== null &&
    isStructuredOutputWrapperKey(single.key) &&
    !rootSchemaCoversProperty(schema, single.key) &&
    rootSchemaHasObjectShape(schema)
  )
}

function shouldPreferUnwrappedStructuredOutput(
  input: unknown,
  unwrapped: unknown,
  schema: Record<string, unknown>
): boolean {
  if (schemaRootIsObject(schema)) return false
  if (unwrapped === input) return false
  const unwrappedErrors = validateJsonSchemaValue(schema, unwrapped)
  if (unwrappedErrors.length > 0) return false
  if (isPlainRecord(input)) {
    const single = singleOwnEntry(input)
    if (
      single !== null &&
      isStructuredOutputWrapperKey(single.key) &&
      !rootSchemaDeclaresProperty(schema, single.key)
    ) {
      return true
    }
  }
  const inputErrors = validateJsonSchemaValue(schema, input)
  if (inputErrors.length > 0) return true
  return false
}

function toolInputFromParsingError(error: ToolInputParsingException, fallback: unknown): unknown {
  const output = (error as { output?: unknown }).output
  if (typeof output === "string") {
    try {
      return JSON.parse(output)
    } catch {
      return output
    }
  }
  return fallback
}

function structuredOutputToolInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const toolSchema = normalizeToolSchemaForProvider(schema) as Record<string, unknown>
  if (schemaRootIsObject(schema)) return normalizeObjectToolSchema(toolSchema)
  return {
    type: "object",
    properties: {
      value: {
        ...toolSchema,
        description:
          typeof toolSchema.description === "string"
            ? toolSchema.description
            : "The final structured result value."
      }
    },
    required: ["value"],
    additionalProperties: false
  }
}

function normalizeToolSchemaForProvider(value: unknown): unknown {
  return normalizeTypeArraysForToolSchema(stripPatternForToolSchema(value))
}

function normalizeObjectToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...schema }
  const types = Array.isArray(normalized.type) ? normalized.type : [normalized.type]
  if (normalized.type === undefined || types.every((item) => item === "object")) {
    normalized.type = "object"
  }
  return normalized
}

function schemaRootIsObject(schema: Record<string, unknown>): boolean {
  if (schemaRootIncludesExplicitNull(schema)) return false
  if (!schemaRootAllowsObject(schema)) return false
  return !schemaRootAllowsNonObject(schema)
}

function schemaRootIncludesExplicitNull(schema: Record<string, unknown>): boolean {
  return validateJsonSchemaValue(schema, null).length === 0
}

function schemaRootAllowsObject(schema: Record<string, unknown>, depth = 0): boolean {
  if (depth > 8) return false
  const explicitTypes = schemaTypeNames(schema)
  if (explicitTypes.includes("object")) return true
  if (explicitTypes.length > 0) return false
  if (
    Array.isArray(schema.required) ||
    isPlainRecord(schema.properties) ||
    schema.additionalProperties !== undefined
  ) {
    return true
  }
  if (schema.const !== undefined || Array.isArray(schema.enum)) return false
  const variants = [...schemaVariantValues(schema.anyOf), ...schemaVariantValues(schema.oneOf)]
  if (variants.length > 0) {
    return variants.some((variant) => {
      if (variant === true) return true
      if (variant === false || !isPlainRecord(variant)) return false
      return schemaRootAllowsObject(variant, depth + 1)
    })
  }
  return !schemaHasScalarRootAssertions(schema)
}

function schemaRootAllowsNonObject(schema: Record<string, unknown>, depth = 0): boolean {
  if (depth > 8) return false
  const explicitTypes = schemaTypeNames(schema)
  if (explicitTypes.length > 0) return explicitTypes.some((type) => type !== "object")
  if (Array.isArray(schema.required) || isPlainRecord(schema.properties)) return false
  if (schema.const !== undefined) return !isPlainRecord(schema.const)
  if (Array.isArray(schema.enum)) return schema.enum.some((candidate) => !isPlainRecord(candidate))
  const variants = [...schemaVariantValues(schema.anyOf), ...schemaVariantValues(schema.oneOf)]
  if (variants.length > 0) {
    return variants.some((variant) => {
      if (variant === true) return true
      if (variant === false || !isPlainRecord(variant)) return false
      return schemaRootAllowsNonObject(variant, depth + 1)
    })
  }
  return true
}

function schemaTypeNames(schema: Record<string, unknown>): string[] {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  return types.filter((item): item is string => typeof item === "string")
}

function schemaHasScalarRootAssertions(schema: Record<string, unknown>): boolean {
  return (
    schema.items !== undefined ||
    schema.minItems !== undefined ||
    schema.maxItems !== undefined ||
    schema.minLength !== undefined ||
    schema.maxLength !== undefined ||
    schema.pattern !== undefined ||
    schema.minimum !== undefined ||
    schema.maximum !== undefined
  )
}

export function exampleStructuredOutputToolInput(schema: Record<string, unknown>): unknown {
  const example = tryExampleStructuredOutputToolInput(schema)
  if (example === STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE) return undefined
  return example
}

function tryExampleStructuredOutputToolInput(
  schema: Record<string, unknown>
): unknown | typeof STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE {
  const value = exampleJsonValue(schema, { nodes: 0 })
  if (value === STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE) return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
  return schemaRootIsObject(schema) ? value : { value }
}

export function structuredOutputToolInputExampleJson(
  schema: Record<string, unknown>
): string | undefined {
  const example = tryExampleStructuredOutputToolInput(schema)
  if (example === STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE) return undefined
  const candidate = schemaRootIsObject(schema) ? example : unwrapToolInput(example)
  if (validateJsonSchemaValue(schema, candidate).length > 0) return undefined
  try {
    const json = JSON.stringify(example, null, 2)
    return json.length <= STRUCTURED_OUTPUT_EXAMPLE_MAX_CHARS ? json : undefined
  } catch {
    return undefined
  }
}

function exampleJsonValue(
  schema: Record<string, unknown>,
  budget: { nodes: number },
  depth = 0
): unknown | typeof STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE {
  budget.nodes += 1
  if (budget.nodes > STRUCTURED_OUTPUT_EXAMPLE_MAX_NODES) {
    return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
  }
  if (depth > 6) return null
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return (
      schema.enum.find((candidate) => validateJsonSchemaValue(schema, candidate).length === 0) ??
      schema.enum[0]
    )
  }
  const anyOfExample = exampleJsonVariant(schema, schema.anyOf, budget, depth)
  if (anyOfExample !== STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE) return anyOfExample
  const oneOfExample = exampleJsonVariant(schema, schema.oneOf, budget, depth)
  if (oneOfExample !== STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE) return oneOfExample
  if (
    (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) ||
    (Array.isArray(schema.oneOf) && schema.oneOf.length > 0)
  ) {
    return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
  }
  const candidates = Array.isArray(schema.type) ? schema.type : [schema.type]
  const type = candidates.find(
    (item): item is string => typeof item === "string" && item !== "null"
  )
  if (!type && candidates.includes("null")) return null
  if (type === "array") {
    const minItems =
      typeof schema.minItems === "number" ? Math.max(0, Math.floor(schema.minItems)) : 0
    if (minItems > STRUCTURED_OUTPUT_EXAMPLE_ARRAY_MAX_ITEMS) {
      return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
    }
    const exampleItems = minItems > 0 ? minItems : 0
    const itemSchema =
      typeof schema.items === "object" && schema.items !== null
        ? (schema.items as Record<string, unknown>)
        : {}
    const out: unknown[] = []
    for (let index = 0; index < exampleItems; index += 1) {
      const item = exampleJsonValue(itemSchema, budget, depth + 1)
      if (item === STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE) {
        return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
      }
      out.push(item)
    }
    return out
  }
  if (type === "string") {
    const minLength =
      typeof schema.minLength === "number" ? Math.max(0, Math.floor(schema.minLength)) : 0
    if (minLength > 32) return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
    const candidates = [
      ...exampleStringsForPattern(typeof schema.pattern === "string" ? schema.pattern : undefined),
      "x".repeat(minLength)
    ]
    for (const candidate of candidates) {
      const padded =
        candidate.length < minLength
          ? candidate + candidate.slice(-1).repeat(minLength - candidate.length)
          : candidate
      if (validateJsonSchemaValue(schema, padded).length === 0) return padded
    }
    return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
  }
  if (type === "number" || type === "integer") return exampleJsonNumber(schema, type === "integer")
  if (type === "boolean") return false
  if (type === "null") return null
  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {}
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : []
  const keys = required.length > 0 ? required : Object.keys(properties)
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const child = properties[key]
    if (typeof child === "object" && child !== null) {
      const example = exampleJsonValue(child as Record<string, unknown>, budget, depth + 1)
      if (example === STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE) {
        return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
      }
      out[key] = example
    } else {
      out[key] = null
    }
  }
  return out
}

function exampleJsonVariant(
  schema: Record<string, unknown>,
  value: unknown,
  budget: { nodes: number },
  depth: number
): unknown | typeof STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE {
  const variants = schemaVariantValues(value)
  if (variants.length === 0) return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
  const siblingAssertions = { ...schema }
  delete siblingAssertions.anyOf
  delete siblingAssertions.oneOf
  for (const variant of variants) {
    budget.nodes += 1
    if (budget.nodes > STRUCTURED_OUTPUT_EXAMPLE_MAX_NODES) {
      return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
    }
    if (variant === false) continue
    const candidateSchema =
      variant === true
        ? siblingAssertions
        : isPlainRecord(variant)
          ? { ...variant, ...siblingAssertions }
          : null
    if (candidateSchema === null) {
      continue
    }
    const candidate = exampleJsonValue(candidateSchema, budget, depth + 1)
    if (
      candidate !== STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE &&
      validateJsonSchemaValue(schema, candidate).length === 0
    ) {
      return candidate
    }
  }
  return STRUCTURED_OUTPUT_EXAMPLE_UNAVAILABLE
}

function exampleStringsForPattern(pattern: string | undefined): string[] {
  if (!pattern) return []
  const candidates: string[] = []
  const literalPrefix = pattern.match(/^\^([A-Za-z0-9_-]+)/)?.[1]
  if (literalPrefix) candidates.push(literalPrefix)
  const repeatedLiteral = pattern.match(/^\^([A-Za-z0-9])\+\$$/)
  if (repeatedLiteral) candidates.push(repeatedLiteral[1])
  const exactClass = pattern.match(/^\^\[([^\]]+)\]\{(\d+)\}\$$/)
  if (exactClass) {
    const length = Number.parseInt(exactClass[2], 10)
    if (Number.isInteger(length) && length >= 0 && length <= 32) {
      candidates.push(exampleCharFromClass(exactClass[1]).repeat(length))
    }
  }
  const repeatedClass = pattern.match(/^\^\[([^\]]+)\]\+\$$/)
  if (repeatedClass) candidates.push(exampleCharFromClass(repeatedClass[1]))
  return [...new Set(candidates)]
}

function exampleCharFromClass(charClass: string): string {
  if (charClass.includes("A-Z")) return "A"
  if (charClass.includes("a-z")) return "a"
  if (charClass.includes("0-9") || charClass.includes("\\d")) return "0"
  const literal = charClass.match(/[A-Za-z0-9_-]/)?.[0]
  return literal ?? "x"
}

function exampleJsonNumber(schema: Record<string, unknown>, integer: boolean): number {
  const minimum = typeof schema.minimum === "number" ? schema.minimum : null
  const maximum = typeof schema.maximum === "number" ? schema.maximum : null
  let value = 0
  if (minimum !== null && value < minimum) value = integer ? Math.ceil(minimum) : minimum
  if (maximum !== null && value > maximum) value = integer ? Math.floor(maximum) : maximum
  return value
}

function stripPatternForToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPatternForToolSchema)
  if (!isPlainRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === "pattern" && typeof child === "string") continue
    if (key === "const" || key === "enum") {
      out[key] = child
      continue
    }
    if (PROVIDER_SCHEMA_DROPPED_ANNOTATIONS.has(key)) continue
    if (key === "properties" && isPlainRecord(child)) {
      const properties: Record<string, unknown> = {}
      for (const [propertyName, propertySchema] of Object.entries(child)) {
        properties[propertyName] = stripPatternForToolSchema(propertySchema)
      }
      out[key] = properties
      continue
    }
    out[key] = stripPatternForToolSchema(child)
  }
  return out
}

function normalizeTypeArraysForToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTypeArraysForToolSchema)
  if (typeof value === "boolean") return {}
  if (!isPlainRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === "type" || key === "nullable") continue
    if (key === "const" || key === "enum") {
      out[key] = child
      continue
    }
    if (PROVIDER_SCHEMA_DROPPED_ANNOTATIONS.has(key)) continue
    if (key === "additionalProperties") {
      if (child === false) out[key] = false
      continue
    }
    if (key === "properties" && isPlainRecord(child)) {
      const properties: Record<string, unknown> = {}
      for (const [propertyName, propertySchema] of Object.entries(child)) {
        properties[propertyName] = normalizeTypeArraysForToolSchema(propertySchema)
      }
      out[key] = properties
      continue
    }
    out[key] = normalizeTypeArraysForToolSchema(child)
  }
  const declaredTypes = Array.isArray(value.type) ? value.type : [value.type]
  const explicitTypes = declaredTypes.filter((item): item is string => typeof item === "string")
  const hasImplicitObjectShape = isPlainRecord(value.properties) || Array.isArray(value.required)
  const inferredTypes =
    explicitTypes.length > 0 ? explicitTypes : hasImplicitObjectShape ? ["object"] : []
  const nullableAcceptsNull =
    value.nullable === true &&
    inferredTypes.length > 0 &&
    !inferredTypes.includes("null") &&
    validateJsonSchemaValue(value, null).length === 0
  const types = nullableAcceptsNull ? [...inferredTypes, "null"] : inferredTypes
  if (types.length === 0) {
    return out
  }
  if (types.length === 1) {
    out.type = types[0]
    return out
  }
  const anyOf = types.map((type) => toolSchemaBranchForType(out, type))
  return { anyOf }
}

function toolSchemaBranchForType(
  schema: Record<string, unknown>,
  type: string
): Record<string, unknown> {
  const branch: Record<string, unknown> = {}
  for (const key of ["title", "description", "enum", "const", "anyOf", "oneOf"] as const) {
    if (schema[key] !== undefined) branch[key] = schema[key]
  }
  if (type === "object") {
    for (const key of ["properties", "required", "additionalProperties"] as const) {
      if (schema[key] !== undefined) branch[key] = schema[key]
    }
  } else if (type === "array") {
    for (const key of ["items", "minItems", "maxItems"] as const) {
      if (schema[key] !== undefined) branch[key] = schema[key]
    }
  } else if (type === "string") {
    for (const key of ["minLength", "maxLength"] as const) {
      if (schema[key] !== undefined) branch[key] = schema[key]
    }
  } else if (type === "number" || type === "integer") {
    for (const key of ["minimum", "maximum"] as const) {
      if (schema[key] !== undefined) branch[key] = schema[key]
    }
  }
  branch.type = type
  return branch
}

export function buildStructuredOutputRepairErrors(
  schema: Record<string, unknown>,
  input: unknown,
  errors: string[]
): string[] {
  const hints = [
    ...collectStringifiedJsonHints(structuredOutputToolInputSchema(schema), input),
    ...collectStringifiedJsonHints(schema, input),
    ...collectSemanticSingleValueJsonHints(schema, input)
  ]
  if (hints.length === 0) return errors
  return [...new Set([...hints, ...errors])]
}

function collectSemanticSingleValueJsonHints(
  schema: Record<string, unknown>,
  input: unknown
): string[] {
  if (schemaRootIsObject(schema) || !isPlainRecord(input)) return []
  const single = singleOwnEntry(input)
  if (single === null) return []
  return collectStringifiedJsonHints(schema, single.value, `$.${single.key}`)
}

function collectStringifiedJsonHints(
  schema: Record<string, unknown>,
  value: unknown,
  path = "$",
  depth = 0,
  budget: { nodes: number; stopped: boolean } = { nodes: 0, stopped: false }
): string[] {
  if (budget.stopped || depth > 8) return []
  budget.nodes += 1
  if (budget.nodes > STRUCTURED_OUTPUT_HINT_MAX_NODES) {
    budget.stopped = true
    return []
  }
  const hints: string[] = []
  for (const variant of schemaVariants(schema.anyOf)) {
    if (budget.stopped) break
    hints.push(...collectStringifiedJsonHints(variant, value, path, depth + 1, budget))
  }
  for (const variant of schemaVariants(schema.oneOf)) {
    if (budget.stopped) break
    hints.push(...collectStringifiedJsonHints(variant, value, path, depth + 1, budget))
  }
  const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type]
  const expectsArray = expectedTypes.includes("array")
  const expectsObject =
    expectedTypes.includes("object") ||
    (schema.type === undefined &&
      (isPlainRecord(schema.properties) || Array.isArray(schema.required)))
  if ((expectsArray || expectsObject) && typeof value === "string") {
    const parsed = parseLikelyJsonString(value)
    if (parsed !== undefined) {
      if ((expectsArray && Array.isArray(parsed)) || (expectsObject && isPlainRecord(parsed))) {
        hints.push(
          `${path}: pass ${expectsArray ? "an array" : "an object"} directly, not a JSON-encoded string. Use ${shortJson(parsed)} instead of ${shortJson(value)}.`
        )
      }
    }
  }
  if (Array.isArray(value)) {
    const itemSchema = isPlainRecord(schema.items) ? schema.items : null
    if (!itemSchema) return Array.from(new Set(hints))
    const maxItems = Math.min(value.length, STRUCTURED_OUTPUT_EXAMPLE_ARRAY_MAX_ITEMS)
    for (let index = 0; index < maxItems && !budget.stopped; index += 1) {
      hints.push(
        ...collectStringifiedJsonHints(
          itemSchema,
          value[index],
          `${path}[${index}]`,
          depth + 1,
          budget
        )
      )
    }
    return Array.from(new Set(hints))
  }
  if (!isPlainRecord(value)) return hints
  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {}
  for (const [key, childSchema] of Object.entries(properties)) {
    if (budget.stopped) break
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (typeof childSchema !== "object" || childSchema === null) continue
    hints.push(
      ...collectStringifiedJsonHints(
        childSchema as Record<string, unknown>,
        value[key],
        `${path}.${key}`,
        depth + 1,
        budget
      )
    )
  }
  if (isPlainRecord(schema.additionalProperties)) {
    for (const key in value) {
      if (budget.stopped) break
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue
      const childValue = value[key]
      hints.push(
        ...collectStringifiedJsonHints(
          schema.additionalProperties,
          childValue,
          `${path}.${key}`,
          depth + 1,
          budget
        )
      )
    }
  }
  return Array.from(new Set(hints))
}

function schemaVariants(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => isPlainRecord(item))
}

function rootSchemaVariants(schema: Record<string, unknown>): Record<string, unknown>[] {
  return [...schemaVariants(schema.anyOf), ...schemaVariants(schema.oneOf)]
}

function schemaVariantValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function parseLikelyJsonString(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return undefined
  if (trimmed.length > STRUCTURED_OUTPUT_HINT_PARSE_MAX_CHARS) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function shortJson(value: unknown): string {
  return boundedStableStringify(value, STRUCTURED_OUTPUT_HINT_JSON_MAX_CHARS)
}

function stableStringifyWithMetadata(value: unknown): { value: string; truncated: boolean } {
  return boundedStableStringifyWithMetadata(value, STRUCTURED_OUTPUT_SIGNATURE_MAX_CHARS)
}

function boundedStableStringify(value: unknown, maxChars: number): string {
  return boundedStableStringifyWithMetadata(value, maxChars).value
}

function boundedStableStringifyWithMetadata(
  value: unknown,
  maxChars: number
): { value: string; truncated: boolean } {
  const seen = new WeakSet<object>()
  let out = ""
  let truncated = false
  let lossy = false

  const append = (text: string): void => {
    if (truncated || maxChars <= 0) return
    const remaining = maxChars - out.length
    if (text.length <= remaining) {
      out += text
      return
    }
    out += text.slice(0, Math.max(0, remaining))
    truncated = true
  }

  const writeString = (text: string): void => {
    const maxInlineChars = Math.min(1_024, Math.max(16, maxChars))
    if (text.length > maxInlineChars) lossy = true
    const value =
      text.length > maxInlineChars
        ? `${text.slice(0, maxInlineChars)}...[truncated ${text.length - maxInlineChars} chars]`
        : text
    append(JSON.stringify(value))
  }

  const write = (node: unknown, depth: number): void => {
    if (truncated) return
    if (depth > 12) {
      lossy = true
      writeString("[MaxDepth]")
      return
    }
    if (node === null) {
      append("null")
      return
    }
    if (typeof node === "string") {
      writeString(node)
      return
    }
    if (typeof node === "number" || typeof node === "boolean") {
      append(JSON.stringify(node))
      return
    }
    if (typeof node === "bigint") {
      writeString(`${node.toString()}n`)
      return
    }
    if (typeof node === "undefined" || typeof node === "function" || typeof node === "symbol") {
      writeString(`[${typeof node}]`)
      return
    }
    if (typeof node !== "object") {
      writeString(String(node))
      return
    }
    if (seen.has(node)) {
      writeString("[Circular]")
      return
    }
    seen.add(node)
    if (Array.isArray(node)) {
      append("[")
      for (let index = 0; index < node.length; index += 1) {
        if (index > 0) append(",")
        write(node[index], depth + 1)
        if (truncated) break
      }
      append("]")
      seen.delete(node)
      return
    }
    append("{")
    const { entries, hasMore } = boundedSortedObjectEntries(node as Record<string, unknown>)
    for (let index = 0; index < entries.length; index += 1) {
      const [key, child] = entries[index]
      if (index > 0) append(",")
      writeString(key)
      append(":")
      write(child, depth + 1)
      if (truncated) break
    }
    if (hasMore && !truncated) {
      lossy = true
      if (entries.length > 0) append(",")
      writeString("...[truncatedKeys]")
      append(":")
      writeString(`first ${STRUCTURED_OUTPUT_STRINGIFY_MAX_OBJECT_KEYS} keys only`)
    }
    append("}")
    seen.delete(node)
  }

  write(value, 0)
  if (!truncated) return { value: out, truncated: lossy }
  const suffix = "...[truncated]"
  if (maxChars <= suffix.length) return { value: suffix.slice(0, maxChars), truncated: true }
  return { value: `${out.slice(0, maxChars - suffix.length)}${suffix}`, truncated: true }
}

function boundedSortedObjectEntries(record: Record<string, unknown>): {
  entries: Array<[string, unknown]>
  hasMore: boolean
} {
  const entries: Array<[string, unknown]> = []
  let hasMore = false
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    if (entries.length >= STRUCTURED_OUTPUT_STRINGIFY_MAX_OBJECT_KEYS) {
      hasMore = true
      break
    }
    entries.push([key, record[key]])
  }
  entries.sort(([a], [b]) => a.localeCompare(b))
  return { entries, hasMore }
}

/**
 * Providers deliver tool args as a JSON object. When the model wraps the whole
 * answer under a conventional single key (input/result/value/data), unwrap one
 * level so near-miss calls still validate. Do not unwrap arbitrary single-key
 * objects: wide schemas like `{}` legitimately accept `{ foo: "bar" }`.
 */
function unwrapToolInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  const single = singleOwnEntry(record)
  if (single !== null && isStructuredOutputWrapperKey(single.key)) return single.value
  return input
}

function singleToolInputValue(input: unknown): unknown | typeof STRUCTURED_OUTPUT_NO_SINGLE_VALUE {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return STRUCTURED_OUTPUT_NO_SINGLE_VALUE
  }
  const single = singleOwnEntry(input as Record<string, unknown>)
  return single === null ? STRUCTURED_OUTPUT_NO_SINGLE_VALUE : single.value
}

function singleOwnEntry(record: Record<string, unknown>): { key: string; value: unknown } | null {
  let found: { key: string; value: unknown } | null = null
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    if (found !== null) return null
    found = { key, value: record[key] }
  }
  return found
}

function isStructuredOutputWrapperKey(key: string): boolean {
  return key === "input" || key === "result" || key === "value" || key === "data"
}
