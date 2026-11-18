import { coordinatorTranscriptContentToText } from "../../shared/internal-notification-turn"
import { getThreadMessagesByIds, upsertThreadMessages } from "../db"
import { BotError } from "../../shared/bots/contracts"
import { BOT_FIXED_REMINDER_DELAY_MS, delayedBotReminderText, scheduledDesktopMessage,
  type BotScheduledWorkPublication } from "../../shared/bots/schedule-observation"
import { mirrorStandardTurnStreamToRenderer } from "../agent/renderer-stream-mirror"
import { emitAppAttention } from "../app-attention-events"
import { notifyIfBackground } from "../services/notify"

/** The original transcript is the desktop receipt. Retry only the same committed message. */
export function persistBotResultMessage(
  threadId: string,
  id: string,
  content: string,
  createdAt: number,
  existing: ReturnType<typeof getThreadMessagesByIds>[number] | null = getThreadMessagesByIds(threadId, [id])[0] ?? null
): void {
  if (existing) {
    if (existing.role !== "assistant" || existing.content !== content)
      throw new BotError("CONFLICT", "原结果交付消息身份不一致。")
    return
  }
  if (
    !upsertThreadMessages(
      threadId,
      [
        {
          id,
          role: "assistant",
          content,
          created_at: new Date(createdAt)
        }
      ],
      { preserveExistingOrder: true }
    )
  )
    throw new Error("未确认原结果已写入主对话。")
}

/** Attach retained result links to the normal reply without creating another message. */
export function completeBotResultMessage(
  threadId: string, id: string, originalText: string, content: string,
  existing = getThreadMessagesByIds(threadId, [id])[0],
  previousGeneratedContent?: string
): void {
  const existingText = coordinatorTranscriptContentToText(existing?.content)
  if (!existing || existing.id !== id || existing.role !== "assistant" ||
      (existingText.trim() !== originalText && existingText !== content && existingText !== previousGeneratedContent))
    throw new BotError("CONFLICT", "原正常回复已变化，未重复发布成果。")
  if (existingText === content) return
  // Final stream rows carry snapshot authority. Preserve the existing priority
  // and verify the durable bytes before the caller acknowledges delivery.
  if (!upsertThreadMessages(threadId,
    [{ ...existing, content, content_mode: "snapshot" }], { preserveExistingOrder: true }) ||
    getThreadMessagesByIds(threadId, [id])[0]?.content !== content)
    throw new Error("未确认附件链接已写入原回复。")
}

/** A null receipt means the first write was skipped because the reminder expired. */
export function persistScheduledBotResultMessage(publication: BotScheduledWorkPublication): string | null | undefined {
  const { threadId, id, createdAt } = publication
  if (!publication.reminder) {
    persistBotResultMessage(threadId, id, scheduledDesktopMessage(publication), createdAt)
    return undefined
  }
  const existing = getThreadMessagesByIds(threadId, [id])[0] ?? null
  if (!existing && publication.reminderExpiresAt && Date.parse(publication.reminderExpiresAt) <= Date.now())
    return null
  const late = delayedBotReminderText(publication.text)
  const markLate = existing ? existing.content === late : Date.now() - createdAt >= BOT_FIXED_REMINDER_DELAY_MS
  const text = markLate ? late : publication.text
  persistBotResultMessage(threadId, id, text, createdAt, existing)
  return text === publication.text ? undefined : text
}

/** Only the first durable acknowledgement is allowed to raise the existing attention signals. */
export async function announceBotResultMessage(input: {
  threadId: string
  id: string
  content: string
  attention: "task-complete" | "task-error" | "interaction"
  notificationTitle: string
  notificationBody: string
  petTitle?: string
  mirrorTranscript?: boolean
}): Promise<void> {
  const { threadId, id, content } = input
  const send = [
    ...(input.mirrorTranscript === false ? [] : [() => {
      mirrorStandardTurnStreamToRenderer(threadId, {
        type: "turn-messages",
        messages: [{ id, role: "assistant", content }]
      })
      mirrorStandardTurnStreamToRenderer(threadId, { type: "done" })
    }]),
    () => emitAppAttention({ kind: input.attention, threadId, key: `bot:${id}` }),
    () => notifyIfBackground(input.notificationTitle, input.notificationBody)
  ]
  if (input.petTitle) {
    const title = input.petTitle
    send.push(async () => {
      const { showPetCompletedTaskNotice } = await import("../pet")
      showPetCompletedTaskNotice(threadId, title)
    })
  }
  for (const outlet of send) {
    try {
      await outlet()
    } catch (error) {
      console.warn("[Bots] Committed result notification unavailable", error)
    }
  }
}
