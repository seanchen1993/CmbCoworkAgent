import type { BaseMessage } from "@langchain/core/messages"
import {
  getThreadMessages,
  getThreadMessagesAfterAnyId,
  getThreadMessagesByIds
} from "../db"
import { withCheckpointer } from "../agent/runtime"
import type { Message } from "../types"
import {
  checkpointHasInterrupt,
  type CheckpointTranscriptMessage,
  deriveCheckpointTranscriptIndex,
  findMessagesAfterCheckpointVisibleIds
} from "../../shared/checkpoint-transcript"
import {
  isRuntimeVisiblePersistedMessage,
  persistedMessageToRuntimeMessage
} from "./persisted-runtime-message"

export { persistedMessageToRuntimeMessage } from "./persisted-runtime-message"

export interface DurableRuntimeTail {
  messages: BaseMessage[]
  persistedMessages: Message[]
  checkpointHasInterrupt: boolean
}

export function findDurableTailMessagesAfterCheckpoint(
  persistedMessages: readonly Message[],
  checkpointVisibleMessages: readonly (string | CheckpointTranscriptMessage)[],
  options: {
    excludeMessageIds?: readonly string[]
    excludeMessages?: readonly Pick<Message, "id" | "role">[]
  } = {}
): Message[] {
  const visibleMessages = persistedMessages.filter(isRuntimeVisiblePersistedMessage)
  return findMessagesAfterCheckpointVisibleIds(visibleMessages, checkpointVisibleMessages, options)
}

async function getLatestCheckpoint(
  threadId: string,
  allowBoundedCheckpointRecovery: boolean
): Promise<unknown | null> {
  try {
    return await withCheckpointer(threadId, async (checkpointer) => {
      if (allowBoundedCheckpointRecovery) {
        return (
          (await checkpointer.getLatestTupleForDurableTailRecovery(threadId))?.checkpoint ?? null
        )
      }
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
  options: {
    excludeMessageIds?: readonly string[]
    excludeMessages?: readonly Pick<Message, "id" | "role">[]
    /** Set only after invoke replacement proves every predecessor settled. */
    allowBoundedCheckpointRecovery?: boolean
  } = {}
): Promise<DurableRuntimeTail> {
  const checkpoint = await getLatestCheckpoint(
    threadId,
    options.allowBoundedCheckpointRecovery === true
  )
  if (!checkpoint) {
    return { messages: [], persistedMessages: [], checkpointHasInterrupt: false }
  }

  const transcript = deriveCheckpointTranscriptIndex(checkpoint)
  if (transcript.visibleMessages.length === 0) {
    return {
      messages: [],
      persistedMessages: [],
      checkpointHasInterrupt: checkpointHasInterrupt(checkpoint)
    }
  }
  // The latest checkpoint boundary is normally an exact durable render id. Probe
  // only a bounded suffix, then ask SQLite for rows after the newest match. A full
  // transcript read remains a compatibility fallback for legacy/corrupt identity
  // metadata, not the ordinary start/resume path.
  const recentCheckpointIds = Array.from(
    new Set(
      transcript.visibleMessages.slice(-32).flatMap((message) =>
        [message.renderId, message.id].filter((id): id is string => Boolean(id))
      )
    )
  )
  const durableCheckpointBoundaries = getThreadMessagesByIds(threadId, recentCheckpointIds)
  const persistedMessages =
    durableCheckpointBoundaries.length > 0
      ? getThreadMessagesAfterAnyId(
          threadId,
          durableCheckpointBoundaries.map((message) => message.id)
        )
      : getThreadMessages(threadId)
  const persistedTail = findDurableTailMessagesAfterCheckpoint(
    persistedMessages,
    transcript.visibleMessages,
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
