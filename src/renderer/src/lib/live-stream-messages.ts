import type { ContentBlock, Message } from "@/types"
import { mergeCheckpointAuthorityTranscriptMessages } from "../../../shared/checkpoint-transcript"
import {
  areMessageReplayContentsCompatible,
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId,
  getMessageProviderOccurrence,
  getMessageProviderOccurrenceIdentity,
  getMessageProviderSourceId,
  normalizeAppendedMessageIds,
  normalizeCompleteMessageIds,
  normalizeCompleteSnapshotMessageIds,
  normalizeMessageRoleCollisionIds,
  orderMessagesByIncomingAnchors,
  orderMessagesByProviderOccurrence
} from "../../../shared/message-role-collision"

export interface LiveStreamMessage {
  id?: string
  provider_source_id?: string
  provider_occurrence?: number
  type?: string
  content?: string | unknown[]
  reasoning?: string
  tool_calls?: Message["tool_calls"]
  tool_call_id?: string
  name?: string
  status?: string
  is_error?: boolean
  content_priority?: number
  start_at?: Date
  end_at?: Date
}

interface OccurrenceOrderedMessage {
  id: string
  provider_source_id?: string
  provider_occurrence?: number
  role?: string
  type?: string
}

function occurrenceOrderedMessageRole(message: OccurrenceOrderedMessage): string {
  return message.role ?? liveStreamMessageRole(message.type)
}

function canAppendDisjointProviderBatch(
  previous: readonly OccurrenceOrderedMessage[],
  incoming: readonly OccurrenceOrderedMessage[]
): boolean {
  if (incoming.length === 0) return true

  const occupiedIds = new Set<string>()
  const occupiedProviderIdentities = new Set<string>()
  for (const message of previous) {
    const id = message.id.trim()
    if (!id) return false
    occupiedIds.add(id)
    occupiedProviderIdentities.add(
      `${occurrenceOrderedMessageRole(message)}\u0000${getMessageProviderSourceId(message)}`
    )
  }

  for (const message of incoming) {
    const id = message.id.trim()
    const role = occurrenceOrderedMessageRole(message)
    // Keep the fast path deliberately narrow. Ordinary provider rows carry a
    // unique raw id; aliases, replays, and occurrence collisions retain the
    // full collision-aware normalizer below.
    if (
      !id ||
      getMessageProviderSourceId(message) !== id ||
      getMessageProviderOccurrence(message) !== undefined ||
      occupiedIds.has(id)
    ) {
      return false
    }
    const providerIdentity = `${role}\u0000${id}`
    if (occupiedProviderIdentities.has(providerIdentity)) return false
    occupiedIds.add(id)
    occupiedProviderIdentities.add(providerIdentity)
  }
  return true
}

function orderLiveMessagesByProviderOccurrence(
  messages: readonly LiveStreamMessage[]
): LiveStreamMessage[] {
  const identified = messages.filter(hasLiveStreamMessageId)
  const orderedIdentified = orderMessagesByProviderOccurrence(identified)
  let identifiedIndex = 0
  return messages.map((message) =>
    hasLiveStreamMessageId(message) ? orderedIdentified[identifiedIndex++] : message
  )
}

function findProviderOccurrenceInsertionIndex<T extends OccurrenceOrderedMessage>(
  messages: readonly T[],
  incoming: T,
  currentIndex: number
): number | undefined {
  const incomingOccurrence = getMessageProviderOccurrence(incoming)
  if (incomingOccurrence === undefined) return undefined
  const incomingRole = occurrenceOrderedMessageRole(incoming)
  const incomingSourceId = getMessageProviderSourceId(incoming)
  for (let index = 0; index < currentIndex; index += 1) {
    const candidate = messages[index]
    if (
      occurrenceOrderedMessageRole(candidate) !== incomingRole ||
      getMessageProviderSourceId(candidate) !== incomingSourceId
    ) {
      continue
    }
    const candidateOccurrence = getMessageProviderOccurrence(candidate)
    if (candidateOccurrence !== undefined && candidateOccurrence > incomingOccurrence) {
      return index
    }
  }
  return undefined
}

export function mergeLiveStreamMessages(
  previous: LiveStreamMessage[],
  incoming: LiveStreamMessage[]
): LiveStreamMessage[] {
  const normalizedPrevious = normalizeLiveStreamMessageIds([], previous)
  const normalizedIncoming = normalizeLiveStreamMessageIds(normalizedPrevious, incoming)

  const merged = new Map<string, LiveStreamMessage>()
  for (const message of normalizedPrevious) {
    if (hasLiveStreamMessageId(message)) merged.set(message.id, message)
  }

  for (const message of normalizedIncoming) {
    if (!hasLiveStreamMessageId(message)) continue
    const existing = merged.get(message.id)
    merged.set(message.id, mergeLiveStreamMessageFields(existing, message))
  }

  const orderedIncomingIds = normalizedIncoming
    .filter(hasLiveStreamMessageId)
    .map((message) => message.id)
  const previousIds = normalizedPrevious.filter(hasLiveStreamMessageId).map((message) => message.id)

  const ordered = Array.from(merged.values())
  const previousIdSet = new Set(previousIds)
  let incomingSegmentStartsNewTurn = false
  for (const incomingMessage of normalizedIncoming) {
    if (
      hasLiveStreamMessageId(incomingMessage) &&
      liveStreamMessageRole(incomingMessage.type) === "user"
    ) {
      incomingSegmentStartsNewTurn = !previousIdSet.has(incomingMessage.id)
    }
    if (!hasLiveStreamMessageId(incomingMessage) || previousIdSet.has(incomingMessage.id)) continue
    if (getMessageProviderOccurrence(incomingMessage) === undefined) continue
    const currentIndex = ordered.findIndex((message) => message.id === incomingMessage.id)
    if (currentIndex < 0 || incomingSegmentStartsNewTurn) continue
    const insertionIndex = findProviderOccurrenceInsertionIndex(
      ordered as Array<LiveStreamMessage & { id: string }>,
      incomingMessage,
      currentIndex
    )
    if (insertionIndex === undefined) continue
    const [moved] = ordered.splice(currentIndex, 1)
    ordered.splice(insertionIndex, 0, moved)
  }
  return orderLiveMessagesByProviderOccurrence(
    orderMessagesByIncomingAnchors(
      previousIds,
      ordered.filter(hasLiveStreamMessageId),
      orderedIncomingIds
    )
  )
}

