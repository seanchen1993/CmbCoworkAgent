import type { ReactNode } from "react"
import { Presence } from "@radix-ui/react-presence"

/** Reuse Radix's animation lifecycle; the existing workspace still owns open/tab/width state. */
export function BotDetailsPane({
  open,
  label,
  children
}: {
  open: boolean
  label: string
  children: ReactNode
}) {
  return (
    <aside
      className="bot-details"
      data-state={open ? "open" : "closed"}
      aria-label={label}
      aria-hidden={!open}
      inert={!open}
    >
      <Presence present={open}>
        <div className="bot-details-content" data-state={open ? "open" : "closed"}>
          {children}
        </div>
      </Presence>
    </aside>
  )
}
