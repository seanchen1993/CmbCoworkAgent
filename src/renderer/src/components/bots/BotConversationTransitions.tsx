import { useEffect, useRef } from "react"
import { useThreadContext } from "@/lib/thread-context"
import { completeBotConversationDeletion, completeBotConversationTransition } from "@/lib/bot-conversation-transition"
import { botErrorMessage } from "@/lib/bot-error-message"
import { useAppStore } from "@/lib/store"

/** The host owns user choices in the originating chat. This listener only reconciles local UI state. */
export function BotConversationTransitions() {
  const context = useThreadContext()
  const latestContext = useRef(context)
  latestContext.current = context

  useEffect(() => {
    const client = window.api.bots?.conversations
    const finish = client?.finishTransition
    if (!client?.onTransition || !finish) return
    const active = new Map<string, { id: string; controller: AbortController }>()
    const unsubscribeDismissed = client.onTransitionDismissed?.(id => {
      for (const entry of active.values()) if (entry.id === id) entry.controller.abort()
    })
    const unsubscribe = client.onTransition(request => {
      const target = request.threadId || (request.action === "delete" && request.work?.workId)
      if (!target) {
        void finish(request.id, "会话操作缺少目标。").catch(error => console.warn("[Bots] Invalid transition:", error))
        return
      }
      const pending = active.get(target)
      if (pending?.id === request.id) return
      if (pending) {
        void finish(request.id, "原会话已有一项变更正在处理。")
          .catch(error => console.warn("[Bots] Failed to decline transition:", error))
        return
      }
      const controller = new AbortController()
      active.set(target, { id: request.id, controller })
      const operation = request.action === "delete"
        ? completeBotConversationDeletion(latestContext.current, request.id, finish)
        : completeBotConversationTransition(latestContext.current, request, finish,
            () => useAppStore.getState().loadThreads(), controller.signal)
      void operation.catch(error => {
        if (!controller.signal.aborted) console.warn("[Bots] Conversation transition failed:", botErrorMessage(error))
      }).finally(() => active.delete(target))
    })
    return () => {
      unsubscribe()
      unsubscribeDismissed?.()
      for (const entry of active.values()) entry.controller.abort()
    }
  }, [])

  return null
}
