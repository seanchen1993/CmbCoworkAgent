import { z } from "zod"

export const BOT_SKILL_MAINTENANCE_CAPABILITY = "skill-maintenance-v1"
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
const epoch = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => !value.includes("\0"))
const address = { botId: id, expectedDataEpoch: epoch }

export const botSkillMaintenanceAddress = z
  .object({ ...address, after: id.optional(), limit: z.number().int().min(1).max(100).default(50) })
  .strict()
export const botSkillMaintenancePolicyInput = z
  .object({
    ...address,
    nonce: id,
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    staleAfterDays: z.number().int().min(1).max(3650),
    archiveAfterDays: z.number().int().min(2).max(3650)
  })
  .strict()
  .refine((value) => value.archiveAfterDays > value.staleAfterDays, "归档天数必须大于检查天数")
export const botSkillMaintenanceChange = z
  .object({
    ...address,
    nonce: id,
    skillId: id,
    version: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    action: z.enum(["pin", "unpin", "manage", "unmanage", "archive", "restore"])
  })
  .strict()
export const botSkillMaintenanceRun = z.object({ ...address, nonce: id }).strict()

export type BotSkillMaintenanceAddress = z.input<typeof botSkillMaintenanceAddress>
export type BotSkillMaintenancePolicyInput = z.infer<typeof botSkillMaintenancePolicyInput>
export type BotSkillMaintenanceChange = z.infer<typeof botSkillMaintenanceChange>
export type BotSkillMaintenanceRun = z.infer<typeof botSkillMaintenanceRun>
export interface BotSkillMaintenancePolicy {
  revision: number
  enabled: boolean
  staleAfterDays: number
  archiveAfterDays: number
  lastRunAt: number | null
}
export interface BotSkillMaintenanceEntry {
  skillId: string
  version: number
  revision: number
  name: string
  managed: boolean
  pinned: boolean
  archived: boolean
  stale: boolean
  useCount: number
  lastUsedAt: number | null
  protectedReason: string | null
}
export interface BotSkillMaintenanceView {
  policy: BotSkillMaintenancePolicy
  entries: BotSkillMaintenanceEntry[]
  next: string | null
}
export interface BotSkillMaintenanceResult {
  archivedIds: string[]
  protectedIds: string[]
  checkedAt: number
  hasMore: boolean
}
