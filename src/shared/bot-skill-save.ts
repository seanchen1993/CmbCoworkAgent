import { z } from "zod"

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => Boolean(value.trim()) && !value.includes("\0"))

/** Nonce is optional only for existing Teach/tool transactions that already own a durable receipt. */
export const botSaveSkillInputSchema = z
  .object({
    nonce: identifier.optional(),
    expectedDataEpoch: z
      .string()
      .min(1)
      .max(160)
      .refine((value) => !value.includes("\0"))
      .optional(),
    botId: identifier,
    id: identifier.optional(),
    version: z.number().int().positive().optional(),
    name: text(100),
    instructions: text(64_000),
    enabled: z.boolean(),
    scope: z.literal("user").optional()
  })
  .strict()
  .refine((input) => Boolean(input.id) === Boolean(input.version))
  .refine((input) => input.expectedDataEpoch === undefined || input.nonce !== undefined)
export type BotSaveSkillInput = Omit<z.infer<typeof botSaveSkillInputSchema>, "scope"> & {
  /** Internal BotSkill spreads are validated by the narrow save schema. */
  scope?: "bot" | "user" | "desktop"
}
export const botPendingSkillSaveSchema = botSaveSkillInputSchema.refine(
  (input) => input.nonce !== undefined && input.expectedDataEpoch !== undefined,
  "A pending skill save requires its original nonce"
)
export type BotPendingSkillSave = BotSaveSkillInput & {
  nonce: string
  expectedDataEpoch: string
}
