import { BotError } from "../../shared/bots/contracts"
import { AsyncLocalStorage } from "node:async_hooks"
import { isLocalBotWork, type BotWorkItem } from "../../shared/bots/work"
import { matchesThreadIncarnation, type ThreadIncarnationRow } from "../services/thread-incarnation"
import { getLocalThreadRunLease } from "../agent/thread-run-lease"
import type { AgentRunExecutionContext } from "../agent/agent-run-service"
import { hasOrdinaryBotConversationShape } from "./ordinary-thread-policy"
import { resolveAgentModeFromMetadata } from "../../shared/agent-mode-metadata"
import type { BotHistoryOwner } from "./history-input-projection"

let lookup: ((threadId: string) => BotWorkItem | null) | undefined
type BotWorkIdentity = BotHistoryOwner
type ThreadDeletionCheck = (
  threadId: string,
  row: ThreadIncarnationRow,
  metadata: Record<string, unknown>
) => void
const threadDeletionScope = new AsyncLocalStorage<ThreadDeletionCheck>()

export async function withBotThreadDeletionCheck<T>(
  check: ThreadDeletionCheck,
  action: () => Promise<T>
): Promise<T> {
  let active = true
  try {
    return await threadDeletionScope.run((...args) => {
      if (!active) throw new BotError("CONFLICT", "会话删除授权已结束。")
      check(...args)
    }, action)
  } finally {
    active = false
  }
}

export function assertScopedBotWorkThreadDeletion(
  threadId: string,
  row: ThreadIncarnationRow,
  metadata: Record<string, unknown>
): boolean {
  const check = threadDeletionScope.getStore()
  if (!check) return false
  check(threadId, row, metadata)
  return true
}
/** Installed by the original local Host; no metadata or renderer field grants execution. */
export function setWorkConversationLookup(resolve: typeof lookup) {
  lookup = resolve
}
export function findBotWorkThreadOwner(threadId: string): BotWorkItem | null {
  return lookup?.(threadId) ?? null
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
/** Native work can have a real thread before the first exposure creates a link. */
export function verifyWorkDeletionThread(
  work: BotHistoryOwner,
  row: ThreadIncarnationRow,
  metadata: Record<string, unknown>
): void {
  const link = work.conversation
  if (
    work.source ||
    work.audienceKey !== "desktop" ||
    (link &&
      (link.ref.kind !== "local_thread" ||
        link.ref.threadId !== work.threadId ||
        !matchesThreadIncarnation(row, link.ref.incarnation)))
  )
    throw new BotError("CONFLICT", "待删除工作与原会话身份不一致。")
  if (metadata.botLocalConversation === true) {
    verifyWorkConversationThread(work, row, metadata)
    return
  }
  if (link?.origin === "existing") {
    if (link.state !== "bound" && hasOrdinaryBotConversationShape(metadata)) return
  } else if (
    link?.state !== "bound" &&
    metadata.botId === work.botId &&
    metadata.botWorkId === work.id &&
    metadata.botHostId === "local" &&
    metadata.botAudienceKey === "desktop" &&
    metadata.botMockBindingId == null &&
    metadata.botGroupId == null &&
    metadata.botWorkOrigin == null &&
    typeof metadata.workspacePath === "string" &&
    metadata.workspacePath.trim() &&
    (!work.workspace || metadata.workspacePath === work.workspace.path)
  )
    return
  throw new BotError("CONFLICT", "待删除工作与原会话归属不一致。")
}

/** The work already owns its initialized thread, before its first exposure. */
export function verifyUnexposedWorkUnlinkThread(
  work: BotWorkItem, row: ThreadIncarnationRow & { thread_id: string }, metadata: Record<string, unknown>
): void {
  if (!work.threadInitialized || work.conversation || row.thread_id !== work.threadId ||
      metadata.botLocalConversation != null || resolveAgentModeFromMetadata(metadata) !== "normal")
    throw new BotError("CONFLICT", "原任务尚无可解除的本机会话关联。")
  verifyWorkDeletionThread(work, row, metadata)
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
