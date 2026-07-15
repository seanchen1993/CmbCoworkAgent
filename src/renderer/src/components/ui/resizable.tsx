import { useCallback, useRef } from "react"
import { GripVertical } from "lucide-react"

const HANDLE_WIDTH = 6 // px

interface ResizeHandleProps {
  onDrag: (totalDelta: number) => void
}

export function ResizeHandle({ onDrag }: ResizeHandleProps) {
  const startXRef = useRef<number>(0)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      startXRef.current = e.clientX
      let frame: number | null = null
      let latestDelta = 0

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

      const handleMouseUp = () => {
        if (frame !== null) {
          window.cancelAnimationFrame(frame)
          frame = null
          onDrag(latestDelta)
        }
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
      }

      document.addEventListener("mousemove", handleMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
    },
    [onDrag]
  )

  return (
    <div
      onMouseDown={handleMouseDown}
      className="group hover:bg-border/50 active:bg-primary/30 transition-colors cursor-col-resize flex items-center justify-center shrink-0 select-none"
      style={{ width: HANDLE_WIDTH }}
    >
      <GripVertical className="size-4 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
    </div>
  )
}
