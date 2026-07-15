import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type ToolCall as LangChainToolCall
} from "@langchain/core/messages"
import { getThreadMessages } from "../db"
import { withCheckpointer } from "../agent/runtime"
import type { Message } from "../types"
import {
  checkpointHasInterrupt,
  deriveCheckpointTranscriptIndex,
  findMessagesAfterCheckpointVisibleIds,
  isWorkflowPlumbingTranscriptContent
} from "../../shared/checkpoint-transcript"

export interface DurableRuntimeTail {
  messages: BaseMessage[]
  persistedMessages: Message[]
  checkpointHasInterrupt: boolean
}

function stringifyMessageContent(content: Message["content"]): string {
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

function isRuntimeVisiblePersistedMessage(message: Message): boolean {
  return !isWorkflowPlumbingTranscriptContent(stringifyMessageContent(message.content))
}

export function persistedMessageToRuntimeMessage(message: Message): BaseMessage | null {
  const content = stringifyMessageContent(message.content)
  if (message.role === "user") {
    return new HumanMessage({ id: message.id, content })
  }
  if (message.role === "assistant") {
    return new AIMessage({
      id: message.id,
      content,
      ...(message.tool_calls
        ? { tool_calls: message.tool_calls as LangChainToolCall[] }
        : {}),
      ...(message.reasoning
        ? {
            additional_kwargs: {
              reasoning: message.reasoning
            }
          }
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

export function findDurableTailMessagesAfterCheckpoint(
  persistedMessages: readonly Message[],
  checkpointVisibleMessageIds: readonly string[],
  options: { excludeMessageIds?: readonly string[] } = {}
): Message[] {
  const visibleMessages = persistedMessages.filter(isRuntimeVisiblePersistedMessage)
  return findMessagesAfterCheckpointVisibleIds(visibleMessages, checkpointVisibleMessageIds, options)
}

async function getLatestCheckpoint(threadId: string): Promise<unknown | null> {
  try {
    return await withCheckpointer(threadId, async (checkpointer) => {
      const config = { configurable: { thread_id: threadId } }
      for await (const checkpoint of checkpointer.list(config, { limit: 1 })) {
        return checkpoint.checkpoint
      }
      return null
    })
  } catch (error) {
    console.warn("[Agent] Failed to inspect checkpoint for durable transcript tail:", error)
    return null
  }
}

export async function getDurableRuntimeTail(
  threadId: string,
  options: { excludeMessageIds?: readonly string[] } = {}
): Promise<DurableRuntimeTail> {
  const checkpoint = await getLatestCheckpoint(threadId)
  if (!checkpoint) {
    return { messages: [], persistedMessages: [], checkpointHasInterrupt: false }
  }

  const transcript = deriveCheckpointTranscriptIndex(checkpoint)
  const persistedTail = findDurableTailMessagesAfterCheckpoint(
    getThreadMessages(threadId),
    transcript.visibleMessageIds,
    options
  )
  return {
    messages: persistedTail
      .map(persistedMessageToRuntimeMessage)
      .filter((message): message is BaseMessage => message !== null),
    persistedMessages: persistedTail,
    checkpointHasInterrupt: checkpointHasInterrupt(checkpoint)
  }
}
