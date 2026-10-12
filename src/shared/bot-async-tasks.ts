import { z } from "zod"
import type { BotRunAddress } from "./bot-run-history"
import type { BotRunStatus } from "./bot-types"

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w:.-]+$/)
export const botAsyncTasksRequest = z
  .object({
    botId: id,
    before: z
      .object({ botId: id, at: z.number().int().nonnegative().safe(), key: id })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(40).optional()
  })
  .strict()
export type BotAsyncTasksRequest = z.infer<typeof botAsyncTasksRequest>
export interface BotAsyncTask {
  key: string
  kind: "child" | "workflow" | "shell"
  jobId?: string
  label: string
  phase: string | null
  status: BotRunStatus
  createdAt: number
  updatedAt: number
  address: BotRunAddress
}
export interface BotAsyncTasksPage {
  items: BotAsyncTask[]
  next: NonNullable<BotAsyncTasksRequest["before"]> | null
}
