import { z } from "zod"
import { botComputerCheckpointId } from "./bot-computer-checkpoint"
const physical = z
  .object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) })
  .strict()
export const botComputerMaintenancePhase = z.enum([
  "capture",
  "verify",
  "prepare",
  "replace",
  "publish",
  "cleanup"
])
export const botComputerMaintenanceComponent = z.enum([
  "data",
  "shared",
  "browser",
  "managed",
  "control"
])
const progressBase = z
  .object({
    format: z.literal(1),
    // Private file and IPC only. Renderer receives the public projection below,
    // never owner/token paths. hostTokenSha256 binds a starting descriptor.
    owner: z
      .object({
        pid: z.number().int().positive(),
        hostTokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
        root: physical,
        lock: physical
      })
      .strict(),
    nonce: botComputerCheckpointId,
    operation: z.enum(["create", "restore", "startup-restore", "delete", "delete-recovery"]),
    phase: botComputerMaintenancePhase,
    component: botComputerMaintenanceComponent,
    activity: z.enum(["file-io", "native-sqlite", "git", "atomic-mutation"]),
    startedAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    // Each completed I/O chunk/traversal advances this private counter. Repeated
    // verification reads do not inflate the public bounded archive byte count.
    workSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    entries: z.number().int().nonnegative().max(50_000),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(20 * 1024 ** 3)
  })
  .strict()
const validTimes = (value: { startedAt: number; updatedAt: number }) =>
  value.updatedAt >= value.startedAt
export const botComputerMaintenanceProgress = progressBase.refine(validTimes)
export type BotComputerMaintenanceProgress = z.infer<typeof botComputerMaintenanceProgress>
export const botComputerMaintenancePublicProgress = progressBase
  .omit({ owner: true, format: true, workSequence: true })
  .refine(validTimes)
export type BotComputerMaintenancePublicProgress = z.infer<
  typeof botComputerMaintenancePublicProgress
>
export const BOT_COMPUTER_PROGRESS_MAX_BYTES = 4096
export const BOT_COMPUTER_MAINTENANCE_FRAME_BYTES = 16 * 1024
export const BOT_COMPUTER_PROGRESS_FLUSH_MS = 250
export const BOT_COMPUTER_PROGRESS_FRESH_MS = 10_000
export const BOT_COMPUTER_FILE_IDLE_MS = 2 * 60_000
export const BOT_COMPUTER_NATIVE_PHASE_MS = 2 * 60 * 60_000
export const BOT_COMPUTER_OPERATION_MS = 24 * 60 * 60_000
/** Activity/freshness proves a supervised phase is alive, not that bytes moved.
 * Count only increasing counters or a legitimate phase transition as file-I/O
 * progress. Native SQLite has no safe incremental quick_check/VACUUM callback:
 * supervise its one isolated child with a fixed phase deadline. No Store may
 * open and no "ready" descriptor may publish until the global journal is gone.
 */
