import type { useThreadContext } from "./thread-context"
import type { QueuedMessage } from "../types"
import { useBotViewStore } from "@/components/bots/view-store"
import { getQueuedBotMessageInput } from "./queued-message-content"
import { canonicalBotMessageInput } from "../../../shared/bots/message-mentions"
import type {
  BotConversationClient,
  BotConversationTransitionRequest,
  BotWorkConversationResolution
} from "../../../shared/bots/conversation"
import type { BotOrdinaryThreadRef } from "../../../shared/bots/thread-history"
import { assertBotNonTeamConversation } from "../../../shared/bots/team-policy"
import { botErrorMessage } from "./bot-error-message"
import { matchesBotThreadDraftRef, preserveLinkComposerDraft, preserveUnlinkComposerDraft } from "./bot-conversation-draft"
import { applyCommittedBotWorkDeletion, applyCommittedThreadDeletion } from "./store"
import {
  cleanupDeletedThreadIfResident,
  runBestEffortCommittedDeletionCleanups
} from "./thread-group-deletion"

type Context = ReturnType<typeof useThreadContext>
type FinishTransition = NonNullable<BotConversationClient["finishTransition"]>
export type BotConversationDeletionRequest = Extract<
  BotConversationTransitionRequest,
  { action: "delete" }
>

export function clearUnlinkedBotWorkSelection({ bot, work }: BotWorkConversationResolution): void {
  const views = useBotViewStore.getState()
  const activeWorkIdByBot = views.hosts[bot.hostId]?.activeWorkIdByBot
  if (activeWorkIdByBot?.[bot.id] === work.id)
    views.update(bot.hostId, { activeWorkIdByBot: { ...activeWorkIdByBot, [bot.id]: null } })
}

/** Prepare the same draft handoff before either association entry point commits. */
export async function prepareBotConversationLink(
  context: Context,
  ref: BotOrdinaryThreadRef,
  assertLive: () => void = () => {}
) {
  const row = await window.api.threads.get(ref.threadId)
  assertLive()
  if (!matchesBotThreadDraftRef(row, ref))
    throw new Error("原会话身份已变化，未改变本机草稿。")
  assertBotNonTeamConversation(row?.metadata)
  const rollbackQueue = await parkOrdinaryConversationQueue(context, ref.threadId, assertLive)
  let rollbackDraft: ReturnType<typeof preserveLinkComposerDraft>
  try {
    assertLive()
    rollbackDraft = preserveLinkComposerDraft(context, ref)
  } catch (error) {
    rollbackQueue()
    throw error
  }

  return async (commit: () => Promise<unknown>) => {
    try {
      assertLive()
      await commit()
    } catch (error) {
      try {
        const latest = await window.api.threads.get(ref.threadId)
        // A lost reply can follow a committed link. Keep drafts parked until
        // the same native conversation is confirmed to remain unbound.
        if (matchesBotThreadDraftRef(latest, ref) && latest?.metadata?.botLocalConversation !== true) {
          rollbackQueue()
          rollbackDraft?.()
        }
      } catch (cause) {
        console.warn("[Bots] Failed to check the saved draft after a conversation link error:", cause)
      }
      throw error
    }
  }
}

export async function completeBotConversationTransition(
  context: Context,
  request: Exclude<BotConversationTransitionRequest, BotConversationDeletionRequest>,
  finish: FinishTransition,
  refresh: () => Promise<void>,
  signal?: AbortSignal
) {
  const assertLive = () => signal?.throwIfAborted()
  const ref = request.action === "link" ? {
    kind: "local_thread" as const, threadId: request.threadId, incarnation: request.incarnation
  } : undefined
  let commitLink: Awaited<ReturnType<typeof prepareBotConversationLink>> | undefined
  let unlinkDraft: Awaited<ReturnType<typeof parkLinkedConversationQueue>>
  try {
    if (ref) {
      commitLink = await prepareBotConversationLink(context, ref, assertLive)
    } else if (request.action === "unlink") {
      unlinkDraft = await parkLinkedConversationQueue(context, request.link, request.unexposedRef)
    }
  } catch (error) {
    if (signal?.aborted) return
    await finish(request.id, botErrorMessage(error).slice(0, 1000))
    return
  }
  if (commitLink) await commitLink(() => finish(request.id))
  else {
    try {
      await finish(request.id)
    } catch (error) {
      if (unlinkDraft && request.action === "unlink" && request.unexposedRef) {
        try {
          const latest = await window.api.threads.get(request.threadId)
          // A lost reply can follow a committed unlink. Keep the copy for the ordinary composer.
          if (matchesBotThreadDraftRef(latest, request.unexposedRef) &&
              latest?.metadata?.botWorkId === request.link.work.id)
            unlinkDraft.rollback()
        } catch (cause) {
          console.warn("[Bots] Failed to check the saved draft after an unlink error:", cause)
        }
      }
      throw error
    }
    if (request.action === "unlink") {
      clearUnlinkedBotWorkSelection(request.link)
      void context.getThreadActions(request.threadId).syncDurableTranscript().catch(() => undefined)
    }
  }
  try {
    unlinkDraft?.commit()
  } catch (error) {
    console.warn("[Bots] Failed to release the original work draft after unlink:", error)
  }
  try {
    await refresh()
  } catch (error) {
    console.warn("[Bots] Failed to refresh thread summaries after a conversation transition:", error)
  }
}

