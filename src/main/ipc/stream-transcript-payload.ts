import type { Message } from "../types"
import { serializedMessageClassName } from "./stream-data-serialization"
import {
  readStreamTranscriptReasoning,
  type QueuedStreamTranscriptMessage
} from "./stream-transcript-flush"
import { getMessageProviderTupleFromMetadata } from "../../shared/message-role-collision"
import {
  streamToolCallContentModeFromMessageMode,
  type StreamToolCallChunk
} from "../../shared/stream-tool-call-chunks"
import {
  readStreamMessageWireMode,
  STREAM_MESSAGE_CONTENT_MODE_KEY,
  STREAM_MESSAGE_TOOL_CALLS_MODE_KEY,
  STREAM_TOOL_CALL_ARGS_MODE_KEY
} from "../../shared/stream-message-wire-mode"

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function extractPersistedMessageContent(content: unknown): Message["content"] {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const blocks = content.filter((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return false
    const type = (block as { type?: unknown }).type
    return type === "text" || type === "image" || type === "tool_use" || type === "tool_result"
  })
  return blocks.length > 0 ? (blocks as Message["content"]) : ""
}

export function getSerializedMessageRole(msgChunk: unknown): Message["role"] | null {
  if (!msgChunk || typeof msgChunk !== "object" || Array.isArray(msgChunk)) return null
  const record = msgChunk as { id?: unknown; type?: unknown; kwargs?: Record<string, unknown> }
  const kwargs = asPlainRecord(record.kwargs) ?? {}
  const className = serializedMessageClassName(msgChunk)
  const type = kwargs.type ?? record.type

  if (className.includes("HumanMessage") || type === "human" || type === "user") return "user"
  if (className.includes("ToolMessage") || type === "tool") return "tool"
  if (className.includes("SystemMessage") || type === "system") return "system"
  if (className.includes("AIMessage") || type === "ai" || type === "assistant") {
    return "assistant"
  }
  return null
}

function serializedMessageId(msgChunk: unknown): string | null {
  if (!msgChunk || typeof msgChunk !== "object" || Array.isArray(msgChunk)) return null
  const record = msgChunk as { id?: unknown; kwargs?: Record<string, unknown> }
  const kwargs = asPlainRecord(record.kwargs) ?? {}
  if (typeof kwargs.id === "string" && kwargs.id.trim()) return kwargs.id.trim()
  if (typeof record.id === "string" && record.id.trim()) return record.id.trim()
  return null
}

export function streamPayloadContentMode(
  payload: unknown
): QueuedStreamTranscriptMessage["streamContentMode"] {
  if (!Array.isArray(payload)) return "delta"
  const metadata = asPlainRecord(payload[1])
  const wireMode = readStreamMessageWireMode(metadata?.[STREAM_MESSAGE_CONTENT_MODE_KEY])
  if (wireMode) return wireMode
  const className = serializedMessageClassName(payload[0])
  return className && !className.endsWith("Chunk") ? "snapshot" : "delta"
}

export function persistedMessageFromStreamPayload(
  payload: unknown
): QueuedStreamTranscriptMessage | null {
  if (!Array.isArray(payload)) return null
  const [msgChunk] = payload
  if (!msgChunk || typeof msgChunk !== "object" || Array.isArray(msgChunk)) return null
  const role = getSerializedMessageRole(msgChunk)
  if (!role || role === "user") return null
  const id = serializedMessageId(msgChunk)
  if (!id) return null

  const record = msgChunk as { content?: unknown; kwargs?: Record<string, unknown> }
  const kwargs = asPlainRecord(record.kwargs) ?? {}
  const content = extractPersistedMessageContent(kwargs.content ?? record.content)
  const toolCalls = Array.isArray(kwargs.tool_calls)
    ? (kwargs.tool_calls as Message["tool_calls"])
    : undefined
  const completeToolCalls =
    toolCalls !== undefined &&
    asPlainRecord(payload[1])?.[STREAM_MESSAGE_TOOL_CALLS_MODE_KEY] === "snapshot"
  const contentPresent =
    typeof (kwargs.content ?? record.content) === "string" ||
    Array.isArray(kwargs.content ?? record.content)
  const wireContentMode = streamPayloadContentMode(payload)
  const streamContentMode = contentPresent ? wireContentMode : "delta"
  const reasoningUpdate =
    role === "assistant" ? readStreamTranscriptReasoning(payload, wireContentMode) : {}
  const streamToolCallContentMode = streamToolCallContentModeFromMessageMode(wireContentMode)
  const streamToolCallChunks: StreamToolCallChunk[] = Array.isArray(kwargs.tool_call_chunks)
    ? kwargs.tool_call_chunks.flatMap((value) => {
        const chunk = asPlainRecord(value)
        if (!chunk) return []
        const id = typeof chunk.id === "string" && chunk.id ? chunk.id : undefined
        const name = typeof chunk.name === "string" && chunk.name ? chunk.name : undefined
        const args = typeof chunk.args === "string" ? chunk.args : undefined
        const index = typeof chunk.index === "number" ? chunk.index : undefined
        if (!id && !name && args === undefined && index === undefined) return []
        const wireMode = readStreamMessageWireMode(chunk[STREAM_TOOL_CALL_ARGS_MODE_KEY])
        return [{ id, name, args, index, contentMode: wireMode ?? streamToolCallContentMode }]
      })
    : []
  if (
    role !== "tool" &&
    !reasoningUpdate.reasoning &&
    (typeof content === "string" ? content.length === 0 : content.length === 0) &&
    (!toolCalls || toolCalls.length === 0) &&
    !completeToolCalls &&
    streamToolCallChunks.length === 0 &&
    streamContentMode !== "snapshot" &&
    reasoningUpdate.reasoning_mode !== "snapshot"
  ) {
    return null
  }

  const toolCallId = typeof kwargs.tool_call_id === "string" ? kwargs.tool_call_id : undefined
  const name = typeof kwargs.name === "string" ? kwargs.name : undefined
  const status = typeof kwargs.status === "string" ? kwargs.status : undefined
  const additionalKwargs = asPlainRecord(kwargs.additional_kwargs)
  const providerTuple = getMessageProviderTupleFromMetadata(additionalKwargs)
  const isError =
    kwargs.is_error === true || additionalKwargs?.is_error === true || status === "error"

  const message: QueuedStreamTranscriptMessage = {
    id,
    ...providerTuple,
    role,
    content,
    ...reasoningUpdate,
    ...(toolCalls && (toolCalls.length > 0 || completeToolCalls) ? { tool_calls: toolCalls } : {}),
    ...(completeToolCalls
      ? { tool_calls_mode: "snapshot" as const }
      : toolCalls?.length || streamToolCallChunks.length
        ? { tool_calls_mode: "delta" as const }
        : {}),
    ...(role === "tool" && toolCallId ? { tool_call_id: toolCallId } : {}),
    ...(role === "tool" && name ? { name } : {}),
    ...(role === "tool" && status ? { status } : {}),
    ...(role === "tool" && isError ? { is_error: true } : {}),
    created_at: new Date(),
    streamContentMode,
    streamToolCallChunks
  }
  return message
}
