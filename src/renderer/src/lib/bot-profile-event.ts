import type { ToolCall, ToolResult } from "@/types"

/** Derive the visible event from a successful host receipt, never a model's promise. */
export function botProfileEvent(
  tool: ToolCall,
  result: Pick<ToolResult, "content" | "is_error">
): string | null {
  if (tool.name !== "bot_update_profile" || result.is_error) return null
  try {
    let receipt = result.content
    if (Array.isArray(receipt)) {
      receipt = receipt
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
    }
    if (typeof receipt === "string") receipt = JSON.parse(receipt)
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null
    const value = receipt as Record<string, unknown>
    if (
      value.ok === false ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 80 ||
      typeof value.instructions !== "string"
    )
      return null
    if (typeof tool.args.name === "string")
      return `已重命名为 ${value.name}${typeof tool.args.instructions === "string" ? "，职责已更新" : ""}`
    return typeof tool.args.instructions === "string" ? "职责已更新" : null
  } catch {
    return null
  }
}
