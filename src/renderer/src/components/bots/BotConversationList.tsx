import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"
import { botSidebarUnreadJumps } from "@/lib/bot-sidebar-unreads"

/** Grok's offscreen-unread jump behavior, using the existing Bot read-state projection. */
export function BotConversationList({ children, label }: { children: ReactNode; label: string }) {
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const frame = useRef(0)
  const expanding = useRef<{ section: HTMLElement; direction: "above" | "below" } | null>(null)
  const [jumps, setJumps] = useState<ReturnType<typeof botSidebarUnreadJumps>>({
    above: null,
    below: null
  })
  const measure = useCallback(() => {
    const el = viewport.current
    if (!el) return
    const bounds = el.getBoundingClientRect()
    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-bot-unread-count]")).map(
      (row) => {
        const rect = row.getBoundingClientRect()
        return {
          key: row.dataset.botRowKey!,
          count: Number(row.dataset.botUnreadCount),
          top: rect.top,
          bottom: rect.bottom
        }
      }
    )
    const next = botSidebarUnreadJumps(rows, bounds)
    setJumps((old) =>
      old.above?.key === next.above?.key &&
      old.above?.count === next.above?.count &&
      old.below?.key === next.below?.key &&
      old.below?.count === next.below?.count
        ? old
        : next
    )
  }, [])
  const scheduleMeasure = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      measure()
    })
  }, [measure])
  const reveal = (row: HTMLElement) => {
    row.scrollIntoView({
      block: "nearest",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"
    })
    row.focus({ preventScroll: true })
  }
  // Read status and order can change without resizing the list. After opening a
  // collapsed section, reveal its nearest unread row rather than just its header.
  useLayoutEffect(() => {
    const pending = expanding.current
    if (pending) {
      expanding.current = null
      const rows = Array.from(
        pending.section.querySelectorAll<HTMLElement>("[data-bot-unread-count='1']")
      )
      const row = pending.direction === "above" ? rows.at(-1) : rows[0]
      if (row?.isConnected) reveal(row)
    }
    measure()
  }, [children, measure])
  useEffect(() => {
    const observer = new ResizeObserver(scheduleMeasure)
    if (viewport.current) observer.observe(viewport.current)
    if (content.current) observer.observe(content.current)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [scheduleMeasure])
  return (
    <div className="bot-list-viewport">
      <div ref={viewport} className="bots-list" aria-label={label} onScroll={scheduleMeasure}>
        <div ref={content}>{children}</div>
      </div>
      {(["above", "below"] as const).map((direction) => {
        const jump = jumps[direction]
        if (!jump) return null
        const Icon = direction === "above" ? ArrowUp : ArrowDown
        return (
          <button
            key={direction}
            className="bot-unread-jump"
            data-direction={direction}
            aria-label={`更多未读消息（${direction === "above" ? "上方" : "下方"}）`}
            title={`${jump.count} 个未读会话`}
            onClick={() => {
              const row = Array.from(
                viewport.current?.querySelectorAll<HTMLElement>("[data-bot-row-key]") ?? []
              ).find((item) => item.dataset.botRowKey === jump.key)
              if (!row) return
              const section = row.closest("section")
              if (row.dataset.botExpandUnread === "true" && section) {
                expanding.current = { section, direction }
                row.click()
              } else reveal(row)
            }}
          >
            <Icon size={18} />
            <span>未读消息</span>
          </button>
        )
      })}
    </div>
  )
}
