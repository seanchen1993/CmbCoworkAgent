import { useId } from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export function ManagedRunStartTimeField({
  scheduled,
  onScheduledChange,
  scheduledAt,
  onTimeChange,
  disabled
}: {
  scheduled: boolean
  onScheduledChange?: (scheduled: boolean) => void
  scheduledAt: string
  onTimeChange: (value: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const fieldId = useId()
  return (
    <div className="mt-2 grid gap-2">
      <div id={fieldId} className="flex items-center gap-1.5 text-sm font-medium">
        开始时间
      </div>
      <div className="grid gap-2 rounded-lg border border-border/70 bg-background/70 px-3 py-2.5">
        {onScheduledChange && (
          <div
            role="radiogroup"
            aria-labelledby={fieldId}
            className="flex items-center gap-4 text-sm"
          >
            {[
              { scheduled: false, label: "立即开始" },
              { scheduled: true, label: "预约开始" }
            ].map((option) => (
              <label
                key={option.label}
                className={cn(
                  "flex items-center gap-1.5 whitespace-nowrap",
                  disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
                )}
              >
                <input
                  type="radio"
                  name={fieldId}
                  checked={scheduled === option.scheduled}
                  onChange={() => onScheduledChange(option.scheduled)}
                  disabled={disabled}
                  className="size-3.5 shrink-0 appearance-none rounded-full border border-muted-foreground/60 bg-background checked:border-primary checked:bg-primary checked:shadow-[inset_0_0_0_3px_var(--background)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                />
                {option.label}
              </label>
            ))}
          </div>
        )}
        {scheduled && (
          <>
            <Input
              type="datetime-local"
              aria-label="托管启动时间"
              value={scheduledAt.replace(" ", "T").slice(0, 16)}
              onChange={(event) =>
                onTimeChange(event.target.value ? `${event.target.value.replace("T", " ")}:00` : "")
              }
              disabled={disabled}
            />
            <p className="text-xs text-muted-foreground">
              应用和电脑处于唤醒状态，到达预约时间后会开始托管运行。
            </p>
          </>
        )}
      </div>
    </div>
  )
}
