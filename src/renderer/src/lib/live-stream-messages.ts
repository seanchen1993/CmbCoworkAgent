import type { ContentBlock, Message } from "@/types"
import { mergeCheckpointAuthorityTranscriptMessages } from "../../../shared/checkpoint-transcript"
import {
  areMessageReplayContentsCompatible,
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId,
  getMessageProviderOccurrence,
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
    const existingContentPriority = existing?.content_priority ?? 0
    const incomingContentPriority = message.content_priority ?? 0
    const hasToolCallsField = Object.prototype.hasOwnProperty.call(message, "tool_calls")
    const hasAuthoritativeIncomingContent =
      incomingContentPriority > 0 && incomingContentPriority >= existingContentPriority
    const shouldUseIncomingContent =
      hasAuthoritativeIncomingContent ||
      (hasUsefulStreamContent(message.content) &&
        incomingContentPriority >= existingContentPriority)
    merged.set(message.id, {
      ...existing,
      ...message,
      content: shouldUseIncomingContent ? message.content : (existing?.content ?? message.content),
      reasoning: message.reasoning ?? existing?.reasoning,
      content_priority: shouldUseIncomingContent
        ? Math.max(existingContentPriority, incomingContentPriority)
        : existingContentPriority,
      tool_calls: hasToolCallsField ? message.tool_calls : existing?.tool_calls,
      tool_call_id: message.tool_call_id ?? existing?.tool_call_id,
      name: message.name ?? existing?.name
    })
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

export function mergeLiveStreamCommitMessages(
  previous: readonly Message[],
  incoming: readonly Message[]
): Message[] {
  const merged = mergeCheckpointAuthorityTranscriptMessages(previous, [])
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

  return orderMessagesByProviderOccurrence(
    orderMessagesByIncomingAnchors(baselineIds, merged, resolvedIncomingIds)
  )
}

export interface NormalizedLiveStreamMessageEntry {
  sourceId: string
  message: LiveStreamMessage & { id: string }
}

export function normalizeLiveStreamMessageEntries(
  previous: ReadonlyArray<LiveStreamMessage>,
  incoming: ReadonlyArray<LiveStreamMessage>
): NormalizedLiveStreamMessageEntry[] {
  const normalizedPrevious = normalizeCompleteLiveStreamSnapshot(
    normalizeMessageRoleCollisionIds(
      [],
      previous.filter(hasLiveStreamMessageId) as Array<LiveStreamMessage & { id: string }>
    )
  )
  const identifiedIncoming = incoming.filter(hasLiveStreamMessageId)
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