export async function completeBotConversationDeletion(
  context: Pick<Context, "getThreadStateSummaries" | "cleanupThread">,
  id: string,
  finish: FinishTransition
) {
  const outcome = await finish(id)
  if (!outcome) throw new Error("未收到删除结果，请核对原会话。")
  const { deletedThreadId, deletedWork, error } = outcome
  if (deletedThreadId) {
    applyCommittedThreadDeletion(deletedThreadId)
    runBestEffortCommittedDeletionCleanups([
      {
        label: "Failed to release deleted thread state",
        run: () =>
          cleanupDeletedThreadIfResident(
            deletedThreadId,
            context.getThreadStateSummaries(),
            context.cleanupThread
          )
      }
    ])
  }
  if (deletedWork) applyCommittedBotWorkDeletion(deletedWork)
  return error
}

function persist(update: (done: (error: string | null) => void) => void) {
  let error: string | null = "草稿尚未保存，未改变会话关联。"
  update((value) => {
    error = value
  })
  if (error) throw new Error(error)
}

function checkQueueUnchanged(context: Context, threadId: string, drafts: QueuedMessage[]) {
  if (context.getThreadState(threadId).queuedMessages !== drafts)
    throw new Error("待发送消息已变化，请检查草稿后重试。")
}

/** Explicit association parks the original queue; it never converts queued text into a new run. */
export async function parkOrdinaryConversationQueue(
  context: Context, threadId: string, assertLive: () => void = () => {}
) {
  assertLive()
  context.initializeThread(threadId, { requireQueuedMessages: true })
  const actions = context.getThreadActions(threadId)
  let drafts = context.getThreadState(threadId).queuedMessages
  if (drafts.some((draft) => draft.botHandoffTarget))
    throw new Error(
      "草稿仍保留此前 Bot 的发送身份，请先核对原任务结果；不要把未确认发送转到新的任务。确认后可删除旧草稿并明确发送新消息。"
    )
  const ids = drafts.filter((d) => d.handoffRequestedAt).map((d) => d.id)
  for (let offset = 0; offset < ids.length; offset += 32) {
    const result = await window.api.agent.reconcileCurrentRunQueuedMessages(
      threadId,
      ids.slice(offset, offset + 32)
    )
    assertLive()
    checkQueueUnchanged(context, threadId, drafts)
    if (result.pendingIds.length || result.injectedIds.length)
      throw new Error("原会话仍有已交接消息，请先等待处理完成。")
    for (const id of result.durableIds) persist((done) => actions.deleteQueuedMessage(id, done))
    drafts = context.getThreadState(threadId).queuedMessages
  }
  const parked: { original: QueuedMessage; written: QueuedMessage }[] = []
  const rollback = () => {
    for (const { original, written } of parked) {
      if (context.getThreadState(threadId).queuedMessages.find(d => d.id === original.id) !== written)
        continue
      persist(done => actions.updateQueuedMessage(original.id, {
        handoffRequestedAt: original.handoffRequestedAt,
        parkedForConversationLink: original.parkedForConversationLink
      }, done))
    }
  }
  try {
    for (const draft of drafts) {
      persist((done) => {
        actions.updateQueuedMessage(
          draft.id,
          {
            handoffRequestedAt: undefined,
            parkedForConversationLink: true
          },
          done
        )
        const written = context.getThreadState(threadId).queuedMessages.find(d => d.id === draft.id)
        if (written) parked.push({ original: draft, written })
      })
    }
  } catch (error) {
    rollback()
    throw error
  }
  // Parked items already cannot auto-drain. Leave the user's stop/suppression
  // state alone so a failed association cannot pause unrelated ordinary work.
  return rollback
}
/** Resolve Bot receipts BEFORE unlink. Unknown handoffs stay parked even after renderer restart. */
export async function parkLinkedConversationQueue(
  context: Context,
  link: BotWorkConversationResolution,
  unexposedRef?: BotOrdinaryThreadRef
) {
  const { threadId } = link.work
  if (unexposedRef) {
    const row = await window.api.threads.get(threadId)
    if (unexposedRef.threadId !== threadId || link.work.conversation || link.bot.hostId !== "local" ||
        row?.metadata?.botWorkId !== link.work.id || row.metadata?.botId !== link.bot.id ||
        row.metadata?.botLocalConversation != null ||
        !matchesBotThreadDraftRef(row, unexposedRef))
      throw new Error("原任务会话身份已变化，未改变本机草稿。")
  }
  context.initializeThread(threadId, { requireQueuedMessages: true })
  const actions = context.getThreadActions(threadId)
  const drafts = context.getThreadState(threadId).queuedMessages
  let currentQueue = drafts
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
                new TextEncoder().encode(canonicalBotMessageInput(input.message, input.mentions, input.inputFileIds, input.explicitSkill))
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
    checkQueueUnchanged(context, threadId, currentQueue)
    for (const draft of batch) {
      const receipt = receipts.find((r) => r.requestId === draft.id)
      // Absence is not proof that a send failed. Keep its original identity
      // across an unlink; native idle/version checks still decide the transition.
      if (draft.handoffRequestedAt && receipt?.state === "absent" && draft.botHandoffTarget)
        continue
      if (draft.handoffRequestedAt && receipt?.state !== "accepted")
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
    currentQueue = context.getThreadState(threadId).queuedMessages
  }
  const draftHandoff = preserveUnlinkComposerDraft(context, link, unexposedRef)
  actions.setQueueAutoDrainSuppressed(true)
  return draftHandoff
}
