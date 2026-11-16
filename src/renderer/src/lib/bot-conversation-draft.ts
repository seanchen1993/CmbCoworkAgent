import { z } from "zod"
import { LOCAL_BOT_HOST_ID, type BotMessageMention } from "../../../shared/bots/contracts"
import type { BotWorkConversationResolution } from "../../../shared/bots/conversation"
import type { BotOrdinaryThreadRef } from "../../../shared/bots/thread-history"
import { parseBotMessageMentions } from "../../../shared/bots/message-mentions"
import { isBotMessageReply } from "../../../shared/bots/message-reply"
import { MAX_ATTACHMENT_PICKER_FILES } from "../../../shared/file-attachment"
import type { useThreadContext } from "./thread-context"
import { isThreadRetired } from "./store"
import type { Thread } from "../types"
import {
  BOT_CONVERSATION_DRAFT_PREFIX,
  botConversationDraftKey,
  botThreadDraftKey,
  botDraftContentSchema,
  loadBotDraftRecord,
  saveBotDraftRecord,
  pruneBotDraftRecords
} from "./bot-draft-storage"

type DraftContext = Pick<
  ReturnType<typeof useThreadContext>,
  "initializeThread" | "getThreadState" | "getThreadActions" | "subscribeToThreadState"
>
const schema = botDraftContentSchema.extend({
  version: z.union([z.literal(1), z.literal(2)]),
  mentions: z.array(z.custom<BotMessageMention>()).optional(),
  skill: z.object({
    name: z.string().min(1).max(160),
    path: z.string().min(1).max(4096)
  }).optional(),
  builtinBrowser: z.boolean().optional(),
  workspaceFiles: z.array(z.object({
    id: z.string().min(1).max(4096),
    displayPath: z.string().min(1).max(4096),
    workspaceFilePath: z.string().min(1).max(4096),
    absolutePath: z.string().min(1).max(4096),
    workspaceKey: z.string().min(1).max(4096),
    filename: z.string().min(1).max(512),
    size: z.number().int().nonnegative().optional(),
    contentChars: z.number().int().nonnegative().optional()
  })).max(MAX_ATTACHMENT_PICKER_FILES).optional(),
  replyTo: z
    .custom<import("../../../shared/bots/contracts").BotMessageReply>(isBotMessageReply)
    .nullable()
    .optional()
}).superRefine((draft, ctx) => {
  if (draft.version !== 2) return
  try { parseBotMessageMentions(draft.text, draft.mentions) }
  catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "提及草稿无效" }) }
})
const threadSchema = z.object({
  incarnation: z.object({ token: z.string().min(1).nullable(), legacyCreatedAt: z.number().int() }),
  draft: schema
})

function sameIncarnation(a: BotOrdinaryThreadRef["incarnation"], b: BotOrdinaryThreadRef["incarnation"]): boolean {
  return a.token !== null || b.token !== null
    ? a.token !== null && a.token === b.token
    : a.legacyCreatedAt === b.legacyCreatedAt
}

export function workComposerDraftRef(
  hostId: string, botId: string, work: BotWorkConversationResolution["work"] | null | undefined
): BotOrdinaryThreadRef | undefined {
  const link = work?.conversation
  if (hostId === LOCAL_BOT_HOST_ID && work?.botId === botId && !work.source &&
      work.audienceKey === "desktop" && (link?.state === "bound" || link?.state === "detaching") &&
      link.ref.kind === "local_thread" && link.ref.threadId === work.threadId) return link.ref
  return undefined
}

/** Move only the known original work key. A failed write leaves the old record intact. */
export function migrateBotWorkDraft(botId: string, workId: string, ref: BotOrdinaryThreadRef): string | null {
  if (isThreadRetired(ref.threadId)) return "原会话已关闭，无法保留草稿。"
  const oldKey = botConversationDraftKey(LOCAL_BOT_HOST_ID, botId, workId)
  const old = loadBotDraftRecord(oldKey, schema)
  if (old.error || !old.draft) return old.error ?? null
  const key = botThreadDraftKey(ref.threadId)
  const error = saveBotDraftRecord(key, { incarnation: ref.incarnation, draft: old.draft }, threadSchema, false)
  if (error) return error
  return saveBotDraftRecord(oldKey, old.draft, schema, true)
}

