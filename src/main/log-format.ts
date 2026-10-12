import { types as nodeUtilTypes } from "node:util"
import { redactLogValues } from "./log-redaction"

const LOG_VALUE_MAX_DEPTH = 5
const LOG_VALUE_MAX_ENTRIES = 64
const LOG_VALUE_MAX_STRING_CHARS = 2 * 1024
const LOG_ARGUMENT_MAX_CHARS = 8 * 1024
export const LOG_LINE_MAX_CHARS = 16 * 1024
const LOG_ARGUMENT_MAX_COUNT = 32
const LOG_PROJECTION_MAX_NODES = 1_024
const LOG_PROJECTION_MAX_PROPERTY_SCANS = 4_096
const LOG_PROJECTION_MAX_STRING_CHARS = 256 * 1024

interface LogProjectionContext {
  remainingNodes: number
  remainingPropertyScans: number
  remainingStringChars: number
  readonly seen: WeakSet<object>
}

function createLogProjectionContext(): LogProjectionContext {
  return {
    remainingNodes: LOG_PROJECTION_MAX_NODES,
    remainingPropertyScans: LOG_PROJECTION_MAX_PROPERTY_SCANS,
    remainingStringChars: LOG_PROJECTION_MAX_STRING_CHARS,
    seen: new WeakSet<object>()
  }
}

function boundedString(value: string, limit = LOG_VALUE_MAX_STRING_CHARS): string {
  // Bound the raw input before any replacement. Replacing first would scan and
  // duplicate an arbitrarily large Error/message on Electron's main isolate,
  // even though only a tiny prefix can ever reach the log.
  const rawPrefix = value.length > limit ? value.slice(0, limit) : value
  const singleLine = rawPrefix.replace(/\r/g, "\\r").replace(/\n/g, "\\n")
  if (value.length <= limit && singleLine.length <= limit) return singleLine
  const truncatedChars =
    value.length > rawPrefix.length
      ? value.length - rawPrefix.length
      : Math.max(0, singleLine.length - limit)
  return `${singleLine.slice(0, limit)}…[truncated ${truncatedChars} chars]`
}

function projectString(
  value: string,
  context: LogProjectionContext,
  maxChars = LOG_VALUE_MAX_STRING_CHARS
): string {
  if (context.remainingStringChars <= 0) return "[text-budget]"
  const limit = Math.min(maxChars, context.remainingStringChars)
  context.remainingStringChars = Math.max(
    0,
    context.remainingStringChars - Math.min(value.length, limit)
  )
  return boundedString(value, limit)
}

