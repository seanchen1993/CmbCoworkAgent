import type { Message } from "@/types"

const padTimePart = (value: number): string => String(value).padStart(2, "0")

// Absolute local time needs no clock subscription or relative-date invalidation.
// Keep formatting cheap: this also runs when timing metadata is rebuilt for history.
export function formatMessageTimeLabel(time: number): string | null {
  const date = new Date(time)
  if (!Number.isFinite(date.getTime())) return null
  const day = `${date.getFullYear()}-${padTimePart(date.getMonth() + 1)}-${padTimePart(date.getDate())}`
  return `${day} ${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`
}

function toDate(value: Date | string | number | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null
  }
  if (value === undefined) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function toTime(value: Date | string | number | undefined): number | null {
  return toDate(value)?.getTime() ?? null
}

function getCreatedTime(message: Message): number | null {
  return toTime(message.created_at) ?? toTime(message.start_at) ?? toTime(message.end_at)
}

export function getAssistantStartTime(message: Message): number | null {
  if (message.role !== "assistant") return null
  return toTime(message.start_at) ?? getCreatedTime(message)
}

function getEndTime(message: Message): number | null {
  return toTime(message.end_at) ?? toTime(message.created_at) ?? toTime(message.start_at)
}

export function buildMessageBubbleTimingMeta(messages: Message[]): {
  assistantDurationMsById: Map<string, number>
  userSendTimeLabelById: Map<string, string>
} {
  const assistantDurationMsById = new Map<string, number>()
  const userSendTimeLabelById = new Map<string, string>()

  for (const message of messages) {
    if (message.role !== "user") continue
    const createdAt = getCreatedTime(message)
    if (createdAt === null) continue
    const label = formatMessageTimeLabel(createdAt)
    if (label) userSendTimeLabelById.set(message.id, label)
  }

  for (let userIndex = 0; userIndex < messages.length; userIndex += 1) {
    const userMessage = messages[userIndex]
    if (userMessage.role !== "user") continue

    const userCreatedAt = getCreatedTime(userMessage)
    if (userCreatedAt === null) continue

    let nextUserIndex = -1
    for (let index = userIndex + 1; index < messages.length; index += 1) {
      if (messages[index].role === "user") {
        nextUserIndex = index
        break
      }
    }

    const turnEndIndex = nextUserIndex === -1 ? messages.length - 1 : nextUserIndex - 1
    if (turnEndIndex < userIndex) continue

    const turnEndTime = getEndTime(messages[turnEndIndex])
    if (turnEndTime === null) continue

    let firstAssistantId: string | null = null
    for (let index = userIndex + 1; index <= turnEndIndex; index += 1) {
      if (messages[index].role === "assistant") {
        firstAssistantId = messages[index].id
        break
      }
    }

    if (!firstAssistantId) continue
    assistantDurationMsById.set(firstAssistantId, Math.max(0, turnEndTime - userCreatedAt))
  }

  return { assistantDurationMsById, userSendTimeLabelById }
}
