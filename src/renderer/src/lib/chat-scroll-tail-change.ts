import type { Message } from "../types"
import {
  getMessageProviderOccurrence,
  getMessageProviderSourceId
} from "../../../shared/message-role-collision"

export interface ChatScrollTailSnapshot {
  visibleCount: number
  lastMessageId: string | null
  lastMessageIdentity: string | null
  loadedMessageCount: number
}

export interface ChatScrollTailChange {
  appendedMessageCount: number
  unreadMessageCount: number
  /** Whether the logical visible tail moved to a different message. */
  tailChanged: boolean
  /** Whether visible rows moved backwards, such as a failed optimistic send being removed. */
  regressed: boolean
}

export interface ClassifyChatScrollTailChangeInput {
  previous: ChatScrollTailSnapshot
  current: ChatScrollTailSnapshot
  displayMessages: readonly Message[]
  visibleMessageIndexes: readonly number[]
  /** Maps an exact renderer message id to its index in `visibleMessageIndexes`. */
  visibleMessageIndexById: ReadonlyMap<string, number>
}

export interface ShouldMarkChatTailContentGrowthInput {
  change: ChatScrollTailChange
  currentTail: Message | undefined
  contentVersionChanged: boolean
  structureVersionChanged: boolean
  changedTail: boolean
}

export function shouldMarkChatTailContentGrowth({
  change,
  currentTail,
  contentVersionChanged,
  structureVersionChanged,
  changedTail
}: ShouldMarkChatTailContentGrowthInput): boolean {
  if (change.regressed || currentTail === undefined || currentTail.role === "user") return false
  if (change.tailChanged) return true
  // A structure rebuild reports every message as changed. With the same logical tail this is a
  // history prepend/reorder, not new output. A later content-only frame will report real growth.
  return contentVersionChanged && !structureVersionChanged && changedTail
}

/**
 * Stable visible-tail identity. Provider identity survives a renderer id re-key; a row without
 * provider metadata falls back to its role and exact id. Normalizing both forms to occurrence 1
 * also makes the common provisional-id -> provider-source-id promotion compare equal.
 */
export function chatScrollTailMessageIdentity(message: Message | undefined): string | null {
  if (!message) return null
  const providerSourceId = getMessageProviderSourceId(message)
  const sourceId = providerSourceId || message.id.trim()
  const occurrence = providerSourceId ? (getMessageProviderOccurrence(message) ?? 1) : 1
  return `${message.role}\u0000${sourceId}\u0000${occurrence}`
}

function findPreviousTailVisibleIndex(
  previous: ChatScrollTailSnapshot,
  current: ChatScrollTailSnapshot,
  displayMessages: readonly Message[],
  visibleMessageIndexes: readonly number[],
  visibleMessageIndexById: ReadonlyMap<string, number>
): number | undefined {
  if (previous.lastMessageId !== null) {
    const exactIndex = visibleMessageIndexById.get(previous.lastMessageId)
    if (
      exactIndex !== undefined &&
      Number.isInteger(exactIndex) &&
      exactIndex >= 0 &&
      exactIndex < current.visibleCount &&
      chatScrollTailMessageIdentity(displayMessages[visibleMessageIndexes[exactIndex]]) ===
        previous.lastMessageIdentity
    ) {
      return exactIndex
    }
  }

  if (previous.lastMessageIdentity === null) return undefined
  for (let visibleIndex = current.visibleCount - 1; visibleIndex >= 0; visibleIndex -= 1) {
    const messageIndex = visibleMessageIndexes[visibleIndex]
    if (
      messageIndex !== undefined &&
      chatScrollTailMessageIdentity(displayMessages[messageIndex]) ===
        previous.lastMessageIdentity
    ) {
      return visibleIndex
    }
  }
  return undefined
}

/**
 * Classifies a projected transcript update without mistaking older-page prepends for new output.
 * The unchanged-tail fast path deliberately returns before touching the history arrays or map.
 */
export function classifyChatScrollTailChange({
  previous,
  current,
  displayMessages,
  visibleMessageIndexes,
  visibleMessageIndexById
}: ClassifyChatScrollTailChangeInput): ChatScrollTailChange {
  const tailChanged = current.lastMessageIdentity !== previous.lastMessageIdentity
  const regressed = current.visibleCount < previous.visibleCount
  if (!tailChanged) {
    return { appendedMessageCount: 0, unreadMessageCount: 0, tailChanged: false, regressed }
  }

  const previousTailVisibleIndex = findPreviousTailVisibleIndex(
    previous,
    current,
    displayMessages,
    visibleMessageIndexes,
    visibleMessageIndexById
  )
  const appendedMessageCount =
    previousTailVisibleIndex !== undefined
      ? Math.max(0, current.visibleCount - previousTailVisibleIndex - 1)
      : previous.visibleCount === 0 && previous.loadedMessageCount === 0
        ? current.visibleCount
        : 0

  let unreadMessageCount = 0
  const appendedStart = Math.max(0, current.visibleCount - appendedMessageCount)
  for (let visibleIndex = appendedStart; visibleIndex < current.visibleCount; visibleIndex += 1) {
    const messageIndex = visibleMessageIndexes[visibleIndex]
    if (messageIndex !== undefined && displayMessages[messageIndex]?.role !== "user") {
      unreadMessageCount += 1
    }
  }

  return { appendedMessageCount, unreadMessageCount, tailChanged, regressed }
}
