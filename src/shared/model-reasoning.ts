const REASONING_KEYS = [
  "reasoning",
  "reasoning_content",
  "reasoning_text",
  "reasoning_details",
  "summary",
  "details",
  "delta"
] as const

// Keep provider-visible reasoning aligned with the existing trace assistant
// content cap. Upload sanitization applies the same assistant-content limit too.
export const TRACE_REASONING_MAX_CHARS = 2_000
const TRACE_REASONING_TRUNCATION_MARKER = "\n…(truncated)"

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Extract text only from a provider-explicit reasoning payload. This helper is
 * deliberately not applied to a model message's ordinary `content`: trace
 * reasoning must contain only reasoning/summary fields that the provider made
 * visible to the client, never inferred or hidden chain-of-thought.
 */
function extractReasoningTextUnsafe(
  value: unknown,
  depth = 0,
  maxChars = Number.POSITIVE_INFINITY
): string {
  if (depth > 6 || maxChars <= 0 || value === null || value === undefined) return ""
  if (typeof value === "string") return value.slice(0, maxChars)
  if (Array.isArray(value)) {
    let result = ""
    for (const item of value) {
      if (result.length >= maxChars) break
      result += extractReasoningTextUnsafe(item, depth + 1, maxChars - result.length)
    }
    return result
  }

  const record = asRecord(value)
  if (!record) return ""
  for (const key of [
    "text",
    "reasoning",
    "reasoning_content",
    "reasoning_text",
    "content"
  ] as const) {
    const text = extractReasoningTextUnsafe(record[key], depth + 1, maxChars)
    if (text) return text
  }
  for (const key of ["summary", "delta", "parts", "reasoning_details", "details"] as const) {
    const text = extractReasoningTextUnsafe(record[key], depth + 1, maxChars)
    if (text) return text
  }
  return ""
}

export function extractReasoningText(value: unknown, maxChars = Number.POSITIVE_INFINITY): string {
  try {
    return extractReasoningTextUnsafe(value, 0, maxChars)
  } catch {
    return ""
  }
}

/**
 * Read provider-visible reasoning from live or serialized LangChain messages.
 * Supports direct message fields, `kwargs`, and `additional_kwargs` without
 * ever falling back to normal assistant content.
 */
export function extractVisibleReasoning(
  messageOrKwargs: unknown,
  maxChars = Number.POSITIVE_INFINITY
): string {
  try {
    const root = asRecord(messageOrKwargs)
    if (!root) return ""
    const kwargs = asRecord(root.kwargs)
    const sources = [
      root,
      kwargs,
      asRecord(root.additional_kwargs),
      asRecord(kwargs?.additional_kwargs)
    ].filter((source): source is Record<string, unknown> => Boolean(source))

    for (const source of sources) {
      for (const key of REASONING_KEYS) {
        const text = extractReasoningTextUnsafe(source[key], 0, maxChars)
        if (text) return text
      }
    }
    return ""
  } catch {
    return ""
  }
}

export function truncateReasoningForTrace(
  value: string,
  maxChars = TRACE_REASONING_MAX_CHARS
): string {
  if (value.length <= maxChars) return value
  const contentLimit = Math.max(0, maxChars - TRACE_REASONING_TRUNCATION_MARKER.length)
  return `${value.slice(0, contentLimit)}${TRACE_REASONING_TRUNCATION_MARKER}`
}

export function isTraceReasoningTruncated(value: string): boolean {
  return value.endsWith(TRACE_REASONING_TRUNCATION_MARKER)
}

/** Merge provider streams that may alternate between deltas and cumulative snapshots. */
export function mergeStreamingReasoning(existing: string, incoming: string): string {
  if (!existing) return incoming
  if (!incoming) return existing
  if (incoming === existing || incoming.startsWith(existing)) return incoming
  if (existing.endsWith(incoming)) return existing

  const maxOverlap = Math.min(existing.length, incoming.length) - 1
  for (let overlap = maxOverlap; overlap >= 2; overlap -= 1) {
    if (existing.slice(-overlap) === incoming.slice(0, overlap)) {
      return `${existing}${incoming.slice(overlap)}`
    }
  }
  return `${existing}${incoming}`
}
