import type { SchedulerEvent } from "../agent/stream-converter"

const CHATX_USER_MESSAGE_PREFIX = "chatx-user:"
const CHATX_ASSISTANT_MESSAGE_PREFIX = "chatx-assistant:"
const CHATX_TOOL_MESSAGE_PREFIX = "chatx-tool:"
const CHATX_TOOL_CALL_PREFIX = "chatx-tool-call:"
const CHATX_SUBAGENT_MESSAGE_PREFIX = "chatx-subagent-message:"
const CHATX_SUBAGENT_LOG_PREFIX = "chatx-subagent-log:"

export function getChatXUserMessageId(msgId: string): string {
  return `${CHATX_USER_MESSAGE_PREFIX}${msgId}`
}

function getTurnIdFromChatXUserMessageId(messageId: string): string | undefined {
  return messageId.startsWith(CHATX_USER_MESSAGE_PREFIX)
    ? messageId.slice(CHATX_USER_MESSAGE_PREFIX.length)
    : undefined
}

function scopeGeneratedMessageId(kind: "assistant" | "tool", turnId: string, id: string): string {
  if (kind === "assistant" && id.startsWith(CHATX_ASSISTANT_MESSAGE_PREFIX)) return id
  if (kind === "tool" && id.startsWith(CHATX_TOOL_MESSAGE_PREFIX)) return id
  const prefix = kind === "assistant" ? CHATX_ASSISTANT_MESSAGE_PREFIX : CHATX_TOOL_MESSAGE_PREFIX
  return `${prefix}${turnId}:${id}`
}

export function getChatXAssistantMessageId(turnId: string, id: string): string {
  return scopeGeneratedMessageId("assistant", turnId, id)
}

function getChatXToolMessageId(turnId: string, id: string): string {
  return scopeGeneratedMessageId("tool", turnId, id)
}

export function getChatXToolCallId(turnId: string, id: string): string {
  if (id.startsWith(CHATX_TOOL_CALL_PREFIX)) return id
  return `${CHATX_TOOL_CALL_PREFIX}${turnId}:${id}`
}

function namespaceToolCalls(
  turnId: string,
  toolCalls: unknown[] | undefined
): unknown[] | undefined {
  if (!Array.isArray(toolCalls)) return toolCalls
  return toolCalls.map((toolCall) => {
    if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return toolCall
    const record = toolCall as Record<string, unknown>
    if (typeof record.id !== "string" && typeof record.tool_call_id !== "string") return toolCall

    return {
      ...record,
      ...(typeof record.id === "string" ? { id: getChatXToolCallId(turnId, record.id) } : {}),
      ...(typeof record.tool_call_id === "string"
        ? { tool_call_id: getChatXToolCallId(turnId, record.tool_call_id) }
        : {})
    }
  })
}

