import type { BaseMessage } from "@langchain/core/messages"
import type { CheckpointTuple } from "@langchain/langgraph-checkpoint"
import {
  captureThreadForkReplay,
  getDb,
  getThreadCore,
  getThreadMessages,
  getThreadMessagesAfterAnyId,
  getThreadMessagesByIds,
  getThreadMessagesForForkReplay
} from "../db"
import { withCheckpointer } from "../agent/runtime"
import type { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { forkReplayMessageDigest, readGraphInputForkReplay } from "../checkpointer/fork-replay-proof"
import type { Message } from "../types"
import {
  checkpointEndsWithAssistantToolCalls,
  checkpointHasInterrupt,
  type CheckpointTranscriptMessage,
  describeCheckpointMessageForkTarget,
  deriveCheckpointTranscriptIndex,
  findMessagesAfterCheckpointVisibleIds,
  getCheckpointUserMessageIndex
} from "../../shared/checkpoint-transcript"
import { isImRemoteControlTranscriptMessageId } from "../../shared/im-remote-transcript"
import {
  applyForkReplayMessages,
  buildVisibleForkableCheckpointList,
  FORK_DURABLE_TAIL_KEY,
  getCheckpointId,
  MAX_FORK_DURABLE_TAIL_MESSAGES,
  readForkDurableTail,
  type ForkCheckpointListOptions,
  type ForkDurableTailReference
} from "../../shared/checkpoint-forkability"
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
  checkpointTuple?: CheckpointTuple
  messages: BaseMessage[]
  persistedMessages: Message[]
  checkpointHasInterrupt: boolean
}

const MAX_FORK_DURABLE_TAIL_BYTES = 8 * 1024 * 1024

export class UnsafeForkTailError extends Error {}

const matchesForkReplayDigest = (message: Message, digest: string): boolean =>
  forkReplayMessageDigest(persistedMessageToRuntimeMessage(message)) === digest

/** Replay a fork-specific view without changing the underlying graph checkpoint. */
export function replayForkDurableTail(
  tuple: CheckpointTuple,
  durableTail: readonly Message[]
): CheckpointTuple {
  if (durableTail.length === 0) return tuple
  if (tuple.checkpoint.channel_values.cmbFunctionConversation !== undefined)
    throw new UnsafeForkTailError("原生会话的历史边界需要已有的持久化凭据。")
  if (durableTail.length > MAX_FORK_DURABLE_TAIL_MESSAGES) {
    throw new UnsafeForkTailError("当前会话尾部消息过多，无法安全物化到 fork checkpoint。")
  }
  if (Buffer.byteLength(JSON.stringify(durableTail), "utf8") > MAX_FORK_DURABLE_TAIL_BYTES) {
    throw new UnsafeForkTailError("当前会话尾部数据过大，无法安全物化到 fork checkpoint。")
  }
  const messages = durableTail.map((message) => persistedMessageToRuntimeMessage(message))
  if (messages.some((message) => message === null)) {
    throw new UnsafeForkTailError("当前会话尾部包含无法安全恢复的工具消息，暂时不能 fork。")
  }
  const replayed = applyForkReplayMessages(tuple, messages)
  if (!replayed) {
    throw new UnsafeForkTailError("当前会话尾部没有可用于 fork 的可见消息。")
  }
  return replayed
}

export function materializeSavedForkTails(
  threadId: string,
  tuples: readonly CheckpointTuple[]
): CheckpointTuple[] {
  const savedTails = new Map<string, ForkDurableTailReference[]>()
  for (const tuple of tuples) {
    const saved = readForkDurableTail(tuple.metadata)
    if (saved) savedTails.set(getCheckpointId(tuple), saved)
  }
  const graphInputTailByParent = new Map<string, ForkDurableTailReference[]>()
  for (const tuple of tuples) {
    if (tuple.metadata?.source !== "input") continue
    const parentId = tuple.parentConfig?.configurable?.checkpoint_id
    if (typeof parentId !== "string" || savedTails.has(parentId) || graphInputTailByParent.has(parentId)) {
      continue
    }
    const evidence = readGraphInputForkReplay(tuple.checkpoint)
    if (evidence.length > 0) graphInputTailByParent.set(parentId, evidence)
  }
  return tuples.map((tuple, index) => {
    try {
      const references =
        savedTails.get(getCheckpointId(tuple)) ??
        (index > 0 ? graphInputTailByParent.get(getCheckpointId(tuple)) : undefined)
      if (!references) return tuple
      const tail = getThreadMessagesForForkReplay(threadId, references, matchesForkReplayDigest)
      if (
        tail?.every(
          (message) => message.role !== "user" && isRuntimeVisiblePersistedMessage(message)
        )
      ) {
        return replayForkDurableTail(tuple, tail)
      }
    } catch (error) {
      if (!(error instanceof UnsafeForkTailError)) throw error
    }
    return tuple
  })
}

