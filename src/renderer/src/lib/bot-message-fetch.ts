import type { CoworkBotAPI } from "../../../shared/bot-api"
import { BotDomainError } from "../../../shared/bot-types"
import { BOT_MESSAGE_PAGE_SIZE } from "./bot-message-history"

type BotMessagePageInput = Parameters<CoworkBotAPI["messages"]>[0]
const pageLimits = new WeakMap<CoworkBotAPI["messages"], Map<string, number>>()
const MAX_PAGE_LIMIT_HINTS = 32

/** Retry only a rejected read whose response exceeded the Host frame budget.
 * The effective limit travels with the page, so a short adaptive page never conceals
 * remaining durable rows. Network errors are passed through without another request.
 */
export async function fetchBotMessagePage(
  read: CoworkBotAPI["messages"],
  input: BotMessagePageInput
) {
  const key = JSON.stringify([input.conversationId, input.threadRootId ?? null])
  const hints = pageLimits.get(read) ?? new Map<string, number>()
  pageLimits.set(read, hints)
  let limit = Math.min(input.limit ?? BOT_MESSAGE_PAGE_SIZE, hints.get(key) ?? Infinity)
  let reduced = false
  for (;;) {
    try {
      const messages = await read({ ...input, limit })
      if (reduced || hints.has(key)) {
        // Remember only rejected oversized pages, not ordinary half-pages around a search
        // target. The bounded LRU prevents every subsequent page repeating the same failure.
        const remembered = reduced ? Math.min(hints.get(key) ?? Infinity, limit) : hints.get(key)!
        hints.delete(key)
        hints.set(key, remembered)
        if (hints.size > MAX_PAGE_LIMIT_HINTS) hints.delete(hints.keys().next().value!)
      }
      return { messages, limit }
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "response_too_large"
      )
        throw error
      if (limit <= 1)
        throw new BotDomainError(
          "response_too_large",
          "这条消息超过后台传输上限，无法完整显示；请缩小内容或改用文件附件。"
        )
      limit = Math.max(1, Math.floor(limit / 2))
      reduced = true
    }
  }
}
