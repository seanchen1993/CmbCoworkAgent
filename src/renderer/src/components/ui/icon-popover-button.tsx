import * as React from "react"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

type PopoverContentProps = React.ComponentProps<typeof PopoverContent>

type IconPopoverButtonProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "disabled" | "title" | "popover"
> & {
  icon: React.ReactNode
  popoverContent: React.ReactNode
  disabled?: boolean
  popoverClassName?: string
  side?: PopoverContentProps["side"]
  align?: PopoverContentProps["align"]
  sideOffset?: PopoverContentProps["sideOffset"]
  stopPropagation?: boolean
}

function IconPopoverButton({
  icon,
  popoverContent,
  disabled = false,
  popoverClassName,
  side = "top",
  align = "center",
  sideOffset = 6,
  stopPropagation = false,
  className,
  type = "button",
  tabIndex,
  onClick,
  onKeyDown,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  ...props
}: IconPopoverButtonProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearCloseTimer = React.useCallback(() => {
    if (!closeTimerRef.current) return
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const showPopover = React.useCallback(() => {
    clearCloseTimer()
    setOpen(true)
  }, [clearCloseTimer])

  const hidePopover = React.useCallback(() => {
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => {
      setOpen(false)
      closeTimerRef.current = null
    }, 80)
  }, [clearCloseTimer])

  React.useEffect(() => clearCloseTimer, [clearCloseTimer])

  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (stopPropagation) event.stopPropagation()
      setOpen(false)
      if (disabled) {
        event.preventDefault()
        return
      }
      onClick?.(event)
    },
    [disabled, onClick, stopPropagation]
  )

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (stopPropagation) event.stopPropagation()
      onKeyDown?.(event)
    },
    [onKeyDown, stopPropagation]
  )

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setOpen(false)
      }}
    >
      <PopoverAnchor asChild>
        <button
          {...props}
          type={type}
          aria-disabled={disabled}
          tabIndex={disabled ? -1 : tabIndex}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onPointerEnter={(event) => {
            showPopover()
            onPointerEnter?.(event)
          }}
          onPointerLeave={(event) => {
            hidePopover()
            onPointerLeave?.(event)
          }}
          onFocus={(event) => {
            showPopover()
            onFocus?.(event)
          }}
          onBlur={(event) => {
            hidePopover()
            onBlur?.(event)
          }}
          className={cn(
            "cursor-pointer inline-flex items-center justify-center rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-background-interactive",
            disabled &&
              "opacity-50 cursor-not-allowed hover:text-muted-foreground hover:bg-transparent",
            className
          )}
        >
          {icon}
        </button>
      </PopoverAnchor>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        className={cn("w-auto max-w-48 px-2.5 py-1.5 text-xs", popoverClassName)}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={showPopover}
        onPointerLeave={hidePopover}
        onClick={(event) => {
          if (stopPropagation) event.stopPropagation()
        }}
      >
        {popoverContent}
      </PopoverContent>
    </Popover>
  )
}

export { IconPopoverButton }
