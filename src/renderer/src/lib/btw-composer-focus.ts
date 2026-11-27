import { useBtwChat } from "./btw-chat"
import { useAppStore } from "./store"

export function focusBtwPaneComposer(pane: HTMLElement): void {
  const chat = pane.querySelector<HTMLElement>('[data-chat-surface="btw"]')
  const target = chat?.querySelector<HTMLTextAreaElement>("textarea.composer-textarea:enabled") ??
    chat ?? pane.querySelector<HTMLButtonElement>("[data-btw-active-tab]") ?? pane
  if (document.activeElement !== target) target.focus({ preventScroll: true })
}

export function prepareBtwComposerFocus(parentId: string): (id: string | undefined) => void {
  const intent = new AbortController()
  const cancel = () => intent.abort()
  for (const type of ["pointerdown", "keydown", "focusin"]) {
    window.addEventListener(type, cancel, { capture: true, signal: intent.signal })
  }
  return id => {
    if (!id || intent.signal.aborted) {
      cancel()
      return
    }
    requestAnimationFrame(() => {
      if (intent.signal.aborted) return
      cancel()
      const app = useAppStore.getState()
      if (app.currentThreadId !== parentId || app.mainView !== "thread" || app.rightModule !== "btw" ||
        app.rightPanelCollapsed || app.showCustomizeView || useBtwChat.getState().selected[parentId] !== id) return
      const pane = document.querySelector<HTMLElement>("[data-btw-pane]")
      if (pane?.dataset.btwPane === id) focusBtwPaneComposer(pane)
    })
  }
}
