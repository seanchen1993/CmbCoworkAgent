import type { BotGroupMessage } from "../../../shared/bots/contracts"
import { botSessionDate } from "./bot-message-date"

/** Grok groups adjacent messages by author; keep our original timeline identities and dates. */
export function botGroupMessageView(
  message: BotGroupMessage,
  previous?: BotGroupMessage,
  next?: BotGroupMessage
) {
  const date = botSessionDate(message.createdAt, previous?.createdAt ?? null)
  const continued = previous?.authorBotId === message.authorBotId && date === null
  const continues =
    next?.authorBotId === message.authorBotId &&
    botSessionDate(next.createdAt, message.createdAt) === null
  return {
    date,
    continued,
    showAuthor: Boolean(message.authorBotId) && !continued,
    showAvatar: Boolean(message.authorBotId) && !continues
  }
}
