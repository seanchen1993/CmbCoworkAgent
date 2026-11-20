import type { Message } from "../types"

export interface TrustedMessageTailLocation {
  messages: Message[]
  index: number
  tail: Message
}

function hasSameToolCallStructure(
  existing: Message["tool_calls"],
  incoming: Message["tool_calls"]
): boolean {
  if (incoming === undefined) return true
  if (existing === incoming) return true
  if (!existing || existing.length !== incoming.length) return false
  return incoming.every((toolCall, index) => {
    const previous = existing[index]
    return (
      previous?.id === toolCall.id &&
      previous.name === toolCall.name &&
      Object.is(previous.args, toolCall.args)
    )
  })
}

function isMonotonicText(existing: unknown, incoming: unknown): boolean {
  if (incoming === undefined) return true
  if (typeof existing !== "string" || typeof incoming !== "string") return false
  return incoming === existing || incoming.startsWith(existing)
}

/**
 * Replace an owned scheduler transcript tail without copying or inspecting its
 * stable prefix. Any identity, ordering, or tool-structure uncertainty rejects
 * the fast path so the caller can use canonical normalization instead.
 */
export function replaceTrustedMessageTailInPlace(
  location: TrustedMessageTailLocation | undefined,
  messages: Message[],
  incoming: Message
): boolean {
  if (
    !location ||
    location.messages !== messages ||
    location.index !== messages.length - 1
  ) {
    return false
  }
  const existing = messages[location.index]
  if (
    existing !== location.tail ||
    existing.id !== incoming.id ||
    existing.role !== incoming.role ||
    existing.tool_call_id !== incoming.tool_call_id ||
    existing.name !== incoming.name ||
    !hasSameToolCallStructure(existing.tool_calls, incoming.tool_calls) ||
    !isMonotonicText(existing.content, incoming.content) ||
    !isMonotonicText(existing.reasoning, incoming.reasoning)
  ) {
    return false
  }

  const next = {
    ...existing,
    ...incoming,
    created_at: existing.created_at
  }
  messages[location.index] = next
  location.tail = next
  return true
}