/** A cold unlink can have an older work-key draft even when no composer is mounted. */
export function preserveUnlinkComposerDraft(
  context: DraftContext, link: BotWorkConversationResolution, unexposedRef?: BotOrdinaryThreadRef
) {
  const { bot, work } = link
  const ref = unexposedRef ?? workComposerDraftRef(bot.hostId, bot.id, work)
  if (!ref) return
  if (!unexposedRef) {
    const migrationError = migrateBotWorkDraft(bot.id, work.id, ref)
    if (migrationError) throw new Error(migrationError)
    const { draft, empty } = composerDraft(context, ref.threadId)
    if (!empty) writeThreadComposerDraft(ref, draft)
    return
  }
  // A failed native unlink leaves its work-key composer in use. Keep the
  // original until the detach is confirmed, with an exact-copy rollback.
  const { draft, empty } = composerDraft(context, ref.threadId)
  const stored = loadBotConversationDraft(bot.hostId, bot.id, work.id)
  if (stored.error) throw new Error(stored.error)
  const next = empty ? stored.draft : draft
  const storage = globalThis.localStorage
  if (!next || !storage) return
  const workKey = botConversationDraftKey(bot.hostId, bot.id, work.id)
  const threadKey = botThreadDraftKey(ref.threadId)
  const original = storage.getItem(workKey)
  const previous = storage.getItem(threadKey)
  writeThreadComposerDraft(ref, next)
  const written = storage.getItem(threadKey)
  return {
    commit() {
      if (original != null && storage.getItem(workKey) === original) storage.removeItem(workKey)
    },
    rollback() {
      if (storage.getItem(threadKey) !== written) return
      if (previous == null) storage.removeItem(threadKey)
      else storage.setItem(threadKey, previous)
    }
  }
}

export function matchesBotThreadDraftRef(row: Thread | null, ref: BotOrdinaryThreadRef): boolean {
  return Boolean(row && row.thread_id === ref.threadId && !isThreadRetired(ref.threadId) &&
    sameIncarnation(ref.incarnation, threadDraftIncarnation(row)))
}

export function threadDraftIncarnation(row: Thread): BotOrdinaryThreadRef["incarnation"] {
  const token = row.metadata?.cmb_thread_incarnation
  return {
    token: typeof token === "string" && token.length ? token : null,
    legacyCreatedAt: new Date(row.created_at).getTime()
  }
}

function writeThreadComposerDraft(ref: BotOrdinaryThreadRef, draft: z.infer<typeof schema>) {
  const error = saveBotDraftRecord(
    botThreadDraftKey(ref.threadId), { incarnation: ref.incarnation, draft }, threadSchema, false
  )
  if (error) throw new Error(error)
}

/** Save the existing composer before acknowledging a link, even when its chat is unmounted. */
export function preserveLinkComposerDraft(context: DraftContext, ref: BotOrdinaryThreadRef): (() => void) | undefined {
  const { draft, empty } = composerDraft(context, ref.threadId)
  if (empty) return
  const key = botThreadDraftKey(ref.threadId)
  const previous = loadBotDraftRecord(key, threadSchema)
  if (previous.error) throw new Error(previous.error)
  if (previous.draft && !sameIncarnation(previous.draft.incarnation, ref.incarnation))
    throw new Error("本机草稿属于其他会话身份，未改变原记录。")
  const storage = globalThis.localStorage
  const original = storage.getItem(key)
  const attachments = draft.attachments.some(file => !file.botInputId && !file.originalUnavailable)
    ? draft.attachments.map(file => file.botInputId || file.originalUnavailable
        ? file : { ...file, originalUnavailable: true as const })
    : draft.attachments
  writeThreadComposerDraft(ref, { ...draft, attachments })
  const written = storage.getItem(key)
  if (attachments !== draft.attachments)
    context.getThreadActions(ref.threadId).setDraftAttachments(attachments)
  if (written === original && attachments === draft.attachments) return
  // Leave a newer write or a completed deletion untouched.
  return () => {
    if (storage.getItem(key) !== written) return
    if (attachments !== draft.attachments && context.getThreadState(ref.threadId).draftAttachments === attachments)
      context.getThreadActions(ref.threadId).setDraftAttachments(draft.attachments)
    if (original === null) storage.removeItem(key)
    else storage.setItem(key, original)
  }
}

