import { useEffect, useRef, useState } from "react"
import { Virtuoso, type VirtuosoHandle, type ListItem } from "react-virtuoso"
import { ChevronLeft, ChevronRight, FileText, Loader2, Minus, Plus, Scan } from "lucide-react"
import type { PDFPageProxy, RenderTask, TextLayer } from "pdfjs-dist"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { openPdfPreview, type PdfPreviewDocument } from "@/lib/pdf-preview-runtime"
import { pdfPreviewPage, pdfPreviewRaster } from "@/lib/pdf-preview-geometry"
import "./bot-pdf-preview.css"

function PdfPage({
  value,
  number,
  scale
}: {
  value: PdfPreviewDocument
  number: number
  scale: number
}) {
  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: value.width, height: value.height })
  const [state, setState] = useState<{
    scale: number
    error: string | null
    ready: boolean
  } | null>(null)
  useEffect(() => {
    const target = stage.current
    if (!target) return
    let disposed = false
    let page: PDFPageProxy | null = null
    let render: RenderTask | null = null
    let text: TextLayer | null = null
    const canvas = document.createElement("canvas")
    canvas.setAttribute("aria-hidden", "true")
    const layer = document.createElement("div")
    layer.className = "bot-pdf-text"
    target.append(canvas, layer)
    const draw = async () => {
      page = await value.document.getPage(number)
      if (disposed) return
      const base = page.getViewport({ scale: 1 })
      setSize((previous) =>
        previous.width === base.width && previous.height === base.height
          ? previous
          : { width: base.width, height: base.height }
      )
      const raster = pdfPreviewRaster(base.width, base.height, scale, window.devicePixelRatio)
      canvas.width = raster.width
      canvas.height = raster.height
      const context = canvas.getContext("2d")
      if (!context) throw new Error("无法绘制 PDF 页面")
      render = page.render({
        canvas,
        canvasContext: context,
        viewport: page.getViewport({ scale: raster.scale })
      })
      const viewport = page.getViewport({ scale })
      // PDF.js 6 uses CSS variables for selectable text geometry.
      layer.style.setProperty("--total-scale-factor", String(viewport.scale * viewport.userUnit))
      text = new value.runtime.TextLayer({
        container: layer,
        textContentSource: page.streamTextContent(),
        viewport
      })
      const results = await Promise.allSettled([render.promise, text.render()])
      if (disposed) return
      if (results[0].status === "rejected") throw results[0].reason
      setState({ scale, error: null, ready: true })
    }
    void draw()
      .catch((error) => {
        if (!disposed)
          setState({
            scale,
            ready: false,
            error: error instanceof Error ? error.message : "此页无法预览"
          })
      })
      .finally(() => {
        if (disposed) {
          canvas.width = canvas.height = 0
          page?.cleanup()
        }
      })
    return () => {
      disposed = true
      render?.cancel()
      text?.cancel()
      canvas.remove()
      layer.remove()
      // A detached canvas must not retain a full-page bitmap between files.
      canvas.width = canvas.height = 0
      page?.cleanup()
    }
  }, [value, number, scale])
  const current = state?.scale === scale ? state : null
  return (
    <div className="bot-pdf-row" style={{ minWidth: size.width * scale + 32 }}>
      <div
        className="bot-pdf-page"
        aria-label={`第 ${number} 页`}
        style={{ width: size.width * scale, height: size.height * scale }}
      >
        <div ref={stage} className="bot-pdf-stage" />
        {!current?.ready && (
          <div className="bot-pdf-page-status" role={current?.error ? "alert" : "status"}>
            {current?.error ?? (
              <Loader2
                className="size-5 animate-spin motion-reduce:animate-none"
                aria-label="正在绘制页面"
              />
            )}
          </div>
        )}
        <span className="bot-pdf-page-number" aria-hidden="true">
          {number}
        </span>
      </div>
    </div>
  )
}

