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
    expectedDataEpoch: z
      .string()
      .min(1)
      .max(160)
      .refine((value) => !value.includes("\0"))
      .optional(),
    botId: id,
    skillId: id,
    version: z.number().int().positive().safe(),
    inputs: text,
    criteria: text
  })
  .strict()
  .transform((value) => {
    if (value.expectedDataEpoch === undefined) delete value.expectedDataEpoch
    return value
  })
export type BotSkillTrialInput = z.infer<typeof botSkillTrialInput>

/** Read-only presentation of an existing trial; the original message remains the execution input. */
export const botSkillTrialMessage = z.object({
  id,
  skillId: id,
  name: z.string().min(1).max(100),
  version: z.number().int().positive().safe(),
  inputs: text,
  criteria: text
})
export type BotSkillTrialMessage = z.infer<typeof botSkillTrialMessage>
