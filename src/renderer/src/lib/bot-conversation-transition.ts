import type { useThreadContext } from "./thread-context"
import { getQueuedModelContent } from "./queued-message-content"
import type { BotWorkConversationResolution } from "../../../shared/bots/conversation"

type Context = ReturnType<typeof useThreadContext>
/** Explicit association parks the original queue; it never converts queued text into a new run. */
export async function parkOrdinaryConversationQueue(context: Context, threadId: string) {
  context.initializeThread(threadId)
  const actions = context.getThreadActions(threadId),
    drafts = context.getThreadState(threadId).queuedMessages
  const ids = drafts.filter((d) => d.handoffRequestedAt).map((d) => d.id)
  if (ids.length) {
    const result = await window.api.agent.reconcileCurrentRunQueuedMessages(threadId, ids)
    if (result.pendingIds.length || result.injectedIds.length)
      throw new Error("原会话仍有已交接消息，请先等待处理完成。")
    for (const id of result.durableIds) actions.deleteQueuedMessage(id)
  }
  for (const draft of context.getThreadState(threadId).queuedMessages)
    actions.updateQueuedMessage(draft.id, {
      handoffRequestedAt: undefined,
      parkedForConversationLink: true
    })
  actions.setQueueAutoDrainSuppressed(true)
}
/** Resolve Bot receipts BEFORE unlink. Unknown handoffs stay parked even after renderer restart. */
export async function parkLinkedConversationQueue(
  context: Context,
  link: BotWorkConversationResolution
) {
  const { threadId } = link.work,
    actions = context.getThreadActions(threadId)
  const drafts = context.getThreadState(threadId).queuedMessages
  for (let offset = 0; offset < drafts.length; offset += 32) {
    const batch = drafts.slice(offset, offset + 32),
      checks = await Promise.all(
        batch
          .filter((d) => d.handoffRequestedAt)
          .map(async (d) => {
            const hash = new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(getQueuedModelContent(d, "bot").trim())
              )
            )
            return {
              requestId: d.id,
              messageHash: Array.from(hash, (n) => n.toString(16).padStart(2, "0")).join("")
            }
          })
      )
    const receipts = checks.length
      ? await window.api.bots.requestReceipts(link.bot.id, checks, link.work.id)
      : []
    for (const draft of batch) {
      const receipt = receipts.find((r) => r.requestId === draft.id)
      if (draft.handoffRequestedAt && (!receipt || receipt.state === "conflict"))
        throw new Error("原发送回执尚未核对，已保留草稿；请稍后再解除关联。")
      if (receipt?.state === "accepted") actions.deleteQueuedMessage(draft.id)
      else
        actions.updateQueuedMessage(draft.id, {
          handoffRequestedAt: undefined,
          botHandoffTarget: undefined,
          parkedForConversationLink: true
        })
    }
  }
  actions.setQueueAutoDrainSuppressed(true)
}
