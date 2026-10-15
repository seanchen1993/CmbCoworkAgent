import { botErrorMessage } from "@/lib/bot-error-message"
import { useEffect, useState } from "react"
import type { BotClient, BotSnapshot } from "../../../../shared/bots/contracts"

/** Revision-coalesced invalidation: at most one snapshot request at a time. */
export function useBots(client: BotClient) {
  const [snapshot, setSnapshot] = useState<BotSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
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
        if (!disposed) setError(botErrorMessage(cause, "无法读取 Bot 状态"))
      } finally {
        pending = false
      }
    }
    const unsubscribe = client.subscribe(() => {
      void refresh()
    })
    const onFocus = () => {
      void refresh()
    }
    window.addEventListener("focus", onFocus)
    void refresh()
    return () => {
      disposed = true
      unsubscribe()
      window.removeEventListener("focus", onFocus)
    }
  }, [client])
  return { snapshot: snapshot?.host.id === client.hostId ? snapshot : null, error }
}
