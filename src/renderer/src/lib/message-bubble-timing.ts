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
  let activeTurn:
    | {
        userCreatedAt: number
        firstAssistantId: string | null
        lastMessageEndAt: number | null
      }
    | undefined

  const finishActiveTurn = (): void => {
    if (!activeTurn?.firstAssistantId || activeTurn.lastMessageEndAt === null) return
    assistantDurationMsById.set(
      activeTurn.firstAssistantId,
      Math.max(0, activeTurn.lastMessageEndAt - activeTurn.userCreatedAt)
    )
  }

  for (const message of messages) {
    if (message.role === "user") {
      finishActiveTurn()

      const createdAt = getCreatedTime(message)
      if (createdAt === null) {
        activeTurn = undefined
        continue
      }

      userSendTimeLabelById.set(message.id, hourMinuteFormatter.format(new Date(createdAt)))
      activeTurn = {
        userCreatedAt: createdAt,
        firstAssistantId: null,
        lastMessageEndAt: getEndTime(message)
      }
      continue
    }

    if (!activeTurn) continue
    activeTurn.lastMessageEndAt = getEndTime(message)
    if (message.role === "assistant" && activeTurn.firstAssistantId === null) {
      activeTurn.firstAssistantId = message.id
    }
  }

  finishActiveTurn()
  return { assistantDurationMsById, userSendTimeLabelById }
}
