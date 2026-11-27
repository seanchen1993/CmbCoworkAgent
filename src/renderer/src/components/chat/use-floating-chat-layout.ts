import { useCallback, useLayoutEffect, type RefObject } from "react"

const mainComposerActionsChanged = new EventTarget()
type MainComposerActionsChange = { actions: HTMLDivElement; attached: boolean }

export function useMainComposerActionsRef(threadId: string, enabled: boolean) {
  const attach = useCallback((actions: HTMLDivElement | null) => {
    if (!actions) return
    const notify = (attached: boolean) => {
      mainComposerActionsChanged.dispatchEvent(
        new CustomEvent<MainComposerActionsChange>(threadId, { detail: { actions, attached } })
      )
    }
    notify(true)
    return () => notify(false)
  }, [threadId])
  return enabled ? attach : undefined
}

export function useBtwComposerToolbarHeight(paneRef: RefObject<HTMLElement | null>, parentId: string, enabled: boolean) {
  useLayoutEffect(() => {
    const pane = paneRef.current
    if (!enabled || !pane) return

    const property = "--btw-toolbar-height"
    let observed: HTMLDivElement | null = null
    // A long model name can add a horizontal scrollbar to the main toolbar.
    const observer = new ResizeObserver(([entry]) => {
      if (entry?.target !== observed) return
      const height = entry?.borderBoxSize[0]?.blockSize
      if (height) {
        const value = `${height}px`
        if (pane.style.getPropertyValue(property) !== value) pane.style.setProperty(property, value)
      } else {
        pane.style.removeProperty(property)
      }
    })
    const observeActions = (actions: HTMLDivElement | null) => {
      observer.disconnect()
      pane.style.removeProperty(property)
      observed = actions
      if (actions) observer.observe(actions, { box: "border-box" })
    }
    const onActionsChange = (event: Event) => {
      const { actions, attached } = (event as CustomEvent<MainComposerActionsChange>).detail
      if (attached) observeActions(actions)
      else if (actions === observed) observeActions(null)
    }

    mainComposerActionsChanged.addEventListener(parentId, onActionsChange)
    observeActions(document.querySelector<HTMLDivElement>(
      `[data-chat-surface="default"][data-chat-thread-id="${CSS.escape(parentId)}"] [data-composer-actions]`
    ))
    return () => {
      mainComposerActionsChanged.removeEventListener(parentId, onActionsChange)
      observer.disconnect()
      pane.style.removeProperty(property)
    }
  }, [paneRef, parentId, enabled])
}

/** Layout only. No chat state, stream subscription or per-token measurement. */
export function useFloatingChatLayout(rootRef: RefObject<HTMLDivElement | null>, threadId: string, resizeInput: () => void) {
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
    let lastWidth: number | undefined
    const measure = () => {
      cancelAnimationFrame(followUp)
      // ResizeObserver runs after layout. Read all geometry before changing insets.
      const headerRect = header?.getBoundingClientRect()
      const headerInset = headerRect ? Math.max(0, headerRect.bottom - viewport.getBoundingClientRect().top) : 0
      const { height, width } = dock.getBoundingClientRect()
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
      if (lastWidth !== undefined && width > 0 && width !== lastWidth) resizeInput()
      lastWidth = width
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
  }, [rootRef, threadId, resizeInput])
}
