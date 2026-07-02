export interface ResultProjectionOptions {
  requiredFields?: string[]
  maxChars?: number
  maxArrayItems?: number
  mode?: "auto" | "fields" | "bounded" | "raw"
}

export interface ResultProjectionMetadata {
  projected: boolean
  truncated: boolean
  originalBytes: number
  originalBytesEstimated?: boolean
  projectedBytes: number
  missingFields?: string[]
  omittedFields?: string[]
  topLevelKeys?: string[]
  requiredFieldsIgnored?: boolean
  ignoredReason?: string
  fullResultRef?: string
}

export interface ProjectedResult {
  data: unknown
  metadata: ResultProjectionMetadata
}

const DEFAULT_MAX_ARRAY_ITEMS = 20
const DEFAULT_MISSING_FIELD_PREVIEW_CHARS = 4_000
const ESTIMATE_SAMPLE_ARRAY_ITEMS = 5
const ESTIMATED_OBJECT_VALUE_BYTES = 16
const MAX_FIELD_HINTS = 80
const MAX_FIELD_HINT_DEPTH = 5

function safeClone(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (
    value == null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value
  }
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function" || typeof value === "symbol") return String(value)

  if (typeof value === "object") {
    const existing = seen.get(value)
    if (existing !== undefined) return "[Circular]"

    if (Array.isArray(value)) {
      const output: unknown[] = []
      seen.set(value, output)
      for (const item of value) output.push(safeClone(item, seen))
      return output
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack
      }
    }

    const output: Record<string, unknown> = {}
    seen.set(value, output)
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = safeClone(item, seen)
    }
    return output
  }

  return String(value)
}

export function safeProjectionStringify(value: unknown): string {
  try {
    return JSON.stringify(safeClone(value), null, 2) ?? String(value)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function primitiveJsonBytes(value: unknown): number {
  if (typeof value === "bigint") return utf8Bytes(JSON.stringify(value.toString()) ?? "null")
  if (typeof value === "function" || typeof value === "symbol") {
    return utf8Bytes(JSON.stringify(String(value)) ?? "null")
  }
  return utf8Bytes(JSON.stringify(value) ?? "null")
}

function estimateSerializedBytes(value: unknown, seen = new WeakSet<object>()): number {
  if (
    value == null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return primitiveJsonBytes(value)
  }

  if (typeof value !== "object") return primitiveJsonBytes(String(value))
  if (seen.has(value)) return primitiveJsonBytes("[Circular]")
  seen.add(value)

  if (Array.isArray(value)) {
    if (value.length === 0) return 2
    const sampleCount = Math.min(value.length, ESTIMATE_SAMPLE_ARRAY_ITEMS)
    let sampleBytes = 0
    for (let i = 0; i < sampleCount; i += 1) {
      sampleBytes += estimateSerializedBytes(value[i], seen)
    }
    const averageItemBytes = sampleBytes / sampleCount
    return 2 + Math.ceil(averageItemBytes * value.length) + Math.max(0, value.length - 1)
  }

  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.length === 0) return 2
  return (
    2 +
    keys.reduce(
      (total, key) => total + utf8Bytes(JSON.stringify(key)) + 1 + ESTIMATED_OBJECT_VALUE_BYTES,
      0
    ) +
    Math.max(0, keys.length - 1)
  )
}

function measureOriginalBytes(
  value: unknown,
  exact: boolean
): { bytes: number; estimated: boolean } {
  if (exact) {
    return { bytes: utf8Bytes(safeProjectionStringify(value)), estimated: false }
  }
  return { bytes: estimateSerializedBytes(value), estimated: true }
}

function normalizedPositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  const integer = Math.floor(value)
  return integer > 0 ? integer : undefined
}

export function hasProjectionOptions(options: ResultProjectionOptions | undefined): boolean {
  if (!options) return false
  return Boolean(
    options.mode === "raw" ||
    options.mode === "bounded" ||
    options.mode === "fields" ||
    (Array.isArray(options.requiredFields) && options.requiredFields.length > 0) ||
    normalizedPositiveInteger(options.maxChars) !== undefined ||
    normalizedPositiveInteger(options.maxArrayItems) !== undefined
  )
}

