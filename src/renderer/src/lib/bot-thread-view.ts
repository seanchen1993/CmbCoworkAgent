/** Conversation IDs cannot contain '/', keeping existing main-view draft keys unchanged. */
export function botThreadView(conversationId: string, rootId?: string): string {
  return rootId ? `${conversationId}/thread/${rootId}` : conversationId
}

export function botViewAddress(viewId: string): { conversationId: string; threadRootId?: string } {
  const parts = viewId.split("/thread/")
  return { conversationId: parts[0], ...(parts[1] ? { threadRootId: parts[1] } : {}) }
}

/** Normal navigation reloads history. Only a branch's parent needs to stay in
 * memory so returning to it can restore the exact reading position. Drafts and
 * pending send receipts have a separate lifecycle and must not use this helper.
 */
export function retainBotViewCache<T>(
  entries: Record<string, T>,
  selected: string
): Record<string, T> {
  const keys = new Set([selected, botViewAddress(selected).conversationId])
  return Object.fromEntries(
    [...keys].filter((key) => Object.hasOwn(entries, key)).map((key) => [key, entries[key]])
  )
}
