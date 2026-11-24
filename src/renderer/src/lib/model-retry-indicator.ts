import { liveStreamMessageRole, type LiveStreamMessage } from "./live-stream-messages"

type RetryMessage = Pick<LiveStreamMessage, "id" | "type" | "content">

function assistantText(message: RetryMessage): string {
  if (liveStreamMessageRole(message.type) !== "assistant") return ""
  const content = message.content
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  return content
    .map((block: unknown) => {
      if (typeof block === "string") return block
      if (!block || typeof block !== "object") return ""
      const { type, text } = block as { type?: unknown; text?: unknown }
      return type === "text" && typeof text === "string" ? text : ""
    })
    .join("")
    .trim()
}

/** Capture the assembled stream state at the retry event, before the next frame. */
export function captureModelRetryBaseline(
  messages: readonly RetryMessage[],
  baseline = new Map<string, string>()
): Map<string, string> {
  for (const message of messages) {
    if (!message.id) continue
    const text = assistantText(message)
    if (text) baseline.set(message.id, text)
  }
  return baseline
}

export function hasModelRetryProgress(
  baseline: ReadonlyMap<string, string>,
  messages: readonly RetryMessage[]
): boolean {
  return messages.some((message) => {
    if (!message.id) return false
    const text = assistantText(message)
    const previous = baseline.get(message.id) ?? ""
    // A repeated or shorter prefix is a replay of text already received.
    return Boolean(text) && !previous.startsWith(text)
  })
}