export function normalizeLiveStreamMessageIds(
  previous: ReadonlyArray<LiveStreamMessage>,
  incoming: ReadonlyArray<LiveStreamMessage>
): LiveStreamMessage[] {
  return normalizeLiveStreamMessageEntries(previous, incoming).map((entry) => entry.message)
}

interface LiveStreamMessageNormalizationIdentity {
  id: string
  type: string | undefined
  providerSourceId: string | undefined
  providerOccurrence: number | undefined
  toolCallId: string | undefined
  toolCallsIdentity: string
}

function getLiveStreamMessageNormalizationIdentity(
  message: LiveStreamMessage
): LiveStreamMessageNormalizationIdentity | null {
  if (!hasLiveStreamMessageId(message)) return null
  return {
    id: message.id,
    type: message.type,
    providerSourceId: getMessageProviderSourceId(message),
    providerOccurrence: getMessageProviderOccurrence(message),
    toolCallId: message.tool_call_id,
    toolCallsIdentity: (message.tool_calls ?? [])
      .map((toolCall, index) => `${toolCall.id ?? index}\u0000${toolCall.name ?? ""}`)
      .join("\u0001")
  }
}

function areLiveStreamMessageNormalizationIdentitiesEqual(
  left: LiveStreamMessageNormalizationIdentity,
  right: LiveStreamMessageNormalizationIdentity
): boolean {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.providerSourceId === right.providerSourceId &&
    left.providerOccurrence === right.providerOccurrence &&
    left.toolCallId === right.toolCallId &&
    left.toolCallsIdentity === right.toolCallsIdentity
  )
}

function mergeLiveStreamMessageFields(
  existing: LiveStreamMessage | undefined,
  incoming: LiveStreamMessage
): LiveStreamMessage {
  const existingContentPriority = existing?.content_priority ?? 0
  const incomingContentPriority = incoming.content_priority ?? 0
  const hasToolCallsField = Object.prototype.hasOwnProperty.call(incoming, "tool_calls")
  const hasAuthoritativeIncomingContent =
    incomingContentPriority > 0 && incomingContentPriority >= existingContentPriority
  const shouldUseIncomingContent =
    hasAuthoritativeIncomingContent ||
    (hasUsefulStreamContent(incoming.content) &&
      incomingContentPriority >= existingContentPriority)
  return {
    ...existing,
    ...incoming,
    content: shouldUseIncomingContent
      ? incoming.content
      : (existing?.content ?? incoming.content),
    reasoning: incoming.reasoning ?? existing?.reasoning,
    content_priority: shouldUseIncomingContent
      ? Math.max(existingContentPriority, incomingContentPriority)
      : existingContentPriority,
    tool_calls: hasToolCallsField ? incoming.tool_calls : existing?.tool_calls,
    tool_call_id: incoming.tool_call_id ?? existing?.tool_call_id,
    name: incoming.name ?? existing?.name
  }
}

export type LiveStreamMessageMerger = (
  previous: LiveStreamMessage[],
  incoming: LiveStreamMessage[]
) => LiveStreamMessage[]

/**
 * Merges messages that have already passed through the stateful id normalizer.
 * Stable cumulative SDK snapshots retain their prefix object references, so the
 * common content-only frame only validates and replaces the changed suffix. Any
 * identity, order, or append boundary falls back to the canonical reconciler.
 */
export function createLiveStreamMessageMerger(): LiveStreamMessageMerger {
  let trustedOutput: LiveStreamMessage[] | undefined
  let outputIdentities: LiveStreamMessageNormalizationIdentity[] = []
  let outputIndexById = new Map<string, number>()
  let sourceMessages: Array<LiveStreamMessage | undefined> = []

  const reconcile = (
    previous: LiveStreamMessage[],
    incoming: LiveStreamMessage[]
  ): LiveStreamMessage[] => {
    const output = mergeLiveStreamMessages(previous, incoming)
    const nextIdentities: LiveStreamMessageNormalizationIdentity[] = []
    const nextIndexById = new Map<string, number>()
    const incomingById = new Map<string, LiveStreamMessage>()
    for (const message of incoming) {
      if (hasLiveStreamMessageId(message)) incomingById.set(message.id, message)
    }
    for (let index = 0; index < output.length; index += 1) {
      const message = output[index]
      const identity = getLiveStreamMessageNormalizationIdentity(message)
      if (!identity) {
        trustedOutput = undefined
        outputIdentities = []
        outputIndexById = new Map()
        sourceMessages = []
        return output
      }
      nextIdentities.push(identity)
      nextIndexById.set(identity.id, index)
    }
    trustedOutput = output
    outputIdentities = nextIdentities
    outputIndexById = nextIndexById
    sourceMessages = output.map((_, index) => incomingById.get(nextIdentities[index].id))
    return output
  }

  return (previous, incoming) => {
    if (
      previous !== trustedOutput ||
      previous.length !== outputIdentities.length ||
      previous.length !== sourceMessages.length
    ) {
      return reconcile(previous, incoming)
    }
    if (incoming.length === 0) return previous

    const isCompleteSnapshot = incoming.length === previous.length
    const updates: Array<{ index: number; message: LiveStreamMessage }> = []
    for (let incomingIndex = 0; incomingIndex < incoming.length; incomingIndex += 1) {
      const message = incoming[incomingIndex]
      if (isCompleteSnapshot && message === sourceMessages[incomingIndex]) continue

      const identity = getLiveStreamMessageNormalizationIdentity(message)
      if (!identity) return reconcile(previous, incoming)
      const outputIndex = outputIndexById.get(identity.id)
      if (
        outputIndex === undefined ||
        (isCompleteSnapshot && outputIndex !== incomingIndex) ||
        !areLiveStreamMessageNormalizationIdentitiesEqual(
          identity,
          outputIdentities[outputIndex]
        )
      ) {
        return reconcile(previous, incoming)
      }
      if (message !== sourceMessages[outputIndex]) {
        updates.push({ index: outputIndex, message })
      }
    }
    if (updates.length === 0) return previous

    const next = previous.slice()
    for (const update of updates) {
      next[update.index] = mergeLiveStreamMessageFields(next[update.index], update.message)
      sourceMessages[update.index] = update.message
    }
    trustedOutput = next
    return next
  }
}

