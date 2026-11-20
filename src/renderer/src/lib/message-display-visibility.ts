import type { Message } from "../types"

import { systemNoticeBlockText } from "../../../shared/goal-notice-presentation"
import { normalizeVisibleReasoningText } from "../../../shared/transcript-reasoning"

export { normalizeVisibleReasoningText } from "../../../shared/transcript-reasoning"

export function hasVisibleReasoningText(reasoning: string | undefined): boolean {
  return normalizeVisibleReasoningText(reasoning).length > 0
}

export function messageVisibleReasoningLength(
  message: Pick<Message, "reasoning"> | null | undefined
): number {
  return normalizeVisibleReasoningText(message?.reasoning).length
}

interface ReasoningAutoCollapseState {
  isStreaming: boolean
  reasoningText: string
  hasVisibleAssistantContent: boolean
  hasToolCalls: boolean
}

export function shouldAutoCollapseReasoning({
  isStreaming,
  reasoningText,
  hasVisibleAssistantContent,
  hasToolCalls
}: ReasoningAutoCollapseState): boolean {
  return (
    isStreaming &&
    reasoningText.length > 0 &&
    (hasVisibleAssistantContent || hasToolCalls)
  )
}

function hasNonWhitespace(value: string | undefined): boolean {
  return typeof value === "string" && /\S/.test(value)
}

function hasAssistantOrUserVisibleText(content: Message["content"]): boolean {
  if (typeof content === "string") return hasNonWhitespace(content)
  if (!Array.isArray(content)) return false
  return content.some((block) => block.type === "text" && hasNonWhitespace(block.text))
}

function hasSystemVisibleText(content: Message["content"]): boolean {
  if (typeof content === "string") return hasNonWhitespace(content)
  if (!Array.isArray(content)) return false
  return content.some((block) => hasNonWhitespace(systemNoticeBlockText(block)))
}

// Keep this aligned with MessageBubble's actual render branches. Tool results
// render inside their assistant tool cards, while empty messages render null.
export function messageRendersNothing(message: Message): boolean {
  if (message.role === "tool") return true
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false

  const hasVisibleText =
    message.role === "system"
      ? hasSystemVisibleText(message.content)
      : hasAssistantOrUserVisibleText(message.content)
  if (hasVisibleText) return false

  return message.role !== "assistant" || !hasVisibleReasoningText(message.reasoning)
}

export function messageHasVisibleRow(
  message: Message,
  hasSupplementalContent: boolean = false
): boolean {
  return hasSupplementalContent || !messageRendersNothing(message)
}

export interface VisibleMessageLayout<T> {
  previousVisibleMessageByIndex: Array<T | null>
  lastVisibleMessageIndex: number
}

export function buildVisibleMessageLayout<T>(
  messages: readonly T[],
  isVisible: (message: T, index: number) => boolean
): VisibleMessageLayout<T> {
  const previousVisibleMessageByIndex: Array<T | null> = new Array(messages.length).fill(null)
  let previousVisibleMessage: T | null = null
  let lastVisibleMessageIndex = -1

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!isVisible(message, index)) continue
    previousVisibleMessageByIndex[index] = previousVisibleMessage
    previousVisibleMessage = message
    lastVisibleMessageIndex = index
  }

  return { previousVisibleMessageByIndex, lastVisibleMessageIndex }
}
