/* eslint-disable react-refresh/only-export-components -- colocated search contracts and bounded runtime primitives are tested directly */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronUp, ChevronDown, X, Search } from "lucide-react"
import { cn } from "@/lib/utils"
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
  open: boolean
  onClose: () => void
  /** Returns the scrollable viewport element to search and scroll within. */
  getViewport: () => HTMLElement | null
  /** Returns the stable-history and live-tail search indexes after the debounce. */
  getSearchCorpus: () => ChatSearchCorpus
  /** Ensures a virtualized message row is mounted before highlighting it. */
  onRevealMessage: (messageId: string) => void
  /** Searches durable pages beyond the currently loaded renderer window. */
  searchDurableMessages?: SearchDurableMessages
  /** Loads an unloaded durable result before the overlay asks to paint it. */
  onRevealDurableMessage?: RevealDurableMessage
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
  shouldExcludeMessageId?: (messageId: string) => boolean
  yieldControl?: () => Promise<void>
  onProgress?: (progress: DurableChatSearchProgress) => void
}

export interface LeadingTrailingThrottle<T> {
  schedule(value: T): void
  cancel(): void
  flush(): void
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
  shouldExcludeMessageId = () => false,
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
      // Loaded/live rows are searched locally. They must not consume the durable
      // occurrence budget, or a hit-heavy latest page could hide older history.
      if (shouldExcludeMessageId(match.messageId)) continue

      const requestedOccurrences = Math.max(1, Math.floor(match.occurrenceCount || 1))
      const remaining = occurrenceLimit - retainedOccurrenceCount
      if (remaining <= 0) {
        truncated = true
        break
      }
      const retainedOccurrences = Math.min(requestedOccurrences, remaining)
      const boundedMatch: DurableChatSearchMatch = {
        ...match,
        occurrenceCount: retainedOccurrences,
        preview: boundDurableSearchPreview(match.preview)
      }
      retained.push(boundedMatch)
      addedMatches.push(boundedMatch)
      retainedOccurrenceCount += retainedOccurrences

      if (retainedOccurrences < requestedOccurrences) truncated = true
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

export function mergeChatSearchResults(
  localMatches: readonly ChatSearchMatch[],
  durableMatches: readonly DurableChatSearchMatch[],
  limit = CHAT_SEARCH_RESULT_LIMIT
): { matches: OverlayChatSearchMatch[]; truncated: boolean } {
  const boundedLimit = Math.max(0, Math.floor(limit))
  const localMessageIds = new Set(localMatches.map((match) => match.messageId))
  const boundedLocal = localMatches.slice(0, boundedLimit)
  const durableCapacity = Math.max(0, boundedLimit - boundedLocal.length)
  const matches: OverlayChatSearchMatch[] = []
  let truncated = localMatches.length > boundedLimit

  // Durable results which are not loaded are older than the locally loaded tail.
  // Restore transcript order after the backend's newest-to-oldest page order.
  const orderedDurable = [...durableMatches].sort((left, right) => {
    if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal
    return left.messageId.localeCompare(right.messageId)
  })
  const seenDurableIds = new Set<string>()
  for (const durableMatch of orderedDurable) {
    if (
      matches.length >= durableCapacity ||
      localMessageIds.has(durableMatch.messageId) ||
      seenDurableIds.has(durableMatch.messageId)
    ) {
      if (!localMessageIds.has(durableMatch.messageId)) truncated = true
      continue
    }
    seenDurableIds.add(durableMatch.messageId)
    const occurrenceCount = Math.max(1, Math.floor(durableMatch.occurrenceCount || 1))
    for (let occurrenceIndex = 0; occurrenceIndex < occurrenceCount; occurrenceIndex += 1) {
      if (matches.length >= durableCapacity) {
        truncated = true
        break
      }
      matches.push({
        messageId: durableMatch.messageId,
        occurrenceIndex,
        sortIndex: durableMatch.ordinal,
        durableMatch
      })
    }
  }

  for (const localMatch of boundedLocal) {
    if (matches.length >= boundedLimit) {
      truncated = true
      break
    }
    matches.push(localMatch)
  }
  return { matches, truncated }
}

/** Return non-overlapping match offsets without allocating beyond `limit`. */
export function collectNeedleOffsets(
  rawText: string,
  rawQuery: string,
  limit = CHAT_SEARCH_HIGHLIGHT_RANGE_LIMIT
): number[] {
  const text = rawText.toLocaleLowerCase()
  const query = rawQuery.toLocaleLowerCase()
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

/** Walk the mounted active row and collect paint ranges matching `query`. */
function collectMatchRanges(viewport: HTMLElement, query: string): Range[] {
  const needle = query.toLocaleLowerCase()
  if (!needle) return []

  const walker = document.createTreeWalker(viewport, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const value = node.nodeValue
      if (!value || !value.trim()) return NodeFilter.FILTER_REJECT
      const parent = (node as Text).parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      // Skip our own overlay UI and non-rendered nodes.
      if (parent.closest("[data-chat-search-overlay]")) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    }
  })

