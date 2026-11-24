import {
  Fragment,
  memo,
  startTransition,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react"
import { createPortal, flushSync } from "react-dom"
import { GitBranch, GitGraph, GitMerge, Loader2, RefreshCw, Tag, X } from "lucide-react"
import { FocusScope } from "@radix-ui/react-focus-scope"
import { hideOthers } from "aria-hidden"
import { Button } from "@/components/ui/button"
import { observeWorkbenchDialogOpen } from "@/lib/modal-dialog"
import { cn } from "@/lib/utils"
import { retainListFocus } from "@/lib/virtual-row-focus"
import { GIT_BRANCH_REFRESH_EVENT, type GitBranchSwitched } from "../../../../shared/git-branches"
import { gitGraphRefAt, type GitGraphCommit, type GitGraphRef } from "../../../../shared/git-graph"
import {
  layoutGitGraph,
  mapScrollPosition,
  maxScrollHeight,
  visibleGraphLines,
  type BranchLineSeed
} from "./git-graph-layout"

const colors = ["#e58a38", "#4b96ed", "#49a56a", "#bc78cd"]
const unavailableButtonClass = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
const rowHeight = 42
const prefetchRows = 50
const refPageSize = 50
const laneSpacing = 18
const laneX = (lane: number) => 16 + lane * laneSpacing
const rowY = (row: number) => rowHeight / 2 + row * rowHeight
const shortHash = (hash: string) => hash.slice(0, 7)
const maxDateMs = 8_640_000_000_000_000
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
})

function formatCommitDate(timestamp: number): string {
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= maxDateMs
    ? dateFormat.format(timestamp)
    : "—"
}

function linePath(x1: number, x2: number, from: BranchLineSeed["from"], to: BranchLineSeed["to"]): string {
  const y1 = rowY(from.rowIndex),
    y2 = rowY(to.rowIndex)
  if (x1 === x2) return `M${x1},${y1}V${y2}`
  const control = (y1 + y2) / 2
  if (Math.abs(x2 - x1) > maxGraphColumnWidth) {
    // Long connections share a straight middle span. Outside bends can be
    // clipped without changing a single visible pixel of this path.
    const bend = Math.sign(x2 - x1) * maxGraphColumnWidth / 2
    return `M${x1},${y1}Q${x1},${control} ${x1 + bend},${control}H${x2 - bend}Q${x2},${control} ${x2},${y2}`
  }
  return `M${x1},${y1}C${x1},${control} ${x2},${control} ${x2},${y2}`
}

function RefBadges({ refs, compact = false }: { refs: GitGraphRef[]; compact?: boolean }) {
  if (!refs.length) return null
  return (
    <span
      className={cn(
        "flex min-w-0 gap-1",
        compact ? "max-w-[75%] shrink-0 overflow-hidden" : "flex-wrap"
      )}
    >
      {(compact ? refs.slice(0, 4) : refs).map(({ kind, name }) => {
        const isTag = kind === "tag"
        const Icon = isTag ? Tag : GitBranch
        return (
          <span
            key={`${kind}:${name}`}
            title={name}
            className={cn(
              "inline-flex h-5 min-w-0 items-center gap-1 rounded-md border bg-muted/50 px-1.5 text-xs text-muted-foreground",
              kind === "head" && "border-amber-600 text-foreground",
              isTag && "border-green-600"
            )}
          >
            <Icon className="size-2.5 shrink-0" />
            <span className={cn("truncate", compact ? "max-w-32" : "max-w-48")}>{name}</span>
          </span>
        )
      })}
    </span>
  )
}

