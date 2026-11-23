import type { Message } from "../types"
import {
  getMessageProviderOccurrence,
  getMessageProviderSourceId
} from "../../../shared/message-role-collision"
import { readToolOwnershipId } from "../../../shared/tool-result-ownership"
import { findReplayedToolExchangeAliases } from "../../../shared/tool-transcript-replay"
import { reconcileMessageDisplayOrder } from "./message-display-order"

export {
  findReplayedToolExchangeAliases as findDisplayedReplayAliases,
  preserveReplayToolBindings
} from "../../../shared/tool-transcript-replay"

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

const noReplayAliases: ReadonlyMap<string, string> = new Map()

function replaySourceKey(message: Message): string | undefined {
  if (message.role === "assistant" || message.role === "tool") {
    return `${message.role}:${getMessageProviderSourceId(message)}`
  }
  return undefined
}

function sameToolSlots(before: Message["tool_calls"], after: Message["tool_calls"]): boolean {
  if (before === after) return true
  const previous = Array.isArray(before) ? before : []
  const next = Array.isArray(after) ? after : []
  return previous.length === next.length && previous.every((call, index) =>
    readToolOwnershipId(call) === readToolOwnershipId(next[index]) &&
    call?.name === next[index]?.name
  )
}

/** Recheck replay proof on order, ownership or evidence changes, including live reasoning. */
export function createChatReplayAliasProjector(): (
  display: ChatMessageProjection
) => ReadonlyMap<string, string> {
  let previousMessages: readonly Message[] | undefined
  let previousStructureVersion = -1
  let previousById = new Map<string, Message>()
  let repeatedSources = new Set<string>()
  let toolReplayAssistantIds = new Set<string>()
  let aliases = noReplayAliases

  return ({ messages, changedMessages, structureVersion }) => {
    let rebuildSources = messages !== previousMessages || structureVersion !== previousStructureVersion
    let evidenceChanged = false
    if (!rebuildSources) {
      for (const message of changedMessages) {
        const previous = previousById.get(message.id)
        if (message === previous) continue
        const source = replaySourceKey(message)
        if (!previous || message.role !== previous.role || source !== replaySourceKey(previous)) {
          rebuildSources = true
          break
        }
        previousById.set(message.id, message)
        if (!source) continue
        evidenceChanged ||= (repeatedSources.has(source) &&
          (message.role === "tool" || toolReplayAssistantIds.has(message.id))) ||
          previous.tool_call_id !== message.tool_call_id ||
          previous.historical_tool_replay_id !== message.historical_tool_replay_id ||
          (message.role === "tool" && previous.name !== message.name) ||
          getMessageProviderOccurrence(previous) !== getMessageProviderOccurrence(message) ||
          !sameToolSlots(previous.tool_calls, message.tool_calls)
      }
    }
    if (rebuildSources) {
      previousMessages = messages
      previousStructureVersion = structureVersion
      previousById = new Map()
      repeatedSources = new Set()
      const sources = new Set<string>()
      for (const message of messages) {
        previousById.set(message.id, message)
        const source = replaySourceKey(message)
        if (!source) continue
        if (sources.has(source)) repeatedSources.add(source)
        sources.add(source)
      }
    }
    if (rebuildSources || evidenceChanged) {
      toolReplayAssistantIds = new Set()
      const nextAliases = findReplayedToolExchangeAliases(messages, toolReplayAssistantIds)
      if (nextAliases.size !== aliases.size ||
          [...nextAliases].some(([id, target]) => aliases.get(id) !== target)) {
        aliases = nextAliases
      }
    }
    return aliases
  }
}

/** A live row may have the only surviving copy of renderer-only reasoning. */
export function resolveChatReplayAliases(
  replayAliases: ReadonlyMap<string, string>,
  liveMessages: readonly Message[],
  display: ChatMessageProjection,
  liveMessageIds?: ReadonlySet<string>
): ReadonlyMap<string, string> {
  if (replayAliases.size === 0) return replayAliases
  const carriesUniqueReasoning = (id: string, canonical: string): boolean => {
    const index = display.indexById.get(id)
    const canonicalIndex = display.indexById.get(canonical)
    if (index === undefined || canonicalIndex === undefined) return false
    const reasoning = display.messages[index].reasoning
    return Boolean(reasoning && display.messages[canonicalIndex].reasoning !== reasoning)
  }
  if (liveMessageIds && replayAliases.size < liveMessages.length) {
    for (const [id, canonical] of replayAliases) {
      if (liveMessageIds.has(id) && carriesUniqueReasoning(id, canonical)) return noReplayAliases
    }
    return replayAliases
  }
  for (const live of liveMessages) {
    const canonical = replayAliases.get(live.id)
    if (canonical && carriesUniqueReasoning(live.id, canonical)) return noReplayAliases
  }
  return replayAliases
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
  if (baseline.role !== "assistant" || live.role !== "assistant") return baseline

  const reasoning =
    !baseline.reasoning && typeof live.reasoning === "string" && live.reasoning.trim()
      ? live.reasoning
      : undefined
  // Durable data remains authoritative when it explicitly contains an array,
  // including [] as a clear. A live non-empty value only fills a missing field.
  const toolCalls =
    !Array.isArray(baseline.tool_calls) &&
    Array.isArray(live.tool_calls) &&
    live.tool_calls.length > 0
      ? live.tool_calls
      : undefined

  if (reasoning === undefined && toolCalls === undefined) return baseline
  return {
    ...baseline,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {})
  }
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
  liveProjection?: ChatLiveMessageProjectionMetadata,
  valuesOrderRevision?: number
) => ChatMessageProjection {
  let previousBaseline: readonly Message[] | null = null
  let previousBaselineContentVersion = 0
  let previousBaselineTailSnapshot: Message | undefined
  let previousLiveStructureKey = ""
  let previousLiveProjectionContentVersion = -1
  let previousLiveProjectionStructureVersion = -1
  let previousUsedLiveProjection = false
  let previousOrderHintStructureKey = ""
  let previousValuesOrderRevision = 0
  let baselineIndexById = new Map<string, number>()
  let liveIndexById = new Map<string, number>()
  let messages: Message[] = []
  let indexById = new Map<string, number>()
  let contentVersion = 0
  let structureVersion = 0

  return (
    baseline,
    liveMessages,
    orderHintMessages,
    baselineContentVersion = 0,
    liveProjection,
    valuesOrderRevision = 0
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
      valuesOrderRevision !== previousValuesOrderRevision ||
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
        const liveIndex = liveIndexById.get(nextTail.id)
        const live = liveIndex === undefined ? undefined : liveMessages[liveIndex]
        const nextMessage = live ? resolveBaselineLiveMessage(nextTail, live) : nextTail
        messages[displayIndex] = nextMessage
        changedMessages.push(nextMessage)
        contentVersion += 1
      } else {
        structureChanged = true
      }
    }

    if (structureChanged) {
      baselineIndexById = new Map(baseline.map((message, index) => [message.id, index]))
      liveIndexById = new Map(liveMessages.map((message, index) => [message.id, index]))
      const merged = baseline.map((message) => {
        const liveIndex = liveIndexById.get(message.id)
        const live = liveIndex === undefined ? undefined : liveMessages[liveIndex]
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
      previousValuesOrderRevision = valuesOrderRevision
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
