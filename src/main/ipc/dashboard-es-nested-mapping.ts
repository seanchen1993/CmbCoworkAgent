/**
 * Whether a failed dashboard query was rejected because `path` exists in some index of
 * the alias, but not as a nested field.
 *
 * The ES reason only survives deep in the cause chain: queryNode keeps the first 200
 * bytes of the error body as "ES 400: …", the worker flattens causes into plain objects
 * so they can be structured-cloned, and esQuery wraps the result once more. So causes are
 * read by `message`, not by `instanceof Error`.
 */
export function isNestedMappingError(error: unknown, path: string): boolean {
  const messages: string[] = []
  const seen = new Set<unknown>()
  let current = error
  while (current && typeof current === "object" && !seen.has(current) && messages.length < 8) {
    seen.add(current)
    const record = current as { message?: unknown; cause?: unknown }
    if (typeof record.message === "string") messages.push(record.message)
    current = record.cause
  }
  const text = messages.join(" ")
  return text.includes(path) && /nested.*(path|type)|not.*nested/i.test(text)
}
