import type { Message } from "../types"
import { reconcileMessageDisplayOrder } from "./message-display-order"
import { mergeDurableTranscriptSnapshot } from "./live-stream-transcript"

export interface ThreadMessagePageCursor {
  beforeOrdinal: number
  beforeMessageId: string
}

export interface ThreadMessageForwardPageCursor {
  anchorMessageId: string
}

export type ThreadMessagePageReloadCursor =
  | ThreadMessagePageCursor
  | ThreadMessageForwardPageCursor

export interface ThreadMessageWindowGap {
  afterMessageId: string
  beforeMessageId: string
  evictedMessageCount: number
  reloadBeforeOrdinal: number | null
  reloadBeforeMessageId: string | null
  reloadAnchorMessageId: string | null
  reloadTargetMessageId: string | null
}

export interface ThreadMessageWindowResult {
  messages: Message[]
  gap: ThreadMessageWindowGap | null
}

interface BoundedThreadMessageWindowOptions {
  maximumResidentMessages: number
  protectedTailMessages: number
  existingGap?: ThreadMessageWindowGap | null
  /** False when rows reintroduced by a latest-page merge already belong to the known gap. */
  accumulateEvictedMessageCount?: boolean
  /** Page-tail ids keep eviction aligned so a released page can be fetched again by cursor. */
  preferredPrefixBoundaryMessageIds?: ReadonlySet<string>
  /**
   * Known durable ids provide a verified forward anchor when no page-tail boundary fits the cap.
   */
  fallbackReloadBoundaryMessageIds?: ReadonlySet<string>
  /** Drop to a contiguous latest suffix instead of publishing a gap without a verified cursor. */
  requireReloadableGap?: boolean
}

export interface ThreadMessagePageWindow {
  firstMessageId: string
  lastMessageId: string
  reloadCursor: ThreadMessagePageReloadCursor | null
}

const THREAD_MESSAGE_PAGE_WINDOW_LIMIT = 2_048

export function createThreadMessagePageWindow(
  messages: readonly Message[],
  reloadCursor: ThreadMessagePageReloadCursor | null
): ThreadMessagePageWindow {
  const first = messages[0]
  const last = messages.at(-1)
  return {
    firstMessageId: first?.id ?? "",
    lastMessageId: last?.id ?? "",
    reloadCursor: reloadCursor ? { ...reloadCursor } : null
  }
}

/**
 * Describe a forward page from an exact durable id. The reader verifies the anchor exists, then
 * returns strictly newer rows so an oversized anchor cannot consume every retry's byte budget.
 */
export function createForwardThreadMessagePageWindow(
  boundaryMessageId: string
): ThreadMessagePageWindow | null {
  if (!boundaryMessageId) return null
  return {
    firstMessageId: boundaryMessageId,
    lastMessageId: `\u0000forward:${boundaryMessageId}`,
    reloadCursor: {
      anchorMessageId: boundaryMessageId
    }
  }
}

export function isForwardThreadMessagePageCursor(
  cursor: ThreadMessagePageReloadCursor | null
): boolean {
  return Boolean(cursor && "anchorMessageId" in cursor)
}

/** Backward/latest pages may advance only when their overlap proves no durable row was skipped. */
export function isThreadMessagePageContinuousWithBoundary(
  messages: readonly Message[],
  boundaryMessageId: string
): boolean {
  return Boolean(
    boundaryMessageId && messages.some((message) => message.id === boundaryMessageId)
  )
}

/** A verified forward page must also contain a strictly newer row before the gap may advance. */
export function isThreadMessageForwardPageProgress(
  messages: readonly Message[],
  verifiedAnchorMessageId: string | undefined,
  expectedAnchorMessageId: string
): boolean {
  return verifiedAnchorMessageId === expectedAnchorMessageId && messages.length > 0
}

export function prependThreadMessagePageWindow(
  existing: readonly ThreadMessagePageWindow[],
  pageWindow: ThreadMessagePageWindow
): ThreadMessagePageWindow[] {
  if (!pageWindow.firstMessageId || !pageWindow.lastMessageId) {
    return existing as ThreadMessagePageWindow[]
  }
  const retained = existing.filter(
    (window) =>
      window.firstMessageId !== pageWindow.firstMessageId ||
      window.lastMessageId !== pageWindow.lastMessageId
  )
  const combined = [pageWindow, ...retained]
  if (combined.length <= THREAD_MESSAGE_PAGE_WINDOW_LIMIT) return combined
  const latestWindow = combined.find((window) => window.reloadCursor === null)
  if (!latestWindow) return combined.slice(0, THREAD_MESSAGE_PAGE_WINDOW_LIMIT)
  const oldestWindows = combined
    .filter((window) => window !== latestWindow)
    .slice(0, THREAD_MESSAGE_PAGE_WINDOW_LIMIT - 1)
  return [...oldestWindows, latestWindow]
}

