import { z } from "zod"
import type { BotModelUsageSummary } from "./bot-model-usage"

export const BOT_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000
export const botUsageBudgetAddress = z.object({ botId: z.string().uuid().nullable() }).strict()
export const botUsageBudgetChange = botUsageBudgetAddress
  .extend({
    nonce: z.string().min(1).max(160),
    dataEpoch: z.string().min(1).max(160),
    revision: z.number().int().nonnegative(),
    outputLimit: z.number().int().min(0).max(1_000_000_000).nullable()
  })
  .strict()
export type BotUsageBudgetAddress = z.infer<typeof botUsageBudgetAddress>
export type BotUsageBudgetChange = z.infer<typeof botUsageBudgetChange>
export interface BotUsageBudgetPolicy extends BotUsageBudgetAddress {
  revision: number
  outputLimit: number | null
}
export interface BotUsageBudgetView extends BotUsageBudgetPolicy {
  dataEpoch: string
  windowStart: number
  asOf: number
  available: number | null
  usage: BotModelUsageSummary
}
