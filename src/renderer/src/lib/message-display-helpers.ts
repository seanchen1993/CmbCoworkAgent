import type { Message, ToolCall } from "@/types"

const QUIET_COORDINATOR_TOOL_NAMES = new Set(["read_worker_state"])
const INTERNAL_COORDINATOR_MESSAGE_PREFIX = "[[CMB_COORDINATOR_WORKER_NOTIFICATION]]"
export const COORDINATOR_NOTIFICATION_PROMPT = `${INTERNAL_COORDINATOR_MESSAGE_PREFIX}
Continue processing completed coordinator worker notifications. This is an internal system turn, not a new user request.`
const INTERNAL_COORDINATOR_CONTEXT_START = "[[CMB_COORDINATOR_INTERNAL_CONTEXT_START]]"
const INTERNAL_COORDINATOR_CONTEXT_END = "[[CMB_COORDINATOR_INTERNAL_CONTEXT_END]]"
const INTERNAL_COORDINATOR_NOTIFICATION_START = "[[CMB_COORDINATOR_INTERNAL_NOTIFICATION_START]]"
const INTERNAL_COORDINATOR_NOTIFICATION_END = "[[CMB_COORDINATOR_INTERNAL_NOTIFICATION_END]]"
const WORKFLOW_NOTIFICATION_TURN_TRIGGER = "[[CMB_WORKFLOW_NOTIFICATION_TURN]]"
const INTERNAL_WORKFLOW_NOTIFICATION_PREFIX = "[[CMB_WORKFLOW_NOTIFICATION_V1:"
/** Renderer-submitted trigger; the main process expands it into the real notification. */
export const WORKFLOW_NOTIFICATION_TURN_PROMPT = `${WORKFLOW_NOTIFICATION_TURN_TRIGGER}
Process the completed workflow task-notification. This is an internal system turn, not a new user request.`

/** Internal workflow plumbing messages (the trigger and the expanded notification). */
export function isWorkflowNotificationPrompt(content: unknown): boolean {
  if (typeof content !== "string") return false
  const normalized = content.trimStart()
  return (
    // FULL-match the turn prompt (mirrors the main process's full-match fix), so a
    // user who pastes text merely STARTING with the trigger (a log/sample) isn't
    // silently hidden as internal plumbing.
    normalized === WORKFLOW_NOTIFICATION_TURN_PROMPT ||
    // The expanded notification carries a runId suffix, so it stays a prefix match.
    normalized.startsWith(INTERNAL_WORKFLOW_NOTIFICATION_PREFIX)
  )
}

function isQuietCoordinatorToolCall(toolCall: ToolCall): boolean {
  return QUIET_COORDINATOR_TOOL_NAMES.has(toolCall.name)
}

function isQuietCoordinatorToolResult(message: Message): boolean {
  return (
    message.role === "tool" &&
    typeof message.name === "string" &&
    QUIET_COORDINATOR_TOOL_NAMES.has(message.name)
  )
}

function messageHasVisibleContent(message: Message): boolean {
  if (typeof message.content === "string") {
    return message.content.trim().length > 0
  }

  return message.content.some((block) => {
    if (block.type === "text") return Boolean(block.text?.trim())
    if (typeof block.content === "string") return Boolean(block.content.trim())
    return false
  })
}

function messageContentToText(content: Message["content"]): string {
  if (typeof content === "string") return content
  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? ""
      if (typeof block.content === "string") return block.content
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function stripMarkedInternalBlock(content: string, start: string, end: string): string {
  let next = content
  while (true) {
    const startIndex = next.indexOf(start)
    if (startIndex === -1) return next

    const endIndex = next.indexOf(end, startIndex + start.length)
    if (endIndex === -1) {
      return next.slice(0, startIndex).trimEnd()
    }

    next = `${next.slice(0, startIndex)}${next.slice(endIndex + end.length)}`
  }
}

function stripInternalCoordinatorBlocks(content: string): string {
  return stripMarkedInternalBlock(
    stripMarkedInternalBlock(
      content,
      INTERNAL_COORDINATOR_CONTEXT_START,
      INTERNAL_COORDINATOR_CONTEXT_END
    ),
    INTERNAL_COORDINATOR_NOTIFICATION_START,
    INTERNAL_COORDINATOR_NOTIFICATION_END
  ).trim()
}

function isInternalCoordinatorMessage(
  content: string,
  role?: Message["role"],
  trustedInternalBlock = false
): boolean {
  const normalizedContent = content.trimStart()
  if (role === "user" && !trustedInternalBlock) {
    return false
  }

  if (normalizedContent.startsWith(INTERNAL_COORDINATOR_MESSAGE_PREFIX)) {
    return true
  }

  const hasCoordinatorHeading =
    normalizedContent.startsWith("## Current Coordinator Workers") ||
    normalizedContent.startsWith("## Coordinator Worker Notifications")

  return hasCoordinatorHeading && (trustedInternalBlock || role === "system")
}

function hasMarkedInternalCoordinatorBlock(content: string): boolean {
  return (
    content.includes(INTERNAL_COORDINATOR_CONTEXT_START) ||
    content.includes(INTERNAL_COORDINATOR_NOTIFICATION_START)
  )
}

export function isCoordinatorNotificationPrompt(content: unknown): boolean {
  return typeof content === "string" && content.trim() === COORDINATOR_NOTIFICATION_PROMPT
}

/**
 * Keep coordinator waiting/probing tools out of the main chat timeline.
 * Worker progress is already represented in the right-side agent panel, so
 * repeating read_worker_state cards only adds visual noise.
 */
export function filterCoordinatorNoiseMessages(messages: Message[]): Message[] {
  return messages.flatMap((message) => {
    const contentText = messageContentToText(message.content)
    if (isInternalCoordinatorMessage(contentText, message.role)) {
      return []
    }

    // Workflow notification plumbing (trigger + expanded <task-notification>)
    // is internal regardless of role — the outcome reaches the user through
    // the assistant's summary and the workflow panel.
    if (isWorkflowNotificationPrompt(contentText)) {
      return []
    }

    if (isQuietCoordinatorToolResult(message)) {
      return []
    }

    if (message.role !== "user" && hasMarkedInternalCoordinatorBlock(contentText)) {
      const cleanedContent = stripInternalCoordinatorBlocks(contentText)
      if (isInternalCoordinatorMessage(cleanedContent, message.role, true)) {
        return []
      }
      if (!cleanedContent && !message.tool_calls?.length) return []

      message = { ...message, content: cleanedContent }
    }

    if (message.role !== "assistant" || !message.tool_calls?.length) {
      return [message]
    }

    const visibleToolCalls = message.tool_calls.filter(
      (toolCall) => !isQuietCoordinatorToolCall(toolCall)
    )
    if (visibleToolCalls.length === message.tool_calls.length) {
      return [message]
    }

    if (visibleToolCalls.length === 0 && !messageHasVisibleContent(message)) {
      return []
    }

    return [
      {
        ...message,
        tool_calls: visibleToolCalls.length > 0 ? visibleToolCalls : undefined
      }
    ]
  })
}
