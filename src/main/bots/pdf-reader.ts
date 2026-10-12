import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas"
import { withPdfDocument } from "../file-pdf-parser"
import { BOT_IMAGE_BYTES, BOT_IMAGE_PIXELS } from "./image-contract"
import { botPdfRequest, botPdfResult, type BotPdfResult } from "./pdf-contract"

type Surface = { canvas: Canvas | null; context: SKRSContext2D | null }

/** Bound PDF.js temporary masks/pattern canvases as well as the output image.
 * This instance belongs to one document and is discarded with its process. */
class PdfCanvasFactory {
  private pixels = 0
  private reserve(width: number, height: number, previous = 0): void {
    const size = Math.ceil(width) * Math.ceil(height)
    if (
      !Number.isFinite(size) ||
      width <= 0 ||
      height <= 0 ||
      size > BOT_IMAGE_PIXELS ||
      this.pixels - previous + size > BOT_IMAGE_PIXELS
    )
      throw new Error("PDF 图像超出像素限额，请简化文档后读取")
    this.pixels += size - previous
  }
  create(width: number, height: number): Surface {
    this.reserve(width, height)
    const canvas = createCanvas(Math.ceil(width), Math.ceil(height))
    return { canvas, context: canvas.getContext("2d") }
  }
  reset(surface: Surface, width: number, height: number): void {
    if (!surface.canvas) throw new Error("PDF 画布已释放")
    this.reserve(width, height, surface.canvas.width * surface.canvas.height)
    surface.canvas.width = Math.ceil(width)
    surface.canvas.height = Math.ceil(height)
  }
  destroy(surface: Surface): void {
    if (!surface.canvas) return
    this.pixels -= surface.canvas.width * surface.canvas.height
    surface.canvas.width = surface.canvas.height = 0
    surface.canvas = null
    surface.context = null
  }
}

/** Render only the requested page/crop, never the whole PDF into one bitmap.
 * PDF scripts/actions/links are not run; the parser receives no source path. */
export async function prepareBotPdfPage(raw: unknown): Promise<BotPdfResult> {
  const input = botPdfRequest.parse(raw)
  return withPdfDocument(
    Buffer.from(input.bytes),
    async (document) => {
      if (input.page > document.numPages) throw new Error(`PDF 只有 ${document.numPages} 页`)
      const page = await document.getPage(input.page)
      try {
        // The same rotated 96-dpi coordinate system is reported for full pages and crops.
        const original = page.getViewport({ scale: 96 / 72 }),
          originalWidth = Math.ceil(original.width),
          originalHeight = Math.ceil(original.height)
        if (
          !Number.isFinite(originalWidth * originalHeight) ||
          originalWidth < 1 ||
          originalHeight < 1 ||
          originalWidth * originalHeight > BOT_IMAGE_PIXELS
        )
          throw new Error("PDF 页面尺寸超过 4000 万像素，请缩小页面后读取")
        const region = input.region ?? { x: 0, y: 0, width: originalWidth, height: originalHeight }
        if (region.x + region.width > originalWidth || region.y + region.height > originalHeight)
          throw new Error("PDF 区域超出页面范围")
        for (const edge of [2048, 1536, 1024]) {
          const scale = Math.min(1, edge / Math.max(region.width, region.height)),
            width = Math.max(1, Math.ceil(region.width * scale)),
            height = Math.max(1, Math.ceil(region.height * scale)),
            canvas = createCanvas(width, height)
          try {
            await page.render({
              // PDF.js's Node adapter uses this same native canvas implementation.
              canvas: canvas as unknown as HTMLCanvasElement,
              viewport: page.getViewport({ scale: (96 / 72) * scale }),
              transform: [1, 0, 0, 1, -region.x * scale, -region.y * scale],
              background: "#ffffff"
            }).promise
            const encoded = await canvas.encode("jpeg", 82)
            if (encoded.length <= BOT_IMAGE_BYTES)
              return botPdfResult.parse({
                page: input.page,
                pageCount: document.numPages,
                dpi: 96,
                image: {
                  mime: "image/jpeg",
                  base64: encoded.toString("base64"),
                  width,
                  height,
                  originalWidth,
                  originalHeight,
                  region
                }
              })
          } finally {
            canvas.width = canvas.height = 0
          }
        }
        throw new Error("PDF 页面无法在模型限额内编码，请选择较小区域")
      } finally {
        page.cleanup()
      }
    },
    { maxImageSize: BOT_IMAGE_PIXELS, CanvasFactory: PdfCanvasFactory, strictRendering: true }
  )
}
