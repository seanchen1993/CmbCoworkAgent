import { createHash } from "node:crypto"
import { BotError } from "../../shared/bots/contracts"
import { isLocalBotWork, type BotWorkItem } from "../../shared/bots/work"
import { getThreadCore } from "../db"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { verifyWorkConversationThread, verifyWorkThreadMetadata } from "./conversation-link-authority"

export function verifiedWorkResultThread(work: BotWorkItem) {
  const row = getThreadCore(work.threadId)
  if (!row || !isLocalBotWork(work))
    throw new BotError("CONFLICT", "原任务会话已变化。")
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
  } else {
    verifyWorkThreadMetadata(work, metadata)
    if (metadata.botLocalConversation === true) throw new BotError("CONFLICT", "原任务关联已变化。")
  }
  return {
    metadata,
    workspacePath,
    incarnation: createHash("sha256")
      .update(JSON.stringify(captureThreadIncarnation(row)))
      .digest("hex")
  }
}
