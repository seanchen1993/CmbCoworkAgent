import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react"

// Adapted from Grok SidebarResizeHandle: right panel, bounded width, keyboard access.
interface PanelResizeHandleProps {
  width: number
  min: number
  max: number
  onResize(width: number): void
  onResizeEnd(): void
}

export function GrokPanelResizeHandle({
  width,
  min,
  max,
  onResize,
  onResizeEnd
}: PanelResizeHandleProps) {
  const startRight = useRef(0)
  const cleanupRef = useRef<(() => void) | null>(null)
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (cleanupRef.current != null || event.button !== 0) return
    const parent = event.currentTarget.parentElement
    if (parent == null) return
    event.preventDefault()
    startRight.current = parent.getBoundingClientRect().right
    const target = event.currentTarget
    const pointerId = event.pointerId
    target.setPointerCapture(pointerId)
    const previousCursor = document.body.style.cursor
    const previousSelection = document.body.style.userSelect
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId === pointerId)
        onResize(Math.min(max, Math.max(min, startRight.current - moveEvent.clientX)))
    }
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") cleanup()
    }
    function cleanup() {
      if (cleanupRef.current !== cleanup) return
      cleanupRef.current = null
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", cleanup)
      window.removeEventListener("pointercancel", cleanup)
      window.removeEventListener("blur", cleanup)
      window.removeEventListener("keydown", onKeyDown)
      target.removeEventListener("lostpointercapture", cleanup)
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelection
      onResizeEnd()
    }
    cleanupRef.current = cleanup
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", cleanup)
    window.addEventListener("pointercancel", cleanup)
    window.addEventListener("blur", cleanup)
    window.addEventListener("keydown", onKeyDown)
    target.addEventListener("lostpointercapture", cleanup)
  }
  useEffect(() => () => cleanupRef.current?.(), [])
  return (
    <div
      aria-label="调整详情面板大小"
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      onKeyDown={(event) => {
        const next =
          event.key === "ArrowLeft"
            ? width + 24
            : event.key === "ArrowRight"
              ? width - 24
              : event.key === "Home"
                ? min
                : event.key === "End"
                  ? max
                  : null
        if (next === null) return
        event.preventDefault()
        onResize(Math.min(max, Math.max(min, next)))
        onResizeEnd()
      }}
      aria-orientation="vertical"
      className="bot-panel-resize-handle"
      onPointerDown={onPointerDown}
      role="separator"
    />
  )
}
