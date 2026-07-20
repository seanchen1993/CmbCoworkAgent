import type { SchedulerEvent } from "../agent/stream-converter"

const CHATX_USER_MESSAGE_PREFIX = "chatx-user:"
const CHATX_ASSISTANT_MESSAGE_PREFIX = "chatx-assistant:"
const CHATX_TOOL_MESSAGE_PREFIX = "chatx-tool:"
const CHATX_TOOL_CALL_PREFIX = "chatx-tool-call:"

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
    if (event.data.type !== "subagents" || !Array.isArray(event.data.subagents)) return event
    return {
      ...event,
      data: {
        ...event.data,
        subagents: namespaceSubagents(currentMsgId, event.data.subagents)
      }
    }
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
