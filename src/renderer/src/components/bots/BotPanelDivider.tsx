import { useEffect, useRef } from "react"
import { BOT_COMPACT_SIDEBAR_WIDTH, clampBotPanelWidth } from "./view-store"

/** Pointer capture owns drag lifetime, including cancellation; no document-level listeners. */
export function BotPanelDivider({
  kind,
  width,
  onChange
}: {
  kind: "sidebar" | "detail"
  width: number
  onChange(width: number): void
}) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const frame = useRef<number | null>(null)
  const container = useRef<HTMLElement | null>(null)
  const pending = useRef(width)
  const change = useRef(onChange)
  change.current = onChange
  const direction = kind === "sidebar" ? 1 : -1
  const finish = () => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
    if (drag.current) change.current(pending.current)
    drag.current = null
  }
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    []
  )
  return (
    <div
      className="bot-panel-divider"
      data-kind={kind}
      role="separator"
      tabIndex={0}
      aria-label={kind === "sidebar" ? "调整 Bot 列表宽度" : "调整 Bot 详情宽度"}
      aria-orientation="vertical"
      aria-valuemin={kind === "sidebar" ? BOT_COMPACT_SIDEBAR_WIDTH : 280}
      aria-valuemax={480}
      aria-valuenow={width}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, width }
        pending.current = width
        container.current = event.currentTarget.parentElement
      }}
      onPointerMove={(event) => {
        if (!drag.current) return
        pending.current = clampBotPanelWidth(
          kind,
          drag.current.width + direction * (event.clientX - drag.current.x)
        )
        if (frame.current === null)
          frame.current = requestAnimationFrame(() => {
            frame.current = null
            container.current?.style.setProperty(
              kind === "sidebar" ? "--bot-sidebar-width" : "--bot-detail-width",
              `${pending.current}px`
            )
          })
      }}
      onPointerUp={(event) => {
        finish()
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
        event.preventDefault()
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? 480
              : kind === "sidebar" &&
                  width === BOT_COMPACT_SIDEBAR_WIDTH &&
                  event.key === "ArrowRight"
                ? 218
                : kind === "sidebar" && width === 218 && event.key === "ArrowLeft"
                  ? BOT_COMPACT_SIDEBAR_WIDTH
                  : width + (event.key === "ArrowLeft" ? -16 : 16) * direction
        onChange(clampBotPanelWidth(kind, next))
      }}
    />
  )
}
