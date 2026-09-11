import type { Message } from "@/types"
import {
  COORDINATOR_NOTIFICATION_PROMPT,
  WORKFLOW_NOTIFICATION_TURN_PROMPT,
  isCoordinatorNotificationPrompt,
  isWorkflowNotificationPrompt,
  projectCoordinatorTranscriptNoise
} from "../../../shared/internal-notification-turn"

export {
  COORDINATOR_NOTIFICATION_PROMPT,
  WORKFLOW_NOTIFICATION_TURN_PROMPT,
  isCoordinatorNotificationPrompt,
  isWorkflowNotificationPrompt
}

function isQuietCoordinatorToolResult(message: Message): boolean {
  return (
    message.role === "tool" &&
    typeof message.name === "string" &&
    message.name === "read_worker_state"
  )
}

/**
 * Keep coordinator waiting/probing tools out of the main chat timeline.
 * Worker progress is already represented in the right-side agent panel, so
 * repeating read_worker_state cards only adds visual noise.
 */
export function filterCoordinatorNoiseMessages(messages: Message[]): Message[] {
  return messages.flatMap((message) => {
    if (isQuietCoordinatorToolResult(message)) {
      return []
    }
    const projection = projectCoordinatorTranscriptNoise(
      message.role,
      message.content,
      message.tool_calls
    )
    if (projection.hidden) return []
    if (!projection.contentChanged && !projection.toolCallsChanged) return [message]
    return [
      {
        ...message,
        ...(projection.contentChanged ? { content: projection.contentText } : {}),
        ...(projection.toolCallsChanged
          ? {
              tool_calls:
                projection.visibleToolCalls && projection.visibleToolCalls.length > 0
                  ? [...projection.visibleToolCalls]
                  : undefined
            }
          : {})
      }
    ]
  })
}
