const INITIAL_CHAT_VIRTUAL_INDEX = 10_000

export interface ChatVirtualWindow {
  threadId: string
  identities: readonly string[]
  firstItemIndex: number
  generation: number
  key: string
}

/** Keep Virtuoso's measured positions attached to the same contiguous transcript identities. */
export function projectChatVirtualWindow(
  previous: ChatVirtualWindow | null,
  threadId: string,
  identities: readonly string[]
): ChatVirtualWindow {
  const reset = (): ChatVirtualWindow => {
    const generation = (previous?.generation ?? -1) + 1
    return {
      threadId,
      identities,
      generation,
      firstItemIndex: INITIAL_CHAT_VIRTUAL_INDEX,
      key: JSON.stringify([threadId, generation])
    }
  }
  if (!previous || previous.threadId !== threadId) return reset()
  if (previous.identities === identities) return previous
  const old = previous.identities
  if (
    old.length === identities.length &&
    old.every((identity, index) => identity === identities[index])
  )
    return previous
  if (!old.length || !identities.length) return reset()
  const oldIndexes = new Map(old.map((identity, index) => [identity, index]))
  if (oldIndexes.size !== old.length || new Set(identities).size !== identities.length)
    return reset()
  const nextStart = identities.findIndex((identity) => oldIndexes.has(identity))
  if (nextStart < 0) return reset()
  const oldStart = oldIndexes.get(identities[nextStart])!
  // Restoring a latest page can remove an old historical prefix and insert a different
  // prefix before the retained tail. A net firstItemIndex shift would assign the removed
  // rows' measurements to those new identities. Only pure prepend/trim can retain sizes.
  if (oldStart > 0 && nextStart > 0) return reset()
  const overlap = Math.min(old.length - oldStart, identities.length - nextStart)
  for (let index = 0; index < overlap; index++) {
    if (old[oldStart + index] !== identities[nextStart + index]) return reset()
  }
  // A shared identity outside the contiguous overlap is a reorder, never a prepend/trim.
  for (let index = nextStart + overlap; index < identities.length; index++) {
    if (oldIndexes.has(identities[index])) return reset()
  }
  const firstItemIndex = previous.firstItemIndex + oldStart - nextStart
  if (firstItemIndex < 1 || !Number.isSafeInteger(firstItemIndex)) return reset()
  return { ...previous, identities, firstItemIndex }
}
