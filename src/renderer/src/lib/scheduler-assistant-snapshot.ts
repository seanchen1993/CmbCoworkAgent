import type { Message } from "../types"
import { normalizeAppendedMessageIds } from "../../../shared/message-role-collision"

export interface SchedulerAssistantAccumulator {
  currentMsgId: string | null
  accumulatedContent: string
  accumulatedReasoning: string
}

export function mergeSchedulerReasoning(current: string, incoming: string, mode?: unknown): string {
  if (mode === "snapshot") return incoming
  if (mode === "delta") return current + incoming
  return incoming.startsWith(current) ? incoming : current + incoming
}

/** Keep the scheduler's next delta based on the same text that the UI displays. */
export function applySchedulerAssistantSnapshot(
  tracker: SchedulerAssistantAccumulator,
  messages: Message[],
  value: unknown
): Message | undefined {
  if (!value || typeof value !== "object") return undefined
  const snapshot = value as Record<string, unknown>
  if (typeof snapshot.id !== "string" || !snapshot.id) return undefined
  if (snapshot.type !== undefined && snapshot.type !== "ai") return undefined
  const hasContent = typeof snapshot.content === "string"
  const hasReasoning = typeof snapshot.reasoning === "string"
  if (!hasContent && !hasReasoning) return undefined
  const identity = normalizeAppendedMessageIds(messages, [{ id: snapshot.id, role: "assistant" }], {
    splitAssistantAfterTool: true
  })[0]
  const existing = messages.find(
    (message) => message.id === identity.id && message.role === "assistant"
  )
  const content = hasContent ? (snapshot.content as string) : (existing?.content ?? "")
  const reasoning = hasReasoning ? (snapshot.reasoning as string) : existing?.reasoning
  tracker.currentMsgId = snapshot.id
  tracker.accumulatedContent = typeof content === "string" ? content : ""
  tracker.accumulatedReasoning = reasoning ?? ""
  return {
    ...existing,
    ...identity,
    role: "assistant",
    content,
    ...(reasoning !== undefined && { reasoning }),
    created_at: existing?.created_at ?? new Date()
  }
}
