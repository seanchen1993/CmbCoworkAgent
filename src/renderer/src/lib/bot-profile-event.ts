import type { ToolCall, ToolResult } from "@/types"

/** Derive the visible event from a successful host receipt, never a model's promise. */
export function botProfileEvent(
  tool: ToolCall,
  result: Pick<ToolResult, "content" | "is_error">
): string | null {
  if (
    !["bot_update_profile", "bot_create_teammate", "bot_update_teammate"].includes(tool.name) ||
    result.is_error
  )
    return null
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
    if (tool.name === "bot_create_teammate")
      return typeof value.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.id)
        ? `已创建 ${value.name}`
        : null
    if (tool.name === "bot_update_teammate")
      return typeof value.id === "string" &&
        value.id === tool.args.botId &&
        (tool.args.name || tool.args.instructions)
        ? `已更新 ${value.name} 的资料`
        : null
    if (typeof tool.args.name === "string")
      return `已重命名为 ${value.name}${typeof tool.args.instructions === "string" ? "，职责已更新" : ""}`
    return typeof tool.args.instructions === "string" ? "职责已更新" : null
  } catch {
    return null
  }
}
