import type { Message } from "../main/types"

export const THREAD_MESSAGE_TEXT_LIMIT = 120_000
export const LEGACY_STRUCTURED_TRANSCRIPT_NOTICE = "[旧检查点结构化正文过大，已显示有界投影]"

/** Historical checkpoint projections appended this reserved diagnostic as the final text block. */
export function hasLegacyStructuredTranscriptNotice(content: readonly unknown[]): boolean {
  const last = content.at(-1)
  if (!last || typeof last !== "object" || Array.isArray(last)) return false
  const block = last as Record<string, unknown>
  return block.type === "text" && block.text === LEGACY_STRUCTURED_TRANSCRIPT_NOTICE &&
    Object.keys(block).length === 2
}
const THREAD_MESSAGE_BLOCK_LIMIT = 80
const THREAD_MESSAGE_BLOCK_TEXT_LIMIT = 60_000
const THREAD_MESSAGE_JSON_STRING_LIMIT = 20_000
const THREAD_MESSAGE_JSON_ARRAY_LIMIT = 100
const THREAD_MESSAGE_JSON_OBJECT_KEY_LIMIT = 80
const THREAD_MESSAGE_JSON_DEPTH_LIMIT = 6
const THREAD_MESSAGE_TOOL_CALL_LIMIT = 50

export function isMessageRole(value: unknown): value is Message["role"] {
  return value === "user" || value === "assistant" || value === "system" || value === "tool"
}

export function parseJsonValue(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.trim() === "") return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function truncateTranscriptString(value: string, limit: number, originalLength = value.length): string {
  if (originalLength <= limit) return value
  return `${value.slice(0, limit)}\n[truncated ${originalLength - limit} chars]`
}

export function normalizeFragmentedThreadMessageContent(parts: readonly string[]): string {
  let prefix = ""
  let length = 0
  for (const part of parts) {
    if (prefix.length < THREAD_MESSAGE_TEXT_LIMIT)
      prefix += part.slice(0, THREAD_MESSAGE_TEXT_LIMIT - prefix.length)
    length += part.length
  }
  return truncateTranscriptString(prefix, THREAD_MESSAGE_TEXT_LIMIT, length)
}

function summarizeJsonValue(value: unknown): unknown {
  if (typeof value === "string")
    return truncateTranscriptString(value, THREAD_MESSAGE_JSON_STRING_LIMIT)
  if (Array.isArray(value)) return `[Array ${value.length}]`
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === "object") return "[Object]"
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
  if (typeof value === "symbol") return value.toString()
  return value
}

function clampJsonForTranscript(
  value: unknown,
  options: {
    stringLimit: number
    arrayLimit: number
    objectKeyLimit: number
    depthLimit: number
    omitTruncationNotice?: boolean
  },
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  if (typeof value === "string") {
    return options.omitTruncationNotice
      ? value.slice(0, options.stringLimit)
      : truncateTranscriptString(value, options.stringLimit)
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
  if (typeof value === "symbol") return value.toString()
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"
  if (depth >= options.depthLimit) return summarizeJsonValue(value)

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const values = value
        .slice(0, options.arrayLimit)
        .map((item) => clampJsonForTranscript(item, options, depth + 1, seen))
      if (value.length > options.arrayLimit) {
        values.push(`[truncated ${value.length - options.arrayLimit} items]`)
      }
      return values
    }

    const output: Record<string, unknown> = {}
    const entries = Object.entries(value).slice(0, options.objectKeyLimit)
    for (const [key, nested] of entries) {
      output[key] = clampJsonForTranscript(nested, options, depth + 1, seen)
    }

    const keyCount = Object.keys(value).length
    if (keyCount > options.objectKeyLimit) {
      output.__truncated_keys = keyCount - options.objectKeyLimit
    }
    return output
  } finally {
    seen.delete(value)
  }
}

export function normalizeMessageContent(content: unknown): Message["content"] {
  return normalizeMessageContentWithinLimits(content, false)
}

// Omitted character counts vary between snapshots and repeated DB reads.
// Use the same storage bounds when verifying provenance of a saved draft.
export function getComparablePersistedMessageContent(content: unknown): Message["content"] {
  return normalizeMessageContentWithinLimits(content, true)
}

