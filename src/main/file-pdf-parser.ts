import { dirname, join, sep } from "node:path"
import { createRequire } from "node:module"
import type { DocumentInitParameters, PDFDocumentProxy } from "pdfjs-dist/types/src/display/api"

/** Shared byte-only loader. Callers run parsing/rendering in a bounded worker. */
export async function withPdfDocument<T>(
  buffer: Buffer,
  read: (document: PDFDocumentProxy) => Promise<T>,
  options: Pick<DocumentInitParameters, "maxImageSize" | "CanvasFactory"> & {
    strictRendering?: boolean
  } = {}
): Promise<T> {
  if (!buffer.subarray(0, 1024).includes(Buffer.from("%PDF-")))
    throw new Error("文件不是有效的 PDF")
  const { getDocument, PDFWorker } = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const { strictRendering, ...documentOptions } = options
  // Keep PDF.js and its worker/assets external to the CJS application bundle.
  const root = dirname(createRequire(__filename).resolve("pdfjs-dist/package.json"))
  // PDF.js 6.3.289 can resolve a partial operator list after its stream failed,
  // and its image decoder publishes null instead of rejecting render(). Watch
  // the dedicated worker's public port so incomplete images are never returned
  // as successful views. No shared worker/session is intercepted.
  const worker = strictRendering ? new PDFWorker({ verbosity: 0 }) : undefined
  let renderFailure: Error | undefined
  const observe = (event: MessageEvent) => {
    const message = event.data
    if (!message || typeof message !== "object") return
    if (typeof message.stream === "number" && message.reason) {
      renderFailure = new Error("PDF 页面解析失败，无法提供完整图像；请修复或简化文档后重试")
    }
    const args = message.data
    if (
      Array.isArray(args) &&
      ((message.action === "obj" && args[2] === "Image" && args[3] === null) ||
        (message.action === "commonobj" && args[1] === "Image" && args[2] === null))
    )
      renderFailure = new Error("PDF 中的图片解码失败，无法提供完整页面；请修复文档后重试")
  }
  let task: ReturnType<typeof getDocument> | undefined
  try {
    if (worker) {
      await worker.promise
      worker.port.addEventListener("message", observe)
    }
    task = getDocument({
      data: Uint8Array.from(buffer),
      cMapUrl: join(root, "cmaps") + sep,
      cMapPacked: true,
      standardFontDataUrl: join(root, "standard_fonts") + sep,
      wasmUrl: join(root, "wasm") + sep,
      useWorkerFetch: false,
      useSystemFonts: false,
      disableFontFace: true,
      enableXfa: false,
      stopAtErrors: true,
      verbosity: 0,
      ...documentOptions,
      ...(worker ? { worker } : {})
    })
    const document = await task.promise
    if (document.numPages > 1000) throw new Error("PDF 超过 1000 页，请拆分后读取")
    const result = await read(document)
    if (renderFailure) throw renderFailure
    return result
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException")
      throw new Error("PDF 已加密，请提供解密后的文件")
    throw error
  } finally {
    try {
      await task?.destroy()
    } finally {
      worker?.port?.removeEventListener("message", observe)
      worker?.destroy()
    }
  }
}

export async function parsePdfText(buffer: Buffer, maxCharacters: number): Promise<string> {
  return withPdfDocument(buffer, async (document) => {
    const pages: string[] = []
    let characters = 0
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number)
      try {
        const { items } = await page.getTextContent()
        const text = items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
          .join("")
          .trim()
        const content = `## Page ${number}\n${text || "[本页没有可提取的文本；可能是扫描图片，需图像识别。]"}`
        characters += content.length + 2
        if (characters > maxCharacters) throw new Error("PDF 文本超过解析上限，请拆分后读取")
        pages.push(content)
      } finally {
        page.cleanup()
      }
    }
    return pages.join("\n\n")
  })
}
