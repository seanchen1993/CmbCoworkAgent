import { useEffect, useRef, useState } from "react"
import { BotError, type BotClient, type BotSnapshot } from "../../../../shared/bots/contracts"

/** Revision-coalesced invalidation: at most one snapshot request at a time. */
export function useBots(client: BotClient) {
  const [snapshot, setSnapshot] = useState<BotSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refreshRef = useRef<() => void>(() => {})
  useEffect(() => {
    let disposed = false,
      pending = false,
      dirty = true
    const refresh = async () => {
      dirty = true
      if (pending) return
      pending = true
      try {
        while (dirty && !disposed) {
          dirty = false
          const result = await client.snapshot()
          if (!disposed) {
            setSnapshot((previous) =>
              !previous ||
              previous.host.id !== result.host.id ||
              previous.revision <= result.revision
                ? result
                : previous
            )
            setError(null)
          }
        }
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof BotError ? cause.message : "暂时无法读取 Bot 数据，请重试。")
      } finally {
        pending = false
      }
    }
    const unsubscribe = client.subscribe((event) => {
      // Memory owns its scoped reader; these writes do not change the control snapshot.
      if (!event.memoryBotId || event.workChanges?.length) void refresh()
    })
    const onFocus = () => {
      void refresh()
    }
    refreshRef.current = onFocus
    window.addEventListener("focus", onFocus)
    void refresh()
    return () => {
      disposed = true
      refreshRef.current = () => {}
      unsubscribe()
      window.removeEventListener("focus", onFocus)
    }
  }, [client])
  return {
    snapshot: snapshot?.host.id === client.hostId ? snapshot : null,
    error,
    retry: () => refreshRef.current()
  }
}

/** Read the workbench indicator through the existing Bot change notifications. */
export function useLocalBotsUnread(): boolean {
  const [hasUnread, setHasUnread] = useState(false)

  useEffect(() => {
    const client = window.api?.bots
    const read = client?.hasUnread?.bind(client)
    if (!client || !read) return

    let disposed = false
    let pending = false
    let dirty = false
    const refresh = async () => {
      dirty = true
      if (pending || disposed) return
      pending = true
      while (dirty && !disposed) {
        dirty = false
        try {
          const unread = await read()
          if (!disposed && !dirty) setHasUnread(unread)
        } catch {
          // A failed read leaves the last known indicator in place.
        }
      }
      pending = false
    }
    const unsubscribe = client.subscribe((event) => {
      if (event.hostId === client.hostId && !event.memoryBotId) void refresh()
    })
    window.addEventListener("focus", refresh)
    void refresh()

    return () => {
      disposed = true
      unsubscribe()
      window.removeEventListener("focus", refresh)
    }
  }, [])

  return hasUnread
}
