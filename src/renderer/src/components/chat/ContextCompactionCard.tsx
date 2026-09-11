import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react"

import type { ContextCompactionLifecycleEvent } from "../../../../shared/context-compaction-events"
import { cn } from "@/lib/utils"
import { ProcessingDuration } from "./ProcessingDuration"

interface ContextCompactionCardProps {
  compaction: ContextCompactionLifecycleEvent
}

export function ContextCompactionCard({
  compaction
}: ContextCompactionCardProps): React.JSX.Element {
  const isRunning = compaction.phase === "started"
  const isComplete = compaction.phase === "completed"
  const title = isRunning ? "正在压缩上下文" : isComplete ? "上下文压缩完成" : "上下文压缩未完成"
  const description = isRunning
    ? "正在整理较早的对话，完成后会自动继续。"
    : isComplete
      ? "已保留关键进展并释放上下文空间。"
      : "压缩过程遇到问题，本次请求可能需要重试。"

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={isRunning}
      data-context-compaction-phase={compaction.phase}
      className={cn(
        "relative overflow-hidden rounded-lg border px-3.5 py-3 shadow-sm",
        isRunning &&
          "border-violet-300/60 bg-violet-50/45 dark:border-violet-500/30 dark:bg-violet-500/10",
        isComplete &&
          "border-emerald-300/60 bg-emerald-50/45 dark:border-emerald-500/30 dark:bg-emerald-500/10",
        !isRunning &&
          !isComplete &&
          "border-amber-300/60 bg-amber-50/45 dark:border-amber-500/30 dark:bg-amber-500/10"
      )}
    >
      {isRunning && (
        <div className="absolute inset-x-0 top-0 h-px animate-pulse bg-gradient-to-r from-transparent via-violet-500/80 to-transparent" />
      )}
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md",
            isRunning && "bg-violet-500/10 text-violet-600 dark:text-violet-300",
            isComplete && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
            !isRunning && !isComplete && "bg-amber-500/10 text-amber-600 dark:text-amber-300"
          )}
        >
          {isRunning ? (
            <Loader2 className="size-4 animate-spin" />
          ) : isComplete ? (
            <CheckCircle2 className="size-4" />
          ) : (
            <CircleAlert className="size-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-foreground">{title}</span>
            {isRunning && (
              <span className="text-[11px] text-muted-foreground">
                <ProcessingDuration startTime={compaction.startedAt} text="已用时" />
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
      </div>
    </div>
  )
}
