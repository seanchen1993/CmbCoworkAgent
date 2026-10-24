import { BotError, type BotMessageMention } from "./contracts"

/** Validate selected identities against exact text, never infer identity from an @name. */
export function parseBotMessageMentions(
  message: string,
  input: unknown,
  leading = 0
): BotMessageMention[] {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > 128)
    throw new BotError("INVALID_INPUT", "Bot 提及格式无效")
  let previousEnd = 0
  return input.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new BotError("INVALID_INPUT", "Bot 提及格式无效")
    const item = value as Record<string, unknown>
    const start = Number(item.start) - leading,
      end = Number(item.end) - leading
    const group = item.kind === "group"
    const id = group ? item.groupId : item.botId
    if (
      !Number.isSafeInteger(item.start) ||
      !Number.isSafeInteger(item.end) ||
      start < previousEnd ||
      end <= start ||
      end > message.length ||
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
      (group ? "botId" in item : item.kind !== undefined || "groupId" in item) ||
      typeof item.label !== "string" ||
      !item.label ||
      item.label.length > 200 ||
      item.label !== item.label.trim() ||
      item.label.includes("\0") ||
      message.slice(start, end) !== `@${item.label}`
    )
      throw new BotError("INVALID_INPUT", "Bot 提及与原消息不一致，请重新选择")
    previousEnd = end
    return group
      ? { start, end, kind: "group", groupId: id, label: item.label }
      : { start, end, botId: id, label: item.label }
  })
}

/** Old sends retain their exact digest bytes. New sends bind both text and selected identities. */
export function canonicalBotMessageInput(
  message: string,
  mentions?: readonly BotMessageMention[]
): string {
  const selected = parseBotMessageMentions(message, mentions)
  return selected.length ? JSON.stringify([message, selected]) : message
}
