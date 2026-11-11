import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"

type RequirementActionButtonProps = ComponentProps<typeof Button> & {
  hint: ReactNode
}

export function RequirementActionButton({
  hint,
  children,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  ...buttonProps
}: RequirementActionButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearCloseTimer = useCallback(() => {
    if (!closeTimerRef.current) return
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])
  const show = useCallback(() => {
    clearCloseTimer()
    setOpen(true)
  }, [clearCloseTimer])
  const hide = useCallback(() => {
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => setOpen(false), 80)
  }, [clearCloseTimer])

  useEffect(() => clearCloseTimer, [clearCloseTimer])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Button
          {...buttonProps}
          onPointerEnter={(event) => {
            show()
            onPointerEnter?.(event)
          }}
          onPointerLeave={(event) => {
            hide()
            onPointerLeave?.(event)
          }}
          onFocus={(event) => {
            show()
            onFocus?.(event)
          }}
          onBlur={(event) => {
            hide()
            onBlur?.(event)
          }}
        >
          {children}
        </Button>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={6}
        className="w-auto max-w-72 px-3 py-2 text-xs leading-5"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={show}
        onPointerLeave={hide}
      >
        {hint}
      </PopoverContent>
    </Popover>
  )
}

export const REQUIREMENT_ACTION_HINTS = {
  startDevelopment: "将当前需求作为开发背景；如已有原型，也会一并带入项目模式。",
  continueDevelopment: "返回该需求关联的项目会话，继续推进开发。",
  resetDevelopment: "仅解除当前需求与项目会话的关联；项目会话及其历史记录会保留。",
  startDesign: "基于当前需求创建设计会话，开始制作原型。",
  continueDesign: "返回已关联的设计会话，继续完善原型。",
  viewDesign: "打开已完成的原型设计及其关联会话。",
  resetDesign: "仅解除当前需求与设计会话的关联；设计会话及其历史记录会保留。"
} as const