function topLevelKeys(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return Object.keys(value as Record<string, unknown>).slice(0, 50)
}

function missingFieldsPreview(data: unknown, maxChars: number | undefined): string {
  const limit = maxChars ?? DEFAULT_MISSING_FIELD_PREVIEW_CHARS
  if (typeof data === "string") {
    if (data.length <= limit) return data
    return `${data.slice(0, limit)}\n\n[Result preview truncated to ${limit} chars]`
  }
  const keys = topLevelKeys(data) ?? []
  return keys.length > 0
    ? `Requested fields were not found. Available top-level keys: ${keys.join(", ")}`
    : "Requested fields were not found in the result."
}

function parseFieldPath(path: string): Array<{ key: string; array: boolean }> | null {
  const trimmed = path.trim()
  if (!trimmed) return null
  const parts = trimmed.split(".")
  const segments: Array<{ key: string; array: boolean }> = []
  for (const rawPart of parts) {
    const part = rawPart.trim()
    if (!part) return null
    if (part === "[]") {
      segments.push({ key: "", array: true })
    } else if (part.endsWith("[]")) {
      const key = part.slice(0, -2)
      if (!key) return null
      segments.push({ key, array: true })
    } else {
      segments.push({ key: part, array: false })
    }
  }
  return segments
}

function ensureObjectSlot(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key]
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>
  }
  const next: Record<string, unknown> = {}
  parent[key] = next
  return next
}

