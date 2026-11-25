export function extractPersistedMessageContent(content: unknown): string | unknown[] {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const blocks = content.filter((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return false
    const type = (block as { type?: unknown }).type
    return type === "text" || type === "image" || type === "tool_use" || type === "tool_result"
  })
  return blocks.length > 0 ? blocks : ""
}