type LiveStreamMessageNormalizationBaseline =
  | ReadonlyArray<LiveStreamMessage>
  | (() => ReadonlyArray<LiveStreamMessage>)

export type LiveStreamMessageIdNormalizer = (
  previous: LiveStreamMessageNormalizationBaseline,
  incoming: ReadonlyArray<LiveStreamMessage>,
  baselineKey?: unknown
) => LiveStreamMessage[]

function canReuseLiveStreamMessageNormalization(
  baseline: ReadonlyArray<LiveStreamMessage>,
  incoming: ReadonlyArray<LiveStreamMessage>,
  incomingIdentities: ReadonlyArray<LiveStreamMessageNormalizationIdentity | null>
): boolean {
  if (incomingIdentities.some((identity) => identity === null)) return false

  const baselineCounts = new Map<string, number>()
  for (const message of baseline) {
    if (!hasLiveStreamMessageId(message)) continue
    const key = `${getMessageProviderSourceId(message)}\u0000${liveStreamMessageRole(message.type)}`
    baselineCounts.set(key, (baselineCounts.get(key) ?? 0) + 1)
  }
  const incomingCounts = new Map<string, number>()
  for (const message of incoming) {
    if (!hasLiveStreamMessageId(message)) continue
    const key = `${getMessageProviderSourceId(message)}\u0000${liveStreamMessageRole(message.type)}`
    incomingCounts.set(key, (incomingCounts.get(key) ?? 0) + 1)
  }

  return incoming.every((message) => {
    if (!hasLiveStreamMessageId(message)) return false
    if (getMessageProviderOccurrence(message) !== undefined) return true
    const key = `${getMessageProviderSourceId(message)}\u0000${liveStreamMessageRole(message.type)}`
    const baselineCount = baselineCounts.get(key) ?? 0
    const incomingCount = incomingCounts.get(key) ?? 0
    // An occurrence-less tool result becomes a replay candidate as soon as its
    // first frame enters the accumulator, and content compatibility can then
    // change the selected slot. Keep it on the complete reconciler.
    if (liveStreamMessageRole(message.type) === "tool") return false
    return baselineCount <= 1 && incomingCount <= 1
  })
}

function applyMappedLiveStreamMessageIdentity(
  mapped: LiveStreamMessage & { id: string },
  incoming: LiveStreamMessage & { id: string }
): LiveStreamMessage & { id: string } {
  const providerSourceId = mapped.provider_source_id?.trim()
  const providerOccurrence = getMessageProviderOccurrence(mapped)
  if (
    mapped.id === incoming.id &&
    (!providerSourceId || providerSourceId === incoming.provider_source_id?.trim()) &&
    (providerOccurrence === undefined ||
      providerOccurrence === getMessageProviderOccurrence(incoming))
  ) {
    return incoming
  }
  return {
    ...incoming,
    id: mapped.id,
    ...(providerSourceId ? { provider_source_id: providerSourceId } : {}),
    ...(providerOccurrence !== undefined ? { provider_occurrence: providerOccurrence } : {})
  }
}

/**
 * Keeps the expensive baseline-to-render-id mapping stable while a provider
 * streams content updates for the same logical message set. Identity/order
 * changes still fall back to the complete collision normalizer.
 */
export function createLiveStreamMessageIdNormalizer(): LiveStreamMessageIdNormalizer {
  const unsetBaselineKey = Symbol("unset-live-stream-baseline")
  let previousBaselineKey: unknown = unsetBaselineKey
  let previousIncomingIdentities: LiveStreamMessageNormalizationIdentity[] = []
  let previousNormalized: LiveStreamMessage[] = []
  let previousMappingReusable = false

  return (previous, incoming, baselineKey = previous) => {
    const incomingIdentities = incoming.map(getLiveStreamMessageNormalizationIdentity)
    const canReuseMapping =
      previousMappingReusable &&
      baselineKey === previousBaselineKey &&
      incomingIdentities.length === previousIncomingIdentities.length &&
      incomingIdentities.length === previousNormalized.length &&
      incomingIdentities.every(
        (identity, index): identity is LiveStreamMessageNormalizationIdentity =>
          identity !== null &&
          areLiveStreamMessageNormalizationIdentitiesEqual(
            identity,
            previousIncomingIdentities[index]
          )
      )

    if (canReuseMapping) {
      const normalized = incoming.map((message, index) =>
        applyMappedLiveStreamMessageIdentity(
          previousNormalized[index] as LiveStreamMessage & { id: string },
          message as LiveStreamMessage & { id: string }
        )
      )
      previousNormalized = normalized
      return normalized
    }

    const resolvedPrevious = typeof previous === "function" ? previous() : previous
    const normalized = normalizeAppendedLiveStreamMessageIds(resolvedPrevious, incoming)
    previousBaselineKey = baselineKey
    previousIncomingIdentities = incomingIdentities.flatMap((identity) =>
      identity ? [identity] : []
    )
    previousNormalized = normalized
    previousMappingReusable = canReuseLiveStreamMessageNormalization(
      resolvedPrevious,
      incoming,
      incomingIdentities
    )
    return normalized
  }
}

