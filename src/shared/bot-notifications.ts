import { z } from "zod"

export const botNotificationChange = z
  .object({
    botId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    dataEpoch: z.string().min(1).max(160),
    enabled: z.boolean(),
    nonce: z.string().min(1).max(160)
  })
  .strict()
export type BotNotificationChange = z.infer<typeof botNotificationChange>
export interface BotNotificationSettings {
  botId: string
  revision: number
  enabled: boolean
}
