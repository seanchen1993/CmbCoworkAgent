import type { Message } from "../types"
import {
  createLiveStreamCumulativeFrameProjector,
  createLiveStreamMessageIdNormalizer,
  createLiveStreamTranscriptIndexCache,
  liveStreamMessageRole,
  normalizeLiveStreamMessageContent,
  type LiveStreamMessage
} from "./live-stream-messages"
import {
  filterCoordinatorNoiseMessages,
  isCoordinatorNotificationPrompt
} from "./message-display-helpers"
import { messageHasVisibleRow } from "./message-display-visibility"

export interface LiveDisplayMessageProjection {
  /** Stable across content-only frames; changed slots are replaced in place. */
  messages: Message[]
  indexById: ReadonlyMap<string, number>
  messageIds: ReadonlySet<string>
  changedMessages: readonly Message[]
  contentVersion: number
  structureVersion: number
  lastUserMessageId: string | null
}

function projectLiveDisplayMessage(
  streamMessage: LiveStreamMessage,
  previous: Message | undefined,
  createdAtById: Map<string, Date>
): Message | null {
  const id = streamMessage.id
  if (!id) return null
  if (
    streamMessage.type === "human" &&
    isCoordinatorNotificationPrompt(streamMessage.content)
  ) {
    return null
  }

  const role = liveStreamMessageRole(streamMessage.type)
  let createdAt =
    streamMessage.start_at ?? streamMessage.end_at ?? previous?.created_at ?? createdAtById.get(id)
  if (!createdAt) {
    createdAt = new Date()
    createdAtById.set(id, createdAt)
  }
  const projected: Message = {
    id,
    role,
    content: normalizeLiveStreamMessageContent(streamMessage.content),
    ...(role === "assistant" && streamMessage.reasoning
      ? { reasoning: streamMessage.reasoning }
      : {}),
    tool_calls: streamMessage.tool_calls,
    ...(role === "tool" && streamMessage.tool_call_id
      ? { tool_call_id: streamMessage.tool_call_id }
      : {}),
    ...(role === "tool" && streamMessage.name ? { name: streamMessage.name } : {}),
    ...(role === "tool" && streamMessage.is_error !== undefined
      ? { is_error: streamMessage.is_error }
      : {}),
    created_at: createdAt,
    ...(streamMessage.start_at ? { start_at: streamMessage.start_at } : {}),
    ...(streamMessage.end_at ? { end_at: streamMessage.end_at } : {})
  }
  return filterCoordinatorNoiseMessages([projected])[0] ?? null
}

/**
 * Projects the SDK's cumulative current-turn snapshot directly into display
 * rows. Stable prefix rows are neither normalized nor reconstructed while an
 * assistant content/reasoning tail grows.
 */
export function createLiveDisplayMessageProjector(): (
  baseline: readonly Message[],
  incoming: readonly LiveStreamMessage[]
) => LiveDisplayMessageProjection {
  const getTranscriptIndex = createLiveStreamTranscriptIndexCache()
  const normalizeMessageIds = createLiveStreamMessageIdNormalizer()
  const projectCumulativeFrame = createLiveStreamCumulativeFrameProjector()
  const createdAtById = new Map<string, Date>()
  let messages: Message[] = []
  let indexById = new Map<string, number>()
  let messageIds = new Set<string>()
  let contentVersion = 0
  let structureVersion = 0
  let lastUserMessageId: string | null = null

  const reconcile = (normalized: readonly LiveStreamMessage[]): LiveDisplayMessageProjection => {
    const nextMessages: Message[] = []
    const nextIndexById = new Map<string, number>()
    let nextLastUserMessageId: string | null = null
    for (const streamMessage of normalized) {
      const projected = projectLiveDisplayMessage(
        streamMessage,
        streamMessage.id ? messages[indexById.get(streamMessage.id) ?? -1] : undefined,
        createdAtById
      )
      if (!projected) continue
      nextIndexById.set(projected.id, nextMessages.length)
      nextMessages.push(projected)
      if (projected.role === "user") nextLastUserMessageId = projected.id
    }
    messages = nextMessages
    indexById = nextIndexById
    messageIds = new Set(nextIndexById.keys())
    lastUserMessageId = nextLastUserMessageId
    contentVersion += 1
    structureVersion += 1
    return {
      messages,
      indexById,
      messageIds,
      changedMessages: messages,
      contentVersion,
      structureVersion,
      lastUserMessageId
    }
  }

  return (baseline, incoming) => {
    const transcriptIndex = getTranscriptIndex(baseline)
    const frame = projectCumulativeFrame(
      incoming,
      () => normalizeMessageIds(() => transcriptIndex.messageIdentities, incoming, transcriptIndex),
      transcriptIndex
    )
    if (frame.completeReconcile) return reconcile(frame.messages)

    const changedMessages: Message[] = []
    for (const streamMessage of frame.changedMessages) {
      const id = streamMessage.id
      if (!id) return reconcile(frame.messages)
      const displayIndex = indexById.get(id)
      const previous = displayIndex === undefined ? undefined : messages[displayIndex]
      const projected = projectLiveDisplayMessage(streamMessage, previous, createdAtById)
      // A content update that changes whether the row is displayable changes
      // layout and must use the canonical full projection.
      if (!projected || displayIndex === undefined) return reconcile(frame.messages)
      messages[displayIndex] = projected
      changedMessages.push(projected)
    }
    if (changedMessages.length > 0) contentVersion += 1
    return {
      messages,
      indexById,
      messageIds,
      changedMessages,
      contentVersion,
      structureVersion,
      lastUserMessageId
    }
  }
}

