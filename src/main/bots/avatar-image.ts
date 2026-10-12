import { imageSize } from "image-size"
import { createCanvas, loadImage } from "@napi-rs/canvas"
import { BOT_AVATAR_EDGE, BOT_AVATAR_BYTES, botAvatarBase64 } from "../../shared/bot-avatar"

/** Runs in the existing disposable media worker. Only a bounded 256px PNG reaches storage. */
export async function prepareBotAvatar(value: unknown): Promise<string> {
  const base64 = botAvatarBase64.parse(value)
  const bytes = Buffer.from(base64, "base64")
  if (
    bytes.length > BOT_AVATAR_BYTES ||
    bytes.toString("base64") !== base64 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("头像必须是裁剪后的 PNG 图片")
  const size = imageSize(bytes)
  if (size.width !== BOT_AVATAR_EDGE || size.height !== BOT_AVATAR_EDGE)
    throw new Error("头像尺寸必须为 256 × 256")
  const original = await loadImage(bytes)
  if (original.width !== BOT_AVATAR_EDGE || original.height !== BOT_AVATAR_EDGE)
    throw new Error("头像解码尺寸无效")
  const canvas = createCanvas(BOT_AVATAR_EDGE, BOT_AVATAR_EDGE)
  canvas.getContext("2d").drawImage(original, 0, 0)
  const png = await canvas.encode("png")
  if (png.length > BOT_AVATAR_BYTES) throw new Error("头像超过大小限制")
  return png.toString("base64")
}