function normalizeMessageContentWithinLimits(
  content: unknown,
  omitTruncationNotice: boolean
): Message["content"] {
  if (typeof content === "string")
    return omitTruncationNotice
      ? content.slice(0, THREAD_MESSAGE_TEXT_LIMIT)
      : truncateTranscriptString(content, THREAD_MESSAGE_TEXT_LIMIT)
  if (Array.isArray(content)) {
    return content.slice(0, THREAD_MESSAGE_BLOCK_LIMIT).map((block) =>
      clampJsonForTranscript(block, {
        stringLimit: THREAD_MESSAGE_BLOCK_TEXT_LIMIT,
        arrayLimit: THREAD_MESSAGE_JSON_ARRAY_LIMIT,
        objectKeyLimit: THREAD_MESSAGE_JSON_OBJECT_KEY_LIMIT,
        depthLimit: THREAD_MESSAGE_JSON_DEPTH_LIMIT,
        omitTruncationNotice
      })
    ) as Message["content"]
  }
  return ""
}

function isToolCallRecord(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function clampToolCalls(value: unknown): Message["tool_calls"] {
  if (!Array.isArray(value)) return undefined
  return value
    .slice(0, THREAD_MESSAGE_TOOL_CALL_LIMIT)
    .filter(isToolCallRecord)
    .map((toolCall) =>
      clampJsonForTranscript(toolCall, {
        stringLimit: THREAD_MESSAGE_JSON_STRING_LIMIT,
        arrayLimit: THREAD_MESSAGE_JSON_ARRAY_LIMIT,
        objectKeyLimit: THREAD_MESSAGE_JSON_OBJECT_KEY_LIMIT,
        depthLimit: THREAD_MESSAGE_JSON_DEPTH_LIMIT
      })
    ) as Message["tool_calls"]
}

function jsonValueNeedsTranscriptClamp(
  value: unknown,
  options: {
    stringLimit: number
    arrayLimit: number
    objectKeyLimit: number
    depthLimit: number
  },
  depth = 0
): boolean {
  if (typeof value === "string") return value.length > options.stringLimit
  if (!value || typeof value !== "object") return false
  if (depth >= options.depthLimit) return true
  if (Array.isArray(value)) {
    return (
      value.length > options.arrayLimit ||
      value
        .slice(0, options.arrayLimit)
        .some((nested) => jsonValueNeedsTranscriptClamp(nested, options, depth + 1))
    )
  }
  const entries = Object.entries(value)
  return (
    entries.length > options.objectKeyLimit ||
    entries
      .slice(0, options.objectKeyLimit)
      .some(([, nested]) => jsonValueNeedsTranscriptClamp(nested, options, depth + 1))
  )
}

export function messageContentNeedsTranscriptClamp(content: unknown): boolean {
  if (typeof content === "string") return content.length > THREAD_MESSAGE_TEXT_LIMIT
  if (!Array.isArray(content)) return content !== undefined && content !== null
  if (content.length > THREAD_MESSAGE_BLOCK_LIMIT) return true
  return content.some((block) =>
    jsonValueNeedsTranscriptClamp(block, {
      stringLimit: THREAD_MESSAGE_BLOCK_TEXT_LIMIT,
      arrayLimit: THREAD_MESSAGE_JSON_ARRAY_LIMIT,
      objectKeyLimit: THREAD_MESSAGE_JSON_OBJECT_KEY_LIMIT,
      depthLimit: THREAD_MESSAGE_JSON_DEPTH_LIMIT
    })
  )
}

export function toolCallsNeedTranscriptClamp(toolCalls: unknown): boolean {
  if (!Array.isArray(toolCalls)) return toolCalls !== undefined && toolCalls !== null
  if (toolCalls.length > THREAD_MESSAGE_TOOL_CALL_LIMIT) return true
  return toolCalls.some(
    (toolCall) =>
      !isToolCallRecord(toolCall) ||
      jsonValueNeedsTranscriptClamp(toolCall, {
        stringLimit: THREAD_MESSAGE_JSON_STRING_LIMIT,
        arrayLimit: THREAD_MESSAGE_JSON_ARRAY_LIMIT,
        objectKeyLimit: THREAD_MESSAGE_JSON_OBJECT_KEY_LIMIT,
        depthLimit: THREAD_MESSAGE_JSON_DEPTH_LIMIT
      })
  )
}