function OpenPdf({ sourceUrl, onDownload }: { sourceUrl: string; onDownload(): void }) {
  const [value, setValue] = useState<PdfPreviewDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState<number | null>(null)
  const [width, setWidth] = useState(0)
  const [page, setPage] = useState(1)
  const [draft, setDraft] = useState<string | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const list = useRef<VirtuosoHandle>(null)
  const scroller = useRef<HTMLElement | null>(null)
  const items = useRef<ListItem<unknown>[]>([])
  useEffect(() => openPdfPreview(sourceUrl, setValue, setError), [sourceUrl])
  useEffect(() => {
    const element = body.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const scale =
    zoom ?? (value && width > 0 ? Math.max(0.1, Math.min(1, (width - 48) / value.width)) : 1)
  const total = value?.document.numPages ?? 0
  const updateVisiblePage = () => {
    if (!scroller.current) return
    const top = scroller.current.scrollTop + 12
    const visible = items.current.find((item) => item.offset + item.size > top)
    if (visible) setPage(visible.index + 1)
  }
  const go = (number: number) => {
    list.current?.scrollToIndex({ index: number - 1, align: "start", behavior: "auto" })
    setPage(number)
    setDraft(null)
  }
  const commit = () => {
    const number = pdfPreviewPage(draft ?? String(page), total)
    if (number !== null) go(number)
    else setDraft(null)
  }
  return (
    <div className="bot-pdf-preview">
      <div className="bot-pdf-toolbar" aria-label="PDF 阅读工具">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="上一页"
            title="上一页"
            disabled={!value || page <= 1}
            onClick={() => go(page - 1)}
          >
            <ChevronLeft size={17} />
          </Button>
          <Input
            aria-label="页码"
            inputMode="numeric"
            className="h-7 w-12 px-1 text-center text-xs"
            disabled={!value}
            value={draft ?? String(page)}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commit()
              }
              if (event.key === "Escape") {
                event.stopPropagation()
                setDraft(null)
              }
            }}
          />
          <span
            className="min-w-8 text-xs tabular-nums text-muted-foreground"
            aria-label={`共 ${total} 页`}
          >
            / {total || "—"}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="下一页"
            title="下一页"
            disabled={!value || page >= total}
            onClick={() => go(page + 1)}
          >
            <ChevronRight size={17} />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="缩小"
            title="缩小"
            disabled={!value || scale <= 0.25}
            onClick={() => setZoom(Math.max(0.25, scale - 0.25))}
          >
            <Minus size={17} />
          </Button>
          <span className="min-w-11 text-center text-xs tabular-nums" aria-label="缩放比例">
            {Math.round(scale * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="放大"
            title="放大"
            disabled={!value || scale >= 4}
            onClick={() => setZoom(Math.min(4, scale + 0.25))}
          >
            <Plus size={17} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="自动缩放"
            title="自动缩放"
            disabled={!value}
            onClick={() => setZoom(null)}
          >
            <Scan size={17} />
          </Button>
        </div>
      </div>
      <div className="bot-pdf-body" ref={body}>
        {error ? (
          <div className="bot-pdf-status" role="alert">
            <FileText className="size-9 opacity-50" />
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={onDownload}>
              保存原文件
            </Button>
          </div>
        ) : !value ? (
          <div className="bot-pdf-status" role="status">
            <Loader2 className="size-5 animate-spin motion-reduce:animate-none" />
            <p>正在打开 PDF…</p>
          </div>
        ) : (
          <Virtuoso
            ref={list}
            className="bot-pdf-list"
            style={{ height: "100%" }}
            totalCount={total}
            defaultItemHeight={value.height * scale + 20}
            increaseViewportBy={200}
            scrollerRef={(element) => {
              scroller.current = element instanceof HTMLElement ? element : null
            }}
            itemsRendered={(rendered) => {
              items.current = rendered
              updateVisiblePage()
            }}
            onScroll={updateVisiblePage}
            itemContent={(index) => <PdfPage value={value} number={index + 1} scale={scale} />}
          />
        )}
      </div>
    </div>
  )
}

/** Radix already owns dismissal, focus restoration and the authenticated save.
 * Reset document/worker/scroll identity whenever the verified file changes. */
export function BotPdfPreview(props: { sourceUrl: string; onDownload(): void }) {
  return <OpenPdf key={props.sourceUrl} {...props} />
}
