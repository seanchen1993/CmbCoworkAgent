import { z } from "zod"
import { botIntroductionIntent } from "./bot-introduction"

/** A user/Host workspace has one primary Bot. Pinning is an independent preference. */
const mutation = z.object({
  revision: z.number().int().nonnegative(),
  dataEpoch: z.string().min(1).max(160),
  nonce: z.string().min(1).max(160)
})
export const botPrimaryChange = mutation.extend({ botId: z.string().uuid().nullable() }).strict()
export type BotPrimaryChange = z.infer<typeof botPrimaryChange>
export const botPrimaryEnsure = mutation
  .extend({
    /** Only this explicit human request introduces a newly created primary Bot. */
    introduction: botIntroductionIntent.optional(),
    /** Explicitly reviewed creation settings, never inferred from a render or a peer message. */
    profile: z
      .object({
        name: z.string().trim().min(1).max(100),
        autoReviewEnabled: z.boolean().optional(),
        instructions: z.string().max(32_000).default(""),
        modelRef: z.string().min(1).max(200).nullable().default(null),
        workspacePath: z.string().min(1).max(4096).nullable().default(null)
      })
      .strict()
  })
  .strict()
export type BotPrimaryEnsure = z.input<typeof botPrimaryEnsure>
export const botPrimaryCheckInChange = mutation
  .extend({
    primaryRevision: z.number().int().nonnegative(),
    botId: z.string().uuid(),
    enabled: z.boolean(),
    prompt: z.string().trim().min(1).max(8000),
    targetBotIds: z
      .array(z.string().uuid())
      .min(1)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, "Bot 不能重复"),
    everyMs: z
      .number()
      .int()
      .min(60_000)
      .max(86_400_000)
      .refine((ms) => ms % 1000 === 0, "频率必须为整秒"),
    timezone: z.string().min(1).max(100)
  })
  .strict()
export type BotPrimaryCheckInChange = z.infer<typeof botPrimaryCheckInChange>
export interface BotPrimaryCheckIn {
  revision: number
  botId: string
  enabled: boolean
  prompt: string
  targetBotIds: string[]
  everyMs: number
  timezone: string
  /** Deleting the managed routine retains this configuration revision. */
  routineId: string | null
}
export interface BotPrimaryState {
  revision: number
  botId: string | null
  dataEpoch: string
  /** Persisted even after its routine is deleted; use this for configuration CAS. */
  checkInRevision: number
  checkIn: BotPrimaryCheckIn | null
}
export type BotPrimaryEnsureResult = {
  outcome: "created" | "present" | "hasMainBot" | "tombstoned" | "botLimit"
  state: BotPrimaryState
  botId: string | null
  conversationId: string | null
}
export const BOT_PRIMARY_CAPABILITY = "primary-bot-v1" as const
