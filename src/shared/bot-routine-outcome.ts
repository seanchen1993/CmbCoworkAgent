import { z } from "zod"

const id = z.string().regex(/^[\w:.-]{1,160}$/)

/** Host-confirmed saved state. A display address never grants execution authority. */
export const botRoutineSaveOutcome = z
  .object({
    version: z.literal(1),
    operation: z.enum(["create", "update"]),
    id,
    botId: id,
    name: z.string().min(1).max(100),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    dataEpoch: z.string().min(1).max(160)
  })
  .strict()
export type BotRoutineSaveOutcome = z.infer<typeof botRoutineSaveOutcome>
