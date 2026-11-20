import { useLayoutEffect, type RefObject } from "react"

/** Layout only. No chat state, stream subscription or per-token measurement. */
export function useFloatingChatLayout(rootRef: RefObject<HTMLDivElement | null>, threadId: string) {
  useLayoutEffect(() => {
    const chat = rootRef.current
    const owner = chat?.closest('[data-thread-floating-chat="true"], [data-bot-floating-chat="true"]')
    const dock = chat?.querySelector<HTMLElement>('[data-chat-footer]')
    const viewport = chat?.querySelector<HTMLElement>('[data-chat-scroll] > [data-radix-scroll-area-viewport]')
    if (!chat || !owner || !dock || !viewport) return
    const header = owner.querySelector<HTMLElement>(':scope > [data-thread-floating-header], :scope > .bot-personal-header')
    chat.dataset.floatingChat = "true"
    const setInset = (name: string, value: number) => {
      const next = `${Math.ceil(value)}px`
      if (chat.style.getPropertyValue(name) !== next) chat.style.setProperty(name, next)
    }
    const measure = () => {
      if (header && owner instanceof HTMLElement) {
        const value = `${Math.ceil(header.getBoundingClientRect().height)}px`
        if (owner.style.getPropertyValue("--chat-floating-header-height") !== value) {
          owner.style.setProperty("--chat-floating-header-height", value)
        }
      }
      // Measure flow height, not scrollHeight: upward-opening menus are not
      // part of the dock and must neither expand nor be clipped by it.
      const height = dock.getBoundingClientRect().height
      const expanded = height > chat.clientHeight * 0.65
      if (expanded) chat.dataset.chatDockExpanded = "true"
      else delete chat.dataset.chatDockExpanded
      setInset("--chat-composer-inset", expanded ? 0 : height)
      setInset("--chat-header-inset", header ? Math.max(0,
        header.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top) : 0)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(dock)
    observer.observe(chat)
    observer.observe(viewport)
    if (header) observer.observe(header)
    return () => {
      observer.disconnect()
      delete chat.dataset.floatingChat
      delete chat.dataset.chatDockExpanded
      chat.style.removeProperty("--chat-composer-inset")
      chat.style.removeProperty("--chat-header-inset")
      if (owner instanceof HTMLElement) owner.style.removeProperty("--chat-floating-header-height")
    }
  }, [rootRef, threadId])
}
