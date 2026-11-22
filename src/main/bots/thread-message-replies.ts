import { BotError, type BotMessageReply } from "../../shared/bots/contracts"
import type { LocalBotHost } from "./host"
import type { ThreadIncarnationRow } from "../services/thread-incarnation"
import { verifyWorkConversationThread } from "./conversation-link-authority"

/** Keep search's visible-body projection scoped to the Host's actual conversation. */
export function createBotThreadReplyResolver(
  threadId: string,
  row: ThreadIncarnationRow,
  metadata: Record<string, unknown>,
  host: Pick<LocalBotHost, "getBot" | "getWork" | "messageOrigins">
):
  | ((
      messageIds: string[]
    ) => ReadonlyMap<string, Pick<BotMessageReply, "id" | "ordinal" | "role">>)
  | undefined {
  if (
    metadata.botHostId !== "local" ||
    typeof metadata.botId !== "string" ||
    metadata.botGroupId != null
  )
    return undefined
  let workId: string | undefined
  let botId: string
  try {
    const bot = host.getBot(metadata.botId)
    botId = bot.id
    if (bot.threadId !== threadId) {
      if (typeof metadata.botWorkId !== "string") return undefined
      const work = host.getWork(botId, metadata.botWorkId)
      if (work.botId !== botId || work.threadId !== threadId) return undefined
      if (work.conversation) {
        if (work.conversation.state !== "bound") return undefined
        verifyWorkConversationThread(work, row, metadata)
      }
      workId = work.id
    }
  } catch (error) {
    if (error instanceof BotError && error.code === "NOT_FOUND") return undefined
    throw error
  }
  // One batched lookup per bounded search window, never one query per message.
  return (messageIds) =>
    new Map(
      host
        .messageOrigins(botId, messageIds, undefined, workId)
        .flatMap(({ requestId, origin }) =>
          origin.kind === "user" && origin.replyTo ? [[requestId, origin.replyTo]] : []
        )
    )
}
