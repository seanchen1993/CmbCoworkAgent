import { useEffect, useRef, useState } from "react"
import type { BotWorkConversationResolution } from "../../../../shared/bots/conversation"
import { botErrorMessage } from "@/lib/bot-error-message"

/** One selected-thread lookup per coalesced revision, no per-task transcript inspection. */
export function useBotConversationLink(threadId: string, enabled: boolean) {
  const [state, setState] = useState<{
    threadId: string
    value: BotWorkConversationResolution | null
    loading: boolean
    error: string | null
  }>({ threadId, value: null, loading: true, error: null })
  const refresh = useRef<() => void>(() => {})
  useEffect(() => {
    if (!enabled || !window.api.bots?.conversations) {
      setState({ threadId, value: null, loading: false, error: null })
      return
    }
    let disposed = false,
      dirty = false,
      pending = false
    setState({ threadId, value: null, loading: true, error: null })
    const reload = async () => {
      dirty = true
      if (pending) return
      pending = true
      try {
        while (dirty && !disposed) {
          dirty = false
          const value = await window.api.bots.conversations!.resolve(threadId)
          if (!disposed) setState({ threadId, value, loading: false, error: null })
        }
      } catch (cause) {
        if (!disposed)
          setState({ threadId, value: null, loading: false, error: botErrorMessage(cause) })
      } finally {
        pending = false
      }
    }
    refresh.current = () => void reload()
    const unsubscribe = window.api.bots.subscribe((event) => {
      if (!event.memoryBotId) void reload()
    })
    void reload()
    return () => {
      disposed = true
      refresh.current = () => {}
      unsubscribe()
    }
  }, [threadId, enabled])
  return {
    ...(!enabled
      ? { threadId, value: null, loading: false, error: null }
      : state.threadId === threadId
        ? state
        : { threadId, value: null, loading: true, error: null }),
    refresh: () => refresh.current()
  }
}
