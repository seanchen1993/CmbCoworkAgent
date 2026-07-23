import { mergeContent, type MessageContent } from "@langchain/core/messages"

export interface RoleCollisionMessage {
  id: string
  role?: string
  type?: string
  provider_source_id?: string
  provider_occurrence?: number
  content?: unknown
  tool_call_id?: string
}

export const MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY = "cmb_internal_provider_source_id"
export const MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY = "cmb_internal_provider_occurrence"

export interface CompletedMessageContentRouteState {
  matched: boolean
  complete: boolean
  observedContent?: unknown
}

function completedRouteTextContent(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  let text = ""
  for (const block of content) {
    if (typeof block === "string") {
      text += block
      continue
    }
    if (
      !block ||
      typeof block !== "object" ||
      Array.isArray(block) ||
      (block as { type?: unknown }).type !== "text" ||
      typeof (block as { text?: unknown }).text !== "string"
    ) {
      return undefined
    }
    text += (block as { text: string }).text
  }
  return text
}

function sameCompletedRouteValue(first: unknown, second: unknown): boolean {
  try {
    return JSON.stringify(first) === JSON.stringify(second)
  } catch {
    return false
  }
}

function completedRouteMergeFields(value: unknown): { index?: string | number; id?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const rawIndex = (value as { index?: unknown }).index
  const rawId = (value as { id?: unknown }).id
  return {
    ...(typeof rawIndex === "number" || typeof rawIndex === "string"
      ? { index: rawIndex }
      : {}),
    ...(typeof rawId === "string" && rawId ? { id: rawId } : {})
  }
}

function isCompletedRouteMergeKeyed(value: unknown): boolean {
  const fields = completedRouteMergeFields(value)
  return fields.index !== undefined || fields.id !== undefined
}

function matchesCompletedRouteMergeTarget(full: unknown, candidate: unknown): boolean {
  const fullFields = completedRouteMergeFields(full)
  const candidateFields = completedRouteMergeFields(candidate)
  if (candidateFields.index !== undefined && fullFields.index !== undefined) {
    if (candidateFields.index !== fullFields.index) return false
    return !candidateFields.id || !fullFields.id || candidateFields.id === fullFields.id
  }
  return (
    candidateFields.index === undefined &&
    fullFields.index === undefined &&
    candidateFields.id !== undefined &&
    candidateFields.id === fullFields.id
  )
}

function isCompletedRouteValuePrefix(full: unknown, candidate: unknown, key?: string): boolean {
  if (sameCompletedRouteValue(full, candidate)) return true
  if (typeof full === "string" && typeof candidate === "string") {
    return key === "type" ||
      key === "id" ||
      key === "name" ||
      key === "output_version" ||
      key === "model_provider"
      ? full === candidate
      : full.startsWith(candidate)
  }
  if (typeof full === "number" && typeof candidate === "number") {
    return key === "index" || key === "created" || key === "timestamp"
      ? full === candidate
      : candidate <= full
  }
  if (Array.isArray(full) && Array.isArray(candidate)) {
    let unkeyedIndex = 0
    return candidate.every((candidateItem) => {
      if (isCompletedRouteMergeKeyed(candidateItem)) {
        const fullItem = full.find((item) =>
          matchesCompletedRouteMergeTarget(item, candidateItem)
        )
        return fullItem !== undefined && isCompletedRouteValuePrefix(fullItem, candidateItem)
      }
      while (unkeyedIndex < full.length && isCompletedRouteMergeKeyed(full[unkeyedIndex])) {
        unkeyedIndex += 1
      }
      if (unkeyedIndex >= full.length) return false
      const fullItem = full[unkeyedIndex]
      unkeyedIndex += 1
      return isCompletedRouteValuePrefix(fullItem, candidateItem)
    })
  }
  if (
    full &&
    candidate &&
    typeof full === "object" &&
    typeof candidate === "object" &&
    !Array.isArray(full) &&
    !Array.isArray(candidate)
  ) {
    const fullRecord = full as Record<string, unknown>
    return Object.entries(candidate as Record<string, unknown>).every(
      ([candidateKey, candidateValue]) =>
        candidateKey in fullRecord &&
        isCompletedRouteValuePrefix(fullRecord[candidateKey], candidateValue, candidateKey)
    )
  }
  return false
}

function mergeCompletedRouteContent(first: unknown, second: unknown): unknown | undefined {
  if (
    (typeof first !== "string" && !Array.isArray(first)) ||
    (typeof second !== "string" && !Array.isArray(second))
  ) {
    return undefined
  }
  try {
    return mergeContent(first as MessageContent, second as MessageContent)
  } catch {
    return undefined
  }
}

/** Merge two true message-mode deltas using LangChain's block-aware rules. */
export function mergeIncrementalMessageContent(
  existing: string | unknown[],
  incoming: string | unknown[]
): string | unknown[] {
  const merged = mergeCompletedRouteContent(existing, incoming)
  return typeof merged === "string" || Array.isArray(merged) ? merged : incoming
}

