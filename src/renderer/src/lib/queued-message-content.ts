import type { QueuedMessage, SkillMetadata } from "@/types"
import { formatBotMessageReply } from "../../../shared/bots/message-reply"
import { BOT_BROWSER_PROMPT_PREFIX } from "../../../shared/user-input-transport"
import { parseBotMessageMentions } from "../../../shared/bots/message-mentions"
import type { BotMessageMention } from "../../../shared/bots/contracts"
import { parseBotInputFileIds } from "../../../shared/bots/input-files"
// Relative (not "@/") so this module stays importable from tsx unit tests, which
// don't resolve the "@/" path alias for runtime values. skill-marker has no
// imports of its own, so the chain stays alias-free.
import { formatSkillUseBlock, parseSkillUseBlock } from "../features/slash-commands/skill-marker"
import { findEnabledSkillSelection } from "./skill-ids"
import {
  formatBuiltinBrowserTranscriptMessage,
  formatBuiltinBrowserTransportMessage
} from "../features/builtin-browser/chat-integration"

// ── Queued-message content builders ───────────────────────────────────────────
// A QueuedMessage stores its parts (text / attachment XML / display prefix / skill
// block) separately so it can be edited in place. These derive the two rendered
// forms — the model payload and the user-facing bubble — matching exactly what a
// live (non-queued) send composes, so a drained draft is byte-identical to typing
// and sending it directly.

export function getQueuedModelContent(
  message: QueuedMessage,
  browserTarget: "workbench" | "bot" = "workbench"
): string {
  const workbenchReply = browserTarget === "workbench" ? message.botReplyTo : undefined
  const text =
    message.builtinBrowser && browserTarget === "bot"
      ? `${BOT_BROWSER_PROMPT_PREFIX}${message.text}`
      : formatBuiltinBrowserTransportMessage(message.text, !workbenchReply && message.builtinBrowser === true)
  const primary = `${text}${message.attachmentModelBlocks ?? ""}`.trim()
  const content = [primary, message.skillBlock].filter((part) => part && part.trim()).join("\n\n")
  if (!message.botReplyTo) return content
  const quoted = formatBotMessageReply(content, message.botReplyTo, browserTarget)
  // The workbench browser prefix stays outermost. The quote is only model
  // context here; this path cannot issue a Bot reply receipt.
  return workbenchReply ? formatBuiltinBrowserTransportMessage(quoted, message.builtinBrowser === true) : quoted
}

export function getQueuedDisplayContent(message: QueuedMessage, includeWorkbenchReply = false): string {
  const primary = message.attachmentDisplayPrefix
    ? [message.attachmentDisplayPrefix, message.text.trim()].filter(Boolean).join("\n\n")
    : message.text.trim()
  const body = includeWorkbenchReply && message.botReplyTo
    ? formatBotMessageReply(primary, message.botReplyTo, "workbench")
    : primary
  const visible = formatBuiltinBrowserTranscriptMessage(body, message.builtinBrowser === true)
  return [visible, message.skillBlock].filter((part) => part && part.trim()).join("\n\n")
}

/** Keep real attachment references separate from display text and part of request identity. */
export function getQueuedBotMessageInput(draft: QueuedMessage): {
  message: string
  mentions?: BotMessageMention[]
  inputFileIds?: string[]
  explicitSkill?: QueuedMessage["botExplicitSkill"]
} {
  const explicitSkill = draft.botExplicitSkill
  const transport = explicitSkill
    ? { ...draft, skillBlock: undefined, text: draft.text.trim() ? draft.text : `使用技能 ${explicitSkill.name}` }
    : draft
  const message = getQueuedModelContent(transport, "bot").trim()
  const selected = parseBotMessageMentions(draft.text, draft.botMentions)
  const inputFileIds = parseBotInputFileIds(draft.botInputFileIds)
  const fields = {
    ...(inputFileIds.length ? { inputFileIds } : {}),
    ...(explicitSkill ? { explicitSkill } : {})
  }
  if (!selected.length) return { message, ...fields }
  const prefix = draft.builtinBrowser ? BOT_BROWSER_PROMPT_PREFIX : ""
  const primary = prefix + draft.text + (draft.attachmentModelBlocks ?? "")
  const leading = primary.length - primary.trimStart().length
  const unquoted = getQueuedModelContent({ ...transport, botReplyTo: undefined }, "bot")
  const quoted = getQueuedModelContent(transport, "bot")
  const offset = prefix.length - leading + quoted.length - unquoted.length
  const mentions = selected.map((mention) => ({
    ...mention,
    start: mention.start + offset,
    end: mention.end + offset
  }))
  return { message, mentions: parseBotMessageMentions(message, mentions), ...fields }
}

