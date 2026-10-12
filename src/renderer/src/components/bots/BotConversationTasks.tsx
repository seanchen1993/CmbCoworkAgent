import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, GitBranch, ListTodo, Square, Workflow } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { StreamingMarkdown } from "@/components/chat/StreamingMarkdown"
import { botPersonaState } from "@/lib/bot-persona-state"
import {
  botConversationTaskAddress,
  botConversationTaskLabels,
  botConversationTaskPage,
  botConversationTaskScopeKey,
  canCancelBotConversationTask,
  selectBotConversationTasks,
  type BotConversationTaskScope,
  type BotConversationTaskSummary
} from "@/lib/bot-conversation-tasks"
import type { BotRun, CoworkBot } from "../../../../shared/bot-types"
import type { BotRunAddress } from "../../../../shared/bot-run-history"
import type { BotWorkCounts } from "../../../../shared/bot-work-pages"
import type { BotRendererWorkPage } from "@/lib/bot-work-page-cache"
import type { BotCachedRunOutput } from "@/lib/bot-run-output-cache"
import { BotAvatar } from "./BotAvatar"
import { BotDialogContent } from "./BotDialog"

export interface BotConversationTasksProps {
  workCounts?: BotWorkCounts
  serverPage?: BotRendererWorkPage<BotRun>
  onPageOpen?(open: boolean): void
  onPageMove?(direction: "next" | "previous" | "first"): void
  onPageRetry?(): void
  scope: BotConversationTaskScope
  runs: readonly BotRun[]
  outputs?: Readonly<Record<string, BotCachedRunOutput>>
  expandedOutputId?: string | null
  onExpandedOutput?(id: string | null): void
  onLoadOutput?(): void
  bots: readonly Pick<CoworkBot, "id" | "name">[]
  conversationKind: "direct" | "group"
  canViewHistory: boolean
  onHistory(address: BotRunAddress): void
  onReview(run: BotRun): void
  /** Reject on failure; the current scope owns pending state and retry feedback. */
  onCancel(runId: string): Promise<unknown>
}

/** Reuse the workspace snapshot and existing action authorities; no second task cache or poller. */
export function BotConversationTasks(props: BotConversationTasksProps) {
  const { runs, scope } = props
  const { conversationId, threadRootId, dataEpoch } = scope
  const summary = useMemo(
    () =>
      selectBotConversationTasks(runs, {
        conversationId,
        threadRootId,
        dataEpoch
      }),
    [runs, conversationId, threadRootId, dataEpoch]
  )
  const projected = props.workCounts
    ? {
        ...summary,
        total: props.workCounts.total,
        attention: props.workCounts.waitingInput + props.workCounts.needsReview,
        running: props.workCounts.running,
        queued: props.workCounts.queued,
        cancelling: props.workCounts.cancelling
      }
    : summary
  return (
    <ConversationTasksScope
      key={botConversationTaskScopeKey(scope)}
      {...props}
      summary={projected}
    />
  )
}

