import { useEffect, useMemo, useRef } from "react"
import type { BotLinkPreviewClient } from "../../../shared/bot-link-preview"
import type { BotIpcTransport } from "../../../shared/bot-ipc-result"
import { BotLinkPreviewCache } from "./bot-link-preview-cache"
import { createBotLinkPreviewClient } from "./bot-link-preview-client"

/** Construction has no effects. Commit owns the cache; StrictMode's immediate replay keeps it alive. */
export function useBotLinkPreviews(
  transport: (() => BotIpcTransport<BotLinkPreviewClient>) | undefined
): BotLinkPreviewCache | null {
  const cache = useMemo(
    () => (transport ? new BotLinkPreviewCache(createBotLinkPreviewClient(transport)) : null),
    [transport]
  )
  const committed = useRef<BotLinkPreviewCache | null>(null)
  useEffect(() => {
    if (!cache) return
    committed.current = cache
    return () => {
      if (committed.current === cache) committed.current = null
      // Immediate cleanup→setup reuses this instance. A real unmount or transport
      // replacement disposes only the detached cache, with no cascading state update.
      queueMicrotask(() => {
        if (committed.current !== cache) void cache.dispose()
      })
    }
  }, [cache])
  return cache
}
