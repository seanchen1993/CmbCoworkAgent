import { useCallback, useEffect, useRef } from "react"
import { GripVertical } from "lucide-react"

const HANDLE_WIDTH = 6 // px

interface ResizeHandleProps {
  onDrag: (totalDelta: number) => void
  onDragStart?: () => void
  onDragEnd?: () => void
}

export function ResizeHandle({ onDrag, onDragStart, onDragEnd }: ResizeHandleProps) {
  const startXRef = useRef<number>(0)
  const draggingRef = useRef(false)
  const frameRef = useRef<number | null>(null)
  const latestDeltaRef = useRef(0)
  const onDragRef = useRef(onDrag)
  const onDragStartRef = useRef(onDragStart)
  const onDragEndRef = useRef(onDragEnd)

  useEffect(() => {
    onDragRef.current = onDrag
    onDragStartRef.current = onDragStart
    onDragEndRef.current = onDragEnd
  }, [onDrag, onDragEnd, onDragStart])

  const clearDragState = useCallback((notifyEnd = true) => {
    const wasDragging = draggingRef.current
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      onDragRef.current(latestDeltaRef.current)
    }
    draggingRef.current = false
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
    if (wasDragging && notifyEnd) onDragEndRef.current?.()
  }, [])

  useEffect(() => {
    const handleWindowBlur = (): void => clearDragState()
    window.addEventListener("blur", handleWindowBlur)
    return () => {
      window.removeEventListener("blur", handleWindowBlur)
      clearDragState(false)
    }
  }, [clearDragState])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    draggingRef.current = true
    latestDeltaRef.current = 0
    startXRef.current = event.clientX
    onDragStartRef.current?.()
    event.preventDefault()
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }, [])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    latestDeltaRef.current = event.clientX - startXRef.current
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      onDragRef.current(latestDeltaRef.current)
    })
  }, [])

  const handlePointerEnd = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      clearDragState()
    },
    [clearDragState]
  )

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      className="group hover:bg-border/50 active:bg-primary/30 transition-colors cursor-col-resize flex items-center justify-center shrink-0 select-none"
      style={{ width: HANDLE_WIDTH }}
    >
      <GripVertical className="size-4 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
    </div>
  )
}
