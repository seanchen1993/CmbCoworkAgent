import { useEffect, useRef, type RefObject } from "react"
import { FunctionPresentation } from "./function-presentation"
import {
  desktopElementVisible,
  desktopChatRegions,
  readDesktopSelection,
  publishDesktopSelection,
  readDesktopPaneDrawings,
  type CapturedDesktopSelection
} from "./function-desktop"

export function useFunctionDesktop(
  threadId: string,
  enabled: boolean,
  root: RefObject<HTMLElement | null>,
  working: boolean
): void {
  const current = useRef({ working })
  current.current = { working }
  const completion = useRef<((working: boolean) => void) | null>(null)
  useEffect(() => {
    if (!enabled || !window.api.mods.desktopAttach) return
    const owner = crypto.randomUUID()
    let alive = true,
      revision = 0,
      selected: CapturedDesktopSelection | undefined,
      turnSelection: number | undefined,
      wasWorking = current.current.working
    const ownsRoot = () => root.current?.dataset.chatThreadId === threadId
    const regions = () =>
      root.current && ownsRoot() ? desktopChatRegions(root.current, threadId) : []
    const present = () =>
      alive &&
      ownsRoot() &&
      document.visibilityState === "visible" &&
      desktopElementVisible(root.current)
    const clear = () => {
      selected = undefined
      revision++
    }
    const changed = () => {
      const value = readDesktopSelection(regions())
      if (value) {
        selected = value
        revision++
      } else {
        const active = document.activeElement
        const hasInputSelection =
          (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
          active.selectionStart !== null &&
          active.selectionEnd !== null &&
          active.selectionEnd > active.selectionStart
        if (hasInputSelection || document.getSelection()?.isCollapsed === false) clear()
      }
      // Clicking the command/button removes browser highlighting; retain the last
      // deliberate selection until Escape, a new selection, or its action completes.
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && present()) clear()
    }
    const pointer = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || target.closest("button, [role='button'], select"))
        return
      queueMicrotask(() => {
        if (alive) changed()
      })
    }
    const keyboardSelection = (event: KeyboardEvent) => {
      if (event.shiftKey || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a"))
        changed()
    }
    // Programmatic selection from slash completion or a redraw must not replace
    // the text the person deliberately selected before running their command.
    document.addEventListener("pointerup", pointer)
    document.addEventListener("keyup", keyboardSelection)
    document.addEventListener("keydown", key)
    completion.current = (working) => {
      if (working && !wasWorking) turnSelection = revision
      if (!working && wasWorking && turnSelection === revision) clear()
      wasWorking = working
    }
    let ready = window.api.mods.desktopAttach(threadId, owner)
    const presentation = typeof window.api.mods.desktopFeedback === "function"
      ? new FunctionPresentation(threadId, owner, () => ownsRoot() ? root.current : null, ready)
      : undefined
    const stop = window.api.mods.onDesktopRequest(async (request) => {
      if (request.threadId !== threadId || request.owner !== owner) return
      try {
        await ready
        if (!alive) return
        if (request.kind === "copy") {
          await window.api.mods.desktopCopy({
            threadId,
            owner,
            requestId: request.requestId,
            present: present()
          })
          return
        }
        if (request.kind === "clear-selection" && request.revision === revision) clear()
        await window.api.mods.desktopRespond({
          threadId,
          owner,
          requestId: request.requestId,
          present: present(),
          revision,
          ...(request.kind === "selection"
            ? {
                selection: present() ? (publishDesktopSelection(selected, regions()) ?? null) : null
              }
            : {}),
          ...(request.kind === "panes"
            ? { drawings: present() ? readDesktopPaneDrawings(regions()) : [] }
            : {})
        })
      } catch {
        /* A destroyed or revoked owner cannot complete an old desktop request. */
      }
    })
    const stopConfiguration = window.api.mods.onConfigurationChanged(() => {
      clear()
      // Retire all in-flight requests even when this chat stays mounted.
      ready = ready
        .catch(() => undefined)
        .then(() => {
          if (alive) return window.api.mods.desktopAttach(threadId, owner)
          return undefined
        })
      void ready.catch(() => undefined)
      presentation?.rebind(ready)
    })
    void ready.catch(() => undefined)
    return () => {
      alive = false
      selected = undefined
      completion.current = null
      presentation?.close()
      stop()
      stopConfiguration()
      document.removeEventListener("pointerup", pointer)
      document.removeEventListener("keyup", keyboardSelection)
      document.removeEventListener("keydown", key)
      void window.api.mods.desktopDetach(threadId, owner).catch(() => undefined)
    }
  }, [threadId, enabled, root])
  useEffect(() => {
    completion.current?.(working)
  }, [working])
}
