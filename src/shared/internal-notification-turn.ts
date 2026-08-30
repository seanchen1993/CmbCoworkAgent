import {
  WORKFLOW_NOTIFICATION_MARKER_PREFIX,
  WORKFLOW_NOTIFICATION_TURN_PROMPT
} from "./checkpoint-transcript"

export { WORKFLOW_NOTIFICATION_TURN_PROMPT }

export const INTERNAL_NOTIFICATION_TRIGGER_SOURCE = "internal_notification"

export const COORDINATOR_NOTIFICATION_PROMPT_PREFIX = "[[CMB_COORDINATOR_WORKER_NOTIFICATION]]"

export const COORDINATOR_NOTIFICATION_PROMPT = `${COORDINATOR_NOTIFICATION_PROMPT_PREFIX}
Continue processing completed coordinator worker notifications. This is an internal system turn, not a new user request.`

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
