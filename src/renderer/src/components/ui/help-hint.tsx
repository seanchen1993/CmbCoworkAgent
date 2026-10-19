import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { CircleHelp } from "lucide-react"
import { Popover, PopoverAnchor, PopoverContent } from "./popover"

/** Brief contextual help, available to pointer, touch and keyboard users. */
export function HelpHint({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const pinned = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const id = useId()
  const cancelClose = () => {
    clearTimeout(timer.current)
  }
  const close = () => {
    cancelClose()
    if (!pinned.current) timer.current = setTimeout(() => setOpen(false), 150)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        cancelClose()
        pinned.current = value
        setOpen(value)
      }}
    >
      <PopoverAnchor asChild>
        <button
          type="button"
          aria-label={label}
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-haspopup="dialog"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerEnter={(event) => {
            if (event.pointerType === "touch") return
            cancelClose()
            setOpen(true)
          }}
          onPointerLeave={close}
          onFocus={() => {
            cancelClose()
            setOpen(true)
          }}
          onBlur={close}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              pinned.current = false
              setOpen(false)
              event.stopPropagation()
            }
          }}
          onClick={() => {
            cancelClose()
            pinned.current = !pinned.current
            setOpen(pinned.current)
          }}
        >
          <CircleHelp className="size-4" aria-hidden="true" />
        </button>
      </PopoverAnchor>
      <PopoverContent
        id={id}
        aria-label={label}
        className="max-h-[min(70vh,420px)] w-[min(340px,calc(100vw-24px))] space-y-2 overflow-y-auto text-xs leading-5"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={cancelClose}
        onPointerLeave={close}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