function ensureArraySlot(parent: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const existing = parent[key]
  if (Array.isArray(existing)) return existing as Record<string, unknown>[]
  const next: Record<string, unknown>[] = []
  parent[key] = next
  return next
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function projectFieldPath(
  source: unknown,
  target: Record<string, unknown> | Record<string, unknown>[],
  segments: Array<{ key: string; array: boolean }>,
  maxArrayItems: number
): boolean {
  if (segments.length === 0) return false

  const [segment, ...rest] = segments

  if (segment.array && segment.key === "") {
    if (!Array.isArray(source) || !Array.isArray(target)) return false
    const items = source.slice(0, maxArrayItems)
    if (rest.length === 0) {
      target.splice(
        0,
        target.length,
        ...(items.map((item) => safeClone(item)) as Record<string, unknown>[])
      )
      return true
    }

    let matched = false
    items.forEach((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return
      const outputItem = target[index] ?? {}
      const nestedMatched = projectFieldPath(item, outputItem, rest, maxArrayItems)
      if (nestedMatched) {
        target[index] = outputItem
        matched = true
      }
    })
    return matched
  }

  if (!source || typeof source !== "object" || Array.isArray(source) || Array.isArray(target)) {
    return false
  }

  const record = source as Record<string, unknown>
  if (!hasOwn(record, segment.key)) return false
  const value = record[segment.key]

  if (segment.array) {
    if (!Array.isArray(value)) return false
    const outputArray = ensureArraySlot(target, segment.key)
    const items = value.slice(0, maxArrayItems)
    if (rest.length === 0) {
      target[segment.key] = items.map((item) => safeClone(item))
      return true
    }

    let matched = false
    items.forEach((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return
      const outputItem = outputArray[index] ?? {}
      const nestedMatched = projectFieldPath(item, outputItem, rest, maxArrayItems)
      if (nestedMatched) {
        outputArray[index] = outputItem
        matched = true
      }
    })
    return matched
  }

  if (rest.length === 0) {
    target[segment.key] = safeClone(value)
    return true
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const outputObject = ensureObjectSlot(target, segment.key)
  return projectFieldPath(value, outputObject, rest, maxArrayItems)
}

function limitArrays(
  value: unknown,
  maxArrayItems: number,
  seen = new WeakMap<object, unknown>()
): unknown {
  if (value == null || typeof value !== "object") return safeClone(value)
  const existing = seen.get(value)
  if (existing !== undefined) return "[Circular]"

  if (Array.isArray(value)) {
    const output: unknown[] = []
    seen.set(value, output)
    for (const item of value.slice(0, maxArrayItems))
      output.push(limitArrays(item, maxArrayItems, seen))
    return output
  }

  const output: Record<string, unknown> = {}
  seen.set(value, output)
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = limitArrays(item, maxArrayItems, seen)
  }
  return output
}

function boundByChars(
  data: unknown,
  maxChars: number | undefined
): { data: unknown; truncated: boolean } {
  if (!maxChars) return { data, truncated: false }

  if (typeof data === "string") {
    if (data.length <= maxChars) return { data, truncated: false }
    return {
      data: `${data.slice(0, maxChars)}\n\n[Result truncated to ${maxChars} chars]`,
      truncated: true
    }
  }

  const serialized = safeProjectionStringify(data)
  if (serialized.length <= maxChars) return { data, truncated: false }
  return {
    data: `${serialized.slice(0, maxChars)}\n\n[Result truncated to ${maxChars} chars]`,
    truncated: true
  }
}

export function projectResultData(
  data: unknown,
  options: ResultProjectionOptions = {}
): ProjectedResult {
  const maxChars = normalizedPositiveInteger(options.maxChars)
  const requestedMaxArrayItems = normalizedPositiveInteger(options.maxArrayItems)
  const maxArrayItems = requestedMaxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS
  const requiredFields = (options.requiredFields ?? []).map((field) => field.trim()).filter(Boolean)
  const usesSelectiveProjection =
    requiredFields.length > 0 || options.mode === "fields" || requestedMaxArrayItems !== undefined
  const keys = topLevelKeys(data)

  if (options.mode === "raw") {
    const originalMeasurement = measureOriginalBytes(data, true)
    const originalBytes = originalMeasurement.bytes
    return {
      data,
      metadata: {
        projected: false,
        truncated: false,
        originalBytes,
        projectedBytes: originalBytes
      }
    }
  }

  if (
    maxChars !== undefined &&
    !usesSelectiveProjection &&
    data !== null &&
    typeof data === "object"
  ) {
    const serialized = safeProjectionStringify(data)
    const originalBytes = utf8Bytes(serialized)
    const truncated = serialized.length > maxChars
    const workingData = truncated
      ? `${serialized.slice(0, maxChars)}\n\n[Result truncated to ${maxChars} chars]`
      : safeClone(data)
    const projectedBytes = truncated
      ? utf8Bytes(safeProjectionStringify(workingData))
      : originalBytes

    return {
      data: workingData,
      metadata: {
        projected: false,
        truncated,
        originalBytes,
        projectedBytes,
        ...(keys ? { topLevelKeys: keys } : {})
      }
    }
  }

  const originalMeasurement = measureOriginalBytes(data, !usesSelectiveProjection)
  const originalBytes = originalMeasurement.bytes

  let projected = requiredFields.length > 0 || options.mode === "fields"
  let workingData: unknown = data
  const missingFields: string[] = []

  if (requiredFields.length > 0) {
    let output: Record<string, unknown> | Record<string, unknown>[] | null = null
    for (const field of requiredFields) {
      const segments = parseFieldPath(field)
      if (!segments) {
        missingFields.push(field)
        continue
      }
      const wantsRootArray = segments[0]?.array === true && segments[0]?.key === ""
      if (!output) output = wantsRootArray ? [] : {}
      if (wantsRootArray !== Array.isArray(output)) {
        missingFields.push(field)
        continue
      }
      if (!projectFieldPath(data, output, segments, maxArrayItems)) {
        missingFields.push(field)
      }
    }
    const projectedOutput = output ?? {}
    const hasProjectedOutput = Array.isArray(projectedOutput)
      ? projectedOutput.length > 0
      : Object.keys(projectedOutput).length > 0
    workingData = hasProjectedOutput
      ? projectedOutput
      : {
          _preview: missingFieldsPreview(data, maxChars),
          _availableTopLevelKeys: keys ?? []
        }
  } else if (requestedMaxArrayItems !== undefined) {
    projected = true
    workingData = limitArrays(data, maxArrayItems)
  } else {
    workingData = safeClone(data)
  }

  const bounded = boundByChars(workingData, maxChars)
  workingData = bounded.data
  const projectedSerialized = safeProjectionStringify(workingData)
  const projectedBytes = utf8Bytes(projectedSerialized)

  return {
    data: workingData,
    metadata: {
      projected,
      truncated: bounded.truncated,
      originalBytes,
      projectedBytes,
      ...(originalMeasurement.estimated ? { originalBytesEstimated: true } : {}),
      ...(missingFields.length > 0 ? { missingFields } : {}),
      ...(keys ? { topLevelKeys: keys } : {})
    }
  }
}

function isJsonObjectSchema(schema: Record<string, unknown>): boolean {
  return (
    schema.type === "object" || Boolean(schema.properties && typeof schema.properties === "object")
  )
}

function isJsonArraySchema(schema: Record<string, unknown>): boolean {
  return schema.type === "array" || Boolean(schema.items)
}

function collectSchemaPaths(
  schema: unknown,
  prefix: string,
  output: string[],
  depth: number
): void {
  if (
    !schema ||
    typeof schema !== "object" ||
    depth > MAX_FIELD_HINT_DEPTH ||
    output.length >= MAX_FIELD_HINTS
  ) {
    return
  }

  const record = schema as Record<string, unknown>
  if (isJsonArraySchema(record)) {
    const arrayPrefix = prefix ? `${prefix}[]` : "[]"
    const items = record.items
    if (
      items &&
      typeof items === "object" &&
      isJsonObjectSchema(items as Record<string, unknown>)
    ) {
      collectSchemaPaths(items, arrayPrefix, output, depth + 1)
    } else if (prefix) {
      output.push(arrayPrefix)
    }
    return
  }

  if (!isJsonObjectSchema(record)) {
    if (prefix) output.push(prefix)
    return
  }

  const properties = record.properties
  if (!properties || typeof properties !== "object") {
    if (prefix) output.push(prefix)
    return
  }

  for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
    if (output.length >= MAX_FIELD_HINTS) break
    const childPath = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === "object") {
      const childRecord = child as Record<string, unknown>
      if (isJsonObjectSchema(childRecord) || isJsonArraySchema(childRecord)) {
        collectSchemaPaths(childRecord, childPath, output, depth + 1)
        continue
      }
    }
    output.push(childPath)
  }
}

