import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronUp, ChevronDown, X, Search } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * In-session keyword search (Ctrl/Cmd+F) for the chat transcript.
 *
 * Highlighting uses the CSS Custom Highlight API (`CSS.highlights`), which paints
 * over live DOM Ranges WITHOUT mutating the DOM. This is essential here: the
 * transcript is React-rendered markdown, so injecting <mark> wrappers would fight
 * React's reconciliation and corrupt the tree. Ranges become stale when React
 * replaces text nodes (e.g. during streaming), so the match set is recomputed
 * whenever `recomputeKey` changes.
 *
 * Limitation (acceptable for a phase-1 keyword find): a match must fall within a
 * single text node. A phrase split across element boundaries (e.g. spanning a
 * **bold** run) is not matched. Most keyword/phrase searches live in one text node.
 */

interface ChatSearchOverlayProps {
  open: boolean
  onClose: () => void
  /** Returns the scrollable viewport element to search and scroll within. */
  getViewport: () => HTMLElement | null
  /** Changes whenever the rendered transcript changes, to re-run the search. */
  recomputeKey: unknown
}

const HIGHLIGHT_NAME = "chat-search"
const ACTIVE_HIGHLIGHT_NAME = "chat-search-active"
const STYLE_ELEMENT_ID = "chat-search-highlight-style"
const SEARCH_DEBOUNCE_MS = 120

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

/** Walk visible text nodes in the viewport and collect ranges matching `query`. */
function collectMatchRanges(viewport: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase()
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
  while (current) {
    const haystack = (current.nodeValue ?? "").toLowerCase()
    let from = 0
    let idx = haystack.indexOf(needle, from)
    while (idx !== -1) {
      const range = document.createRange()
      range.setStart(current, idx)
      range.setEnd(current, idx + needle.length)
      ranges.push(range)
      from = idx + needle.length
      idx = haystack.indexOf(needle, from)
    }
    current = walker.nextNode()
  }
  return ranges
}

export function ChatSearchOverlay({
  open,
  onClose,
  getViewport,
  recomputeKey
}: ChatSearchOverlayProps): React.JSX.Element | null {
  const [query, setQuery] = useState("")
  const [matchCount, setMatchCount] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rangesRef = useRef<Range[]>([])
  // Mirror of activeIndex so navigation can compute the next index without a
  // setState updater — keeps updaters pure (no side effects) for StrictMode /
  // concurrent rendering, where an impure updater would run twice.
  const activeIndexRef = useRef(0)
  const apiSupported = useMemo(() => supportsHighlightApi(), [])

  const setActive = useCallback((next: number): void => {
    activeIndexRef.current = next
    setActiveIndex(next)
  }, [])

  // Paint all matches + the active match, then scroll the active match into view.
  const applyHighlights = useCallback((ranges: Range[], active: number, scroll: boolean): void => {
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

      if (scroll) {
        // Scroll the parent element (not the Range) — with content-visibility
        // the offscreen Range may report a zero rect, but the element box exists.
        const anchor = activeRange.startContainer.parentElement
        anchor?.scrollIntoView({ block: "center" })
      }
    } else {
      registry.delete(ACTIVE_HIGHLIGHT_NAME)
    }
  }, [])

  // Recompute matches when the query, transcript, or open state changes.
  useEffect(() => {
    if (!open || !apiSupported) return
    const trimmed = query.trim()

    const timer = window.setTimeout(() => {
      const viewport = getViewport()
      if (!viewport || !trimmed) {
        rangesRef.current = []
        setMatchCount(0)
        setActive(0)
        clearHighlights()
        return
      }

      const ranges = collectMatchRanges(viewport, trimmed)
      rangesRef.current = ranges
      setMatchCount(ranges.length)
      // Keep the active index in range as content streams in/out.
      const next = ranges.length === 0 ? 0 : Math.min(activeIndexRef.current, ranges.length - 1)
      setActive(next)
      applyHighlights(ranges, next, false)
    }, SEARCH_DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [open, query, recomputeKey, apiSupported, getViewport, applyHighlights, setActive])

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
    clearHighlights()
  }, [open])

  useEffect(() => {
    return () => clearHighlights()
  }, [])

  const goToMatch = useCallback(
    (direction: 1 | -1): void => {
      const ranges = rangesRef.current
      if (ranges.length === 0) return
      const next = (activeIndexRef.current + direction + ranges.length) % ranges.length
      setActive(next)
      applyHighlights(ranges, next, true)
    },
    [applyHighlights, setActive]
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

  return (
    <div
      data-chat-search-overlay
      className="absolute right-4 top-3 z-30 flex items-center gap-1.5 rounded-xl border border-border/70 bg-background/95 px-2 py-1.5 shadow-lg shadow-black/10 backdrop-blur-sm"
    >
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
      <span className="min-w-[3.5rem] shrink-0 text-center text-xs tabular-nums text-muted-foreground">
        {query.trim() ? (matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : "无结果") : ""}
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
  )
}