function CommitRefList({ commit, count }: { commit: GitGraphCommit; count: number }) {
  const [firstVisible, setFirstVisible] = useState(0)
  const height = 24
  const first = Math.max(0, firstVisible - 3)
  const end = Math.min(count, firstVisible + 8)
  return (
    <div
      role="list"
      aria-label="提交引用"
      tabIndex={0}
      className="overflow-y-auto"
      style={{ height: Math.min(120, count * height) }}
      onScroll={(event) => setFirstVisible(Math.floor(event.currentTarget.scrollTop / height))}
    >
      <div className="relative" style={{ height: count * height }}>
        {Array.from({ length: end - first }, (_, offset) => {
          const index = first + offset
          return (
            <div
              key={index}
              role="listitem"
              aria-posinset={index + 1}
              aria-setsize={count}
              className="absolute inset-x-0"
              style={{ top: index * height, height }}
            >
              <RefBadges refs={[gitGraphRefAt(commit, index)]} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

const CommitDetails = memo(function CommitDetails({ commit }: { commit: GitGraphCommit }) {
  const refCount = commit.packedRefs?.length ?? commit.refs.length

  return (
    <section
      aria-label="提交详情"
      className="grid max-h-[30vh] shrink-0 gap-3 overflow-auto border-t bg-muted/25 p-3 text-sm sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
    >
      <div className="min-w-0">
        <p className="mb-1 text-muted-foreground">主题</p>
        <p className="break-words">{commit.subject || shortHash(commit.hash)}</p>
        {refCount > 0 && (
          <div className="mt-2 space-y-1">
            {refCount > refPageSize || commit.packedRefs ? (
              <CommitRefList key={commit.hash} commit={commit} count={refCount} />
            ) : (
              <RefBadges refs={commit.refs} />
            )}
          </div>
        )}
      </div>
      <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2">
        {[
          ["提交", commit.hash],
          ["作者", commit.author],
          ["日期", formatCommitDate(commit.timestamp)],
          ["父提交", commit.parents.map(shortHash).join(", ") || "—"]
        ].map(([name, value]) => (
          <div key={name} className="min-w-0">
            <dt className="text-muted-foreground">{name}</dt>
            <dd
              title={value}
              className={cn("truncate", (name === "提交" || name === "父提交") && "font-mono")}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
})

const blockSize = 10
const tableHeaderHeight = 40
const overscanRows = 3
const firstPaintRows = 2
const initialRowsPerFrame = 4
const maxGraphColumnWidth = 320

type GraphBlock = Awaited<ReturnType<typeof layoutGitGraph>> & { start: number }
type GraphColumns = { gridTemplateColumns: string }
type History = {
  blocks: GraphBlock[]
  count: number
  width: number
  hasMore: boolean
  snapshot?: string
}
type GraphLoadMode = "replace" | "more" | "prefetch"
type GraphLoadError = { message: string; mode: Exclude<GraphLoadMode, "prefetch"> }
const emptyHistory: History = { blocks: [], count: 0, width: 1, hasMore: false }

async function appendCommits(
  history: History,
  page: Awaited<ReturnType<typeof window.api.git.getCommitGraph>>,
  isCurrent: () => boolean
): Promise<History> {
  let sliceStart = performance.now()
  function yieldIfBusy(): Promise<void> | undefined {
    if (performance.now() - sliceStart < 6) return
    return new Promise<void>((resolve, reject) => setTimeout(() => {
      if (!isCurrent()) return reject(new DOMException("Graph request superseded", "AbortError"))
      sliceStart = performance.now()
      resolve()
    }, 0))
  }
  const blocks = history.blocks.slice()
  let width = history.width
  // Each block continues the previous block; build the target index once per page.
  const targets = new Map<string, number>()
  const incoming = blocks.at(-1)?.outgoing ?? []
  for (let column = 0; column < incoming.length; column++) {
    if (column % 1024 === 0) {
      const pause = yieldIfBusy()
      if (pause) await pause
    }
    const lane = incoming[column]
    if (lane) targets.set(lane.targetHash, column)
  }
  for (let i = 0; i < page.commits.length; i += blockSize) {
    const pause = yieldIfBusy()
    if (pause) await pause
    const block = await layoutGitGraph(
      page.commits.slice(i, i + blockSize), blocks.at(-1)?.outgoing, targets, yieldIfBusy
    )
    blocks.push({ ...block, start: history.count + i })
    width = Math.max(width, block.width)
  }
  return {
    blocks,
    count: history.count + page.commits.length,
    width,
    hasMore: page.hasMore,
    snapshot: page.snapshot
  }
}

function visibleBlocks(blocks: GraphBlock[], start: number, end: number) {
  let low = 0,
    high = blocks.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (blocks[mid].start + blocks[mid].rows.length <= start) low = mid + 1
    else high = mid
  }
  let stop = low
  while (stop < blocks.length && blocks[stop].start < end) stop++
  return blocks.slice(low, stop)
}

function compileBlockPaths(block: GraphBlock, offset: number, width: number, relatedHash?: string) {
  const firstLane = Math.floor((offset - laneX(0) - 1) / laneSpacing)
  const lastLane = Math.ceil((offset + width - laneX(0) + 1) / laneSpacing)
  const left = offset - maxGraphColumnWidth - laneSpacing
  const right = offset + width + maxGraphColumnWidth + laneSpacing
  const clip = {
    first: Math.floor((left - laneX(0)) / laneSpacing),
    last: Math.ceil((right - laneX(0)) / laneSpacing),
    colors: colors.length
  }
  const strokes = colors.map(() => new Set<string>())
  for (const { from, to, colourIndex } of visibleGraphLines(block, firstLane, lastLane, relatedHash, clip)) {
    const x1 = Math.max(left, Math.min(right, laneX(from.laneIndex)))
    const x2 = Math.max(left, Math.min(right, laneX(to.laneIndex)))
    strokes[colourIndex % colors.length].add(linePath(x1, x2, from, to))
  }
  return strokes.map(paths => Array.from(paths).join(" "))
}

const GraphBlockDrawing = memo(function GraphBlockDrawing({
  block,
  rowCount,
  width,
  laneOffset,
  hovered,
  selected
}: {
  block: GraphBlock
  rowCount: number
  width: number
  laneOffset: number
  hovered: string | null
  selected: string | null
}) {
  const paths = useMemo(() => compileBlockPaths(block, laneOffset, width), [block, laneOffset, width])
  const highlighted = useMemo(
    () => hovered ? compileBlockPaths(block, laneOffset, width, hovered) : [],
    [block, laneOffset, width, hovered]
  )
  const height = rowCount * rowHeight

  return (
    <svg
      role="img"
      aria-label="Git 提交图"
      width={width}
      height={height}
      viewBox={`${laneOffset} 0 ${width} ${height}`}
      className="pointer-events-none absolute left-0 top-0 z-10 overflow-hidden bg-muted/20"
    >
      {paths.map(
        (path, color) =>
          path && (
            <path
              key={color}
              d={path}
              stroke={colors[color]}
              opacity={hovered ? 0.3 : 0.6}
              strokeWidth={2}
              fill="none"
            />
          )
      )}
      {highlighted.map(
        (path, color) =>
          path && <path key={color} d={path} stroke={colors[color]} strokeWidth={2} fill="none" />
      )}
      {block.rows.slice(0, rowCount).map(({ commit, column, colourIndex }, i) => (
        <Fragment key={commit.hash}>
          <circle
            cx={laneX(column)}
            cy={rowY(i)}
            r={4}
            fill={colors[colourIndex % colors.length]}
            opacity={hovered && hovered !== commit.hash && selected !== commit.hash ? 0.6 : 1}
            className="stroke-background"
            strokeWidth={1.5}
          />
          {selected === commit.hash && (
            <circle
              cx={laneX(column)}
              cy={rowY(i)}
              r={5.5}
              fill="none"
              stroke={colors[colourIndex % colors.length]}
            />
          )}
        </Fragment>
      ))}
    </svg>
  )
})

const GraphBlockRows = memo(function GraphBlockRows({
  block,
  start,
  end,
  columns,
  selected,
  expanded,
  onHover,
  onSelect
}: {
  block: GraphBlock
  start: number
  end: number
  columns: GraphColumns
  selected: string | null
  expanded?: string
  onHover: (hash: string | null) => void
  onSelect: (commit: GitGraphCommit) => void
}) {
  return (
    <div style={start ? { paddingTop: start * rowHeight } : undefined}>
      {block.rows.slice(start, end).map(({ commit }) => (
        <GraphRow
          key={commit.hash}
          commit={commit}
          columns={columns}
          selected={commit.hash === selected}
          expanded={commit.hash === expanded}
          onHover={onHover}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
})

const GraphRow = memo(function GraphRow({
  commit,
  columns,
  selected,
  expanded,
  onHover,
  onSelect
}: {
  commit: GitGraphCommit
  columns: GraphColumns
  selected: boolean
  expanded: boolean
  onHover: (hash: string | null) => void
  onSelect: (commit: GitGraphCommit) => void
}) {
  return (
    <button
      type="button"
      ref={retainListFocus}
      aria-pressed={selected}
      aria-expanded={expanded}
      className="grid w-full items-center text-left text-sm hover:bg-muted/40 aria-pressed:bg-muted/60"
      style={{ ...columns, height: rowHeight }}
      onMouseEnter={() => onHover(commit.hash)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onSelect(commit)}
    >
      <span aria-hidden="true" className="self-stretch border-r" />
      <span className="flex min-w-0 items-center gap-2 px-3">
        <RefBadges refs={commit.refs} compact />
        <span className="truncate" title={commit.subject}>
          {commit.subject || shortHash(commit.hash)}
        </span>
        {commit.parents.length > 1 && (
          <GitMerge aria-label="合并提交" className="size-3 shrink-0 text-blue-500" />
        )}
      </span>
      <time className="truncate px-3 text-muted-foreground">
        {formatCommitDate(commit.timestamp)}
      </time>
      <span className="truncate px-3 text-muted-foreground" title={commit.author}>
        {commit.author}
      </span>
      <span className="truncate px-3 font-mono text-muted-foreground">
        {shortHash(commit.hash)}
      </span>
    </button>
  )
})

export function GitGraphDialog({
  cwd,
  gitDir,
  onClose,
  onCloseAutoFocus
}: {
  cwd?: string
  gitDir?: string
  onClose: () => void
  onCloseAutoFocus?: () => void
}): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)
  const refreshRef = useRef<HTMLButtonElement>(null)
  const showBackground = useRef<() => void>(undefined)
  const openTimer = useRef<number>(undefined)
  const restoreFocusOnClose = useRef(false)
  const titleId = useId()
  const descriptionId = useId()
  useLayoutEffect(() => {
    const overlay = overlayRef.current
    if (!overlay) return
    if (overlay.matches(":popover-open")) showBackground.current = hideOthers(overlay)
    return () => {
      window.clearTimeout(openTimer.current)
      showBackground.current?.()
      showBackground.current = undefined
    }
  }, [])
  useLayoutEffect(() => {
    const stopWatchingDialogs = observeWorkbenchDialogOpen(() => {
      window.clearTimeout(openTimer.current)
      restoreFocusOnClose.current = false
      onClose()
    })

    const handleEscape = (event: KeyboardEvent): void => {
      const overlay = overlayRef.current
      if (event.key !== "Escape" || !overlay) return
      // Keep workbench shortcuts from handling Escape, even if a virtual row lost focus.
      event.preventDefault()
      event.stopImmediatePropagation()
      if (overlay.matches(":popover-open")) overlay.hidePopover()
      else {
        window.clearTimeout(openTimer.current)
        restoreFocusOnClose.current = true
        onClose()
      }
    }
    window.addEventListener("keydown", handleEscape, true)
    return () => {
      stopWatchingDialogs()
      window.removeEventListener("keydown", handleEscape, true)
    }
  }, [onClose])
  const [history, setHistory] = useState(emptyHistory)
  const [presented, setPresented] = useState(false)
  const current = useRef(emptyHistory)
  const [{ row: firstRow, offset: rowOffset }, setViewport] = useState({ row: 0, offset: 0 })
  const [viewportHeight, setViewportHeight] = useState<number | null>(null)
  const [initialRowLimit, setInitialRowLimit] = useState<number | null>(firstPaintRows)
  const [firstLane, setFirstLane] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<GitGraphCommit | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<GraphLoadError | null>(null)
  const [historyChanged, setHistoryChanged] = useState(false)
  const request = useRef(0)
  const pending = useRef<GraphLoadMode | null>(null)
  const skipPrefetch = useRef<History | null>(null)
  const unverifiedBranchChanges = useRef(new Set<string>())
  const scroller = useRef<HTMLDivElement>(null)
  const measuredHeight = useRef<number | null>(null)
  const scrollTop = useRef(0)
  const historyHeight = history.count * rowHeight
  const hasHistory = history.count > 0
  const canvasHeight = Math.min(historyHeight, maxScrollHeight)
  const lastHeight = useRef(0)
  const viewportPosition = useCallback(
    (scrollTop: number) => {
      const y = scrollTop - tableHeaderHeight
      const logicalY = mapScrollPosition(y, canvasHeight, historyHeight)
      return { row: Math.max(0, Math.floor(logicalY / rowHeight)), offset: logicalY - y }
    },
    [canvasHeight, historyHeight]
  )
  useLayoutEffect(() => {
    const view = scroller.current
    if (!view) return
    const observer = new ResizeObserver(() => {
      const height = view.clientHeight
      const top = view.scrollTop
      const scrolled = top !== scrollTop.current
      if (height === measuredHeight.current && !scrolled) return
      measuredHeight.current = height
      // Growing the viewport can also move the scroll position away from the old bottom.
      flushSync(() => {
        setViewportHeight(height)
        if (scrolled) {
          scrollTop.current = top
          setViewport(viewportPosition(top))
        }
      })
    })
    observer.observe(view)
    return () => observer.disconnect()
  }, [viewportPosition])
  useLayoutEffect(() => {
    const previous = lastHeight.current
    lastHeight.current = historyHeight
    const view = scroller.current
    if (!view || !previous || canvasHeight === historyHeight || previous === historyHeight) return
    const anchor = mapScrollPosition(
      view.scrollTop - tableHeaderHeight,
      Math.min(previous, maxScrollHeight),
      previous
    )
    view.scrollTop = tableHeaderHeight + mapScrollPosition(anchor, historyHeight, canvasHeight)
    scrollTop.current = view.scrollTop
    setViewport(viewportPosition(scrollTop.current))
  }, [canvasHeight, historyHeight, viewportPosition])
  const naturalGraphWidth = Math.max(56, 44 + (history.width - 1) * laneSpacing)
  const graphWidth = Math.min(naturalGraphWidth, maxGraphColumnWidth)
  const maxLaneOffset = naturalGraphWidth - graphWidth
  const maxFirstLane = Math.ceil(maxLaneOffset / laneSpacing)
  const laneOffset = Math.min(firstLane * laneSpacing, maxLaneOffset)
  const columns = useMemo(
    () => ({ gridTemplateColumns: `${graphWidth}px minmax(260px,1fr) 128px 112px 84px` }),
    [graphWidth]
  )
  const start = Math.max(0, firstRow - overscanRows)
  // Prepare at most one block until the initial layout measures the viewport.
  const visibleRows = viewportHeight === null
    ? blockSize
    : Math.ceil(viewportHeight / rowHeight) + overscanRows + 1
  const viewportEnd = firstRow + visibleRows
  const stagedEnd = firstRow === 0 ? initialRowLimit : null
  const end = stagedEnd === null ? viewportEnd : Math.min(viewportEnd, stagedEnd)
  const loadedViewportEnd = Math.min(history.count, viewportEnd)
  useLayoutEffect(() => {
    if (initialRowLimit === null || loadedViewportEnd === 0) return

    const addRows = () => {
      const limit = initialRowLimit + initialRowsPerFrame
      startTransition(() => setInitialRowLimit(limit < loadedViewportEnd ? limit : null))
    }
    // The first batch is already in the DOM. Let the browser paint it before
    // spending another frame on the remaining visible and overscan rows.
    let frame = requestAnimationFrame(() => {
      if (initialRowLimit === firstPaintRows) frame = requestAnimationFrame(addRows)
      else addRows()
    })
    return () => cancelAnimationFrame(frame)
  }, [initialRowLimit, loadedViewportEnd])
  const renderedBlocks = visibleBlocks(history.blocks, start, end)
  const visibleHovered =
    hovered &&
    renderedBlocks.some((block) => block.rows.some(({ commit }) => commit.hash === hovered))
      ? hovered
      : null
  const selectCommit = useCallback((commit: GitGraphCommit) => {
    setSelected(commit.hash)
    startTransition(() => {
      setDetail((previous) => (previous?.hash === commit.hash ? null : commit))
    })
  }, [])

  const load = useCallback(
    async (mode: GraphLoadMode = "replace") => {
      const previous = current.current
      const more = mode !== "replace"
      if (more && (!previous.hasMore || (mode === "prefetch" && skipPrefetch.current === previous)))
        return
      if (more && pending.current) {
        if (mode === "more" && pending.current === "prefetch") {
          pending.current = "more"
          setLoading(true)
        }
        return
      }
      const id = ++request.current
      pending.current = mode
      setLoading(mode !== "prefetch")
      setError(null)
      try {
        let page = await window.api.git.getCommitGraph(
          cwd,
          more ? previous.count : 0,
          more ? previous.snapshot : undefined,
          true
        )
        if (id !== request.current) return
        let reset = Boolean(page.reset)
        if (more && !reset && !page.commits.length) {
          page = await window.api.git.getCommitGraph(cwd, 0, undefined, true)
          if (id !== request.current) return
          reset = true
        }
        const replace = !more || reset
        const next = await appendCommits(replace ? emptyHistory : previous, page, () => id === request.current)
        if (id !== request.current) return
        skipPrefetch.current = reset ? next : null
        current.current = next
        setHistory(next)
        if (replace) {
          if (scroller.current?.contains(document.activeElement)) {
            const focusTarget = next.count ? scroller.current : refreshRef.current
            focusTarget?.focus({ preventScroll: true })
          }
          scrollTop.current = 0
          scroller.current?.scrollTo(0, 0)
          setViewport({ row: 0, offset: 0 })
          setFirstLane(0)
          setSelected(page.commits[0]?.hash ?? null)
          setDetail(null)
          setHovered(null)
        }
        setHistoryChanged(reset)
      } catch (err) {
        if (id === request.current) {
          const failedMode = pending.current
          if (failedMode === "prefetch") skipPrefetch.current = previous
          else if (failedMode) {
            const message = err instanceof Error
              ? err.message.replace(/^Error invoking remote method 'git:getCommitGraph': (?:Error: )?/, "")
              : ""
            setError({ message: message || "读取 Git 图谱失败", mode: failedMode })
          }
        }
      } finally {
        if (id === request.current) {
          pending.current = null
          setLoading(false)
        }
      }
    },
    [cwd]
  )

  useEffect(() => {
    if (!presented) return
    void load()
    return () => {
      request.current++
      if (pending.current) void window.api.git.cancelCommitGraph().catch(() => undefined)
      pending.current = null
    }
  }, [load, presented])

  useEffect(() => {
    if (!presented) return
    const unverified = unverifiedBranchChanges.current
    if (gitDir) {
      if (unverified.has(gitDir)) void load()
      unverified.clear()
    }
    const onBranchChanged = (event: Event) => {
      const detail = (event as CustomEvent<GitBranchSwitched>).detail
      if (!detail) return
      const sameWorktree =
        gitDir && detail.gitDir ? gitDir === detail.gitDir : detail.repositoryPath === cwd
      if (sameWorktree) void load()
      // A child repository can open the graph before its initial probe completes.
      else if (!gitDir && detail.gitDir) unverified.add(detail.gitDir)
    }
    window.addEventListener(GIT_BRANCH_REFRESH_EVENT, onBranchChanged)
    return () => window.removeEventListener(GIT_BRANCH_REFRESH_EVENT, onBranchChanged)
  }, [cwd, gitDir, load, presented])

  const readAhead = useCallback(() => {
    if (
      !viewportHeight || !scroller.current || document.hidden || error ||
      history !== current.current || !history.hasMore
    ) return
    const logicalY = mapScrollPosition(
      scrollTop.current - tableHeaderHeight,
      canvasHeight,
      historyHeight
    )
    const remaining = historyHeight - logicalY - viewportHeight
    if (remaining <= 3 * rowHeight) void load("more")
    else if (remaining <= prefetchRows * rowHeight) void load("prefetch")
  }, [history, canvasHeight, historyHeight, viewportHeight, error, load])

  useEffect(() => {
    readAhead()
    document.addEventListener("visibilitychange", readAhead)
    return () => document.removeEventListener("visibilitychange", readAhead)
  }, [readAhead])

  return createPortal(
    <div
      ref={overlayRef}
      popover="auto"
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.newState === "open") setPresented(true)
        else {
          restoreFocusOnClose.current = true
          onClose()
        }
      }}
      className="fixed inset-0 m-0 h-full w-full max-w-none place-items-center overflow-hidden border-0 bg-transparent p-0 text-foreground [&:popover-open]:grid [-webkit-app-region:no-drag]"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/35"
        onClick={() => overlayRef.current?.hidePopover()}
      />
      <FocusScope
        asChild
        trapped
        loop
        onMountAutoFocus={(event) => {
          event.preventDefault()
          const overlay = overlayRef.current
          if (!overlay) return
          if (refreshRef.current) refreshRef.current.autofocus = true
          // Native autofocus needs layout. Let React finish mounting the dialog first.
          openTimer.current = window.setTimeout(() => {
            overlay.showPopover()
            showBackground.current ??= hideOthers(overlay)
          }, 0)
        }}
        onUnmountAutoFocus={(event) => {
          event.preventDefault()
          if (restoreFocusOnClose.current) onCloseAutoFocus?.()
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          data-cmb-modal-dialog="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className="relative flex h-[min(78vh,720px)] w-[min(96vw,64rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-lg [contain:strict] will-change-transform"
        >
          <header className="flex h-10 shrink-0 items-center gap-2 border-b bg-muted/25 px-3 pr-12">
            <GitGraph className="size-4" />
            <h2 id={titleId} className="flex-1 text-sm font-medium">Git 图谱</h2>
            <p id={descriptionId} className="sr-only">查看当前仓库的 Git 图谱。{cwd}</p>
            {maxFirstLane > 0 && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>图谱泳道</span>
                <input
                  type="range"
                  min={0}
                  max={maxFirstLane}
                  value={firstLane}
                  className="w-24 accent-foreground"
                  onChange={(event) => setFirstLane(event.currentTarget.valueAsNumber)}
                />
              </label>
            )}
            <Button
              ref={refreshRef}
              aria-label="刷新 Git 图谱"
              variant="ghost"
              size="icon-sm"
              aria-disabled={loading}
              className={unavailableButtonClass}
              onClick={() => {
                if (!loading) void load()
              }}
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
          </header>
          {error && (
            <p role="alert" className="shrink-0 break-all p-3 text-sm text-destructive">
              {error.message}
              {history.hasMore && (
                <Button variant="ghost" size="sm" onClick={() => void load(error.mode)}>
                  重试加载
                </Button>
              )}
            </p>
          )}
          {historyChanged && (
            <p role="status" className="shrink-0 px-3 py-2 text-sm text-muted-foreground">
              仓库历史已更新，已回到最新提交。
            </p>
          )}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scroller}
              role="region"
              aria-label="提交历史"
              aria-hidden={!hasHistory || undefined}
              tabIndex={hasHistory ? 0 : -1}
              className={cn("min-h-0 flex-1 [contain:strict]", hasHistory ? "overflow-auto" : "overflow-hidden")}
              aria-busy={loading}
              onScroll={(event) => {
                scrollTop.current = event.currentTarget.scrollTop
                const next = viewportPosition(scrollTop.current)
                readAhead()
                if (next.row !== firstRow || next.offset !== rowOffset) {
                  // Commit the exposed rows before the browser paints a scroll past our overscan.
                  const update = () => {
                    setInitialRowLimit(null)
                    setViewport(next)
                  }
                  if (Math.abs(next.row - firstRow) > overscanRows) flushSync(update)
                  else update()
                }
              }}
            >
              <div style={{ minWidth: Math.max(760, graphWidth + 584) }}>
                <div
                  className="grid h-10 border-b bg-muted/30 text-sm font-medium text-muted-foreground"
                  style={columns}
                >
                  {["图", "描述", "日期", "作者", "提交"].map((label) => (
                    <div key={label} className="flex items-center border-r px-3 last:border-r-0">
                      {label}
                    </div>
                  ))}
                </div>
                <div className="relative overflow-clip" style={{ height: canvasHeight }}>
                  {renderedBlocks.map((block) => {
                    const rowEnd = Math.min(block.rows.length, end - block.start)
                    // As rows arrive, clip the full lane paths to their matching rows.
                    const drawingRows = stagedEnd === null ? block.rows.length : rowEnd
                    return (
                      <div
                        key={block.start}
                        className="absolute inset-x-0"
                        style={{
                          top: block.start * rowHeight - rowOffset,
                          height: drawingRows * rowHeight,
                          contain: "layout"
                        }}
                      >
                        <GraphBlockDrawing
                          block={block}
                          rowCount={drawingRows}
                          width={graphWidth}
                          laneOffset={laneOffset}
                          hovered={visibleHovered}
                          selected={selected}
                        />
                        <GraphBlockRows
                          block={block}
                          start={Math.max(0, start - block.start)}
                          end={rowEnd}
                          columns={columns}
                          selected={selected}
                          expanded={detail?.hash}
                          onHover={setHovered}
                          onSelect={selectCommit}
                        />
                      </div>
                    )
                  })}
                </div>
                {hasHistory && loading && (
                  <div role="status" className="p-2 text-center text-xs text-muted-foreground">
                    正在加载更多提交…
                  </div>
                )}
              </div>
            </div>
            {!hasHistory && (
              <div
                role="status"
                className="absolute inset-x-0 bottom-0 top-10 grid place-content-center justify-items-center gap-3 text-sm text-muted-foreground"
              >
                {loading ? (
                  <Loader2 aria-label="正在读取提交" className="size-5 animate-spin" />
                ) : (
                  <>
                    <GitGraph className="size-8" />
                    {error ? "可刷新图谱重试" : "暂无提交"}
                  </>
                )}
              </div>
            )}
          </div>
          {detail && <CommitDetails key={detail.hash} commit={detail} />}
          <button
            type="button"
            aria-label="关闭 Git 图谱"
            className="absolute right-3 top-3 rounded-sm opacity-70 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => overlayRef.current?.hidePopover()}
          >
            <X className="size-4" />
          </button>
        </div>
      </FocusScope>
    </div>,
    document.body
  )
}