export interface DynamicLiveVisibilityProjectionInput {
  live: LiveDisplayMessageProjection
  displayMessages: readonly Message[]
  displayIndexById: ReadonlyMap<string, number>
  displayContentVersion: number
  displayStructureVersion: number
  hasHookLogChip: (message: Message) => boolean
}

export interface DynamicLiveVisibilityProjection {
  byIndex: ReadonlyMap<number, boolean>
  orderedVisibleIndexes: readonly number[]
  version: number
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (values[middle] < target) low = middle + 1
    else high = middle
  }
  return low
}

/** Keeps the live-row visibility map incremental on content-only tail frames. */
export function createDynamicLiveVisibilityProjector(): (
  input: DynamicLiveVisibilityProjectionInput
) => DynamicLiveVisibilityProjection {
  let previousLiveContentVersion = -1
  let previousLiveStructureVersion = -1
  let previousDisplayContentVersion = -1
  let previousDisplayStructureVersion = -1
  let previousDisplayIndexById: ReadonlyMap<string, number> | null = null
  let previousHasHookLogChip: DynamicLiveVisibilityProjectionInput["hasHookLogChip"] | null = null
  let visibility = new Map<number, boolean>()
  let orderedVisibleIndexes: number[] = []
  let version = 0

  const rebuild = (input: DynamicLiveVisibilityProjectionInput): void => {
    visibility = new Map()
    orderedVisibleIndexes = []
    for (const liveMessage of input.live.messages) {
      const displayIndex = input.displayIndexById.get(liveMessage.id)
      if (displayIndex === undefined) continue
      const displayMessage = input.displayMessages[displayIndex]
      if (!displayMessage) continue
      const visible = messageHasVisibleRow(displayMessage, input.hasHookLogChip(displayMessage))
      visibility.set(displayIndex, visible)
      if (visible) orderedVisibleIndexes.push(displayIndex)
    }
    orderedVisibleIndexes.sort((left, right) => left - right)
    version += 1
  }

  return (input) => {
    const structureChanged =
      input.live.structureVersion !== previousLiveStructureVersion ||
      input.displayStructureVersion !== previousDisplayStructureVersion ||
      input.displayIndexById !== previousDisplayIndexById ||
      input.hasHookLogChip !== previousHasHookLogChip
    const liveContentChanged = input.live.contentVersion !== previousLiveContentVersion
    const displayContentChanged =
      input.displayContentVersion !== previousDisplayContentVersion

    if (structureChanged || (displayContentChanged && !liveContentChanged)) {
      rebuild(input)
    } else if (liveContentChanged) {
      for (const liveMessage of input.live.changedMessages) {
        const displayIndex = input.displayIndexById.get(liveMessage.id)
        if (displayIndex === undefined) continue
        const displayMessage = input.displayMessages[displayIndex]
        if (!displayMessage) continue
        const previousVisible = visibility.get(displayIndex) === true
        const nextVisible = messageHasVisibleRow(
          displayMessage,
          input.hasHookLogChip(displayMessage)
        )
        visibility.set(displayIndex, nextVisible)
        if (previousVisible === nextVisible) continue
        const insertionIndex = lowerBound(orderedVisibleIndexes, displayIndex)
        if (nextVisible) {
          orderedVisibleIndexes.splice(insertionIndex, 0, displayIndex)
        } else if (orderedVisibleIndexes[insertionIndex] === displayIndex) {
          orderedVisibleIndexes.splice(insertionIndex, 1)
        }
        version += 1
      }
    }

    previousLiveContentVersion = input.live.contentVersion
    previousLiveStructureVersion = input.live.structureVersion
    previousDisplayContentVersion = input.displayContentVersion
    previousDisplayStructureVersion = input.displayStructureVersion
    previousDisplayIndexById = input.displayIndexById
    previousHasHookLogChip = input.hasHookLogChip
    return { byIndex: visibility, orderedVisibleIndexes, version }
  }
}
