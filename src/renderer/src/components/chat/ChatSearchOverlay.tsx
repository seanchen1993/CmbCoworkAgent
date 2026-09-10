/* eslint-disable react-refresh/only-export-components -- colocated search contracts and bounded runtime primitives are tested directly */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ChevronUp, ChevronDown, X, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { findChatSearchLocationRange, mapChatSearchDom } from "@/lib/chat-search-dom"
import { chatSearchLocationKey, type ChatSearchLocation,
  type ChatSearchReveal } from "../../../../shared/chat-search-types"
import {
  createChatSearchMatcher,
  type ChatSearchCorpus,
  type ChatSearchMatch
} from "@/lib/chat-search-matches"

/**
 * In-session keyword search (Ctrl/Cmd+F) for the chat transcript.
 *
 * Highlighting uses the CSS Custom Highlight API (`CSS.highlights`), which paints
 * over live DOM Ranges WITHOUT mutating the DOM. This is essential here: the
 * transcript is React-rendered markdown, so injecting <mark> wrappers would fight
 * React's reconciliation and corrupt the tree. Ranges become stale when React
 * replaces text nodes (e.g. during streaming), so the mounted active row is
 * repainted whenever `recomputeKey` changes. Match discovery itself uses the
 * complete transcript data index and is independent of the bounded DOM window.
 *
 * A data-index match split across rendered element boundaries can still be
 * navigated to, but the CSS highlight is limited to a single text node.
 */

export interface DurableChatSearchOptions {
  beforeOrdinal?: number
  beforeMessageId?: string
  limit?: number
}

export interface DurableChatSearchMatch {
  messageId: string
  ordinal: number
  role: "user" | "assistant" | "system" | "tool"
  createdAt: number
  occurrenceCount: number
  preview: string
  occurrenceOffset?: number
  locations?: ChatSearchLocation[]
}

export interface DurableChatSearchPage {
  matches: DurableChatSearchMatch[]
  beforeOrdinal: number | null
  beforeMessageId: string | null
  hasMore: boolean
  scanned?: number
  truncated?: boolean
}

export type SearchDurableMessages = (
  query: string,
  options: DurableChatSearchOptions
) => Promise<DurableChatSearchPage>

export type RevealDurableMessage = (
  match: DurableChatSearchMatch
) => Promise<void> | void

interface ChatSearchOverlayProps {
  searchLocalCorpus?: (corpus: ChatSearchCorpus, query: string) => Promise<ChatSearchMatch[]>
  onRevealSearchContext?: (reveal: ChatSearchReveal | null) => void
  onCancelLocalSearch?: () => void
  validateSearchLocation?: (reveal: ChatSearchReveal, signal: AbortSignal) => Promise<boolean>
  open: boolean
  onClose: () => void
  /** Returns the scrollable viewport element to search and scroll within. */
  getViewport: () => HTMLElement | null
  /** Returns the stable-history and live-tail search indexes after the debounce. */
  getSearchCorpus: (signal?: AbortSignal) => ChatSearchCorpus | Promise<ChatSearchCorpus>
  /** Ensures a virtualized message row is mounted before highlighting it. */
  onRevealMessage: (messageId: string) => void
  /** Searches durable pages beyond the currently loaded renderer window. */
  searchDurableMessages?: SearchDurableMessages
  /** Loads an unloaded durable result before the overlay asks to paint it. */
  onRevealDurableMessage?: RevealDurableMessage
  /** Invalidates an older durable reveal when query/open identity moves on. */
  onCancelDurableReveal?: () => void
  /** Changes whenever the rendered transcript changes, to re-run the search. */
  recomputeKey: unknown
}

const HIGHLIGHT_NAME = "chat-search"
const ACTIVE_HIGHLIGHT_NAME = "chat-search-active"
const STYLE_ELEMENT_ID = "chat-search-highlight-style"
const SEARCH_THROTTLE_MS = 120
const SEARCH_THROTTLE_MAX_WAIT_MS = 480
const DURABLE_SEARCH_SETTLE_MS = 120
const DURABLE_SEARCH_PAGE_LIMIT = 100
const DURABLE_SEARCH_MAX_PAGES = 1_000
const SEARCH_REVEAL_MAX_FRAMES = 60
export const CHAT_SEARCH_RESULT_LIMIT = 1_000
export const CHAT_SEARCH_HIGHLIGHT_RANGE_LIMIT = 1_000
export const CHAT_SEARCH_PREVIEW_LIMIT = 240

export interface OverlayChatSearchMatch extends ChatSearchMatch {
  durableMatch?: DurableChatSearchMatch
}

export interface DurableChatSearchProgress {
  addedMatches: readonly DurableChatSearchMatch[]
  retainedOccurrenceCount: number
  pageCount: number
  scanned: number
  hasMore: boolean
}

export interface DurableChatSearchScanResult {
  matches: DurableChatSearchMatch[]
  retainedOccurrenceCount: number
  pageCount: number
  scanned: number
  truncated: boolean
  cancelled: boolean
}

interface ScanDurableChatSearchOptions {
  query: string
  search: SearchDurableMessages
  maxOccurrences?: number
  pageLimit?: number
  maxPages?: number
  shouldContinue?: () => boolean
  getLocalCoverage?: (messageId: string) => { occurrenceCount: number; authoritative: boolean }
  yieldControl?: () => Promise<void>
  onProgress?: (progress: DurableChatSearchProgress) => void
}

export interface LeadingTrailingThrottle<T> {
  schedule(value: T): void
  cancel(): void
  flush(): void
}

