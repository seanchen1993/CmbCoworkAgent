import type { Message } from "../types"
import { reconcileMessageDisplayOrder } from "./message-display-order"

export interface ChatMessageProjection {
  /**
   * The array identity is stable while only live content changes. Individual
   * live slots are replaced in place; consumers that render content must also
   * observe `contentVersion`.
   */
  messages: Message[]
  indexById: ReadonlyMap<string, number>
  changedMessages: readonly Message[]
  contentVersion: number
  structureVersion: number
}

export interface ChatLiveMessageProjectionMetadata {
  changedMessages: readonly Message[]
  contentVersion: number
  structureVersion: number
}

function liveStructureKey(messages: readonly Message[]): string {
  return messages
    .map(
      (message) =>
        `${message.id}\u0000${message.role}\u0000${message.tool_call_id ?? ""}\u0000${
          message.provider_occurrence ?? ""
        }`
    )
    .join("\u0001")
}

/**
 * `useStream().messages` may be a fresh content snapshot for every token. Its
 * length and boundary ids are enough to invalidate the cached layout for the
 * structural changes that are not already represented by `liveStructureKey`.
 * Internal live reorders are covered by that key; persisted reorders replace
 * the baseline array.
 */
function orderHintStructureKey(
  messages: ReadonlyArray<{ id?: string }> | undefined
): string {
  if (!messages?.length) return "0"
  return `${messages.length}\u0000${messages[0]?.id ?? ""}\u0000${
    messages[messages.length - 1]?.id ?? ""
  }`
}

function resolveBaselineLiveMessage(baseline: Message, live: Message): Message {
  if (
    baseline.role === "assistant" &&
    !baseline.reasoning &&
    typeof live.reasoning === "string" &&
    live.reasoning.trim()
  ) {
    return { ...baseline, reasoning: live.reasoning }
  }
  return baseline
}

/**
 * Builds the complete display order only when message identity/order changes.
 * A content-only token frame touches the (normally tiny) live suffix and swaps
 * those slots in the existing array, avoiding a copy or traversal of the
 * persisted history.
 */
export function createChatMessageProjector(): (
  baseline: readonly Message[],
  liveMessages: readonly Message[],
  orderHintMessages: ReadonlyArray<{ id?: string }> | undefined,
  baselineContentVersion?: number,
  liveProjection?: ChatLiveMessageProjectionMetadata
) => ChatMessageProjection {
  let previousBaseline: readonly Message[] | null = null
  let previousBaselineContentVersion = 0
  let previousBaselineTailSnapshot: Message | undefined
  let previousLiveStructureKey = ""
  let previousLiveProjectionContentVersion = -1
  let previousLiveProjectionStructureVersion = -1
  let previousUsedLiveProjection = false
  let previousOrderHintStructureKey = ""
  let baselineIndexById = new Map<string, number>()
  let messages: Message[] = []
  let indexById = new Map<string, number>()
  let contentVersion = 0
  let structureVersion = 0

  return (
    baseline,
    liveMessages,
    orderHintMessages,
    baselineContentVersion = 0,
    liveProjection
  ) => {
    const usesLiveProjection = Boolean(liveProjection)
    const nextLiveStructureKey = usesLiveProjection ? "" : liveStructureKey(liveMessages)
    const nextOrderHintStructureKey = orderHintStructureKey(orderHintMessages)
    const baselineContentChanged =
      baselineContentVersion !== previousBaselineContentVersion
    let structureChanged =
      baseline !== previousBaseline ||
      usesLiveProjection !== previousUsedLiveProjection ||
      (liveProjection
        ? liveProjection.structureVersion !== previousLiveProjectionStructureVersion
        : nextLiveStructureKey !== previousLiveStructureKey) ||
      nextOrderHintStructureKey !== previousOrderHintStructureKey

    const changedMessages: Message[] = []

    if (
      !structureChanged &&
      baselineContentChanged
    ) {
      const nextTail = baseline.at(-1)
      const previousTail = previousBaselineTailSnapshot
      const displayIndex = previousTail ? indexById.get(previousTail.id) : undefined
      if (
        nextTail &&
        previousTail &&
        displayIndex !== undefined &&
        nextTail.id === previousTail.id &&
        nextTail.role === previousTail.role &&
        nextTail.tool_call_id === previousTail.tool_call_id
      ) {
        messages[displayIndex] = nextTail
        changedMessages.push(nextTail)
        contentVersion += 1
      } else {
        structureChanged = true
      }
    }

    if (structureChanged) {
      baselineIndexById = new Map(baseline.map((message, index) => [message.id, index]))
      const liveById = new Map(liveMessages.map((message) => [message.id, message]))
      const merged = baseline.map((message) => {
        const live = liveById.get(message.id)
        return live ? resolveBaselineLiveMessage(message, live) : message
      })
      for (const live of liveMessages) {
        if (!baselineIndexById.has(live.id)) merged.push(live)
      }

      messages = reconcileMessageDisplayOrder(merged, orderHintMessages)
      indexById = new Map(messages.map((message, index) => [message.id, index]))
      previousBaseline = baseline
      previousBaselineContentVersion = baselineContentVersion
      previousBaselineTailSnapshot = baseline.at(-1)
      previousLiveStructureKey = nextLiveStructureKey
      previousLiveProjectionContentVersion = liveProjection?.contentVersion ?? -1
      previousLiveProjectionStructureVersion = liveProjection?.structureVersion ?? -1
      previousUsedLiveProjection = usesLiveProjection
      previousOrderHintStructureKey = nextOrderHintStructureKey
      contentVersion += 1
      structureVersion += 1
      return {
        messages,
        indexById,
        changedMessages: messages,
        contentVersion,
        structureVersion
      }
    }

    let contentChanged = false
    const liveMessagesToUpdate =
      liveProjection &&
      liveProjection.contentVersion !== previousLiveProjectionContentVersion
        ? liveProjection.changedMessages
        : liveProjection
          ? []
          : liveMessages
    for (const live of liveMessagesToUpdate) {
      const displayIndex = indexById.get(live.id)
      if (displayIndex === undefined) continue
      const baselineIndex = baselineIndexById.get(live.id)
      const nextMessage =
        baselineIndex === undefined
          ? live
          : resolveBaselineLiveMessage(baseline[baselineIndex], live)
      if (messages[displayIndex] === nextMessage) continue
      messages[displayIndex] = nextMessage
      changedMessages.push(nextMessage)
      contentChanged = true
    }
    if (contentChanged) contentVersion += 1
    if (baselineContentChanged) {
      previousBaselineContentVersion = baselineContentVersion
      previousBaselineTailSnapshot = baseline.at(-1)
    }

    previousLiveProjectionContentVersion = liveProjection?.contentVersion ?? -1
    previousLiveProjectionStructureVersion = liveProjection?.structureVersion ?? -1
    previousUsedLiveProjection = usesLiveProjection

    return { messages, indexById, changedMessages, contentVersion, structureVersion }
  }
}
