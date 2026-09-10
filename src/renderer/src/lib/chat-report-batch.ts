import type { Message } from "@/types"
import { stringifyMessageContentForReport } from "./live-stream-messages"

export interface ChatReportBatch {
  messageIds: string[]
  payload: Array<{ role: string; content: string }>
}

// The durable history page is already bounded, but a retained task may have
// many manually-prepended pages. Reporting only needs the latest user turn and
// must never copy or retain that complete history during a task switch.
export const CHAT_REPORT_MAX_TURN_SCAN_MESSAGES = 512
export const CHAT_REPORT_MAX_BATCH_MESSAGES = 128
export const CHAT_REPORT_MAX_MESSAGE_CHARS = 64_000
export const CHAT_REPORT_MAX_BATCH_CHARS = 256_000

const TRUNCATION_MARKER = "\n…"

function truncateReportContent(content: string, limit: number): string {
  if (content.length <= limit) return content
  if (limit <= TRUNCATION_MARKER.length) return content.slice(0, limit)
  return `${content.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
}

function projectReportMessage(
  message: Message,
  remainingChars: number
): { id: string; role: string; content: string } | null {
  if (!message.id || remainingChars <= 0) return null
  const content = truncateReportContent(
    stringifyMessageContentForReport(message.content),
    Math.min(CHAT_REPORT_MAX_MESSAGE_CHARS, remainingChars)
  )
  return { id: message.id, role: message.role, content }
}

/**
 * Build a bounded report for the latest user turn.
 *
 * The backward lookup itself is capped, so a 10k-message retained history has
 * the same reporting cost as a normal recent page. The initiating user prompt
 * is kept first and the remaining budget is spent newest-first, preserving the
 * most useful completion tail when a tool-heavy turn exceeds the cap.
 */
export function buildLatestChatReportBatch(
  messages: readonly Message[]
): ChatReportBatch | null {
  const lastMessage = messages.at(-1)
  if (!lastMessage || lastMessage.role === "user") return null

  const scanStart = Math.max(0, messages.length - CHAT_REPORT_MAX_TURN_SCAN_MESSAGES)
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= scanStart; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index
      break
    }
  }
  if (lastUserIndex < 0) return null

  const user = projectReportMessage(messages[lastUserIndex], CHAT_REPORT_MAX_MESSAGE_CHARS)
  if (!user) return null

  let remainingChars = CHAT_REPORT_MAX_BATCH_CHARS - user.content.length
  const newestTail: Array<{ id: string; role: string; content: string }> = []
  const tailStart = Math.max(
    lastUserIndex + 1,
    messages.length - (CHAT_REPORT_MAX_BATCH_MESSAGES - 1)
  )
  for (let index = messages.length - 1; index >= tailStart; index -= 1) {
    const projected = projectReportMessage(messages[index], remainingChars)
    if (!projected) break
    newestTail.push(projected)
    remainingChars -= projected.content.length
  }
  newestTail.reverse()

  const selected = [user, ...newestTail]
  return {
    messageIds: selected.map((message) => message.id),
    payload: selected.map(({ role, content }) => ({ role, content }))
  }
}