function completedRouteValueSize(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

/**
 * Advances a delayed completed-message route across either delta chunks or
 * cumulative snapshots. The caller owns the route lifetime: a mismatch means
 * the next assistant has started, while a complete match consumes the route.
 */
export function advanceCompletedMessageContentRoute(
  fullContent: unknown,
  observedContent: unknown,
  incomingContent: unknown
): CompletedMessageContentRouteState {
  const fullText = completedRouteTextContent(fullContent)
  const incomingText = completedRouteTextContent(incomingContent)
  const observedText = completedRouteTextContent(observedContent)
  if (
    fullText !== undefined &&
    incomingText !== undefined &&
    (observedContent === undefined || observedText !== undefined)
  ) {
    if (!incomingText && fullText) {
      return { matched: false, complete: false }
    }

    const candidates = new Set<string>([incomingText])
    if (observedText !== undefined) {
      candidates.add(`${observedText}${incomingText}`)
      if (incomingText.startsWith(observedText)) candidates.add(incomingText)
      if (observedText.startsWith(incomingText)) candidates.add(observedText)
    }
    const nextObserved = [...candidates]
      .filter((candidate) => fullText.startsWith(candidate))
      .sort((left, right) => right.length - left.length)[0]
    return nextObserved === undefined
      ? { matched: false, complete: false }
      : {
          matched: true,
          complete: nextObserved === fullText,
          observedContent: nextObserved
        }
  }

  if (Array.isArray(fullContent) && Array.isArray(incomingContent)) {
    const candidates: unknown[] = [incomingContent]
    if (typeof observedContent === "string" || Array.isArray(observedContent)) {
      const merged = mergeCompletedRouteContent(observedContent, incomingContent)
      if (merged !== undefined) candidates.push(merged)
      if (isCompletedRouteValuePrefix(observedContent, incomingContent)) {
        candidates.push(observedContent)
      }
    }
    const nextObserved = candidates
      .filter((candidate) => isCompletedRouteValuePrefix(fullContent, candidate))
      .sort((left, right) => completedRouteValueSize(right) - completedRouteValueSize(left))[0]
    return nextObserved === undefined
      ? { matched: false, complete: false }
      : {
          matched: true,
          complete:
            isCompletedRouteValuePrefix(nextObserved, fullContent) &&
            isCompletedRouteValuePrefix(fullContent, nextObserved),
          observedContent: nextObserved
        }
  }

  const matched = sameCompletedRouteValue(fullContent, incomingContent)
  return {
    matched,
    complete: matched,
    ...(matched ? { observedContent: incomingContent } : {})
  }
}

export function getMessageProviderTupleFromMetadata(
  metadata: Record<string, unknown> | undefined
): Pick<RoleCollisionMessage, "provider_source_id" | "provider_occurrence"> | undefined {
  const providerSourceId = metadata?.[MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]
  const providerOccurrence = metadata?.[MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]
  if (
    typeof providerSourceId !== "string" ||
    !providerSourceId.trim() ||
    typeof providerOccurrence !== "number" ||
    !Number.isInteger(providerOccurrence) ||
    providerOccurrence < 1
  ) {
    return undefined
  }
  return {
    provider_source_id: providerSourceId.trim(),
    provider_occurrence: providerOccurrence
  }
}

export interface RoleCollisionReasoningMessage extends RoleCollisionMessage {
  reasoning?: string
}

export const MESSAGE_ID_COLLISION_MARKER = "::cmb-id-collision:"
export const MESSAGE_SAME_ROLE_DUPLICATE_MARKER = "::cmb-same-role-duplicate:"

function normalizedMessageRole(message: RoleCollisionMessage): string {
  if (message.role === "user" || message.type === "human") return "user"
  if (message.role === "assistant" || message.type === "ai") return "assistant"
  if (message.role === "tool" || message.type === "tool") return "tool"
  if (message.role === "system" || message.type === "system") return "system"
  return message.role || message.type || "unknown"
}

function collisionIdentity(sourceId: string, role: string): string {
  return `${sourceId}\u0000${role}`
}

export function buildMessageRoleCollisionId(
  sourceId: string,
  role: string,
  suffix?: number
): string {
  const base = `${sourceId}${MESSAGE_ID_COLLISION_MARKER}${encodeURIComponent(role)}`
  return suffix && suffix > 1 ? `${base}:${suffix}` : base
}

export function buildMessageSameRoleDuplicateId(
  sourceId: string,
  role: string,
  occurrence: number = 2
): string {
  const normalizedOccurrence = Math.max(2, Math.trunc(occurrence) || 2)
  return `${sourceId}${MESSAGE_SAME_ROLE_DUPLICATE_MARKER}${encodeURIComponent(role)}:${normalizedOccurrence}`
}

function parseMessageRoleCollisionId(messageId: string): { sourceId: string; role: string } | null {
  const markerIndex = messageId.lastIndexOf(MESSAGE_ID_COLLISION_MARKER)
  if (markerIndex <= 0) return null

  const sourceId = messageId.slice(0, markerIndex)
  const encodedRoleWithSuffix = messageId.slice(markerIndex + MESSAGE_ID_COLLISION_MARKER.length)
  const encodedRole = encodedRoleWithSuffix.replace(/:\d+$/, "")
  if (!encodedRole) return null

  try {
    return { sourceId, role: decodeURIComponent(encodedRole) }
  } catch {
    return null
  }
}

function parseMessageSameRoleDuplicateId(
  messageId: string
): { sourceId: string; role: string; occurrence: number } | null {
  const markerIndex = messageId.lastIndexOf(MESSAGE_SAME_ROLE_DUPLICATE_MARKER)
  if (markerIndex <= 0) return null

  const sourceId = messageId.slice(0, markerIndex)
  const encodedRoleWithOccurrence = messageId.slice(
    markerIndex + MESSAGE_SAME_ROLE_DUPLICATE_MARKER.length
  )
  const match = /^(.*):(\d+)$/.exec(encodedRoleWithOccurrence)
  if (!match) return null

  const occurrence = Number(match[2])
  if (!Number.isInteger(occurrence) || occurrence < 2) return null
  try {
    return { sourceId, role: decodeURIComponent(match[1]), occurrence }
  } catch {
    return null
  }
}

export function getMessageRoleCollisionSourceId(message: RoleCollisionMessage): string {
  const role = normalizedMessageRole(message)
  const messageId = message.id.trim()
  const parsed = parseMessageRoleCollisionId(messageId)
  return parsed?.role === role ? parsed.sourceId.trim() : messageId
}

export function getMessageRoleCollisionIdentity(message: RoleCollisionMessage): string {
  return collisionIdentity(getMessageRoleCollisionSourceId(message), normalizedMessageRole(message))
}

export function getMessageProviderSourceId(message: RoleCollisionMessage): string {
  const role = normalizedMessageRole(message)
  const messageId = message.id.trim()
  const explicitSourceId = message.provider_source_id?.trim()
  if (explicitSourceId) return explicitSourceId
  const duplicate = parseMessageSameRoleDuplicateId(messageId)
  if (duplicate?.role === role) return duplicate.sourceId.trim()
  return getMessageRoleCollisionSourceId({ ...message, id: messageId })
}

export function getMessageProviderOccurrence(
  message: RoleCollisionMessage
): number | undefined {
  if (
    typeof message.provider_occurrence === "number" &&
    Number.isInteger(message.provider_occurrence) &&
    message.provider_occurrence >= 1
  ) {
    return message.provider_occurrence
  }
  const role = normalizedMessageRole(message)
  const duplicate = parseMessageSameRoleDuplicateId(message.id.trim())
  return duplicate?.role === role ? duplicate.occurrence : undefined
}

function providerRoleIdentity(message: RoleCollisionMessage): string {
  return collisionIdentity(getMessageProviderSourceId(message), normalizedMessageRole(message))
}

export function getMessageProviderOccurrenceIdentity(message: RoleCollisionMessage): string {
  return `${providerRoleIdentity(message)}\u0000${getMessageProviderOccurrence(message) ?? 1}`
}

function isInternalMessageIdForRole(message: RoleCollisionMessage): boolean {
  const role = normalizedMessageRole(message)
  const messageId = message.id.trim()
  return (
    parseMessageRoleCollisionId(messageId)?.role === role ||
    parseMessageSameRoleDuplicateId(messageId)?.role === role
  )
}

function messageHasToolCallId(
  message: RoleCollisionMessage,
  toolCallId: string | undefined
): boolean {
  if (!toolCallId) return false
  const toolCalls = (message as RoleCollisionMessage & { tool_calls?: unknown[] }).tool_calls
  return Boolean(
    toolCalls?.some(
      (toolCall) =>
        typeof toolCall === "object" &&
        toolCall !== null &&
        "id" in toolCall &&
        toolCall.id === toolCallId
    )
  )
}

export function areMessageReplayContentsCompatible(
  existing: RoleCollisionMessage,
  incoming: RoleCollisionMessage
): boolean {
  if (existing.content === undefined || incoming.content === undefined) return true
  if (typeof existing.content === "string" && typeof incoming.content === "string") {
    return (
      existing.content === incoming.content ||
      existing.content.startsWith(incoming.content) ||
      incoming.content.startsWith(existing.content)
    )
  }
  try {
    return JSON.stringify(existing.content) === JSON.stringify(incoming.content)
  } catch {
    return false
  }
}

export function buildAvailableProviderOccurrenceId(
  sourceId: string,
  role: string,
  occurrence: number,
  occupiedIds: ReadonlySet<string>
): string {
  const primaryId =
    occurrence === 1
      ? buildMessageRoleCollisionId(sourceId, role)
      : buildMessageSameRoleDuplicateId(sourceId, role, occurrence)
  if (!occupiedIds.has(primaryId)) return primaryId

  let suffix = Math.max(2, occurrence)
  let collisionId = buildMessageRoleCollisionId(sourceId, role, suffix)
  while (occupiedIds.has(collisionId)) {
    suffix += 1
    collisionId = buildMessageRoleCollisionId(sourceId, role, suffix)
  }
  return collisionId
}

/**
 * Assigns occurrence-scoped ids to repeated same-role provider ids in a full,
 * ordered transcript snapshot. Incremental deltas should use
 * normalizeAppendedMessageIds instead so repeated chunks still update one row.
 */
export function normalizeCompleteMessageIds<T extends RoleCollisionMessage>(
  messages: readonly T[]
): T[] {
  const crossRoleNormalized = normalizeMessageRoleCollisionIds([], messages)
  const occurrenceByIdentity = new Map<string, number>()
  const renderIdByProviderOccurrence = new Map<string, string>()
  const occupiedIds = new Set<string>()

  return crossRoleNormalized.map((message) => {
    const role = normalizedMessageRole(message)
    const sourceId = getMessageProviderSourceId(message)
    const identity = providerRoleIdentity(message)
    const declaredOccurrence = getMessageProviderOccurrence(message)
    const highestOccurrence = occurrenceByIdentity.get(identity) ?? 0
    const occurrence = declaredOccurrence ?? highestOccurrence + 1
    occurrenceByIdentity.set(identity, Math.max(highestOccurrence, occurrence))
    const occurrenceIdentity = `${identity}\u0000${occurrence}`
    const existingRenderId =
      declaredOccurrence !== undefined
        ? renderIdByProviderOccurrence.get(occurrenceIdentity)
        : undefined
    if (existingRenderId) {
      return {
        ...message,
        id: existingRenderId,
        provider_source_id: sourceId,
        provider_occurrence: occurrence
      } as T
    }

    let renderId = message.id
    if (
      occupiedIds.has(renderId) ||
      (occurrence > 1 && !message.provider_source_id?.trim())
    ) {
      renderId = buildAvailableProviderOccurrenceId(sourceId, role, occurrence, occupiedIds)
    }
    occupiedIds.add(renderId)
    renderIdByProviderOccurrence.set(occurrenceIdentity, renderId)
    const shouldPersistOccurrence = declaredOccurrence !== undefined || occurrence > 1
    return (
      renderId === message.id &&
      (!shouldPersistOccurrence || message.provider_occurrence === occurrence)
    )
      ? message
      : ({
          ...message,
          id: renderId,
          ...(renderId !== message.id ? { provider_source_id: sourceId } : {}),
          ...(shouldPersistOccurrence ? { provider_occurrence: occurrence } : {})
        } as T)
  })
}

/**
 * Rebases a complete ordered snapshot onto stable baseline render ids. Unlike
 * append normalization, this does not use the latest user turn to infer
 * identity: snapshot position supplies order, while provider occurrence
 * supplies identity.
 */
export function normalizeCompleteSnapshotMessageIds<T extends RoleCollisionMessage>(
  baselineMessages: readonly RoleCollisionMessage[],
  incomingMessages: readonly T[]
): T[] {
  const baseline = normalizeCompleteMessageIds(baselineMessages)
  const snapshot = normalizeCompleteMessageIds(
    normalizeMessageRoleCollisionIds(baseline, incomingMessages)
  )
  const highestBaselineOccurrence = new Map<string, number>()
  const baselineEntryKeys = new Set<string>()
  const baselineEntries = baseline.flatMap((message) => {
    const identity = providerRoleIdentity(message)
    const highestOccurrence = highestBaselineOccurrence.get(identity) ?? 0
    const occurrence = getMessageProviderOccurrence(message) ?? highestOccurrence + 1
    highestBaselineOccurrence.set(identity, Math.max(highestOccurrence, occurrence))
    const entryKey = `${identity}\u0000${occurrence}`
    if (baselineEntryKeys.has(entryKey)) return []
    baselineEntryKeys.add(entryKey)
    return [{ message, identity, occurrence }]
  })
  const transcript = [...baseline]
  const highestIncomingOccurrence = new Map<string, number>()
  const rawIncomingIdCounts = new Map<string, number>()
  incomingMessages.forEach((message) => {
    const messageId = message.id.trim()
    rawIncomingIdCounts.set(messageId, (rawIncomingIdCounts.get(messageId) ?? 0) + 1)
  })

  return snapshot.map((message, messageIndex) => {
    const rawMessage = incomingMessages[messageIndex]
    const identity = providerRoleIdentity(message)
    const highestOccurrence = highestIncomingOccurrence.get(identity) ?? 0
    const inferredOccurrence = getMessageProviderOccurrence(message) ?? highestOccurrence + 1
    const declaredOccurrence = rawMessage ? getMessageProviderOccurrence(rawMessage) : undefined
    let matches =
      declaredOccurrence === undefined
        ? []
        : baselineEntries.filter(
            (candidate) =>
              candidate.identity === identity && candidate.occurrence === declaredOccurrence
          )
    if (declaredOccurrence === undefined && rawMessage) {
      const rawId = rawMessage.id.trim()
      const rawSourceId = rawMessage.provider_source_id?.trim()
      const exactIds = new Set([rawId, message.id])
      if (rawIncomingIdCounts.get(rawId) === 1) {
        matches = baselineEntries.filter(
          (candidate) =>
            normalizedMessageRole(candidate.message) === normalizedMessageRole(message) &&
            exactIds.has(candidate.message.id) &&
            (!rawSourceId || getMessageProviderSourceId(candidate.message) === rawSourceId)
        )
      }
    }
    if (matches.length !== 1) {
      matches = baselineEntries.filter(
        (candidate) =>
          candidate.identity === identity && candidate.occurrence === inferredOccurrence
      )
    }
    if (matches.length === 1) {
      const baselineMessage = matches[0].message
      const occurrence = matches[0].occurrence
      highestIncomingOccurrence.set(identity, Math.max(highestOccurrence, occurrence))
      const sourceId = getMessageProviderSourceId(message)
      const rebased = {
        ...message,
        id: baselineMessage.id,
        provider_source_id:
          baselineMessage.provider_source_id?.trim() ??
          message.provider_source_id?.trim() ??
          sourceId,
        provider_occurrence: occurrence
      } as T
      transcript.push(rebased)
      return rebased
    }

    highestIncomingOccurrence.set(
      identity,
      Math.max(highestOccurrence, inferredOccurrence)
    )
    const normalized = normalizeCompleteMessageIds([
      ...transcript,
      {
        ...message,
        ...(getMessageProviderOccurrence(message) !== undefined || inferredOccurrence > 1
          ? { provider_occurrence: inferredOccurrence }
          : {})
      }
    ]).at(-1) as T
    transcript.push(normalized)
    return normalized
  })
}

export function orderMessagesByProviderOccurrence<T extends RoleCollisionMessage>(
  messages: readonly T[]
): T[] {
  const ordered: T[] = []
  let runStart = 0
  while (runStart < messages.length) {
    const identity = providerRoleIdentity(messages[runStart])
    let runEnd = runStart + 1
    while (
      runEnd < messages.length &&
      providerRoleIdentity(messages[runEnd]) === identity
    ) {
      runEnd += 1
    }
    const run = messages.slice(runStart, runEnd)
    run.sort((left, right) => {
      const leftOccurrence = getMessageProviderOccurrence(left)
      const rightOccurrence = getMessageProviderOccurrence(right)
      if (leftOccurrence === undefined || rightOccurrence === undefined) return 0
      return leftOccurrence - rightOccurrence
    })
    ordered.push(...run)
    runStart = runEnd
  }
  return ordered
}

export function orderMessagesByIncomingAnchors<T extends RoleCollisionMessage>(
  baselineIds: readonly string[],
  mergedMessages: readonly T[],
  incomingIds: readonly string[]
): T[] {
  const mergedById = new Map(mergedMessages.map((message) => [message.id, message]))
  const stableBaselineIds = [...new Set(baselineIds)].filter((id) => mergedById.has(id))
  const stableBaselineIdSet = new Set(stableBaselineIds)
  const uniqueIncomingIds = [...new Set(incomingIds)].filter((id) => mergedById.has(id))
  const incomingAnchorIds = uniqueIncomingIds.filter((id) => stableBaselineIdSet.has(id))
  if (incomingAnchorIds.length === 0) return [...mergedMessages]

  const incomingIdSet = new Set(uniqueIncomingIds)
  const incomingCoversBaseline = stableBaselineIds.every((id) => incomingIdSet.has(id))
  const ordered: T[] = []
  const emitted = new Set<string>()
  const emit = (id: string): void => {
    if (emitted.has(id)) return
    const message = mergedById.get(id)
    if (!message) return
    emitted.add(id)
    ordered.push(message)
  }
  if (incomingCoversBaseline) {
    uniqueIncomingIds.forEach(emit)
    mergedMessages.forEach((message) => emit(message.id))
    return ordered
  }

  stableBaselineIds.forEach(emit)
  uniqueIncomingIds.forEach((id, incomingIndex) => {
    if (emitted.has(id)) return
    const nextAnchorId = uniqueIncomingIds
      .slice(incomingIndex + 1)
      .find((candidateId) => stableBaselineIdSet.has(candidateId))
    const message = mergedById.get(id)
    if (!message) return
    if (nextAnchorId) {
      const nextAnchorIndex = ordered.findIndex((candidate) => candidate.id === nextAnchorId)
      if (nextAnchorIndex >= 0) {
        emitted.add(id)
        ordered.splice(nextAnchorIndex, 0, message)
        return
      }
    }
    // Without a later baseline anchor the input may be a sparse append that
    // merely repeats an early user/message. Preserve the omitted baseline tail
    // and append the unanchored suffix instead of guessing a position inside it.
    emit(id)
  })
  mergedMessages.forEach((message) => emit(message.id))
  return ordered
}

/**
 * Normalizes newly appended transcript records against an ordered baseline.
 * A provider id seen in the current user turn is treated as an update; the same
 * role/id reused after a later user boundary receives a new occurrence id.
 */
export function normalizeAppendedMessageIds<T extends RoleCollisionMessage>(
  baselineMessages: readonly RoleCollisionMessage[],
  incomingMessages: readonly T[],
  options: {
    normalizeCrossRole?: boolean
    splitAssistantAfterTool?: boolean
    forceAppend?: boolean
  } = {}
): T[] {
  const transcript = normalizeCompleteMessageIds(baselineMessages)
  const normalized: T[] = []

  for (const rawMessage of incomingMessages) {
    if (options.normalizeCrossRole === false && isInternalMessageIdForRole(rawMessage)) {
      transcript.push(rawMessage)
      normalized.push(rawMessage)
      continue
    }
    const role = normalizedMessageRole(rawMessage)
    const sourceId = getMessageProviderSourceId(rawMessage)
    const identity = providerRoleIdentity(rawMessage)
    let lastUserIndex = -1
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      if (normalizedMessageRole(transcript[index]) === "user") {
        lastUserIndex = index
        break
      }
    }

    const candidateIndexes: number[] = []
    for (let index = 0; index < transcript.length; index += 1) {
      if (providerRoleIdentity(transcript[index]) === identity) candidateIndexes.push(index)
    }
    const candidateProviderOccurrence = (candidateIndex: number): number =>
      getMessageProviderOccurrence(transcript[candidateIndex]) ??
      candidateIndexes.indexOf(candidateIndex) + 1

    const canUpdateCandidate = (candidateIndex: number): boolean => {
      if (role !== "tool") return true
      const candidateToolCallId = transcript[candidateIndex].tool_call_id
      if (
        candidateToolCallId &&
        rawMessage.tool_call_id &&
        candidateToolCallId !== rawMessage.tool_call_id
      ) {
        return false
      }
      const isExactRenderId = transcript[candidateIndex].id === rawMessage.id.trim()
      const declaredOccurrence = getMessageProviderOccurrence(rawMessage)
      const isExplicitOccurrenceMatch =
        declaredOccurrence !== undefined &&
        candidateProviderOccurrence(candidateIndex) === declaredOccurrence
      if (isExplicitOccurrenceMatch) return true
      const hasLaterMatchingToolCall = transcript.some(
        (message, index) =>
          index > candidateIndex &&
          normalizedMessageRole(message) === "assistant" &&
          messageHasToolCallId(message, rawMessage.tool_call_id)
      )
      if (
        isExactRenderId &&
        !hasLaterMatchingToolCall &&
        areMessageReplayContentsCompatible(transcript[candidateIndex], rawMessage)
      ) {
        return true
      }
      return !transcript.some(
        (message, index) =>
          index > candidateIndex && normalizedMessageRole(message) === "assistant"
      )
    }
    const hasCompatibleExplicitProviderIdentity = (candidateIndex: number): boolean => {
      const candidate = transcript[candidateIndex]
      const explicitSourceId = rawMessage.provider_source_id?.trim()
      if (explicitSourceId && getMessageProviderSourceId(candidate) !== explicitSourceId) {
        return false
      }
      const explicitOccurrence = getMessageProviderOccurrence(rawMessage)
      if (
        explicitOccurrence !== undefined &&
        (getMessageProviderOccurrence(candidate) ?? 1) !== explicitOccurrence
      ) {
        return false
      }
      return true
    }

    let targetIndex: number | undefined
    const hasInternalId = isInternalMessageIdForRole(rawMessage)
    const declaredProviderOccurrence = getMessageProviderOccurrence(rawMessage)
    const mustAppendDeclaredOccurrence =
      !options.forceAppend &&
      declaredProviderOccurrence !== undefined &&
      !candidateIndexes.some(
        (index) => candidateProviderOccurrence(index) === declaredProviderOccurrence
      )
    if (
      !options.forceAppend &&
      declaredProviderOccurrence !== undefined &&
      !mustAppendDeclaredOccurrence
    ) {
      const occurrenceIndex = candidateIndexes.find(
        (index) => candidateProviderOccurrence(index) === declaredProviderOccurrence
      )
      if (occurrenceIndex !== undefined && canUpdateCandidate(occurrenceIndex)) {
        targetIndex = occurrenceIndex
      }
    }
    if (
      targetIndex === undefined &&
      !mustAppendDeclaredOccurrence &&
      !options.forceAppend &&
      rawMessage.provider_source_id?.trim()
    ) {
      const exactIndex = transcript.findIndex(
        (message) => message.id === rawMessage.id.trim() && normalizedMessageRole(message) === role
      )
      if (
        exactIndex >= 0 &&
        hasCompatibleExplicitProviderIdentity(exactIndex) &&
        canUpdateCandidate(exactIndex)
      ) {
        targetIndex = exactIndex
      }
    }
    if (
      targetIndex === undefined &&
      !mustAppendDeclaredOccurrence &&
      !options.forceAppend &&
      !rawMessage.provider_source_id?.trim() &&
      declaredProviderOccurrence === undefined
    ) {
      const exactIndex = transcript.findIndex(
        (message) => message.id === rawMessage.id.trim() && normalizedMessageRole(message) === role
      )
      const adoptedProviderSourceId =
        exactIndex >= 0 ? transcript[exactIndex].provider_source_id?.trim() : undefined
      const crossedToolBoundary =
        exactIndex >= 0 &&
        options.splitAssistantAfterTool === true &&
        role === "assistant" &&
        rawMessage.id.includes(MESSAGE_ID_COLLISION_MARKER) &&
        transcript.some(
          (message, index) => index > exactIndex && normalizedMessageRole(message) === "tool"
        )
      if (
        exactIndex >= 0 &&
        adoptedProviderSourceId &&
        adoptedProviderSourceId !== rawMessage.id.trim() &&
        !crossedToolBoundary &&
        canUpdateCandidate(exactIndex)
      ) {
        targetIndex = exactIndex
      }
    }
    if (
      targetIndex === undefined &&
      !mustAppendDeclaredOccurrence &&
      !options.forceAppend &&
      hasInternalId
    ) {
      const exactIndex = transcript.findIndex(
        (message) => message.id === rawMessage.id.trim() && normalizedMessageRole(message) === role
      )
      const crossedToolBoundary =
        exactIndex >= 0 &&
        options.splitAssistantAfterTool === true &&
        role === "assistant" &&
        rawMessage.id.includes(MESSAGE_ID_COLLISION_MARKER) &&
        transcript.some(
          (message, index) => index > exactIndex && normalizedMessageRole(message) === "tool"
        )
      if (
        exactIndex >= 0 &&
        !crossedToolBoundary &&
        hasCompatibleExplicitProviderIdentity(exactIndex) &&
        canUpdateCandidate(exactIndex)
      ) {
        targetIndex = exactIndex
      }
    }
    if (
      targetIndex === undefined &&
      !mustAppendDeclaredOccurrence &&
      !options.forceAppend &&
      !hasInternalId
    ) {
      if (role === "user") {
        const latestCandidate = candidateIndexes.at(-1)
        if (latestCandidate === transcript.length - 1) targetIndex = latestCandidate
      } else {
        const latestCandidate = candidateIndexes.findLast((index) => index > lastUserIndex)
        const crossedToolBoundary =
          options.splitAssistantAfterTool === true &&
          role === "assistant" &&
          latestCandidate !== undefined &&
          transcript.some(
            (message, index) =>
              index > latestCandidate && normalizedMessageRole(message) === "tool"
          )
        if (
          !crossedToolBoundary &&
          latestCandidate !== undefined &&
          canUpdateCandidate(latestCandidate)
        ) {
          targetIndex = latestCandidate
        }
      }
    }

    let message: T
    if (targetIndex !== undefined) {
      const renderId = transcript[targetIndex].id
      const providerSourceId = transcript[targetIndex].provider_source_id?.trim()
      const providerOccurrence = getMessageProviderOccurrence(transcript[targetIndex])
      message =
        renderId === rawMessage.id && !providerSourceId && !providerOccurrence
          ? rawMessage
          : ({
              ...rawMessage,
              id: renderId,
              ...(providerSourceId ? { provider_source_id: providerSourceId } : {}),
              ...(providerOccurrence ? { provider_occurrence: providerOccurrence } : {})
            } as T)
      transcript[targetIndex] = { ...transcript[targetIndex], ...message, id: renderId }
    } else {
      const crossRoleMessage =
        options.normalizeCrossRole === false
          ? rawMessage
          : (normalizeMessageRoleCollisionIds(transcript, [rawMessage])[0] ?? rawMessage)
      let renderId = crossRoleMessage.id
      let providerOccurrence = getMessageProviderOccurrence(crossRoleMessage)
      const occupiedIds = new Set(transcript.map((candidate) => candidate.id))
      if (candidateIndexes.length > 0) {
        const highestExistingOccurrence = candidateIndexes.reduce(
          (highest, index, candidateOffset) => {
            const parsed = parseMessageSameRoleDuplicateId(transcript[index].id)
            const persistedOccurrence = getMessageProviderOccurrence(transcript[index])
            return Math.max(
              highest,
              persistedOccurrence ?? parsed?.occurrence ?? candidateOffset + 1
            )
          },
          1
        )
        const declaredOccurrence = getMessageProviderOccurrence(rawMessage)
        providerOccurrence = declaredOccurrence ?? highestExistingOccurrence + 1
        renderId = buildAvailableProviderOccurrenceId(
          sourceId,
          role,
          providerOccurrence,
          occupiedIds
        )
      } else if (occupiedIds.has(renderId)) {
        providerOccurrence ??= 1
        renderId = buildAvailableProviderOccurrenceId(
          sourceId,
          role,
          providerOccurrence,
          occupiedIds
        )
      }
      message =
        renderId === crossRoleMessage.id && !providerOccurrence
          ? crossRoleMessage
          : ({
              ...crossRoleMessage,
              id: renderId,
              ...(renderId !== crossRoleMessage.id ? { provider_source_id: sourceId } : {}),
              ...(providerOccurrence ? { provider_occurrence: providerOccurrence } : {})
            } as T)
      transcript.push(message)
    }
    normalized.push(message)
  }

  return normalized
}

