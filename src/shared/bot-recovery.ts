import { z } from "zod"

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
const note = z
  .string()
  .max(8000)
  .refine((value) => Boolean(value.trim()) && !value.includes("\0"))
const recovery = z.object({
  id,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  decision: z.enum(["resume", "cancel"]),
  note,
  effects: z
    .array(z.object({ id, outcome: z.enum(["succeeded", "failed"]), note }).strict())
    .max(500)
})
export const botRecoveryInput = recovery
  .extend({ nonce: id.optional(), dataEpoch: id.optional() })
  .strict()
  .refine((input) => (input.nonce === undefined) === (input.dataEpoch === undefined))
export const pendingBotRecovery = recovery.extend({ nonce: id, dataEpoch: id }).strict()
export type PendingBotRecovery = z.infer<typeof pendingBotRecovery>
