import type { BotMessageReply } from "./bots/contracts"
import { verifiedBotMessageReply } from "./bots/message-reply"
import { appendChatSearchToolSummaries, createChatSearchPlan } from "./chat-search-plan"
import type { ChatSearchPlan } from "./chat-search-types"
import { projectCoordinatorTranscriptNoise } from "./internal-notification-turn"
import {
  clampToolCalls,
  messageContentNeedsTranscriptClamp,
  normalizeMessageContent,
  parseJsonValue,
  THREAD_MESSAGE_TEXT_LIMIT,
  toolCallsNeedTranscriptClamp
} from "./thread-message-content"
import { normalizeVisibleReasoningText } from "./transcript-reasoning"
import { isVisibleTranscriptMessage } from "./transcript-visibility"
import { projectUserAttachmentContent } from "./user-attachment-display"

// Search reads a bounded sample so standalone reasoning never enters the search corpus.
export const THREAD_SEARCH_REASONING_BYTE_LIMIT = 4096

/** Candidates are byte-bounded by the caller before parsing or reading fragments. */
export function createThreadSearchMessagePlan(
  role: string,
  parsedContent: unknown,
  fragments: readonly string[],
  toolCallsJson: string | null,
  reasoningSample: string | null = null,
  reasoningOmitted = false,
  bodyOnly = false,
  replyTo?: Pick<BotMessageReply, "id" | "ordinal" | "role">,
  sideConversation = false
): (ChatSearchPlan & { reasoningVisibilityUnverified?: boolean }) | null {
  // Completed tool details are folded and have no independent transcript row.
  if (role === "tool") return null

  // Reassemble before applying display filters so a split marker cannot leak into search.
  const raw =
    typeof parsedContent === "string" && fragments.length > 0
      ? parsedContent + fragments.join("")
      : parsedContent
  // A malformed legacy body can still have visible tool summaries.
  if (parsedContent !== undefined && !isVisibleTranscriptMessage(role, raw)) return null
  // A generated truncation notice is display chrome. It should not become a
  // hit or send a large literal body through the Markdown syntax path.
  const storedContent = typeof raw === "string"
    ? raw.slice(0, THREAD_MESSAGE_TEXT_LIMIT)
    : normalizeMessageContent(raw)
  const attachments =
    role === "user" && typeof storedContent === "string"
      ? projectUserAttachmentContent(storedContent)
      : undefined
  const displayContent = attachments?.text ?? storedContent
  const parsedTools = parseJsonValue(toolCallsJson)
  const toolCalls = clampToolCalls(parsedTools)
  const visible = projectCoordinatorTranscriptNoise(role, displayContent, toolCalls)
  if (visible.hidden) return null

  const stripThink =
    role === "assistant" &&
    (bodyOnly || reasoningOmitted || Boolean(normalizeVisibleReasoningText(reasoningSample ?? undefined)))
  const reply = role === "user" && typeof displayContent === "string"
    ? verifiedBotMessageReply(displayContent, replyTo)
    : null
  const plan = createChatSearchPlan(
    role,
    reply?.message ?? (visible.contentChanged ? visible.contentText : displayContent),
    { stripThink, sideConversation }
  )
  const reasoningVisibilityUnverified =
    reasoningOmitted &&
    plan.segments.some((segment) => segment.stripThink && /<\/?think>/i.test(segment.raw))
  if (
    reasoningVisibilityUnverified ||
    attachments?.incomplete ||
    messageContentNeedsTranscriptClamp(raw) ||
    toolCallsNeedTranscriptClamp(parsedTools) ||
    (toolCallsJson !== null && parsedTools === undefined)
  )
    plan.truncated = true
  if (!bodyOnly) appendChatSearchToolSummaries(plan, visible.visibleToolCalls ?? [])
  return reasoningVisibilityUnverified ? { ...plan, reasoningVisibilityUnverified } : plan
}