export function preserveAssistantReasoningByRoleCollisionIdentity<
  T extends RoleCollisionReasoningMessage
>(existingMessages: readonly T[], incomingMessages: readonly T[]): T[] {
  const existingReasoningByIdentity = new Map(
    existingMessages
      .filter(
        (message) => normalizedMessageRole(message) === "assistant" && Boolean(message.reasoning)
      )
      .map(
        (message) => [getMessageProviderOccurrenceIdentity(message), message.reasoning!] as const
      )
  )

  return incomingMessages.map((message) => {
    if (normalizedMessageRole(message) !== "assistant" || message.reasoning) return message
    const existingReasoning = existingReasoningByIdentity.get(
      getMessageProviderOccurrenceIdentity(message)
    )
    return existingReasoning ? ({ ...message, reasoning: existingReasoning } as T) : message
  })
}

/**
 * Rewrites only cross-role id collisions. The first role keeps the provider id;
 * later roles receive a stable internal id derived from provider id + role.
 * Repeated snapshots are mapped back to the same internal id.
 */
export function normalizeMessageRoleCollisionIds<T extends RoleCollisionMessage>(
  baselineMessages: readonly RoleCollisionMessage[],
  incomingMessages: readonly T[]
): T[] {
  if (incomingMessages.length === 0) return []

  const roleByRenderId = new Map<string, string>()
  const renderIdBySourceRole = new Map<string, string>()

  const register = (message: RoleCollisionMessage): void => {
    const role = normalizedMessageRole(message)
    const sourceId = getMessageRoleCollisionSourceId(message)
    const identity = collisionIdentity(sourceId, role)
    if (renderIdBySourceRole.has(identity)) return

    const messageId = message.id.trim()
    const occupiedRole = roleByRenderId.get(messageId)
    if (occupiedRole === undefined || occupiedRole === role) {
      roleByRenderId.set(messageId, role)
      renderIdBySourceRole.set(identity, messageId)
      return
    }

    let suffix: number | undefined
    let collisionId = buildMessageRoleCollisionId(sourceId, role)
    while (roleByRenderId.has(collisionId) && roleByRenderId.get(collisionId) !== role) {
      suffix = (suffix ?? 1) + 1
      collisionId = buildMessageRoleCollisionId(sourceId, role, suffix)
    }
    roleByRenderId.set(collisionId, role)
    renderIdBySourceRole.set(identity, collisionId)
  }

  baselineMessages.forEach(register)

  return incomingMessages.map((message) => {
    const role = normalizedMessageRole(message)
    const messageId = message.id.trim()
    if (
      isInternalMessageIdForRole(message) &&
      getMessageProviderOccurrence(message) !== undefined &&
      (roleByRenderId.get(messageId) === undefined || roleByRenderId.get(messageId) === role)
    ) {
      roleByRenderId.set(messageId, role)
      return messageId === message.id ? message : ({ ...message, id: messageId } as T)
    }
    const sourceId = getMessageRoleCollisionSourceId(message)
    const identity = collisionIdentity(sourceId, role)
    let renderId = renderIdBySourceRole.get(identity)

    if (!renderId) {
      const occupiedRole = roleByRenderId.get(messageId)
      if (occupiedRole === undefined || occupiedRole === role) {
        renderId = messageId
      } else {
        let suffix: number | undefined
        renderId = buildMessageRoleCollisionId(sourceId, role)
        while (roleByRenderId.has(renderId) && roleByRenderId.get(renderId) !== role) {
          suffix = (suffix ?? 1) + 1
          renderId = buildMessageRoleCollisionId(sourceId, role, suffix)
        }
      }
      roleByRenderId.set(renderId, role)
      renderIdBySourceRole.set(identity, renderId)
    }

    return renderId === message.id ? message : ({ ...message, id: renderId } as T)
  })
}
