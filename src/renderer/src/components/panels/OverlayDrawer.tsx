import { X } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"

export interface OverlayDrawerProps {
  open: boolean
  title: string
  ariaLabel?: string
  onClose: () => void
  children: ReactNode
  widthClassName?: string
}

export function OverlayDrawer({
  open,
  title,
  ariaLabel,
  onClose,
  children,
  widthClassName = "w-[min(720px,90vw)]"
}: OverlayDrawerProps): React.JSX.Element | null {
  const [present, setPresent] = useState(open)
  const [leaving, setLeaving] = useState(false)

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
      className={`absolute inset-0 z-[70] flex justify-end bg-black/10 ${
        leaving ? "pointer-events-none" : "pointer-events-auto"
      }`}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel ?? title}
      onClick={onClose}
    >
      <aside
        className={`flex h-full ${widthClassName} min-w-0 flex-col border-l border-border bg-background-elevated shadow-[-12px_0_32px_rgba(0,0,0,0.14)] motion-reduce:animate-none ${
          leaving
            ? "animate-out slide-out-to-right-8 duration-150"
            : "animate-in slide-in-from-right-8 duration-200"
        }`}
        onClick={(event) => event.stopPropagation()}
      >
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
