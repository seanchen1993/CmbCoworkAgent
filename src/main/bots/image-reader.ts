import { imageSize } from "image-size"
import { createCanvas, loadImage } from "@napi-rs/canvas"
import {
  BOT_IMAGE_BYTES,
  BOT_IMAGE_PIXELS,
  botImageRequest,
  botImageResult,
  type BotImageResult,
  isBotRasterImage
} from "./image-contract"

/** Byte-only worker code. Header inspection bounds allocation before native decode. */
export async function prepareBotImage(input: unknown): Promise<BotImageResult> {
  const request = botImageRequest.parse(input),
    bytes = Buffer.from(request.bytes)
  if (!isBotRasterImage(bytes)) throw new Error("仅支持 PNG、JPEG、GIF 和 WebP 图片")
  const dimensions = imageSize(bytes)
  if (
    !dimensions.width ||
    !dimensions.height ||
    dimensions.width * dimensions.height > BOT_IMAGE_PIXELS
  )
    throw new Error("图片像素超过 4000 万，请缩小图片后再读取")
  const original = await loadImage(bytes)
  if (!original.width || !original.height || original.width * original.height > BOT_IMAGE_PIXELS)
    throw new Error("图片解码尺寸无效")
  const region = request.region ?? { x: 0, y: 0, width: original.width, height: original.height }
  if (region.x + region.width > original.width || region.y + region.height > original.height)
    throw new Error("图片区域超出原图范围")
  // A bounded model view keeps full-resolution file bytes out of graph checkpoints.
  // The immutable original remains downloadable; region reads preserve small text.
  for (const edge of [2048, 1536, 1024]) {
    const scale = Math.min(1, edge / Math.max(region.width, region.height))
    const width = Math.max(1, Math.round(region.width * scale)),
      height = Math.max(1, Math.round(region.height * scale))
    const canvas = createCanvas(width, height),
      context = canvas.getContext("2d")
    context.fillStyle = "#ffffff"
    context.fillRect(0, 0, width, height)
    context.drawImage(
      original,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      width,
      height
    )
    const encoded = await canvas.encode("jpeg", 82)
    if (encoded.length <= BOT_IMAGE_BYTES)
      return botImageResult.parse({
        mime: "image/jpeg",
        base64: encoded.toString("base64"),
        width,
        height,
        originalWidth: original.width,
        originalHeight: original.height,
        region
      })
  }
  throw new Error("图片无法在模型限额内编码，请选择较小区域")
}
