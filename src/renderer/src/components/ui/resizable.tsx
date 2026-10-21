import { useCallback, useEffect, useRef } from "react"
import { GripVertical } from "lucide-react"

const HANDLE_WIDTH = 6 // px

interface ResizeHandleProps {
  onDrag: (totalDelta: number) => void
  onDragEnd?: (totalDelta: number) => void
  onDragCancel?: () => void
}

export function ResizeHandle({ onDrag, onDragEnd, onDragCancel }: ResizeHandleProps) {
  const startXRef = useRef<number>(0)
  const cleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => cleanupRef.current?.(), [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      cleanupRef.current?.()
      startXRef.current = e.clientX
      let frame: number | null = null
      let latestDelta = 0
      const previousCursor = document.body.style.cursor
      const previousUserSelect = document.body.style.userSelect

      const flushDrag = (): void => {
        frame = null
        onDrag(latestDelta)
      }

      const scheduleDrag = (delta: number): void => {
        latestDelta = delta
        if (frame === null) {
          frame = window.requestAnimationFrame(flushDrag)
        }
      }

      const handleMouseMove = (e: MouseEvent) => {
        // Calculate total delta from drag start
        const totalDelta = e.clientX - startXRef.current
        scheduleDrag(totalDelta)
      }

      const cleanup = () => {
        if (frame !== null) window.cancelAnimationFrame(frame)
        frame = null
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
        window.removeEventListener("blur", handleMouseUp)
        document.body.style.cursor = previousCursor
        document.body.style.userSelect = previousUserSelect
        cleanupRef.current = null
      }
      const handleMouseUp = () => {
        if (frame !== null) {
          window.cancelAnimationFrame(frame)
          frame = null
          onDrag(latestDelta)
        }
        cleanup()
        onDragEnd?.(latestDelta)
      }

      cleanupRef.current = () => {
        cleanup()
        onDragCancel?.()
      }

      document.addEventListener("mousemove", handleMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
      window.addEventListener("blur", handleMouseUp)
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
    },
    [onDrag, onDragEnd, onDragCancel]
  )

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={handleMouseDown}
      className="group hover:bg-border/50 active:bg-primary/30 transition-colors cursor-col-resize flex items-center justify-center shrink-0 select-none"
      style={{ width: HANDLE_WIDTH }}
    >
      <GripVertical className="size-4 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
    </div>
  )
}
