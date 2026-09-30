import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { toast } from "sonner"
import { collectNearbyElements, elementFromPagePoint, getElementAnchor } from "./visual-anchor"
import { VisualCommentPin } from "./VisualCommentPin"
import { VisualDrawLayer } from "./VisualDrawLayer"
import { VisualEditToolbar } from "./VisualEditToolbar"
import { getSubmittableVisualAnnotations, getVisualEditSubmitBlock } from "./visual-submit-guards"
import type {
  ClawVisualAnnotation,
  ClawVisualBox,
  ClawVisualFeedbackContext,
  ClawVisualPoint,
  ClawVisualStroke,
  ClawVisualTargetKind,
  ClawVisualToolMode,
  ClawVisualViewport
} from "./visual-edit-types"

function boundsForPoints(points: ClawVisualPoint[]): ClawVisualBox | undefined {
  if (points.length === 0) return undefined
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(Math.max(...xs) - minX),
    height: Math.round(Math.max(...ys) - minY)
  }
}

function screenPoint(
  annotation: Pick<ClawVisualAnnotation, "pageX" | "pageY">,
  viewport: ClawVisualViewport,
  scale: number
): ClawVisualPoint {
  return {
    x: ((annotation.pageX ?? 0) - viewport.scrollX) * scale,
    y: ((annotation.pageY ?? 0) - viewport.scrollY) * scale
  }
}

const FLOATING_PANEL_MARGIN = 12
const DRAFT_PANEL_SIZE = { width: 270, height: 240 }

function floatingPanelPosition(
  point: ClawVisualPoint,
  bounds: { width: number; height: number },
  size: { width: number; height: number }
): { left: number; top: number } {
  const maxLeft = Math.max(FLOATING_PANEL_MARGIN, bounds.width - size.width - FLOATING_PANEL_MARGIN)
  const maxTop = Math.max(FLOATING_PANEL_MARGIN, bounds.height - size.height - FLOATING_PANEL_MARGIN)
  const preferredLeft =
    point.x + FLOATING_PANEL_MARGIN + size.width <= bounds.width
      ? point.x + FLOATING_PANEL_MARGIN
      : point.x - size.width - FLOATING_PANEL_MARGIN
  const preferredTop =
    point.y + FLOATING_PANEL_MARGIN + size.height <= bounds.height
      ? point.y + FLOATING_PANEL_MARGIN
      : point.y - size.height - FLOATING_PANEL_MARGIN

  return {
    left: Math.min(Math.max(FLOATING_PANEL_MARGIN, preferredLeft), maxLeft),
    top: Math.min(Math.max(FLOATING_PANEL_MARGIN, preferredTop), maxTop)
  }
}

function findScrollableParent(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null
  while (current) {
    const style = window.getComputedStyle(current)
    const canScrollY =
      /(auto|scroll|overlay)/.test(style.overflowY) && current.scrollHeight > current.clientHeight
    const canScrollX =
      /(auto|scroll|overlay)/.test(style.overflowX) && current.scrollWidth > current.clientWidth
    if (canScrollY || canScrollX) return current
    current = current.parentElement
  }
  return null
}

