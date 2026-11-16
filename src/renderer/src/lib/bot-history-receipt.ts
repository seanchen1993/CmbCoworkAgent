import type { ToolCall, ToolResult } from "@/types"
import { parseBotWorkHistoryHref, type BotWorkHistoryPage } from "../../../shared/bots/work-history"
import { parseBotThreadHistoryHref, type BotOrdinaryThreadRef, type BotThreadHistoryPage } from "../../../shared/bots/thread-history"

export type BotHistoryPage = BotWorkHistoryPage | BotThreadHistoryPage

function sameThread(left: BotOrdinaryThreadRef, right: unknown): boolean {
  if (!right || typeof right !== "object") return false
  const ref = right as Partial<BotOrdinaryThreadRef>
  return ref.kind === "local_thread" && left.threadId === ref.threadId &&
    left.incarnation.token === ref.incarnation?.token &&
    left.incarnation.legacyCreatedAt === ref.incarnation?.legacyCreatedAt
}

/** Only successful Host search/read receipts receive source controls. */
export function botHistoryReceipt(
  tool: ToolCall,
  result?: Pick<ToolResult, "content" | "is_error">
): BotHistoryPage | null {
  if (
    !["bot_work_search", "bot_work_read", "bot_thread_read"].includes(tool.name) ||
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
      !Array.isArray(page?.entries) ||
      page.entries.length > 24
    )
      return null
    if (tool.name === "bot_thread_read") {
      if (typeof page.thread?.title !== "string" ||
          !["more", "incomplete", "exhausted"].includes(page.coverage)) return null
      // The returned identity must agree with both the actual read request and
      // every source. Opening still revalidates it through the existing Host resolver.
      if (!page.entries.every(entry => {
        const source = typeof entry?.href === "string" ? parseBotThreadHistoryHref(entry.href) : null
        return source && typeof entry.text === "string" &&
          (entry.role === "user" || entry.role === "assistant") && Number.isSafeInteger(entry.ordinal) &&
          source.messageId === entry.source?.messageId &&
          sameThread(source.conversation, tool.args?.conversation) &&
          sameThread(source.conversation, page.thread.conversation) &&
          sameThread(source.conversation, entry.source?.conversation)
      })) return null
      const messageId = typeof tool.args?.messageId === "string" ? tool.args.messageId.trim() : ""
      if (messageId && !page.entries.some(entry => entry.source.messageId === messageId)) return null
      return page
    }
    if (typeof page.work?.id !== "string" || typeof page.work.title !== "string") return null
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
