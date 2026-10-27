import { z } from "zod"
import type { BotMessageMention } from "../../../shared/bots/contracts"
import { parseBotMessageMentions } from "../../../shared/bots/message-mentions"
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
  version: z.union([z.literal(1), z.literal(2)]),
  mentions: z.array(z.custom<BotMessageMention>()).optional(),
  replyTo: z
    .custom<import("../../../shared/bots/contracts").BotMessageReply>(isBotMessageReply)
    .nullable()
    .optional()
}).superRefine((draft, ctx) => {
  if (draft.version !== 2) return
  try { parseBotMessageMentions(draft.text, draft.mentions) }
  catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "提及草稿无效" }) }
})
const key = (hostId: string, botId: string, workId?: string) =>
  prefix + JSON.stringify(workId ? [hostId, botId, workId] : [hostId, botId])

export function loadBotConversationDraft(hostId: string, botId: string, workId?: string) {
  return loadBotDraftRecord(key(hostId, botId, workId), schema)
}

export function restoreBotConversationDraft(
  context: DraftContext,
  hostId: string,
  botId: string,
  threadId: string,
  workId?: string
): string | null {
  // The original initializer restores its persisted queue only before a state
  // exists. Restore that queue before draft actions create a default state.
  context.initializeThread(threadId)
  const current = context.getThreadState(threadId)
  if (current.draftInput || current.draftAttachments.length || current.draftBotReplyTo) return null
  const saved = loadBotConversationDraft(hostId, botId, workId)
  if (saved.error) return saved.error
  if (saved.draft) {
    const actions = context.getThreadActions(threadId)
    if (saved.draft.version === 2 && saved.draft.mentions?.length)
      actions.setDraftBotInput(saved.draft.text, saved.draft.mentions)
    else actions.setDraftInput(saved.draft.text)
    actions.setDraftAttachments(saved.draft.attachments)
    if (saved.draft.replyTo) actions.setDraftBotReplyTo(saved.draft.replyTo)
  }
  return null
}

export function saveBotConversationDraft(
  context: DraftContext,
  hostId: string,
  botId: string,
  threadId: string,
  workId?: string
): string | null {
  const current = context.getThreadState(threadId)
  return saveBotDraftRecord(
    key(hostId, botId, workId),
    {
      version: 2 as const,
      ...(current.draftBotMentions?.length ? { mentions: current.draftBotMentions } : {}),
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
  onError: (error: string | null) => void,
  workId?: string
): () => void {
  const restoreError = restoreBotConversationDraft(context, hostId, botId, threadId, workId)
  let {
    draftInput: previousText,
    draftAttachments: previousAttachments,
    draftBotReplyTo: previousReply,
    draftBotMentions: previousMentions
  } = context.getThreadState(threadId)
  const save = () => onError(saveBotConversationDraft(context, hostId, botId, threadId, workId))
  if (restoreError) onError(restoreError)
  else save()
  return context.subscribeToThreadState(threadId, () => {
    const current = context.getThreadState(threadId)
    if (
      current.draftInput === previousText &&
      current.draftAttachments === previousAttachments &&
      current.draftBotReplyTo === previousReply &&
      current.draftBotMentions === previousMentions
    )
      return
    previousText = current.draftInput
    previousAttachments = current.draftAttachments
    previousReply = current.draftBotReplyTo
    previousMentions = current.draftBotMentions
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
