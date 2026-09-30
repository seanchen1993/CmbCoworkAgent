import { MessageSquarePlus, PenLine, SendHorizontal, Trash2, Undo2, X } from "lucide-react"
import type { ClawVisualToolMode } from "./visual-edit-types"
import { cn } from "@/lib/utils"

function ToolButton({
  active,
  disabled,
  title,
  onClick,
  children
}: {
  active?: boolean
  disabled?: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md border text-xs transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
        disabled && "cursor-not-allowed opacity-40"
      )}
    >
      {children}
    </button>
  )
}

export function VisualEditToolbar({
  mode,
  annotationCount,
  submittableCount,
  submitDisabled,
  onModeChange,
  onUndo,
  onClear,
  onSubmit,
  onClose
}: {
  mode: ClawVisualToolMode
  annotationCount: number
  submittableCount: number
  submitDisabled?: boolean
  onModeChange: (mode: ClawVisualToolMode) => void
  onUndo: () => void
  onClear: () => void
  onSubmit: () => void
  onClose: () => void
}): React.JSX.Element {
  const hasAnnotations = annotationCount > 0
  const hasSubmittableAnnotations = submittableCount > 0

  return (
    <div
      className="absolute bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-background/95 px-2.5 py-2 shadow-2xl backdrop-blur"
      onClick={(event) => event.stopPropagation()}
    >
      <ToolButton title="退出标注" onClick={onClose}>
        <X className="size-4" />
      </ToolButton>
      <div className="h-5 w-px bg-border" />
      <ToolButton active={mode === "comment"} title="批注" onClick={() => onModeChange("comment")}>
        <MessageSquarePlus className="size-4" />
      </ToolButton>
      <ToolButton active={mode === "draw"} title="画线" onClick={() => onModeChange("draw")}>
        <PenLine className="size-4" />
      </ToolButton>
      <div className="h-5 w-px bg-border" />
      <ToolButton disabled={!hasAnnotations} title="撤销" onClick={onUndo}>
        <Undo2 className="size-4" />
      </ToolButton>
      <ToolButton disabled={!hasAnnotations} title="清空" onClick={onClear}>
        <Trash2 className="size-4" />
      </ToolButton>
      <button
        type="button"
        disabled={!hasSubmittableAnnotations || submitDisabled}
        onClick={(event) => {
          event.stopPropagation()
          onSubmit()
        }}
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <SendHorizontal className="size-4" />
        交给 Claw 修改
      </button>
    </div>
  )
}
