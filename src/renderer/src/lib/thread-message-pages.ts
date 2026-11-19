import type { Message } from "../types"
import { preserveAssistantReasoningByRoleCollisionIdentity } from "../../../shared/message-role-collision"
import { compareTranscriptPositions } from "../../../shared/thread-message-order"
import { GOAL_USER_EVENT_MESSAGE_ID_PREFIX } from "../../../shared/goal-events"
import { insertPageGoalMessages } from "./goal-transcript"
import { reconcileMessageDisplayOrder } from "./message-display-order"
import { mergeDurableTranscriptSnapshot } from "./live-stream-transcript"

export interface ThreadMessagePageCursor {
  beforeOrdinal: number
  beforeMessageId: string
}

export interface ThreadMessageForwardPageCursor {
  anchorMessageId: string
}

export interface ThreadMessageTargetPageCursor {
  targetMessageId: string
}

export type ThreadMessagePageReloadCursor =
  | ThreadMessagePageCursor
  | ThreadMessageTargetPageCursor
  | ThreadMessageForwardPageCursor

export interface ThreadMessageWindowGap {
  afterMessageId: string
  beforeMessageId: string | null
  evictedMessageCount: number
  reloadBeforeOrdinal: number | null
  reloadBeforeMessageId: string | null
  reloadExactMessageId: string | null
  reloadAnchorMessageId: string | null
  reloadTargetMessageId: string | null
}

export interface ThreadMessageWindowResult {
  messages: Message[]
  gap: ThreadMessageWindowGap | null
  reusedLayout?: boolean
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
  firstDurableMessageId?: string
  lastDurableMessageId?: string
  reloadCursor: ThreadMessagePageReloadCursor | null
  beforeCreatedAt?: Date
}

const THREAD_MESSAGE_PAGE_WINDOW_LIMIT = 2_048

