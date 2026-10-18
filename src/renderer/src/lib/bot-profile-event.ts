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
    let nameChanged = typeof tool.args.name === "string"
    let instructionsChanged = typeof tool.args.instructions === "string"
    if ("changes" in value) {
      const changes = value.changes
      if (
        !changes ||
        typeof changes !== "object" ||
        Array.isArray(changes) ||
        !("name" in changes) ||
        typeof changes.name !== "boolean" ||
        !("instructions" in changes) ||
        typeof changes.instructions !== "boolean"
      )
        return null
      nameChanged &&= changes.name
      instructionsChanged &&= changes.instructions
    }
    if (tool.name === "bot_update_teammate")
      return typeof value.id === "string" &&
        value.id === tool.args.botId &&
        (tool.args.name || tool.args.instructions)
        ? nameChanged || instructionsChanged
          ? `已更新 ${value.name} 的资料`
          : `${value.name} 的资料未变更`
        : null
    if (nameChanged) return `已重命名为 ${value.name}${instructionsChanged ? "，职责已更新" : ""}`
    if (instructionsChanged) return "职责已更新"
    return "changes" in value ? "资料未变更" : null
  } catch {
    return null
  }
}
