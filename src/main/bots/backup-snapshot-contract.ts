import { isAbsolute } from "node:path"
import { z } from "zod"
import { botBackupId, botBackupSummarySchema } from "../../shared/bot-backup"

export const botSnapshotRequest = z
  .object({
    directory: z.string().min(1).max(4096).refine(isAbsolute),
    nonce: botBackupId,
    hostId: z.string().uuid()
  })
  .strict()

/** A withdrawn snapshot is a terminal occurrence, not a transient I/O failure.
 * This private worker result preserves that distinction without error-text matching. */
export const botSnapshotResult = z.union([
  botBackupSummarySchema,
  z.object({ status: z.literal("deleted"), id: botBackupId }).strict()
])
