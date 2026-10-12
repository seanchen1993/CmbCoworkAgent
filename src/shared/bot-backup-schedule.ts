import { z } from "zod"
import { botBackupId, botBackupSummarySchema } from "./bot-backup"

const timestamp = z.number().int().nonnegative().nullable()
export const botBackupScheduleChange = z
  .object({
    nonce: botBackupId,
    dataEpoch: z.string().min(1).max(128),
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    intervalHours: z.number().int().min(1).max(168)
  })
  .strict()
export type BotBackupScheduleChange = z.infer<typeof botBackupScheduleChange>
export const botBackupScheduleState = z
  .object({
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    intervalHours: z.number().int().min(1).max(168),
    nextAt: timestamp,
    pendingId: botBackupId.nullable(),
    lastAttemptAt: timestamp,
    retryAt: timestamp,
    lastBackup: botBackupSummarySchema.nullable(),
    error: z.string().max(2000).nullable()
  })
  .strict()
export type BotBackupScheduleState = z.infer<typeof botBackupScheduleState>
export interface BotBackupScheduleView extends BotBackupScheduleState {
  dataEpoch: string
  running: boolean
  available: boolean
}
export const initialBotBackupSchedule: BotBackupScheduleState = {
  revision: 0,
  enabled: false,
  intervalHours: 24,
  nextAt: null,
  pendingId: null,
  lastAttemptAt: null,
  retryAt: null,
  lastBackup: null,
  error: null
}