export function createThreadMessagePageWindow(
  messages: readonly Message[],
  reloadCursor: ThreadMessagePageReloadCursor | null,
  beforeCreatedAt?: Date,
  rawPage?: readonly Pick<Message, "id">[]
): ThreadMessagePageWindow {
  const first = messages[0]
  const last = messages.at(-1)
  const firstDurable = rawPage?.[0]?.id
  const lastDurable = rawPage?.at(-1)?.id
  return {
    firstMessageId: first?.id ?? "",
    lastMessageId: last?.id ?? "",
    ...(firstDurable && firstDurable !== first?.id && { firstDurableMessageId: firstDurable }),
    ...(lastDurable && lastDurable !== last?.id && { lastDurableMessageId: lastDurable }),
    reloadCursor: reloadCursor ? { ...reloadCursor } : null,
    ...(beforeCreatedAt && { beforeCreatedAt })
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

/** Backward reads require a real SQLite row, even when the page displays only Goal sidecars. */
export function getForwardPageBackwardBoundary(
  displayed: readonly Message[], rawPage: readonly Message[]
): Message | undefined {
  const firstDisplayed = displayed.find(({ id, ordinal }) =>
    ordinal !== undefined && !id.startsWith(GOAL_USER_EVENT_MESSAGE_ID_PREFIX))
  const firstRaw = rawPage[0]
  if (firstRaw?.ordinal === undefined) return firstDisplayed
  return !firstDisplayed || compareTranscriptPositions(firstRaw, firstDisplayed) <= 0
    ? firstRaw : firstDisplayed
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
  if (gap.reloadAnchorMessageId && gap.reloadTargetMessageId === gap.reloadAnchorMessageId)
    return gap
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
  const exactTarget =
    reloadCursor && "targetMessageId" in reloadCursor
      ? reloadCursor.targetMessageId
      : null
  const backwardCursor =
    reloadCursor && "beforeOrdinal" in reloadCursor ? reloadCursor : null
  return {
    ...gap,
    reloadBeforeOrdinal: backwardCursor?.beforeOrdinal ?? null,
    reloadBeforeMessageId: backwardCursor?.beforeMessageId ?? null,
    reloadExactMessageId: exactTarget,
    reloadAnchorMessageId: forwardAnchor,
    // A null cursor on a known latest-page descriptor means "reload the latest page", not
    // "unavailable". `reloadTargetMessageId` is therefore the availability discriminator.
    reloadTargetMessageId: nextWindow?.firstDurableMessageId ?? nextWindow?.firstMessageId ?? forwardAnchor
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
  const retainedIds = new Set(existing.map(({ id }) => id))
  const retainedIdentities = new Set(existing.map(threadMessagePageIdentity))
  const prefix: Message[] = []
  for (const message of olderPage) {
    const identity = threadMessagePageIdentity(message)
    if (retainedIds.has(message.id) || retainedIdentities.has(identity)) continue
    retainedIds.add(message.id)
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

  const knownGap = options.existingGap
  if (knownGap?.reloadTargetMessageId) {
    const gapTailStart = findThreadMessageGapTailStart(merged, knownGap)
    if (gapTailStart > 0) {
      // The detached prefix cannot fill spare capacity reserved for the latest
      // tail. Doing so would split the known missing interval into two gaps.
      const retainedTail = merged.slice(Math.max(gapTailStart, merged.length - sizes.tail))
      const prefixLimit = Math.min(gapTailStart, sizes.maximum - retainedTail.length)
      const beforeMessageId = retainedTail[0]?.id ?? null
      if (prefixLimit === gapTailStart) {
        const messages = [...merged.slice(0, prefixLimit), ...retainedTail]
        return {
          messages,
          gap: {
            ...knownGap, beforeMessageId,
            evictedMessageCount: knownGap.evictedMessageCount + merged.length - messages.length
          }
        }
      }
      const durableIds = options.fallbackReloadBoundaryMessageIds
      for (let index = prefixLimit - 1; index >= 0; index -= 1) {
        const id = merged[index].id
        if (!durableIds?.has(id) || id.startsWith(GOAL_USER_EVENT_MESSAGE_ID_PREFIX)) continue
        const messages = [...merged.slice(0, index + 1), ...retainedTail]
        return {
          messages,
          gap: {
            afterMessageId: id,
            beforeMessageId,
            evictedMessageCount: knownGap.evictedMessageCount + merged.length - messages.length,
            reloadBeforeOrdinal: null,
            reloadBeforeMessageId: null,
            reloadExactMessageId: null,
            reloadAnchorMessageId: id,
            reloadTargetMessageId: id
          }
        }
      }
    }
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
      reloadExactMessageId: null,
      reloadAnchorMessageId: null,
      reloadTargetMessageId: null
    }
  }
}

interface AdvanceThreadMessageWindowAcrossGapOptions {
  gap: ThreadMessageWindowGap
  maximumResidentMessages: number
  protectedTailMessages: number
  activeMessageIds?: ReadonlySet<string>
  rawPage?: readonly Message[]
  hasMore?: boolean
}

function refreshThreadMessageFromPage(durable: Message, local: Message | undefined, active?: ReadonlySet<string>): Message {
  if (!local) return durable
  const [refreshed] = preserveAssistantReasoningByRoleCollisionIdentity([local], [durable])
  if (active?.has(durable.id) && local.role === "assistant" && durable.role === "assistant" &&
      typeof local.content === "string" && typeof durable.content === "string" &&
      local.content.startsWith(durable.content) && local.content.length > durable.content.length) {
    return { ...refreshed, content: local.content, tool_calls: local.tool_calls ?? refreshed.tool_calls }
  }
  return refreshed
}

/** Move the detached historical window one known durable page toward the protected latest tail. */
export function advanceThreadMessageWindowAcrossGap(
  existing: readonly Message[],
  reloadedPage: readonly Message[],
  options: AdvanceThreadMessageWindowAcrossGapOptions
): ThreadMessageWindowResult {
  const gapTailStart = findThreadMessageGapTailStart(existing, options.gap)
  const tailCandidates = gapTailStart >= 0 ? existing.slice(gapTailStart) : []
  const protectedTailCount = Math.max(0, Math.floor(options.protectedTailMessages))
  const retainedTail = protectedTailCount ? tailCandidates.slice(-protectedTailCount) : []
  const before = new Map(retainedTail.map((message) => [message.id, message]))
  const pageIds = new Set(reloadedPage.map(({ id }) => id))
  const pageIdentities = threadMessagePageIdentitySet(reloadedPage)
  const newest = retainedTail.filter((message) =>
    !pageIds.has(message.id) && !pageIdentities.has(threadMessagePageIdentity(message)))
  const rawPage = options.rawPage ?? reloadedPage
  const rawIds = new Set(rawPage.map(({ id }) => id))
  const rawIdentities = threadMessagePageIdentitySet(rawPage)
  const pageOverlapsTail = retainedTail.some((message) =>
    !message.id.startsWith(GOAL_USER_EVENT_MESSAGE_ID_PREFIX) &&
    (rawIds.has(message.id) || rawIdentities.has(threadMessagePageIdentity(message))))
  const refreshed = reloadedPage.map((message) => refreshThreadMessageFromPage(
    message, before.get(message.id), options.activeMessageIds))
  const merged = [...refreshed, ...newest]
  const maximum = Math.max(1, Math.floor(options.maximumResidentMessages))
  const messages = merged.length > maximum ? merged.slice(-maximum) : merged
  const pageTail = reloadedPage.at(-1)
  const tailHead = retainedTail[0]

  return {
    messages,
    gap:
      !pageOverlapsTail && pageTail && options.hasMore !== false &&
      (tailHead || options.hasMore === true)
        ? {
            afterMessageId: pageTail.id,
            beforeMessageId: tailHead?.id ?? null,
            evictedMessageCount: Math.max(
              1,
              options.gap.evictedMessageCount - reloadedPage.length
            ),
            reloadBeforeOrdinal: null,
            reloadBeforeMessageId: null,
            reloadExactMessageId: null,
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
  residentOrdinals?: ReadonlyMap<string, number | null>
  goalAnchors?: ReadonlyMap<string, string>
  activeMessageIds?: ReadonlySet<string>
  hasNewerMessages?: boolean
}

export function findThreadMessageGapTailStart(
  messages: readonly Message[], gap: ThreadMessageWindowGap
): number {
  const before = gap.beforeMessageId
    ? messages.findIndex(({ id }) => id === gap.beforeMessageId) : -1
  if (before >= 0) return before
  const after = messages.findIndex(({ id }) => id === gap.afterMessageId)
  return after < 0 ? -1 : after + 1
}

export function selectTargetedThreadMessageTail(
  existing: readonly Message[], limit: number, gap?: ThreadMessageWindowGap | null
): readonly Message[] {
  if (limit <= 0) return []
  if (!gap) return existing.slice(-limit)
  const start = findThreadMessageGapTailStart(existing, gap)
  return start < 0 ? [] : existing.slice(Math.max(start, existing.length - limit))
}

/** Build a bounded historical search window while keeping the active newest tail resident. */
export function createTargetedThreadMessageWindow(
  existing: readonly Message[],
  targetPage: readonly Message[],
  options: TargetedThreadMessageWindowOptions
): ThreadMessageWindowResult {
  const targetIndex = targetPage.findIndex((message) => message.id === options.targetMessageId)
  if (targetIndex < 0) return { messages: existing as Message[], gap: null }
  const resident = existing.findIndex((message) => message.id === options.targetMessageId)
  const before = new Map(existing.map((message) => [message.id, message]))
  const fetched = new Map(targetPage.map((message) => [message.id, message]))
  const refresh = (durable: Message) => refreshThreadMessageFromPage(
    durable, before.get(durable.id), options.activeMessageIds)
  const firstSaved = existing.find(({ ordinal }) => ordinal !== undefined)
  const lastSaved = existing.findLast(({ ordinal }) => ordinal !== undefined)
  const obsoleteGap = options.hasNewerMessages === false && options.existingGap?.afterMessageId === options.targetMessageId
  const consistent = resident >= 0 && !obsoleteGap && existing.every((message) => {
    const current = fetched.get(message.id)
    const anchor = options.goalAnchors?.get(message.id)
    if (anchor && anchor !== message.transcript_anchor_message_id) return false
    if (options.residentOrdinals?.has(message.id) &&
        options.residentOrdinals.get(message.id) !== message.ordinal) return false
    if (current && current.ordinal !== message.ordinal) return false
    return message.ordinal === undefined || current !== undefined || options.residentOrdinals?.has(message.id)
  }) && (!firstSaved || !lastSaved || targetPage.every((message) =>
    before.has(message.id) || (message.ordinal !== undefined
      ? compareTranscriptPositions(message, firstSaved) < 0 || compareTranscriptPositions(message, lastSaved) > 0
      : !message.id.startsWith(GOAL_USER_EVENT_MESSAGE_ID_PREFIX))))
  if (consistent) {
    const messages = [...existing]
    messages[resident] = refresh(targetPage[targetIndex])
    return { messages, gap: options.existingGap ?? null, reusedLayout: true }
  }

  const sizes = boundedWindowSizes(
    targetPage.length + existing.length,
    options.maximumResidentMessages,
    options.protectedTailMessages
  )
  const targetPageStart = Math.max(0, targetIndex - sizes.prefix + 1)
  const retainedPage = targetPage.slice(targetPageStart, targetPageStart + sizes.prefix).map(refresh)
  const retainedIds = new Set(retainedPage.map(({ id }) => id))
  const retainedIdentities = new Set(retainedPage.map(threadMessagePageIdentity))
  const lastTarget = retainedPage.at(-1)
  const savedTail: Message[] = []
  const unanchoredGoals: Message[] = []
  const localTail: Message[] = []
  for (const message of selectTargetedThreadMessageTail(existing, sizes.tail, options.existingGap)) {
    if (retainedIds.has(message.id) || retainedIdentities.has(threadMessagePageIdentity(message))) continue
    const savedOrdinal = options.residentOrdinals?.get(message.id)
    const ordinal = options.residentOrdinals?.has(message.id) ? savedOrdinal :
      options.residentOrdinals && message.ordinal !== undefined ? undefined : message.ordinal
    if (ordinal === null || (options.residentOrdinals && message.ordinal !== undefined && ordinal === undefined))
      continue
    if (ordinal === undefined) {
      if (message.role === "user" && message.id.startsWith(GOAL_USER_EVENT_MESSAGE_ID_PREFIX)) {
        if (!lastTarget || message.created_at >= lastTarget.created_at) unanchoredGoals.push(message)
      } else {
        localTail.push(message)
      }
      continue
    }
    const anchor = options.goalAnchors?.get(message.id) ?? message.transcript_anchor_message_id
    const refreshed = ordinal !== message.ordinal || anchor !== message.transcript_anchor_message_id
      ? { ...message, ordinal, transcript_anchor_message_id: anchor } : message
    if (lastTarget?.ordinal !== undefined && compareTranscriptPositions(refreshed, lastTarget) <= 0) continue
    savedTail.push(refreshed)
  }
  const retainedTail = [
    ...insertPageGoalMessages(savedTail.sort(compareTranscriptPositions), unanchoredGoals), ...localTail
  ]
  const messages = [...retainedPage, ...retainedTail].slice(-sizes.maximum)
  const pageTail = retainedPage.at(-1)
  const liveHead = retainedTail[0]

  return {
    messages,
    gap:
      pageTail && options.hasNewerMessages !== false &&
      (liveHead || options.hasNewerMessages === true)
        ? {
            afterMessageId: pageTail.id,
            beforeMessageId: liveHead?.id ?? null,
            evictedMessageCount: Math.max(1, existing.length - retainedTail.length),
            reloadBeforeOrdinal: null,
            reloadBeforeMessageId: null,
            reloadExactMessageId: null,
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
  const gapTailStart = options.existingGap ? findThreadMessageGapTailStart(existing, options.existingGap) : -1
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
