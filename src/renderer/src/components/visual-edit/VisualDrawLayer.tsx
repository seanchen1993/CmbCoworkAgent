import { useCallback, useRef, useState } from "react"
import type { ClawVisualPoint, ClawVisualStroke, ClawVisualViewport } from "./visual-edit-types"

function getPointerPoint(
  event: React.PointerEvent<HTMLDivElement>,
  viewport: ClawVisualViewport,
  zoom: number
): ClawVisualPoint {
  const rect = event.currentTarget.getBoundingClientRect()
  const scale = Math.max(zoom, 1) / 100
  return {
    x: Math.max(0, (event.clientX - rect.left) / scale + viewport.scrollX),
    y: Math.max(0, (event.clientY - rect.top) / scale + viewport.scrollY)
  }
}

function pointsToPath(points: ClawVisualPoint[]): string {
  if (points.length === 0) return ""
  const [first, ...rest] = points
  return rest.reduce((path, point) => `${path} L ${point.x} ${point.y}`, `M ${first.x} ${first.y}`)
}

function toScreenPoints(
  points: ClawVisualPoint[],
  viewport: ClawVisualViewport,
  scale: number
): ClawVisualPoint[] {
  return points.map((point) => ({
    x: (point.x - viewport.scrollX) * scale,
    y: (point.y - viewport.scrollY) * scale
  }))
}

export function VisualDrawLayer({
  active,
  strokes,
  viewport,
  zoom,
  onStrokeComplete
}: {
  active: boolean
  strokes: ClawVisualStroke[]
  viewport: ClawVisualViewport
  zoom: number
  onStrokeComplete: (stroke: ClawVisualStroke) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<ClawVisualPoint[]>([])
  const draftRef = useRef<ClawVisualPoint[]>([])
  const drawingRef = useRef(false)
  const pointerIdRef = useRef<number | null>(null)
  const scale = Math.max(zoom, 1) / 100

  const finishStroke = useCallback(() => {
    if (!drawingRef.current) return
    drawingRef.current = false
    pointerIdRef.current = null
    const points = draftRef.current
    if (points.length >= 2) {
      onStrokeComplete({
        points,
        color: "#cc785c",
        width: 5
      })
    }
    draftRef.current = []
    setDraft([])
  }, [onStrokeComplete])

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!active || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    drawingRef.current = true
    pointerIdRef.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = getPointerPoint(event, viewport, zoom)
    draftRef.current = [point]
    setDraft([point])
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!active || !drawingRef.current || pointerIdRef.current !== event.pointerId) return
    event.preventDefault()
    const next = getPointerPoint(event, viewport, zoom)
    const last = draftRef.current[draftRef.current.length - 1]
    if (last && Math.hypot(next.x - last.x, next.y - last.y) < 3) return
    const points = [...draftRef.current, next]
    draftRef.current = points
    setDraft(points)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (pointerIdRef.current !== event.pointerId) return
    event.preventDefault()
    finishStroke()
  }

  return (
    <div
      className="absolute inset-0 z-20"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{
        pointerEvents: active ? "auto" : "none",
        cursor: active ? "crosshair" : "default",
        touchAction: "none"
      }}
    >
      <svg width="100%" height="100%" className="block overflow-visible">
        {strokes.map((stroke, index) => (
          <path
            key={index}
            d={pointsToPath(toScreenPoints(stroke.points, viewport, scale))}
            fill="none"
            stroke={stroke.color}
            strokeWidth={Math.max(2, stroke.width * scale)}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.92}
          />
        ))}
        {draft.length > 0 && (
          <path
            d={pointsToPath(toScreenPoints(draft, viewport, scale))}
            fill="none"
            stroke="#cc785c"
            strokeWidth={Math.max(2, 5 * scale)}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.92}
          />
        )}
      </svg>
    </div>
  )
}