/**
 * Expand a clipped user body before collecting DOM ranges. A freshly mounted bubble may not have
 * completed its overflow effect yet; in that case the data threshold plus scrollHeight requests
 * another animation frame without adding a subscription to every message row.
 */
export function prepareUserContentForSearchHighlight(row: HTMLElement): boolean {
  const content = row.querySelector<HTMLElement>(
    "[data-chat-search-user-content-collapse-threshold]"
  )
  if (content) {
    const button = row.querySelector<HTMLButtonElement>(
      "[data-chat-search-expand-user-content]"
    )
    if (button?.getAttribute("aria-expanded") === "false") {
      button.click()
      return true
    }
    if (button) return false
    const threshold = Number(content.dataset.chatSearchUserContentCollapseThreshold)
    return Number.isFinite(threshold) && content.scrollHeight > threshold + 8
  }
  return false
}

/** User clipping already has bounded DOM; Markdown must never be automatically expanded. */
export function prepareChatContentForSearchHighlight(row: HTMLElement): boolean {
  return prepareUserContentForSearchHighlight(row)
}

/** A message or paragraph can be taller than the viewport; center the actual text range. */
export function scrollChatSearchRangeIntoView(viewport: HTMLElement, range: Range): void {
  const rect = range.getBoundingClientRect()
  if (rect.height <= 0) return
  const viewportRect = viewport.getBoundingClientRect()
  const target =
    viewport.scrollTop +
    rect.top -
    viewportRect.top -
    viewport.clientTop -
    (viewport.clientHeight - Math.min(rect.height, viewport.clientHeight)) / 2
  viewport.scrollTo({
    top: Math.max(0, Math.min(target, viewport.scrollHeight - viewport.clientHeight)),
    behavior: "auto"
  })
}

/**
 * Leading/trailing throttle with a fixed max-wait boundary. Unlike a debounce,
 * a continuously streaming transcript cannot postpone the callback forever.
 */
export function createLeadingTrailingThrottle<T>(
  callback: (value: T) => void,
  waitMs = SEARCH_THROTTLE_MS,
  maxWaitMs = SEARCH_THROTTLE_MAX_WAIT_MS
): LeadingTrailingThrottle<T> {
  let active = false
  let queued = false
  let latestValue: T | undefined
  let quietTimer: ReturnType<typeof setTimeout> | null = null
  let maxTimer: ReturnType<typeof setTimeout> | null = null

  const clearTimers = (): void => {
    if (quietTimer !== null) clearTimeout(quietTimer)
    if (maxTimer !== null) clearTimeout(maxTimer)
    quietTimer = null
    maxTimer = null
  }

  const finish = (invokeTrailing: boolean): void => {
    const value = latestValue
    const shouldInvoke = invokeTrailing && queued && value !== undefined
    clearTimers()
    active = false
    queued = false
    latestValue = undefined
    if (shouldInvoke) callback(value)
  }

  const scheduleQuietTimer = (): void => {
    if (quietTimer !== null) clearTimeout(quietTimer)
    quietTimer = setTimeout(() => finish(true), Math.max(0, waitMs))
  }

  return {
    schedule(value): void {
      latestValue = value
      if (!active) {
        active = true
        queued = false
        maxTimer = setTimeout(() => finish(true), Math.max(0, maxWaitMs))
        scheduleQuietTimer()
        callback(value)
        return
      }

      queued = true
      scheduleQuietTimer()
    },
    cancel(): void {
      clearTimers()
      active = false
      queued = false
      latestValue = undefined
    },
    flush(): void {
      finish(true)
    }
  }
}

export function boundDurableSearchPreview(
  rawPreview: string,
  limit = CHAT_SEARCH_PREVIEW_LIMIT
): string {
  const normalized = rawPreview.replace(/\s+/g, " ").trim()
  const safeLimit = Math.max(0, Math.floor(limit))
  if (normalized.length <= safeLimit) return normalized
  if (safeLimit === 0) return ""
  if (safeLimit === 1) return "…"
  return `${normalized.slice(0, safeLimit - 1)}…`
}

