import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import type { CommentItem } from "./types"

const FLOATING_EDGE_GAP = 12

function clampNumber(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

function useFloatingBoxPosition(
  boxRef: RefObject<HTMLDivElement | null>,
  {
    anchorXPercent,
    anchorYPercent,
    viewportWidth,
    viewportHeight,
    width,
    fallbackHeight,
    offset,
    enabled = true
  }: {
    anchorXPercent: number
    anchorYPercent: number
    viewportWidth: number
    viewportHeight: number
    width: number
    fallbackHeight: number
    offset: number
    enabled?: boolean
  }
) {
  const safeViewportWidth = Math.max(1, viewportWidth)
  const safeViewportHeight = Math.max(1, viewportHeight)
  const boxWidth = Math.min(width, Math.max(180, safeViewportWidth - FLOATING_EDGE_GAP * 2))
  const maxHeight = Math.max(80, safeViewportHeight - FLOATING_EDGE_GAP * 2)
  const [measuredHeight, setMeasuredHeight] = useState(fallbackHeight)

  useLayoutEffect(() => {
    if (!enabled) return
    const element = boxRef.current
    if (!element) return

    const updateHeight = () => {
      const nextHeight = element.getBoundingClientRect().height || fallbackHeight
      setMeasuredHeight((prev) => (Math.abs(prev - nextHeight) > 1 ? nextHeight : prev))
    }

    updateHeight()
    if (typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    return () => observer.disconnect()
  }, [boxRef, boxWidth, enabled, fallbackHeight, maxHeight])

  const boxHeight = Math.min(measuredHeight || fallbackHeight, maxHeight)
  const anchorX = (anchorXPercent / 100) * safeViewportWidth
  const anchorY = (anchorYPercent / 100) * safeViewportHeight
  const left = clampNumber(
    anchorX - boxWidth / 2,
    FLOATING_EDGE_GAP,
    safeViewportWidth - boxWidth - FLOATING_EDGE_GAP
  )
  const belowTop = anchorY + offset
  const aboveTop = anchorY - offset - boxHeight
  const canFitBelow = belowTop + boxHeight <= safeViewportHeight - FLOATING_EDGE_GAP
  const canFitAbove = aboveTop >= FLOATING_EDGE_GAP
  const preferredTop = canFitBelow || !canFitAbove ? belowTop : aboveTop
  const top = clampNumber(
    preferredTop,
    FLOATING_EDGE_GAP,
    safeViewportHeight - boxHeight - FLOATING_EDGE_GAP
  )

  return {
    left,
    top,
    width: boxWidth,
    maxHeight,
    overflowY: "auto" as const
  }
}

export function CommentPin({
  comment,
  index,
  pinLeft,
  pinTop,
  viewportWidth = 800,
  viewportHeight = 600,
  isActive,
  onToggle,
  onSend,
  onEdit
}: {
  comment: CommentItem
  index: number
  pinLeft: number
  pinTop: number
  viewportWidth?: number
  viewportHeight?: number
  isActive: boolean
  onToggle: () => void
  onSend: (text: string) => void
  onEdit: (newText: string) => void
}) {
  const AVATAR_SIZE = 26
  const [editState, setEditState] = useState({
    commentId: comment.id,
    sourceText: comment.text,
    value: comment.text
  })
  const popoverRef = useRef<HTMLDivElement>(null)
  const editText =
    editState.commentId === comment.id && editState.sourceText === comment.text
      ? editState.value
      : comment.text
  const hasEdits = editText.trim() !== comment.text.trim()
  const setEditText = (value: string) => {
    setEditState({ commentId: comment.id, sourceText: comment.text, value })
  }
  const popoverStyle = useFloatingBoxPosition(popoverRef, {
    anchorXPercent: pinLeft,
    anchorYPercent: pinTop,
    viewportWidth,
    viewportHeight,
    width: 252,
    fallbackHeight: 210,
    offset: AVATAR_SIZE / 2 + 8,
    enabled: isActive
  })

  const handleClose = () => {
    if (hasEdits && editText.trim()) onEdit(editText.trim())
    onToggle()
  }

  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        title={comment.text}
        style={{
          position: "absolute",
          left: `${pinLeft}%`,
          top: `${pinTop}%`,
          zIndex: 20,
          width: AVATAR_SIZE,
          height: AVATAR_SIZE,
          borderRadius: "50% 50% 50% 0",
          transform: "translate(-50%, -50%) rotate(-45deg)",
          background: "#f59e0b",
          border: "2px solid #fff",
          boxShadow: isActive
            ? "0 0 0 3px rgba(245,158,11,0.35), 0 4px 12px rgba(0,0,0,0.2)"
            : "0 2px 8px rgba(0,0,0,0.18)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          padding: 0,
          transition: "box-shadow 0.15s",
          pointerEvents: "auto"
        }}
      >
        <span
          style={{
            transform: "rotate(45deg)",
            fontSize: 11,
            fontWeight: 700,
            color: "#fff",
            lineHeight: 1,
            fontFamily: "inherit"
          }}
        >
          {index}
        </span>
      </button>

      {isActive && (
        <div
          ref={popoverRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            ...popoverStyle,
            background: "#ffffff",
            borderRadius: 14,
            boxShadow: "0 8px 32px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08)",
            padding: "14px 14px 12px",
            zIndex: 30,
            boxSizing: "border-box",
            pointerEvents: "auto"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                background: "#f59e0b",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                fontWeight: 700,
                color: "#fff",
                flexShrink: 0
              }}
            >
              {index}
            </span>
            <span style={{ fontSize: 11, color: "#8a8a8a", flex: 1 }}>
              {new Date(comment.createdAt).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit"
              })}
            </span>
            <button
              onClick={handleClose}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: 15,
                color: "#aaa",
                padding: "0 2px",
                lineHeight: 1
              }}
            >
              ×
            </button>
          </div>

          <div
            style={{
              display: "inline-block",
              marginBottom: 8,
              padding: "2px 8px",
              borderRadius: 5,
              background: "#fef3c7",
              color: "#92400e",
              fontSize: 11,
              fontFamily: "monospace",
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }}
          >
            {comment.elementDesc}
          </div>

          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                if (editText.trim()) onSend(editText.trim())
              }
              if (e.key === "Escape") {
                e.preventDefault()
                handleClose()
              }
            }}
            rows={3}
            style={{
              width: "100%",
              border: "1px solid #e0ded8",
              borderRadius: 8,
              padding: "7px 9px",
              fontSize: 13,
              fontFamily: "inherit",
              resize: "none",
              outline: "none",
              lineHeight: 1.5,
              color: "#1a1a1a",
              boxSizing: "border-box",
              marginBottom: 10,
              background: "#fafaf8"
            }}
          />

          <div style={{ display: "flex", gap: 7 }}>
            <button
              onClick={handleClose}
              style={{
                flex: 1,
                padding: "6px 0",
                fontSize: 12,
                fontWeight: 500,
                background: "#f5f4f0",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
                color: "#6a6a6a",
                fontFamily: "inherit"
              }}
            >
              {hasEdits ? "保存" : "关闭"}
            </button>
            <button
              onClick={() => {
                if (editText.trim()) onSend(editText.trim())
              }}
              disabled={!editText.trim()}
              style={{
                flex: 2,
                padding: "6px 0",
                fontSize: 12,
                fontWeight: 700,
                background: editText.trim() ? "#cc785c" : "#e0ded8",
                border: "none",
                borderRadius: 8,
                cursor: editText.trim() ? "pointer" : "default",
                color: editText.trim() ? "#fff" : "#aaa",
                fontFamily: "inherit",
                transition: "background 0.12s"
              }}
            >
              发送 →
            </button>
          </div>
        </div>
      )}
    </>
  )
}

