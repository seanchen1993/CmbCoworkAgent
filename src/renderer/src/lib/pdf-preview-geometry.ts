/** Adapted from Grok's bounded PDF raster calculation; each mounted canvas is
 * capped separately and leaves the viewport when Cmb's virtual list unmounts it. */
export const PDF_PREVIEW_MAX_PIXELS = 4 * 1024 * 1024
const MAX_CANVAS_SIDE = 8192
export const PDF_PREVIEW_MAX_PAGES = 10_000

export function pdfPreviewRaster(width: number, height: number, scale: number, pixelRatio: number) {
  if (![width, height, scale].every((value) => Number.isFinite(value) && value > 0))
    throw new Error("PDF 页面尺寸无效")
  if (!Number.isFinite(width * height)) throw new Error("PDF 页面尺寸无效")
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? Math.min(2, pixelRatio) : 1
  const rasterScale = Math.min(
    scale * ratio,
    Math.sqrt(PDF_PREVIEW_MAX_PIXELS / (width * height)),
    MAX_CANVAS_SIDE / width,
    MAX_CANVAS_SIDE / height
  )
  return {
    scale: rasterScale,
    width: Math.max(1, Math.floor(width * rasterScale)),
    height: Math.max(1, Math.floor(height * rasterScale))
  }
}

export function pdfPreviewPage(value: string, pageCount: number): number | null {
  if (!/^\d+$/.test(value.trim()) || pageCount < 1) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? Math.min(pageCount, Math.max(1, number)) : null
}
