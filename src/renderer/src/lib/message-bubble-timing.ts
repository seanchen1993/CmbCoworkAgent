import type { Message } from "@/types"

const hourMinuteFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
})

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
    userSendTimeLabelById.set(message.id, hourMinuteFormatter.format(new Date(createdAt)))
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
