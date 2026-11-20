import { useEffect, useRef, useState } from "react"
import { ZoomIn, ZoomOut, Maximize2, RotateCw, Hand } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"

interface ImageViewerProps {
  filePath: string
  sourceUrl: string
}

export function ImageViewer({ filePath, sourceUrl }: ImageViewerProps): React.JSX.Element {
  const [zoom, setZoom] = useState(100)
  const [rotation, setRotation] = useState(0)
  const [isPanning, setIsPanning] = useState(false)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)
  const panStartRef = useRef({ x: 0, y: 0 })
  const panFrameRef = useRef<number | null>(null)
  const pendingPanOffsetRef = useRef<{ x: number; y: number } | null>(null)

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

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      {/* Header with controls */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border bg-background/50 shrink-0">
        <div className="flex items-center gap-2 text-xs text-muted-foreground overflow-hidden">
          <span className="truncate">{fileName}</span>
          <span className="text-muted-foreground/50">•</span>
          <span>Image</span>
          {canPan && (
            <>
              <span className="text-muted-foreground/50">•</span>
              <span className="flex items-center gap-1">
                <Hand className="size-3" />
                Drag to pan
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
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
            onClick={handleZoomIn}
            disabled={zoom >= 400}
            className="h-7 px-2"
          >
            <ZoomIn className="size-4" />
          </Button>

          <Button variant="ghost" size="sm" onClick={handleRotate} className="h-7 px-2">
            <RotateCw className="size-4" />
          </Button>

          <Button variant="ghost" size="sm" onClick={handleResetZoom} className="h-7 px-2">
            <Maximize2 className="size-4" />
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
