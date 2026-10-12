import type { Message } from "../../../main/types"
import { isVisibleTranscriptMessage } from "../../../shared/checkpoint-transcript"
import {
  botContextMessage,
  botContextImport,
  type BotContextImport,
  type BotContextDraft
} from "../../../shared/bot-context-import"

/** Reuse the paged Cmb transcript, exposing only complete visible text for an explicit selection. */
export function selectableBotContextMessages(
  messages: readonly Message[],
  truncatedIds: readonly string[] = []
): BotContextDraft["messages"] {
  const truncated = new Set(truncatedIds)
  return messages.flatMap((message) => {
    if (
      truncated.has(message.id) ||
      !["user", "assistant"].includes(message.role) ||
      !isVisibleTranscriptMessage(message.role, message.content)
    )
      return []
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n")
    if (!text.trim()) return []
    const time = new Date(message.created_at).getTime()
    const parsed = botContextMessage.safeParse({
      id: message.id,
      role: message.role,
      text,
      ...(Number.isSafeInteger(message.ordinal) && message.ordinal! >= 0
        ? { ordinal: message.ordinal }
        : {}),
      ...(Number.isSafeInteger(time) && time >= 0 ? { createdAt: time } : {})
    })
    return parsed.success ? [parsed.data] : []
  })
}

const key = (botId: string) => `bot-context-pending:${botId}`
export function readPendingContextImport(
  botId: string,
  dataEpoch: string
): BotContextImport | null {
  try {
    const raw = localStorage.getItem(key(botId))
    if (!raw || raw.length > 400_000) return null
    const saved = JSON.parse(raw)
    if (saved.dataEpoch !== dataEpoch) return null
    const parsed = botContextImport.safeParse(saved.input)
    return parsed.success && parsed.data.botId === botId ? parsed.data : null
  } catch {
    return null
  }
}

export function rememberContextImport(input: BotContextImport, dataEpoch: string): void {
  try {
    localStorage.setItem(key(input.botId), JSON.stringify({ input, dataEpoch }))
  } catch {
    throw new Error("无法保留导入记录，请清理应用存储后重试。记录尚未提交。")
  }
}

export function acknowledgeContextImport(input: BotContextImport, dataEpoch: string): void {
  try {
    if (readPendingContextImport(input.botId, dataEpoch)?.nonce === input.nonce)
      localStorage.removeItem(key(input.botId))
  } catch {
    /* A retained receipt is safe to acknowledge again after reopening. */
  }
}
