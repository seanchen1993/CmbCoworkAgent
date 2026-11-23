import type { BotThreadOwner } from "../../shared/bots/conversation"
import { BotError } from "../../shared/bots/contracts"
import { getThreadCore } from "../db"
import { verifyWorkConversationThread } from "./conversation-link-authority"
import type { LocalBotHost } from "./host"

/** Reading a sidebar badge never exposes/binds a native work or starts its thread. */
export function botThreadOwners(
  host: LocalBotHost,
  threadIds: readonly string[]
): BotThreadOwner[] {
  return host.workOwnerCandidates(threadIds).flatMap(({ work, bot }) => {
    const row = getThreadCore(work.threadId)
    if (!row || (work.conversation && work.conversation.state !== "bound")) return []
    let metadata: Record<string, unknown>
    try {
      metadata = JSON.parse(row.metadata || "{}")
    } catch {
      return []
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return []
    if (work.conversation) {
      try {
        verifyWorkConversationThread(work, row, metadata)
      } catch (error) {
        if (error instanceof BotError && error.code === "CONFLICT") return []
        throw error
      }
    } else if (
      metadata.botId !== work.botId ||
      metadata.botWorkId !== work.id ||
      metadata.botHostId !== "local" ||
      metadata.botAudienceKey !== "desktop" ||
      metadata.botLocalConversation != null ||
      metadata.botGroupId != null ||
      metadata.botMockBindingId != null ||
      (work.workspace && metadata.workspacePath !== work.workspace.path)
    )
      return []
    return [
      { threadId: work.threadId, threadCreatedAt: Number(row.created_at), workId: work.id, bot,
        ...(work.working ? { working: true as const } : {}),
        ...(work.userControlled ? { userControlled: true as const } : {}) }
    ]
  })
}
