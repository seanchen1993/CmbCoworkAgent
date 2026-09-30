import React, { useCallback, useEffect, useRef, useState } from "react"
import { v4 as uuid } from "uuid"
import { MousePointer2, PenLine, SendHorizontal, Trash2, Undo2, X } from "lucide-react"
import type { DrawNote, DrawPoint, DrawStroke, DrawToolMode, DraftDrawNote } from "./types"

export interface ResolvedDrawStroke extends DrawStroke {
  resolvedPoints?: DrawPoint[]
  orphaned?: boolean
  /** 1-based region number shown on the canvas; matches the "[区域 N]" label in the prompt. */
  regionIndex?: number
}

export interface ResolvedDrawNote extends DrawNote {
  resolvedPoint?: DrawPoint
  orphaned?: boolean
  /** Region number this note is bound to, when it explains a stroke. */
  regionIndex?: number
}

export interface ResolvedDraftDrawNote extends DraftDrawNote {
  resolvedPoint?: DrawPoint
  orphaned?: boolean
  regionIndex?: number
}

function getPointerDrawPoint(
  e: React.PointerEvent<HTMLDivElement>,
  scrollX: number,
  scrollY: number,
  zoom: number
): DrawPoint {
  const rect = e.currentTarget.getBoundingClientRect()
  const scale = Math.max(zoom, 1) / 100
  return {
    x: Math.max(0, (e.clientX - rect.left) / scale + scrollX),
    y: Math.max(0, (e.clientY - rect.top) / scale + scrollY),
  }
}

function pointsToSvgPath(points: DrawPoint[]): string {
  if (points.length === 0) return ""
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  const [first, ...rest] = points
  return rest.reduce((path, point) => `${path} L ${point.x} ${point.y}`, `M ${first.x} ${first.y}`)
}

function toScreenDrawPoints(points: DrawPoint[], scrollX: number, scrollY: number, scale: number): DrawPoint[] {
  return points.map((point) => ({
    x: (point.x - scrollX) * scale,
    y: (point.y - scrollY) * scale,
  }))
}

export function DrawLayer({
  active,
  mode,
  strokes,
  notes,
  draftNote,
  zoom,
  scrollX,
  scrollY,
  onStrokeComplete,
  onNoteDraft,
  onNoteSubmit,
  onNoteCancel,
  onWheelScroll,
}: {
  active: boolean
  mode: DrawToolMode
  strokes: ResolvedDrawStroke[]
  notes: ResolvedDrawNote[]
  draftNote: ResolvedDraftDrawNote | null
  zoom: number
  scrollX: number
  scrollY: number
  onStrokeComplete: (stroke: DrawStroke) => void
  onNoteDraft: (point: DrawPoint) => void
  onNoteSubmit: (text: string) => void
  onNoteCancel: () => void
  onWheelScroll: (deltaX: number, deltaY: number) => void
}) {
  const [draft, setDraft] = useState<DrawPoint[]>([])
  const draftRef = useRef<DrawPoint[]>([])
  const drawingRef = useRef(false)
  const pointerIdRef = useRef<number | null>(null)
  const scale = zoom / 100

  const finishStroke = useCallback(() => {
    if (!drawingRef.current) return
    drawingRef.current = false
    pointerIdRef.current = null
    const points = draftRef.current
    if (points.length >= 2) {
      onStrokeComplete({
        id: uuid(),
        points,
        color: "#cc785c",
        width: 5,
        createdAt: Date.now(),
      })
    }
    draftRef.current = []
    setDraft([])
  }, [onStrokeComplete])

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!active || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const point = getPointerDrawPoint(e, scrollX, scrollY, zoom)
    if (mode === "note") {
      onNoteDraft(point)
      return
    }
    drawingRef.current = true
    pointerIdRef.current = e.pointerId
    e.currentTarget.setPointerCapture(e.pointerId)
    const points = [point]
    draftRef.current = points
    setDraft(points)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!active || mode !== "draw" || !drawingRef.current || pointerIdRef.current !== e.pointerId) return
    e.preventDefault()
    const next = getPointerDrawPoint(e, scrollX, scrollY, zoom)
    const last = draftRef.current[draftRef.current.length - 1]
    if (last && Math.hypot(next.x - last.x, next.y - last.y) < 3) return
    const points = [...draftRef.current, next]
    draftRef.current = points
    setDraft(points)
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current === e.pointerId) {
      e.preventDefault()
      finishStroke()
    }
  }

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!active) return
    e.preventDefault()
    e.stopPropagation()
    onWheelScroll(e.deltaX, e.deltaY)
  }

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: active ? 18 : 6,
        pointerEvents: active ? "auto" : "none",
        cursor: active ? (mode === "draw" ? "crosshair" : "text") : "default",
        touchAction: "none",
      }}
    >
      <svg width="100%" height="100%" style={{ display: "block", overflow: "visible" }}>
        {strokes.map((stroke) => {
          const screenPoints = toScreenDrawPoints(stroke.resolvedPoints ?? stroke.points, scrollX, scrollY, scale)
          return (
            <g key={stroke.id}>
              <path
                d={pointsToSvgPath(screenPoints)}
                fill="none"
                stroke={stroke.color}
                strokeWidth={Math.max(2, stroke.width * scale)}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={stroke.orphaned ? 0.55 : 0.9}
                strokeDasharray={stroke.orphaned ? "8 6" : undefined}
              />
              {stroke.regionIndex !== undefined && screenPoints.length > 0 && (
                <StrokeRegionLabel
                  index={stroke.regionIndex}
                  x={Math.min(...screenPoints.map((point) => point.x))}
                  y={Math.min(...screenPoints.map((point) => point.y))}
                  color={stroke.color}
                  faded={stroke.orphaned}
                />
              )}
            </g>
          )
        })}
        {draft.length > 0 && (
          <path
            d={pointsToSvgPath(toScreenDrawPoints(draft, scrollX, scrollY, scale))}
            fill="none"
            stroke="#cc785c"
            strokeWidth={Math.max(2, 5 * scale)}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.92}
          />
        )}
      </svg>
      {notes.map((note) => (
        <DrawNoteBadge
          key={note.id}
          x={((note.resolvedPoint?.x ?? note.pageX) - scrollX) * scale}
          y={((note.resolvedPoint?.y ?? note.pageY) - scrollY) * scale}
          text={note.text}
          orphaned={note.orphaned}
          regionIndex={note.regionIndex}
        />
      ))}
      {draftNote && (
        <DrawNoteDraft
          x={((draftNote.resolvedPoint?.x ?? draftNote.pageX) - scrollX) * scale}
          y={((draftNote.resolvedPoint?.y ?? draftNote.pageY) - scrollY) * scale}
          onSubmit={onNoteSubmit}
          onCancel={onNoteCancel}
        />
      )}
    </div>
  )
}

