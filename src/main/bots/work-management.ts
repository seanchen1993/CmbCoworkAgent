import { BotError } from "../../shared/bots/contracts"
import type { BotWorkItem } from "../../shared/bots/work"
import { getThreadCore, updateThread } from "../db"
import {
  requireThreadMutationLease,
  withThreadMutationLeaseLock,
  type ThreadMutationLease
} from "../ipc/thread-run-mutation-lock"
import { broadcastToRenderers } from "../agent/renderer-stream-mirror"
import { verifyWorkConversationThread } from "./conversation-link-authority"
import type { LocalBotHost } from "./host"
import { protectedBotHistoryTitle } from "./history-input-projection"

/** Rename through the same mutation guard as threads:update. Never acquire an execution lease. */
export async function renameBotWorkThread(
  host: LocalBotHost,
  work: BotWorkItem,
  commit: () => BotWorkItem,
  originalLease?: ThreadMutationLease
): Promise<BotWorkItem> {
  const current = () => {
    const latest = host.getWork(work.botId, work.id)
    if (
      latest.threadId !== work.threadId ||
      latest.audienceKey !== work.audienceKey ||
      (latest.conversation && latest.conversation.state !== "bound")
    )
      throw new BotError("CONFLICT", "任务关联已变化，请重新选择")
    return latest
  }
  const target = current()
  if (originalLease && originalLease.threadId !== target.threadId)
    throw new BotError("CONFLICT", "任务与原会话身份不一致，未修改会话名称")
  if (!originalLease && !getThreadCore(target.threadId)) {
    if (target.threadInitialized || target.conversation)
      throw new BotError("NOT_FOUND", "原任务会话不存在，不会创建替代历史")
    // The first execution will create its original thread with this title.
    return commit()
  }
  const lease = originalLease ?? requireThreadMutationLease(target.threadId)
  return withThreadMutationLeaseLock(lease, (row) => {
    const latest = current()
    const metadata = JSON.parse(row.metadata || "{}") as Record<string, unknown>
    if (latest.conversation) verifyWorkConversationThread(latest, row, metadata)
    else if (
      metadata.botId !== latest.botId ||
      metadata.botWorkId !== latest.id ||
      metadata.botHostId !== "local" ||
      metadata.botGroupId != null ||
      metadata.botAudienceKey !== latest.audienceKey ||
      (metadata.botMockBindingId ?? null) !== (latest.source?.bindingId ?? null) ||
      (latest.source &&
        (metadata.botMockConversationId !== latest.source.conversationId ||
          metadata.botMockGrantVersion !== latest.source.grantVersion)) ||
      (originalLease && (metadata.botLocalConversation != null || metadata.botWorkOrigin != null)) ||
      (latest.workspace && metadata.workspacePath !== latest.workspace.path)
    )
      throw new BotError("CONFLICT", "任务与原会话身份不一致，未修改会话名称")

    const renamed = commit()
    try {
      if (row.title !== renamed.title || metadata.title !== renamed.title) {
        if (
          !updateThread(row.thread_id, {
            title: renamed.title,
            metadata: JSON.stringify({ ...metadata, title: renamed.title,
              ...(row.title !== renamed.title ? protectedBotHistoryTitle(null) : {}) })
          })
        )
          throw new Error("原会话已不存在")
        broadcastToRenderers("threads:changed", undefined)
      }
    } catch (cause) {
      throw new BotError(
        "CONFLICT",
        `任务名称已保存，但原会话名称同步失败；请用同一请求重试。${cause instanceof Error ? cause.message : ""}`
      )
    }
    return renamed
  })
}
