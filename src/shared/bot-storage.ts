import { z } from "zod"

export const botStorageLevel = z.enum(["healthy", "soft", "hard"])
export type BotStorageLevel = z.infer<typeof botStorageLevel>
export const botVolumeSample = z
  .object({
    volume: z.string().min(1).max(300),
    deviceId: z.string().min(1).max(100),
    totalBytes: z.number().int().positive().safe(),
    availableBytes: z.number().int().nonnegative().safe()
  })
  .strict()
  .refine((value) => value.availableBytes <= value.totalBytes)
export interface BotStorageStatus {
  checkedAt: number | null
  complete: boolean
  level: BotStorageLevel | "unknown"
  volumes: {
    name: string
    totalBytes: number
    availableBytes: number
    level: BotStorageLevel
    sampledAt: number
  }[]
}
