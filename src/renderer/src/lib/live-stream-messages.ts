import type { ContentBlock, Message } from "@/types"

export interface LiveStreamMessage {
  id?: string
  type?: string
  content?: string | unknown[]
  tool_calls?: Message["tool_calls"]
  tool_call_id?: string
  name?: string
  start_at?: Date
  end_at?: Date
}

export function mergeLiveStreamMessages(
  previous: LiveStreamMessage[],
  incoming: LiveStreamMessage[]
): LiveStreamMessage[] {
  if (incoming.length === 0) return previous

  const merged = new Map<string, LiveStreamMessage>()
  for (const message of previous) {
    if (hasLiveStreamMessageId(message)) merged.set(message.id, message)
  }

  for (const message of incoming) {
    if (!hasLiveStreamMessageId(message)) continue
    const existing = merged.get(message.id)
    merged.set(message.id, {
      ...existing,
      ...message,
      content: hasUsefulStreamContent(message.content)
        ? message.content
        : (existing?.content ?? message.content),
      tool_calls:
        message.tool_calls && message.tool_calls.length > 0
          ? message.tool_calls
          : existing?.tool_calls,
      tool_call_id: message.tool_call_id ?? existing?.tool_call_id,
      name: message.name ?? existing?.name
    })
  }

  const incomingIds = new Set(incoming.filter(hasLiveStreamMessageId).map((message) => message.id))
  const previousIds = previous.filter(hasLiveStreamMessageId).map((message) => message.id)
  const incomingCoversPrevious =
    previousIds.length > 0 && previousIds.every((messageId) => incomingIds.has(messageId))
  if (incomingCoversPrevious) {
    const ordered: LiveStreamMessage[] = []
    const emitted = new Set<string>()
    for (const message of incoming) {
      if (!hasLiveStreamMessageId(message) || emitted.has(message.id)) continue
      const mergedMessage = merged.get(message.id)
      if (mergedMessage) {
        ordered.push(mergedMessage)
        emitted.add(message.id)
      }
    }
    for (const message of previous) {
      if (!hasLiveStreamMessageId(message) || emitted.has(message.id)) continue
      const mergedMessage = merged.get(message.id)
      if (mergedMessage) ordered.push(mergedMessage)
    }
    return ordered
  }

  return Array.from(merged.values())
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