export interface LiveStreamCumulativeFrameProjection {
  messages: LiveStreamMessage[]
  changedMessages: LiveStreamMessage[]
  completeReconcile: boolean
}

export type LiveStreamCumulativeFrameProjector = (
  incoming: readonly LiveStreamMessage[],
  normalizeCompleteFrame: () => LiveStreamMessage[],
  baselineKey: unknown
) => LiveStreamCumulativeFrameProjection

/**
 * Converts the SDK's cumulative current-turn array into changed slots. The SDK
 * preserves prefix message references and replaces only the active tail, so a
 * content-only token need not read or normalize the stable tool-loop prefix.
 */
export function createLiveStreamCumulativeFrameProjector(): LiveStreamCumulativeFrameProjector {
  const unsetBaselineKey = Symbol("unset-live-stream-frame-baseline")
  let previousBaselineKey: unknown = unsetBaselineKey
  let sourceMessages: readonly LiveStreamMessage[] = []
  let sourceIdentities: LiveStreamMessageNormalizationIdentity[] = []
  let normalizedMessages: LiveStreamMessage[] = []

  const reconcile = (
    incoming: readonly LiveStreamMessage[],
    normalizeCompleteFrame: () => LiveStreamMessage[],
    baselineKey: unknown
  ): LiveStreamCumulativeFrameProjection => {
    const normalized = normalizeCompleteFrame()
    const identities = incoming.map(getLiveStreamMessageNormalizationIdentity)
    const cacheable =
      normalized.length === incoming.length && identities.every((identity) => identity !== null)
    previousBaselineKey = cacheable ? baselineKey : unsetBaselineKey
    sourceMessages = cacheable ? incoming : []
    sourceIdentities = cacheable
      ? (identities as LiveStreamMessageNormalizationIdentity[])
      : []
    normalizedMessages = cacheable ? normalized : []
    return {
      messages: normalized,
      changedMessages: normalized,
      completeReconcile: true
    }
  }

  return (incoming, normalizeCompleteFrame, baselineKey) => {
    if (
      baselineKey !== previousBaselineKey ||
      incoming.length !== sourceMessages.length ||
      incoming.length !== normalizedMessages.length
    ) {
      return reconcile(incoming, normalizeCompleteFrame, baselineKey)
    }

    let nextNormalized = normalizedMessages
    const changedMessages: LiveStreamMessage[] = []
    for (let index = 0; index < incoming.length; index += 1) {
      const message = incoming[index]
      if (message === sourceMessages[index]) continue
      const identity = getLiveStreamMessageNormalizationIdentity(message)
      if (
        !identity ||
        !areLiveStreamMessageNormalizationIdentitiesEqual(identity, sourceIdentities[index])
      ) {
        return reconcile(incoming, normalizeCompleteFrame, baselineKey)
      }
      const normalized = applyMappedLiveStreamMessageIdentity(
        normalizedMessages[index] as LiveStreamMessage & { id: string },
        message as LiveStreamMessage & { id: string }
      )
      if (nextNormalized === normalizedMessages) nextNormalized = normalizedMessages.slice()
      nextNormalized[index] = normalized
      changedMessages.push(normalized)
    }
    sourceMessages = incoming
    normalizedMessages = nextNormalized
    return {
      messages: normalizedMessages,
      changedMessages,
      completeReconcile: false
    }
  }
}

export interface LiveStreamMessageTimeEntry {
  start_at: Date
  end_at?: Date
}

export interface LiveStreamCommitMergeResult {
  messages: Message[]
  resolvedIncoming: Message[]
}

export interface LiveStreamCommitResolution {
  resolved: Message[]
  unresolved: Message[]
}

export type LiveStreamMessageTimeMap = Record<string, LiveStreamMessageTimeEntry>

export type TimedLiveStreamMessageProjector = (
  messages: readonly LiveStreamMessage[],
  messageTimes: LiveStreamMessageTimeMap
) => LiveStreamMessage[]

/** Reuses timed message objects for unchanged current-turn prefix slots. */
export function createTimedLiveStreamMessageProjector(): TimedLiveStreamMessageProjector {
  let sourceMessages: readonly LiveStreamMessage[] = []
  let sourceIds: Array<string | undefined> = []
  let sourceTimes: Array<LiveStreamMessageTimeEntry | undefined> = []
  let projected: LiveStreamMessage[] = []

  return (messages, messageTimes) => {
    if (messages.length !== sourceMessages.length) {
      sourceMessages = messages
      sourceIds = messages.map((message) => message.id)
      sourceTimes = sourceIds.map((id) => (id ? messageTimes[id] : undefined))
      projected = messages.map((message, index) => ({
        ...message,
        ...(sourceTimes[index]?.start_at ? { start_at: sourceTimes[index]?.start_at } : {}),
        ...(sourceTimes[index]?.end_at ? { end_at: sourceTimes[index]?.end_at } : {})
      }))
      return projected
    }

    let next = projected
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      const previousId = sourceIds[index]
      const id = message === sourceMessages[index] ? previousId : message.id
      const time = id ? messageTimes[id] : undefined
      if (message === sourceMessages[index] && time === sourceTimes[index]) continue
      if (next === projected) next = projected.slice()
      next[index] = {
        ...message,
        ...(time?.start_at ? { start_at: time.start_at } : {}),
        ...(time?.end_at ? { end_at: time.end_at } : {})
      }
      sourceIds[index] = id
      sourceTimes[index] = time
    }
    sourceMessages = messages
    projected = next
    return projected
  }
}

