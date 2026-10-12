import { z } from "zod"

export const botRecipientIds = z
  .array(z.string().regex(/^[\w:.-]{1,160}$/))
  .max(6)
  .refine((ids) => new Set(ids).size === ids.length, "接收者不能重复")

/** Host-resolved names at send time; a later rename cannot rewrite message history. */
export const botRecipientReferences = z
  .array(z.object({ botId: z.string(), name: z.string().min(1).max(100) }).strict())
  .max(6)

export type BotRecipientReference = z.infer<typeof botRecipientReferences>[number]
