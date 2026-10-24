import { BotError } from "./contracts"
import { botIdentifier } from "./validation"
import { isBotThreadMessageId } from "./message-reply"
import nativeEmoji from "./reaction-emoji-native.json"

export const BOT_REACTION_LOOKUP_LIMIT = 100
export const BOT_MESSAGE_REACTION_LIMIT = 64

/** The host resolves the real thread; renderer input never supplies a transcript path. */
export type BotReactionTarget =
  | { kind: "bot"; botId: string; workId?: string }
  | { kind: "group"; groupId: string }

export interface BotReactionItem {
  emoji: string
  count: number
  mine: boolean
  actors?: { botId: string; name: string }[]
}
export interface BotMessageReactionState {
  messageId: string
  canReact: boolean
  reactions: BotReactionItem[]
}
export interface BotMessageReactions {
  revision: number
  items: BotMessageReactionState[]
}
export interface BotMessageReactionUpdate {
  revision: number
  item: BotMessageReactionState
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BotError("INVALID_INPUT", "消息反应请求格式无效")
  return value as Record<string, unknown>
}
export function parseBotReactionTarget(value: unknown): BotReactionTarget {
  const input = record(value)
  if (input.kind === "bot") {
    if (Object.keys(input).some((key) => !["kind", "botId", "workId"].includes(key)))
      throw new BotError("INVALID_INPUT", "消息反应会话目标无效")
    return {
      kind: "bot",
      botId: botIdentifier(input.botId),
      ...(input.workId !== undefined ? { workId: botIdentifier(input.workId) } : {})
    }
  }
  if (
    input.kind === "group" &&
    Object.keys(input).every((key) => ["kind", "groupId"].includes(key))
  )
    return { kind: "group", groupId: botIdentifier(input.groupId) }
  throw new BotError("INVALID_INPUT", "消息反应会话目标无效")
}
export function parseBotReactionMessageId(value: unknown): string {
  if (!isBotThreadMessageId(value)) throw new BotError("INVALID_INPUT", "消息标识无效")
  return value
}
export function parseBotReactionMessageIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > BOT_REACTION_LOOKUP_LIMIT)
    throw new BotError("INVALID_INPUT", "消息反应查询过多")
  return [...new Set(value.map(parseBotReactionMessageId))]
}

// The picker and host share the same versioned Unicode catalog. Prefer the fully
// qualified form so a quick heart and its presentation-selector alias cannot duplicate.
const canonicalEmoji = new Map<string, string>()
const supportedEmoji = new Set(nativeEmoji)
for (const emoji of nativeEmoji) {
  const key = emoji.replace(/\uFE0F/g, "")
  const previous = canonicalEmoji.get(key)
  if (!previous || previous.length < emoji.length) canonicalEmoji.set(key, emoji)
}
export function parseBotReactionEmoji(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 64 || value !== value.trim())
    throw new BotError("INVALID_INPUT", "请选择一个有效表情")
  const emoji = canonicalEmoji.get(value.replace(/\uFE0F/g, ""))
  if (!emoji || (!supportedEmoji.has(value) && value !== emoji.replace(/\uFE0F/g, "")))
    throw new BotError("INVALID_INPUT", "请选择一个有效表情")
  return emoji
}
export function parseBotReactionPresent(value: unknown): boolean {
  if (typeof value !== "boolean") throw new BotError("INVALID_INPUT", "消息反应状态无效")
  return value
}
