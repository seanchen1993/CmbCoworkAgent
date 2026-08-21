import type { Message } from "../types"
import { reconcileMessageDisplayOrder } from "./message-display-order"
import { mergeDurableTranscriptSnapshot } from "./live-stream-transcript"

export interface ThreadMessagePageCursor {
  beforeOrdinal: number
  beforeMessageId: string
}

export function threadMessagePageIdentity(message: Message): string {
  if (message.provider_source_id && message.provider_occurrence !== undefined) {
    return `${message.role}\u0000provider\u0000${message.provider_source_id}\u0000${message.provider_occurrence}`
  }
  return `${message.role}\u0000id\u0000${message.id}`
}

export function threadMessagePageIdentitySet(
  messages: readonly Message[]
): ReadonlySet<string> {
  return new Set(messages.map(threadMessagePageIdentity))
}

/** Prepend an older durable page while retaining every existing message object. */
export function prependThreadMessagePage(
  existing: readonly Message[],
  olderPage: readonly Message[]
): Message[] {
  if (olderPage.length === 0) return existing as Message[]
  const retainedIdentities = new Set(existing.map(threadMessagePageIdentity))
  const prefix: Message[] = []
  for (const message of olderPage) {
    const identity = threadMessagePageIdentity(message)
    if (retainedIdentities.has(identity)) continue
    retainedIdentities.add(identity)
    prefix.push(message)
  }
  return prefix.length > 0 ? [...prefix, ...existing] : (existing as Message[])
}

export interface LatestThreadMessagePageMergeResult {
  messages: Message[]
  addedDurableMessageCount: number
  /** Number of old rows retained without entering the durable merge window. */
  retainedPrefixLength: number
}

/**
 * Merge the latest bounded DB page into an already paged transcript.
 *
 * The first overlapping durable row bounds the expensive authority/reasoning
 * merge to the recent suffix. Older pages are retained by reference and are
 * never interpreted as if they arrived after the latest DB page. A missing
 * overlap is deliberately treated as an ambiguous legacy case and falls back
 * to the complete semantic merge.
 */
export function mergeLatestThreadMessagePage(
  existing: readonly Message[],
  latestPage: readonly Message[],
  orderHintMessages?: ReadonlyArray<{ id?: string }>
): LatestThreadMessagePageMergeResult {
  if (latestPage.length === 0) {
    return {
      messages: existing as Message[],
      addedDurableMessageCount: 0,
      retainedPrefixLength: existing.length
    }
  }

  const pageIndexByIdentity = new Map<string, number>()
  const ambiguousPageIdentities = new Set<string>()
  for (let index = 0; index < latestPage.length; index += 1) {
    const identity = threadMessagePageIdentity(latestPage[index])
    if (pageIndexByIdentity.has(identity)) {
      ambiguousPageIdentities.add(identity)
      pageIndexByIdentity.delete(identity)
    } else if (!ambiguousPageIdentities.has(identity)) {
      pageIndexByIdentity.set(identity, index)
    }
  }

  let mergeStart = -1
  const matchedPageIndexes = new Set<number>()
  // A normal completion reaches the first page row after reading at most the
  // bounded page plus a small renderer-only tail. Do not touch the stable
  // historical prefix once that authoritative anchor is found.
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    const pageIndex = pageIndexByIdentity.get(threadMessagePageIdentity(existing[index]))
    if (pageIndex === undefined) continue
    matchedPageIndexes.add(pageIndex)
    mergeStart = index
    if (pageIndex === 0) break
  }

  if (mergeStart < 0) {
    const merged = mergeDurableTranscriptSnapshot(
      latestPage as Message[],
      existing as Message[]
    )
    return {
      messages: reconcileMessageDisplayOrder(merged, orderHintMessages ?? latestPage),
      addedDurableMessageCount: pageIndexByIdentity.size,
      retainedPrefixLength: 0
    }
  }

  const retainedPrefix = existing.slice(0, mergeStart)
  const recentSuffix = existing.slice(mergeStart)
  const mergedSuffix = mergeDurableTranscriptSnapshot(
    latestPage as Message[],
    recentSuffix as Message[]
  )
  const orderedSuffix = reconcileMessageDisplayOrder(
    mergedSuffix,
    orderHintMessages ?? latestPage
  )
  return {
    messages:
      retainedPrefix.length > 0
        ? [...retainedPrefix, ...orderedSuffix]
        : orderedSuffix,
    addedDurableMessageCount: Math.max(
      0,
      pageIndexByIdentity.size - matchedPageIndexes.size
    ),
    retainedPrefixLength: retainedPrefix.length
  }
}
