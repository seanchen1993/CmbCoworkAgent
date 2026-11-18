import { createHash } from "node:crypto"
import { BotError } from "../../shared/bots/contracts"
import type { BotWorkItem } from "../../shared/bots/work"
import { getThreadCore } from "../db"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { verifyWorkConversationThread } from "./conversation-link-authority"

export function verifiedWorkResultThread(work: BotWorkItem) {
  const row = getThreadCore(work.threadId)
  if (!row || work.source || work.audienceKey !== "desktop")
    throw new BotError("CONFLICT", "原桌面任务会话已变化。")
  const metadata = JSON.parse(row.metadata || "{}") as Record<string, unknown>
  const workspacePath = metadata?.workspacePath
  if (typeof workspacePath !== "string" || !workspacePath.trim())
    throw new BotError("CONFLICT", "原任务目录已变化。")
  if (work.conversation) {
    if (
      work.conversation.state !== "bound" ||
      work.conversation.ref.kind !== "local_thread" ||
      work.conversation.ref.threadId !== work.threadId
    )
      throw new BotError("CONFLICT", "原任务关联已变化。")
    verifyWorkConversationThread(work, row, metadata)
  } else if (
    metadata.botHostId !== "local" ||
    metadata.botId !== work.botId ||
    metadata.botWorkId !== work.id ||
    metadata.botAudienceKey !== "desktop" ||
    metadata.botGroupId != null ||
    metadata.botMockBindingId != null ||
    metadata.botLocalConversation === true ||
    (work.workspace && work.workspace.path !== workspacePath)
  ) {
    throw new BotError("CONFLICT", "原任务归属已变化。")
  }
  return {
    metadata,
    workspacePath,
    incarnation: createHash("sha256")
      .update(JSON.stringify(captureThreadIncarnation(row)))
      .digest("hex")
  }
}
