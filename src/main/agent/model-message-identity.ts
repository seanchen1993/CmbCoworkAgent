import { AIMessage, AIMessageChunk, BaseMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"
import {
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId,
  getMessageProviderOccurrence,
  getMessageProviderSourceId,
  getMessageProviderTupleFromMetadata,
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY,
  type RoleCollisionMessage
} from "../../shared/message-role-collision"

function identity(message: BaseMessage): RoleCollisionMessage | undefined {
  if (typeof message.id !== "string" || !message.id.trim()) return undefined
  const type = message.getType()
  return {
    id: message.id,
    role: type === "ai" ? "assistant" : type === "human" ? "user" : type,
    ...getMessageProviderTupleFromMetadata(message.additional_kwargs)
  }
}

/** Only ordinary graphs use this. Native model calls retain their original provider binding
 * and obtain a host UUID from their own finalizer before entering the reducer.
 */
export function normalizeModelMessageIdentity(
  response: unknown,
  history: readonly BaseMessage[]
): void {
  const source =
    response && typeof response === "object"
      ? (response as { messages?: unknown; update?: { messages?: unknown } })
      : undefined
  const messages =
    AIMessage.isInstance(response) || AIMessageChunk.isInstance(response)
      ? [response]
      : Array.isArray(source?.messages)
        ? source.messages
        : Array.isArray(source?.update?.messages)
          ? source.update.messages
          : []
  const occupied = new Set<string>()
  const occurrences = new Map<string, number>()
  for (const message of history) {
    const value = identity(message)
    if (!value) continue
    occupied.add(value.id)
    if (value.role === "assistant") {
      const sourceId = getMessageProviderSourceId(value)
      occurrences.set(
        sourceId,
        Math.max(occurrences.get(sourceId) ?? 0, getMessageProviderOccurrence(value) ?? 1)
      )
    }
  }
  // Structured results may place a ToolMessage after an AIMessage with the same ID.
  for (const message of messages) {
    if (
      BaseMessage.isInstance(message) &&
      !AIMessage.isInstance(message) &&
      !AIMessageChunk.isInstance(message) &&
      typeof message.id === "string"
    )
      occupied.add(message.id)
  }
  const priorObjects = new Set(history)
  const processed = new Set<object>()
  for (const message of messages) {
    if (!AIMessage.isInstance(message) && !AIMessageChunk.isInstance(message)) continue
    if (processed.has(message)) continue
    processed.add(message)
    if (priorObjects.has(message)) throw Error("MODEL_RESPONSE_REUSES_HISTORY_OBJECT")
    if (typeof message.id !== "string" || !message.id.trim()) continue
    const sourceId = getMessageProviderSourceId(identity(message)!)
    const occurrence = (occurrences.get(sourceId) ?? 0) + 1
    if (!Number.isSafeInteger(occurrence)) throw Error("MODEL_RESPONSE_OCCURRENCE_INVALID")
    let candidate =
      occurrence > 1
        ? buildMessageSameRoleDuplicateId(sourceId, "assistant", occurrence)
        : message.id
    if (occupied.has(candidate)) {
      candidate = buildMessageRoleCollisionId(
        sourceId,
        "assistant",
        occurrence > 1 ? occurrence : undefined
      )
      let suffix = Math.max(2, occurrence)
      while (occupied.has(candidate)) {
        if (!Number.isSafeInteger(suffix)) throw Error("MODEL_RESPONSE_OCCURRENCE_INVALID")
        candidate = buildMessageRoleCollisionId(sourceId, "assistant", suffix)
        suffix += 1
      }
    }
    const additional = {
      ...message.additional_kwargs,
      [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: sourceId,
      [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: occurrence
    }
    // Keep the original object: structured retry Commands hold this same response reference.
    // _updateId also updates lc_kwargs, so a cold checkpoint load retains the assigned ID.
    if (candidate !== message.id) message._updateId(candidate)
    message.additional_kwargs = additional
    message.lc_kwargs.additional_kwargs = additional
    occupied.add(candidate)
    occurrences.set(sourceId, occurrence)
  }
}

export function createModelMessageIdentityMiddleware() {
  return createMiddleware({
    name: "ordinaryModelMessageIdentity",
    wrapModelCall: async (request, handler) => {
      const response = await handler(request)
      normalizeModelMessageIdentity(response, request.state.messages)
      return response
    }
  })
}
