import { z } from "zod"
import { isBotMessageReply } from "../../../shared/bots/message-reply"
import type { useThreadContext } from "./thread-context"
import {
  botDraftContentSchema,
  loadBotDraftRecord,
  saveBotDraftRecord,
  pruneBotDraftRecords
} from "./bot-draft-storage"

type DraftContext = Pick<
  ReturnType<typeof useThreadContext>,
  "initializeThread" | "getThreadState" | "getThreadActions" | "subscribeToThreadState"
>
const prefix = "cmb-bot-conversation-draft-v1:"
const schema = botDraftContentSchema.extend({
  version: z.literal(1),
  replyTo: z
    .custom<import("../../../shared/bots/contracts").BotMessageReply>(isBotMessageReply)
    .nullable()
    .optional()
})
const key = (hostId: string, botId: string) => prefix + JSON.stringify([hostId, botId])

export function loadBotConversationDraft(hostId: string, botId: string) {
  return loadBotDraftRecord(key(hostId, botId), schema)
}

export function restoreBotConversationDraft(
  context: DraftContext,
  hostId: string,
  botId: string,
  threadId: string
): string | null {
  // The original initializer restores its persisted queue only before a state
  // exists. Restore that queue before draft actions create a default state.
  context.initializeThread(threadId)
  const current = context.getThreadState(threadId)
  if (current.draftInput || current.draftAttachments.length || current.draftBotReplyTo) return null
  const saved = loadBotConversationDraft(hostId, botId)
  if (saved.error) return saved.error
  if (saved.draft) {
    const actions = context.getThreadActions(threadId)
    actions.setDraftInput(saved.draft.text)
    actions.setDraftAttachments(saved.draft.attachments)
    if (saved.draft.replyTo) actions.setDraftBotReplyTo(saved.draft.replyTo)
  }
  return null
}

export function saveBotConversationDraft(
  context: DraftContext,
  hostId: string,
  botId: string,
  threadId: string
): string | null {
  const current = context.getThreadState(threadId)
  return saveBotDraftRecord(
    key(hostId, botId),
    {
      version: 1 as const,
      text: current.draftInput,
      attachments: current.draftAttachments,
      replyTo: current.draftBotReplyTo ?? null
    },
    schema,
    !current.draftInput && !current.draftAttachments.length && !current.draftBotReplyTo
  )
}

/** Observe only draft changes in the original store; token/stream updates never write storage. */
export function bindBotConversationDraft(
  context: DraftContext,
  hostId: string,
  botId: string,
  threadId: string,
  onError: (error: string | null) => void
): () => void {
  const restoreError = restoreBotConversationDraft(context, hostId, botId, threadId)
  let {
    draftInput: previousText,
    draftAttachments: previousAttachments,
    draftBotReplyTo: previousReply
  } = context.getThreadState(threadId)
  const save = () => onError(saveBotConversationDraft(context, hostId, botId, threadId))
  if (restoreError) onError(restoreError)
  else save()
  return context.subscribeToThreadState(threadId, () => {
    const current = context.getThreadState(threadId)
    if (
      current.draftInput === previousText &&
      current.draftAttachments === previousAttachments &&
      current.draftBotReplyTo === previousReply
    )
      return
    previousText = current.draftInput
    previousAttachments = current.draftAttachments
    previousReply = current.draftBotReplyTo
    save()
  })
}

let lastPruned = ""
export function pruneBotConversationDrafts(hostId: string, botIds: readonly string[]): void {
  const signature = JSON.stringify([hostId, [...botIds].sort()])
  if (signature === lastPruned) return
  pruneBotDraftRecords(prefix, hostId, botIds)
  lastPruned = signature
}
