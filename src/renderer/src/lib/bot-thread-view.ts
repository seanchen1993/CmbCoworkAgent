/** Conversation IDs cannot contain '/', keeping existing main-view draft keys unchanged. */
export function botThreadView(conversationId: string, rootId?: string): string {
  return rootId ? `${conversationId}/thread/${rootId}` : conversationId
}

export function botViewAddress(viewId: string): { conversationId: string; threadRootId?: string } {
  const parts = viewId.split("/thread/")
  return { conversationId: parts[0], ...(parts[1] ? { threadRootId: parts[1] } : {}) }
}
