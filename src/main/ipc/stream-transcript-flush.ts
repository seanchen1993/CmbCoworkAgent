import type { Message } from "../types"
import {
  getMessageProviderOccurrence,
  getMessageProviderSourceId,
  mergeIncrementalMessageContent,
  normalizeAppendedMessageIds,
  normalizeMessageRoleCollisionIds
} from "../../shared/message-role-collision"
import {
  mergeStreamToolCallChunks,
  type StreamToolCallChunk
} from "../../shared/stream-tool-call-chunks"

export interface QueuedStreamTranscriptMessage extends Message {
  streamContentMode: "delta" | "snapshot"
  streamToolCallChunks: StreamToolCallChunk[]
}

/**
 * Identity of the one assistant message that is currently receiving ordinary
 * text chunks. It is scoped to a physical run by the caller. A boundary drops
 * the identity instead of guessing whether a reused provider id is still the
 * same logical message.
 */
export interface StreamTranscriptAssistantIdentity {
  rawId: string
  stableId: string
  providerSourceId: string
  providerOccurrence: number
  observedTextPrefix?: string
}

export interface ResolvedStreamTranscriptFlush {
  messages: Message[]
  preserveExistingOrder: boolean
  /**
   * The batch is a trusted content-only delta for the cached assistant row.
   * Callers may append it through the fragment path instead of rewriting the
   * accumulated message body.
   */
  appendTextDelta?: boolean
  nextAssistantIdentity?: StreamTranscriptAssistantIdentity
}

function hasUsefulQueuedContent(content: Message["content"]): boolean {
  return typeof content === "string" ? content.length > 0 : content.length > 0
}

function mergeQueuedStreamContent(
  existing: Message["content"],
  incoming: Message["content"],
  incomingMode: QueuedStreamTranscriptMessage["streamContentMode"]
): Message["content"] {
  if (!hasUsefulQueuedContent(incoming)) return existing
  if (!hasUsefulQueuedContent(existing)) return incoming
  if (incomingMode === "snapshot") return incoming
  return mergeIncrementalMessageContent(existing, incoming) as Message["content"]
}

function mergeQueuedStreamMessage(
  base: QueuedStreamTranscriptMessage,
  incoming: QueuedStreamTranscriptMessage
): QueuedStreamTranscriptMessage {
  const streamToolCallChunks = [...base.streamToolCallChunks, ...incoming.streamToolCallChunks]
  const toolCalls = mergeStreamToolCallChunks(
    [...(base.tool_calls ?? []), ...(incoming.tool_calls ?? [])],
    streamToolCallChunks
  )
  return {
    ...base,
    ...incoming,
    content: mergeQueuedStreamContent(base.content, incoming.content, incoming.streamContentMode),
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    streamToolCallChunks,
    tool_call_id: incoming.tool_call_id ?? base.tool_call_id,
    name: incoming.name ?? base.name,
    status: incoming.status ?? base.status,
    is_error: incoming.is_error ?? base.is_error,
    created_at: base.created_at ?? incoming.created_at,
    start_at: base.start_at ?? incoming.start_at,
    end_at: incoming.end_at ?? base.end_at
  }
}

function normalizeQueuedStreamMessages(
  baselineMessages: readonly Message[],
  messages: readonly QueuedStreamTranscriptMessage[]
): QueuedStreamTranscriptMessage[] {
  return normalizeAppendedMessageIds(
    baselineMessages,
    normalizeMessageRoleCollisionIds(baselineMessages, messages),
    { splitAssistantAfterTool: true }
  )
}

function coalesceNormalizedStreamMessages(
  normalizedMessages: readonly QueuedStreamTranscriptMessage[]
): Message[] {
  const byId = new Map<string, QueuedStreamTranscriptMessage>()
  for (const message of normalizedMessages) {
    const existing = byId.get(message.id)
    byId.set(message.id, existing ? mergeQueuedStreamMessage(existing, message) : message)
  }
  return [...byId.values()].map((queuedMessage) => {
    const message = { ...queuedMessage } as Partial<QueuedStreamTranscriptMessage>
    delete message.streamContentMode
    delete message.streamToolCallChunks
    return message as Message
  })
}

export function coalesceQueuedStreamMessages(
  baselineMessages: readonly Message[],
  messages: readonly QueuedStreamTranscriptMessage[]
): Message[] {
  return coalesceNormalizedStreamMessages(normalizeQueuedStreamMessages(baselineMessages, messages))
}

export function canUseIncrementalStreamTranscriptUpsert(messages: readonly Message[]): boolean {
  return messages.every((message) => {
    if (message.role === "user" || message.role === "system") return true
    const providerSourceId = message.provider_source_id?.trim()
    const providerOccurrence = getMessageProviderOccurrence(message)
    const hasExplicitProviderTuple = Boolean(providerSourceId) && providerOccurrence !== undefined
    if (message.role === "assistant") return hasExplicitProviderTuple
    return hasExplicitProviderTuple || Boolean(message.tool_call_id)
  })
}

