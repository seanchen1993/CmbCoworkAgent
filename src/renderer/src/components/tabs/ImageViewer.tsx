import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { ZoomIn, ZoomOut, RotateCcw, RotateCw, Hand } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"

interface ImageViewerProps {
  filePath: string
  sourceUrl: string
  presentation?: "file" | "lightbox"
  onBackdropClick?: () => void
  onNavigate?: (direction: -1 | 1) => void
}

export function ImageViewer({
  filePath,
  sourceUrl,
  presentation = "file",
  onBackdropClick,
  onNavigate
}: ImageViewerProps): React.JSX.Element {
  const [zoom, setZoom] = useState(100)
  const [rotation, setRotation] = useState(0)
  const [isPanning, setIsPanning] = useState(false)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const panMovedRef = useRef(false)
  const panStartRef = useRef({ x: 0, y: 0 })
  const panFrameRef = useRef<number | null>(null)
  const pendingPanOffsetRef = useRef<{ x: number; y: number } | null>(null)

  const navigateRef = useRef(onNavigate)
  useLayoutEffect(() => {
    navigateRef.current = onNavigate
  }, [onNavigate])
  const lightboxViewRef = useRef({ zoom: 100, offset: { x: 0, y: 0 } })
  const lightboxPointerRef = useRef<{
    id: number
    startX: number
    startY: number
    origin: { x: number; y: number }
    panning: boolean
  } | null>(null)

  const clampLightboxOffset = useCallback((offset: { x: number; y: number }, nextZoom: number) => {
    const frame = containerRef.current,
      image = imageRef.current
    if (!frame || !image) return { x: 0, y: 0 }
    const maxX = Math.max(0, ((image.offsetWidth * nextZoom) / 100 - frame.clientWidth) / 2),
      maxY = Math.max(0, ((image.offsetHeight * nextZoom) / 100 - frame.clientHeight) / 2)
    return {
      x: Math.max(-maxX, Math.min(maxX, offset.x)),
      y: Math.max(-maxY, Math.min(maxY, offset.y))
    }
  }, [])
  const writeLightboxView = useCallback(
    (nextZoom: number, offset: { x: number; y: number }, immediate: boolean) => {
      lightboxViewRef.current = { zoom: nextZoom, offset: clampLightboxOffset(offset, nextZoom) }
      const write = () => {
        panFrameRef.current = null
        const current = lightboxViewRef.current
        setZoom(current.zoom)
        setPanOffset(current.offset)
      }
      if (immediate) {
        if (panFrameRef.current !== null) window.cancelAnimationFrame(panFrameRef.current)
        pendingPanOffsetRef.current = null
        write()
      } else if (panFrameRef.current === null)
        panFrameRef.current = window.requestAnimationFrame(write)
    },
    [clampLightboxOffset]
  )
  const finishLightboxPointer = useCallback(
    (cancelled: boolean) => {
      const pointer = lightboxPointerRef.current
      if (!pointer) return
      lightboxPointerRef.current = null
      if (cancelled) panMovedRef.current = true
      if (imageRef.current?.hasPointerCapture(pointer.id))
        imageRef.current.releasePointerCapture(pointer.id)
      setIsPanning(false)
      const current = lightboxViewRef.current
      writeLightboxView(current.zoom, current.offset, true)
    },
    [writeLightboxView]
  )
  const zoomLightbox = useCallback(
    (requestedZoom: number, clientX: number, clientY: number) => {
      const frame = containerRef.current
      if (!frame) return
      const current = lightboxViewRef.current,
        nextZoom = Math.max(100, Math.min(500, requestedZoom))
      if (nextZoom === current.zoom) return
      finishLightboxPointer(true)
      const bounds = frame.getBoundingClientRect(),
        focalX = clientX - bounds.left - bounds.width / 2,
        focalY = clientY - bounds.top - bounds.height / 2,
        ratio = nextZoom / current.zoom
      writeLightboxView(
        nextZoom,
        {
          x: focalX - (focalX - current.offset.x) * ratio,
          y: focalY - (focalY - current.offset.y) * ratio
        },
        true
      )
    },
    [finishLightboxPointer, writeLightboxView]
  )
  useEffect(() => {
    if (presentation !== "lightbox") return
    const frame = containerRef.current,
      image = imageRef.current
    if (!frame || !image) return
    const abort = new AbortController()
    frame.addEventListener(
      "wheel",
      (event) => {
        if (!image.naturalWidth) return
        event.preventDefault()
        frame.focus({ preventScroll: true })
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.clientHeight : 1
        zoomLightbox(
          lightboxViewRef.current.zoom * Math.exp(-event.deltaY * unit * 0.0015),
          event.clientX,
          event.clientY
        )
      },
      { passive: false, signal: abort.signal }
    )
    const dialog = frame.closest<HTMLElement>('[role="dialog"]')
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (
        !(target instanceof Element) ||
        target.closest('[role="dialog"]') !== dialog ||
        target.closest('input,textarea,[contenteditable="true"]')
      )
        return
      const frame = containerRef.current
      if (!frame) return
      const current = lightboxViewRef.current,
        bounds = frame.getBoundingClientRect()
      if (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "_") {
        event.preventDefault()
        zoomLightbox(
          current.zoom * (event.key === "+" || event.key === "=" ? 1.4 : 1 / 1.4),
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2
        )
      } else if (event.key === "0") {
        event.preventDefault()
        finishLightboxPointer(true)
        writeLightboxView(100, { x: 0, y: 0 }, true)
      } else if (
        current.zoom > 100 &&
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        event.preventDefault()
        finishLightboxPointer(true)
        writeLightboxView(
          current.zoom,
          {
            x:
              current.offset.x +
              (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0),
            y:
              current.offset.y +
              (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0)
          },
          true
        )
      } else if (
        current.zoom === 100 &&
        navigateRef.current &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        event.preventDefault()
        finishLightboxPointer(true)
        navigateRef.current(event.key === "ArrowLeft" ? -1 : 1)
      }
    }
    dialog?.addEventListener("keydown", handleKey, { signal: abort.signal })
    return () => {
      abort.abort()
      const pointer = lightboxPointerRef.current
      lightboxPointerRef.current = null
      if (pointer && image.hasPointerCapture(pointer.id)) image.releasePointerCapture(pointer.id)
      if (panFrameRef.current !== null) window.cancelAnimationFrame(panFrameRef.current)
      panFrameRef.current = null
      pendingPanOffsetRef.current = null
    }
  }, [presentation, zoomLightbox, finishLightboxPointer, writeLightboxView])

  const fileName = filePath.split("/").pop() || filePath

  const handleZoomIn = (): void => {
    const newZoom = Math.min(zoom + 25, 400)
    setZoom(newZoom)
    if (newZoom <= 100) {
      setPanOffset({ x: 0, y: 0 })
    }
  }

  const handleZoomOut = (): void => {
    const newZoom = Math.max(zoom - 25, 25)
    setZoom(newZoom)
    if (newZoom <= 100) {
      setPanOffset({ x: 0, y: 0 })
    }
  }

  const handleResetZoom = (): void => {
    setZoom(100)
    setRotation(0)
    setPanOffset({ x: 0, y: 0 })
  }

  const handleRotate = (): void => {
    setRotation((prev) => (prev + 90) % 360)
  }

  const handleMouseDown = (e: React.MouseEvent): void => {
    if (zoom > 100) {
      setIsPanning(true)
      panStartRef.current = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y }
      e.preventDefault()
    }
  }

  const handleMouseMove = (e: React.MouseEvent): void => {
    if (isPanning && zoom > 100) {
      pendingPanOffsetRef.current = {
        x: e.clientX - panStartRef.current.x,
        y: e.clientY - panStartRef.current.y
      }
      if (panFrameRef.current === null) {
        panFrameRef.current = window.requestAnimationFrame(() => {
          panFrameRef.current = null
          const next = pendingPanOffsetRef.current
          pendingPanOffsetRef.current = null
          if (next) setPanOffset(next)
        })
      }
    }
  }

  const handleMouseUp = (): void => {
    if (panFrameRef.current !== null) {
      window.cancelAnimationFrame(panFrameRef.current)
      panFrameRef.current = null
      const next = pendingPanOffsetRef.current
      pendingPanOffsetRef.current = null
      if (next) setPanOffset(next)
    }
    setIsPanning(false)
  }

  const handleMouseLeave = (): void => {
    handleMouseUp()
  }

  useEffect(() => {
    return () => {
      if (panFrameRef.current !== null) {
        window.cancelAnimationFrame(panFrameRef.current)
      }
    }
  }, [])

  const canPan = zoom > 100

  if (presentation === "lightbox")
    return (
      <div
        ref={containerRef}
        data-image-presentation="lightbox"
        data-image-scale={zoom}
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden outline-none"
        tabIndex={0}
        aria-label="图片预览，点击缩放，放大后拖动"
        onClick={(event) => {
          if (event.target === event.currentTarget && !panMovedRef.current) onBackdropClick?.()
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.ctrlKey || !event.isPrimary || lightboxPointerRef.current)
            return
          panMovedRef.current = false
          if (event.target !== imageRef.current) return
          event.currentTarget.focus({ preventScroll: true })
          const current = lightboxViewRef.current,
            panning = current.zoom > 100
          lightboxPointerRef.current = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            origin: current.offset,
            panning
          }
          setIsPanning(panning)
          if (panning) {
            event.preventDefault()
            imageRef.current?.setPointerCapture(event.pointerId)
          }
        }}
        onPointerMove={(event) => {
          const pointer = lightboxPointerRef.current
          if (!pointer || pointer.id !== event.pointerId) return
          const dx = event.clientX - pointer.startX,
            dy = event.clientY - pointer.startY
          if (Math.hypot(dx, dy) > 4) panMovedRef.current = true
          if (pointer.panning)
            writeLightboxView(
              lightboxViewRef.current.zoom,
              { x: pointer.origin.x + dx, y: pointer.origin.y + dy },
              false
            )
        }}
        onPointerUp={(event) => {
          if (lightboxPointerRef.current?.id === event.pointerId) finishLightboxPointer(false)
        }}
        onPointerCancel={(event) => {
          if (lightboxPointerRef.current?.id === event.pointerId) finishLightboxPointer(true)
        }}
        onLostPointerCapture={(event) => {
          if (lightboxPointerRef.current?.id === event.pointerId) finishLightboxPointer(true)
        }}
        style={{
          cursor: canPan ? (isPanning ? "grabbing" : "grab") : "default",
          touchAction: "none"
        }}
      >
        <img
          ref={imageRef}
          src={sourceUrl}
          alt={fileName}
          className={`max-h-full max-w-full select-none object-contain ${isPanning ? "" : "transition-transform duration-200 motion-reduce:transition-none"}`}
          draggable={false}
          onClick={(event) => {
            event.stopPropagation()
            if (panMovedRef.current) return
            if (event.ctrlKey || event.button !== 0) return
            const current = lightboxViewRef.current
            if (!event.altKey && current.zoom >= 500) {
              finishLightboxPointer(true)
              writeLightboxView(100, { x: 0, y: 0 }, true)
            } else
              zoomLightbox(
                event.altKey ? current.zoom / 2.5 : current.zoom * 2.5,
                event.clientX,
                event.clientY
              )
          }}
          style={{
            cursor: canPan ? (isPanning ? "grabbing" : "grab") : "zoom-in",
            transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom / 100})`
          }}
        />
      </div>
    )

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      {/* Header with controls */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border bg-background/50 shrink-0">
        <div className="flex items-center gap-2 text-xs text-muted-foreground overflow-hidden">
          <span className="truncate">{fileName}</span>
          <span className="text-muted-foreground/50">•</span>
          <span>图片</span>
          {canPan && (
            <>
              <span className="text-muted-foreground/50">•</span>
              <span className="flex items-center gap-1">
                <Hand className="size-3" />
                拖动平移
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="缩小"
            title="缩小"
            onClick={handleZoomOut}
            disabled={zoom <= 25}
            className="h-7 px-2"
          >
            <ZoomOut className="size-4" />
          </Button>

          <span className="text-xs text-muted-foreground min-w-[3rem] text-center">{zoom}%</span>

          <Button
            variant="ghost"
            size="sm"
            aria-label="放大"
            title="放大"
            onClick={handleZoomIn}
            disabled={zoom >= 400}
            className="h-7 px-2"
          >
            <ZoomIn className="size-4" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            aria-label="顺时针旋转90°"
            title="顺时针旋转90°"
            onClick={handleRotate}
            className="h-7 px-2"
          >
            <RotateCw className="size-4" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            aria-label="重置视图"
            title="重置视图"
            onClick={handleResetZoom}
            className="h-7 px-2"
          >
            <RotateCcw className="size-4" />
          </Button>
        </div>
      </div>

      {/* Image display */}
      <ScrollArea className="flex-1 min-h-0">
        <div
          ref={containerRef}
          className="flex items-center justify-center min-h-full p-8 overflow-hidden"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          style={{
            cursor: canPan ? (isPanning ? "grabbing" : "grab") : "default",
            userSelect: "none"
          }}
        >
          <img
            src={sourceUrl}
            alt={fileName}
            className={`max-w-full h-auto ${isPanning ? "" : "transition-transform duration-200"}`}
            style={{
              transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom / 100}) rotate(${rotation}deg)`,
              imageRendering: zoom > 100 ? "pixelated" : "auto"
            }}
            draggable={false}
          />
        </div>
      </ScrollArea>
    </div>
  )
}
