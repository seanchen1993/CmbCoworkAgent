import { imageSize } from "image-size"
import { botLinkPreviewImage, type BotLinkPreviewImage } from "../../shared/bot-link-preview"
import { isBotRasterImage } from "./image-contract"
import { BotUtilityProcess, type BotUtilityLauncher } from "./utility-process"

/** Decode at most one raster frame: a per-frame pixel cap alone does not bound animation work. */
function isSingleFrameRaster(bytes: Buffer, type: string): boolean {
  if (type === "png") {
    for (let offset = 8; offset < bytes.length; ) {
      if (offset + 12 > bytes.length) return false
      const length = bytes.readUInt32BE(offset),
        end = offset + length + 12
      if (end > bytes.length || bytes.toString("ascii", offset + 4, offset + 8) === "acTL")
        return false
      offset = end
    }
    return true
  }
  if (type === "webp") {
    for (let offset = 12; offset < bytes.length; ) {
      if (offset + 8 > bytes.length) return false
      const tag = bytes.toString("ascii", offset, offset + 4),
        length = bytes.readUInt32LE(offset + 4),
        end = offset + 8 + length + (length % 2)
      if (
        end > bytes.length ||
        tag === "ANIM" ||
        tag === "ANMF" ||
        (tag === "VP8X" && length > 0 && (bytes[offset + 8] & 2) !== 0)
      )
        return false
      offset = end
    }
    return true
  }
  if (type !== "gif") return true
  if (bytes.length < 13) return false
  let offset = 13 + (bytes[10] & 128 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0),
    frames = 0
  const skipBlocks = () => {
    while (offset < bytes.length) {
      const length = bytes[offset++]
      if (length === 0) return true
      if (offset + length > bytes.length) return false
      offset += length
    }
    return false
  }
  while (offset < bytes.length) {
    const kind = bytes[offset++]
    if (kind === 0x3b) return frames === 1
    if (kind === 0x21) {
      if (offset >= bytes.length) return false
      offset++
      if (!skipBlocks()) return false
      continue
    }
    if (kind !== 0x2c || offset + 9 > bytes.length || ++frames > 1) return false
    const width = bytes.readUInt16LE(offset + 4),
      height = bytes.readUInt16LE(offset + 6),
      flags = bytes[offset + 8]
    if (!width || !height || width * height > 1_000_000) return false
    offset += 9 + (flags & 128 ? 3 * (1 << ((flags & 7) + 1)) : 0)
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) return false
    offset++
    if (!skipBlocks()) return false
  }
  return false
}

export function previewImageHeader(bytes: Buffer, mime: string): boolean {
  if (!bytes.length || bytes.length > 512 * 1024 || !isBotRasterImage(bytes)) return false
  try {
    const size = imageSize(bytes)
    return (
      isSingleFrameRaster(bytes, size.type ?? "") &&
      size.width > 0 &&
      size.height > 0 &&
      size.width <= 2048 &&
      size.height <= 2048 &&
      size.width * size.height <= 1_000_000 &&
      (
        {
          png: "image/png",
          jpg: "image/jpeg",
          webp: "image/webp",
          gif: "image/gif"
        } as Record<string, string>
      )[size.type ?? ""] === mime
    )
  } catch {
    return false
  }
}
/** Byte-only existing utility-worker branch: the renderer receives a new JPEG, never origin bytes. */
export async function prepareBotLinkPreviewImage(input: {
  bytes: Uint8Array
  mime: string
}): Promise<BotLinkPreviewImage> {
  const bytes = Buffer.from(input.bytes)
  if (!previewImageHeader(bytes, input.mime)) throw new Error("Unsupported preview raster")
  const { createCanvas, loadImage } = await import("@napi-rs/canvas")
  const decoded = await loadImage(bytes)
  if (!decoded.width || !decoded.height || decoded.width * decoded.height > 1_000_000)
    throw new Error("Preview decode limit")
  for (const edge of [480, 320]) {
    const scale = Math.min(1, edge / Math.max(decoded.width, decoded.height))
    const width = Math.max(1, Math.round(decoded.width * scale)),
      height = Math.max(1, Math.round(decoded.height * scale))
    const canvas = createCanvas(width, height),
      context = canvas.getContext("2d")
    context.fillStyle = "#ffffff"
    context.fillRect(0, 0, width, height)
    context.drawImage(decoded, 0, 0, width, height)
    const jpeg = await canvas.encode("jpeg", 75)
    if (jpeg.length <= 128 * 1024)
      return botLinkPreviewImage.parse({
        mime: "image/jpeg",
        base64: jpeg.toString("base64"),
        width,
        height
      })
  }
  throw new Error("Preview encoding limit")
}
export class BotLinkPreviewImageReader {
  private readonly worker: BotUtilityProcess
  constructor(launcher: BotUtilityLauncher) {
    this.worker = new BotUtilityProcess(launcher, "链接预览图片", 4000)
  }
  async render(
    bytes: Buffer,
    mime: string,
    signal: AbortSignal
  ): Promise<BotLinkPreviewImage | null> {
    if (!previewImageHeader(bytes, mime)) return null
    return this.worker.invoke(
      { kind: "link-preview-image", bytes, mime },
      (value) => botLinkPreviewImage.parse(value),
      signal
    )
  }
}