  const ranges: Range[] = []
  let current = walker.nextNode()
  while (current && ranges.length < CHAT_SEARCH_HIGHLIGHT_RANGE_LIMIT) {
    const offsets = collectNeedleOffsets(
      current.nodeValue ?? "",
      needle,
      CHAT_SEARCH_HIGHLIGHT_RANGE_LIMIT - ranges.length
    )
    for (const offset of offsets) {
      const range = document.createRange()
      range.setStart(current, offset)
      range.setEnd(current, offset + needle.length)
      ranges.push(range)
    }
    current = walker.nextNode()
  }
  return ranges
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
  open,
  onClose,
  getViewport,
  getSearchCorpus,
  onRevealMessage,
  searchDurableMessages,
  onRevealDurableMessage,
  recomputeKey
}: ChatSearchOverlayProps): React.JSX.Element | null {
  const [query, setQuery] = useState("")
  const [matchCount, setMatchCount] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [activePreview, setActivePreview] = useState("")
  const [durableScanning, setDurableScanning] = useState(false)
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [durableSearchFailed, setDurableSearchFailed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const matchesRef = useRef<OverlayChatSearchMatch[]>([])
  const localMatchesRef = useRef<ChatSearchMatch[]>([])
  const localMessageIdsRef = useRef<ReadonlySet<string>>(new Set())
  const durableMatchesRef = useRef<DurableChatSearchMatch[]>([])
  const durableScanStateRef = useRef({ scanning: false, truncated: false, failed: false })
  const highlightFrameRef = useRef<number | null>(null)
  const highlightGenerationRef = useRef(0)
  const searchGenerationRef = useRef(0)
  const searchMatcherRef = useRef(createChatSearchMatcher(CHAT_SEARCH_RESULT_LIMIT + 1))
  const autoRevealedQueryRef = useRef("")
  const getSearchCorpusRef = useRef(getSearchCorpus)
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
      const generation = highlightGenerationRef.current + 1
      const searchGeneration = searchGenerationRef.current
      highlightGenerationRef.current = generation
      if (highlightFrameRef.current !== null) {
        cancelAnimationFrame(highlightFrameRef.current)
        highlightFrameRef.current = null
      }

      const tryHighlight = (attempt: number): void => {
        if (
          highlightGenerationRef.current !== generation ||
          searchGenerationRef.current !== searchGeneration
        ) {
          return
        }
        const viewport = getViewport()
        const row = viewport
          ? Array.from(viewport.querySelectorAll<HTMLElement>("[data-chat-message-id]")).find(
              (candidate) => candidate.dataset.chatMessageId === match.messageId
            )
          : undefined
        if (!row) {
          if (attempt >= SEARCH_REVEAL_MAX_FRAMES) {
            highlightFrameRef.current = null
            return
          }
          highlightFrameRef.current = requestAnimationFrame(() => tryHighlight(attempt + 1))
          return
        }

        highlightFrameRef.current = null
        const ranges = collectMatchRanges(row, rawQuery.trim())
        if (apiSupported && ranges.length > 0) {
          applyHighlights(ranges, Math.min(match.occurrenceIndex, ranges.length - 1))
        } else {
          clearHighlights()
        }
        if (scroll) row.scrollIntoView({ block: "center", behavior: "smooth" })
      }

      const revealMountedRow = (): void => {
        if (
          highlightGenerationRef.current !== generation ||
          searchGenerationRef.current !== searchGeneration
        ) {
          return
        }
        onRevealMessage(match.messageId)
        tryHighlight(0)
      }

      if (match.durableMatch && !onRevealDurableMessage) {
        // The bounded preview is still useful when the caller deliberately avoids hydrating a
        // non-contiguous history page. Do not spend 60 animation frames polling for a row that
        // cannot be mounted in this mode.
        clearHighlights()
        return
      }
      if (match.durableMatch && onRevealDurableMessage) {
        void Promise.resolve()
          .then(() => onRevealDurableMessage(match.durableMatch as DurableChatSearchMatch))
          .then(revealMountedRow)
          .catch(() => {
            if (highlightGenerationRef.current === generation) clearHighlights()
          })
        return
      }
      revealMountedRow()
    },
    [
      apiSupported,
      applyHighlights,
      getViewport,
      onRevealDurableMessage,
      onRevealMessage
    ]
  )

  const publishMatches = useCallback(
    (rawQuery: string, repaint: boolean, allowAutoReveal: boolean): void => {
      const previousMatch = matchesRef.current[activeIndexRef.current]
      const previousKey = previousMatch
        ? `${previousMatch.messageId}\u0000${previousMatch.occurrenceIndex}`
        : ""
      const merged = mergeChatSearchResults(
        localMatchesRef.current,
        durableMatchesRef.current
      )
      matchesRef.current = merged.matches

      let nextIndex = 0
      if (previousKey) {
        const retainedIndex = merged.matches.findIndex(
          (match) => `${match.messageId}\u0000${match.occurrenceIndex}` === previousKey
        )
        nextIndex =
          retainedIndex >= 0
            ? retainedIndex
            : Math.min(activeIndexRef.current, Math.max(0, merged.matches.length - 1))
      }
      setMatchCount(merged.matches.length)
      setActive(nextIndex)

      const scanState = durableScanStateRef.current
      setDurableScanning(scanState.scanning)
      setSearchTruncated(merged.truncated || scanState.truncated)
      setDurableSearchFailed(scanState.failed)

      const activeMatch = merged.matches[nextIndex]
      setActivePreview(activeMatch?.durableMatch?.preview ?? "")
      if (!activeMatch) {
        clearHighlights()
        return
      }

      const normalizedQuery = rawQuery.trim().toLocaleLowerCase()
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
    publishMatchesRef.current = publishMatches
  }, [getSearchCorpus, publishMatches])

  useEffect(() => {
    const throttle = createLeadingTrailingThrottle<{ generation: number; query: string }>(
      (task) => {
        if (searchGenerationRef.current !== task.generation) return
        const matches = searchMatcherRef.current(getSearchCorpusRef.current(), task.query)
        // Keep one sentinel past the cap so the UI can report truncation.
        localMatchesRef.current = matches.slice(0, CHAT_SEARCH_RESULT_LIMIT + 1)
        localMessageIdsRef.current = new Set(
          localMatchesRef.current.map((match) => match.messageId)
        )
        publishMatchesRef.current(task.query, true, true)
      }
    )
    localSearchThrottleRef.current = throttle
    return () => {
      throttle.cancel()
      localSearchThrottleRef.current = null
    }
  }, [])

  const normalizedQuery = query.trim().toLocaleLowerCase()

  // Query/open identity owns the durable scan generation. Streaming content
  // updates do not restart the database scan; they only schedule local work.
  useEffect(() => {
    const generation = searchGenerationRef.current + 1
    searchGenerationRef.current = generation
    localSearchThrottleRef.current?.cancel()
    highlightGenerationRef.current += 1
    autoRevealedQueryRef.current = ""
    localMatchesRef.current = []
    localMessageIdsRef.current = new Set()
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
        shouldExcludeMessageId: (messageId) => localMessageIdsRef.current.has(messageId),
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
  }, [normalizedQuery, open, searchDurableMessages])

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
    highlightGenerationRef.current += 1
    if (highlightFrameRef.current !== null) {
      cancelAnimationFrame(highlightFrameRef.current)
      highlightFrameRef.current = null
    }
    clearHighlights()
  }, [open])

  useEffect(() => {
    return () => {
      searchGenerationRef.current += 1
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
      setActivePreview(match.durableMatch?.preview ?? "")
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
      {activePreview && (
        <div
          data-chat-search-durable-preview
          className="max-w-[32rem] truncate px-1 pb-0.5 pt-1 text-xs text-muted-foreground"
          title={activePreview}
        >
          历史消息：{activePreview}
        </div>
      )}
    </div>
  )
}
