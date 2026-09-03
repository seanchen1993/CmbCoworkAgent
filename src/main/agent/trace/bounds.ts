const DEFAULT_MAX_DEPTH = 6
const DEFAULT_MAX_ENTRIES = 64
const DEFAULT_MAX_STRING_CHARS = 16 * 1024

/**
 * Marker left in the middle of a value that was cut down to a head and a tail.
 *
 * Collection and upload both truncate, and they used to do it independently:
 * collection kept only the head, then the uploader took a "head and tail" of
 * that — so the tail a reader saw in the cloud was the middle of the original,
 * presented as its end, and the omitted count described the wrong string. The
 * two sides now share this format, and the uploader narrows the two halves
 * separately instead of slicing across them.
 */
export const TRACE_TRUNCATION_MARKER_PREFIX = "\n...[trace truncated: omitted "
export const TRACE_TRUNCATION_MARKER_SUFFIX = " chars]...\n"

const TRACE_TRUNCATION_MARKER_PATTERN = /\n\.\.\.\[trace truncated: omitted (\d+) chars\]\.\.\.\n/

export interface SplitTruncatedText {
  head: string
  tail: string
  omitted: number
}

/** Split a value this module truncated back into its head, tail and omitted count. */
export function splitTruncatedText(value: string): SplitTruncatedText | undefined {
  const match = TRACE_TRUNCATION_MARKER_PATTERN.exec(value)
  if (!match || match.index < 0) return undefined
  return {
    head: value.slice(0, match.index),
    tail: value.slice(match.index + match[0].length),
    omitted: Number.parseInt(match[1], 10) || 0
  }
}

function joinTruncatedText(head: string, tail: string, omitted: number): string {
  return `${head}${TRACE_TRUNCATION_MARKER_PREFIX}${omitted}${TRACE_TRUNCATION_MARKER_SUFFIX}${tail}`
}

/**
 * The marker itself has to fit inside maxChars, or the caller's own head-only
 * cut lands past the marker and takes the tail off again — which is the exact
 * failure this function exists to prevent. 12 digits covers any omitted count.
 */
const TRACE_TRUNCATION_MARKER_OVERHEAD =
  TRACE_TRUNCATION_MARKER_PREFIX.length + TRACE_TRUNCATION_MARKER_SUFFIX.length + 12

/**
 * Cut `value` to `maxChars` keeping both ends. The tail is a quarter of the
 * budget: enough that an error or a result's last lines survive, small enough
 * that the head still carries the shape of the content.
 */
export function truncateKeepingEnds(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const budget = Math.max(2, maxChars - TRACE_TRUNCATION_MARKER_OVERHEAD)
  const headChars = Math.max(1, Math.floor(budget * 0.75))
  const tailChars = Math.max(1, budget - headChars)

  const existing = splitTruncatedText(value)
  if (existing) {
    // Already split once. Narrow each half on its own so the tail stays the
    // real tail, and carry the original omitted count forward.
    const head = existing.head.slice(0, headChars)
    const tail = existing.tail.slice(-tailChars)
    const omitted =
      existing.omitted + (existing.head.length - head.length) + (existing.tail.length - tail.length)
    return joinTruncatedText(head, tail, omitted)
  }
  return joinTruncatedText(
    value.slice(0, headChars),
    value.slice(-tailChars),
    value.length - headChars - tailChars
  )
}

/**
 * Share of the collection pool reserved for the end of a turn. A quarter keeps
 * the head long enough to show how the work started while still covering the
 * last few steps, which is where the answer usually is.
 */
export const TRACE_TAIL_RESERVE_RATIO = 0.25

export const TRACE_COLLECTION_MAX_BYTES = 512 * 1024
export const TRACE_PERSISTED_MAX_BYTES = 1024 * 1024

export interface BoundedTelemetryOptions {
  maxBytes: number
  maxDepth?: number
  maxEntries?: number
  maxStringChars?: number
}

export interface BoundedTelemetryResult {
  value: unknown
  estimatedBytes: number
  truncated: boolean
}

function truncateString(
  value: string,
  maxChars: number,
  maxBytes: number
): {
  value: string
  bytes: number
  truncated: boolean
} {
  const charLimit = Math.max(0, Math.min(maxChars, maxBytes))
  let output = value.length > charLimit ? value.slice(0, charLimit) : value
  let bytes = Buffer.byteLength(output, "utf8")
  if (bytes > maxBytes) {
    output = output.slice(0, Math.max(0, Math.floor(charLimit / 4)))
    bytes = Buffer.byteLength(output, "utf8")
  }
  return { value: output, bytes, truncated: output.length < value.length }
}

/**
 * Project an arbitrary runtime value into a small, getter-free JSON shape.
 * Enumeration, depth, string and aggregate byte limits are all independent so
 * a trace side-channel can never retain an attacker-sized tool payload.
 */