export interface LiveStreamTranscriptIndex {
  messages: readonly Message[]
  messageIds: ReadonlySet<string>
  messageRoleIds: ReadonlySet<string>
  messageIdentities: ReadonlyArray<LiveStreamMessage & { id: string }>
  providerOccurrenceIdentities: ReadonlySet<string>
}

export function messageToLiveStreamIdentity(
  message: Message
): LiveStreamMessage & { id: string } {
  return {
    id: message.id,
    ...(message.provider_source_id ? { provider_source_id: message.provider_source_id } : {}),
    ...(message.provider_occurrence
      ? { provider_occurrence: message.provider_occurrence }
      : {}),
    type:
      message.role === "user"
        ? "human"
        : message.role === "assistant"
          ? "ai"
          : message.role
  }
}

/** Cache stable transcript indexes by immutable message-array reference. */
export function createLiveStreamTranscriptIndexCache(): (
  messages: readonly Message[]
) => LiveStreamTranscriptIndex {
  const cache = new WeakMap<readonly Message[], LiveStreamTranscriptIndex>()
  return (messages) => {
    const cached = cache.get(messages)
    if (cached) return cached

    const messageIds = new Set<string>()
    const messageRoleIds = new Set<string>()
    const messageIdentities: Array<LiveStreamMessage & { id: string }> = []
    const providerOccurrenceIdentities = new Set<string>()
    for (const message of messages) {
      messageIds.add(message.id)
      messageRoleIds.add(`${message.role}\u0000${message.id}`)
      messageIdentities.push(messageToLiveStreamIdentity(message))
      providerOccurrenceIdentities.add(getMessageProviderOccurrenceIdentity(message))
    }
    const index = {
      messages,
      messageIds,
      messageRoleIds,
      messageIdentities,
      providerOccurrenceIdentities
    }
    cache.set(messages, index)
    return index
  }
}

