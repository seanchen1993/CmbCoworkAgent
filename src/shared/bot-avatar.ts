import { z } from "zod"

export const BOT_AVATAR_EDGE = 256
export const BOT_AVATAR_BYTES = 320 * 1024
export const botAvatarBase64 = z
  .string()
  .min(4)
  .max(Math.ceil(BOT_AVATAR_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w:.-]+$/)
export const botAvatarAddress = z
  .object({
    botId: identifier,
    hash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
export const botAvatarChange = z
  .object({
    botId: identifier,
    nonce: identifier,
    expectedDataEpoch: z.string().min(1).max(160).optional(),
    revision: z.number().int().safe().positive(),
    pngBase64: botAvatarBase64.nullable()
  })
  .strict()
export type BotAvatarAddress = z.infer<typeof botAvatarAddress>
export type BotAvatarChange = z.infer<typeof botAvatarChange>
export interface BotAvatarChanged {
  botId: string
  revision: number
  hash: string | null
}
