import { z } from "zod"

export const BOT_BROWSER_CHECKPOINT_LIMIT = 20
const id = z.string().uuid()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
export const botBrowserCheckpointSelection = z.object({ id, sha256 }).strict()
export const botBrowserMaintenanceRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), nonce: id }).strict(),
  z.object({ action: z.literal("reset"), nonce: id }).strict(),
  z
    .object({ action: z.literal("restore"), nonce: id, checkpoint: botBrowserCheckpointSelection })
    .strict(),
  z.object({ action: z.literal("delete"), checkpoint: botBrowserCheckpointSelection }).strict()
])
export const botBrowserCheckpointSchema = z
  .object({
    id,
    sha256,
    createdAt: z.number().int().nonnegative(),
    reason: z.enum(["manual", "before-reset", "before-restore"]),
    platform: z.enum(["darwin", "win32", "linux"]),
    browser: z.enum(["chrome", "msedge"]),
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative()
  })
  .strict()
export type BotBrowserCheckpoint = z.infer<typeof botBrowserCheckpointSchema>
export type BotBrowserMaintenanceRequest = z.infer<typeof botBrowserMaintenanceRequest>
export interface BotBrowserMaintenanceResult {
  action: BotBrowserMaintenanceRequest["action"]
  checkpoint?: BotBrowserCheckpoint
  safetyCheckpoint?: BotBrowserCheckpoint
}
export const botBrowserMaintenanceResult = z
  .object({
    action: z.enum(["create", "reset", "restore", "delete"]),
    checkpoint: botBrowserCheckpointSchema.optional(),
    safetyCheckpoint: botBrowserCheckpointSchema.optional()
  })
  .strict()
  .refine((result) => result.action !== "create" || !!result.checkpoint)
/** Desktop-owned offline maintenance; deliberately unavailable to model tools. */
export interface BotBrowserMaintenanceAPI {
  list(): Promise<BotBrowserCheckpoint[]>
  execute(input: BotBrowserMaintenanceRequest): Promise<BotBrowserMaintenanceResult>
}
