import type { Message } from "../types"

export function normalizeVisibleReasoningText(reasoning: string | undefined): string {
  if (!reasoning) return ""
  return reasoning
    .replace(/^\s*<think>\s*/i, "")
    .replace(/\s*<\/think>\s*$/i, "")
    .trim()
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

function getAssistantOrUserVisibleText(content: Message["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .filter(Boolean)
    .join("\n")
}

function getSystemVisibleText(content: Message["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? ""
      return typeof block.content === "string" ? block.content : ""
    })
    .filter(Boolean)
    .join("\n")
}

// Keep this aligned with MessageBubble's actual render branches. Tool results
// render inside their assistant tool cards, while empty messages render null.
export function messageRendersNothing(message: Message): boolean {
  if (message.role === "tool") return true
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false

  const visibleText =
    message.role === "system"
      ? getSystemVisibleText(message.content)
      : getAssistantOrUserVisibleText(message.content)
  if (visibleText.trim().length > 0) return false

  return (
    message.role !== "assistant" || normalizeVisibleReasoningText(message.reasoning).length === 0
  )
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
