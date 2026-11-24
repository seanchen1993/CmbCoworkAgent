import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import {
  ChevronDown,
  CornerDownLeft,
  FolderClosed,
  ListFilter,
  MessageSquare,
  RotateCw,
  Search,
  SearchX
} from "lucide-react"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { hasOpenModalDialog } from "@/lib/modal-dialog"
import { adoptThreadSearchSummary, isThreadDeletionPending, useAppStore } from "@/lib/store"
import { useThreadStateSelector } from "@/lib/thread-context"
import { REMOTE_INBOX_WORKSPACE_NAME } from "../../../../shared/remote-inbox-workspace"
import {
  bindThreadSearchTicket,
  cancelThreadSearchNavigation,
  finishThreadSearchNavigation,
  isCurrentThreadSearchNavigation,
  openThreadSearch,
  reserveThreadSearchNavigation,
  useThreadSearch,
  withOwnedThreadSearchTransition
} from "@/lib/thread-search-navigation"
import {
  THREAD_SEARCH_QUERY_LIMIT,
  type ThreadSearchPage,
  type ThreadSearchScope,
  type ThreadSearchResult
} from "../../../../shared/thread-search-types"

const threadSearchEnabled =
  import.meta.env.VITE_DISABLE_THREAD_SEARCH !== "1" &&
  (typeof window === "undefined" || window.api?.threads?.searchEnabled !== false)
const MAX_INLINE_TITLE_MATCH_LENGTH = 32

function openForCurrentView() {
  openThreadSearch(useAppStore.getState().mainView === "harness")
}

export function ThreadSearchButton({ className }: { className: string }) {
  if (!threadSearchEnabled) return null
  const isMac = globalThis.window?.electron?.process?.platform === "darwin"
  return (
    <button
      type="button"
      aria-label="搜索会话"
      aria-haspopup="dialog"
      aria-keyshortcuts={isMac ? "Meta+Shift+F" : "Control+Shift+F"}
      title={`搜索会话（${isMac ? "⌘⇧F" : "Ctrl+Shift+F"}）`}
      className={className}
      onClick={openForCurrentView}
    >
      <Search
        size={18}
        strokeWidth={1.6}
        className="shrink-0 transition-transform group-hover:scale-[1.04]"
        aria-hidden="true"
      />
    </button>
  )
}

function coverageLabel(page: ThreadSearchPage | null) {
  if (!page) return ""
  if (page.coverage.reasons.some((reason) => reason.startsWith("project-catalog") || reason === "project-route-unavailable"))
    return "项目搜索覆盖不完整，可在对应项目刷新后重试"
  if (page.scanStatus === "limited") return "已达到本次搜索范围上限，请缩小范围"
  if (page.coverage.reasons.includes("legacy-foreground-required"))
    return "部分旧历史需打开对应会话恢复，恢复后可刷新"
  if (page.coverage.reasons.includes("legacy-pending"))
    return "部分历史正在准备，当前结果可能不完整"
  if (page.coverage.reasons.includes("legacy-unverified")) return "部分历史的可见内容无法完全确认"
  if (page.coverage.reasons.includes("unavailable-source")) return "部分历史读取失败，可重试"
  if (
    page.coverage.reasons.includes("oversized-row") ||
    page.coverage.reasons.includes("projection-truncated")
  )
    return "部分超长内容未搜索完整"
  if (page.coverage.reasons.includes("changed-during-search"))
    return "部分会话在搜索期间发生变化，可重试"
  return ""
}

function compareResults(a: ThreadSearchResult, b: ThreadSearchResult) {
  return Number(b.matchedBy === "title") - Number(a.matchedBy === "title") || b.frozenUpdatedAt - a.frozenUpdatedAt || (a.threadId === b.threadId ? 0 : a.threadId < b.threadId ? 1 : -1)
}

