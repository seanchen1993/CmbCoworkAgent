import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ManagedRunTimeline, type ManagedRunTimelineProps } from "./ManagedRunPanel"
import { MANAGED_RUN_STATUS_LABELS } from "../../../../shared/harness-board-types"
import type { ManagedRunSummary } from "../../../../shared/harness-board-types"

const STATUS_STYLES: Record<ManagedRunSummary["status"], string> = {
  running: "border-status-info/20 bg-status-info/10 text-status-info",
  completed: "border-status-nominal/20 bg-status-nominal/10 text-status-nominal",
  cancelled: "border-status-warning/20 bg-status-warning/10 text-status-warning",
  failed: "border-status-critical/20 bg-status-critical/10 text-status-critical",
  corrupt: "border-status-warning/20 bg-status-warning/10 text-status-warning"
}

export function ManagedRunHistory({
  run,
  projectId,
  featureId,
  ...timelineProps
}: Omit<ManagedRunTimelineProps, "embedded" | "refreshRevision">): React.JSX.Element | null {
  const [history, setHistory] = useState<ManagedRunSummary[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshRevision, setRefreshRevision] = useState(0)
  const requestVersion = useRef(0)
  const loadRuns = useCallback(async (): Promise<void> => {
    const version = ++requestVersion.current
    setLoading(true)
    setError(null)
    try {
      const runs = await window.api.harnessBoard.getManagedRuns(projectId, featureId)
      if (version === requestVersion.current) {
        setHistory(runs)
        setRefreshRevision((current) => current + 1)
      }
    } catch (error) {
      if (version === requestVersion.current) {
        setError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (version === requestVersion.current) setLoading(false)
    }
  }, [projectId, featureId])

  useEffect(() => {
    void loadRuns()
    return () => {
      requestVersion.current += 1
    }
  }, [loadRuns, run?.runId])

  const runs = useMemo(() => {
    const records = new Map(history.map((item) => [item.runId, item]))
    if (run) {
      const persisted = records.get(run.runId)
      if (!persisted || run.updatedAt >= persisted.updatedAt) records.set(run.runId, run)
    }
    return [...records.values()].sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt)
    )
  }, [history, run])

  if (!loading && !error && runs.length === 0) return null

  return (
    <section className="rounded-xl border border-border/80 bg-background-elevated/80 p-3 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Managed Run
          </div>
          <div className="mt-1 text-sm font-semibold">托管执行记录</div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7"
          onClick={() => void loadRuns()}
          disabled={loading}
          title="刷新托管运行记录及日志"
          aria-label="刷新托管运行记录及日志"
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </Button>
      </div>
      {error && (
        <div className="mt-3 text-xs text-status-critical">托管运行列表读取失败：{error}</div>
      )}
      {loading && runs.length === 0 && (
        <div className="py-8 text-center text-xs text-muted-foreground">读取托管运行记录</div>
      )}
      <div className="mt-3 space-y-2">
        {runs.map((item, index) => {
          const isExpanded = expanded[item.runId] ?? index === 0
          const secondaryTime =
            item.status === "running"
              ? item.updatedAt
              : item.status === "corrupt"
                ? undefined
                : item.completedAt || item.updatedAt
          return (
            <div
              key={item.runId}
              className="overflow-hidden rounded-xl border border-border/70 bg-background/70"
            >
              <button
                type="button"
                className="flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                aria-expanded={isExpanded}
                onClick={() =>
                  setExpanded((current) => ({ ...current, [item.runId]: !isExpanded }))
                }
              >
                {isExpanded ? (
                  <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="grid min-w-0 flex-1 grid-cols-[5em_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs leading-5">
                  <span className="text-muted-foreground">开始：</span>
                  <span className="font-medium tabular-nums">{item.startedAt || "未知"}</span>
                  <span className="text-muted-foreground">
                    {item.status === "running" ? "最近更新：" : "结束："}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {secondaryTime || "未知"}
                  </span>
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium leading-4",
                    STATUS_STYLES[item.status]
                  )}
                >
                  {MANAGED_RUN_STATUS_LABELS[item.status]}
                </span>
              </button>
              {isExpanded && (
                <div className="border-t border-border/60">
                  <ManagedRunTimeline
                    {...timelineProps}
                    embedded
                    refreshRevision={refreshRevision}
                    run={item}
                    projectId={projectId}
                    featureId={featureId}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
