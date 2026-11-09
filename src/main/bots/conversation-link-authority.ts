import { BotError } from "../../shared/bots/contracts"
import { isLocalBotWork, type BotWorkItem } from "../../shared/bots/work"
import { matchesThreadIncarnation, type ThreadIncarnationRow } from "../services/thread-incarnation"
import { getLocalThreadRunLease } from "../agent/thread-run-lease"
import type { AgentRunExecutionContext } from "../agent/agent-run-service"

let lookup: ((threadId: string) => BotWorkItem | null) | undefined
type BotWorkIdentity = Pick<BotWorkItem, "id" | "botId" | "threadId" | "source" | "audienceKey" | "workspace" | "conversation">
/** Installed by the original local Host; no metadata or renderer field grants execution. */
export function setWorkConversationLookup(resolve: typeof lookup) {
  lookup = resolve
}
/** The Host's source remains authoritative in either UI; opening never changes its audience. */
export function verifyWorkThreadMetadata(
  work: BotWorkIdentity,
  metadata: Record<string, unknown>
): void {
  const source = work.source
  if (
    !isLocalBotWork(work) ||
    metadata.botId !== work.botId ||
    metadata.botHostId !== "local" ||
    metadata.botWorkId !== work.id ||
    metadata.botAudienceKey !== work.audienceKey ||
    metadata.botGroupId != null ||
    (metadata.botMockBindingId ?? null) !== (source?.bindingId ?? null) ||
    (source &&
      (metadata.botMockConversationId !== source.conversationId ||
        metadata.botMockGrantVersion !== source.grantVersion ||
        (metadata.botMockTransport != null && metadata.botMockTransport !== "im"))) ||
    typeof metadata.workspacePath !== "string" ||
    !metadata.workspacePath.trim() ||
    (work.workspace && metadata.workspacePath !== work.workspace.path)
  )
    throw new BotError("CONFLICT", "任务与原会话身份不一致，已停止以保护会话。")
}
export function verifyWorkConversationThread(
  work: BotWorkIdentity,
  row: ThreadIncarnationRow,
  metadata: Record<string, unknown>
): void {
  verifyWorkThreadMetadata(work, metadata)
  const link = work.conversation
  if (
    !link ||
    link.ref.kind !== "local_thread" ||
    !matchesThreadIncarnation(row, link.ref.incarnation) ||
    metadata.botLocalConversation !== true ||
    metadata.botWorkOrigin !== link.origin
  )
    throw new BotError("CONFLICT", "任务与原会话身份不一致，已停止以保护会话。")
}
export function assertWorkConversationEntry(
  threadId: string,
  row: ThreadIncarnationRow | null | undefined,
  metadata: Record<string, unknown>,
  context?: AgentRunExecutionContext
): void {
  const work = lookup?.(threadId)
  if (!work && metadata.botLocalConversation !== true) return
  if (!work || !row || (work.conversation && work.conversation.state !== "bound"))
    throw new BotError("CONFLICT", "任务会话正在关联或解除，请返回任务入口核对后继续。")
  if (work.conversation) verifyWorkConversationThread(work, row, metadata)
  const lease = getLocalThreadRunLease(threadId)
  if (
    context?.source !== "bot" ||
    context.localRunLease?.owner !== "bot" ||
    !lease ||
    lease.owner !== "bot" ||
    lease.runId !== context.localRunLease.runId
  )
    throw new BotError(
      "CONFLICT",
      "此会话已关联 Bot 任务，请使用任务会话发送；停止、完成和继续也由同一任务处理。"
    )
}