function projectLogValue(value: unknown, depth: number, context: LogProjectionContext): unknown {
  if (context.remainingNodes <= 0) return "[node-limit]"
  context.remainingNodes -= 1
  if (typeof value === "string") return projectString(value, context)
  if (typeof value === "bigint") return projectString(`${value.toString()}n`, context)
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    try {
      if (nodeUtilTypes.isProxy(value)) return "[Unserializable Object]"
    } catch {
      return "[Unserializable Object]"
    }
  }
  if (typeof value === "function") {
    return `[Function ${projectString(value.name || "anonymous", context, 256)}]`
  }
  if (typeof value === "symbol") return projectString(value.toString(), context)
  if (typeof value !== "object") return projectString(String(value), context)
  if (context.seen.has(value)) return "[Circular]"
  if (depth >= LOG_VALUE_MAX_DEPTH) return "[Object depth-limit]"
  context.seen.add(value)

  if (value instanceof Error) {
    return {
      name: projectString(value.name, context, 256),
      message: projectString(value.message, context),
      stack: projectString(value.stack || "", context)
    }
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof RegExp || value instanceof URL) {
    return projectString(value.toString(), context)
  }
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`
  if (Array.isArray(value)) {
    const count = Math.min(value.length, LOG_VALUE_MAX_ENTRIES)
    const output = new Array<unknown>(count)
    for (let index = 0; index < count; index += 1) {
      output[index] = projectLogValue(value[index], depth + 1, context)
    }
    if (value.length > count) output.push(`[+${value.length - count} entries]`)
    return output
  }
  if (value instanceof Map) {
    const output: unknown[] = []
    let index = 0
    for (const [key, nested] of value) {
      if (index >= LOG_VALUE_MAX_ENTRIES) break
      output.push([
        projectLogValue(key, depth + 1, context),
        projectLogValue(nested, depth + 1, context)
      ])
      index += 1
    }
    if (value.size > index) output.push(`[+${value.size - index} entries]`)
    return { map: output }
  }
  if (value instanceof Set) {
    const output: unknown[] = []
    let index = 0
    for (const nested of value) {
      if (index >= LOG_VALUE_MAX_ENTRIES) break
      output.push(projectLogValue(nested, depth + 1, context))
      index += 1
    }
    if (value.size > index) output.push(`[+${value.size - index} entries]`)
    return { set: output }
  }

  const output: Record<string, unknown> = {}
  let included = 0
  try {
    for (const key in value) {
      if (context.remainingPropertyScans <= 0) {
        output["…"] = "[property-scan-limit]"
        break
      }
      context.remainingPropertyScans -= 1
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      if (included >= LOG_VALUE_MAX_ENTRIES) {
        output["…"] = `[entry-limit ${LOG_VALUE_MAX_ENTRIES}]`
        break
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      output[projectString(key, context, 256)] =
        descriptor && "value" in descriptor
          ? projectLogValue(descriptor.value, depth + 1, context)
          : "[Getter]"
      included += 1
    }
  } catch {
    return "[Unserializable Object]"
  }
  return output
}

function projectLogValueSafely(value: unknown, context: LogProjectionContext): unknown {
  try {
    return projectLogValue(value, 0, context)
  } catch {
    return "[Unserializable Object]"
  }
}

function safeStringify(value: unknown, context: LogProjectionContext): string {
  const projected = projectLogValueSafely(value, context)
  let serialized: string
  try {
    if (typeof projected === "string") {
      serialized = projected
    } else {
      // JSON.stringify intentionally returns undefined for top-level undefined.
      // console.log accepts that value, so the file logger must preserve it as
      // text instead of letting its own length bound crash the business call.
      serialized = JSON.stringify(projected) ?? String(projected)
    }
  } catch {
    serialized = "[Unserializable Object]"
  }
  return serialized.length <= LOG_ARGUMENT_MAX_CHARS
    ? serialized
    : `${serialized.slice(0, LOG_ARGUMENT_MAX_CHARS)}…[argument-truncated]`
}

export function joinLogArguments(args: unknown[]): string {
  let output = ""
  const count = Math.min(args.length, LOG_ARGUMENT_MAX_COUNT)
  const projectionContext = createLogProjectionContext()
  for (let index = 0; index < count; index += 1) {
    const separator = output ? " " : ""
    const remaining = LOG_LINE_MAX_CHARS - output.length - separator.length
    if (remaining <= 0) break
    output += `${separator}${safeStringify(args[index], projectionContext).slice(0, remaining)}`
  }
  if (args.length > count && output.length < LOG_LINE_MAX_CHARS) {
    output += ` [+${args.length - count} args]`
  }
  return output.slice(0, LOG_LINE_MAX_CHARS)
}

/** Shared desktop/Host console projection. Apply redaction before any truncation
 * and never invoke getters, proxies or user-defined serialization. */
export function boundedLogArguments(args: unknown[]): unknown[] {
  const redactedInputArgs = redactLogValues(args.slice(0, LOG_ARGUMENT_MAX_COUNT))
  const projectionContext = createLogProjectionContext()
  const boundedArgs = redactedInputArgs.map((value) =>
    projectLogValueSafely(value, projectionContext)
  )
  if (args.length > boundedArgs.length)
    boundedArgs.push(`[+${args.length - boundedArgs.length} args]`)
  return boundedArgs
}
