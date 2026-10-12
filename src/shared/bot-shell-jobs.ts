import { z } from "zod"
import type { BotRunAddress } from "./bot-run-history"

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w:.-]+$/)
export const botShellJobRead = z
  .object({
    conversationId: id,
    runId: id,
    threadRootId: id.optional(),
    jobId: z.string().uuid(),
    offset: z.number().int().min(0).max(262144).optional()
  })
  .strict()
export const botShellJobStop = botShellJobRead
  .omit({ offset: true })
  .extend({
    nonce: z.string().uuid(),
    dataEpoch: z.string().min(1).max(200),
    revision: z.number().int().min(1).safe()
  })
  .strict()
export type BotShellJobRead = z.infer<typeof botShellJobRead>
export type BotShellJobStop = z.infer<typeof botShellJobStop>
export const botShellJobStatus = z.enum([
  "queued",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "needs_review"
])
export interface BotShellJobView {
  /** Genuine Store scope; optional only for older Host versions. */
  dataEpoch?: string
  id: string
  address: BotRunAddress
  command: string
  keepAlive?: boolean
  reviewed?: boolean
  status: z.infer<typeof botShellJobStatus>
  revision: number
  createdAt: number
  updatedAt: number
  exitCode: number | null
  output: string
  truncated: boolean
  nextOffset: number | null
}
