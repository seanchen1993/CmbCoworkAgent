import { useAppStore } from "../store"
import { matchesBotThreadDraftRef } from "../bot-conversation-draft"
import { isManagedLocalWorkConversation } from "../thread-classification"
import type { ThreadActions } from "../thread-context"
import type { BotClient } from "../../../../shared/bots/contracts"
import type { Thread } from "../../types"
import type { BotWorkItem } from "../../../../shared/bots/work"

export function matchesBoundBotWorkThreadSummary(thread: Thread, work: BotWorkItem): boolean {
  const link = work.conversation, metadata = thread.metadata
  return link?.state === "bound" && link.ref.kind === "local_thread" &&
    thread.thread_id === work.threadId && thread.thread_id === link.ref.threadId &&
    new Date(thread.created_at).getTime() === link.ref.incarnation.legacyCreatedAt &&
    metadata?.botLocalConversation === true && metadata.botHostId === "local" &&
    metadata.botId === work.botId && metadata.botWorkId === work.id &&
    metadata.botAudienceKey === "desktop" && metadata.botWorkOrigin === link.origin
}

/** A work can open from the Bot task list without being in the first sidebar page. */
export async function ensureBotWorkThreadSummary(
  threadId: string,
  isCurrent: () => boolean,
  matches: (thread: Thread) => boolean = () => true
): Promise<void> {
  const hasCurrentSummary = () => useAppStore.getState().threads.some(
    thread => thread.thread_id === threadId && matches(thread)
  )
  if (hasCurrentSummary()) return
  const thread = await window.api.threads.get(threadId)
  if (!isCurrent()) return
  if (!thread || thread.thread_id !== threadId) throw new Error("任务原会话不存在，无法加载设置。")
  if (!matches(thread)) throw new Error("原任务关联已变化，无法加载设置。")
  // Do not overwrite a newer directory refresh, or retain transcript values in the sidebar.
  if (!hasCurrentSummary()) {
    useAppStore.getState().addThreadSummary({ ...thread, thread_values: {} })
  }
}

export async function resolveBotWorkThreadForNavigation(
  client: BotClient,
  work: BotWorkItem,
  isCurrent: () => boolean
): Promise<string | null> {
  if (!isCurrent()) return null
  if (client.hostId !== "local" || !client.conversations || work.source || work.audienceKey !== "desktop")
    throw new Error("此任务没有可打开的本机会话。")
  if (work.deletionPending || work.deletionCommitted)
    throw new Error("此任务正在删除或已删除，无法打开。")

  // The Host verifies or exposes the existing task thread. Opening it does not take control.
  const original = await client.conversations.expose(work.botId, work.id)
  if (!isCurrent()) return null
  const link = original.conversation
  const expectedRef = work.conversation?.ref
  if (
    original.botId !== work.botId || original.id !== work.id || original.threadId !== work.threadId ||
    original.source || original.audienceKey !== "desktop" || original.deletionPending || original.deletionCommitted ||
    link?.ref.kind !== "local_thread" || link.ref.threadId !== original.threadId ||
    (link.state !== "bound" && link.state !== "detached") ||
    (work.conversation?.state === "detached") !== (link.state === "detached")
  ) throw new Error("原会话身份已变化，无法打开。")

  const ref = link.ref
  await useAppStore.getState().loadThreads()
  if (!isCurrent()) return null
  await ensureBotWorkThreadSummary(ref.threadId, isCurrent, thread =>
    matchesBotThreadDraftRef(thread, ref) &&
    (!expectedRef || (expectedRef.kind === "local_thread" && matchesBotThreadDraftRef(thread, expectedRef))) &&
    (link.state === "detached" ||
      (isManagedLocalWorkConversation(thread) && matchesBoundBotWorkThreadSummary(thread, original)))
  )
  return isCurrent() ? ref.threadId : null
}

export function openBotWorkThreadChat(
  threadContext: { getThreadActions(threadId: string): Pick<ThreadActions, "setActiveTab"> },
  threadId: string
): Promise<void> {
  threadContext.getThreadActions(threadId).setActiveTab("agent")
  return useAppStore.getState().selectThread(threadId)
}