export function CommentDraftInput({
  x,
  y,
  viewportWidth = 800,
  viewportHeight = 600,
  elementDesc,
  onSubmit,
  onSend,
  onCancel
}: {
  x: number
  y: number
  viewportWidth?: number
  viewportHeight?: number
  elementDesc: string
  onSubmit: (text: string) => void
  onSend: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const popoverStyle = useFloatingBoxPosition(popoverRef, {
    anchorXPercent: x,
    anchorYPercent: y,
    viewportWidth,
    viewportHeight,
    width: 264,
    fallbackHeight: 220,
    offset: 8
  })

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const canSubmit = text.trim().length > 0

  return (
    <div
      ref={popoverRef}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        ...popoverStyle,
        zIndex: 25,
        background: "#ffffff",
        borderRadius: 14,
        boxShadow: "0 8px 32px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08)",
        padding: "14px 14px 12px",
        boxSizing: "border-box"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: "#f59e0b",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            color: "#fff",
            fontWeight: 700,
            flexShrink: 0
          }}
        >
          +
        </span>
        <span style={{ fontSize: 12, color: "#8a8a8a", fontWeight: 500 }}>添加批注</span>
      </div>

      <div
        style={{
          display: "inline-block",
          marginBottom: 10,
          padding: "3px 10px",
          borderRadius: 6,
          background: "#fef3c7",
          color: "#92400e",
          fontSize: 11,
          fontFamily: "monospace",
          fontWeight: 500,
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }}
      >
        {elementDesc}
      </div>

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            if (canSubmit) onSubmit(text.trim())
          }
          if (e.key === "Escape") {
            e.preventDefault()
            onCancel()
          }
        }}
        placeholder="输入批注内容… (Shift+Enter 换行)"
        rows={3}
        style={{
          width: "100%",
          border: "1px solid #e0ded8",
          borderRadius: 8,
          padding: "8px 10px",
          fontSize: 13,
          fontFamily: "inherit",
          resize: "none",
          outline: "none",
          lineHeight: 1.5,
          color: "#1a1a1a",
          boxSizing: "border-box"
        }}
      />

      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button
          onClick={onCancel}
          style={{
            flex: 1,
            padding: "6px 0",
            fontSize: 12,
            fontWeight: 500,
            background: "#f5f4f0",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
            color: "#6a6a6a",
            fontFamily: "inherit"
          }}
        >
          取消
        </button>
        <button
          onClick={() => {
            if (canSubmit) onSubmit(text.trim())
          }}
          disabled={!canSubmit}
          style={{
            flex: 1.4,
            padding: "6px 0",
            fontSize: 12,
            fontWeight: 600,
            background: canSubmit ? "#f5f4f0" : "#ebebeb",
            border: canSubmit ? "1px solid #c8c6c0" : "1px solid #e0ded8",
            borderRadius: 8,
            cursor: canSubmit ? "pointer" : "default",
            color: canSubmit ? "#1a1a1a" : "#aaa",
            fontFamily: "inherit",
            transition: "all 0.12s"
          }}
        >
          保存
        </button>
        <button
          onClick={() => {
            if (canSubmit) onSend(text.trim())
          }}
          disabled={!canSubmit}
          style={{
            flex: 1.6,
            padding: "6px 0",
            fontSize: 12,
            fontWeight: 700,
            background: canSubmit ? "#cc785c" : "#e0ded8",
            border: "none",
            borderRadius: 8,
            cursor: canSubmit ? "pointer" : "default",
            color: canSubmit ? "#fff" : "#aaa",
            fontFamily: "inherit",
            transition: "background 0.12s"
          }}
        >
          发送 →
        </button>
      </div>
    </div>
  )
}
