import type { Message } from "@/types"
import { mergeCheckpointAuthorityTranscriptMessages } from "../../../shared/checkpoint-transcript"
import {
  getMessageProviderOccurrenceIdentity,
  preserveAssistantReasoningByRoleCollisionIdentity
} from "../../../shared/message-role-collision"
import { isInternalGoalPromptMessage } from "./goal-notice-messages"
import { isVisibleCheckpointTranscriptMessage, sameGoalCommandMessage } from "./goal-transcript"
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
    ...(streamMessage.provider_source_id
      ? { provider_source_id: streamMessage.provider_source_id }
      : {}),
    ...(streamMessage.provider_occurrence
      ? { provider_occurrence: streamMessage.provider_occurrence }
      : {}),
    role,
    content: normalizeLiveStreamMessageContent(streamMessage.content),
    ...(typeof streamMessage.content_priority === "number"
      ? { content_priority: streamMessage.content_priority }
      : {}),
    ...(role === "assistant" && streamMessage.reasoning
      ? { reasoning: streamMessage.reasoning }
      : {}),
    tool_calls: streamMessage.tool_calls,
    ...(role === "tool" && streamMessage.tool_call_id
      ? { tool_call_id: streamMessage.tool_call_id }
      : {}),
    ...(role === "tool" && streamMessage.name ? { name: streamMessage.name } : {}),
    ...(role === "tool" && typeof streamMessage.status === "string"
      ? { status: streamMessage.status }
      : {}),
    ...(role === "tool" && streamMessage.is_error !== undefined
      ? { is_error: streamMessage.is_error }
      : {}),
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

export interface DurableTranscriptRequirementIndex {
  messageIds: ReadonlySet<string>
  messageIdentities: ReadonlySet<string>
  satisfied: boolean
}

/** A bounded durable page is usable only after it contains every row whose
 * just-flushed live bridge is waiting for persistence. */
export function indexDurableTranscriptRequirements(
  persistedMessages: readonly Message[],
  requiredMessageIds: readonly string[],
  requiredMessageIdentities: readonly string[]
): DurableTranscriptRequirementIndex {
  const messageIds = new Set(persistedMessages.map((message) => message.id))
  const messageIdentities = new Set(
    persistedMessages.map(getMessageProviderOccurrenceIdentity)
  )
  return {
    messageIds,
    messageIdentities,
    satisfied:
      requiredMessageIds.every((messageId) => messageIds.has(messageId)) &&
      requiredMessageIdentities.every((identity) => messageIdentities.has(identity))
  }
}

/** Merge a full DB-ordinal snapshot with local-only/live records without letting
 * optimistic renderer arrival order displace durable user-turn boundaries. */
export function mergeDurableTranscriptSnapshot(
  durableMessages: Message[],
  localMessages: Message[]
): Message[] {
  const merged = mergeCheckpointAuthorityTranscriptMessages(durableMessages, localMessages, {
    isSameMessage: sameGoalCommandMessage
  })
  // thread_messages is authoritative for ordinal/content but does not persist
  // renderer-only reasoning. Reattach it by provider occurrence so the first
  // durable sync after a stream stops cannot make visible thinking disappear.
  return preserveAssistantReasoningByRoleCollisionIdentity(localMessages, merged)
}