export function loadBotConversationDraft(hostId: string, botId: string, workId?: string) {
  return loadBotDraftRecord(botConversationDraftKey(hostId, botId, workId), schema)
}

export function restoreBotConversationDraft(
  context: DraftContext,
  hostId: string,
  botId: string,
  threadId: string,
  workId?: string
): string | null {
  return restoreDraft(context, threadId, () => loadBotConversationDraft(hostId, botId, workId))
}

function restoreDraft(context: DraftContext, threadId: string, load: () => ReturnType<typeof loadBotConversationDraft>): string | null {
  if (isThreadRetired(threadId)) return null
  // The original initializer restores its persisted queue only before a state
  // exists. Restore that queue before draft actions create a default state.
  context.initializeThread(threadId)
  const current = context.getThreadState(threadId)
  if (
    current.draftInput || current.draftAttachments.length || current.draftBotReplyTo ||
    current.draftMentionedWorkspaceFiles.length || current.draftSkill || current.draftBuiltinBrowser
  ) return null
  const saved = load()
  if (saved.error) return saved.error
  if (saved.draft) {
    const actions = context.getThreadActions(threadId)
    if (saved.draft.version === 2 && saved.draft.mentions?.length)
      actions.setDraftBotInput(saved.draft.text, saved.draft.mentions)
    else actions.setDraftInput(saved.draft.text)
    actions.setDraftAttachments(saved.draft.attachments)
    if (saved.draft.replyTo) actions.setDraftBotReplyTo(saved.draft.replyTo)
    if (saved.draft.workspaceFiles?.length) {
      actions.setDraftMentionedWorkspaceFiles(saved.draft.workspaceFiles)
    }
    if (saved.draft.skill) actions.setDraftSkill({ ...saved.draft.skill, restored: true })
    else if (saved.draft.builtinBrowser) actions.setDraftBuiltinBrowser(true)
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
  // Cleanup of a committed thread publishes an empty state even when its Bot
  // work still needs a retry. Only the work deletion receipt clears that draft.
  if (isThreadRetired(threadId)) return null
  const { draft, empty } = composerDraft(context, threadId)
  return saveBotDraftRecord(
    botConversationDraftKey(hostId, botId, workId),
    draft, schema, empty
  )
}

function composerDraft(context: DraftContext, threadId: string) {
  const current = context.getThreadState(threadId)
  const workspaceFiles = current.draftMentionedWorkspaceFiles
  const skill = current.draftSkill
  // Selecting a skill updates the two chips in sequence. Persist only the new selection.
  const builtinBrowser = current.draftBuiltinBrowser && !skill
  return {
    draft: {
      version: 2 as const,
      ...(current.draftBotMentions?.length ? { mentions: current.draftBotMentions } : {}),
      ...(workspaceFiles.length ? { workspaceFiles } : {}),
      ...(skill ? { skill: { name: skill.name, path: skill.path } } : {}),
      ...(builtinBrowser ? { builtinBrowser } : {}),
      text: current.draftInput,
      attachments: current.draftAttachments,
      replyTo: current.draftBotReplyTo ?? null
    },
    empty: !current.draftInput && !current.draftAttachments.length && !current.draftBotReplyTo &&
      !workspaceFiles.length && !skill && !builtinBrowser
  }
}

/** Observe only draft changes in the original store; token/stream updates never write storage. */
export function bindBotConversationDraft(
  context: DraftContext,
  hostId: string,
  botId: string,
  threadId: string,
  onError: (error: string | null) => void,
  workId?: string,
  ref?: BotOrdinaryThreadRef
): () => void {
  if (ref && workId && ref.threadId === threadId) {
    const error = migrateBotWorkDraft(botId, workId, ref)
    if (!error) return bindThreadDraft(context, ref, onError)
    // Keep editing and saving in the legacy key if migration could not complete.
    return bindDraft(context, threadId, () => restoreBotConversationDraft(context, hostId, botId, threadId, workId),
      () => saveBotConversationDraft(context, hostId, botId, threadId, workId), cause => onError(cause ?? error))
  }
  return bindDraft(context, threadId, () => restoreBotConversationDraft(context, hostId, botId, threadId, workId),
    () => saveBotConversationDraft(context, hostId, botId, threadId, workId), onError)
}

function bindDraft(
  context: DraftContext,
  threadId: string,
  restore: () => string | null,
  saveDraft: () => string | null,
  onError: (error: string | null) => void
) {
  const restoreError = restore()
  let {
    draftInput: previousText,
    draftAttachments: previousAttachments,
    draftMentionedWorkspaceFiles: previousWorkspaceFiles,
    draftBotReplyTo: previousReply,
    draftBotMentions: previousMentions,
    draftSkill: previousSkill,
    draftBuiltinBrowser: previousBuiltinBrowser
  } = context.getThreadState(threadId)
  const save = () => onError(saveDraft())
  if (restoreError) onError(restoreError)
  else save()
  return context.subscribeToThreadState(threadId, () => {
    const current = context.getThreadState(threadId)
    if (
      current.draftInput === previousText &&
      current.draftAttachments === previousAttachments &&
      current.draftMentionedWorkspaceFiles === previousWorkspaceFiles &&
      current.draftBotReplyTo === previousReply &&
      current.draftBotMentions === previousMentions &&
      current.draftSkill === previousSkill &&
      current.draftBuiltinBrowser === previousBuiltinBrowser
    )
      return
    previousText = current.draftInput
    previousAttachments = current.draftAttachments
    previousWorkspaceFiles = current.draftMentionedWorkspaceFiles
    previousReply = current.draftBotReplyTo
    previousMentions = current.draftBotMentions
    previousSkill = current.draftSkill
    previousBuiltinBrowser = current.draftBuiltinBrowser
    save()
  })
}

function bindThreadDraft(context: DraftContext, ref: BotOrdinaryThreadRef,
  onError: (error: string | null) => void, onConsumed?: () => void
) {
  const key = botThreadDraftKey(ref.threadId)
  let consumed = false
  return bindDraft(context, ref.threadId, () => restoreDraft(context, ref.threadId, () => {
    const stored = loadBotDraftRecord(key, threadSchema)
    if (stored.error) return { error: stored.error }
    return { draft: stored.draft && sameIncarnation(stored.draft.incarnation, ref.incarnation)
      ? stored.draft.draft : undefined }
  }), () => {
    if (consumed || isThreadRetired(ref.threadId)) return null
    const { draft, empty } = composerDraft(context, ref.threadId)
    const error = saveBotDraftRecord(key, { incarnation: ref.incarnation, draft }, threadSchema, empty)
    if (!error && empty && onConsumed) {
      consumed = true
      onConsumed()
    }
    return error
  }, onError)
}

export function hasBotThreadDraft(threadId: string): boolean {
  try { return globalThis.localStorage?.getItem(botThreadDraftKey(threadId)) != null }
  catch { return false }
}

/** Restore only a Bot-origin draft belonging to this now ordinary native thread. */
export function bindDetachedBotThreadDraft(
  context: DraftContext, threadId: string, row: Thread,
  onError: (error: string | null) => void, onConsumed: () => void
): (() => void) | undefined {
  if (row.thread_id !== threadId || row.metadata?.botId != null || row.metadata?.botWorkId != null ||
      row.metadata?.botLocalConversation === true ||
      isThreadRetired(threadId)) return
  const incarnation = threadDraftIncarnation(row)
  const stored = loadBotDraftRecord(botThreadDraftKey(threadId), threadSchema)
  if (stored.error) {
    onError(stored.error)
    return
  }
  if (!stored.draft || !sameIncarnation(stored.draft.incarnation, incarnation)) return
  return bindThreadDraft(context, { kind: "local_thread", threadId, incarnation }, onError, onConsumed)
}

let lastPruned = ""
export function pruneBotConversationDrafts(hostId: string, botIds: readonly string[]): void {
  const signature = JSON.stringify([hostId, [...botIds].sort()])
  if (signature === lastPruned) return
  pruneBotDraftRecords(BOT_CONVERSATION_DRAFT_PREFIX, hostId, botIds)
  lastPruned = signature
}
