import type { BaseMessage } from "@langchain/core/messages"
import type { CheckpointTuple } from "@langchain/langgraph-checkpoint"
import { getDb, getThreadCore, getThreadMessages, getThreadMessagesAfterAnyId, getThreadMessagesByIds } from "../db"
import { withCheckpointer } from "../agent/runtime"
import type { Message } from "../types"
import {
  checkpointHasInterrupt,
  type CheckpointTranscriptMessage,
  deriveCheckpointTranscriptIndex,
  findMessagesAfterCheckpointVisibleIds
} from "../../shared/checkpoint-transcript"
import { isImRemoteControlTranscriptMessageId } from "../../shared/im-remote-transcript"
import {
  isRuntimeVisiblePersistedMessage as isBaseRuntimeVisiblePersistedMessage,
  persistedMessageToRuntimeMessage,
  type PersistedRuntimeMessageOptions
} from "./persisted-runtime-message"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { modErrorCode } from "../mods/errors"
import { CheckpointMessageSnapshotRecoveryError } from "../checkpointer/sqljs-saver"
import { getModsManager } from "../mods/manager"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { nativeFunctionConversationWorkspace, createMainFunctionConversationRecoveryDecision,
  requireMainFunctionConversationRecovery } from "../checkpointer/function-conversation-main-recovery"
import { readFunctionConversationState } from "../checkpointer/function-conversation-delivery"
import { readFunctionConversationCompactionBoundary, reconcileFunctionConversationCompaction }
  from "../checkpointer/function-conversation-compaction-boundary"

export { persistedMessageToRuntimeMessage } from "./persisted-runtime-message"

export interface DurableRuntimeTail {
  messages: BaseMessage[]
  persistedMessages: Message[]
  checkpointHasInterrupt: boolean
}

function isRuntimeVisiblePersistedMessage(message: Message): boolean {
  return (
    !isImRemoteControlTranscriptMessageId(message.id) &&
    isBaseRuntimeVisiblePersistedMessage(message)
  )
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
): Promise<CheckpointTuple | null> {
  try {
    return await withCheckpointer(threadId, async (checkpointer) => {
      if (allowBoundedCheckpointRecovery) {
        return (
          (await checkpointer.getLatestTupleForDurableTailRecovery(threadId)) ?? null
        )
      }
      const config = { configurable: { thread_id: threadId } }
      for await (const checkpoint of checkpointer.list(config, { limit: 1 })) {
        return checkpoint
      }
      return null
    })
  } catch (error) {
    // A refused protected checkpoint is not an absent checkpoint. Preserve its first
    // failure instead of letting the next step attempt to start with an empty tail.
    if (modErrorCode(error).startsWith("MODS_CONVERSATION_") ||
      error instanceof CheckpointMessageSnapshotRecoveryError ||
      (error instanceof Error && (error.name.startsWith("CHECKPOINT_STORAGE_") ||
        error.message.startsWith("SQLJS_SAVER_")))) throw error
    console.warn("[Agent] Failed to inspect checkpoint for durable transcript tail:", error)
    return null
  }
}

async function compactedBoundary(threadId: string, tuple: CheckpointTuple): Promise<string | undefined> {
  if (tuple.checkpoint.channel_values.cmbFunctionConversation === undefined) return undefined
  const manager = getModsManager(), store = manager?.captureFunctionConversationStore()
  const database = getDb(), thread = getThreadCore(threadId)
  const workspace = thread && nativeFunctionConversationWorkspace(thread.metadata)
  if (!manager || !store || !thread || !workspace)
    throw new ModFunctionError("MODS_CONVERSATION_RECOVERY_REQUIRED")
  const incarnation = captureThreadIncarnation(thread), signal = new AbortController().signal
  const guard = () => {
    const current = getThreadCore(threadId)
    if (getDb() !== database || getModsManager() !== manager ||
      !matchesThreadIncarnation(current, incarnation) || current?.metadata !== thread.metadata)
      throw new ModFunctionError("MODS_CONVERSATION_THREAD_CHANGED")
  }
  const decide = createMainFunctionConversationRecoveryDecision({ database, store, threadId,
    workspace: manager.workspaceKey(workspace), originalThread: thread, signal,
    currentDatabase: getDb, readThread: () => getThreadCore(threadId), assertCurrent: guard })
  const state = readFunctionConversationState(tuple.checkpoint.channel_values.cmbFunctionConversation)
  const binding = requireMainFunctionConversationRecovery(decide(tuple.config, state))
  // Keep validation outside getLatestCheckpoint's legacy read-error fallback: a stale/forged
  // host anchor must fail closed, never become an empty tail or replay the compacted history.
  return withCheckpointer(threadId, async saver => {
    const host = { saver, store, control: manager.store, database, binding }
    guard()
    await reconcileFunctionConversationCompaction(host, tuple.config)
    guard()
    return readFunctionConversationCompactionBoundary(host, tuple)
  })
}

export async function getDurableRuntimeTail(
  threadId: string,
  options: {
    excludeMessageIds?: readonly string[]
    excludeMessages?: readonly Pick<Message, "id" | "role">[]
    /** Set only after invoke replacement proves every predecessor settled. */
    allowBoundedCheckpointRecovery?: boolean
    resolveFunctionRow?: PersistedRuntimeMessageOptions["resolveFunctionRow"]
  } = {}
): Promise<DurableRuntimeTail> {
  const resolveFunctionRow = options.resolveFunctionRow
  const tuple = await getLatestCheckpoint(
    threadId,
    options.allowBoundedCheckpointRecovery === true
  )
  if (!tuple) {
    return { messages: [], persistedMessages: [], checkpointHasInterrupt: false }
  }
  const checkpoint = tuple.checkpoint

  const transcript = deriveCheckpointTranscriptIndex(checkpoint)
  if (transcript.hasInvalidFunctionRows)
    throw new ModFunctionError("MODS_CONVERSATION_TRANSCRIPT_INVALID")
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
      transcript.visibleMessages
        .slice(-32)
        .flatMap((message) =>
          [message.renderId, message.id].filter((id): id is string => Boolean(id))
        )
    )
  )
  const durableCheckpointBoundaries = getThreadMessagesByIds(threadId, recentCheckpointIds)
  const covered = durableCheckpointBoundaries.length === 0
    ? await compactedBoundary(threadId, tuple) : undefined
  const persistedMessages =
    durableCheckpointBoundaries.length > 0
      ? getThreadMessagesAfterAnyId(
          threadId,
          durableCheckpointBoundaries.map((message) => message.id)
        )
      : covered ? getThreadMessagesAfterAnyId(threadId, [covered]) : getThreadMessages(threadId)
  const persistedTail = findDurableTailMessagesAfterCheckpoint(
    persistedMessages,
    transcript.visibleMessages,
    options
  )
  return {
    messages: persistedTail
      .map((message) => persistedMessageToRuntimeMessage(message, { resolveFunctionRow }))
      .filter((message): message is BaseMessage => message !== null),
    persistedMessages: persistedTail,
    checkpointHasInterrupt: checkpointHasInterrupt(checkpoint)
  }
}
