// Electron's bundled Chromium can lag the user's Chrome. Use PDF.js's own
// compatibility build in both realms rather than adding app-wide polyfills.
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist"
import { PDF_PREVIEW_MAX_PAGES } from "./pdf-preview-geometry"

export type PdfPreviewRuntime = typeof import("pdfjs-dist")
export interface PdfPreviewDocument {
  runtime: PdfPreviewRuntime
  document: PDFDocumentProxy
  width: number
  height: number
}

let runtimePromise: Promise<PdfPreviewRuntime> | null = null
function loadRuntime(): Promise<PdfPreviewRuntime> {
  return (runtimePromise ??= import("pdfjs-dist/legacy/build/pdf.mjs")
    .then((runtime) => {
      runtime.GlobalWorkerOptions.workerSrc = workerUrl
      return runtime
    })
    .catch((error) => {
      runtimePromise = null
      throw error
    }))
}

/** The existing attachment loader has already verified bytes and identity.
 * No URL, document, page or worker is retained in a cross-file cache. */
export function openPdfPreview(
  sourceUrl: string,
  publish: (document: PdfPreviewDocument) => void,
  fail: (message: string) => void
): () => void {
  let cancelled = false
  let task: PDFDocumentLoadingTask | null = null
  const destroy = () => {
    const owned = task
    task = null
    if (owned) void owned.destroy().catch(() => {})
  }
  void loadRuntime()
    .then(async (runtime) => {
      if (cancelled) return
      // Relative asset roots work with both Vite HTTP and packaged file:// pages.
      const asset = (name: string) => new URL(`./pdfjs/${name}/`, document.baseURI).href
      task = runtime.getDocument({
        url: sourceUrl,
        cMapUrl: asset("cmaps"),
        cMapPacked: true,
        standardFontDataUrl: asset("standard_fonts"),
        wasmUrl: asset("wasm"),
        useWorkerFetch: false,
        enableXfa: false,
        disableAutoFetch: true,
        disableStream: true,
        canvasMaxAreaInBytes: 16 * 1024 * 1024,
        maxImageSize: 16 * 1024 * 1024
      })
      const doc = await task.promise
      if (cancelled) return
      if (
        !Number.isSafeInteger(doc.numPages) ||
        doc.numPages < 1 ||
        doc.numPages > PDF_PREVIEW_MAX_PAGES
      )
        throw new Error("PDF 页数超过预览范围，请保存原文件查看")
      const first = await doc.getPage(1)
      if (cancelled) return
      const size = first.getViewport({ scale: 1 })
      publish({ runtime, document: doc, width: size.width, height: size.height })
    })
    .catch((error) => {
      destroy()
      if (!cancelled)
        fail(
          error instanceof Error && error.name === "PasswordException"
            ? "此 PDF 需要密码，请保存原文件后打开"
            : error instanceof Error
              ? error.message
              : "PDF 无法预览，请保存原文件查看"
        )
    })
  return () => {
    cancelled = true
    destroy()
  }
}