export function deriveFieldPathsFromJsonSchema(
  schema: unknown,
  maxPaths = MAX_FIELD_HINTS
): string[] {
  const output: string[] = []
  collectSchemaPaths(schema, "", output, 0)
  return Array.from(new Set(output)).slice(0, maxPaths)
}

function collectValuePaths(
  value: unknown,
  prefix: string,
  output: string[],
  depth: number,
  seen: WeakSet<object>
): void {
  if (output.length >= MAX_FIELD_HINTS || depth > MAX_FIELD_HINT_DEPTH) return
  if (value == null || typeof value !== "object") {
    if (prefix) output.push(prefix)
    return
  }
  if (seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    const arrayPrefix = prefix ? `${prefix}[]` : "[]"
    const firstObject = value.find((item) => item && typeof item === "object")
    if (firstObject) {
      collectValuePaths(firstObject, arrayPrefix, output, depth + 1, seen)
    } else if (prefix) {
      output.push(arrayPrefix)
    }
    return
  }

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0 && prefix) {
    output.push(prefix)
    return
  }
  for (const [key, child] of entries) {
    if (output.length >= MAX_FIELD_HINTS) break
    const childPath = prefix ? `${prefix}.${key}` : key
    collectValuePaths(child, childPath, output, depth + 1, seen)
  }
}

export function deriveFieldPathsFromValue(value: unknown, maxPaths = MAX_FIELD_HINTS): string[] {
  const output: string[] = []
  collectValuePaths(value, "", output, 0, new WeakSet<object>())
  return Array.from(new Set(output)).slice(0, maxPaths)
}