export function normalizeAppendedLiveStreamMessageIds(
  previous: ReadonlyArray<LiveStreamMessage>,
  incoming: ReadonlyArray<LiveStreamMessage>
): LiveStreamMessage[] {
  const baseline = normalizeCompleteMessageIds(
    previous.filter(hasLiveStreamMessageId) as Array<LiveStreamMessage & { id: string }>
  )
  const identifiedIncoming = incoming.filter(hasLiveStreamMessageId)
  const completeIncoming = normalizeCompleteMessageIds(
    normalizeMessageRoleCollisionIds(baseline, identifiedIncoming)
  )
  if (completeIncoming.length === 0) return []

  const identity = (message: LiveStreamMessage & { id: string }): string =>
    `${getMessageProviderSourceId(message)}\u0000${liveStreamMessageRole(message.type)}`
  let scopeStart = baseline.findLastIndex(
    (message) => liveStreamMessageRole(message.type) === "user"
  )
  scopeStart = scopeStart >= 0 ? scopeStart : 0

  const firstIncomingUser = completeIncoming.find(
    (message) => liveStreamMessageRole(message.type) === "user"
  )
  let incomingAlignsExistingUser = false
  if (firstIncomingUser) {
    const userIdentity = identity(firstIncomingUser)
    const incomingUserCount = completeIncoming.filter(
      (message) =>
        liveStreamMessageRole(message.type) === "user" && identity(message) === userIdentity
    ).length
    const matchingIndexes = baseline.flatMap((candidate, index) =>
      identity(candidate) === userIdentity ? [index] : []
    )
    if (matchingIndexes.length > 0) {
      incomingAlignsExistingUser = true
      const suffixOffset = Math.max(0, matchingIndexes.length - incomingUserCount)
      scopeStart = matchingIndexes[suffixOffset]
    }
  }

  const scopedCandidatesByIdentity = new Map<
    string,
    Array<{
      message: LiveStreamMessage & { id: string }
      baselineIndex: number
      occurrence: number
    }>
  >()
  const allCandidatesByIdentity = new Map<
    string,
    Array<{
      message: LiveStreamMessage & { id: string }
      baselineIndex: number
      occurrence: number
    }>
  >()
  const highestOccurrenceByIdentity = new Map<string, number>()
  const baselineCountByIdentity = new Map<string, number>()
  baseline.forEach((message, index) => {
    const key = identity(message)
    const baselineCount = (baselineCountByIdentity.get(key) ?? 0) + 1
    baselineCountByIdentity.set(key, baselineCount)
    const occurrence = getMessageProviderOccurrence(message) ?? baselineCount
    highestOccurrenceByIdentity.set(
      key,
      Math.max(highestOccurrenceByIdentity.get(key) ?? 0, occurrence)
    )
    const allCandidates = allCandidatesByIdentity.get(key) ?? []
    allCandidates.push({ message, baselineIndex: index, occurrence })
    allCandidatesByIdentity.set(key, allCandidates)
    if (index < scopeStart) return
    const candidates = scopedCandidatesByIdentity.get(key) ?? []
    candidates.push({ message, baselineIndex: index, occurrence })
    scopedCandidatesByIdentity.set(key, candidates)
  })

  const candidateCursorByIdentity = new Map<string, number>()
  const appendedCountByIdentity = new Map<string, number>()
  const occupiedIds = new Set(baseline.map((message) => message.id))
  const incomingAssistantEntries = completeIncoming.flatMap((incomingMessage, index) =>
    liveStreamMessageRole(incomingMessage.type) === "assistant"
      ? [{ message: incomingMessage, index }]
      : []
  )
  return completeIncoming.map((message, incomingIndex) => {
    const key = identity(message)
    const candidates = scopedCandidatesByIdentity.get(key) ?? []
    const allCandidates = allCandidatesByIdentity.get(key) ?? []
    let candidateCursor = candidateCursorByIdentity.get(key) ?? 0
    let candidate: (typeof candidates)[number] | undefined
    const rawIncomingMessage = identifiedIncoming[incomingIndex]
    const declaredProviderOccurrence = rawIncomingMessage
      ? getMessageProviderOccurrence(rawIncomingMessage)
      : undefined
    const canUseCandidate = (currentCandidate: (typeof candidates)[number]): boolean => {
      if (liveStreamMessageRole(message.type) === "tool") {
        if (
          currentCandidate.message.tool_call_id &&
          message.tool_call_id &&
          currentCandidate.message.tool_call_id !== message.tool_call_id
        ) {
          return false
        }
        if (declaredProviderOccurrence === currentCandidate.occurrence) return true
        const laterAssistantRepeatsToolCall = baseline.some(
          (baselineMessage, baselineIndex) =>
            baselineIndex > currentCandidate.baselineIndex &&
            liveStreamMessageRole(baselineMessage.type) === "assistant" &&
            Boolean(
              message.tool_call_id &&
                baselineMessage.tool_calls?.some(
                  (toolCall) => toolCall.id === message.tool_call_id
                )
            )
        )
        if (
          rawIncomingMessage?.id === currentCandidate.message.id &&
          !laterAssistantRepeatsToolCall &&
          areMessageReplayContentsCompatible(currentCandidate.message, message)
        ) {
          return true
        }
        const crossedAssistants = baseline.filter(
          (baselineMessage, baselineIndex) =>
            baselineIndex > currentCandidate.baselineIndex &&
            liveStreamMessageRole(baselineMessage.type) === "assistant"
        )
        const matchedIncomingAssistantIndexes = new Set<number>()
        const incomingCoversCrossedAssistants = crossedAssistants.every(
          (baselineAssistant) => {
            const baselineOccurrence = getMessageProviderOccurrence(baselineAssistant)
            const matchingIndex = incomingAssistantEntries.findIndex(
              (incomingAssistantEntry, incomingAssistantIndex) => {
                if (matchedIncomingAssistantIndexes.has(incomingAssistantIndex)) return false
                if (incomingAssistantEntry.index <= incomingIndex) return false
                if (identity(incomingAssistantEntry.message) !== identity(baselineAssistant)) {
                  return false
                }
                const incomingOccurrence = getMessageProviderOccurrence(
                  incomingAssistantEntry.message
                )
                return (
                  baselineOccurrence === undefined ||
                  incomingOccurrence === undefined ||
                  baselineOccurrence === incomingOccurrence
                )
              }
            )
            if (matchingIndex < 0) return false
            matchedIncomingAssistantIndexes.add(matchingIndex)
            return true
          }
        )
        if (
          crossedAssistants.length > 0 &&
          (!incomingAlignsExistingUser || !incomingCoversCrossedAssistants)
        ) {
          return false
        }
      }
      return true
    }
    if (declaredProviderOccurrence !== undefined) {
      const declaredCandidateIndexes = allCandidates.flatMap((currentCandidate, index) =>
        currentCandidate.occurrence === declaredProviderOccurrence ? [index] : []
      )
      const declaredCandidateIndex =
        declaredCandidateIndexes.length === 1 ? declaredCandidateIndexes[0] : -1
      const scopedDeclaredCandidateIndex = candidates.findIndex(
        (currentCandidate) => currentCandidate.occurrence === declaredProviderOccurrence
      )
      if (declaredCandidateIndex >= 0) {
        if (scopedDeclaredCandidateIndex >= 0) {
          candidateCursor = Math.max(candidateCursor, scopedDeclaredCandidateIndex + 1)
        }
        const declaredCandidate = allCandidates[declaredCandidateIndex]
        if (canUseCandidate(declaredCandidate)) candidate = declaredCandidate
      }
    } else {
      while (candidateCursor < candidates.length) {
        const currentCandidate = candidates[candidateCursor]
        candidateCursor += 1
        if (!canUseCandidate(currentCandidate)) continue
        candidate = currentCandidate
        break
      }
    }
    candidateCursorByIdentity.set(key, candidateCursor)
    if (candidate) {
      const providerSourceId = candidate.message.provider_source_id?.trim()
      const providerOccurrence = getMessageProviderOccurrence(candidate.message)
      return candidate.message.id === message.id && !providerSourceId && !providerOccurrence
        ? message
        : {
            ...message,
            id: candidate.message.id,
            ...(providerSourceId ? { provider_source_id: providerSourceId } : {}),
            ...(providerOccurrence ? { provider_occurrence: providerOccurrence } : {})
          }
    }

    const sourceId = getMessageProviderSourceId(message)
    const role = liveStreamMessageRole(message.type)
    const occurrence =
      declaredProviderOccurrence ??
      (highestOccurrenceByIdentity.get(key) ?? 0) +
        (appendedCountByIdentity.get(key) ?? 0) +
        1
    let renderId = message.id
    if (occurrence > 1 || occupiedIds.has(renderId)) {
      renderId =
        occurrence === 1
          ? buildMessageRoleCollisionId(sourceId, role)
          : buildMessageSameRoleDuplicateId(sourceId, role, occurrence)
      let collisionSuffix = Math.max(2, occurrence)
      while (occupiedIds.has(renderId)) {
        renderId = buildMessageRoleCollisionId(sourceId, role, collisionSuffix)
        collisionSuffix += 1
      }
    }
    appendedCountByIdentity.set(key, (appendedCountByIdentity.get(key) ?? 0) + 1)
    occupiedIds.add(renderId)
    return renderId === message.id && (occurrence === 1 || message.provider_occurrence === occurrence)
      ? message
      : {
          ...message,
          id: renderId,
          ...(renderId !== message.id ? { provider_source_id: sourceId } : {}),
          ...(occurrence > 1 ? { provider_occurrence: occurrence } : {})
        }
  })
}

