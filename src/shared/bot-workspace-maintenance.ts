import { z } from "zod"
import { botBrowserMaintenanceRequest } from "./bot-browser-maintenance"

// The existing maintenance action/receipt convention is shared; the two APIs
// have distinct channels, schemas and catalogs and cannot restore each other.
export const botWorkspaceMaintenanceRequest = botBrowserMaintenanceRequest
export type BotWorkspaceMaintenanceRequest = z.infer<typeof botWorkspaceMaintenanceRequest>
export const BOT_WORKSPACE_CHECKPOINT_LIMIT = 20
export const botWorkspaceCheckpointSchema = z
  .object({
    id: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.number().int().nonnegative(),
    reason: z.enum(["manual", "before-reset", "before-restore"]),
    platform: z.enum(["darwin", "win32", "linux"]),
    workspaceId: z.string().uuid(),
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative()
  })
  .strict()
export type BotWorkspaceCheckpoint = z.infer<typeof botWorkspaceCheckpointSchema>
export const botWorkspaceMaintenanceResult = z
  .object({
    action: z.enum(["create", "reset", "restore", "delete"]),
    checkpoint: botWorkspaceCheckpointSchema.optional(),
    safetyCheckpoint: botWorkspaceCheckpointSchema.optional(),
    recoveryCopy: z.string().uuid().optional()
  })
  .strict()
  .refine((result) => result.action !== "create" || !!result.checkpoint)
export type BotWorkspaceMaintenanceResult = z.infer<typeof botWorkspaceMaintenanceResult>
export interface BotWorkspaceMaintenanceAPI {
  list(): Promise<BotWorkspaceCheckpoint[]>
  execute(input: BotWorkspaceMaintenanceRequest): Promise<BotWorkspaceMaintenanceResult>
  /** Open the managed recovery location, never a renderer-supplied local path. */
  revealRecovery(): Promise<void>
}
