import { z } from "zod"

const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9:_-]+$/)
export const botSkillSelection = z
  .object({
    botId: identifier,
    id: identifier,
    version: z.number().int().min(1)
  })
  .strict()
export const botSkillSelections = z
  .array(botSkillSelection)
  .max(6)
  .refine(
    (items) => new Set(items.map((item) => `${item.botId}:${item.id}`)).size === items.length,
    "不能重复选择相同技能"
  )
export const botSkillReference = botSkillSelection.extend({ name: z.string().min(1).max(100) })
export type BotSkillSelection = z.infer<typeof botSkillSelection>
export type BotSkillReference = z.infer<typeof botSkillReference>
export interface BotSkillCandidate extends BotSkillReference {
  scope?: "bot" | "user" | "desktop"
  sourceName?: string
  botName: string
  verified: boolean
}