export function mergeLiveStreamCommitMessagesDetailed(
  previous: readonly Message[],
  incoming: readonly Message[]
): LiveStreamCommitMergeResult {
  const merged = mergeCheckpointAuthorityTranscriptMessages(previous, [])
  if (canAppendDisjointProviderBatch(merged, incoming)) {
    const resolvedIncoming = [...incoming]
    return {
      messages: [...merged, ...resolvedIncoming],
      resolvedIncoming
    }
  }
  const baselineIds = merged.map((message) => message.id)
  const baselineIdSet = new Set(baselineIds)
  const roleNormalizedIncoming = normalizeMessageRoleCollisionIds(previous, incoming)
  const snapshotNormalizedIncoming = normalizeCompleteSnapshotMessageIds(
    previous,
    roleNormalizedIncoming
  )
  const incomingContainsUser = roleNormalizedIncoming.some((message) => message.role === "user")
  const normalizedIncoming = incomingContainsUser && snapshotNormalizedIncoming.some((message) =>
    baselineIdSet.has(message.id)
  )
    ? snapshotNormalizedIncoming
    : normalizeAppendedMessageIds(
        previous,
        normalizeCompleteMessageIds(roleNormalizedIncoming)
      )
  const indexById = new Map(merged.map((message, index) => [message.id, index]))
  const resolvedIncomingIds: string[] = []
  let incomingSegmentStartsNewTurn = false

  for (const rawIncoming of normalizedIncoming) {
    const commitMessage = normalizeMessageRoleCollisionIds(merged, [rawIncoming])[0] ?? rawIncoming
    const existingIndex = indexById.get(commitMessage.id)
    if (commitMessage.role === "user") incomingSegmentStartsNewTurn = existingIndex === undefined
    if (existingIndex === undefined) {
      const insertionIndex = incomingSegmentStartsNewTurn
        ? undefined
        : findProviderOccurrenceInsertionIndex(merged, commitMessage, merged.length)
      if (insertionIndex === undefined) {
        indexById.set(commitMessage.id, merged.length)
        merged.push(commitMessage)
      } else {
        merged.splice(insertionIndex, 0, commitMessage)
        for (const [id, index] of indexById) {
          if (index >= insertionIndex) indexById.set(id, index + 1)
        }
        indexById.set(commitMessage.id, insertionIndex)
      }
      resolvedIncomingIds.push(commitMessage.id)
      continue
    }

    const existing = merged[existingIndex]
    if (existing.role !== commitMessage.role) {
      // The role normalizer should make this unreachable, but never merge two
      // different logical records solely because a provider reused an id.
      continue
    }

    const existingContentPriority = existing.content_priority ?? 0
    const incomingContentPriority = commitMessage.content_priority ?? 0
    const hasToolCallsField = Object.prototype.hasOwnProperty.call(commitMessage, "tool_calls")
    const shouldUseIncomingContent =
      (incomingContentPriority > 0 && incomingContentPriority >= existingContentPriority) ||
      (hasUsefulStreamContent(commitMessage.content) &&
        incomingContentPriority >= existingContentPriority)

    merged[existingIndex] = {
      ...existing,
      ...commitMessage,
      content: shouldUseIncomingContent ? commitMessage.content : existing.content,
      reasoning: commitMessage.reasoning ?? existing.reasoning,
      content_priority: shouldUseIncomingContent
        ? Math.max(existingContentPriority, incomingContentPriority)
        : existing.content_priority,
      tool_calls: hasToolCallsField ? commitMessage.tool_calls : existing.tool_calls,
      tool_call_id: commitMessage.tool_call_id ?? existing.tool_call_id,
      name: commitMessage.name ?? existing.name,
      status: commitMessage.status ?? existing.status,
      is_error: commitMessage.is_error ?? existing.is_error
    }
    resolvedIncomingIds.push(existing.id)
  }

  const messages = orderMessagesByProviderOccurrence(
    orderMessagesByIncomingAnchors(baselineIds, merged, resolvedIncomingIds)
  )
  const resolvedById = new Map(messages.map((message) => [message.id, message]))
  return {
    messages,
    resolvedIncoming: resolvedIncomingIds.flatMap((id) => {
      const message = resolvedById.get(id)
      return message ? [message] : []
    })
  }
}

export function mergeLiveStreamCommitMessages(
  previous: readonly Message[],
  incoming: readonly Message[]
): Message[] {
  return mergeLiveStreamCommitMessagesDetailed(previous, incoming).messages
}

export function resolveCommittedLiveStreamMessages(
  messages: readonly Message[],
  pending: readonly Message[]
): LiveStreamCommitResolution {
  const exactByRoleId = new Map<string, Message>()
  const byProviderOccurrence = new Map<string, Message | null>()
  for (const message of messages) {
    exactByRoleId.set(`${message.role}\u0000${message.id}`, message)
    const identity = getMessageProviderOccurrenceIdentity(message)
    if (!byProviderOccurrence.has(identity)) {
      byProviderOccurrence.set(identity, message)
    } else if (byProviderOccurrence.get(identity) !== message) {
      byProviderOccurrence.set(identity, null)
    }
  }

  const resolved: Message[] = []
  const unresolved: Message[] = []
  for (const pendingMessage of pending) {
    const exact = exactByRoleId.get(`${pendingMessage.role}\u0000${pendingMessage.id}`)
    const providerMatch = byProviderOccurrence.get(
      getMessageProviderOccurrenceIdentity(pendingMessage)
    )
    const committed = exact ?? providerMatch ?? undefined
    if (committed) {
      resolved.push(committed)
      continue
    }

    // Ambiguous provider tuples are exceptional, but keep the established
    // append normalizer as a semantic fallback instead of guessing a row.
    const normalized = normalizeAppendedMessageIds(messages, [pendingMessage])[0]
    const fallback = normalized
      ? exactByRoleId.get(`${normalized.role}\u0000${normalized.id}`)
      : undefined
    if (fallback) resolved.push(fallback)
    else unresolved.push(pendingMessage)
  }
  return { resolved, unresolved }
}

