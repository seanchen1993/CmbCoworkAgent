import type { Ref } from "react"
import { createPortal } from "react-dom"
import { Bot, CheckCircle2, CircleAlert, Loader2, Maximize2, Square, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ProjectAgentRunState } from "./use-project-agent-run"

export function ProjectAgentMinimized({
  mode,
  state,
  running,
  restoreButtonRef,
  onRestore,
  onStop,
  onDismiss
}: {
  mode: "analysis" | "report"
  state: ProjectAgentRunState
  running: boolean
  restoreButtonRef: Ref<HTMLButtonElement>
  onRestore: () => void
  onStop: () => void
  onDismiss: () => void
}) {
  const current = state.steps.findLast((step) => step.status === "running")
  const status = running
    ? current?.title || (mode === "report" ? "正在后台生成报告…" : "正在后台分析…")
    : !state.startedAt
      ? "已最小化，展开继续"
      : {
          running: "正在运行…",
          completed: mode === "report" ? "报告已生成，展开查看" : "分析已完成，展开查看",
          failed: "任务未完成，展开查看原因",
          cancelled: "任务已终止，展开继续"
        }[state.outcome]
  const StatusIcon = running
    ? Loader2
    : !state.startedAt
      ? Bot
      : state.outcome === "completed"
        ? CheckCircle2
        : CircleAlert

  return createPortal(
    <section
      aria-label="最小化的项目分析 Agent"
      className="fixed bottom-4 right-4 z-40 flex w-[min(360px,calc(100vw-2rem))] items-center gap-2 rounded-lg border border-border bg-card p-3 shadow-lg"
    >
      <StatusIcon
        aria-hidden="true"
        className={`size-4 shrink-0 text-primary ${running ? "animate-spin" : ""}`}
      />
      <button
        ref={restoreButtonRef}
        type="button"
        aria-label="展开项目分析 Agent"
        className="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onRestore}
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          项目分析 Agent <Maximize2 className="size-3 text-muted-foreground" />
        </span>
        <span
          role="status"
          className="mt-1 block truncate text-xs text-muted-foreground"
          title={status}
        >
          {status}
        </span>
      </button>
      {running ? (
        <Button type="button" size="sm" variant="outline" onClick={onStop}>
          <Square className="mr-1 size-3" />
          终止任务
        </Button>
      ) : (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          aria-label="收起任务入口"
          onClick={onDismiss}
        >
          <X className="size-3.5" />
        </Button>
      )}
    </section>,
    document.body
  )
}