export function DrawActionBar({
  mode,
  count,
  onModeChange,
  onClose,
  onUndo,
  onClear,
  onSend,
}: {
  mode: DrawToolMode
  count: number
  onModeChange: (mode: DrawToolMode) => void
  onClose: () => void
  onUndo: () => void
  onClear: () => void
  onSend: () => void
}) {
  const disabled = count === 0
  return (
    <div
      style={{
        position: "absolute",
        bottom: 20,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 28,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        borderRadius: 999,
        background: "rgba(255,255,255,0.94)",
        border: "1px solid rgba(0,0,0,0.08)",
        backdropFilter: "blur(12px)",
        boxShadow: "0 10px 32px rgba(0,0,0,0.18)",
      }}
    >
      <button onClick={onClose} title="退出绘制" style={drawIconBtnStyle(false, "light")}>
        <X size={15} />
      </button>
      <button onClick={onUndo} disabled={disabled} title="撤销" style={drawIconBtnStyle(disabled, "light")}>
        <Undo2 size={15} />
      </button>
      <div style={{ display: "flex", padding: 3, borderRadius: 12, background: "#f0efeb", gap: 3 }}>
        <DrawModeButton
          active={mode === "draw"}
          icon={<PenLine size={15} />}
          label="绘制"
          onClick={() => onModeChange("draw")}
        />
        <DrawModeButton
          active={mode === "note"}
          icon={<MousePointer2 size={15} />}
          label="点击"
          onClick={() => onModeChange("note")}
        />
      </div>
      <span style={{ padding: "0 8px", color: "#6a6a6a", fontSize: 13, fontWeight: 500, whiteSpace: "nowrap" }}>
        {mode === "note" ? "点击任意位置添加备注" : "拖拽画出修改区域"}
      </span>
      <span style={{ padding: "0 2px 0 8px", color: "#4a4a4a", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" }}>
        队列 {count}
      </span>
      <button onClick={onClear} disabled={disabled} title="清空队列" style={drawIconBtnStyle(disabled, "light")}>
        <Trash2 size={15} />
      </button>
      <button
        onClick={onSend}
        disabled={disabled}
        title="发送绘制标记"
        style={{
          ...drawIconBtnStyle(disabled, "accent"),
          width: "auto",
          minWidth: 74,
          padding: "0 16px",
          gap: 6,
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        <SendHorizontal size={14} />
        发送
      </button>
    </div>
  )
}

function DrawModeButton({ active, icon, label, onClick }: {
  active: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 34,
        minWidth: 92,
        padding: "0 14px",
        border: active ? "1px solid rgba(0,0,0,0.08)" : "1px solid transparent",
        borderRadius: 10,
        background: active ? "#ffffff" : "transparent",
        color: active ? "#1a1a1a" : "#6a6a6a",
        boxShadow: active ? "0 2px 8px rgba(0,0,0,0.08)" : "none",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        fontSize: 13,
        fontWeight: 700,
        fontFamily: "inherit",
      }}
    >
      {icon}
      {label}
    </button>
  )
}

function drawIconBtnStyle(disabled: boolean, tone: "light" | "accent"): React.CSSProperties {
  const accent = tone === "accent"
  return {
    height: 34,
    width: 34,
    border: "none",
    borderRadius: 10,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: accent ? (disabled ? "#e0ded8" : "#cc785c") : "transparent",
    color: accent ? (disabled ? "#aaa" : "#fff") : (disabled ? "#b0b0b0" : "#5f5f5f"),
    cursor: disabled ? "default" : "pointer",
    fontSize: 13,
    fontWeight: 700,
    fontFamily: "inherit",
  }
}

/** Small "N" chip pinned to a stroke's top-left corner, matching "[区域 N]" in the prompt. */
function StrokeRegionLabel({
  index,
  x,
  y,
  color,
  faded,
}: {
  index: number
  x: number
  y: number
  color: string
  faded?: boolean
}) {
  const r = 9
  const cx = x - r - 2
  const cy = y - r - 2
  return (
    <g opacity={faded ? 0.55 : 0.95} pointerEvents="none">
      <circle cx={cx} cy={cy} r={r} fill={color} />
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        fill="#fff"
        fontSize={11}
        fontWeight={700}
        fontFamily="inherit"
      >
        {index}
      </text>
    </g>
  )
}

function DrawNoteBadge({ x, y, text, orphaned, regionIndex }: { x: number; y: number; text: string; orphaned?: boolean; regionIndex?: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: "translate(-10px, -100%)",
        maxWidth: 180,
        padding: "8px 10px",
        borderRadius: 8,
        background: orphaned ? "#f3f4f6" : "#fff3a3",
        border: orphaned ? "1px dashed #9ca3af" : "1px solid #e1c84f",
        boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
        color: orphaned ? "#4b5563" : "#1a1a1a",
        fontSize: 13,
        lineHeight: 1.35,
        fontWeight: 600,
        pointerEvents: "none",
        whiteSpace: "pre-wrap",
      }}
    >
      {regionIndex !== undefined && (
        <span
          style={{
            display: "inline-block",
            marginRight: 6,
            padding: "1px 6px",
            borderRadius: 999,
            background: "#cc785c",
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            verticalAlign: "1px",
          }}
        >
          区域 {regionIndex}
        </span>
      )}
      {text}
    </div>
  )
}

