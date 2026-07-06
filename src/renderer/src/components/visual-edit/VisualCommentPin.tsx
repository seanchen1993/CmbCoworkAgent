import { useState } from "react"
import { Check, Trash2, X } from "lucide-react"
import type { ClawVisualAnnotation } from "./visual-edit-types"

const FLOATING_PANEL_MARGIN = 12
const COMMENT_PANEL_SIZE = { width: 260, height: 240 }

function statusLabel(status: ClawVisualAnnotation["status"]): string {
  switch (status) {
    case "submitted":
      return "已提交"
    case "resolved":
      return "已处理"
    case "unresolved":
      return "未确认"
    case "stale":
      return "已失效"
    case "pending":
      return "待提交"
    default:
      return "草稿"
  }
}

function floatingPanelPosition(
  point: { x: number; y: number },
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

export function VisualCommentPin({
  annotation,
  x,
  y,
  containerSize,
  active,
  onToggle,
  onTextChange,
  onDelete
}: {
  annotation: ClawVisualAnnotation
  x: number
  y: number
  containerSize: { width: number; height: number }
  active: boolean
  onToggle: () => void
  onTextChange: (text: string) => void
  onDelete: () => void
}): React.JSX.Element {
  const [editState, setEditState] = useState({
    annotationId: annotation.id,
    sourceText: annotation.text ?? "",
    value: annotation.text ?? ""
  })
  const value =
    editState.annotationId === annotation.id && editState.sourceText === (annotation.text ?? "")
      ? editState.value
      : (annotation.text ?? "")
  const setValue = (nextValue: string): void => {
    setEditState({
      annotationId: annotation.id,
      sourceText: annotation.text ?? "",
      value: nextValue
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        title={annotation.text || annotation.id}
        className="absolute z-30 flex size-7 items-center justify-center rounded-full border-2 border-white text-[10px] font-bold text-white shadow-lg transition-transform hover:scale-105"
        style={{
          left: x,
          top: y,
          transform: "translate(-50%, -50%)",
          background: "#f59e0b"
        }}
      >
        {annotation.id}
      </button>

      {active && (
        <div
          className="absolute z-40 w-[260px] rounded-lg border border-border bg-background p-3 shadow-2xl"
          style={floatingPanelPosition({ x, y }, containerSize, COMMENT_PANEL_SIZE)}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {annotation.id}
            </span>
            <span className="flex-1 truncate text-[11px] text-muted-foreground">
              {statusLabel(annotation.status)}
            </span>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onToggle}
              aria-label="关闭标注"
            >
              <X className="size-3.5" />
            </button>
          </div>
          {annotation.anchor?.screenLabel && (
            <div className="mb-2 truncate rounded bg-amber-50 px-2 py-1 font-mono text-[11px] text-amber-900">
              {annotation.anchor.screenLabel}
            </div>
          )}
          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="min-h-[82px] w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
            placeholder="描述这里需要怎么改"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
              onClick={onDelete}
            >
              <Trash2 className="size-3.5" />
              删除
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              onClick={() => onTextChange(value.trim())}
            >
              <Check className="size-3.5" />
              保存
            </button>
          </div>
        </div>
      )}
    </>
  )
}
