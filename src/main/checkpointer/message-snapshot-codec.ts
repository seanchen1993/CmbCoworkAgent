/** Shared message-delta codec extracted from SqlJsSaver. Storage owners keep their
 * own transaction, retention, lease and recovery policies. */
export const MAX_CHECKPOINT_MESSAGE_SNAPSHOT_DEPTH = 128
export const MAX_CHECKPOINT_MESSAGE_DELTA_BYTES = 8 * 1024 * 1024
const MESSAGE_PREFIX_SENTINEL_COUNT = 24
const MESSAGE_PREFIX_TAIL_WINDOW = 16
const MESSAGE_PREFIX_MIN_SHARED_TAIL = 4
const EXTERNAL_MESSAGES_MARKER = "__cmb_sqljs_external_messages_v1"

export interface CheckpointMessageWriteState {
  checkpointId: string
  messages: unknown[]
  messageCount: number
  prefixSentinels: CheckpointMessageSentinel[]
  tailSentinels: CheckpointMessageSentinel[]
  hasExternalSnapshot: boolean
  snapshotDepth: number
  deltaBytes: number
  snapshotGeneration: string | null
}

interface CheckpointMessageSentinel {
  index: number
  value: unknown
}

interface ExternalMessagesReference {
  [EXTERNAL_MESSAGES_MARKER]: true
  messageCount: number
}

export function buildExternalMessagesReference(messageCount: number): ExternalMessagesReference {
  return {
    [EXTERNAL_MESSAGES_MARKER]: true,
    messageCount
  }
}

export function isExternalMessagesReference(value: unknown): value is ExternalMessagesReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<ExternalMessagesReference>
  return candidate[EXTERNAL_MESSAGES_MARKER] === true && Number.isInteger(candidate.messageCount)
}

export function captureCheckpointMessageSentinels(messages: unknown[]): {
  messageCount: number
  prefixSentinels: CheckpointMessageSentinel[]
  tailSentinels: CheckpointMessageSentinel[]
} {
  const messageCount = messages.length
  const tailStart = Math.max(0, messageCount - MESSAGE_PREFIX_TAIL_WINDOW)
  const prefixSentinels: CheckpointMessageSentinel[] = []
  if (tailStart > 0) {
    const sentinelCount = Math.min(MESSAGE_PREFIX_SENTINEL_COUNT, tailStart)
    const indices = new Set<number>()
    for (let offset = 0; offset < sentinelCount; offset += 1) {
      const index =
        sentinelCount === 1 ? 0 : Math.floor((offset * (tailStart - 1)) / (sentinelCount - 1))
      indices.add(index)
    }
    for (const index of indices) prefixSentinels.push({ index, value: messages[index] })
  }

  const tailSentinels: CheckpointMessageSentinel[] = []
  for (let index = tailStart; index < messageCount; index += 1) {
    tailSentinels.push({ index, value: messages[index] })
  }
  return { messageCount, prefixSentinels, tailSentinels }
}

/**
 * Return a trusted common prefix for the append/replace-tail shapes emitted by
 * LangGraph's messages reducer. Distributed sentinels guard the stable history,
 * while the final window identifies an exact changed suffix without rescanning
 * a long transcript. Shapes that do not prove that structural sharing fall
 * back to the exact reference scan below.
 */
function trustedMessageReferencePrefix(
  previous: CheckpointMessageWriteState,
  next: unknown[]
): number | null {
  const previousCount = previous.messageCount
  if (previousCount === 0) return 0
  if (next.length < previousCount) return null

  for (const sentinel of previous.prefixSentinels) {
    if (next[sentinel.index] !== sentinel.value) {
      // If the same array was mutated in place, it no longer contains the
      // persisted prefix needed by the exact fallback. Rebase safely instead.
      return next === previous.messages ? 0 : null
    }
  }

  let sharedTail = 0
  for (const sentinel of previous.tailSentinels) {
    if (next[sentinel.index] !== sentinel.value) {
      return sharedTail >= Math.min(MESSAGE_PREFIX_MIN_SHARED_TAIL, sentinel.index)
        ? sentinel.index
        : next === previous.messages
          ? 0
          : null
    }
    sharedTail += 1
  }

  if (next === previous.messages || next.length > previousCount) return previousCount
  // A cloned, equal-length array could contain an unsampled replacement in the
  // middle. Treat it as ambiguous and retain the exact fallback.
  return null
}

export function commonMessageReferencePrefix(
  previous: CheckpointMessageWriteState,
  next: unknown[]
): number {
  const trustedPrefix = trustedMessageReferencePrefix(previous, next)
  if (trustedPrefix !== null) return trustedPrefix
  if (previous.messages.length !== previous.messageCount) return 0

  return exactMessageReferencePrefix(previous.messages, next)
}

/** Compare every retained reference. Callers keep a shallow copy so replacing an
 * entry in the reducer's array cannot rewrite the persisted prefix identity.
 * Message values obey LangGraph's immutable-message reducer contract. */
export function exactMessageReferencePrefix(
  previous: readonly unknown[],
  next: readonly unknown[]
): number {
  const limit = Math.min(previous.length, next.length)
  let index = 0
  while (index < limit && previous[index] === next[index]) index += 1
  return index
}

export function serializedPayloadBytes(payload: string | Uint8Array): number {
  return typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.byteLength
}

export interface CheckpointMessageChunk {
  messages: unknown[]
  start: number
  end: number
}

export function truncateCheckpointMessageChunks(
  chunks: CheckpointMessageChunk[],
  currentLength: number,
  length: number
): void {
  let retainedLength = currentLength
  while (retainedLength > length) {
    const chunk = chunks.at(-1)
    if (!chunk) break
    const chunkLength = chunk.end - chunk.start
    const removeCount = Math.min(chunkLength, retainedLength - length)
    chunk.end -= removeCount
    retainedLength -= removeCount
    if (chunk.start === chunk.end) chunks.pop()
  }
}

export function materializeCheckpointMessageChunks(
  chunks: readonly CheckpointMessageChunk[],
  messageCount: number
): unknown[] {
  const messages = new Array<unknown>(messageCount)
  let outputIndex = 0
  for (const chunk of chunks) {
    for (let sourceIndex = chunk.start; sourceIndex < chunk.end; sourceIndex += 1) {
      messages[outputIndex] = chunk.messages[sourceIndex]
      outputIndex += 1
    }
  }
  if (outputIndex !== messageCount) {
    throw new Error("[SqlJsSaver] Checkpoint message chunk count mismatch")
  }
  return messages
}
