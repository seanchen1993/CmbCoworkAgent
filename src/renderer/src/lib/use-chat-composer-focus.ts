import { useEffect, type RefObject } from "react"
import { CHAT_COMPOSER_FOCUS_EVENT, consumeChatComposerFocus } from "./chat-flow-use"
import { useAppStore } from "@/lib/store"

/** Consume only an explicit focus intent for the visible chat and exact workspace. */
export function useChatComposerFocus(
  input: RefObject<HTMLTextAreaElement | null>,
  threadId: string,
  workspace: string | null | undefined,
  showCustomizeView: boolean
) {
  useEffect(() => {
    let frame: number | undefined
    const focus = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const state = useAppStore.getState()
        if (
          state.currentThreadId === threadId &&
          !state.showCustomizeView &&
          workspace &&
          consumeChatComposerFocus({ threadId, workspace })
        )
          input.current?.focus({ preventScroll: true })
      })
    }
    focus()
    window.addEventListener(CHAT_COMPOSER_FOCUS_EVENT, focus)
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      window.removeEventListener(CHAT_COMPOSER_FOCUS_EVENT, focus)
    }
  }, [input, threadId, workspace, showCustomizeView])
}