function DrawNoteDraft({
  x,
  y,
  onSubmit,
  onCancel,
}: {
  x: number
  y: number
  onSubmit: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState("")
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: "translate(-10px, -100%)",
        width: 190,
        padding: 10,
        borderRadius: 10,
        background: "#fff3a3",
        border: "1px solid #e1c84f",
        boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
        pointerEvents: "auto",
      }}
    >
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            onSubmit(text)
          }
          if (e.key === "Escape") {
            e.preventDefault()
            onCancel()
          }
        }}
        placeholder="添加备注..."
        rows={3}
        style={{ width: "100%", border: "none", outline: "none", resize: "none", background: "transparent", color: "#1a1a1a", fontSize: 14, lineHeight: 1.4, fontFamily: "inherit", boxSizing: "border-box" }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 8 }}>
        <button onClick={onCancel} style={{ padding: "5px 8px", border: "none", borderRadius: 7, background: "rgba(0,0,0,0.08)", color: "#4a4a4a", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>
          取消
        </button>
        <button
          onClick={() => onSubmit(text)}
          disabled={!text.trim()}
          style={{ padding: "5px 10px", border: "none", borderRadius: 7, background: text.trim() ? "#cc785c" : "rgba(0,0,0,0.12)", color: text.trim() ? "#fff" : "#8a8a8a", cursor: text.trim() ? "pointer" : "default", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}
        >
          添加
        </button>
      </div>
    </div>
  )
}