/** Work creation rebuilds attachments from Host receipts, so every original block needs one. */
export function getQueuedBotWorkCreationInput(draft: QueuedMessage): ReturnType<typeof getQueuedBotMessageInput> {
  const input = getQueuedBotMessageInput({ ...draft, attachmentModelBlocks: undefined })
  const ids = input.inputFileIds ?? []
  // The composer escapes closing tags in file contents. Only inspect each block's
  // opening header and compare it to the separate picker receipts, never derive a receipt from the text.
  const blocks = (draft.attachmentModelBlocks ?? "").trim().split("\n</attachment>")
  const trailing = blocks.pop()
  if (trailing || blocks.length !== ids.length || (!blocks.length && draft.attachmentDisplayPrefix?.trim()) ||
      blocks.some((block, i) => /^\s*<attachment filename="[^"]*" input_id="([^"]+)"(?=\s)/.exec(block)?.[1] !== ids[i]))
    throw new Error("原草稿已保留。请在输入框重新选择附件，再交办新任务。")
  return input
}

export function getQueuedPreview(message: QueuedMessage): string {
  const content = getQueuedDisplayContent(message)
  const display = (parseSkillUseBlock(content)?.rest ?? content).replace(/\s+/g, " ").trim()
  return display || "待执行消息"
}

/** Parked drafts only resume on request. A possibly accepted handoff still fences the whole queue. */
export function nextOrdinaryQueuedMessage(messages: readonly QueuedMessage[]): QueuedMessage | undefined {
  if (hasUnresolvedQueuedHandoff(messages)) return
  return messages.find(message => !message.parkedForConversationLink && !message.botExplicitSkill)
}

export function hasUnresolvedQueuedHandoff(messages: readonly QueuedMessage[]): boolean {
  return messages.some(message => message.handoffRequestedAt || message.botHandoffTarget)
}

export function canResumeParkedQueuedMessage(message: QueuedMessage): boolean {
  return message.parkedForConversationLink === true && !message.handoffRequestedAt &&
    !message.botHandoffTarget && !message.botSkillTarget
}

/** Only an explicitly resumed parked skill can leave the Bot queue with its original selection. */
export function prepareParkedSkillResume(
  message: QueuedMessage,
  skills: readonly SkillMetadata[],
  disabledSkillIds: ReadonlySet<string>
): Pick<QueuedMessage, "parkedForConversationLink" | "botExplicitSkill" | "skillBlock"> | undefined {
  if (!canResumeParkedQueuedMessage(message) || !message.botExplicitSkill) return
  const { name, path } = message.botExplicitSkill
  const marker = parseSkillUseBlock(message.skillBlock ?? "")
  if (!marker || marker.rest.trim() || marker.skillName !== name.trim() || marker.skillPath !== path.trim()) return
  const skill = findEnabledSkillSelection(message.botExplicitSkill, skills, disabledSkillIds)
  if (!skill) return
  return { parkedForConversationLink: false, botExplicitSkill: undefined, skillBlock: formatSkillUseBlock(skill) }
}

// Mirror handleSubmit's guard: if a user message literally contains a coordinator
// control marker, prefix it so it can't be mistaken for an internal notification.
const COORDINATOR_INTERNAL_MARKER_RE =
  /\[\[CMB_COORDINATOR_(?:WORKER_NOTIFICATION|INTERNAL_(?:CONTEXT|NOTIFICATION)_(?:START|END))\]\]/

export function guardCoordinatorPlainText(displayContent: string): string {
  return COORDINATOR_INTERNAL_MARKER_RE.test(displayContent)
    ? `用户输入的普通文本：\n\n${displayContent}`
    : displayContent
}

export interface QueuedMessageReconciliation {
  pendingIds: string[]
  injectedIds: string[]
  durableIds: string[]
}

export type GuidedMessageDisposition = "durable" | "owned_by_run" | "unconsumed"

/** Classify a handed-off draft. Durable wins because run cleanup may already
 * have removed its transient injected id by the time the renderer asks. */
export function classifyGuidedMessage(
  messageId: string,
  reconciliation: QueuedMessageReconciliation
): GuidedMessageDisposition {
  if (reconciliation.durableIds.includes(messageId)) return "durable"
  if (
    reconciliation.pendingIds.includes(messageId) ||
    reconciliation.injectedIds.includes(messageId)
  ) {
    return "owned_by_run"
  }
  return "unconsumed"
}

/** A pump may claim only the exact draft version it started preparing. */
export function canClaimQueuedMessage(
  expected: QueuedMessage,
  current: QueuedMessage | undefined
): boolean {
  return Boolean(
    current &&
    current.id === expected.id &&
    !current.handoffRequestedAt &&
    !current.parkedForConversationLink &&
    !current.botHandoffTarget &&
    !current.botExplicitSkill &&
    current.updated_at.getTime() === expected.updated_at.getTime()
  )
}

// ── Draft-queue localStorage key ──────────────────────────────────────────────
// Lives here (not thread-context.tsx, where the queue itself is persisted) so
// store.ts's deleteThread can import it to clean this up on thread deletion
// without a circular import — thread-context.tsx imports FROM store.ts.
const QUEUE_STORAGE_PREFIX = "cmbcowork:message-queue:"

export function queueStorageKey(threadId: string): string {
  return `${QUEUE_STORAGE_PREFIX}${threadId}`
}
