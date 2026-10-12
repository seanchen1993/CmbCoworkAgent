import { z } from "zod"

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9:_-]+$/)
export const botDeleteSkillInput = z
  .object({
    nonce: id,
    botId: id,
    skillId: id,
    version: z.number().int().positive()
  })
  .strict()
export type BotDeleteSkillInput = z.infer<typeof botDeleteSkillInput>
export interface BotDeleteSkillReceipt {
  id: string
  version: number
  deletedAt: number
  affectedRoutineIds: string[]
  cancelledRunIds: string[]
  /** Cancellation requested; effects may still be collecting their result. */
  cancellingRunIds: string[]
  /** Existing uncertain effects require review and are never represented as cancelled. */
  reviewRunIds: string[]
  /** Cross-turn jobs whose origin may already be complete. Absent on older receipts. */
  stoppingServiceJobIds?: string[]
  /** Published snapshots are owned by the user library and are not withdrawn here. */
  retainedLibraryIds: string[]
}
