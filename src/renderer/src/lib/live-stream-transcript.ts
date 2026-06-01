import type { Message } from "@/types"
import { isInternalGoalPromptMessage } from "./goal-notice-messages"
import { isVisibleCheckpointTranscriptMessage } from "./goal-transcript"
import {
  liveStreamMessageRole,
  normalizeLiveStreamMessageContent,
  type LiveStreamMessage
} from "./live-stream-messages"

export function liveStreamMessageToStoreMessage(
  streamMessage: LiveStreamMessage & { id: string },
  timing?: { start_at?: Date; end_at?: Date }
): Message {
  const role = liveStreamMessageRole(streamMessage.type)
  return {
    id: streamMessage.id,
    role,
    content: normalizeLiveStreamMessageContent(streamMessage.content),
    tool_calls: streamMessage.tool_calls,
    ...(role === "tool" && streamMessage.tool_call_id
      ? { tool_call_id: streamMessage.tool_call_id }
      : {}),
    ...(role === "tool" && streamMessage.name ? { name: streamMessage.name } : {}),
    created_at: timing?.start_at ?? new Date(),
    ...(timing?.start_at ? { start_at: timing.start_at } : {}),
    ...(timing?.end_at ? { end_at: timing.end_at } : {})
  }
}

export function resolveLiveStreamMessageEndAt(
  startAt: Date,
  nextStartAt: Date | undefined,
  completedAt: Date
): Date {
  const candidate = nextStartAt ?? completedAt
  return candidate.getTime() >= startAt.getTime() ? candidate : startAt
}

export function shouldSkipLiveStreamAccumulatorMessage(
  streamMessage: LiveStreamMessage & { id: string }
): boolean {
  const storeMessage = liveStreamMessageToStoreMessage(streamMessage)
  if (isInternalGoalPromptMessage(storeMessage)) return false
  return !isVisibleCheckpointTranscriptMessage(storeMessage)
}
