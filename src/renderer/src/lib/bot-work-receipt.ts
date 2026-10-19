import type { ToolCall, ToolResult } from "@/types"

/** Only verified Runtime tool results produce a work navigation card, never assistant prose. */
export function botWorkReceipt(
  tool: ToolCall,
  result: Pick<ToolResult, "content" | "is_error">,
  botId: string
): { id: string; title: string; label: string } | null {
  if (
    result.is_error ||
    typeof result.content !== "string" ||
    result.content.length > 100000 ||
    !["bot_work_create", "bot_work_send", "bot_work_complete", "bot_work_continue"].includes(
      tool.name
    )
  )
    return null
  try {
    const value = JSON.parse(result.content)
    if (value?.kind !== "bot-work-receipt" || value.operation !== tool.name || !value.receipt)
      return null
    const work = tool.name === "bot_work_create" ? value.receipt.work : value.receipt
    const id = tool.name === "bot_work_send" ? work.workId : work.id
    if (work.botId !== botId || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      return null
    if (
      tool.name === "bot_work_create" &&
      (value.receipt.task?.workId !== id || value.receipt.task.threadId !== work.threadId)
    )
      return null
    return {
      id,
      title: typeof work.title === "string" ? work.title : "查看工作会话",
      label: {
        bot_work_create: "已交办工作",
        bot_work_send: "已接纳工作补充",
        bot_work_complete: "工作已完成",
        bot_work_continue: "已继续原工作"
      }[tool.name]!
    }
  } catch {
    return null
  }
}
