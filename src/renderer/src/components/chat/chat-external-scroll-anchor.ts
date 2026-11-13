import type { VirtuosoHandle } from "react-virtuoso"
import { claimChatViewportScrollOwner, type ChatViewportScrollOwner } from "./chat-viewport-scroll-owner"

/** Capture both the handle and owner so stale cleanup cannot release a newer list. */
export function acquireChatExternalScrollAnchor(handle: VirtuosoHandle | null,
  viewport?: HTMLElement | null, kind: Exclude<ChatViewportScrollOwner, "search"> = "detached"): () => void {
  const owner = {}
  const lease = viewport ? claimChatViewportScrollOwner(viewport, kind) : undefined
  let active = true
  try { handle?.setExternalScrollAnchor({ owner, active: true }) }
  catch (error) {
    lease?.release()
    try { handle?.setExternalScrollAnchor({ owner, active: false }) } catch { /* Preserve acquisition failure. */ }
    throw error
  }
  return () => {
    if (!active) return
    active = false
    try { lease?.release() }
    finally { handle?.setExternalScrollAnchor({ owner, active: false }) }
  }
}
