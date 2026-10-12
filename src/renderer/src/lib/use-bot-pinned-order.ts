import { botApi } from "@/lib/bot-api"
import { useRef, useState, type ButtonHTMLAttributes } from "react"
import { toast } from "sonner"
import { useBotWorkspaceStore } from "./bot-workspace-store"

const dragType = "application/x-cmb-bot-pin"
type Position = "before" | "after"

/** Pointer and keyboard gestures share the same revision-bound Host mutation. */
export function useBotPinnedOrder(query: string, showHidden: boolean) {
  const state = useBotWorkspaceStore()
  const saving = useRef(false)
  const dragged = useRef<string | null>(null)
  const [marker, setMarker] = useState<{ id: string; position: Position } | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const order = state.snapshot?.pinnedOrder
  const enabled = state.host?.capabilities?.includes("pinned-order") && !!order
  const move = async (movedId: string, targetId: string, position: Position) => {
    if (!enabled || !order || saving.current || movedId === targetId) return
    saving.current = true
    setMarker(null)
    try {
      await botApi.reorderPinned({
        nonce: crypto.randomUUID(),
        revision: order.revision,
        movedId,
        targetId,
        position
      })
      await useBotWorkspaceStore.getState().refresh()
      setAnnouncement("置顶顺序已保存")
    } catch (error) {
      // Never silently retry a stale drag against a newer order from another window.
      await useBotWorkspaceStore.getState().refresh()
      toast.error(error instanceof Error ? error.message : "未能保存置顶顺序")
    } finally {
      saving.current = false
    }
  }
  const props = (
    id: string
  ): ButtonHTMLAttributes<HTMLButtonElement> & { "data-drop-position"?: Position } => {
    if (!enabled || !order?.ids.includes(id)) return {}
    return {
      draggable: true,
      "aria-describedby": "bot-pinned-order-help",
      "aria-keyshortcuts":
        "Control+Shift+ArrowUp Control+Shift+ArrowDown Meta+Shift+ArrowUp Meta+Shift+ArrowDown",
      "data-drop-position": marker?.id === id ? marker.position : undefined,
      onDragStart(event) {
        if (saving.current) return event.preventDefault()
        dragged.current = id
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData(dragType, id)
      },
      onDragOver(event) {
        if (
          !dragged.current ||
          dragged.current === id ||
          !event.dataTransfer.types.includes(dragType)
        )
          return
        event.preventDefault()
        event.dataTransfer.dropEffect = "move"
        const bounds = event.currentTarget.getBoundingClientRect()
        const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after"
        setMarker((old) => (old?.id === id && old.position === position ? old : { id, position }))
      },
      onDragLeave(event) {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMarker(null)
      },
      onDragEnd() {
        dragged.current = null
        setMarker(null)
      },
      onDrop(event) {
        const movedId = event.dataTransfer.getData(dragType)
        if (!dragged.current || movedId !== dragged.current || movedId === id) return
        event.preventDefault()
        const bounds = event.currentTarget.getBoundingClientRect()
        void move(movedId, id, event.clientY < bounds.top + bounds.height / 2 ? "before" : "after")
        dragged.current = null
      },
      onKeyDown(event) {
        if (
          !(event.ctrlKey || event.metaKey) ||
          !event.shiftKey ||
          !["ArrowUp", "ArrowDown"].includes(event.key)
        )
          return
        event.preventDefault()
        const visible = order.ids.filter((candidate) => {
          const bot = state.snapshot?.bots.find((bot) => bot.id === candidate)
          return (
            bot &&
            (!bot.hidden || showHidden) &&
            bot.name.toLowerCase().includes(query.toLowerCase())
          )
        })
        const index = visible.indexOf(id)
        const target = visible[index + (event.key === "ArrowUp" ? -1 : 1)]
        if (index >= 0 && target)
          void move(id, target, event.key === "ArrowUp" ? "before" : "after")
      }
    }
  }
  return { props, announcement }
}
