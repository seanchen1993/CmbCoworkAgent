import { X } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

const DEFAULT_DRAWER_WIDTH = 720
const MIN_DRAWER_WIDTH = 250
const MAX_DRAWER_WIDTH = 1600
const MAX_VIEWPORT_WIDTH_RATIO = 0.9

export interface OverlayDrawerProps {
  open: boolean
  title: string
  ariaLabel?: string
  onClose: () => void
  children: ReactNode
}

export function OverlayDrawer({
  open,
  title,
  ariaLabel,
  onClose,
  children
}: OverlayDrawerProps): React.JSX.Element | null {
  const [present, setPresent] = useState(open)
  const [leaving, setLeaving] = useState(false)
  const [width, setWidth] = useState(DEFAULT_DRAWER_WIDTH)
  const dragStartRef = useRef<{ clientX: number; width: number } | null>(null)

  const clampWidth = useCallback((nextWidth: number): number => {
    const viewportMax = Math.max(MIN_DRAWER_WIDTH, window.innerWidth * MAX_VIEWPORT_WIDTH_RATIO)
    return Math.min(MAX_DRAWER_WIDTH, viewportMax, Math.max(MIN_DRAWER_WIDTH, nextWidth))
  }, [])

  const handleResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      dragStartRef.current = { clientX: event.clientX, width: clampWidth(width) }

      let frame: number | null = null
      let latestClientX = event.clientX

      const flushResize = (): void => {
        frame = null
        const start = dragStartRef.current
        if (!start) return
        setWidth(clampWidth(start.width - (latestClientX - start.clientX)))
      }

      const handleMouseMove = (moveEvent: MouseEvent): void => {
        latestClientX = moveEvent.clientX
        if (frame === null) frame = window.requestAnimationFrame(flushResize)
      }

      const handleMouseUp = (): void => {
        if (frame !== null) {
          window.cancelAnimationFrame(frame)
          flushResize()
        }
        dragStartRef.current = null
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
    [clampWidth, width]
  )

  useEffect(() => {
    if (open) {
      setPresent(true)
      setLeaving(false)
      return
    }
    if (!present) return
    setLeaving(true)
    const timer = window.setTimeout(() => setPresent(false), 180)
    return () => window.clearTimeout(timer)
  }, [open, present])

  if (!present) return null

  return (
    <div
      className="pointer-events-none absolute inset-0 z-50 flex justify-end"
      role="dialog"
      aria-label={ariaLabel ?? title}
    >
      <aside
        className={`pointer-events-auto relative flex h-full min-w-0 flex-col border-l border-border bg-background-elevated shadow-[-12px_0_32px_rgba(0,0,0,0.14)] motion-reduce:animate-none ${
          leaving
            ? "animate-out slide-out-to-right-8 duration-150"
            : "animate-in slide-in-from-right-8 duration-200"
        }`}
        style={{ width: clampWidth(width) }}
      >
        <div
          role="separator"
          aria-label="调整右侧面板宽度"
          aria-orientation="vertical"
          title="拖动调整右侧面板宽度"
          onMouseDown={handleResizeStart}
          className="group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize select-none"
        >
          <div className="absolute inset-y-0 left-1 w-px bg-border transition-colors group-hover:bg-border-emphasis group-active:bg-primary/70" />
        </div>
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/70 px-3">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border"
            onClick={onClose}
            title="关闭面板"
            aria-label="关闭面板"
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </aside>
    </div>
  )
}
