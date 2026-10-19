import { useEffect, useLayoutEffect, useRef } from "react"
import { BOT_COMPACT_SIDEBAR_WIDTH, clampBotPanelWidth } from "./view-store"

function clearPanelDrag(container: HTMLElement | null, kind: "sidebar" | "detail"): void {
  if (container?.dataset.botPanelDragging === kind) delete container.dataset.botPanelDragging
}

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
  useLayoutEffect(() => {
    change.current = onChange
  }, [onChange])
  const direction = kind === "sidebar" ? 1 : -1
  const widthVariable = kind === "sidebar" ? "--bot-sidebar-width" : "--bot-detail-width"
  const finish = () => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
    if (drag.current) {
      container.current?.style.setProperty(widthVariable, `${pending.current}px`)
      change.current(pending.current)
    }
    drag.current = null
    clearPanelDrag(container.current, kind)
  }
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      clearPanelDrag(container.current, kind)
    },
    [kind]
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
        container.current = event.currentTarget.parentElement
        const panel = container.current?.querySelector(
          kind === "sidebar" ? ".bots-sidebar" : ".bot-details"
        )
        const actualWidth = panel?.getBoundingClientRect().width ?? width
        // A drag can interrupt a keyboard transition; freeze its current visual width first.
        container.current?.style.setProperty(widthVariable, `${actualWidth}px`)
        if (container.current) container.current.dataset.botPanelDragging = kind
        drag.current = { x: event.clientX, width: actualWidth }
        pending.current = clampBotPanelWidth(kind, actualWidth)
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
            container.current?.style.setProperty(widthVariable, `${pending.current}px`)
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
