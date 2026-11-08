import type { VirtuosoHandle } from "react-virtuoso"

/** Capture both the handle and owner so stale cleanup cannot release a newer list. */
export function acquireChatExternalScrollAnchor(handle: VirtuosoHandle | null): () => void {
  const owner = {}
  handle?.setExternalScrollAnchor({ owner, active: true })
  return () => handle?.setExternalScrollAnchor({ owner, active: false })
}
