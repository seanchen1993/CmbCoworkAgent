import type { ToolCall, ToolResult } from "@/types"
import { parseBotWorkHistoryHref, type BotWorkHistoryPage } from "../../../shared/bots/work-history"

/** Only successful Host search/read receipts receive source controls. */
export function botHistoryReceipt(
  tool: ToolCall,
  result?: Pick<ToolResult, "content" | "is_error">
): BotWorkHistoryPage | null {
  if (
    !["bot_work_search", "bot_work_read"].includes(tool.name) ||
    result?.is_error ||
    typeof result?.content !== "string" ||
    result.content.length > 160000
  )
    return null
  try {
    const value = JSON.parse(result.content)
    const page = value.receipt
    if (
      value.kind !== "bot-work-receipt" ||
      value.operation !== tool.name ||
      typeof page?.work?.id !== "string" ||
      typeof page.work.title !== "string" ||
      !Array.isArray(page.entries) ||
      page.entries.length > 24
    )
      return null
    if (
      !page.entries.every(
        (entry) =>
          typeof entry.text === "string" &&
          typeof entry.href === "string" &&
          parseBotWorkHistoryHref(entry.href)?.workId === page.work.id
      )
    )
      return null
    return page
  } catch {
    return null
  }
}