function defaultYieldControl(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Scan newest-to-oldest durable pages while retaining only bounded results. */
export async function scanDurableChatSearch({
  query,
  search,
  maxOccurrences = CHAT_SEARCH_RESULT_LIMIT,
  pageLimit = DURABLE_SEARCH_PAGE_LIMIT,
  maxPages = DURABLE_SEARCH_MAX_PAGES,
  shouldContinue = () => true,
  getLocalCoverage = () => ({ occurrenceCount: 0, authoritative: false }),
  yieldControl = defaultYieldControl,
  onProgress
}: ScanDurableChatSearchOptions): Promise<DurableChatSearchScanResult> {
  const retained: DurableChatSearchMatch[] = []
  const seenMessageIds = new Set<string>()
  const occurrenceLimit = Math.max(0, Math.floor(maxOccurrences))
  const boundedPageLimit = Math.max(1, Math.floor(pageLimit))
  const boundedMaxPages = Math.max(1, Math.floor(maxPages))
  let retainedOccurrenceCount = 0
  let pageCount = 0
  let scanned = 0
  let beforeOrdinal: number | undefined
  let beforeMessageId: string | undefined
  let truncated = occurrenceLimit === 0

  const result = (cancelled: boolean): DurableChatSearchScanResult => ({
    matches: retained,
    retainedOccurrenceCount,
    pageCount,
    scanned,
    truncated,
    cancelled
  })

  const normalizedQuery = query.trim()
  if (!normalizedQuery || occurrenceLimit === 0) return result(false)

  while (pageCount < boundedMaxPages) {
    if (!shouldContinue()) return result(true)
    const page = await search(normalizedQuery, {
      ...(beforeOrdinal === undefined ? {} : { beforeOrdinal }),
      ...(beforeMessageId === undefined ? {} : { beforeMessageId }),
      limit: boundedPageLimit
    })
    if (!shouldContinue()) return result(true)

    pageCount += 1
    if (page.truncated) truncated = true
    if (Number.isFinite(page.scanned)) scanned += Math.max(0, Math.floor(page.scanned ?? 0))
    const addedMatches: DurableChatSearchMatch[] = []

    for (let matchIndex = 0; matchIndex < page.matches.length; matchIndex += 1) {
      const match = page.matches[matchIndex]
      if (!match.messageId || seenMessageIds.has(match.messageId)) continue
      seenMessageIds.add(match.messageId)
      const requestedOccurrences = Math.max(1, Math.floor(match.occurrenceCount || 1))
      const localCoverage = getLocalCoverage(match.messageId)
      const localOccurrenceCount = Math.max(
        0,
        Math.floor(localCoverage.occurrenceCount || 0)
      )
      if (localCoverage.authoritative) continue
      // Disjoint local ranges are not a prefix. Never infer missing positions from their count.
      if (localOccurrenceCount > 0) continue
      const missingOccurrences = requestedOccurrences
      if (missingOccurrences === 0) continue
      const remaining = occurrenceLimit - retainedOccurrenceCount
      if (remaining <= 0) {
        truncated = true
        break
      }
      const retainedOccurrences = Math.min(missingOccurrences, remaining)
      const boundedMatch: DurableChatSearchMatch = {
        ...match,
        occurrenceCount: retainedOccurrences,
        ...(match.locations ? { locations: match.locations.slice(0, retainedOccurrences) } : {}),
        preview: boundDurableSearchPreview(match.preview)
      }
      retained.push(boundedMatch)
      addedMatches.push(boundedMatch)
      retainedOccurrenceCount += retainedOccurrences

      if (retainedOccurrences < missingOccurrences) truncated = true
      if (retainedOccurrenceCount >= occurrenceLimit) {
        if (matchIndex < page.matches.length - 1 || page.hasMore) truncated = true
        break
      }
    }

    onProgress?.({
      addedMatches,
      retainedOccurrenceCount,
      pageCount,
      scanned,
      hasMore: page.hasMore
    })

    if (retainedOccurrenceCount >= occurrenceLimit || !page.hasMore) return result(false)

    const nextOrdinal = page.beforeOrdinal
    const nextMessageId = page.beforeMessageId
    if (
      nextOrdinal === null ||
      nextMessageId === null ||
      (nextOrdinal === beforeOrdinal && nextMessageId === beforeMessageId)
    ) {
      // A malformed/non-advancing cursor must not spin the renderer forever.
      truncated = true
      return result(false)
    }
    beforeOrdinal = nextOrdinal
    beforeMessageId = nextMessageId
    await yieldControl()
  }

  truncated = true
  return result(false)
}

function searchMatchKey(match: ChatSearchMatch): string {
  return `${match.messageId}\u0000${match.location
    ? chatSearchLocationKey(match.location) : match.occurrenceIndex}`
}

export function mergeChatSearchResults(
  localMatches: readonly ChatSearchMatch[],
  durableMatches: readonly DurableChatSearchMatch[],
  limit = CHAT_SEARCH_RESULT_LIMIT
): { matches: OverlayChatSearchMatch[]; truncated: boolean } {
  const cap = Math.max(0, Math.floor(limit))
  const localIds = new Set(localMatches.map((match) => match.messageId))
  const candidates: OverlayChatSearchMatch[] = [...localMatches.slice(0, cap + 1)]
  let truncated = localMatches.length > cap
  const durableCapacity = Math.max(0, cap - Math.min(localMatches.length, cap))
  let added = 0
  const seen = new Set<string>()
  for (const durable of [...durableMatches].sort((a, b) => a.ordinal - b.ordinal ||
    a.messageId.localeCompare(b.messageId))) {
    // A resident snapshot owns its row. Never attach positions from a different projection.
    if (localIds.has(durable.messageId) || seen.has(durable.messageId)) continue
    seen.add(durable.messageId)
    const count = durable.locations?.length ?? Math.min(cap, durable.occurrenceCount)
    for (let index = 0; index < count; index += 1) {
      if (added >= durableCapacity) { truncated = true; break }
      candidates.push({ messageId: durable.messageId, sortIndex: durable.ordinal,
        occurrenceIndex: index, location: durable.locations?.[index], durableMatch: durable })
      added += 1
    }
  }
  candidates.sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0) ||
    a.messageId.localeCompare(b.messageId) || a.occurrenceIndex - b.occurrenceIndex)
  return { matches: candidates.slice(0, cap), truncated: truncated || candidates.length > cap }
}

/** Return non-overlapping match offsets without allocating beyond `limit`. */
export function collectNeedleOffsets(
  rawText: string,
  rawQuery: string,
  limit = CHAT_SEARCH_HIGHLIGHT_RANGE_LIMIT
): number[] {
  const text = rawText.toLowerCase()
  const query = rawQuery.toLowerCase()
  const boundedLimit = Math.max(0, Math.floor(limit))
  if (!query || boundedLimit === 0) return []

  const offsets: number[] = []
  let from = 0
  let index = text.indexOf(query, from)
  while (index >= 0 && offsets.length < boundedLimit) {
    offsets.push(index)
    from = index + query.length
    index = text.indexOf(query, from)
  }
  return offsets
}

// The CSS Custom Highlight API types are not in this project's TS lib yet.
type HighlightCtor = new (...ranges: Range[]) => { priority: number }
interface HighlightRegistry {
  set(name: string, highlight: object): void
  delete(name: string): void
}

