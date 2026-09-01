import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  Loader2,
  MessageSquare,
  RefreshCw
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { MANAGED_RUN_STATUS_LABELS } from "../../../../shared/harness-board-types"
import type {
  ManagedRunDecisionFacts,
  ManagedRunEvent,
  ManagedRunEventCursor,
  ManagedRunEventsPage,
  ManagedRunSummary
} from "../../../../shared/harness-board-types"

const EVENT_LABELS: Record<string, string> = {
  run_started: "启动托管运行",
  feature_inspected: "检查当前状态",
  decision_made: "托管运行决策",
  session_created: "创建会话",
  session_started: "启动会话",
  session_completed: "会话结束",
  provider_retry_scheduled: "等待模型服务重试",
  provider_retry_sent: "发起模型服务重试",
  provider_retry_reset: "模型服务已恢复",
  biz_retry_reuse_thread: "继续当前任务",
  biz_retry_new_thread: "重新执行当前阶段",
  human_gate_requested: "需要人工确认",
  human_gate_approved: "用户同意推进",
  human_gate_rejected: "用户拒绝推进",
  human_gate_conflict: "同特性确认冲突，自动拒绝",
  run_cancelled: "已停止托管",
  run_failed: "托管失败",
  run_completed: "托管完成"
}

const HIDDEN_EVENT_TYPES = new Set<ManagedRunEvent["type"]>([
  "feature_inspected",
  "provider_retry_scheduled",
  "session_started"
])

const DECISION_LABELS: Record<string, string> = {
  advance: "创建新会话执行后续任务",
  biz_retry_reuse_thread: "复用当前会话继续任务",
  biz_retry_new_thread: "创建新会话重试当前阶段任务",
  provider_retry: "复用当前会话重试模型服务",
  fail: "结束托管运行",
  complete: "完成托管运行"
}

const DECISION_TIPS: Record<string, string> = {
  advance: "推进到下一个阶段",
  biz_retry_reuse_thread: "当前阶段尚未结束，复用当前会话继续执行",
  biz_retry_new_thread: "当前阶段尚未结束，创建新会话重新执行",
  provider_retry: "模型服务调用失败，在原会话中重试",
  fail: "当前条件无法继续自动执行，结束托管运行",
  complete: "特性已完成，结束托管运行"
}

const STATUS_TEXT: Record<string, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  done: "已完成",
  blocked: "受阻",
  warning: "警告",
  error: "错误",
  skipped: "已跳过",
  archived: "已归档",
  unknown: "未知"
}

const CHANGED_FIELD_TEXT: Record<string, string> = {
  currentNode: "当前阶段",
  featureStatus: "特性状态",
  currentNodeStatus: "阶段状态",
  nextAction: "执行指令"
}

function statusTone(status: ManagedRunSummary["status"]): string {
  if (status === "completed") return "text-status-nominal"
  if (status === "corrupt" || status === "failed") return "text-status-critical"
  if (status === "cancelled") return "text-status-warning"
  return "text-status-info"
}

function eventSummary(event: ManagedRunEvent): string {
  if (event.summary) return event.summary
  return EVENT_LABELS[event.type] || event.type
}

