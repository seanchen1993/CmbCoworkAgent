import { hasReadableChatSessionBody, selectChatSessionSaveAnchor } from "./chat-session-save-anchor"

interface RestorePosition {
  element: HTMLElement
  offset: number
  temporary: boolean
}

/** A cold saved row must not evict text that has already become readable. */
export function createChatSessionRestorePosition(): {
  resolve(viewport: HTMLElement, target: HTMLElement | undefined, offset: number): RestorePosition | null
} {
  let held: { element: HTMLElement, messageId: string, offset: number } | null = null
  return {
    resolve(viewport, target, offset) {
      // Recycled targets need the existing bounded index reveal to mount their read again.
      // Do not let a stale temporary position undo that navigation on the next frame.
      if (!target) {
        held = null
        return null
      }
      const ready = target && !target.querySelector("[data-function-site-pending]") &&
        (!target.querySelector("[data-function-site]") || hasReadableChatSessionBody(target))
      if (ready) {
        held = null
        return { element: target, offset, temporary: false }
      }
      if (held && (!viewport.contains(held.element) ||
        held.element.dataset.chatMessageId !== held.messageId ||
        !hasReadableChatSessionBody(held.element))) held = null
      if (!held) {
        const anchor = selectChatSessionSaveAnchor(viewport)
        const element = anchor && Array.from(viewport.querySelectorAll<HTMLElement>(
          "[data-chat-message-id]"
        )).find(row => row.dataset.chatMessageId === anchor.messageId)
        const rect = element?.getBoundingClientRect()
        const bounds = viewport.getBoundingClientRect()
        if (element && anchor && rect && rect.width > 0 && rect.height > 0 &&
          rect.bottom > bounds.top && rect.top < bounds.bottom && hasReadableChatSessionBody(element)) {
          held = { element, messageId: anchor.messageId, offset: anchor.offsetFromViewportTop }
        }
      }
      return held ? { element: held.element, offset: held.offset, temporary: true } : null
    }
  }
}