function namespaceSubagents(turnId: string, subagents: unknown): unknown {
  if (!Array.isArray(subagents)) return subagents
  return subagents.map((subagent) => {
    if (!subagent || typeof subagent !== "object" || Array.isArray(subagent)) return subagent
    const record = subagent as Record<string, unknown>
    if (typeof record.id !== "string" && typeof record.toolCallId !== "string") return subagent

    return {
      ...record,
      ...(typeof record.id === "string" ? { id: getChatXToolCallId(turnId, record.id) } : {}),
      ...(typeof record.toolCallId === "string"
        ? { toolCallId: getChatXToolCallId(turnId, record.toolCallId) }
        : {})
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function scopeOpaqueId(prefix: string, turnId: string, id: string): string {
  return id.startsWith(prefix) ? id : `${prefix}${turnId}:${id}`
}

function namespaceSubagentAssistantMessageId(
  turnId: string,
  id: string,
  rawSubagentId: string,
  scopedSubagentId: string
): string {
  const syntheticPrefix = `subagent-assistant-${rawSubagentId}-`
  if (id.startsWith(syntheticPrefix)) {
    return `subagent-assistant-${scopedSubagentId}-${id.slice(syntheticPrefix.length)}`
  }
  return getChatXAssistantMessageId(turnId, id)
}

function namespaceSubagentTranscriptMessage(
  turnId: string,
  rawSubagentId: string,
  scopedSubagentId: string,
  value: unknown
): unknown {
  if (!isRecord(value)) return value
  const message = value
  const rawId = typeof message.id === "string" ? message.id : undefined
  let id = rawId
  if (rawId === `subagent-prompt-${rawSubagentId}`) {
    id = `subagent-prompt-${scopedSubagentId}`
  } else if (rawId === `subagent-final-${rawSubagentId}`) {
    id = `subagent-final-${scopedSubagentId}`
  } else if (rawId && message.role === "tool") {
    id = getChatXToolMessageId(turnId, rawId)
  } else if (rawId && message.role === "assistant") {
    id = namespaceSubagentAssistantMessageId(
      turnId,
      rawId,
      rawSubagentId,
      scopedSubagentId
    )
  } else if (rawId) {
    id = scopeOpaqueId(CHATX_SUBAGENT_MESSAGE_PREFIX, turnId, rawId)
  }

  const namespaceAssistantId = (candidate: unknown): unknown =>
    typeof candidate === "string"
      ? namespaceSubagentAssistantMessageId(
          turnId,
          candidate,
          rawSubagentId,
          scopedSubagentId
        )
      : candidate
  const namespaceAssistantIds = (candidate: unknown): unknown =>
    Array.isArray(candidate) ? candidate.map(namespaceAssistantId) : candidate

  return {
    ...message,
    ...(id ? { id } : {}),
    // `subagent_tool_call_id` is the provider/checkpoint identity used by fork
    // filtering. Keep it raw; only UI routing ids are scoped per ChatX turn.
    ...(typeof message.tool_call_id === "string"
      ? { tool_call_id: getChatXToolCallId(turnId, message.tool_call_id) }
      : {}),
    ...(Array.isArray(message.tool_calls)
      ? { tool_calls: namespaceToolCalls(turnId, message.tool_calls) }
      : {}),
    ...(message.replaces_message_id !== undefined
      ? { replaces_message_id: namespaceAssistantId(message.replaces_message_id) }
      : {}),
    ...(message.replaces_message_id_prefix !== undefined
      ? { replaces_message_id_prefix: namespaceAssistantId(message.replaces_message_id_prefix) }
      : {}),
    ...(message.compatible_replaces_message_id_prefix !== undefined
      ? {
          compatible_replaces_message_id_prefix: namespaceAssistantId(
            message.compatible_replaces_message_id_prefix
          )
        }
      : {}),
    ...(message.replaced_message_ids !== undefined
      ? { replaced_message_ids: namespaceAssistantIds(message.replaced_message_ids) }
      : {}),
    ...(message.replaced_message_id_prefixes !== undefined
      ? {
          replaced_message_id_prefixes: namespaceAssistantIds(
            message.replaced_message_id_prefixes
          )
        }
      : {}),
    ...(message.compatible_replaced_message_id_prefixes !== undefined
      ? {
          compatible_replaced_message_id_prefixes: namespaceAssistantIds(
            message.compatible_replaced_message_id_prefixes
          )
        }
      : {})
  }
}

function namespaceSubagentTranscriptEvent(
  turnId: string,
  event: Extract<SchedulerEvent, { type: "custom" }>
): SchedulerEvent {
  const rawSubagentId = event.data.subagentId
  if (typeof rawSubagentId !== "string") return event
  const scopedSubagentId = getChatXToolCallId(turnId, rawSubagentId)
  return {
    ...event,
    data: {
      ...event.data,
      subagentId: scopedSubagentId,
      ...(event.data.subagentMessage !== undefined
        ? {
            subagentMessage: namespaceSubagentTranscriptMessage(
              turnId,
              rawSubagentId,
              scopedSubagentId,
              event.data.subagentMessage
            )
          }
        : {}),
      ...(Array.isArray(event.data.subagentMessages)
        ? {
            subagentMessages: event.data.subagentMessages.map((message) =>
              namespaceSubagentTranscriptMessage(
                turnId,
                rawSubagentId,
                scopedSubagentId,
                message
              )
            )
          }
        : {})
    }
  }
}

function namespaceSubagentLogEvent(
  turnId: string,
  event: Extract<SchedulerEvent, { type: "custom" }>
): SchedulerEvent {
  if (!isRecord(event.data.entry)) return event
  const entry = event.data.entry
  const kind = entry.kind
  return {
    ...event,
    data: {
      ...event.data,
      entry: {
        ...entry,
        ...(typeof entry.id === "string"
          ? {
              id:
                kind === "assistant"
                  ? getChatXAssistantMessageId(turnId, entry.id)
                  : scopeOpaqueId(CHATX_SUBAGENT_LOG_PREFIX, turnId, entry.id)
            }
          : {}),
        ...(typeof entry.toolCallId === "string"
          ? { toolCallId: getChatXToolCallId(turnId, entry.toolCallId) }
          : {}),
        ...(typeof entry.subagentToolCallId === "string"
          ? { subagentToolCallId: getChatXToolCallId(turnId, entry.subagentToolCallId) }
          : {})
      }
    }
  }
}

export function namespaceChatXStreamEventIds(
  event: SchedulerEvent,
  currentMsgId: string
): SchedulerEvent {
  if (event.type === "message-delta") {
    return {
      ...event,
      id: getChatXAssistantMessageId(currentMsgId, event.id),
      toolCalls: namespaceToolCalls(currentMsgId, event.toolCalls),
      ...(event.subagentId
        ? { subagentId: getChatXToolCallId(currentMsgId, event.subagentId) }
        : {})
    }
  }

  if (event.type === "tool-message") {
    return {
      ...event,
      id: getChatXToolMessageId(currentMsgId, event.id),
      toolCallId: getChatXToolCallId(currentMsgId, event.toolCallId),
      ...(event.subagentId
        ? { subagentId: getChatXToolCallId(currentMsgId, event.subagentId) }
        : {})
    }
  }

  if (event.type === "custom") {
    if (event.data.type === "subagents" && Array.isArray(event.data.subagents)) {
      return {
        ...event,
        data: {
          ...event.data,
          subagents: namespaceSubagents(currentMsgId, event.data.subagents)
        }
      }
    }
    if (event.data.type === "subagent_transcript_message") {
      return namespaceSubagentTranscriptEvent(currentMsgId, event)
    }
    if (event.data.type === "subagent_log_entry") {
      return namespaceSubagentLogEvent(currentMsgId, event)
    }
    return event
  }

  if (event.type !== "full-messages") return event

  let activeTurnId: string | undefined
  return {
    ...event,
    messages: event.messages.map((message) => {
      if (message.role === "user") {
        const turnId = getTurnIdFromChatXUserMessageId(message.id)
        activeTurnId = turnId
        return message
      }

      if (!activeTurnId) return message

      if (message.role === "assistant") {
        return {
          ...message,
          id: getChatXAssistantMessageId(activeTurnId, message.id),
          tool_calls: namespaceToolCalls(activeTurnId, message.tool_calls)
        }
      }

      if (message.role === "tool") {
        return {
          ...message,
          id: getChatXToolMessageId(activeTurnId, message.id),
          ...(message.tool_call_id
            ? { tool_call_id: getChatXToolCallId(activeTurnId, message.tool_call_id) }
            : {})
        }
      }

      return message
    })
  }
}
