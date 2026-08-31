interface MessageIdLike {
  id: string
}

/** Resolve the first visible message on the contiguous latest side of a raw history gap. */
export function resolveChatSearchContiguousTailStart(
  rawMessages: readonly MessageIdLike[],
  visibleBaseline: readonly MessageIdLike[],
  beforeMessageId: string | null
): number {
  if (!beforeMessageId) return 0
  const visibleIndexes = new Map(
    visibleBaseline.map((message, index) => [message.id, index] as const)
  )
  const rawBoundaryIndex = rawMessages.findIndex((message) => message.id === beforeMessageId)
  if (rawBoundaryIndex < 0) return visibleBaseline.length
  for (let index = rawBoundaryIndex; index < rawMessages.length; index += 1) {
    const visibleIndex = visibleIndexes.get(rawMessages[index].id)
    if (visibleIndex !== undefined) return visibleIndex
  }
  return visibleBaseline.length
}
