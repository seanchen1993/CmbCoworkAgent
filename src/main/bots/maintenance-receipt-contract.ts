import { z } from "zod"
import {
  botBrowserCheckpointSchema,
  botBrowserMaintenanceRequest,
  botBrowserMaintenanceResult,
  type BotBrowserMaintenanceResult
} from "../../shared/bot-browser-maintenance"

/** Exactly the format previously written as both pending journal and completed
 * browser receipt. Keep one parser for recovery and migration. */
export const botBrowserMaintenanceJournal = z
  .object({
    format: z.literal(1),
    request: botBrowserMaintenanceRequest.transform((request, ctx) => {
      if (request.action === "reset" || request.action === "restore") return request
      ctx.addIssue({ code: "custom", message: "浏览器替换请求必须是恢复或重置" })
      return z.NEVER
    }),
    stage: z.string().uuid(),
    hadOriginal: z.boolean(),
    safetyCheckpoint: botBrowserCheckpointSchema.optional()
  })
  .strict()
  .refine((journal) => journal.hadOriginal === Boolean(journal.safetyCheckpoint))
export type BotBrowserMaintenanceJournal = z.infer<typeof botBrowserMaintenanceJournal>
export function browserMaintenanceJournalResult(
  journal: BotBrowserMaintenanceJournal
): BotBrowserMaintenanceResult {
  return botBrowserMaintenanceResult.parse({
    action: journal.request.action,
    ...(journal.safetyCheckpoint ? { safetyCheckpoint: journal.safetyCheckpoint } : {})
  })
}
export const botBrowserMaintenanceReceipt = z
  .union([
    z
      .object({ request: botBrowserMaintenanceRequest, result: botBrowserMaintenanceResult })
      .strict(),
    botBrowserMaintenanceJournal.transform((journal) => ({
      request: journal.request,
      result: browserMaintenanceJournalResult(journal)
    }))
  ])
  .refine((receipt) => receipt.request.action === receipt.result.action)

import {
  botWorkspaceMaintenanceRequest,
  botWorkspaceMaintenanceResult
} from "../../shared/bot-workspace-maintenance"
export const botWorkspaceMaintenanceReceipt = z
  .object({ request: botWorkspaceMaintenanceRequest, result: botWorkspaceMaintenanceResult })
  .strict()
  .refine((receipt) => receipt.request.action === receipt.result.action)