export function ThreadSearchDialog({ activateChat }: { activateChat: () => void }) {
  const { open, openingVersion, failure, origin } = useThreadSearch()
  const currentThreadId = useAppStore((state) => state.currentThreadId)
  const thread = useAppStore((state) =>
    state.threads.find((item) => item.thread_id === state.currentThreadId)
  )
  const residentWorkspace = useThreadStateSelector(open ? currentThreadId : null,
    (state) => state.workspacePath ?? (state.historyLoading || state.historyRestorationPending ? undefined : null)
  )
  const workspace = residentWorkspace === undefined ? thread?.metadata?.workspacePath : residentWorkspace
  const currentWorkspace = typeof workspace === "string" && workspace.trim() ? workspace : null
  const [query, setQuery] = useState("")
  const [scopeSelection, setScopeSelection] = useState<{ version: number; value: string }>()
  const defaultScope = origin?.projectMode ? (origin.projectId ? "project" : "projects") : "ordinary"
  const scope = scopeSelection?.version === openingVersion ? scopeSelection.value : defaultScope
  const availableScope = scope === "workspace" && !currentWorkspace ? "ordinary" : scope
  const workspacePath =
    availableScope === "none" ? null : availableScope === "workspace" ? currentWorkspace : undefined
  const projectId = origin?.projectId
  const [retry, setRetry] = useState(0)
  const [results, setResults] = useState<ThreadSearchResult[]>([])
  const [pending, setPending] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [page, setPage] = useState<ThreadSearchPage | null>(null)
  const [error, setError] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [opening, setOpening] = useState<{ id: number; threadId: string } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const resultsId = useId()
  const list = useRef<HTMLDivElement>(null)
  const entry = useRef<HTMLElement | null>(null)
  const closedByNavigation = useRef(false)
  const reasons = coverageLabel(page)
  const searchKey = JSON.stringify([openingVersion, query, availableScope, workspacePath, projectId, retry])
  const [executingKey, setExecutingKey] = useState("")
  const visibleResults = executingKey === searchKey ? results : []
  const selectedResult =
    visibleResults.find((result) => result.threadId === selected) ?? visibleResults[0]
  const hasQuery = Boolean(query.trim())
  const isSearching = hasQuery && (pending || executingKey !== searchKey)
  const searchError = executingKey === searchKey ? error : ""
  const status =
    failure ||
    (restarting && executingKey === searchKey ? "搜索已过期，正在重新搜索…" : "") ||
    searchError ||
    (executingKey === searchKey && reasons) ||
    (isSearching
      ? "正在搜索已保存内容…"
      : visibleResults.length
        ? `已找到 ${visibleResults.length} 个会话`
        : "未找到匹配的已保存内容")
  const openingThreadId =
    opening && isCurrentThreadSearchNavigation(opening.id) ? opening.threadId : null

  useLayoutEffect(() => {
    if (!open || !input.current || document.activeElement === input.current) return
    closedByNavigation.current = false
    entry.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    input.current.focus()
  }, [open, openingVersion])

  useEffect(() => {
    if (!threadSearchEnabled) return
    const shortcut = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        !event.altKey &&
        !event.isComposing &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!useThreadSearch.getState().open && hasOpenModalDialog()) return
        openForCurrentView()
      }
    }
    window.addEventListener("keydown", shortcut, true)
    return () => window.removeEventListener("keydown", shortcut, true)
  }, [])

  useEffect(() => {
    if (!open || !query.trim()) return
    let active = true
    let session: string | undefined
    let expiredOnce = false
    const invalidatedSessions = new Set<string>()
    const unsubscribe = window.api.threads.onSearchProjectCatalogChanged?.((sessionId) => {
      if (!active) return
      invalidatedSessions.add(sessionId)
      if (session !== sessionId) return
      setResults((previous) => previous.filter((result) => result.route.kind === "ordinary"))
      setPage((previous) => previous?.sessionId === sessionId ? {
        ...previous,
        coverage: {
          ...previous.coverage,
          completeness: "partial",
          reasons: [...new Set([...previous.coverage.reasons, "project-catalog-changed" as const])]
        }
      } : previous)
    })
    const run = async (): Promise<void> => {
      useThreadSearch.setState({ failure: "" })
      setExecutingKey(searchKey)
      setResults([])
      setSelected(null)
      setPage(null)
      setError("")
      setPending(true)
      setRestarting(expiredOnce)
      try {
        const requestScope: ThreadSearchScope =
          availableScope === "project" && projectId ? { kind: "project", projectId } :
          availableScope === "projects" || availableScope === "all" ? { kind: availableScope } :
          { kind: "ordinary", workspacePath }
        let next = await window.api.threads.searchStart({ query, scope: requestScope })
        if (active) setRestarting(false)
        session = next.sessionId
        while (active) {
          if (next.coverage.reasons.includes("project-catalog-changed")) invalidatedSessions.add(next.sessionId)
          const invalidated = invalidatedSessions.has(next.sessionId)
          setPage(invalidated ? {
            ...next,
            coverage: {
              ...next.coverage,
              completeness: "partial",
              reasons: [...new Set([...next.coverage.reasons, "project-catalog-changed" as const])]
            }
          } : next)
          if (invalidated) setResults((previous) => previous.filter((result) => result.route.kind === "ordinary"))
          const additions = invalidated
            ? next.results.filter((result) => result.route.kind === "ordinary")
            : next.results
          if (additions.length) {
            const first = [...additions].sort(compareResults)[0]
            setSelected((previous) => previous ?? first.threadId)
            setResults((previous) => {
              const byId = new Map(previous.map((result) => [result.threadId, result]))
              for (const result of additions) byId.set(result.threadId, result)
              return [...byId.values()].sort(compareResults)
            })
          }
          if (!next.nextCursor) return
          if (!active) return
          next = await window.api.threads.searchContinue(next.nextCursor)
        }
      } catch (cause) {
        if (!active) return
        if (!expiredOnce && /SEARCH_CURSOR_EXPIRED|SEARCH_UNAVAILABLE/.test(String(cause))) {
          expiredOnce = true
          return await run()
        }
        setError(String(cause).includes("SEARCH_BUSY") ? "搜索正在忙，请重试" : "搜索失败，请重试")
      } finally {
        if (active) setPending(false)
        else if (session) void window.api.threads.searchCancel(session).catch(() => {})
      }
    }
    const timer = window.setTimeout(() => void run(), 200)
    return () => {
      active = false
      unsubscribe?.()
      window.clearTimeout(timer)
      if (session) void window.api.threads.searchCancel(session).catch(() => {})
    }
  }, [open, query, workspacePath, availableScope, projectId, searchKey])

  async function navigate(result: ThreadSearchResult) {
    if (openingThreadId === result.threadId || isThreadDeletionPending(result.threadId)) return
    const id = reserveThreadSearchNavigation(useAppStore.getState().currentThreadId, result.threadId)
    setOpening({ id, threadId: result.threadId })
    try {
      const summary = await window.api.threads.searchSummary(result)
      if (!summary?.navigationTicketId || !bindThreadSearchTicket(id, summary.navigationTicketId) || !summary.searchRoute) {
        finishThreadSearchNavigation(id, "会话已变化或被删除，请重新搜索")
        return
      }
      const { searchRoute: route, navigationTicketId, searchReadOnly, ...thread } = summary
      const project = route.kind === "ordinary" ? undefined : (await window.api.harnessBoard.catalogPage({
        projectId: route.projectId,
        projectLimit: 1,
        includeRegistry: false
      })).projects.find((item) => item.projectId === route.projectId)
      if (!isCurrentThreadSearchNavigation(id)) return
      if (route.kind !== "ordinary" && !project) {
        finishThreadSearchNavigation(id, "暂时无法打开所属项目，请刷新后重试")
        return
      }
      const confirmed = route.kind !== "ordinary" || await window.api.threads.searchConfirmRoute({
        ...result, target: result.target, navigationTicketId
      })
      if (!isCurrentThreadSearchNavigation(id)) return
      if (!confirmed || !adoptThreadSearchSummary(thread, result.incarnation)) {
        finishThreadSearchNavigation(id, "会话或项目已变化，请重新搜索")
        return
      }
      withOwnedThreadSearchTransition(id, () => {
        const store = useAppStore.getState()
        const sourceView = store.mainView
        const sourceThread = store.currentThreadId
        const restoreSourceView = sourceView === "harness" ? undefined : () => {
          const current = useAppStore.getState()
          if (current.mainView !== "harness") return
          current.setMainView(sourceView)
          if (sourceView === "thread" && sourceThread) void current.selectThread(sourceThread)
        }
        if (route.kind === "ordinary") void store.selectThread(result.threadId)
        else if (store.mainView !== "harness") store.setMainView("harness")
        if (!project) activateChat()
        closedByNavigation.current = true
        useThreadSearch.setState({
          ordinarySidebarAnchor: route.kind === "ordinary" ? { threadId: result.threadId } : null,
          navigation: {
            id, result, query, route, navigationTicketId, project, searchReadOnly,
            stage: project ? "board" : "chat",
            onProjectReady: project ? activateChat : undefined, restoreSourceView
          },
          open: false
        })
      })
      window.setTimeout(() => finishThreadSearchNavigation(id, "加载会话超时，请重新搜索"), 30_000)
    } catch {
      finishThreadSearchNavigation(id, "无法打开会话，请重试")
    } finally {
      setOpening((current) => (current?.id === id ? null : current))
    }
  }

  useEffect(() => {
    if (!selected) return
    const row = Array.from(
      list.current?.querySelectorAll<HTMLElement>("[data-search-thread]") ?? []
    ).find((node) => node.dataset.searchThread === selected)
    row?.scrollIntoView({ block: "nearest" })
  }, [selected])

  if (!threadSearchEnabled) return null
  return (
    <>
      {!open && failure && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-md border bg-background px-4 py-2 text-sm shadow"
        >
          {failure}{" "}
          <button className="ml-3 underline" onClick={openForCurrentView}>
            重新搜索
          </button>
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) openForCurrentView()
          else {
            closedByNavigation.current = false
            cancelThreadSearchNavigation()
            useThreadSearch.setState({ open: false })
          }
        }}
      >
        <DialogContent
          className="top-[10dvh] flex max-h-[min(32rem,80dvh)] w-[calc(100%-1.5rem)] max-w-[680px] translate-y-0 flex-col gap-0 rounded-xl p-0 shadow-2xl sm:rounded-xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            if (input.current && document.activeElement !== input.current) {
              closedByNavigation.current = false
              entry.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null
              input.current.focus()
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (!closedByNavigation.current && !useThreadSearch.getState().open)
              entry.current?.focus()
          }}
        >
          <div className="shrink-0 px-4 pb-3 pt-4 sm:px-5">
            <DialogTitle className="pr-8 text-sm leading-5">搜索会话</DialogTitle>
            <DialogDescription className="sr-only">
              搜索已保存内容，最新生成内容保存后可刷新。
            </DialogDescription>
          </div>
          <div className="mx-4 mb-3 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-input bg-muted/30 px-2 py-1 focus-within:border-ring sm:mx-5">
            <div className="flex min-w-[10rem] flex-1 items-center gap-2 pl-1">
              <Search className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <input
                ref={input}
                role="combobox"
                aria-expanded={true}
                aria-controls={resultsId}
                aria-activedescendant={
                  selectedResult
                    ? `${resultsId}-${encodeURIComponent(selectedResult.threadId)}`
                    : undefined
                }
                aria-autocomplete="list"
                aria-label="搜索会话"
                placeholder="搜索会话标题或内容"
                value={query}
                maxLength={THREAD_SEARCH_QUERY_LIMIT}
                className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-foreground/65"
                onChange={(event) => {
                  if (opening) cancelThreadSearchNavigation()
                  useThreadSearch.setState({ failure: "" })
                  setQuery(event.target.value)
                  setSelected(null)
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229 || !selectedResult)
                    return
                  const index = visibleResults.indexOf(selectedResult)
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault()
                    const next = Math.min(
                      visibleResults.length - 1,
                      Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1))
                    )
                    setSelected(visibleResults[next].threadId)
                  } else if (event.key === "Enter") {
                    event.preventDefault()
                    void navigate(selectedResult)
                  }
                }}
              />
            </div>
            <div className="relative flex shrink-0 items-center">
              <ListFilter
                className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              <select
                aria-label="搜索范围"
                className="h-8 appearance-none rounded-md border border-border bg-background pl-7 pr-7 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={availableScope}
                onChange={(event) => {
                  if (opening) cancelThreadSearchNavigation()
                  useThreadSearch.setState({ failure: "" })
                  setScopeSelection({ version: openingVersion, value: event.target.value })
                  setSelected(null)
                }}
              >
                <option value="ordinary">普通会话</option>
                <option value="project" disabled={!projectId}>
                  当前项目
                </option>
                <option value="projects">全部项目</option>
                <option value="all">全部会话</option>
                <option value="workspace" disabled={!currentWorkspace}>
                  当前工作区
                </option>
                <option value="none">无工作区</option>
              </select>
              <ChevronDown
                className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
            </div>
          </div>
          {hasQuery && (
            <div className="flex shrink-0 items-start justify-between gap-2 border-t border-border/60 px-4 py-2 text-xs text-foreground/75 sm:px-5">
              <span role="status" className="min-w-0 break-words py-1">
                {status}
              </span>
              <button
                type="button"
                className="-mr-1 inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  if (opening) cancelThreadSearchNavigation()
                  useThreadSearch.setState({ failure: "" })
                  setRetry((value) => value + 1)
                }}
              >
                <RotateCw className="size-3.5" aria-hidden="true" />
                刷新
              </button>
            </div>
          )}
          <div className="flex min-h-0 flex-col">
            {!visibleResults.length && !isSearching && !searchError && (
              <div className="grid h-36 place-items-center overflow-y-auto px-4 py-3 text-center">
                <div className="flex flex-col items-center gap-2">
                  <div className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
                    {hasQuery ? (
                      <SearchX className="size-5" aria-hidden="true" />
                    ) : (
                      <Search className="size-5" aria-hidden="true" />
                    )}
                  </div>
                  <p className="text-sm text-foreground/75">
                    {hasQuery ? "试试其他关键词，或切换搜索范围" : "输入关键词，查找已保存的会话"}
                  </p>
                </div>
              </div>
            )}
            <div
              ref={list}
              id={resultsId}
              role="listbox"
              aria-label="会话搜索结果"
              className="min-h-0 overflow-y-auto overscroll-contain px-2 empty:pb-0 sm:px-3"
            >
              {visibleResults.map((result) => {
                const range = result.snippetRanges[0]
                const titleMatch = result.matchedBy === "title"
                const highlightInTitle =
                  titleMatch &&
                  result.snippet === result.title &&
                  result.title.length <= MAX_INLINE_TITLE_MATCH_LENGTH
                const snippet = range ? (
                  <>
                    {result.snippet.slice(0, range.start)}
                    <mark className="rounded-sm bg-primary/15 font-medium text-foreground">
                      {result.snippet.slice(range.start, range.end)}
                    </mark>
                    {result.snippet.slice(range.end)}
                  </>
                ) : (
                  result.snippet
                )
                const projectRoute = result.route?.kind === "ordinary" ? undefined : result.route
                const workspaceLabel = projectRoute
                  ? [
                      result.projectLabel ?? projectRoute.projectId,
                      projectRoute.kind === "featureSession"
                        ? (result.featureLabel ?? projectRoute.slug)
                        : null
                    ]
                      .filter(Boolean)
                      .join(" / ")
                  : result.remoteInbox
                    ? REMOTE_INBOX_WORKSPACE_NAME
                    : result.workspacePath
                const workspaceName =
                  projectRoute || result.remoteInbox
                    ? workspaceLabel
                    : (workspaceLabel?.split(/[\\/]/).filter(Boolean).at(-1) ?? workspaceLabel)
                return (
                  <button
                    key={result.threadId}
                    id={`${resultsId}-${encodeURIComponent(result.threadId)}`}
                    data-search-thread={result.threadId}
                    role="option"
                    aria-selected={result === selectedResult}
                    disabled={openingThreadId === result.threadId}
                    type="button"
                    onClick={() => void navigate(result)}
                    className="group grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60 aria-selected:border-primary/20 aria-selected:bg-primary/10"
                  >
                    <span className="mt-0.5 grid size-8 place-items-center rounded-md bg-muted text-muted-foreground group-aria-selected:bg-primary/10 group-aria-selected:text-primary">
                      {projectRoute ? (
                        <FolderClosed className="size-4" aria-hidden="true" />
                      ) : (
                        <MessageSquare className="size-4" aria-hidden="true" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                        <span
                          className={`min-w-0 max-w-full font-medium ${highlightInTitle ? "break-words" : "truncate"}`}
                          title={result.title}
                        >
                          {highlightInTitle ? snippet : result.title}
                        </span>
                        <time className="text-xs tabular-nums text-foreground/70">
                          {new Date(result.frozenUpdatedAt).toLocaleString()}
                        </time>
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2 text-xs text-foreground/70">
                        <span
                          aria-hidden={workspaceName !== workspaceLabel || undefined}
                          className="min-w-0 truncate"
                          title={workspaceLabel ?? undefined}
                        >
                          {workspaceName ?? "无工作区"}
                        </span>
                        {workspaceName !== workspaceLabel && (
                          <span className="sr-only">{workspaceLabel}</span>
                        )}
                        <span>
                          {titleMatch ? "标题匹配" : "正文匹配"}
                          {!titleMatch && result.navigation === "threadOnly" ? " · 打开会话" : ""}
                        </span>
                      </span>
                      {!highlightInTitle && (
                        <span className="mt-1 line-clamp-2 break-words text-sm leading-snug text-foreground">
                          {snippet}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
          <div
            className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-muted/30 px-4 py-2 text-xs text-foreground/75 sm:px-5"
            aria-hidden="true"
          >
            <span className="flex items-center gap-1.5">
              <kbd className="rounded border border-border bg-background px-1 font-sans">↑ ↓</kbd>
              选择
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="grid h-5 min-w-5 place-items-center rounded border border-border bg-background px-1">
                <CornerDownLeft className="size-3" />
              </kbd>
              打开
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <kbd className="rounded border border-border bg-background px-1 font-sans">Esc</kbd>
              关闭
            </span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
