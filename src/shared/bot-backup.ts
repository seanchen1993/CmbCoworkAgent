import { z } from "zod"

export const BOT_BACKUP_LIMIT = 50
export const botBackupId = z.string().uuid()
export const botBackupSelection = z
  .object({
    id: botBackupId,
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
export const botBackupRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), nonce: botBackupId }).strict(),
  z
    .object({ action: z.literal("restore"), nonce: botBackupId, backup: botBackupSelection })
    .strict(),
  z.object({ action: z.literal("delete"), backup: botBackupSelection }).strict()
])
export type BotBackupRequest = z.infer<typeof botBackupRequest>
export interface BotBackupSummary {
  id: string
  sha256: string
  createdAt: number
  reason: "manual" | "before-restore" | "scheduled"
  schemaVersion: number
  files: number
  bytes: number
}
export interface BotBackupResult {
  action: BotBackupRequest["action"]
  backup?: BotBackupSummary
  safetyBackup?: BotBackupSummary
  recoveryCopy?: string
}
export const botBackupSummarySchema = z
  .object({
    id: botBackupId,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.number().int().nonnegative(),
    reason: z.enum(["manual", "before-restore", "scheduled"]),
    schemaVersion: z.number().int().positive(),
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative()
  })
  .strict()
/** Local data maintenance is deliberately separate from model-facing Host RPC. */
export const botBackupResult = z
  .object({
    action: z.enum(["create", "restore", "delete"]),
    backup: botBackupSummarySchema.optional(),
    safetyBackup: botBackupSummarySchema.optional(),
    recoveryCopy: botBackupId.optional()
  })
  .strict()
  .refine((result) => result.action !== "create" || !!result.backup)

export interface BotBackupAPI {
  list(): Promise<BotBackupSummary[]>
  execute(input: BotBackupRequest): Promise<BotBackupResult>
  reveal(): Promise<void>
}