function contentContainsToolBoundary(content: Message["content"]): boolean {
  return (
    Array.isArray(content) &&
    content.some((block) => block.type === "tool_use" || block.type === "tool_result")
  )
}

function isOrdinaryAssistantChunk(message: QueuedStreamTranscriptMessage): boolean {
  return (
    message.role === "assistant" &&
    !message.tool_call_id &&
    (!message.tool_calls || message.tool_calls.length === 0) &&
    message.streamToolCallChunks.length === 0 &&
    !contentContainsToolBoundary(message.content)
  )
}

function isContentOnlyAssistantTextDelta(message: QueuedStreamTranscriptMessage): boolean {
  return (
    isOrdinaryAssistantChunk(message) &&
    message.streamContentMode === "delta" &&
    typeof message.content === "string" &&
    message.content.length > 0 &&
    message.reasoning === undefined &&
    message.content_priority === undefined &&
    message.name === undefined &&
    message.status === undefined &&
    message.is_error === undefined &&
    message.goal_id === undefined &&
    message.active_window_id === undefined &&
    message.start_at === undefined &&
    message.end_at === undefined
  )
}

function stableAssistantProviderTuple(
  message: QueuedStreamTranscriptMessage
): QueuedStreamTranscriptMessage {
  if (message.role !== "assistant") return message
  const providerSourceId = getMessageProviderSourceId(message)
  const providerOccurrence = getMessageProviderOccurrence(message) ?? 1
  if (
    message.provider_source_id === providerSourceId &&
    message.provider_occurrence === providerOccurrence
  ) {
    return message
  }
  return {
    ...message,
    provider_source_id: providerSourceId,
    provider_occurrence: providerOccurrence
  }
}

function messageMatchesCachedAssistantIdentity(
  message: QueuedStreamTranscriptMessage,
  identity: StreamTranscriptAssistantIdentity
): boolean {
  if (!isOrdinaryAssistantChunk(message)) return false
  const providerSourceId = getMessageProviderSourceId(message)
  if (providerSourceId !== identity.providerSourceId) return false
  const explicitProviderOccurrence = getMessageProviderOccurrence(message)
  if (
    explicitProviderOccurrence !== undefined &&
    explicitProviderOccurrence !== identity.providerOccurrence
  ) {
    return false
  }
  const messageId = message.id.trim()
  return messageId === identity.rawId || messageId === identity.stableId
}

const STREAM_IDENTITY_TEXT_PREFIX_LIMIT = 4_096

function streamIdentityText(content: Message["content"]): string | undefined {
  if (typeof content === "string") return content
  let text = ""
  for (const block of content) {
    if (typeof block.text !== "string") continue
    text += block.text
    if (text.length >= STREAM_IDENTITY_TEXT_PREFIX_LIMIT) break
  }
  return text || undefined
}

function appendIdentityTextPrefix(existing: string | undefined, incoming: string): string {
  if ((existing?.length ?? 0) >= STREAM_IDENTITY_TEXT_PREFIX_LIMIT) return existing!
  return `${existing ?? ""}${incoming}`.slice(0, STREAM_IDENTITY_TEXT_PREFIX_LIMIT)
}

function nextObservedTextPrefix(
  existing: string | undefined,
  incoming: QueuedStreamTranscriptMessage
): { matched: boolean; prefix?: string } {
  const incomingText = streamIdentityText(incoming.content)
  if (incomingText === undefined) return { matched: true, prefix: existing }
  if (incoming.streamContentMode !== "snapshot") {
    return { matched: true, prefix: appendIdentityTextPrefix(existing, incomingText) }
  }
  if (
    existing !== undefined &&
    !incomingText.startsWith(existing) &&
    !existing.startsWith(incomingText)
  ) {
    return { matched: false }
  }
  const longerText = incomingText.length >= (existing?.length ?? 0) ? incomingText : existing!
  return {
    matched: true,
    prefix: longerText.slice(0, STREAM_IDENTITY_TEXT_PREFIX_LIMIT)
  }
}

function applyCachedAssistantIdentity(
  messages: readonly QueuedStreamTranscriptMessage[],
  identity: StreamTranscriptAssistantIdentity
):
  | {
      messages: QueuedStreamTranscriptMessage[]
      nextIdentity: StreamTranscriptAssistantIdentity
    }
  | undefined {
  if (messages.length === 0) return undefined
  let observedTextPrefix = identity.observedTextPrefix
  const identifiedMessages: QueuedStreamTranscriptMessage[] = []
  for (const message of messages) {
    if (!messageMatchesCachedAssistantIdentity(message, identity)) return undefined
    const nextObservation = nextObservedTextPrefix(observedTextPrefix, message)
    if (!nextObservation.matched) return undefined
    observedTextPrefix = nextObservation.prefix
    identifiedMessages.push({
      ...message,
      id: identity.stableId,
      provider_source_id: identity.providerSourceId,
      provider_occurrence: identity.providerOccurrence
    })
  }
  return {
    messages: identifiedMessages,
    nextIdentity: { ...identity, observedTextPrefix }
  }
}

