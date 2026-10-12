import { z } from "zod"
import type { BotRunStatus } from "./bot-types"

export const BOT_ROUTINE_DISPATCH_CAPABILITY = "routine-dispatch-history-v1"
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
export const botRoutineDispatchRequest = z
  .object({
    botId: id,
    routineId: id,
    expectedDataEpoch: z
      .string()
      .min(1)
      .max(160)
      .refine((value) => !value.includes("\0")),
    before: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(50).default(20)
  })
  .strict()
export type BotRoutineDispatchRequest = z.input<typeof botRoutineDispatchRequest>
export interface BotRoutineDispatch {
  cursor: number
  dueAt: number
  nextAt: number | null
  recordedAt: number
  disposition: "triggered" | "coalesced" | "skipped"
  runId: string | null
  status: BotRunStatus | null
}
export interface BotRoutineDispatchHistory {
  items: BotRoutineDispatch[]
  next: number | null
}
