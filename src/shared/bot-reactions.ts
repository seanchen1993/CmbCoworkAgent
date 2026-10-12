import { z } from "zod"
export type { TranscriptReaction as BotReaction } from "./upstream/grok-reactions"

const segments = new Intl.Segmenter("en", { granularity: "grapheme" })
export function isBotReactionEmoji(value: string): boolean {
  return (
    value.length <= 16 &&
    [...segments.segment(value)].length === 1 &&
    (/\p{Extended_Pictographic}/u.test(value) ||
      /^\p{Regional_Indicator}{2}$/u.test(value) ||
      /^[0-9#*]\uFE0F?\u20E3$/u.test(value)) &&
    !/[\p{L}\p{N}\p{White_Space}]/u.test(value.replace(/^[0-9](?=\uFE0F?\u20E3$)/u, ""))
  )
}
export const botReactionEmoji = z.string().refine(isBotReactionEmoji, "请选择一个有效表情")
export const botReactionState = z.object({
  messageId: z.string(),
  revision: z.number().int().nonnegative(),
  reactions: z.array(z.object({ emoji: botReactionEmoji, by: z.string().min(1).max(160) })).max(100)
})
export type BotReactionState = z.infer<typeof botReactionState>
export interface BotReactInput {
  conversationId: string
  messageId: string
  emoji: string
  active: boolean
  revision: number
}