function getHighlightRegistry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS
  return css?.highlights ?? null
}

function getHighlightCtor(): HighlightCtor | null {
  return (globalThis as { Highlight?: HighlightCtor }).Highlight ?? null
}

function supportsHighlightApi(): boolean {
  return getHighlightRegistry() !== null && getHighlightCtor() !== null
}

/** Inject the highlight colors once. ::highlight() can't be set via inline style. */
function ensureHighlightStyle(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) return
  const style = document.createElement("style")
  style.id = STYLE_ELEMENT_ID
  style.textContent = `
    ::highlight(${HIGHLIGHT_NAME}) {
      background-color: rgba(250, 204, 21, 0.45);
      color: inherit;
    }
    ::highlight(${ACTIVE_HIGHLIGHT_NAME}) {
      background-color: #f97316;
      color: #ffffff;
    }
  `
  document.head.appendChild(style)
}

function clearHighlights(): void {
  const registry = getHighlightRegistry()
  if (!registry) return
  registry.delete(HIGHLIGHT_NAME)
  registry.delete(ACTIVE_HIGHLIGHT_NAME)
}

/** Keep the DOM Range corpus identical to the text projection used by the data index. */
export function isSearchableChatTextNode(node: Node, row: HTMLElement): boolean {
  const value = node.nodeValue
  if (!value || !value.trim()) return false
  const parent = (node as Text).parentElement
  if (!parent) return false
  const searchArea = parent.closest<HTMLElement>("[data-chat-search-text]")
  if (!searchArea || !row.contains(searchArea)) return false
  const ignoredArea = parent.closest<HTMLElement>("[data-chat-search-ignore]")
  if (ignoredArea && ignoredArea !== searchArea && row.contains(ignoredArea)) return false
  const tag = parent.tagName
  return tag !== "SCRIPT" && tag !== "STYLE" && tag !== "NOSCRIPT"
}

/** Walk the mounted active row and collect paint ranges matching `query`. */
export function collectMatchRanges(viewport: HTMLElement, query: string): Range[] {
  return mapChatSearchDom(viewport, query).ranges.map((entry) => entry.range)
}

export function formatChatSearchStatus(
  hasQuery: boolean,
  matchCount: number,
  activeIndex: number,
  scanning: boolean,
  truncated: boolean,
  failed: boolean
): string {
  if (!hasQuery) return ""
  const countLabel = matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : ""
  if (scanning) return countLabel ? `${countLabel} · 扫描中` : "扫描中…"
  if (failed) return countLabel ? `${countLabel} · 历史搜索失败` : "历史搜索失败"
  if (truncated) return countLabel ? `${countLabel} · 已截断` : "结果已截断"
  return countLabel || "无结果"
}

