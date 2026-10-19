import type { ToolCall, ToolResult } from "@/types"
import type { BotExchange } from "../../../shared/bots/contracts"

export function exchangeMessages(exchanges: BotExchange[]) {
  return exchanges
    .flatMap((exchange) => [
      {
        id: `${exchange.taskId}:0`,
        author: exchange.sender,
        message: exchange.message,
        at: exchange.createdAt
      },
      ...(exchange.reply
        ? [
            {
              id: `${exchange.taskId}:1`,
              author: exchange.recipient,
              message: exchange.reply.message,
              at: exchange.reply.createdAt
            }
          ]
        : [])
    ])
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}

/** The dispatch ID comes from a successful host result, never from model tool arguments. */
export function delegatedTaskReceipt(
  tool: ToolCall,
  result: Pick<ToolResult, "content" | "is_error">
): { taskId: string; botId?: string; botName?: string } | null {
  if (tool.name !== "bot_delegate" || result.is_error) return null
  try {
    let value = result.content
    if (Array.isArray(value)) {
      value = value
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
    }
    if (typeof value === "string") value = JSON.parse(value)
    if (!value || typeof value !== "object" || !("taskId" in value)) return null
    const id = value.taskId
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null
    const receipt = value as Record<string, unknown>
    if (receipt.ok === false) return null
    return {
      taskId: id,
      ...(typeof receipt.botId === "string" ? { botId: receipt.botId } : {}),
      ...(typeof receipt.botName === "string" ? { botName: receipt.botName } : {})
    }
  } catch {
    return null
  }
}