export function VisualEditLayer({
  threadId,
  targetKind,
  targetPath,
  targetUrl,
  iframeRef,
  active,
  annotations,
  zoom = 100,
  submitDisabled,
  onClose,
  onAnnotationsChange,
  onSubmit
}: {
  threadId: string
  targetKind: ClawVisualTargetKind
  targetPath?: string
  targetUrl?: string
  iframeRef: RefObject<HTMLIFrameElement | null>
  active: boolean
  annotations: ClawVisualAnnotation[]
  zoom?: number
  submitDisabled?: boolean
  onClose: () => void
  onAnnotationsChange: (
    next: ClawVisualAnnotation[] | ((prev: ClawVisualAnnotation[]) => ClawVisualAnnotation[])
  ) => void
  onSubmit: (context: ClawVisualFeedbackContext) => Promise<boolean | void> | boolean | void
}): React.JSX.Element | null {
  const overlayRef = useRef<HTMLDivElement>(null)
  const draftTextareaRef = useRef<HTMLTextAreaElement>(null)
  const idCounterRef = useRef(1)
  const mountedRef = useRef(false)
  const [mode, setMode] = useState<ClawVisualToolMode>("comment")
  const [draft, setDraft] = useState<ClawVisualAnnotation | null>(null)
  const [draftText, setDraftText] = useState("")
  const [activeId, setActiveId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [viewport, setViewport] = useState<ClawVisualViewport>({
    scrollX: 0,
    scrollY: 0,
    width: 1,
    height: 1
  })
  const scale = Math.max(zoom, 1) / 100

  const nextId = useCallback(() => `A${idCounterRef.current++}`, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const maxId = annotations.reduce((max, annotation) => {
      const match = annotation.id.match(/^A(\d+)$/)
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    idCounterRef.current = Math.max(idCounterRef.current, maxId + 1)
  }, [annotations])

  const syncViewport = useCallback(() => {
    const iframe = iframeRef.current
    const win = iframe?.contentWindow
    const rect = iframe?.getBoundingClientRect()
    setViewport({
      scrollX: win?.scrollX ?? 0,
      scrollY: win?.scrollY ?? 0,
      width: win?.innerWidth ?? rect?.width ?? 1,
      height: win?.innerHeight ?? rect?.height ?? 1
    })
  }, [iframeRef])

  useEffect(() => {
    if (!active) return
    syncViewport()
    const win = iframeRef.current?.contentWindow
    win?.addEventListener("scroll", syncViewport, { passive: true })
    win?.addEventListener("resize", syncViewport)
    window.addEventListener("resize", syncViewport)
    return () => {
      win?.removeEventListener("scroll", syncViewport)
      win?.removeEventListener("resize", syncViewport)
      window.removeEventListener("resize", syncViewport)
    }
  }, [active, iframeRef, syncViewport])

  useEffect(() => {
    if (!draft) return
    const frameId = window.requestAnimationFrame(() => {
      draftTextareaRef.current?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [draft])

  const getPagePointFromEvent = useCallback(
    (event: React.MouseEvent<HTMLDivElement> | React.PointerEvent<HTMLDivElement>) => {
      const rect = overlayRef.current?.getBoundingClientRect()
      if (!rect) return null
      return {
        x: Math.max(0, (event.clientX - rect.left) / scale + viewport.scrollX),
        y: Math.max(0, (event.clientY - rect.top) / scale + viewport.scrollY)
      }
    },
    [scale, viewport.scrollX, viewport.scrollY]
  )

  const makePointAnnotation = useCallback(
    (point: ClawVisualPoint): ClawVisualAnnotation => {
      const element = elementFromPagePoint(iframeRef.current, point)
      const anchor = getElementAnchor(element, point, { targetPath, targetUrl })
      return {
        id: nextId(),
        kind: "comment",
        pageX: point.x,
        pageY: point.y,
        anchor,
        nearbyElements: collectNearbyElements(iframeRef.current, [point]),
        status: "draft",
        createdAt: Date.now()
      }
    },
    [iframeRef, nextId, targetPath, targetUrl]
  )

  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (mode === "draw" || submitting) return
    if (event.target !== overlayRef.current) return
    const point = getPagePointFromEvent(event)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()
    const nextDraft = makePointAnnotation(point)
    setDraft(nextDraft)
    setDraftText("")
    setActiveId(null)
  }

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    const win = iframeRef.current?.contentWindow
    const deltaX = event.deltaX
    const deltaY = event.deltaY
    event.preventDefault()
    event.stopPropagation()

    if (!win) {
      const scrollParent = findScrollableParent(overlayRef.current)
      scrollParent?.scrollBy({ left: deltaX, top: deltaY, behavior: "auto" })
      return
    }

    const beforeX = win.scrollX
    const beforeY = win.scrollY
    win.scrollBy({ left: deltaX, top: deltaY, behavior: "auto" })
    window.requestAnimationFrame(() => {
      if (win.scrollX === beforeX && win.scrollY === beforeY) {
        const scrollParent = findScrollableParent(overlayRef.current)
        scrollParent?.scrollBy({ left: deltaX, top: deltaY, behavior: "auto" })
      }
      syncViewport()
    })
  }

  const handleSaveDraft = (): void => {
    const value = draftText.trim()
    if (!draft || !value) {
      setDraft(null)
      setDraftText("")
      return
    }
    onAnnotationsChange((prev) => [...prev, { ...draft, text: value, status: "pending" }])
    setDraft(null)
    setDraftText("")
  }

  const handleStrokeComplete = useCallback(
    (stroke: ClawVisualStroke): void => {
      const firstPoint = stroke.points[0]
      const element = firstPoint ? elementFromPagePoint(iframeRef.current, firstPoint) : null
      const anchor = firstPoint
        ? getElementAnchor(element, firstPoint, { targetPath, targetUrl })
        : undefined
      const bbox = boundsForPoints(stroke.points)
      setDraft({
        id: nextId(),
        kind: "draw",
        pageX: bbox ? bbox.x + bbox.width / 2 : firstPoint?.x,
        pageY: bbox ? bbox.y + bbox.height / 2 : firstPoint?.y,
        stroke,
        bbox,
        anchor,
        nearbyElements: collectNearbyElements(iframeRef.current, stroke.points),
        status: "draft",
        createdAt: Date.now()
      })
      setDraftText("")
      setActiveId(null)
    },
    [iframeRef, nextId, targetPath, targetUrl]
  )

  const handleUndo = (): void => {
    setDraft(null)
    setDraftText("")
    onAnnotationsChange((prev) => prev.slice(0, -1))
  }

  const handleClear = (): void => {
    setDraft(null)
    setDraftText("")
    setActiveId(null)
    onAnnotationsChange([])
  }

  const handleSubmit = async (): Promise<void> => {
    if (submitting) return
    const block = getVisualEditSubmitBlock({ draft, annotations })
    if (block) {
      setActiveId(block.annotation?.id ?? null)
      toast.warning(block.message)
      return
    }
    const submittableAnnotations = getSubmittableVisualAnnotations(annotations)
    const submittableIds = new Set(submittableAnnotations.map((annotation) => annotation.id))
    setSubmitting(true)
    const context: ClawVisualFeedbackContext = {
      threadId,
      targetKind,
      targetPath,
      targetUrl,
      annotations: submittableAnnotations,
      submittedAt: Date.now()
    }
    try {
      const submitted = await onSubmit(context)
      if (submitted === false) return
      onAnnotationsChange((prev) =>
        prev.map((annotation) =>
          submittableIds.has(annotation.id) && annotation.status === "pending"
            ? { ...annotation, status: "submitted" }
            : annotation
        )
      )
      if (mountedRef.current) {
        onClose()
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }

  const submittableCount = useMemo(
    () => getSubmittableVisualAnnotations(annotations).length,
    [annotations]
  )

  const strokes = useMemo(
    () =>
      annotations
        .filter((annotation) => annotation.kind === "draw" && annotation.stroke)
        .map((annotation) => annotation.stroke as ClawVisualStroke),
    [annotations]
  )
  const visibleStrokes = useMemo(() => {
    if (draft?.kind === "draw" && draft.stroke) {
      return [...strokes, draft.stroke]
    }
    return strokes
  }, [draft, strokes])

  if (!active) return null

  const overlaySize = {
    width: overlayRef.current?.clientWidth ?? viewport.width,
    height: overlayRef.current?.clientHeight ?? viewport.height
  }
  const draftPosition = draft
    ? floatingPanelPosition(screenPoint(draft, viewport, scale), overlaySize, DRAFT_PANEL_SIZE)
    : null

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-30 overflow-hidden bg-transparent"
      onClick={handleOverlayClick}
      onWheel={handleWheel}
      style={{
        cursor: mode === "draw" ? "crosshair" : "copy",
        pointerEvents: "auto"
      }}
    >
      <div className="pointer-events-none absolute left-3 top-3 z-40 rounded-md border border-border bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm">
        视觉标注模式 · {mode === "comment" ? "批注" : "画线"}
      </div>
      <VisualDrawLayer
        active={mode === "draw" && !submitting}
        strokes={visibleStrokes}
        viewport={viewport}
        zoom={zoom}
        onStrokeComplete={handleStrokeComplete}
      />
      {annotations
        .filter(
          (annotation) =>
            typeof annotation.pageX === "number" && typeof annotation.pageY === "number"
        )
        .map((annotation) => {
          const point = screenPoint(annotation, viewport, scale)
          return (
            <VisualCommentPin
              key={annotation.id}
              annotation={annotation}
              x={point.x}
              y={point.y}
              containerSize={overlaySize}
              active={activeId === annotation.id}
              onToggle={() =>
                setActiveId((prev) => (prev === annotation.id ? null : annotation.id))
              }
              onTextChange={(text) => {
                onAnnotationsChange((prev) =>
                  prev.map((item) =>
                    item.id === annotation.id ? { ...item, text, status: "pending" } : item
                  )
                )
                setActiveId(null)
              }}
              onDelete={() => {
                onAnnotationsChange((prev) => prev.filter((item) => item.id !== annotation.id))
                setActiveId(null)
              }}
            />
          )
        })}
      {draft && (
        <div
          className="absolute z-50 w-[270px] rounded-lg border border-border bg-background p-3 shadow-2xl"
          style={{
            left: draftPosition?.left ?? FLOATING_PANEL_MARGIN,
            top: draftPosition?.top ?? FLOATING_PANEL_MARGIN
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">
              {draft.kind === "draw" ? "描述画线区域" : "添加批注"} · {draft.id}
            </span>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                setDraft(null)
                setDraftText("")
              }}
            >
              ×
            </button>
          </div>
          {draft.anchor?.screenLabel && (
            <div className="mb-2 truncate rounded bg-amber-50 px-2 py-1 font-mono text-[11px] text-amber-900">
              {draft.anchor.screenLabel}
            </div>
          )}
          <textarea
            ref={draftTextareaRef}
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            className="min-h-[88px] w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
            placeholder="描述这里需要怎么改"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                setDraft(null)
                setDraftText("")
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              onClick={handleSaveDraft}
            >
              保存
            </button>
          </div>
        </div>
      )}
      <VisualEditToolbar
        mode={mode}
        annotationCount={annotations.length}
        submittableCount={submittableCount}
        submitDisabled={submitDisabled || submitting}
        onModeChange={(nextMode) => {
          setMode(nextMode)
          setDraft(null)
          setDraftText("")
          setActiveId(null)
        }}
        onUndo={handleUndo}
        onClear={handleClear}
        onSubmit={() => void handleSubmit()}
        onClose={onClose}
      />
    </div>
  )
}
