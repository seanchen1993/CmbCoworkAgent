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
    let followUp = 0
    const measure = () => {
      cancelAnimationFrame(followUp)
      // ResizeObserver runs after layout. Read all geometry before changing insets.
      const headerRect = header?.getBoundingClientRect()
      const headerInset = headerRect ? Math.max(0, headerRect.bottom - viewport.getBoundingClientRect().top) : 0
      const height = dock.getBoundingClientRect().height
      const expanded = height > chat.clientHeight * 0.65
      let flowChanged = false
      if (headerRect && owner instanceof HTMLElement) {
        const value = `${Math.ceil(headerRect.height)}px`
        if (owner.style.getPropertyValue("--chat-floating-header-height") !== value) {
          owner.style.setProperty("--chat-floating-header-height", value)
          flowChanged = true
        }
      }
      if (expanded !== (chat.dataset.chatDockExpanded === "true")) {
        if (expanded) chat.dataset.chatDockExpanded = "true"
        else delete chat.dataset.chatDockExpanded
        flowChanged = true
      }
      setInset("--chat-composer-inset", expanded ? 0 : height)
      setInset("--chat-header-inset", headerInset)
      // A header or dock can move the viewport without resizing it.
      if (flowChanged) followUp = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(dock)
    observer.observe(chat)
    observer.observe(viewport)
    if (header) observer.observe(header)
    return () => {
      cancelAnimationFrame(followUp)
      observer.disconnect()
      delete chat.dataset.floatingChat
      delete chat.dataset.chatDockExpanded
      chat.style.removeProperty("--chat-composer-inset")
      chat.style.removeProperty("--chat-header-inset")
      if (owner instanceof HTMLElement) owner.style.removeProperty("--chat-floating-header-height")
    }
  }, [rootRef, threadId])
}