function DecisionBadge({
  decision,
  facts,
  rule,
  stageLabels
}: {
  decision?: string
  facts?: ManagedRunDecisionFacts
  rule?: string
  stageLabels?: Map<string, string>
}): React.JSX.Element | null {
  if (!decision) return null
  const label = DECISION_LABELS[decision]
  if (!label) return null
  const fallbackRule = DECISION_TIPS[decision]
  const changedFields =
    facts?.changedFields.map((field) => CHANGED_FIELD_TEXT[field] || field) ?? []
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="cursor-help rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-96 p-3">
        <div className="text-xs font-semibold">判断事实</div>
        {facts ? (
          <div className="mt-1.5 space-y-1 text-xs leading-5 opacity-90">
            {facts.previousNodeId && facts.previousNodeId !== facts.currentNodeId && (
              <div>
                上一个阶段：{stageLabels?.get(facts.previousNodeId) || facts.previousNodeId}
              </div>
            )}
            <div>当前阶段：{stageLabels?.get(facts.currentNodeId) || facts.currentNodeId}</div>
            <div>特性状态：{STATUS_TEXT[facts.featureStatus] || facts.featureStatus}</div>
            <div>阶段状态：{STATUS_TEXT[facts.currentNodeStatus] || facts.currentNodeStatus}</div>
            {facts.slashSkill && <div>执行技能：/{facts.slashSkill.replace(/^\/+/, "")}</div>}
            {facts.initialInspection ? (
              <div>执行基线：当前托管运行尚未建立上一次检查基线</div>
            ) : changedFields.length > 0 ? (
              <div>与上次相比：{changedFields.join("、")}发生变化</div>
            ) : (
              <div>与上次相比：当前阶段、特性状态、阶段状态和执行指令均未变化</div>
            )}
            {facts.terminalOutcome && (
              <div>会话结果：{facts.terminalOutcome === "success" ? "成功" : "失败"}</div>
            )}
            {facts.terminalReason && <div>会话说明：{facts.terminalReason}</div>}
            {decision === "biz_retry_reuse_thread" || decision === "biz_retry_new_thread" ? (
              <div>本次当前任务重试：{Math.min(facts.bizRetryCount + 1, 3)}/3</div>
            ) : (
              facts.bizRetryCount > 0 && <div>当前任务已重试：{facts.bizRetryCount}/3</div>
            )}
            {decision === "provider_retry" ? (
              <div>本次模型服务重试：{Math.min(facts.providerRetryCount + 1, 3)}/3</div>
            ) : (
              facts.providerRetryCount > 0 && (
                <div>模型服务已重试：{facts.providerRetryCount}/3</div>
              )
            )}
            {(decision === "biz_retry_reuse_thread" || decision === "biz_retry_new_thread") &&
              facts.contextUsageRatio !== undefined && (
                <div>上下文占用：{Math.round(facts.contextUsageRatio * 1000) / 10}%</div>
              )}
            {(decision === "biz_retry_reuse_thread" || decision === "biz_retry_new_thread") &&
              facts.contextUsageRatio === undefined && (
                <div>上下文占用：无法计算，回退到执行基线判断</div>
              )}
            {(decision === "biz_retry_reuse_thread" || decision === "biz_retry_new_thread") &&
              facts.contextReuseThreshold !== undefined && (
                <div>上下文复用阈值：{facts.contextReuseThreshold * 100}%</div>
              )}
            {(decision === "biz_retry_reuse_thread" || decision === "biz_retry_new_thread") &&
              facts.contextReusable !== undefined && (
                <div>上下文判断：{facts.contextReusable ? "允许复用" : "不复用当前会话"}</div>
              )}
            {(decision === "biz_retry_reuse_thread" || decision === "biz_retry_new_thread") && (
              <div>
                重试方式：{decision === "biz_retry_reuse_thread" ? "复用当前会话" : "创建新会话"}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-1.5 text-xs opacity-90">暂无结构化判断事实</div>
        )}
        <div className="mt-3 border-t border-border/50 pt-2 text-xs font-semibold">判断规则</div>
        <div className="mt-1 text-xs leading-5 opacity-90">{rule || fallbackRule}</div>
      </TooltipContent>
    </Tooltip>
  )
}

export function ManagedRunPanel({
  run,
  currentSessionTitle,
  currentSessionActive,
  onSelectThread
}: {
  run?: ManagedRunSummary
  currentSessionTitle?: string | null
  currentSessionActive?: boolean
  onSelectThread?: (threadId: string) => void
}): React.JSX.Element {
  if (!run) {
    return (
      <section className="rounded-xl border border-dashed border-border/80 bg-background/70 px-3 py-5 text-sm text-muted-foreground">
        尚未开始托管
      </section>
    )
  }

  const sessionLabel = currentSessionActive
    ? "活跃会话"
    : run.nextRetryAt
      ? "待重试会话"
      : "最近会话"

  return (
    <section className="rounded-xl border border-border/80 bg-background-elevated/80 p-3 shadow-xs">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        托管模式信息
      </div>
      <div className={cn("mt-1 text-sm font-semibold", statusTone(run.status))}>
        {run.status === "running" && run.nextRetryAt
          ? "托管等待模型服务重试中"
          : MANAGED_RUN_STATUS_LABELS[run.status]}
      </div>

      <div className="mt-3 rounded-lg border border-border/70 bg-background/70 px-2.5 py-2 text-[11px] text-muted-foreground">
        <span>{sessionLabel}</span>
        {run.currentSession?.threadId ? (
          <button
            type="button"
            className="mt-0.5 block max-w-full truncate text-left font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onSelectThread?.(run.currentSession?.threadId || "")}
            title={currentSessionTitle || run.currentSession.threadId}
          >
            {currentSessionTitle || "查看会话"}
          </button>
        ) : (
          <strong className="mt-0.5 block text-foreground">暂无活跃会话</strong>
        )}
      </div>

      {run.status === "running" && run.nextRetryAt && (
        <div className="mt-2 rounded-lg border border-status-info/25 bg-status-info/5 px-2.5 py-2 text-[11px] text-status-info">
          托管模型服务重试中 {run.providerRetryCount}/3 · {run.nextRetryAt}
        </div>
      )}
      {run.status === "running" && run.bizRetryCount > 0 && (
        <div className="mt-2 rounded-lg border border-status-warning/25 bg-status-warning/5 px-2.5 py-2 text-[11px] text-status-warning">
          托管当前任务重试中 {run.bizRetryCount}/3
        </div>
      )}
      {run.status === "corrupt" && (
        <div className="mt-2 rounded-lg border border-status-warning/25 bg-status-warning/5 px-2.5 py-2 text-[11px] text-status-warning">
          损坏记录已隔离；重新开始将创建新的托管 Run，不会读取该记录的状态。
        </div>
      )}
      {(run.cancellationReason || run.failureReason) && (
        <div className="mt-2 line-clamp-3 rounded-lg border border-status-warning/25 bg-status-warning/5 px-2.5 py-2 text-[11px] text-status-warning">
          {run.cancellationReason || run.failureReason}
        </div>
      )}
    </section>
  )
}

interface ManagedRunTimelineProps {
  run?: ManagedRunSummary
  projectId: string
  featureId: string
  stages: Array<{ id: string; label: string }>
  selectedNodeId?: string | null
  sessionTitles?: Map<string, string>
  onSelectNode?: (nodeId: string) => void
  onSelectThread?: (threadId: string) => void
}

function EventRow({
  event,
  stageLabels,
  sessionTitles,
  onSelectThread
}: {
  event: ManagedRunEvent
  stageLabels?: Map<string, string>
  sessionTitles?: Map<string, string>
  onSelectThread?: (threadId: string) => void
}): React.JSX.Element {
  const threadIds = [event.threadId, event.sourceThreadId, event.targetThreadId].filter(
    (threadId, index, values): threadId is string =>
      Boolean(threadId) && values.indexOf(threadId) === index
  )
  const threadTitle = (threadId: string): string =>
    sessionTitles?.get(threadId) || "关联会话"
  const threadRole = (threadId: string): string =>
    event.sourceThreadId === threadId
      ? "来源"
      : event.targetThreadId === threadId
        ? "目标"
        : "关联"
  return (
    <div className="grid gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2.5 text-[11px] md:grid-cols-[132px_minmax(0,1fr)]">
      <div className="font-mono leading-5 text-muted-foreground">{event.createTime}</div>
      <div
        className={cn(
          "relative min-w-0",
          threadIds.length > 1 ? "pr-20" : threadIds.length === 1 ? "pr-8" : undefined
        )}
      >
        <div className="flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 leading-5">
          <span className="font-semibold text-foreground">
            {EVENT_LABELS[event.type] || event.type}
          </span>
          {event.type === "decision_made" && (
            <DecisionBadge
              decision={event.decision}
              facts={event.decisionFacts}
              rule={event.decisionRule}
              stageLabels={stageLabels}
            />
          )}
        </div>
        {event.type !== "decision_made" &&
          event.type !== "human_gate_approved" &&
          event.type !== "session_completed" && (
          <div className="mt-1 leading-5 text-muted-foreground">{eventSummary(event)}</div>
        )}
        {threadIds.length === 1 && (
          <div className="absolute -top-0.5 right-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onSelectThread?.(threadIds[0])}
                  aria-label={`查看关联会话：${threadTitle(threadIds[0])}`}
                >
                  <MessageSquare className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-80">
                查看关联会话：{threadTitle(threadIds[0])}
              </TooltipContent>
            </Tooltip>
          </div>
        )}
        {threadIds.length > 1 && (
          <div className="absolute -top-0.5 right-0">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`查看 ${threadIds.length} 个关联会话`}
                >
                  <MessageSquare className="size-3.5" />
                  会话 {threadIds.length}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-2">
                <div className="px-2 pb-1.5 text-xs font-semibold">关联会话</div>
                <div className="space-y-1">
                  {threadIds.map((threadId) => (
                    <button
                      key={threadId}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onSelectThread?.(threadId)}
                      title={threadTitle(threadId)}
                    >
                      <span className="min-w-0 flex-1 truncate">{threadTitle(threadId)}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {threadRole(threadId)}
                      </span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        )}
      </div>
    </div>
  )
}

export function ManagedRunTimeline({
  run,
  projectId,
  featureId,
  stages,
  selectedNodeId,
  sessionTitles,
  onSelectNode,
  onSelectThread
}: ManagedRunTimelineProps): React.JSX.Element | null {
  const [events, setEvents] = useState<ManagedRunEvent[]>([])
  const [nextCursor, setNextCursor] = useState<ManagedRunEventCursor | undefined>()
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(Boolean(run))
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  const [collapsedCurrentGroups, setCollapsedCurrentGroups] = useState<Set<string>>(() => new Set())
  const groupRefs = useRef(new Map<string, HTMLDivElement>())

  const loadEvents = useCallback(
    async (cursor?: ManagedRunEventCursor, append = false): Promise<void> => {
      if (!run) return
      if (append) setLoadingMore(true)
      else setLoading(true)
      setLoadError(null)
      try {
        const page: ManagedRunEventsPage = await window.api.harnessBoard.getManagedRunEvents({
          projectId,
          featureId,
          runId: run.runId,
          cursor,
          limit: 200
        })
        setEvents((current) => (append ? [...page.events, ...current] : page.events))
        setNextCursor(page.nextCursor)
        setHasMore(page.hasMore)
      } catch (error) {
        setHasMore(false)
        setLoadError(error instanceof Error ? error.message : String(error))
      } finally {
        if (append) setLoadingMore(false)
        else setLoading(false)
      }
    },
    [featureId, projectId, run]
  )

  useEffect(() => {
    if (run) void loadEvents()
  }, [loadEvents, run])

  useEffect(() => {
    if (!selectedNodeId) return
    groupRefs.current.get(selectedNodeId)?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }, [selectedNodeId])

  const stageLabels = useMemo(
    () => new Map(stages.map((stage) => [stage.id, stage.label])),
    [stages]
  )
  const visibleEvents = useMemo(
    () => [...events].reverse().filter((event) => !HIDDEN_EVENT_TYPES.has(event.type)),
    [events]
  )
  const globalEvents = visibleEvents.filter((event) => event.scope === "global")
  const stageGroups = useMemo(() => {
    const eventsByNodeId = new Map<string, ManagedRunEvent[]>()
    for (const event of visibleEvents) {
      if (event.scope !== "stage" || !event.nodeId) continue
      const group = eventsByNodeId.get(event.nodeId) ?? []
      group.push(event)
      eventsByNodeId.set(event.nodeId, group)
    }
    const workflowGroups = stages
      .map((stage) => ({
        nodeId: stage.id,
        events: eventsByNodeId.get(stage.id) ?? []
      }))
      .filter((group) => group.events.length > 0)
    const workflowNodeIds = new Set(stages.map((stage) => stage.id))
    const unknownGroups = Array.from(eventsByNodeId, ([nodeId, groupEvents]) => ({
      nodeId,
      events: groupEvents
    })).filter((group) => !workflowNodeIds.has(group.nodeId))
    return [...workflowGroups, ...unknownGroups]
  }, [stages, visibleEvents])

  if (!run) return null

  const toggleGroup = (groupId: string, expanded: boolean, selected: boolean): void => {
    setExpandedGroups((current) => {
      const next = new Set(current)
      if (expanded) next.delete(groupId)
      else next.add(groupId)
      return next
    })
    setCollapsedCurrentGroups((current) => {
      const next = new Set(current)
      if (expanded && selected) next.add(groupId)
      else next.delete(groupId)
      return next
    })
  }

  const renderGroup = (
    groupId: string,
    label: string,
    groupEvents: ManagedRunEvent[],
    global = false
  ): React.JSX.Element => {
    const selected = !global && selectedNodeId === groupId
    const expanded =
      expandedGroups.has(groupId) || (selected && !collapsedCurrentGroups.has(groupId))
    return (
      <div
        key={groupId}
        ref={(element) => {
          if (element) groupRefs.current.set(groupId, element)
          else groupRefs.current.delete(groupId)
        }}
        className={cn(
          "overflow-hidden rounded-xl border bg-background/70 transition-colors",
          selected ? "border-primary/45 ring-1 ring-primary/15" : "border-border/70"
        )}
      >
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => {
            if (!global) onSelectNode?.(groupId)
            toggleGroup(groupId, expanded, selected)
          }}
          aria-expanded={expanded}
        >
          <span className="flex min-w-0 items-center gap-2">
            {expanded ? (
              <ChevronDown className="size-4 shrink-0" />
            ) : (
              <ChevronRight className="size-4 shrink-0" />
            )}
            <CircleDot
              className={cn(
                "size-3.5 shrink-0",
                selected ? "text-primary" : "text-muted-foreground"
              )}
            />
            <span className="truncate text-sm font-semibold">{label}</span>
          </span>
          <span className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-[10px] text-muted-foreground">
            {groupEvents.length} 个事件
          </span>
        </button>
        {expanded && (
          <div className="space-y-2 border-t border-border/60 p-2.5">
            {groupEvents.length > 0 ? (
              groupEvents.map((event) => (
                <EventRow
                  key={event.eventId}
                  event={event}
                  stageLabels={stageLabels}
                  sessionTitles={sessionTitles}
                  onSelectThread={onSelectThread}
                />
              ))
            ) : (
              <div className="px-2 py-4 text-xs text-muted-foreground">当前分组暂无托管事件。</div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <TooltipProvider>
      <section className="rounded-xl border border-border/80 bg-background-elevated/80 p-3 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Managed Run
            </div>
            <div className="mt-1 text-sm font-semibold">托管执行记录</div>
            <div className="mt-1 font-mono text-[10px] text-muted-foreground">
              {run.startedAt || "-"} — {run.updatedAt || "-"}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            onClick={() => void loadEvents()}
            disabled={loading}
            title="刷新托管执行记录"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
        </div>

        {run.lastDecision && (
          <div className="mt-3 rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-[11px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-foreground">最近操作</span>
              <DecisionBadge
                decision={run.lastDecision.decision}
                facts={run.lastDecision.facts}
                rule={run.lastDecision.rule}
                stageLabels={stageLabels}
              />
              <span className="text-[10px] text-muted-foreground">
                {run.lastDecision.createTime}
              </span>
            </div>
          </div>
        )}

        {loading && events.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
            <Loader2 className="mr-2 size-3.5 animate-spin" />
            读取托管事件
          </div>
        ) : loadError ? (
          <div className="mt-3 rounded-lg border border-status-critical/25 bg-status-critical/5 px-3 py-4 text-xs text-status-critical">
            托管时间线读取失败：{loadError}
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {renderGroup("global", "全局生命周期", globalEvents, true)}
            {stageGroups.map((group) =>
              renderGroup(group.nodeId, stageLabels.get(group.nodeId) || group.nodeId, group.events)
            )}
            {stageGroups.length === 0 && globalEvents.length === 0 && (
              <div className="rounded-lg border border-dashed border-border/70 px-3 py-6 text-center text-xs text-muted-foreground">
                当前 ManagedRun 暂无时间线事件。
              </div>
            )}
            {hasMore && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full text-xs"
                onClick={() => nextCursor !== undefined && void loadEvents(nextCursor, true)}
                disabled={loadingMore || nextCursor === undefined}
              >
                {loadingMore && <Loader2 className="mr-2 size-3.5 animate-spin" />}
                加载更早事件
              </Button>
            )}
          </div>
        )}
      </section>
    </TooltipProvider>
  )
}