/** Refresh the authoritative latest-page descriptor without discarding older reload cursors. */
export function upsertLatestThreadMessagePageWindow(
  existing: readonly ThreadMessagePageWindow[],
  latestWindow: ThreadMessagePageWindow
): ThreadMessagePageWindow[] {
  if (
    !latestWindow.firstMessageId ||
    !latestWindow.lastMessageId ||
    latestWindow.reloadCursor !== null
  ) {
    return existing as ThreadMessagePageWindow[]
  }
  const retained = existing.filter((window) => window.reloadCursor !== null)
  if (retained.length < THREAD_MESSAGE_PAGE_WINDOW_LIMIT) {
    return [...retained, latestWindow]
  }
  // At the metadata cap retain the oldest known cursor chain plus the latest page. The latest
  // descriptor must never be sliced away because every detached/targeted window converges to it.
  return [
    ...retained.slice(0, THREAD_MESSAGE_PAGE_WINDOW_LIMIT - 1),
    latestWindow
  ]
}

export function attachThreadMessageGapReload(
  gap: ThreadMessageWindowGap | null,
  pageWindows: readonly ThreadMessagePageWindow[],
  knownDurableBoundaryMessageIds?: ReadonlySet<string>
): ThreadMessageWindowGap | null {
  if (!gap) return null
  const boundaryIndex = pageWindows.findIndex(
    (window) => window.lastMessageId === gap.afterMessageId
  )
  const nextWindow = boundaryIndex >= 0 ? pageWindows[boundaryIndex + 1] : undefined
  const describedReloadCursor = nextWindow?.reloadCursor ?? null
  const reloadCursor =
    nextWindow || !knownDurableBoundaryMessageIds?.has(gap.afterMessageId)
      ? describedReloadCursor
      : { anchorMessageId: gap.afterMessageId }
  const forwardAnchor =
    reloadCursor && "anchorMessageId" in reloadCursor
      ? reloadCursor.anchorMessageId
      : null
  const backwardCursor =
    reloadCursor && "beforeOrdinal" in reloadCursor ? reloadCursor : null
  return {
    ...gap,
    reloadBeforeOrdinal: backwardCursor?.beforeOrdinal ?? null,
    reloadBeforeMessageId: backwardCursor?.beforeMessageId ?? null,
    reloadAnchorMessageId: forwardAnchor,
    // A null cursor on a known latest-page descriptor means "reload the latest page", not
    // "unavailable". `reloadTargetMessageId` is therefore the availability discriminator.
    reloadTargetMessageId: nextWindow?.firstMessageId ?? forwardAnchor
  }
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

function boundedWindowSizes(
  messageCount: number,
  maximumResidentMessages: number,
  protectedTailMessages: number
): { maximum: number; tail: number; prefix: number } {
  const maximum = Math.max(1, Math.floor(maximumResidentMessages))
  const tail = Math.min(
    Math.max(0, Math.floor(protectedTailMessages)),
    Math.max(0, Math.min(messageCount, maximum - 1))
  )
  return { maximum, tail, prefix: maximum - tail }
}

/**
 * Prepend a durable page while retaining a fixed newest tail for live-stream reconciliation.
 * Once the resident cap is reached, the released middle is represented explicitly by `gap`.
 */
export function prependBoundedThreadMessagePage(
  existing: readonly Message[],
  olderPage: readonly Message[],
  options: BoundedThreadMessageWindowOptions
): ThreadMessageWindowResult {
  const merged = prependThreadMessagePage(existing, olderPage)
  const sizes = boundedWindowSizes(
    merged.length,
    options.maximumResidentMessages,
    options.protectedTailMessages
  )
  if (merged.length <= sizes.maximum) {
    return { messages: merged, gap: options.existingGap ?? null }
  }

  const tailStart = merged.length - sizes.tail
  const prefixCandidates = merged.slice(0, tailStart)
  let retainedPrefixLength = Math.min(prefixCandidates.length, sizes.prefix)
  const preferredBoundaries = options.preferredPrefixBoundaryMessageIds
  let hasVerifiedReloadBoundary = false
  if (options.existingGap) {
    const existingBoundaryIndex = prefixCandidates.findIndex(
      (message) => message.id === options.existingGap?.afterMessageId
    )
    const existingTailRetained = merged
      .slice(tailStart)
      .some((message) => message.id === options.existingGap?.beforeMessageId)
    if (
      existingBoundaryIndex >= 0 &&
      existingBoundaryIndex < sizes.prefix &&
      existingTailRetained
    ) {
      retainedPrefixLength = existingBoundaryIndex + 1
      hasVerifiedReloadBoundary = true
    }
  }
  if (!hasVerifiedReloadBoundary && preferredBoundaries && preferredBoundaries.size > 0) {
    for (let index = retainedPrefixLength - 1; index >= 0; index -= 1) {
      if (!preferredBoundaries.has(prefixCandidates[index].id)) continue
      retainedPrefixLength = index + 1
      hasVerifiedReloadBoundary = true
      break
    }
  }
  let retainedPrefix = prefixCandidates.slice(0, retainedPrefixLength)
  if (!hasVerifiedReloadBoundary) {
    const fallbackBoundaries = options.fallbackReloadBoundaryMessageIds
    if (fallbackBoundaries && fallbackBoundaries.size > 0) {
      let boundaryIndex = -1
      for (let index = retainedPrefixLength - 1; index >= 0; index -= 1) {
        if (!fallbackBoundaries.has(prefixCandidates[index].id)) continue
        boundaryIndex = index
        break
      }
      if (boundaryIndex < 0) {
        for (let index = prefixCandidates.length - 1; index >= retainedPrefixLength; index -= 1) {
          if (!fallbackBoundaries.has(prefixCandidates[index].id)) continue
          boundaryIndex = index
          break
        }
      }
      if (boundaryIndex >= 0) {
        const retainedPrefixStart = Math.max(0, boundaryIndex - sizes.prefix + 1)
        retainedPrefix = prefixCandidates.slice(retainedPrefixStart, boundaryIndex + 1)
        hasVerifiedReloadBoundary = true
      }
    }
  }
  const retainedTail = sizes.tail > 0 ? merged.slice(tailStart) : []
  if (options.requireReloadableGap && !hasVerifiedReloadBoundary) {
    return {
      messages: merged.slice(-sizes.maximum),
      gap: null
    }
  }
  const messages = [...retainedPrefix, ...retainedTail]
  const afterMessage = retainedPrefix.at(-1)
  const beforeMessage = retainedTail[0]
  if (!afterMessage || !beforeMessage) {
    return { messages: messages.slice(0, sizes.maximum), gap: options.existingGap ?? null }
  }
  if (afterMessage === merged[tailStart - 1]) {
    return { messages, gap: options.existingGap ?? null }
  }

  return {
    messages,
    gap: {
      afterMessageId: afterMessage.id,
      beforeMessageId: beforeMessage.id,
      evictedMessageCount:
        (options.existingGap?.evictedMessageCount ?? 0) +
        (options.accumulateEvictedMessageCount === false && options.existingGap
          ? 0
          : merged.length - messages.length),
      reloadBeforeOrdinal: null,
      reloadBeforeMessageId: null,
      reloadAnchorMessageId: null,
      reloadTargetMessageId: null
    }
  }
}

interface AdvanceThreadMessageWindowAcrossGapOptions {
  gap: ThreadMessageWindowGap
  maximumResidentMessages: number
  protectedTailMessages: number
}

/** Move the detached historical window one known durable page toward the protected latest tail. */
export function advanceThreadMessageWindowAcrossGap(
  existing: readonly Message[],
  reloadedPage: readonly Message[],
  options: AdvanceThreadMessageWindowAcrossGapOptions
): ThreadMessageWindowResult {
  const gapTailStart = existing.findIndex(
    (message) => message.id === options.gap.beforeMessageId
  )
  const tailCandidates = gapTailStart >= 0 ? existing.slice(gapTailStart) : []
  const protectedTailCount = Math.max(0, Math.floor(options.protectedTailMessages))
  const retainedTail = tailCandidates.slice(-protectedTailCount)
  const retainedTailIdentities = new Set(retainedTail.map(threadMessagePageIdentity))
  const pageOverlapsTail = reloadedPage.some((message) =>
    retainedTailIdentities.has(threadMessagePageIdentity(message))
  )
  const merged = prependThreadMessagePage(retainedTail, reloadedPage)
  const maximum = Math.max(1, Math.floor(options.maximumResidentMessages))
  const messages = merged.length > maximum ? merged.slice(-maximum) : merged
  const pageTail = reloadedPage.at(-1)
  const tailHead = retainedTail[0]

  return {
    messages,
    gap:
      !pageOverlapsTail && pageTail && tailHead
        ? {
            afterMessageId: pageTail.id,
            beforeMessageId: tailHead.id,
            evictedMessageCount: Math.max(
              1,
              options.gap.evictedMessageCount - reloadedPage.length
            ),
            reloadBeforeOrdinal: null,
            reloadBeforeMessageId: null,
            reloadAnchorMessageId: null,
            reloadTargetMessageId: null
          }
        : null
  }
}

interface TargetedThreadMessageWindowOptions {
  targetMessageId: string
  protectedTailMessages: number
  maximumResidentMessages: number
  existingGap?: ThreadMessageWindowGap | null
}

/** Build a bounded historical search window while keeping the active newest tail resident. */
export function createTargetedThreadMessageWindow(
  existing: readonly Message[],
  targetPage: readonly Message[],
  options: TargetedThreadMessageWindowOptions
): ThreadMessageWindowResult {
  const targetIndex = targetPage.findIndex((message) => message.id === options.targetMessageId)
  if (targetIndex < 0) return { messages: existing as Message[], gap: null }

  const sizes = boundedWindowSizes(
    targetPage.length + existing.length,
    options.maximumResidentMessages,
    options.protectedTailMessages
  )
  const targetPageStart = Math.max(0, targetIndex - sizes.prefix + 1)
  const retainedPage = targetPage.slice(targetPageStart, targetPageStart + sizes.prefix)
  const retainedIdentities = new Set(retainedPage.map(threadMessagePageIdentity))
  const gapTailStart = options.existingGap
    ? existing.findIndex((message) => message.id === options.existingGap?.beforeMessageId)
    : -1
  const tailCandidates = options.existingGap
    ? gapTailStart >= 0
      ? existing.slice(gapTailStart)
      : []
    : existing
  const retainedTail = tailCandidates
    .slice(-sizes.tail)
    .filter((message) => !retainedIdentities.has(threadMessagePageIdentity(message)))
  const messages = [...retainedPage, ...retainedTail].slice(-sizes.maximum)
  const pageTail = retainedPage.at(-1)
  const liveHead = retainedTail[0]

  return {
    messages,
    gap:
      pageTail && liveHead
        ? {
            afterMessageId: pageTail.id,
            beforeMessageId: liveHead.id,
            evictedMessageCount: Math.max(1, existing.length - retainedTail.length),
            reloadBeforeOrdinal: null,
            reloadBeforeMessageId: null,
            reloadAnchorMessageId: null,
            reloadTargetMessageId: null
          }
        : null
  }
}

interface RestoreLatestThreadMessageWindowOptions {
  maximumResidentMessages: number
  protectedLocalTailMessages: number
  existingGap?: ThreadMessageWindowGap | null
}

/** Replace a detached historical window with the latest durable page and its uncommitted tail. */
export function restoreLatestThreadMessageWindow(
  existing: readonly Message[],
  latestPage: readonly Message[],
  options: RestoreLatestThreadMessageWindowOptions
): ThreadMessageWindowResult {
  const protectedTailCount = Math.max(0, Math.floor(options.protectedLocalTailMessages))
  const gapTailStart = options.existingGap
    ? existing.findIndex((message) => message.id === options.existingGap?.beforeMessageId)
    : -1
  const localTailCandidates = options.existingGap
    ? gapTailStart >= 0
      ? existing.slice(gapTailStart)
      : []
    : existing
  const localTail = localTailCandidates.slice(-protectedTailCount)
  const merged = mergeLatestThreadMessagePage(localTail, latestPage).messages
  const maximum = Math.max(1, Math.floor(options.maximumResidentMessages))
  return {
    messages: merged.length > maximum ? merged.slice(-maximum) : merged,
    gap: null
  }
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
