import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type ToolCall as LangChainToolCall
} from "@langchain/core/messages"
import type { Message } from "../types"
import {
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY
} from "../../shared/message-role-collision"
import { isWorkflowPlumbingTranscriptContent } from "../../shared/checkpoint-transcript"

export function stringifyPersistedMessageContent(content: Message["content"]): string {
  if (typeof content === "string") return content
  return content
    .map((block) => {
      if (typeof block.text === "string") return block.text
      if (typeof block.content === "string") return block.content
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

export function isRuntimeVisiblePersistedMessage(message: Message): boolean {
  return !isWorkflowPlumbingTranscriptContent(stringifyPersistedMessageContent(message.content))
}

/** Convert one durable transcript row back to the LangChain message used by the graph. */
export function persistedMessageToRuntimeMessage(message: Message): BaseMessage | null {
  const content = stringifyPersistedMessageContent(message.content)
  if (message.role === "user") {
    return new HumanMessage({ id: message.id, content })
  }
  if (message.role === "assistant") {
    const providerSourceId = message.provider_source_id?.trim()
    const providerOccurrence = message.provider_occurrence
    const additionalKwargs = {
      ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      ...(providerSourceId &&
      typeof providerOccurrence === "number" &&
      Number.isInteger(providerOccurrence) &&
      providerOccurrence >= 1
        ? {
            [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: providerSourceId,
            [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: providerOccurrence
          }
        : {})
    }
    return new AIMessage({
      id: message.id,
      content,
      ...(message.tool_calls
        ? { tool_calls: message.tool_calls as LangChainToolCall[] }
        : {}),
      ...(Object.keys(additionalKwargs).length > 0
        ? { additional_kwargs: additionalKwargs }
        : {})
    })
  }
  if (message.role === "system") {
    return new SystemMessage({ id: message.id, content })
  }
  if (message.role === "tool") {
    if (!message.tool_call_id) return null
    const status =
      message.status === "success" || message.status === "error" ? message.status : undefined
    return new ToolMessage({
      id: message.id,
      content,
      tool_call_id: message.tool_call_id,
      ...(message.name ? { name: message.name } : {}),
      ...(status ? { status } : {}),
      ...(message.is_error ? { additional_kwargs: { is_error: true } } : {})
    })
  }
  return null
}
