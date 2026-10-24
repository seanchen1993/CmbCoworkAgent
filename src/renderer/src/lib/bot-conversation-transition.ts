import type { useThreadContext } from "./thread-context"
import { getQueuedBotMessageInput } from "./queued-message-content"
import { canonicalBotMessageInput } from "../../../shared/bots/message-mentions"
import type { BotWorkConversationResolution } from "../../../shared/bots/conversation"

type Context = ReturnType<typeof useThreadContext>
function persist(update: (done: (error: string | null) => void) => void) {
  let error: string | null = "草稿尚未保存，未改变会话关联。"
  update((value) => {
    error = value
  })
  if (error) throw new Error(error)
}
/** Explicit association parks the original queue; it never converts queued text into a new run. */
export async function parkOrdinaryConversationQueue(context: Context, threadId: string) {
  context.initializeThread(threadId)
  const actions = context.getThreadActions(threadId),
    drafts = context.getThreadState(threadId).queuedMessages
  if (drafts.some((draft) => draft.botHandoffTarget))
    throw new Error(
      "草稿仍保留此前 Bot 的发送身份，请先核对原任务结果；不要把未确认发送转到新的任务。确认后可删除旧草稿并明确发送新消息。"
    )
  actions.setQueueAutoDrainSuppressed(true)
  const ids = drafts.filter((d) => d.handoffRequestedAt).map((d) => d.id)
  for (let offset = 0; offset < ids.length; offset += 32) {
    const result = await window.api.agent.reconcileCurrentRunQueuedMessages(
      threadId,
      ids.slice(offset, offset + 32)
    )
    if (result.pendingIds.length || result.injectedIds.length)
      throw new Error("原会话仍有已交接消息，请先等待处理完成。")
    for (const id of result.durableIds) persist((done) => actions.deleteQueuedMessage(id, done))
  }
  for (const draft of context.getThreadState(threadId).queuedMessages)
    persist((done) =>
      actions.updateQueuedMessage(
        draft.id,
        {
          handoffRequestedAt: undefined,
          parkedForConversationLink: true
        },
        done
      )
    )
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
  if (
    drafts.some(
      (draft) =>
        draft.botHandoffTarget &&
        (draft.botHandoffTarget.botId !== link.bot.id ||
          draft.botHandoffTarget.workId !== link.work.id)
    )
  )
    throw new Error("草稿属于此前的 Bot 任务，请先核对原发送记录，不能改用当前任务回执。")
  for (let offset = 0; offset < drafts.length; offset += 32) {
    const batch = drafts.slice(offset, offset + 32),
      checks = await Promise.all(
        batch
          .filter((d) => d.handoffRequestedAt)
          .map(async (d) => {
            const input = getQueuedBotMessageInput(d)
            const hash = new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(canonicalBotMessageInput(input.message, input.mentions))
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
      if (receipt?.state === "accepted")
        persist((done) => actions.deleteQueuedMessage(draft.id, done))
      else
        persist((done) =>
          actions.updateQueuedMessage(
            draft.id,
            {
              handoffRequestedAt: undefined,
              botHandoffTarget: undefined,
              parkedForConversationLink: true
            },
            done
          )
        )
    }
  }
  actions.setQueueAutoDrainSuppressed(true)
}
