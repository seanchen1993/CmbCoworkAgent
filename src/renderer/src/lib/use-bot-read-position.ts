import { useEffect, type RefObject } from "react"
import { useBotWorkspaceStore } from "./bot-workspace-store"

/** Only acknowledge content actually brought into a visible, focused transcript. */
export function useBotReadPosition(
  container: RefObject<HTMLElement | null>,
  conversationId: string | null,
  messageCount: number
): void {
  useEffect(() => {
    const node = container.current
    if (!node || !conversationId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false,
      running = false
    const inspect = async () => {
      if (disposed || running || document.visibilityState !== "visible" || !document.hasFocus())
        return
      const state = useBotWorkspaceStore.getState()
      if (state.selected !== conversationId || state.opening[conversationId]) return
      const viewport = node.getBoundingClientRect()
      let through = 0
      for (const message of node.querySelectorAll<HTMLElement>("[data-message-sequence]")) {
        const bounds = message.getBoundingClientRect()
        if (bounds.bottom > viewport.top && bounds.bottom <= viewport.bottom + 1)
          through = Math.max(through, Number(message.dataset.messageSequence))
      }
      if (!through) return
      running = true
      try {
        await state.markRead(conversationId, through)
      } finally {
        running = false
      }
    }
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void inspect(), 180)
    }
    node.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("focus", schedule)
    document.addEventListener("visibilitychange", schedule)
    const resize = new ResizeObserver(schedule)
    resize.observe(node)
    schedule()
    return () => {
      disposed = true
      clearTimeout(timer)
      resize.disconnect()
      node.removeEventListener("scroll", schedule)
      window.removeEventListener("focus", schedule)
      document.removeEventListener("visibilitychange", schedule)
    }
  }, [container, conversationId, messageCount])
}
