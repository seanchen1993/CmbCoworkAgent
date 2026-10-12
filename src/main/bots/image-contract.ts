import { z } from "zod"
import { BOT_FILE_BYTES } from "../../shared/bot-files"

export const BOT_IMAGE_BYTES = 1024 * 1024
export const BOT_IMAGE_PIXELS = 40_000_000
export const botImageRegion = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive()
})
export const botImageRequest = z.object({
  kind: z.literal("image"),
  bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength <= BOT_FILE_BYTES),
  region: botImageRegion.optional()
})
export const botImageResult = z
  .object({
    mime: z.literal("image/jpeg"),
    base64: z
      .string()
      .max(Math.ceil(BOT_IMAGE_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    width: z.number().int().min(1).max(2048),
    height: z.number().int().min(1).max(2048),
    originalWidth: z.number().int().positive().max(BOT_IMAGE_PIXELS),
    originalHeight: z.number().int().positive().max(BOT_IMAGE_PIXELS),
    region: botImageRegion
  })
  .refine(
    (view) =>
      view.originalWidth * view.originalHeight <= BOT_IMAGE_PIXELS &&
      view.region.x + view.region.width <= view.originalWidth &&
      view.region.y + view.region.height <= view.originalHeight &&
      Buffer.byteLength(view.base64, "base64") <= BOT_IMAGE_BYTES &&
      Buffer.from(view.base64, "base64").toString("base64") === view.base64,
    "图片视图尺寸或编码无效"
  )
export type BotImageRegion = z.infer<typeof botImageRegion>
export type BotImageResult = z.infer<typeof botImageResult>

export function isBotRasterImage(bytes: Buffer): boolean {
  return (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
    ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString()) ||
    (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP")
  )
}
