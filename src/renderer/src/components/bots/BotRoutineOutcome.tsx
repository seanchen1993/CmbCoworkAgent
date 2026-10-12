import { CalendarClock } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BotRoutineSaveOutcome } from "../../../../shared/bot-routine-outcome"

export function BotRoutineOutcome({
  outcome,
  disabled,
  open
}: {
  outcome: BotRoutineSaveOutcome
  disabled: boolean
  open(): void
}) {
  return (
    <div className="flex max-w-full flex-wrap items-center gap-2" data-bot-routine-outcome>
      <span className="shrink-0 text-xs text-muted-foreground" data-bot-routine-outcome-status>
        {outcome.operation === "create" ? "已创建例行任务" : "已更新例行任务"}
      </span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-7 max-w-full min-w-0 shrink gap-1.5 rounded-full px-2.5 text-left disabled:cursor-default"
        aria-label={`查看例程 ${outcome.name}`}
        title={disabled ? "当前无法打开此例程详情" : `查看例程 ${outcome.name}`}
        disabled={disabled}
        onClick={open}
        data-bot-routine-outcome-pill
      >
        <CalendarClock
          size={14}
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">{outcome.name}</span>
      </Button>
    </div>
  )
}
