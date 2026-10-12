import { z } from "zod"

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9:_-]+$/)
export const BOT_SKILL_LIBRARY_LIMIT = 256
export const BOT_USER_SKILLS_CAPABILITY = "user-skill-definitions-v1"
export const botSkillEnablement = z
  .object({
    nonce: id,
    expectedDataEpoch: z.string().min(1).max(160),
    botId: id,
    id,
    version: z.number().int().positive().safe(),
    revision: z.number().int().nonnegative().safe(),
    enabled: z.boolean()
  })
  .strict()
export type BotSkillEnablementInput = z.infer<typeof botSkillEnablement>
export interface BotSkillEnablementReceipt {
  botId: string
  id: string
  version: number
  revision: number
  enabled: boolean
}
// Leave headroom inside the authenticated transport's 8 MiB envelope.
export const BOT_SKILL_LIBRARY_BYTES = 4 * 1024 * 1024
export const botPublishSkill = z
  .object({
    nonce: id,
    botId: id,
    skillId: id,
    version: z.number().int().positive(),
    // Zero means the user reviewed that this skill has never been published.
    libraryRevision: z.number().int().nonnegative()
  })
  .strict()
export const botWithdrawSkill = z
  .object({
    nonce: id,
    id,
    revision: z.number().int().positive(),
    expectedDataEpoch: z.string().min(1).max(160).optional()
  })
  .strict()
export type BotPublishSkill = z.infer<typeof botPublishSkill>
export type BotWithdrawSkill = z.infer<typeof botWithdrawSkill>
export interface BotLibrarySkill {
  kind?: "authored"
  id: string
  sourceBotId: string
  sourceSkillId: string
  sourceVersion: number
  name: string
  instructions: string
  revision: number
  enabled: boolean
  updatedAt: number
}
