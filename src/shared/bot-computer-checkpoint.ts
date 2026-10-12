import { z } from "zod"
import type { BotComputerMaintenancePublicProgress } from "./bot-computer-maintenance-progress"

export const BOT_COMPUTER_CHECKPOINT_LIMIT = 20
export const BOT_COMPUTER_RECOVERY_COPY_LIMIT = 5
export const botComputerCheckpointId = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase())
export const botComputerCheckpointHash = z.string().regex(/^[a-f0-9]{64}$/)
export const botComputerCheckpointSelection = z
  .object({
    id: botComputerCheckpointId,
    sha256: botComputerCheckpointHash
  })
  .strict()
export const botComputerCheckpointRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), nonce: botComputerCheckpointId }).strict(),
  z
    .object({
      action: z.literal("restore"),
      nonce: botComputerCheckpointId,
      checkpoint: botComputerCheckpointSelection
    })
    .strict(),
  z.object({ action: z.literal("delete"), checkpoint: botComputerCheckpointSelection }).strict()
])
export const botComputerCheckpointSummary = z
  .object({
    id: botComputerCheckpointId,
    sha256: botComputerCheckpointHash,
    createdAt: z.number().int().nonnegative(),
    platform: z.enum(["darwin", "win32", "linux"]),
    files: z.number().int().nonnegative().max(50_000),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(20 * 1024 ** 3),
    data: z.enum(["absent", "established"]),
    shared: z.enum(["absent", "established"]),
    browser: z.enum(["absent", "established"]),
    managedGit: z
      .object({
        complete: z.number().int().nonnegative().max(2048),
        filesOnly: z.number().int().nonnegative().max(2048)
      })
      .strict()
  })
  .strict()
export const botComputerCheckpointRestoreResult = z
  .object({
    action: z.literal("restore"),
    checkpoint: botComputerCheckpointSelection,
    recoveryCopy: botComputerCheckpointId,
    restartRequired: z.literal(true),
    reviewRequired: z.literal(true)
  })
  .strict()
export const botComputerCheckpointResult = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), checkpoint: botComputerCheckpointSummary }).strict(),
  z.object({ action: z.literal("delete") }).strict(),
  botComputerCheckpointRestoreResult
])
export type BotComputerCheckpointRequest = z.infer<typeof botComputerCheckpointRequest>
export type BotComputerCheckpointSummary = z.infer<typeof botComputerCheckpointSummary>
export type BotComputerCheckpointResult = z.infer<typeof botComputerCheckpointResult>
export const botComputerDeliverablesSummary = z
  .object({
    id: botComputerCheckpointId,
    checkpoint: botComputerCheckpointSelection,
    projects: z.number().int().min(1).max(2048)
  })
  .strict()
export type BotComputerDeliverablesSummary = z.infer<typeof botComputerDeliverablesSummary>
export interface BotComputerCheckpointAPI {
  deliverables(): Promise<BotComputerDeliverablesSummary[]>
  progress(): Promise<BotComputerMaintenancePublicProgress | null>
  list(): Promise<BotComputerCheckpointSummary[]>
  recoveryCopies(): Promise<
    { id: string; sha256: string; checkpoint: z.infer<typeof botComputerCheckpointSelection> }[]
  >
  deleteRecovery(selection: z.infer<typeof botComputerCheckpointSelection>): Promise<void>
  execute(input: BotComputerCheckpointRequest): Promise<BotComputerCheckpointResult>
  revealRecovery(recoveryCopy: string): Promise<void>
  revealDeliverables(recoveryCopy: string): Promise<void>
}
