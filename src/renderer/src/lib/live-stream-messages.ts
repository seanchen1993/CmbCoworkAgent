import type { Message } from "@/types"

export interface LiveStreamMessage {
  id?: string
  type?: string
  content?: string | unknown[]
  tool_calls?: Message["tool_calls"]
  tool_call_id?: string
  name?: string
}

export function mergeLiveStreamMessages(
  previous: LiveStreamMessage[],
  incoming: LiveStreamMessage[]
): LiveStreamMessage[] {
  if (incoming.length === 0) return previous

  const merged = new Map<string, LiveStreamMessage>()
  for (const message of previous) {
    if (message.id) merged.set(message.id, message)
  }

  for (const message of incoming) {
    if (!message.id) continue
    const existing = merged.get(message.id)
    merged.set(message.id, {
      ...existing,
      ...message,
      content:
        message.content !== undefined && message.content !== ""
          ? message.content
          : existing?.content ?? message.content,
      tool_calls:
        message.tool_calls && message.tool_calls.length > 0
          ? message.tool_calls
          : existing?.tool_calls,
      tool_call_id: message.tool_call_id ?? existing?.tool_call_id,
      name: message.name ?? existing?.name
    })
  }

  return Array.from(merged.values())
}
