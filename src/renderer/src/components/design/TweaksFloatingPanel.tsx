import { useCallback, useEffect, useRef, useState } from "react"
import { GripVertical } from "lucide-react"
import type { FloatingPanelPosition, VariationItem } from "./types"

const VARIATION_COLORS: Record<string, string> = {
  a: "#f97316",
  b: "#3b82f6",
  c: "#10b981",
  d: "#a855f7",
}

export function TweaksFloatingPanel({
  variations,
  activeId,
  position,
  onPositionChange,
  onSelect,
}: {
  variations: VariationItem[]
  activeId: string | null
  position: FloatingPanelPosition | null
  onPositionChange: (position: FloatingPanelPosition) => void
  onSelect: (id: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const didDragRef = useRef(false)

  const clampPosition = useCallback((x: number, y: number): FloatingPanelPosition => {
    const panel = panelRef.current
    const parent = panel?.parentElement
    if (!panel || !parent) return { x: Math.max(12, x), y: Math.max(12, y) }

    const maxX = Math.max(12, parent.clientWidth - panel.offsetWidth - 12)
    const maxY = Math.max(12, parent.clientHeight - panel.offsetHeight - 12)
    return {
      x: Math.min(Math.max(12, x), maxX),
      y: Math.min(Math.max(12, y), maxY),
    }
  }, [])

  useEffect(() => {
    if (position) return
    const panel = panelRef.current
    const parent = panel?.parentElement
    if (!panel || !parent) return

    onPositionChange(clampPosition(
      parent.clientWidth - panel.offsetWidth - 28,
      parent.clientHeight - panel.offsetHeight - 28,
    ))
  }, [clampPosition, collapsed, onPositionChange, position, variations.length])

  useEffect(() => {
    if (!position) return
    const clamped = clampPosition(position.x, position.y)
    if (clamped.x !== position.x || clamped.y !== position.y) {
      onPositionChange(clamped)
    }
  }, [clampPosition, onPositionChange, position])

  const beginDrag = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return
    const current = position ?? clampPosition(28, 28)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: current.x,
      originY: current.y,
    }
    didDragRef.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [clampPosition, position])

  const moveDrag = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3) {
      didDragRef.current = true
    }
    onPositionChange(clampPosition(
      drag.originX + event.clientX - drag.startX,
      drag.originY + event.clientY - drag.startY,
    ))
  }, [clampPosition, onPositionChange])

  const endDrag = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const panelPosition = position ?? { x: 28, y: 28 }

  return (
    <div
      ref={panelRef}
      style={{
        position: "absolute",
        left: panelPosition.x,
        top: panelPosition.y,
        zIndex: 30,
        userSelect: "none",
        touchAction: "none",
      }}
    >
      {collapsed ? (
        <button
          onClick={(event) => {
            if (didDragRef.current) {
              event.preventDefault()
              didDragRef.current = false
              return
            }
            setCollapsed(false)
          }}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 16px",
            background: "#1a1a1a",
            borderRadius: 999,
            border: "none",
            cursor: "pointer",
            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
            color: "#ffffff",
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.06em",
            fontFamily: "inherit",
            touchAction: "none",
          }}
        >
          <span style={{ fontSize: 10 }}>◈</span>
          TWEAKS
        </button>
      ) : (
        <div
          style={{
            background: "#ffffff",
            borderRadius: 20,
            boxShadow: "0 8px 40px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06)",
            padding: "20px 22px 18px",
            minWidth: 200,
          }}
        >
          <div
            onPointerDown={beginDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              margin: "-6px -4px 18px",
              padding: "6px 4px",
              cursor: "grab",
              touchAction: "none",
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", color: "#1a1a1a", textTransform: "uppercase" }}>
              <GripVertical size={14} strokeWidth={2} style={{ color: "#a0a0a0", flexShrink: 0 }} />
              Tweaks
            </span>
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); setCollapsed(true) }}
              style={{ background: "none", border: "none", cursor: "pointer", padding: "0 0 0 8px", fontSize: 16, color: "#8a8a8a", lineHeight: 1, fontFamily: "inherit" }}
            >
              ×
            </button>
          </div>

          <div style={{ fontSize: 12, color: "#8a8a8a", fontWeight: 500, marginBottom: 10, letterSpacing: "0.02em" }}>
            变体选择
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {variations.map((v) => {
              const isActive = activeId === v.id
              const color = VARIATION_COLORS[v.id] ?? "#888"
              return (
                <button
                  key={v.id}
                  onClick={() => onSelect(v.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 14px",
                    borderRadius: 12,
                    fontSize: 13,
                    fontWeight: isActive ? 700 : 500,
                    color: isActive ? "#ffffff" : "#1a1a1a",
                    background: isActive ? "#1a1a1a" : "#f5f4f0",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "all 0.12s ease",
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: isActive ? color : "#c8c6c0",
                      flexShrink: 0,
                      transition: "background 0.12s",
                    }}
                  />
                  {v.label}
                </button>
              )
            })}
          </div>

          {activeId && (
            <div
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTop: "1px solid #f0efeb",
                fontSize: 11,
                color: "#8a8a8a",
                textAlign: "center",
              }}
            >
              后续追问将迭代此变体
            </div>
          )}
        </div>
      )}
    </div>
  )
}
