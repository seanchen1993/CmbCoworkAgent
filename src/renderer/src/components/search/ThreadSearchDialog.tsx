import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { Search } from "lucide-react"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
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

function openForCurrentView() {
  openThreadSearch(useAppStore.getState().mainView === "harness")
}

export function ThreadSearchButton() {
  if (!threadSearchEnabled) return null
  return (
    <button
      type="button"
      className="flex h-8 w-full items-center gap-2 rounded px-2 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
      onClick={openForCurrentView}
    >
      <Search className="size-4 shrink-0" aria-hidden="true" />
      搜索会话
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
          className="sm:max-w-xl"
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
            if (!closedByNavigation.current && !useThreadSearch.getState().open) entry.current?.focus()
          }}
        >
          <DialogTitle>搜索会话</DialogTitle>
          <DialogDescription>搜索已保存内容，最新生成内容保存后可刷新。</DialogDescription>
          <div className="flex gap-2">
            <input
              ref={input}
              role="combobox"
              aria-expanded={true}
              aria-controls={resultsId}
              aria-activedescendant={selectedResult ? `${resultsId}-${encodeURIComponent(selectedResult.threadId)}` : undefined}
              aria-autocomplete="list"
              aria-label="搜索会话"
              placeholder="输入关键词"
              value={query}
              maxLength={THREAD_SEARCH_QUERY_LIMIT}
              className="min-w-0 flex-1 rounded border bg-background px-3 py-2 text-sm"
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
            <select
              aria-label="搜索范围"
              className="rounded border bg-background px-2 text-sm"
              value={availableScope}
              onChange={(event) => {
                if (opening) cancelThreadSearchNavigation()
                useThreadSearch.setState({ failure: "" })
                setScopeSelection({ version: openingVersion, value: event.target.value })
                setSelected(null)
              }}
            >
              <option value="ordinary">普通会话</option>
              <option value="project" disabled={!projectId}>当前项目</option>
              <option value="projects">全部项目</option>
              <option value="all">全部会话</option>
              <option value="workspace" disabled={!currentWorkspace}>
                当前工作区
              </option>
              <option value="none">无工作区</option>
            </select>
          </div>
          {query.trim() && (
            <div className="flex justify-between gap-2 text-xs text-muted-foreground">
              <span role="status">
                {failure ||
                  (restarting && executingKey === searchKey ? "搜索已过期，正在重新搜索…" : "") ||
                  (executingKey === searchKey && (error || reasons)) ||
                  (pending || executingKey !== searchKey
                    ? "正在搜索已保存内容…"
                    : visibleResults.length
                      ? `已找到 ${visibleResults.length} 个会话`
                      : "未找到匹配的已保存内容")}
              </span>
              <button
                type="button"
                className="shrink-0 underline"
                onClick={() => {
                  if (opening) cancelThreadSearchNavigation()
                  useThreadSearch.setState({ failure: "" })
                  setRetry((value) => value + 1)
                }}
              >
                刷新
              </button>
            </div>
          )}
          <div ref={list} id={resultsId} role="listbox" aria-label="会话搜索结果"
            className="max-h-[55vh] overflow-auto">
            {visibleResults.map((result) => {
              const range = result.snippetRanges[0]
              const workspaceLabel = result.route && result.route.kind !== "ordinary"
                ? [result.projectLabel ?? result.route.projectId,
                    result.route.kind === "featureSession" ? result.featureLabel ?? result.route.slug : null
                  ].filter(Boolean).join(" / ")
                : result.remoteInbox ? REMOTE_INBOX_WORKSPACE_NAME : result.workspacePath
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
                  className={`block w-full rounded px-3 py-2 text-left text-sm hover:bg-muted ${result === selectedResult ? "bg-muted" : ""}`}
                >
                  <span className="block truncate font-medium">{result.title}</span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <span className="min-w-0 truncate" title={workspaceLabel ?? undefined}>
                      {workspaceLabel ?? "无工作区"}
                    </span>
                    <span className="shrink-0 whitespace-nowrap">
                      · {new Date(result.frozenUpdatedAt).toLocaleString()} ·{" "}
                      <span>{result.matchedBy === "title" ? "标题" : "正文"}</span>
                      {result.navigation === "threadOnly" ? " · 打开会话" : ""}
                    </span>
                  </span>
                  <span className="line-clamp-2 break-all">
                    {range ? (
                      <>
                        {result.snippet.slice(0, range.start)}
                        <mark className="rounded bg-amber-400/30 text-foreground">
                          {result.snippet.slice(range.start, range.end)}
                        </mark>
                        {result.snippet.slice(range.end)}
                      </>
                    ) : (
                      result.snippet
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
