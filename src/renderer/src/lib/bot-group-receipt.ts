import type { ToolCall, ToolResult } from "@/types"

export function botGroupReceipt(tool: ToolCall, result: Pick<ToolResult, "content" | "is_error">) {
  if (tool.name !== "bot_send_message" || result.is_error) return null
  try {
    const value = JSON.parse(String(result.content))
    if (
      value.kind !== "bot-group-message" ||
      typeof value.groupId !== "string" ||
      typeof value.messageId !== "string" ||
      !value.messageId ||
      (value.groupSource !== undefined &&
        value.groupSource !== "app" &&
        value.groupSource !== "zhaohu")
    )
      return null
    return {
      groupId: value.groupId as string,
      source: (value.groupSource ?? "app") as "app" | "zhaohu"
    }
  } catch {
    return null
  }
}