export function boundTelemetryValue(
  input: unknown,
  options: BoundedTelemetryOptions
): BoundedTelemetryResult {
  let remaining = Math.max(0, options.maxBytes)
  let truncated = false
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxStringChars = options.maxStringChars ?? DEFAULT_MAX_STRING_CHARS
  const seen = new WeakSet<object>()

  const takeString = (value: string, limit = maxStringChars): string => {
    const result = truncateString(value, limit, remaining)
    remaining = Math.max(0, remaining - result.bytes)
    truncated ||= result.truncated
    return result.value
  }

  const visit = (value: unknown, depth: number): unknown => {
    if (remaining <= 0) {
      truncated = true
      return "[trace budget exhausted]"
    }
    if (typeof value === "string") return takeString(value)
    if (typeof value === "number") {
      remaining = Math.max(0, remaining - 16)
      return Number.isFinite(value) ? value : String(value)
    }
    if (typeof value === "boolean" || value === null) {
      remaining = Math.max(0, remaining - 5)
      return value
    }
    if (value === undefined) return undefined
    if (typeof value === "bigint") return takeString(`${value.toString()}n`, 128)
    if (typeof value === "symbol") return takeString(value.toString(), 256)
    if (typeof value === "function") {
      let name = "anonymous"
      try {
        name = value.name || name
      } catch {
        // Proxy functions may reject property access.
      }
      return takeString(`[Function ${name}]`, 256)
    }
    if (typeof value !== "object") return takeString(String(value), 256)
    if (seen.has(value)) return "[Circular]"
    if (depth >= maxDepth) {
      truncated = true
      return "[depth limit]"
    }
    seen.add(value)

    try {
      if (value instanceof Error) {
        return {
          name: takeString(value.name, 256),
          message: takeString(value.message),
          stack: takeString(value.stack ?? "", maxStringChars)
        }
      }
      if (value instanceof Date) return takeString(value.toISOString(), 64)
      if (value instanceof RegExp || value instanceof URL) return takeString(String(value), 1024)
      if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`
      if (ArrayBuffer.isView(value)) return `[Binary view ${value.byteLength} bytes]`
      if (Array.isArray(value)) {
        const count = Math.min(value.length, maxEntries)
        const output: unknown[] = []
        for (let index = 0; index < count && remaining > 0; index += 1) {
          output.push(visit(value[index], depth + 1))
          remaining = Math.max(0, remaining - 2)
        }
        if (value.length > count) truncated = true
        return output
      }

      const output: Record<string, unknown> = {}
      let count = 0
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue
        if (key === "__proto__" || key === "prototype" || key === "constructor") continue
        if (count >= maxEntries || remaining <= 0) {
          truncated = true
          break
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        const boundedKey = takeString(key, 256)
        output[boundedKey] =
          descriptor && "value" in descriptor
            ? visit(descriptor.value, depth + 1)
            : "[Getter omitted]"
        remaining = Math.max(0, remaining - 4)
        count += 1
      }
      return output
    } catch {
      truncated = true
      return "[Unserializable value]"
    }
  }

  let value: unknown
  try {
    value = visit(input, 0)
  } catch {
    truncated = true
    value = "[Unserializable value]"
  }
  return {
    value,
    estimatedBytes: Math.max(0, options.maxBytes - remaining),
    truncated
  }
}

/**
 * Truncate a first-party scalar field without touching the shared collection
 * budget.
 *
 * Top-level trace fields — identity, org path, ids, model name, error message —
 * are produced by this app, not by tools or models, so they can never be the
 * source of trace bloat that the budget exists to contain. They must also never
 * be replaced by a truncation placeholder: downstream analytics group, filter
 * and de-duplicate on their exact values, so a placeholder does not read as
 * "missing", it reads as a real user named "[trace budget exhausted]".
 */
export function clampText(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value
}

export class TraceCollectionBudget {
  private remainingBytes: number

  /**
   * Bytes held back for whatever turns out to be the end of the turn. Taken out
   * of the same pool, not added to it: the trace's size ceiling is unchanged,
   * the spend is just no longer entirely front-loaded.
   */
  readonly tailReserveBytes: number

  constructor(maxBytes = TRACE_COLLECTION_MAX_BYTES) {
    // Leave room for the fixed field names and punctuation that wrap the
    // budgeted containers. Top-level scalars are not funded from here — they
    // use clampText and are bounded by their own nature.
    const pool = Math.max(0, maxBytes - 32 * 1024)
    this.tailReserveBytes = Math.floor(pool * TRACE_TAIL_RESERVE_RATIO)
    this.remainingBytes = pool - this.tailReserveBytes
  }

  get remaining(): number {
    return this.remainingBytes
  }

  canAdd(minimumBytes = 64): boolean {
    return this.remainingBytes >= minimumBytes
  }

  /**
   * @param keepEnds for content fields (message text, tool results, assistant
   * text). Identifiers and timestamps must stay head-only — a marker spliced
   * into an id would corrupt it, and they never approach their limits anyway.
   */
  takeText(value: string, maxChars: number, keepEnds = false): string {
    // A drained budget must never turn a scalar into the "[trace budget
    // exhausted]" placeholder. boundTelemetryValue emits that marker for a
    // string input only when the budget is already at zero, and for a scalar
    // field the marker is indistinguishable from real content downstream — an
    // empty string is the only honest representation of "dropped".
    if (this.remainingBytes <= 0) return ""
    const result = boundTelemetryValue(keepEnds ? truncateKeepingEnds(value, maxChars) : value, {
      maxBytes: this.remainingBytes,
      maxStringChars: maxChars,
      maxDepth: 1,
      maxEntries: 1
    })
    this.remainingBytes = Math.max(0, this.remainingBytes - result.estimatedBytes)
    return typeof result.value === "string" ? result.value : ""
  }

  takeValue(value: unknown, maxBytes: number): unknown {
    // Same rule as takeText: a drained budget must not turn a whole value into
    // the "[trace budget exhausted]" placeholder. boundTelemetryValue emits
    // that marker to show where a nested value was cut, which is useful inside
    // a structure and actively wrong as the value itself — a node output that
    // became the marker rendered as the model's reply on the trace detail page.
    // Absent is the honest answer; the caller's own optional handling takes over.
    if (this.remainingBytes <= 0) return undefined
    const result = boundTelemetryValue(value, {
      maxBytes: Math.min(this.remainingBytes, maxBytes)
    })
    this.remainingBytes = Math.max(0, this.remainingBytes - result.estimatedBytes)
    return result.value
  }
}
