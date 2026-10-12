import { z } from "zod"

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
const text = z
  .string()
  .min(1)
  .max(8000)
  .refine((value) => !!value.trim() && !value.includes("\0"))
export const botSkillTrialInput = z
  .object({
    nonce: id,
    botId: id,
    skillId: id,
    version: z.number().int().positive().safe(),
    inputs: text,
    criteria: text
  })
  .strict()
export type BotSkillTrialInput = z.infer<typeof botSkillTrialInput>
