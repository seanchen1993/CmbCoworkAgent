import { z } from "zod"
import {
  SAND_AUTO_REVIEW_INSTRUCTION_MAX_CHARS,
  SAND_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES
} from "./bot-auto-review-instructions"

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
const instructions = z
  .array(z.string().trim().min(1).max(SAND_AUTO_REVIEW_INSTRUCTION_MAX_CHARS))
  .max(SAND_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES)
export const botAutoReviewPolicy = z
  .object({
    isEnabled: z.boolean(),
    allowInstructions: instructions,
    blockInstructions: instructions
  })
  .strict()
export const botAutoReviewChange = botAutoReviewPolicy
  .extend({
    botId: id,
    revision: z.number().int().nonnegative(),
    nonce: id,
    dataEpoch: z.string().min(1).max(160)
  })
  .strict()
export type BotAutoReviewPolicy = z.infer<typeof botAutoReviewPolicy>
export type BotAutoReviewChange = z.infer<typeof botAutoReviewChange>
export interface BotAutoReviewSettings extends BotAutoReviewPolicy {
  botId: string
  revision: number
  dataEpoch: string
}
export interface BotAutoReviewResult {
  decision: "allow" | "ask"
  reason: string
  model: string | null
}