function deriveTrailingAssistantIdentity(
  rawMessages: readonly QueuedStreamTranscriptMessage[],
  normalizedMessages: readonly QueuedStreamTranscriptMessage[]
): StreamTranscriptAssistantIdentity | undefined {
  let suffixStart = rawMessages.length
  while (suffixStart > 0 && isOrdinaryAssistantChunk(rawMessages[suffixStart - 1])) {
    suffixStart -= 1
  }
  if (suffixStart === rawMessages.length) return undefined

  const rawSuffix = rawMessages.slice(suffixStart)
  const normalizedSuffix = normalizedMessages.slice(suffixStart)
  if (rawSuffix.length !== normalizedSuffix.length || normalizedSuffix.length === 0) {
    return undefined
  }

  const lastNormalized = normalizedSuffix.at(-1)
  if (!lastNormalized || lastNormalized.role !== "assistant") return undefined
  const stableId = lastNormalized.id.trim()
  const providerSourceId = lastNormalized.provider_source_id?.trim()
  const providerOccurrence = getMessageProviderOccurrence(lastNormalized)
  if (!stableId || !providerSourceId || providerOccurrence === undefined) return undefined

  const rawId = getMessageProviderSourceId(rawSuffix[0])
  if (!rawId || rawId !== providerSourceId) return undefined
  if (
    rawSuffix.some((message) => getMessageProviderSourceId(message) !== rawId) ||
    normalizedSuffix.some(
      (message) =>
        message.role !== "assistant" ||
        message.id.trim() !== stableId ||
        message.provider_source_id?.trim() !== providerSourceId ||
        getMessageProviderOccurrence(message) !== providerOccurrence
    )
  ) {
    return undefined
  }

  let observedTextPrefix: string | undefined
  for (const message of normalizedSuffix) {
    const nextObservation = nextObservedTextPrefix(observedTextPrefix, message)
    if (!nextObservation.matched) return undefined
    observedTextPrefix = nextObservation.prefix
  }
  return {
    rawId,
    stableId,
    providerSourceId,
    providerOccurrence,
    observedTextPrefix
  }
}

/**
 * Resolve one debounce batch. The durable transcript is loaded only when the
 * batch lacks an explicit provider tuple and cannot reuse the run-scoped
 * identity established by an earlier full normalization.
 */
export function resolveStreamTranscriptFlush({
  queuedMessages,
  currentAssistantIdentity,
  loadBaselineMessages
}: {
  queuedMessages: readonly QueuedStreamTranscriptMessage[]
  currentAssistantIdentity?: StreamTranscriptAssistantIdentity
  loadBaselineMessages: () => readonly Message[]
}): ResolvedStreamTranscriptFlush {
  if (currentAssistantIdentity) {
    const cached = applyCachedAssistantIdentity(queuedMessages, currentAssistantIdentity)
    if (cached) {
      const messages = coalesceQueuedStreamMessages([], cached.messages)
      if (canUseIncrementalStreamTranscriptUpsert(messages)) {
        return {
          messages,
          preserveExistingOrder: true,
          ...(messages.length === 1 && queuedMessages.every(isContentOnlyAssistantTextDelta)
            ? { appendTextDelta: true }
            : {}),
          nextAssistantIdentity: cached.nextIdentity
        }
      }
    }
  }

  const incrementalMessages = coalesceQueuedStreamMessages([], queuedMessages)
  const cachedAssistantWasRejected =
    currentAssistantIdentity !== undefined &&
    queuedMessages.some((message) => message.role === "assistant")
  if (!cachedAssistantWasRejected && canUseIncrementalStreamTranscriptUpsert(incrementalMessages)) {
    return {
      messages: incrementalMessages,
      preserveExistingOrder: true,
      // Explicit provider tuples do not need a durable identity lookup, but
      // still seed the run cache so the next content-only batch can use the
      // fragment append path. This first batch remains a normal upsert because
      // the durable row may not exist yet.
      nextAssistantIdentity: deriveTrailingAssistantIdentity(
        queuedMessages,
        normalizeQueuedStreamMessages([], queuedMessages)
      )
    }
  }

  const baselineMessages = loadBaselineMessages()
  const normalizedMessages = normalizeQueuedStreamMessages(baselineMessages, queuedMessages).map(
    stableAssistantProviderTuple
  )
  return {
    messages: coalesceNormalizedStreamMessages(normalizedMessages),
    // The bounded baseline resolves identities only. Existing durable ordinals
    // remain authoritative; this flush may update matching rows or append new
    // rows, but must never reload/rewrite the lifetime transcript.
    preserveExistingOrder: true,
    nextAssistantIdentity: deriveTrailingAssistantIdentity(queuedMessages, normalizedMessages)
  }
}
