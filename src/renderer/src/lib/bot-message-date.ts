import type { Message } from "@/types"
import { formatMessageTimeLabel, getCreatedTime } from "./message-bubble-timing"

/** Session separators use message timestamps, so history doesn't need a ticking clock. */
export function botMessageDate(message: Message, previous?: Message | null): string | null {
  const current = getCreatedTime(message)
  if (current === null || message.role === "tool") return null
  const before = previous ? getCreatedTime(previous) : null
  return botSessionDate(current, before)
}

/** Shared by private and group timelines; dates come from durable message timestamps. */
export function botSessionDate(current: number, before: number | null): string | null {
  if (!Number.isFinite(current)) return null
  if (
    before !== null &&
    current >= before &&
    current - before < 30 * 60_000 &&
    new Date(current).toDateString() === new Date(before).toDateString()
  )
    return null
  return formatMessageTimeLabel(current)
}
