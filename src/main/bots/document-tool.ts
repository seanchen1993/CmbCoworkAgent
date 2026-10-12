import { extname } from "node:path"
import { ToolMessage } from "@langchain/core/messages"
import { BotDocumentReader } from "./document-reader"
import { isBotRasterImage, type BotImageRegion } from "./image-contract"

/** Shared rendering of already-authorized bytes. Callers retain the source/lease
 * checks; the parser never receives a filesystem capability or a secret path.
 */
export async function botDocumentToolContent(
  reader: BotDocumentReader,
  input: {
    name: string
    bytes: Buffer
    offset: number
    limit: number
    imageRegion?: BotImageRegion
    pdfPage?: number
    callId: string
  },
  signal: AbortSignal,
  check: () => void
): Promise<string | ToolMessage> {
  const { name, bytes, offset, limit, imageRegion, pdfPage, callId } = input
  check()
  if (pdfPage !== undefined) {
    const { image, ...page } = await reader.pdfPage(bytes, pdfPage, imageRegion, signal)
    check()
    const { base64, ...dimensions } = image
    return new ToolMessage({
      tool_call_id: callId,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            name,
            ...page,
            ...dimensions,
            note: "Visual PDF page, not extracted/OCR text. Inspect the image using vision. image_region coordinates use the rotated page at 96 dpi (originalWidth/originalHeight). Only this page/region is shown; use pdf_page for other pages. The source PDF is unchanged."
          })
        },
        { type: "image_url", image_url: { url: `data:${image.mime};base64,${base64}` } }
      ]
    })
  }
  if (isBotRasterImage(bytes)) {
    const view = await reader.image(bytes, imageRegion, signal)
    check()
    return new ToolMessage({
      tool_call_id: callId,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            name,
            originalWidth: view.originalWidth,
            originalHeight: view.originalHeight,
            region: view.region,
            width: view.width,
            height: view.height,
            note: "Bounded still-image view. Coordinates use the decoded original. Use image_region for small details; the downloadable original is unchanged. Animated images show one frame."
          })
        },
        { type: "image_url", image_url: { url: `data:${view.mime};base64,${view.base64}` } }
      ]
    })
  }
  if (imageRegion) throw new Error("PDF 局部图像需同时指定 pdf_page；文本读取请使用 offset/limit")
  if (
    [".pdf", ".docx", ".xlsx", ".xls", ".pptx", ".txt", ".md", ".csv"].includes(
      extname(name).toLowerCase()
    )
  ) {
    const result = await reader.read(name, bytes, offset, limit, signal)
    check()
    return JSON.stringify(result)
  }
  if (bytes.includes(0))
    throw new Error("此文件是二进制格式，需要相应文档解析工具；不能将其当作文本读取")
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error("文件不是 UTF-8 文本，需要转换或使用相应解析工具")
  }
  return JSON.stringify({
    name,
    offset,
    totalCharacters: text.length,
    text: text.slice(offset, offset + limit),
    hasMore: offset + limit < text.length
  })
}
