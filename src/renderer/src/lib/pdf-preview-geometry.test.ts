import { expect, it } from "vitest"
import { PDF_PREVIEW_MAX_PIXELS, pdfPreviewPage, pdfPreviewRaster } from "./pdf-preview-geometry"

it("bounds oversized pages and high-DPI zoom without dropping below valid canvas dimensions", () => {
  for (const [width, height] of [
    [595, 842],
    [30_000, 50_000],
    [1, 100_000]
  ]) {
    const value = pdfPreviewRaster(width, height, 4, 3)
    expect(value.width * value.height).toBeLessThanOrEqual(PDF_PREVIEW_MAX_PIXELS)
    expect(Math.max(value.width, value.height)).toBeLessThanOrEqual(8192)
    expect(Math.min(value.width, value.height)).toBeGreaterThanOrEqual(1)
  }
  expect(() => pdfPreviewRaster(Infinity, 30, 1, 1)).toThrow()
  expect(() => pdfPreviewRaster(30, -1, 1, 1)).toThrow()
})

it("page entry accepts only an integer and clamps to an existing page", () => {
  expect(pdfPreviewPage(" 3 ", 10)).toBe(3)
  expect(pdfPreviewPage("0", 10)).toBe(1)
  expect(pdfPreviewPage("30", 10)).toBe(10)
  for (const value of ["", "x", "1.5", "1e2", "9007199254740992"])
    expect(pdfPreviewPage(value, 10)).toBeNull()
})