export function getForkableReplyId(
  tuple: CheckpointTuple,
  interrupted: boolean,
  transcript = deriveCheckpointTranscriptIndex(tuple.checkpoint)
): string | undefined {
  if (tuple.metadata?.source === "input" || checkpointHasInterrupt(tuple.checkpoint))
    return undefined
  const last = transcript.visibleMessages.at(-1)
  const id = last?.renderId ?? last?.id
  if (!id) return undefined
  return (interrupted && last?.role === "tool") ||
    describeCheckpointMessageForkTarget(tuple.checkpoint, id, transcript).isForkableMessageBoundary
    ? id
    : undefined
}

/** The stop handler can run before the model's streamed reply reaches the
 * graph. Require a durable user anchor from the stopped logical turn. */
export function captureInterruptedForkReply(
  threadId: string,
  tuple: CheckpointTuple,
  turnUserId: string,
  transcript = deriveCheckpointTranscriptIndex(tuple.checkpoint)
): { replyId: string; durableTail: ForkDurableTailReference[] } | undefined {
  const anchor = transcript.visibleMessages.at(-1)
  if (anchor?.role !== "user" || getCheckpointUserMessageIndex(tuple.checkpoint, turnUserId) < 0)
    return
  const anchors = getThreadMessagesByIds(threadId, [
    anchor.renderId ?? anchor.id,
    anchor.id
  ]).filter((message) => message.role === "user")
  if (anchors.length === 0) return
  const durable = getThreadMessagesAfterAnyId(
    threadId,
    anchors.map(({ id }) => id),
    MAX_FORK_DURABLE_TAIL_MESSAGES + 1
  )
  const tail = findDurableTailMessagesAfterCheckpoint(durable, transcript.visibleMessages)
  const nextUser = tail.findIndex((message) => message.role === "user")
  const reply = nextUser < 0 ? tail : tail.slice(0, nextUser)
  if (reply.length === 0 || (nextUser < 0 && durable.length > MAX_FORK_DURABLE_TAIL_MESSAGES))
    return
  try {
    const replay = replayForkDurableTail(tuple, reply)
    if (checkpointEndsWithAssistantToolCalls(replay.checkpoint)) return undefined
    const replyId = getForkableReplyId(replay, true)
    if (replyId) {
      const durableTail = captureThreadForkReplay(threadId, reply.map(({ id }) => id))
      if (durableTail) return { replyId, durableTail }
    }
  } catch (error) {
    if (!(error instanceof UnsafeForkTailError)) throw error
  }
  return undefined
}

/** Keep the verified durable message identities before the next graph input
 * makes this checkpoint historical. The graph state itself stays untouched. */
export async function preserveForkDurableTail(
  checkpointer: SqlJsSaver,
  tail: DurableRuntimeTail,
  options: ForkCheckpointListOptions,
  ownsRun: () => boolean
): Promise<CheckpointTuple | undefined> {
  const tuple = tail.checkpointTuple
  const firstUser = tail.persistedMessages.findIndex((message) => message.role === "user")
  const messages =
    firstUser < 0 ? tail.persistedMessages : tail.persistedMessages.slice(0, firstUser)
  if (!tuple || readForkDurableTail(tuple.metadata) || messages.length === 0 || !ownsRun()) {
    return undefined
  }
  try {
    const replay = replayForkDurableTail(tuple, messages)
    if (buildVisibleForkableCheckpointList([replay], options).length === 0) return undefined
    const threadId = tuple.config.configurable?.thread_id
    if (typeof threadId !== "string") return undefined
    // Turn setup can yield after reading the durable tail. Reconciliation may
    // have renamed those rows and assigned their old IDs to different messages.
    const evidence = messages.flatMap((message) => {
      const digest = forkReplayMessageDigest(persistedMessageToRuntimeMessage(message))
      return digest ? [{ id: message.id, digest }] : []
    })
    if (evidence.length !== messages.length) return undefined
    const current = getThreadMessagesForForkReplay(threadId, evidence, matchesForkReplayDigest)
    if (current?.length !== messages.length) return undefined
    const references = captureThreadForkReplay(threadId, current.map(({ id }) => id))
    if (!references) return undefined
    const updated = await checkpointer.updateCheckpointMetadata(tuple.config, (metadata) => {
      // The stop handler may have published exact evidence after this read.
      if (!ownsRun() || readForkDurableTail(metadata)) return metadata
      return { ...metadata, [FORK_DURABLE_TAIL_KEY]: references }
    })
    return readForkDurableTail(updated) === references && ownsRun() ? replay : undefined
  } catch (error) {
    if (!(error instanceof UnsafeForkTailError)) throw error
    return undefined
  }
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
        return (await checkpointer.getLatestTupleForDurableTailRecovery(threadId)) ?? null
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
  const checkpointTuple = await getLatestCheckpoint(
    threadId,
    options.allowBoundedCheckpointRecovery === true
  )
  if (!checkpointTuple) {
    return { messages: [], persistedMessages: [], checkpointHasInterrupt: false }
  }
  const { checkpoint } = checkpointTuple

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
    ? await compactedBoundary(threadId, checkpointTuple) : undefined
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
    checkpointTuple,
    messages: persistedTail
      .map((message) => persistedMessageToRuntimeMessage(message, { resolveFunctionRow }))
      .filter((message): message is BaseMessage => message !== null),
    persistedMessages: persistedTail,
    checkpointHasInterrupt: checkpointHasInterrupt(checkpoint)
  }
}
