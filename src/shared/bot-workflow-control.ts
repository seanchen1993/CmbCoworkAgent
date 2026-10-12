import { z } from "zod"
import type { BotRunStatus } from "./bot-types"

const address = {
  conversationId: z.string().min(1).max(160),
  runId: z.string().min(1).max(160),
  threadRootId: z.string().min(1).max(160).optional(),
  nonce: z.string().min(1).max(160),
  expectedDataEpoch: z.string().min(1).max(160).optional(),
  revision: z.number().int().positive()
}
export const botWorkflowControl = z.discriminatedUnion("operation", [
  z
    .object({
      ...address,
      operation: z.literal("message"),
      text: z.string().trim().min(1).max(32_000)
    })
    .strict(),
  z.object({ ...address, operation: z.literal("cancel") }).strict()
])
export type BotWorkflowControl = z.infer<typeof botWorkflowControl>
export interface BotWorkflowControlReceipt {
  runId: string
  status: BotRunStatus
  messageId?: string
}
