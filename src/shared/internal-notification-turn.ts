import {
  WORKFLOW_NOTIFICATION_MARKER_PREFIX,
  WORKFLOW_NOTIFICATION_TURN_PROMPT
} from "./checkpoint-transcript"

export { WORKFLOW_NOTIFICATION_TURN_PROMPT }

export const INTERNAL_NOTIFICATION_TRIGGER_SOURCE = "internal_notification"

export const COORDINATOR_NOTIFICATION_PROMPT_PREFIX = "[[CMB_COORDINATOR_WORKER_NOTIFICATION]]"

export const COORDINATOR_NOTIFICATION_PROMPT = `${COORDINATOR_NOTIFICATION_PROMPT_PREFIX}
Continue processing completed coordinator worker notifications. This is an internal system turn, not a new user request.`

const QUIET_COORDINATOR_TOOL_NAMES = new Set(["read_worker_state"])
const INTERNAL_COORDINATOR_CONTEXT_START = "[[CMB_COORDINATOR_INTERNAL_CONTEXT_START]]"
const INTERNAL_COORDINATOR_CONTEXT_END = "[[CMB_COORDINATOR_INTERNAL_CONTEXT_END]]"
const INTERNAL_COORDINATOR_NOTIFICATION_START =
  "[[CMB_COORDINATOR_INTERNAL_NOTIFICATION_START]]"
const INTERNAL_COORDINATOR_NOTIFICATION_END = "[[CMB_COORDINATOR_INTERNAL_NOTIFICATION_END]]"

interface CoordinatorToolCallLike {
  name?: unknown
}

export interface CoordinatorTranscriptProjection<TToolCall extends CoordinatorToolCallLike> {
  hidden: boolean
  contentText: string
  contentChanged: boolean
  visibleToolCalls: readonly TToolCall[] | undefined
  toolCallsChanged: boolean
}

export function coordinatorTranscriptContentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return ""
      const record = block as Record<string, unknown>
      if (record.type === "text" && typeof record.text === "string") return record.text
      return typeof record.content === "string" ? record.content : ""
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
    if (endIndex === -1) return next.slice(0, startIndex).trimEnd()
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
  role: string,
  trustedInternalBlock = false
): boolean {
  const normalizedContent = content.trimStart()
  if (role === "user" && !trustedInternalBlock) return false
  if (normalizedContent.startsWith(COORDINATOR_NOTIFICATION_PROMPT_PREFIX)) return true
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

function isQuietCoordinatorToolCall(toolCall: CoordinatorToolCallLike): boolean {
  return typeof toolCall.name === "string" && QUIET_COORDINATOR_TOOL_NAMES.has(toolCall.name)
}

/**
 * Shared projection for coordinator rows before they enter either the chat DOM or durable search.
 * Keeping both consumers on this boundary prevents search from returning an ID that virtualization
 * can never mount, or counting text/tool calls that the visible row strips away.
 */
export function projectCoordinatorTranscriptNoise<TToolCall extends CoordinatorToolCallLike>(
  role: string,
  content: unknown,
  toolCalls?: readonly TToolCall[]
): CoordinatorTranscriptProjection<TToolCall> {
  let contentText = coordinatorTranscriptContentToText(content)
  if (isInternalCoordinatorMessage(contentText, role) || isWorkflowNotificationPrompt(contentText)) {
    return {
      hidden: true,
      contentText: "",
      contentChanged: false,
      visibleToolCalls: toolCalls,
      toolCallsChanged: false
    }
  }

  let contentChanged = false
  if (role !== "user" && hasMarkedInternalCoordinatorBlock(contentText)) {
    contentText = stripInternalCoordinatorBlocks(contentText)
    contentChanged = true
    if (isInternalCoordinatorMessage(contentText, role, true)) {
      return {
        hidden: true,
        contentText: "",
        contentChanged,
        visibleToolCalls: toolCalls,
        toolCallsChanged: false
      }
    }
    if (!contentText && !toolCalls?.length) {
      return {
        hidden: true,
        contentText: "",
        contentChanged,
        visibleToolCalls: toolCalls,
        toolCallsChanged: false
      }
    }
  }

  if (role !== "assistant" || !toolCalls?.length) {
    return {
      hidden: false,
      contentText,
      contentChanged,
      visibleToolCalls: toolCalls,
      toolCallsChanged: false
    }
  }

  const visibleToolCalls = toolCalls.filter((toolCall) => !isQuietCoordinatorToolCall(toolCall))
  const toolCallsChanged = visibleToolCalls.length !== toolCalls.length
  return {
    hidden: toolCallsChanged && visibleToolCalls.length === 0 && !contentText.trim(),
    contentText,
    contentChanged,
    visibleToolCalls: toolCallsChanged ? visibleToolCalls : toolCalls,
    toolCallsChanged
  }
}

export type InternalNotificationTurnKind = "coordinator" | "workflow" | "internal"

export function isCoordinatorNotificationPrompt(content: unknown): boolean {
  return typeof content === "string" && content.trim() === COORDINATOR_NOTIFICATION_PROMPT
}

/** Exact renderer trigger used to start a workflow completion-report turn. */
export function isWorkflowNotificationTurnPrompt(content: unknown): boolean {
  return typeof content === "string" && content.trimStart() === WORKFLOW_NOTIFICATION_TURN_PROMPT
}

/** Workflow plumbing messages hidden from the ordinary chat transcript. */
export function isWorkflowNotificationPrompt(content: unknown): boolean {
  if (typeof content !== "string") return false
  const normalized = content.trimStart()
  return (
    normalized === WORKFLOW_NOTIFICATION_TURN_PROMPT ||
    normalized.startsWith(WORKFLOW_NOTIFICATION_MARKER_PREFIX)
  )
}

/**
 * Classify a Trace turn without relying only on a reserved string. New traces
 * carry an explicit trigger source; exact marker matching remains as a fallback
 * for traces recorded before that field value existed.
 */
export function classifyInternalNotificationTurn(input: {
  content: unknown
  executionMode?: string
  triggerSource?: string
}): InternalNotificationTurnKind | null {
  if (input.triggerSource === INTERNAL_NOTIFICATION_TRIGGER_SOURCE) {
    if (input.executionMode === "coordinator") return "coordinator"
    if (input.executionMode === "workflow") return "workflow"
    return "internal"
  }

  if (input.executionMode === "coordinator" && isCoordinatorNotificationPrompt(input.content)) {
    return "coordinator"
  }
  if (input.executionMode === "workflow" && isWorkflowNotificationTurnPrompt(input.content)) {
    return "workflow"
  }
  return null
}