function ConversationTasksScope({
  scope,
  summary,
  bots,
  conversationKind,
  canViewHistory,
  onHistory,
  onReview,
  onCancel,
  outputs,
  expandedOutputId,
  onExpandedOutput,
  onLoadOutput,
  serverPage,
  onPageOpen,
  onPageMove,
  onPageRetry
}: BotConversationTasksProps & { summary: BotConversationTaskSummary }) {
  const [open, setOpen] = useState(false)
  const [requestedPage, setRequestedPage] = useState(0)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [failure, setFailure] = useState<{
    runId: string
    message: string
  } | null>(null)
  const active = useRef(false)
  const pending = useRef<string | null>(null)
  const names = useMemo(() => new Map(bots.map((bot) => [bot.id, bot.name])), [bots])
  const localPage = botConversationTaskPage(summary.items, requestedPage)
  const page = serverPage
    ? {
        page: serverPage.pageIndex,
        pageCount: Math.max(1, Math.ceil(summary.total / 20)),
        total: summary.total,
        items: serverPage.items
      }
    : localPage
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  useEffect(() => {
    if (requestedPage !== page.page) setRequestedPage(page.page)
  }, [requestedPage, page.page])
  useEffect(() => {
    if (!summary.total) setOpen(false)
  }, [summary.total])

  useEffect(() => {
    onPageOpen?.(open)
    return () => onPageOpen?.(false)
  }, [open, onPageOpen])
  const currentRun = (id: string) => [...summary.items, ...page.items].find((run) => run.id === id)
  const history = (id: string) => {
    const run = currentRun(id)
    const address = run && botConversationTaskAddress(run, scope)
    if (!canViewHistory || !address) return
    setOpen(false)
    onExpandedOutput?.(null)
    onHistory(address)
  }
  const review = (id: string) => {
    const run = currentRun(id)
    if (!run || run.status !== "needs_review" || !botConversationTaskAddress(run, scope)) return
    setOpen(false)
    onExpandedOutput?.(null)
    onReview(run)
  }
  const cancel = async (id: string) => {
    const run = currentRun(id)
    if (!run || !canCancelBotConversationTask(run) || pending.current) return
    pending.current = id
    setPendingId(id)
    setFailure(null)
    try {
      await onCancel(id)
    } catch (error) {
      if (active.current)
        setFailure({
          runId: id,
          message: error instanceof Error ? error.message : "停止任务失败"
        })
    } finally {
      if (active.current) {
        pending.current = null
        setPendingId(null)
      }
    }
  }
  const detail = (run: BotRun) =>
    run.waitingForComputer
      ? "等待你归还浏览器控制权"
      : run.waitingForBot
        ? `等待 ${names.get(run.waitingForBot) ?? "协作 Bot"} 的结果`
        : run.status === "running" && run.activity
          ? run.activity.description
          : botConversationTaskLabels[run.status]
  const stopLabel = (run: BotRun) =>
    run.workflowTask ? "停止子任务" : conversationKind === "group" ? "停止本轮讨论" : "停止此任务"
  const actions = (run: BotRun) => (
    <div className="flex shrink-0 items-center gap-1">
      {canViewHistory && (
        <Button size="sm" variant="ghost" onClick={() => history(run.id)}>
          任务记录
        </Button>
      )}
      {run.status === "needs_review" && (
        <Button size="sm" variant="outline" onClick={() => review(run.id)}>
          核对并恢复
        </Button>
      )}
      {canCancelBotConversationTask(run) && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pendingId !== null}
          onClick={() => void cancel(run.id)}
        >
          <Square size={12} />
          {pendingId === run.id ? "正在停止…" : stopLabel(run)}
        </Button>
      )}
    </div>
  )
  const failureMessage = (run: BotRun) =>
    failure?.runId === run.id ? (
      <p role="alert" className="mt-1 text-xs leading-5 text-destructive">
        {failure.message}
      </p>
    ) : null
  const output = (run: BotRun) => outputs?.[run.id]?.text ?? run.output ?? ""
  const label = (run: BotRun) => run.workflowTask?.label ?? names.get(run.botId) ?? "Bot"
  const counts = [
    summary.attention ? `${summary.attention} 个待处理` : "",
    summary.running ? `${summary.running} 个工作中` : "",
    summary.queued ? `${summary.queued} 个排队中` : "",
    summary.cancelling ? `${summary.cancelling} 个正在停止` : ""
  ]
    .filter(Boolean)
    .join(" · ")

  if (!summary.total) return null
  return (
    <section
      className="space-y-2"
      aria-label="当前会话任务"
      data-conversation-task-scope={botConversationTaskScopeKey(scope)}
    >
      {summary.total > summary.inline.length && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-2 rounded-xl border border-border/60 bg-muted/25 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`查看全部 ${summary.total} 个任务`}
        >
          <ListTodo size={15} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{counts}</span>
          <span className="shrink-0 text-xs font-medium">全部任务 · {summary.total}</span>
          <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
        </button>
      )}
      {summary.inline.map((run) => (
        <section
          key={run.id}
          data-inline-task-id={run.id}
          className={run.workflowTask ? "ml-6 border-l border-border/60 pl-4" : undefined}
        >
          <div className="bot-work-state" role="status">
            <BotAvatar agentId={run.botId} size="md" state={botPersonaState(run)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate" title={`${label(run)} · ${detail(run)}`}>
                {label(run)} · {detail(run)}
              </span>
              {run.error && (
                <span className="mt-1 block text-xs text-muted-foreground">{run.error}</span>
              )}
              {failureMessage(run)}
            </span>
            {actions(run)}
          </div>
          {output(run) && (
            <div className="bot-stream-output" data-stream-run={run.id}>
              <StreamingMarkdown isStreaming={run.status === "running"}>
                {output(run)}
              </StreamingMarkdown>
            </div>
          )}
          <OutputReadState entry={outputs?.[run.id]} onLoad={onLoadOutput} />
        </section>
      ))}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) onExpandedOutput?.(null)
        }}
      >
        <BotDialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ListTodo size={18} />
              {scope.threadRootId ? "分支任务" : "当前会话任务"}
            </DialogTitle>
            <DialogDescription>
              {counts}。任务随执行进展更新，审批和核对沿用原有处理流程。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>共 {summary.total} 个任务</span>
            <span>
              第 {page.page + 1}
              {serverPage ? "" : ` / ${page.pageCount}`} 页
            </span>
          </div>
          {serverPage?.loading && (
            <p role="status" className="text-xs text-muted-foreground">
              正在读取任务…
            </p>
          )}
          {serverPage?.error && (
            <div role="alert" className="text-xs text-destructive">
              {serverPage.error}
              <Button size="sm" variant="ghost" onClick={onPageRetry}>
                重试
              </Button>
            </div>
          )}
          <div className="min-h-0 overflow-y-auto">
            <ul className="space-y-2" aria-label="当前会话任务列表">
              {page.items.map((run) => (
                <li
                  key={run.id}
                  data-conversation-task-id={run.id}
                  className="rounded-xl border border-border/70 bg-background/40 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {run.workflowTask ? (
                      <GitBranch size={16} className="shrink-0 text-muted-foreground" />
                    ) : (
                      <Workflow size={16} className="shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium" title={label(run)}>
                        {label(run)}
                      </span>
                      <span
                        className="mt-0.5 block truncate text-xs text-muted-foreground"
                        title={detail(run)}
                      >
                        {detail(run)}
                      </span>
                    </span>
                    {actions(run)}
                  </div>
                  {failureMessage(run)}
                  {run.error && (
                    <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                      {run.error}
                    </p>
                  )}
                  {(run.hasOutput ?? !!run.output) && (
                    <TaskOutput
                      output={output(run)}
                      entry={outputs?.[run.id]}
                      expanded={onExpandedOutput ? expandedOutputId === run.id : undefined}
                      onExpanded={
                        onExpandedOutput
                          ? (next) => {
                              if (next) onExpandedOutput(run.id)
                              else if (expandedOutputId === run.id) onExpandedOutput(null)
                            }
                          : undefined
                      }
                      onLoad={onLoadOutput}
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex items-center justify-between border-t border-border/60 pt-3">
            <Button
              size="sm"
              variant="ghost"
              disabled={
                serverPage ? !serverPage.canPrevious || serverPage.loading : page.page === 0
              }
              onClick={() =>
                serverPage ? onPageMove?.("previous") : setRequestedPage(page.page - 1)
              }
            >
              <ChevronLeft size={14} />
              上一页
            </Button>
            {serverPage && page.page > 0 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={serverPage.loading}
                onClick={() => onPageMove?.("first")}
              >
                回到第一页
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={
                serverPage
                  ? !serverPage.canNext || serverPage.loading
                  : page.page + 1 === page.pageCount
              }
              onClick={() => (serverPage ? onPageMove?.("next") : setRequestedPage(page.page + 1))}
            >
              下一页
              <ChevronRight size={14} />
            </Button>
          </div>
        </BotDialogContent>
      </Dialog>
    </section>
  )
}

function OutputReadState({ entry, onLoad }: { entry?: BotCachedRunOutput; onLoad?: () => void }) {
  if (!entry?.hasMore && !entry?.error) return null
  return (
    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
      <span role={entry.error ? "alert" : "status"}>{entry.error ?? "正在读取后续输出…"}</span>
      {onLoad && (
        <Button size="sm" variant="ghost" onClick={onLoad}>
          {entry.error ? "重试" : "加载后续输出"}
        </Button>
      )}
    </div>
  )
}

function TaskOutput({
  output,
  entry,
  expanded: controlled,
  onExpanded,
  onLoad
}: {
  output: string
  entry?: BotCachedRunOutput
  expanded?: boolean
  onExpanded?(value: boolean): void
  onLoad?(): void
}) {
  const [localExpanded, setExpanded] = useState(false)
  const expanded = controlled ?? localExpanded
  return (
    <details
      open={expanded}
      className="mt-2 text-xs text-muted-foreground"
      onToggle={(event) => {
        const next = event.currentTarget.open
        if (next === expanded) return
        if (onExpanded) onExpanded(next)
        else setExpanded(next)
      }}
    >
      <summary className="cursor-pointer rounded-md py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        查看实时输出
      </summary>
      {expanded && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-sans leading-5">
          {output}
        </pre>
      )}
      {expanded && <OutputReadState entry={entry} onLoad={onLoad} />}
    </details>
  )
}
