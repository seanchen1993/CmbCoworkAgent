import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore, useCallback } from "react"
import { createPortal } from "react-dom"
import { Toaster, toast as nativeToast, type ExternalToast } from "sonner"
import { ChatTransientToasts, type ChatToastKind } from "./chat-transient-toasts"
import {
  readFunctionPresentation,
  subscribeFunctionPresentation,
  readThreadToastBlock
} from "./function-presentation"
import { desktopElementPresented } from "./function-desktop"
import { getThemePreference, subscribeThemePreference } from "./theme-preference"
import { getThemeDefinition } from "./theme-registry"

class ChatToastRouting {
  private queue?: ChatTransientToasts
  private live = false
  activate(queue: ChatTransientToasts | undefined): void {
    this.queue = queue
    this.live = true
  }
  close(): void {
    this.live = false
  }
  current(): { live: boolean; queue?: ChatTransientToasts } {
    return { live: this.live, queue: this.queue }
  }
}

export function useChatTransientToasts(thread: string, enabled: boolean) {
  const routing = useMemo(() => new ChatToastRouting(), [thread])
  const queue = useMemo(
    () =>
      enabled
        ? new ChatTransientToasts(thread, crypto.randomUUID(), {
            show: (kind, text, options) => nativeToast[kind](text, options),
            dismiss: (id) => {
              nativeToast.dismiss(id)
            },
            originalIds: (owner) =>
              nativeToast
                .getToasts()
                .filter(
                  (row) =>
                    "className" in row &&
                    row.className?.split(/\s+/).includes(`devclaw-original-${owner}`)
                )
                .map((row) => row.id)
          })
        : undefined,
    [thread, enabled]
  )
  useLayoutEffect(() => routing.activate(queue), [routing, queue])
  useLayoutEffect(() => () => routing.close(), [routing])
  const version = useSyncExternalStore(
    queue?.subscribe ?? (() => () => {}),
    queue?.snapshot ?? (() => 0)
  )
  const presentation = useSyncExternalStore(
    useCallback((listener) => subscribeFunctionPresentation(thread, listener), [thread]),
    useCallback(() => readFunctionPresentation(thread), [thread])
  )
  const theme = useSyncExternalStore(
    subscribeThemePreference,
    getThemePreference,
    getThemePreference
  )
  useEffect(() => {
    if (!queue) return
    let frame = 0,
      closed = false
    const read = () => {
      const { present, held } = readThreadToastBlock(thread)
      const container = document.querySelector<HTMLElement>(
        `[data-chat-transient-owner="${CSS.escape(queue.owner)}"]`
      )
      const node = container?.querySelector<HTMLElement>(
        `[data-sonner-toast].${CSS.escape(`devclaw-transient-${queue.activeId}`)}[data-mounted='true'][data-visible='true'][data-removed='false']`
      )
      queue.present(
        present,
        held,
        desktopElementPresented(node ?? null),
        Boolean(node?.matches(":hover, :focus-within"))
      )
    }
    const schedule = () => {
      if (frame || closed) return
      if (document.visibilityState !== "visible") {
        queue.present(false, true, false, false)
        return
      }
      frame = requestAnimationFrame(() => {
        frame = 0
        read()
      })
    }
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.target instanceof HTMLElement &&
            (record.target.closest("[data-chat-transient-owner]") ||
              [...record.addedNodes, ...record.removedNodes].some(
                (node) => node instanceof HTMLElement && node.querySelector("[data-sonner-toast]")
              ))
        )
      )
        schedule()
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-visible", "data-mounted", "data-removed", "hidden", "style", "class"]
    })
    const stopPresentation = subscribeFunctionPresentation(thread, schedule)
    const stopQueue = queue.subscribe(schedule)
    const visibility = () => {
      if (document.visibilityState !== "visible") {
        cancelAnimationFrame(frame)
        frame = 0
        queue.present(false, true, false, false)
      } else schedule()
    }
    document.addEventListener("visibilitychange", visibility)
    for (const name of ["pointerover", "pointerout", "focusin", "focusout", "scroll"])
      document.addEventListener(name, schedule, true)
    window.addEventListener("resize", schedule)
    schedule()
    return () => {
      closed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      stopPresentation()
      stopQueue()
      document.removeEventListener("visibilitychange", visibility)
      for (const name of ["pointerover", "pointerout", "focusin", "focusout", "scroll"])
        document.removeEventListener(name, schedule, true)
      window.removeEventListener("resize", schedule)
      queue.close()
    }
  }, [queue, thread])
  const methods = useMemo(() => {
    const method = (kind: ChatToastKind) => (text: string, options?: ExternalToast) => {
      const { live, queue } = routing.current()
      if (!live) return options?.id ?? crypto.randomUUID()
      if (!queue) return nativeToast[kind](text, options)
      const { present, held } = readThreadToastBlock(thread)
      queue.present(present, held, false, false)
      return queue.show(kind, text, options)
    }
    return {
      success: method("success"),
      error: method("error"),
      info: method("info"),
      warning: method("warning"),
      message: method("message"),
      dismiss: (id?: string | number) => {
        const { live, queue } = routing.current()
        if (!live) return
        if (queue) queue.dismiss(id)
        else nativeToast.dismiss(id)
      }
    }
  }, [routing, thread])
  const held = presentation.held
  void version
  return {
    toast: methods,
    toaster: queue
      ? createPortal(
          <div data-chat-transient-owner={queue.owner} hidden={held}>
            <Toaster
              id={queue.owner}
              position="top-center"
              richColors
              duration={2200}
              theme={getThemeDefinition(theme).colorScheme}
              visibleToasts={1}
            />
          </div>,
          document.body
        )
      : null
  }
}
