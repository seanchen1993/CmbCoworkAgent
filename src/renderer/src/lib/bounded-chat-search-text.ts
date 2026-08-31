export const CHAT_SEARCH_DOCUMENT_TEXT_LIMIT = 256 * 1024

const CHAT_SEARCH_VALUE_DEPTH_LIMIT = 6
const CHAT_SEARCH_ARRAY_ENTRY_LIMIT = 256
const CHAT_SEARCH_OBJECT_KEY_LIMIT = 128

/**
 * Builds searchable plain text without ever JSON-stringifying an unbounded tool result. The
 * representation is intentionally JSON-like rather than valid JSON: search only needs field names
 * and values, while the hard character/entry/depth budgets keep opening Ctrl/Cmd+F responsive.
 */
export function buildBoundedChatSearchText(
  values: readonly unknown[],
  limit = CHAT_SEARCH_DOCUMENT_TEXT_LIMIT
): string {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : CHAT_SEARCH_DOCUMENT_TEXT_LIMIT
  if (normalizedLimit === 0) return ""

  const chunks: string[] = []
  const seen = new WeakSet<object>()
  let remaining = normalizedLimit

  const append = (value: string): void => {
    if (remaining <= 0 || !value) return
    const clipped = value.length <= remaining ? value : value.slice(0, remaining)
    chunks.push(clipped)
    remaining -= clipped.length
  }

  const visit = (value: unknown, depth: number): void => {
    if (remaining <= 0 || value === null || value === undefined) return
    if (typeof value === "string") {
      append(value)
      return
    }
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    ) {
      append(String(value))
      return
    }
    if (typeof value === "symbol" || typeof value === "function") return
    if (value instanceof Date) {
      const timestamp = value.getTime()
      if (Number.isFinite(timestamp)) append(value.toISOString())
      return
    }
    if (typeof value !== "object") return
    if (seen.has(value)) {
      append("[Circular]")
      return
    }
    if (depth >= CHAT_SEARCH_VALUE_DEPTH_LIMIT) {
      append("[Nested value]")
      return
    }

    seen.add(value)
    try {
      if (Array.isArray(value)) {
        const entryCount = Math.min(value.length, CHAT_SEARCH_ARRAY_ENTRY_LIMIT)
        for (let index = 0; index < entryCount && remaining > 0; index += 1) {
          if (index > 0) append("\n")
          try {
            visit(value[index], depth + 1)
          } catch {
            append("[Unreadable value]")
          }
        }
        if (value.length > entryCount) append("\n[Truncated array]")
        return
      }

      let keyCount = 0
      try {
        for (const key in value as Record<string, unknown>) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue
          if (keyCount >= CHAT_SEARCH_OBJECT_KEY_LIMIT || remaining <= 0) {
            append("\n[Truncated object]")
            break
          }
          if (keyCount > 0) append("\n")
          append(key)
          append(": ")
          try {
            visit((value as Record<string, unknown>)[key], depth + 1)
          } catch {
            append("[Unreadable value]")
          }
          keyCount += 1
        }
      } catch {
        append("[Unreadable object]")
      }
    } finally {
      seen.delete(value)
    }
  }

  for (let index = 0; index < values.length && remaining > 0; index += 1) {
    if (index > 0) append("\n")
    visit(values[index], 0)
  }
  return chunks.join("")
}
