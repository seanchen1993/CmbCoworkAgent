import { useLayoutEffect, useRef, type ReactNode } from "react"

/** Attribute is consumed once per DOM lifetime; token updates never restart its CSS animation. */
export function BotMessageEntrance({
  id,
  entering,
  active = true,
  onEntered,
  children
}: {
  id: string
  entering: boolean
  active?: boolean
  onEntered(id: string): void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!entering || !active || !ref.current) return
    ref.current.dataset.botMessageEnter = "new"
    onEntered(id)
  }, [id, entering, active, onEntered])
  return (
    <div ref={ref} className="bot-message-entrance">
      {children}
    </div>
  )
}
