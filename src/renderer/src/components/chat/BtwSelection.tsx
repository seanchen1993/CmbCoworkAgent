import { useEffect, useState, type RefObject } from "react"
import { MessageSquareText } from "lucide-react"
import type { BtwReference } from "@/lib/btw-references"

function selectedRow(root: HTMLElement) {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return
  const rowAt = (node: Node | null) => {
    const element = node instanceof Element ? node : node?.parentElement
    if (!element || element.closest("button, input, textarea, [role=button], time, [role=dialog]")) return
    return element.closest<HTMLElement>("[data-chat-message-id]")
  }
  const row = rowAt(selection.anchorNode)
  if (!row || row !== rowAt(selection.focusNode) || !root.contains(row)) return
  const text = selection.toString()
  return text.trim() ? { selection, row, text } : undefined
}

export function BtwSelection({ root, parentId, onAddToSide }: {
  root: RefObject<HTMLDivElement | null>
  parentId: string
  onAddToSide: (reference: BtwReference) => void
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const chat = root.current
    if (!chat) return
    const clear = () => setPosition(null)
    function update() {
      const target = selectedRow(chat!)
      if (!target) { clear(); return }
      const box = target.selection.getRangeAt(0).getBoundingClientRect()
      const bounds = chat!.getBoundingClientRect()
      setPosition({ x: Math.max(4, Math.min(box.left - bounds.left, bounds.width - 150)), y: Math.max(4, box.top - bounds.top - 34) })
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" ? clear() : update()
    const clearOnOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest("[data-chat-selection-actions]"))) clear()
    }
    chat.addEventListener("pointerup", update)
    chat.addEventListener("keyup", onKey)
    document.addEventListener("pointerdown", clearOnOutside)
    chat.addEventListener("scroll", clear, true)
    return () => {
      document.removeEventListener("pointerdown", clearOnOutside)
      chat.removeEventListener("keyup", onKey)
      chat.removeEventListener("pointerup", update)
      chat.removeEventListener("scroll", clear, true)
    }
  }, [root, parentId])
  function addReference() {
    setPosition(null)
    const target = root.current && selectedRow(root.current)
    if (!target) return
    onAddToSide({ parentId, rowId: target.row.dataset.chatMessageId!, role: target.row.dataset.messageRole || "assistant", text: target.text })
    target.selection.removeAllRanges()
  }

  if (!position) return null
  return (
    <button type="button" data-chat-selection-actions data-add-side-selection
      style={{ left: position.x, top: position.y }}
      className="absolute z-30 flex h-8 items-center gap-1.5 rounded-lg border bg-popover px-2 text-xs shadow-md hover:bg-muted"
      onMouseDown={event => event.preventDefault()} onClick={addReference}>
      <MessageSquareText className="size-3.5" />在辅助对话中提问
    </button>
  )
}