export function ChatSearchOverlay({
  searchLocalCorpus,
  onRevealSearchContext,
  onCancelLocalSearch,
  validateSearchLocation,
  open,
  onClose,
  getViewport,
  getSearchCorpus,
  onRevealMessage,
  searchDurableMessages,
  onRevealDurableMessage,
  onCancelDurableReveal,
  recomputeKey
}: ChatSearchOverlayProps): React.JSX.Element | null {
  const [query, setQuery] = useState("")
  const [matchCount, setMatchCount] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [durableScanning, setDurableScanning] = useState(false)
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [durableSearchFailed, setDurableSearchFailed] = useState(false)
  const localScanStateRef = useRef({ scanning: false, truncated: false, failed: false })
  const localRequestRef = useRef(0)
  const localCorpusAbortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const matchesRef = useRef<OverlayChatSearchMatch[]>([])
  const localMatchesRef = useRef<ChatSearchMatch[]>([])
  const localOccurrenceCountsRef = useRef<ReadonlyMap<string, number>>(new Map())
  const localDocumentCoverageRef = useRef<ReadonlyMap<string, boolean>>(new Map())
  const durableMatchesRef = useRef<DurableChatSearchMatch[]>([])
  const durableScanStateRef = useRef({ scanning: false, truncated: false, failed: false })
  const highlightFrameRef = useRef<number | null>(null)
  const highlightGenerationRef = useRef(0)
  const pendingNavigationRef = useRef<number | null>(null)
  const validationAbortRef = useRef<AbortController | null>(null)
  const contextRevealRef = useRef<ChatSearchReveal | null>(null)
  const contextRefreshFrameRef = useRef<number | null>(null)
  const revealCallbacksRef = useRef({
    onRevealMessage,
    onRevealDurableMessage,
    onRevealSearchContext,
    validateSearchLocation
  })
  useLayoutEffect(() => {
    // A durable page replaces the parent's visible-index map. Async continuations must use
    // the callbacks from that commit, not the map captured before hydration began.
    revealCallbacksRef.current = {
      onRevealMessage,
      onRevealDurableMessage,
      onRevealSearchContext,
      validateSearchLocation
    }
  }, [onRevealMessage, onRevealDurableMessage, onRevealSearchContext, validateSearchLocation])

  const searchGenerationRef = useRef(0)
  const searchMatcherRef = useRef(createChatSearchMatcher(CHAT_SEARCH_RESULT_LIMIT + 1))
  const autoRevealedQueryRef = useRef("")
  const durableRevealIdentityRef = useRef("")
  const getSearchCorpusRef = useRef(getSearchCorpus)
  const searchLocalCorpusRef = useRef(searchLocalCorpus)
  const localSearchThrottleRef = useRef<
    LeadingTrailingThrottle<{ generation: number; query: string }> | null
  >(null)
  const publishMatchesRef = useRef<
    (rawQuery: string, repaint: boolean, allowAutoReveal: boolean) => void
  >(() => undefined)
  // Mirror of activeIndex so navigation can compute the next index without a
  // setState updater — keeps updaters pure (no side effects) for StrictMode /
  // concurrent rendering, where an impure updater would run twice.
  const activeIndexRef = useRef(0)
  const apiSupported = useMemo(() => supportsHighlightApi(), [])

  useEffect(() => {
    if (!open) return
    const viewport = getViewport()
    if (!viewport) return
    const cancelNavigationFromInput = (): void => {
      if (pendingNavigationRef.current === null) return
      highlightGenerationRef.current += 1
      pendingNavigationRef.current = null
      validationAbortRef.current?.abort()
      if (highlightFrameRef.current !== null) {
        cancelAnimationFrame(highlightFrameRef.current)
        highlightFrameRef.current = null
      }
      onCancelDurableReveal?.()
    }
    viewport.addEventListener("wheel", cancelNavigationFromInput, { passive: true })
    viewport.addEventListener("touchstart", cancelNavigationFromInput, { passive: true })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        cancelNavigationFromInput()
      }
    }
    viewport.addEventListener("keydown", onKeyDown)
    viewport.addEventListener("pointerdown", cancelNavigationFromInput, { passive: true })
    return () => {
      viewport.removeEventListener("wheel", cancelNavigationFromInput)
      viewport.removeEventListener("touchstart", cancelNavigationFromInput)
      viewport.removeEventListener("keydown", onKeyDown)
      viewport.removeEventListener("pointerdown", cancelNavigationFromInput)
    }
  }, [getViewport, onCancelDurableReveal, open])

  const setActive = useCallback((next: number): void => {
    activeIndexRef.current = next
    setActiveIndex(next)
  }, [])

  // Paint matches within the mounted active row. The global match count comes
  // from the data index, so transcript virtualization never hides results.
  const applyHighlights = useCallback((ranges: Range[], active: number): void => {
    const registry = getHighlightRegistry()
    const HighlightImpl = getHighlightCtor()
    if (!registry || !HighlightImpl) return

    if (ranges.length === 0) {
      clearHighlights()
      return
    }

    ensureHighlightStyle()
    registry.set(HIGHLIGHT_NAME, new HighlightImpl(...ranges))

    const activeRange = ranges[active]
    if (activeRange) {
      const activeHighlight = new HighlightImpl(activeRange)
      // Paint the active match on top of the base highlight.
      activeHighlight.priority = 1
      registry.set(ACTIVE_HIGHLIGHT_NAME, activeHighlight)
    } else {
      registry.delete(ACTIVE_HIGHLIGHT_NAME)
    }
  }, [])

  const revealAndHighlight = useCallback(
    (match: OverlayChatSearchMatch, rawQuery: string, scroll: boolean): void => {
      const findRow = (): { viewport: HTMLElement; row: HTMLElement } | null => {
        const viewport = getViewport()
        const row = viewport
          ? Array.from(viewport.querySelectorAll<HTMLElement>("[data-chat-message-id]")).find(
              (candidate) => candidate.dataset.chatMessageId === match.messageId
            )
          : undefined
        return viewport && row ? { viewport, row } : null
      }
      if (!scroll) {
        // Token refreshes only repaint a mounted row. They must neither cancel a pending
        // navigation nor mount an offscreen result and pull a detached reader back to it.
        if (pendingNavigationRef.current !== null) return
        const mounted = findRow()
        const range =
          mounted && match.location
            ? findChatSearchLocationRange(mounted.row, match.location, rawQuery)
            : null
        const ranges = match.location
          ? range
            ? [range]
            : []
          : mounted
            ? collectMatchRanges(mounted.row, rawQuery.trim())
            : []
        applyHighlights(ranges, match.location ? 0 : match.occurrenceIndex)
        return
      }
      const generation = highlightGenerationRef.current + 1
      const searchGeneration = searchGenerationRef.current
      highlightGenerationRef.current = generation
      pendingNavigationRef.current = generation
      validationAbortRef.current?.abort()
      const validation = new AbortController()
      validationAbortRef.current = validation
      revealCallbacksRef.current.onRevealSearchContext?.(null)
      contextRevealRef.current = null
      if (highlightFrameRef.current !== null) {
        cancelAnimationFrame(highlightFrameRef.current)
        highlightFrameRef.current = null
      }

      const finish = (): void => {
        if (pendingNavigationRef.current === generation) pendingNavigationRef.current = null
        highlightFrameRef.current = null
      }
      let stableFrames = 0
      let previousRangeTop: number | null = null
      let previousScrollHeight = 0
      let contextRequested = false
      let cachedRange: Range | null = null
      const tryHighlight = (attempt: number): void => {
        if (
          highlightGenerationRef.current !== generation ||
          searchGenerationRef.current !== searchGeneration
        ) {
          return
        }
        const mounted = findRow()
        if (!mounted) {
          if (attempt >= SEARCH_REVEAL_MAX_FRAMES) {
            finish()
            return
          }
          highlightFrameRef.current = requestAnimationFrame(() => tryHighlight(attempt + 1))
          return
        }

        const { viewport, row } = mounted
        if (!match.location && row.querySelector("[data-chat-search-expand-markdown]")) {
          // A legacy count-only reply cannot identify a position across folded gaps.
          clearHighlights()
          finish()
          return
        }
        if (prepareChatContentForSearchHighlight(row)) {
          if (attempt >= SEARCH_REVEAL_MAX_FRAMES) {
            finish()
            return
          }
          highlightFrameRef.current = requestAnimationFrame(() => tryHighlight(attempt + 1))
          return
        }

        if (
          cachedRange &&
          (!cachedRange.startContainer.isConnected ||
            !cachedRange.toString().toLowerCase().includes(rawQuery.trim().toLowerCase()))
        )
          cachedRange = null
        const locationRange = match.location
          ? (cachedRange ?? findChatSearchLocationRange(row, match.location, rawQuery))
          : null
        if (match.location && !locationRange && !contextRequested) {
          contextRequested = true
          const reveal = { messageId: match.messageId, location: match.location }
          contextRevealRef.current = reveal
          revealCallbacksRef.current.onRevealSearchContext?.(reveal)
          highlightFrameRef.current = requestAnimationFrame(() => tryHighlight(attempt + 1))
          return
        }
        const ranges = match.location
          ? locationRange
            ? [locationRange]
            : []
          : collectMatchRanges(row, rawQuery.trim())
        const activeOccurrence = match.location ? 0 : match.occurrenceIndex
        if (apiSupported && ranges.length > 0) {
          applyHighlights(ranges, activeOccurrence)
        } else {
          clearHighlights()
        }
        const activeRange = ranges[activeOccurrence]
        cachedRange = activeRange ?? null
        if (activeRange) {
          const rect = activeRange.getBoundingClientRect()
          stableFrames =
            rect.height > 0 &&
            previousRangeTop !== null &&
            Math.abs(rect.top - previousRangeTop) < 1 &&
            viewport.scrollHeight === previousScrollHeight
              ? stableFrames + 1
              : 0
          scrollChatSearchRangeIntoView(viewport, activeRange)
          previousRangeTop = activeRange.getBoundingClientRect().top
          previousScrollHeight = viewport.scrollHeight
        }
        // Expanding Markdown changes the virtual row's measured height. Its ResizeObserver
        // can adjust scrollTop after this frame; retain navigation until layout has settled.
        if (stableFrames >= 2 || attempt >= SEARCH_REVEAL_MAX_FRAMES) {
          finish()
        } else {
          highlightFrameRef.current = requestAnimationFrame(() => tryHighlight(attempt + 1))
        }
      }

      const revealMountedRow = (): void => {
        if (
          highlightGenerationRef.current !== generation ||
          searchGenerationRef.current !== searchGeneration
        ) {
          return
        }
        revealCallbacksRef.current.onRevealMessage(match.messageId)
        const validate = revealCallbacksRef.current.validateSearchLocation
        if (match.location && validate) {
          void validate({ messageId: match.messageId, location: match.location }, validation.signal)
            .then((valid) => {
              if (highlightGenerationRef.current !== generation || validation.signal.aborted) return
              if (valid) tryHighlight(0)
              else {
                clearHighlights()
                finish()
              }
            })
            .catch(() => {
              if (highlightGenerationRef.current === generation) {
                clearHighlights()
                finish()
              }
            })
        } else tryHighlight(0)
      }

      const revealDurable = revealCallbacksRef.current.onRevealDurableMessage
      if (match.durableMatch && !revealDurable) {
        // The bounded preview is still useful when the caller deliberately avoids hydrating a
        // non-contiguous history page. Do not spend 60 animation frames polling for a row that
        // cannot be mounted in this mode.
        clearHighlights()
        finish()
        return
      }
      if (match.durableMatch && revealDurable) {
        void Promise.resolve()
          .then(() => revealDurable(match.durableMatch as DurableChatSearchMatch))
          .then(revealMountedRow)
          .catch(() => {
            if (highlightGenerationRef.current === generation) {
              clearHighlights()
              finish()
            }
          })
        return
      }
      revealMountedRow()
    },
    [apiSupported, applyHighlights, getViewport]
  )

  const publishMatches = useCallback(
    (rawQuery: string, repaint: boolean, allowAutoReveal: boolean): void => {
      const previousMatch = matchesRef.current[activeIndexRef.current]
      const previousKey = previousMatch ? searchMatchKey(previousMatch) : ""
      const merged = mergeChatSearchResults(
        localMatchesRef.current,
        durableMatchesRef.current.filter(
          (match) => !localDocumentCoverageRef.current.get(match.messageId)
        )
      )
      matchesRef.current = merged.matches

      let nextIndex = 0
      if (previousKey) {
        const retainedIndex = merged.matches.findIndex(
          (match) => searchMatchKey(match) === previousKey
        )
        nextIndex =
          retainedIndex >= 0
            ? retainedIndex
            : Math.min(activeIndexRef.current, Math.max(0, merged.matches.length - 1))
      }
      setMatchCount(merged.matches.length)
      setActive(nextIndex)

      const scanState = durableScanStateRef.current
      const localState = localScanStateRef.current
      setDurableScanning(scanState.scanning || localState.scanning)
      setSearchTruncated(merged.truncated || scanState.truncated || localState.truncated)
      setDurableSearchFailed(scanState.failed || localState.failed)

      const activeMatch = merged.matches[nextIndex]
      if (!activeMatch) {
        contextRevealRef.current = null
        revealCallbacksRef.current.onRevealSearchContext?.(null)
        clearHighlights()
        return
      }
      const previousContext = contextRevealRef.current
      if (
        repaint &&
        previousContext &&
        activeMatch.location &&
        pendingNavigationRef.current === null &&
        (previousContext.messageId !== activeMatch.messageId ||
          chatSearchLocationKey(previousContext.location) !==
            chatSearchLocationKey(activeMatch.location))
      ) {
        const reveal = { messageId: activeMatch.messageId, location: activeMatch.location }
        contextRevealRef.current = reveal
        revealCallbacksRef.current.onRevealSearchContext?.(reveal)
        if (contextRefreshFrameRef.current !== null)
          cancelAnimationFrame(contextRefreshFrameRef.current)
        const generation = searchGenerationRef.current
        contextRefreshFrameRef.current = requestAnimationFrame(() => {
          contextRefreshFrameRef.current = null
          if (searchGenerationRef.current === generation)
            revealAndHighlight(activeMatch, rawQuery, false)
        })
      }

      const normalizedQuery = rawQuery.trim().toLowerCase()
      if (allowAutoReveal && autoRevealedQueryRef.current !== normalizedQuery) {
        autoRevealedQueryRef.current = normalizedQuery
        revealAndHighlight(activeMatch, rawQuery, true)
      } else if (repaint && !activeMatch.durableMatch) {
        revealAndHighlight(activeMatch, rawQuery, false)
      }
    },
    [revealAndHighlight, setActive]
  )

  useEffect(() => {
    getSearchCorpusRef.current = getSearchCorpus
    searchLocalCorpusRef.current = searchLocalCorpus
    publishMatchesRef.current = publishMatches
  }, [getSearchCorpus, publishMatches, searchLocalCorpus])

  useEffect(() => {
    const throttle = createLeadingTrailingThrottle<{ generation: number; query: string }>(
      (task) => {
        const request = ++localRequestRef.current
        localCorpusAbortRef.current?.abort()
        const controller = new AbortController()
        localCorpusAbortRef.current = controller
        void (async () => {
          if (searchGenerationRef.current !== task.generation) return
          localScanStateRef.current = { scanning: true, truncated: false, failed: false }
          publishMatchesRef.current(task.query, false, false)
          const corpus = await getSearchCorpusRef.current(controller.signal)
          if (
            searchGenerationRef.current !== task.generation ||
            localRequestRef.current !== request
          )
            return
          const matches = searchLocalCorpusRef.current
            ? await searchLocalCorpusRef.current(corpus, task.query)
            : searchMatcherRef.current(corpus, task.query)
          if (
            searchGenerationRef.current !== task.generation ||
            localRequestRef.current !== request
          )
            return
          // Keep one sentinel past the cap so the UI can report truncation.
          localMatchesRef.current = matches.slice(0, CHAT_SEARCH_RESULT_LIMIT + 1)
          const occurrenceCounts = new Map<string, number>()
          for (const match of localMatchesRef.current) {
            occurrenceCounts.set(match.messageId, (occurrenceCounts.get(match.messageId) ?? 0) + 1)
          }
          localOccurrenceCountsRef.current = occurrenceCounts
          const coverage = new Map<string, boolean>()
          for (const document of corpus.stableDocuments) {
            coverage.set(
              document.messageId,
              Boolean(document.durableAuthoritative) || !document.truncated
            )
          }
          for (const document of corpus.dynamicDocuments) {
            coverage.set(
              document.messageId,
              Boolean(document.durableAuthoritative) || !document.truncated
            )
          }
          localDocumentCoverageRef.current = coverage
          localScanStateRef.current = {
            scanning: false,
            failed: false,
            truncated:
              Boolean(corpus.truncated) ||
              [...corpus.stableDocuments, ...corpus.dynamicDocuments].some((doc) => doc.truncated)
          }
          publishMatchesRef.current(task.query, true, true)
        })().catch(() => {
          if (
            searchGenerationRef.current !== task.generation ||
            localRequestRef.current !== request
          )
            return
          localScanStateRef.current = { scanning: false, truncated: true, failed: true }
          publishMatchesRef.current(task.query, false, false)
        })
      }
    )
    localSearchThrottleRef.current = throttle
    return () => {
      throttle.cancel()
      localSearchThrottleRef.current = null
    }
  }, [])

  const normalizedQuery = query.trim().toLowerCase()

  // Query/open identity owns the durable scan generation. Streaming content
  // updates do not restart the database scan; they only schedule local work.
  useEffect(() => {
    const nextRevealIdentity = open && normalizedQuery ? normalizedQuery : ""
    const previousRevealIdentity = durableRevealIdentityRef.current
    if (
      previousRevealIdentity !== nextRevealIdentity &&
      (previousRevealIdentity || nextRevealIdentity)
    ) {
      onCancelDurableReveal?.()
    }
    durableRevealIdentityRef.current = nextRevealIdentity

    const generation = searchGenerationRef.current + 1
    onCancelLocalSearch?.()
    searchGenerationRef.current = generation
    localRequestRef.current += 1
    localCorpusAbortRef.current?.abort()
    validationAbortRef.current?.abort()
    contextRevealRef.current = null
    if (contextRefreshFrameRef.current !== null) cancelAnimationFrame(contextRefreshFrameRef.current)
    localScanStateRef.current = { scanning: false, truncated: false, failed: false }
    revealCallbacksRef.current.onRevealSearchContext?.(null)
    localSearchThrottleRef.current?.cancel()
    highlightGenerationRef.current += 1
    pendingNavigationRef.current = null
    autoRevealedQueryRef.current = ""
    localMatchesRef.current = []
    localOccurrenceCountsRef.current = new Map()
    localDocumentCoverageRef.current = new Map()
    durableMatchesRef.current = []
    durableScanStateRef.current = { scanning: false, truncated: false, failed: false }
    searchMatcherRef.current = createChatSearchMatcher(CHAT_SEARCH_RESULT_LIMIT + 1)
    publishMatchesRef.current(normalizedQuery, false, false)

    if (!open || !normalizedQuery || !searchDurableMessages) {
      if (!normalizedQuery) clearHighlights()
      return
    }

    let active = true
    const timer = window.setTimeout(() => {
      if (!active || searchGenerationRef.current !== generation) return
      durableScanStateRef.current = { scanning: true, truncated: false, failed: false }
      publishMatchesRef.current(normalizedQuery, false, false)

      void scanDurableChatSearch({
        query: normalizedQuery,
        search: searchDurableMessages,
        maxOccurrences: Math.max(
          0,
          CHAT_SEARCH_RESULT_LIMIT -
            Math.min(localMatchesRef.current.length, CHAT_SEARCH_RESULT_LIMIT)
        ),
        shouldContinue: () => active && searchGenerationRef.current === generation,
        getLocalCoverage: (messageId) => ({
          occurrenceCount: localOccurrenceCountsRef.current.get(messageId) ?? 0,
          authoritative: localDocumentCoverageRef.current.get(messageId) ?? false
        }),
        onProgress: ({ addedMatches }) => {
          if (!active || searchGenerationRef.current !== generation) return
          if (addedMatches.length === 0) return
          durableMatchesRef.current.push(...addedMatches)
          publishMatchesRef.current(normalizedQuery, false, true)
        }
      })
        .then((result) => {
          if (!active || result.cancelled || searchGenerationRef.current !== generation) return
          durableMatchesRef.current = result.matches
          durableScanStateRef.current = {
            scanning: false,
            truncated: result.truncated,
            failed: false
          }
          publishMatchesRef.current(normalizedQuery, false, true)
        })
        .catch(() => {
          if (!active || searchGenerationRef.current !== generation) return
          durableScanStateRef.current = { scanning: false, truncated: false, failed: true }
          publishMatchesRef.current(normalizedQuery, false, false)
        })
    }, DURABLE_SEARCH_SETTLE_MS)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [normalizedQuery, onCancelDurableReveal, onCancelLocalSearch, open, searchDurableMessages])

  // Leading/trailing max-wait throttling guarantees progress during an
  // uninterrupted token stream while still coalescing the hot path.
  useEffect(() => {
    if (!open || !normalizedQuery) return
    localSearchThrottleRef.current?.schedule({
      generation: searchGenerationRef.current,
      query: normalizedQuery
    })
  }, [normalizedQuery, open, recomputeKey])

  // Focus the input when opened; seed it with the current text selection.
  useEffect(() => {
    if (!open) return
    const selection = window.getSelection()?.toString().trim() ?? ""
    const frame = requestAnimationFrame(() => {
      // Deferred into the frame callback so we don't call setState synchronously
      // inside the effect body (avoids a cascading-render lint/perf warning).
      if (selection && selection.length <= 80) {
        setQuery(selection)
      }
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  // Clear highlights whenever the overlay is closed or unmounts.
  useEffect(() => {
    if (open) return
    revealCallbacksRef.current.onRevealSearchContext?.(null)
    highlightGenerationRef.current += 1
    pendingNavigationRef.current = null
    if (highlightFrameRef.current !== null) {
      cancelAnimationFrame(highlightFrameRef.current)
      highlightFrameRef.current = null
    }
    clearHighlights()
  }, [open])

  useEffect(() => {
    return () => {
      searchGenerationRef.current += 1
      localCorpusAbortRef.current?.abort()
      validationAbortRef.current?.abort()
      if (contextRefreshFrameRef.current !== null) cancelAnimationFrame(contextRefreshFrameRef.current)
      highlightGenerationRef.current += 1
      if (highlightFrameRef.current !== null) {
        cancelAnimationFrame(highlightFrameRef.current)
      }
      clearHighlights()
    }
  }, [])

  const goToMatch = useCallback(
    (direction: 1 | -1): void => {
      const matches = matchesRef.current
      if (matches.length === 0) return
      const next = (activeIndexRef.current + direction + matches.length) % matches.length
      setActive(next)
      const match = matches[next]
      revealAndHighlight(match, query, true)
    },
    [query, revealAndHighlight, setActive]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "Enter") {
        event.preventDefault()
        goToMatch(event.shiftKey ? -1 : 1)
      } else if (event.key === "Escape") {
        event.preventDefault()
        onClose()
      }
    },
    [goToMatch, onClose]
  )

  if (!open) return null

  const statusText = formatChatSearchStatus(
    Boolean(query.trim()),
    matchCount,
    activeIndex,
    durableScanning,
    searchTruncated,
    durableSearchFailed
  )

  return (
    <div
      data-chat-search-overlay
      className="absolute right-4 top-3 z-30 flex max-w-[34rem] flex-col rounded-xl border border-border/70 bg-background/95 px-2 py-1.5 shadow-lg shadow-black/10 backdrop-blur-sm"
    >
      <div className="flex items-center gap-1.5">
        <Search className="ml-1 size-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="在当前会话中搜索"
          className="w-44 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          spellCheck={false}
        />
        <span
          aria-live="polite"
          className="min-w-[5rem] shrink-0 text-center text-xs tabular-nums text-muted-foreground"
        >
          {statusText}
        </span>
        <button
          type="button"
          aria-label="上一个匹配"
          disabled={matchCount === 0}
          onClick={() => goToMatch(-1)}
          className={cn(
            "flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            matchCount === 0 && "cursor-not-allowed opacity-40 hover:bg-transparent"
          )}
        >
          <ChevronUp className="size-4" />
        </button>
        <button
          type="button"
          aria-label="下一个匹配"
          disabled={matchCount === 0}
          onClick={() => goToMatch(1)}
          className={cn(
            "flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            matchCount === 0 && "cursor-not-allowed opacity-40 hover:bg-transparent"
          )}
        >
          <ChevronDown className="size-4" />
        </button>
        <button
          type="button"
          aria-label="关闭搜索"
          onClick={onClose}
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