export interface NormalizedLiveStreamMessageEntry {
  sourceId: string
  message: LiveStreamMessage & { id: string }
}

export function normalizeLiveStreamMessageEntries(
  previous: ReadonlyArray<LiveStreamMessage>,
  incoming: ReadonlyArray<LiveStreamMessage>
): NormalizedLiveStreamMessageEntry[] {
  const identifiedPrevious = previous.filter(hasLiveStreamMessageId)
  const identifiedIncoming = incoming.filter(hasLiveStreamMessageId)
  if (canAppendDisjointProviderBatch(identifiedPrevious, identifiedIncoming)) {
    return identifiedIncoming.map((message) => ({
      sourceId: message.id,
      message
    }))
  }
  const normalizedPrevious = normalizeCompleteLiveStreamSnapshot(
    normalizeMessageRoleCollisionIds([], identifiedPrevious)
  )
  const normalizedIncoming = normalizeCompleteSnapshotMessageIds(
    normalizedPrevious,
    normalizeMessageRoleCollisionIds(normalizedPrevious, identifiedIncoming)
  )
  return normalizedIncoming.map((message, index) => ({
    sourceId: identifiedIncoming[index].id,
    message
  }))
}

function normalizeCompleteLiveStreamSnapshot(
  messages: Array<LiveStreamMessage & { id: string }>
): Array<LiveStreamMessage & { id: string }> {
  // A complete values snapshot can contain distinct same-role records that
  // reuse a provider id. The cross-role normalizer intentionally leaves those
  // ids alone, so assign occurrence-scoped ids across the complete snapshot
  // without coalescing repeated stream deltas.
  return normalizeCompleteMessageIds(messages)
}

export function replaceLiveStreamMessageId(
  messages: LiveStreamMessage[],
  fromId: string,
  toId: string,
  providerSourceIdOverride?: string,
  providerOccurrenceOverride?: number
): LiveStreamMessage[] {
  if (!fromId || !toId || fromId === toId) return messages
  const sourceIndex = messages.findIndex((message) => message.id === fromId)
  if (sourceIndex < 0) return messages

  const targetIndex = messages.findIndex((message) => message.id === toId)
  const originalSource = messages[sourceIndex] as LiveStreamMessage & { id: string }
  const providerSourceId = getMessageProviderSourceId(originalSource)
  const providerOccurrence = getMessageProviderOccurrence(originalSource)
  const providerSourceIdOverrideTrimmed = providerSourceIdOverride?.trim()
  const hasProviderOccurrenceOverride =
    typeof providerOccurrenceOverride === "number" &&
    Number.isInteger(providerOccurrenceOverride) &&
    providerOccurrenceOverride >= 1
  const source = {
    ...originalSource,
    id: toId,
    provider_source_id:
      providerSourceIdOverrideTrimmed || originalSource.provider_source_id || providerSourceId,
    ...(hasProviderOccurrenceOverride
      ? { provider_occurrence: providerOccurrenceOverride }
      : providerOccurrence !== undefined
        ? { provider_occurrence: providerOccurrence }
        : {})
  }
  const target = targetIndex >= 0 ? messages[targetIndex] : undefined
  const canonical = target ? mergeLiveStreamMessages([source], [target])[0] : source
  const insertionIndex = targetIndex >= 0 ? Math.min(sourceIndex, targetIndex) : sourceIndex

  return messages.flatMap((message, index) => {
    if (index === insertionIndex) return [canonical]
    if (message.id === fromId || message.id === toId) return []
    return [message]
  })
}

export interface LiveStreamMessageIdAlias {
  fromId: string
  toId: string
  providerSourceId?: string
  providerOccurrence?: number
}

export function applyLiveStreamMessageIdAliases(
  messages: LiveStreamMessage[],
  aliases: Iterable<LiveStreamMessageIdAlias>
): LiveStreamMessage[] {
  let result = messages
  for (const alias of aliases) {
    result = replaceLiveStreamMessageId(
      result,
      alias.fromId,
      alias.toId,
      alias.providerSourceId,
      alias.providerOccurrence
    )
  }
  return result
}

function hasLiveStreamMessageId(message: LiveStreamMessage): message is LiveStreamMessage & {
  id: string
} {
  return typeof message.id === "string" && message.id.length > 0
}

function hasUsefulStreamContent(content: LiveStreamMessage["content"]): boolean {
  if (content === undefined || content === "") return false
  if (Array.isArray(content)) return content.some(isContentBlock)
  return true
}

const CONTENT_BLOCK_TYPES = new Set(["text", "image", "tool_use", "tool_result"])

export function liveStreamMessageRole(type?: LiveStreamMessage["type"]): Message["role"] {
  if (type === "human") return "user"
  if (type === "tool") return "tool"
  if (type === "system") return "system"
  return "assistant"
}

export function normalizeLiveStreamMessageContent(
  content: LiveStreamMessage["content"]
): Message["content"] {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const blocks = content.filter(isContentBlock)
    return blocks.length > 0 ? blocks : ""
  }
  return ""
}

export function stringifyMessageContentForReport(content: Message["content"]): string {
  if (typeof content === "string") return content
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return ""
      if ("type" in block && block.type === "text" && "text" in block) {
        return typeof block.text === "string" ? block.text : ""
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (typeof value !== "object" || value === null) return false
  const block = value as Record<string, unknown>
  return typeof block.type === "string" && CONTENT_BLOCK_TYPES.has(block.type)
}
