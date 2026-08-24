export interface ChatSearchDocument {
  messageId: string
  text: string
  sortIndex?: number
}

export interface ChatSearchMatch {
  messageId: string
  occurrenceIndex: number
  sortIndex?: number
}

export interface ChatSearchCorpus {
  /** Changes only when persisted/search-stable content changes. */
  stableDocuments: readonly ChatSearchDocument[]
  /** The live suffix and any live overrides of persisted rows. */
  dynamicDocuments: readonly ChatSearchDocument[]
  dynamicMessageIds: ReadonlySet<string>
}

export function findChatSearchMatches(
  documents: readonly ChatSearchDocument[],
  rawQuery: string
): ChatSearchMatch[] {
  const query = rawQuery.trim().toLocaleLowerCase()
  if (!query) return []

  const matches: ChatSearchMatch[] = []
  for (const document of documents) {
    const text = document.text.toLocaleLowerCase()
    let offset = 0
    let occurrenceIndex = 0
    let matchIndex = text.indexOf(query, offset)
    while (matchIndex >= 0) {
      matches.push({
        messageId: document.messageId,
        occurrenceIndex,
        ...(document.sortIndex === undefined ? {} : { sortIndex: document.sortIndex })
      })
      occurrenceIndex += 1
      offset = matchIndex + query.length
      matchIndex = text.indexOf(query, offset)
    }
  }
  return matches
}

function mergeSortedMatches(
  stable: readonly ChatSearchMatch[],
  dynamic: readonly ChatSearchMatch[]
): ChatSearchMatch[] {
  const merged: ChatSearchMatch[] = []
  let stableIndex = 0
  let dynamicIndex = 0
  while (stableIndex < stable.length || dynamicIndex < dynamic.length) {
    const stableMatch = stable[stableIndex]
    const dynamicMatch = dynamic[dynamicIndex]
    if (!dynamicMatch) {
      merged.push(stableMatch)
      stableIndex += 1
      continue
    }
    if (!stableMatch) {
      merged.push(dynamicMatch)
      dynamicIndex += 1
      continue
    }
    if ((stableMatch.sortIndex ?? 0) <= (dynamicMatch.sortIndex ?? 0)) {
      merged.push(stableMatch)
      stableIndex += 1
    } else {
      merged.push(dynamicMatch)
      dynamicIndex += 1
    }
  }
  return merged
}

/**
 * Caches matching for the stable history. While tokens update the dynamic
 * suffix, only that suffix is searched again; the already-indexed history text
 * is not revisited.
 */
export function createChatSearchMatcher(): (
  corpus: ChatSearchCorpus,
  query: string
) => ChatSearchMatch[] {
  let previousStableDocuments: readonly ChatSearchDocument[] | null = null
  let previousQuery = ""
  let stableMatches: ChatSearchMatch[] = []
  let previousDynamicIdKey = ""
  let visibleStableMatches: readonly ChatSearchMatch[] = stableMatches

  return (corpus, query) => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return []

    if (
      corpus.stableDocuments !== previousStableDocuments ||
      normalizedQuery !== previousQuery
    ) {
      stableMatches = findChatSearchMatches(corpus.stableDocuments, normalizedQuery)
      previousStableDocuments = corpus.stableDocuments
      previousQuery = normalizedQuery
      previousDynamicIdKey = "\u0001"
    }

    const dynamicIdKey = Array.from(corpus.dynamicMessageIds).sort().join("\u0000")
    if (dynamicIdKey !== previousDynamicIdKey) {
      visibleStableMatches =
        corpus.dynamicMessageIds.size === 0
          ? stableMatches
          : stableMatches.filter((match) => !corpus.dynamicMessageIds.has(match.messageId))
      previousDynamicIdKey = dynamicIdKey
    }

    const dynamicMatches = findChatSearchMatches(corpus.dynamicDocuments, normalizedQuery)
    return mergeSortedMatches(visibleStableMatches, dynamicMatches)
  }
}
