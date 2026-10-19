import { botErrorMessage } from "@/lib/bot-error-message"
import { useEffect, useRef, useState } from "react"
import type { BotClient, BotExchange } from "../../../../shared/bots/contracts"
import { exchangeMessages } from "@/lib/bot-exchange-view"

const INITIAL_INDEX = 1_000_000
const EMPTY = {
  anchor: null as BotExchange | null,
  messages: [] as ReturnType<typeof exchangeMessages>,
  firstIndex: INITIAL_INDEX,
  before: undefined as string | undefined
}

/** One in-flight reader; refresh only the latest page and older unfinished dispatches. */
export function useBotExchange(client: BotClient, botId: string, taskId: string, groupId?: string) {
  const [view, setView] = useState(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const refreshRef = useRef<() => void>(() => {})
  const olderRef = useRef<() => void>(() => {})
  useEffect(() => {
    let disposed = false,
      pending = false,
      dirty = false,
      requestedBefore: string | undefined
    let items: BotExchange[] = [],
      before: string | undefined,
      initialized = false
    setView(EMPTY)
    setError(null)
    const drain = async () => {
      if (pending || document.hidden || disposed) return
      pending = true
      setLoading(true)
      try {
        while (!disposed && !document.hidden && (dirty || requestedBefore)) {
          const cursor = dirty ? undefined : requestedBefore
          if (dirty) dirty = false
          else requestedBefore = undefined
          const page = await client.exchangeHistory(botId, taskId, groupId, cursor)
          if (disposed) return
          const updates = new Map(page.items.map((item) => [item.taskId, item]))
          if (
            !cursor &&
            page.before &&
            items.length &&
            !items.some((item) => updates.has(item.taskId))
          ) {
            // After a long hidden interval, reset the window rather than silently skipping a gap.
            items = []
            initialized = false
            setView(EMPTY)
          }
          if (!cursor) {
            // Old completed exchanges are immutable. Only pending replies need to be revisited.
            for (const item of items) {
              if (
                !updates.has(item.taskId) &&
                (["queued", "running", "waiting_user"].includes(item.state) ||
                  (item.reply && !item.reply.delivered))
              ) {
                const updated = await client.exchange(botId, item.taskId, groupId)
                if (disposed) return
                updates.set(item.taskId, updated)
              }
            }
          }
          const merged = new Map(items.map((item) => [item.taskId, item]))
          for (const [id, item] of updates) merged.set(id, item)
          items = [...merged.values()]
          if (!initialized || cursor) before = page.before
          initialized = true
          const messages = exchangeMessages(items)
          const nextBefore = before
          setView((previous) => {
            const offset = previous.messages.length
              ? messages.findIndex((item) => item.id === previous.messages[0].id)
              : 0
            return {
              anchor: page.anchor,
              messages,
              before: nextBefore,
              firstIndex: previous.firstIndex - Math.max(0, offset)
            }
          })
          setError(null)
        }
      } catch (cause) {
        if (!disposed) {
          // Revoked group membership and deleted participants must not leave stale content visible.
          items = []
          before = undefined
          requestedBefore = undefined
          initialized = false
          setView(EMPTY)
          setError(botErrorMessage(cause, "无法读取交流记录"))
        }
      } finally {
        pending = false
        if (!disposed) setLoading(false)
      }
    }
    const refresh = () => {
      dirty = true
      void drain()
    }
    refreshRef.current = refresh
    olderRef.current = () => {
      if (!before || pending) return
      requestedBefore = before
      void drain()
    }
    const unsubscribe = client.subscribe(refresh)
    document.addEventListener("visibilitychange", refresh)
    refresh()
    return () => {
      disposed = true
      unsubscribe()
      document.removeEventListener("visibilitychange", refresh)
      refreshRef.current = () => {}
      olderRef.current = () => {}
    }
  }, [client, botId, taskId, groupId])
  return {
    ...view,
    error,
    loading,
    refresh: () => refreshRef.current(),
    loadOlder: () => olderRef.current()
  }
}
