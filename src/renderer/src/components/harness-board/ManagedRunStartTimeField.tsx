import { useId } from "react"
import { Input } from "@/components/ui/input"
import { ManagedRunRadioOption } from "./ManagedRunRadioOption"

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
    <div className="grid gap-2 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-x-4">
      <div id={fieldId} className="flex h-9 items-center text-sm font-medium">
        开始时间
      </div>
      <div className="grid min-w-0 gap-2">
        {onScheduledChange && (
          <div role="radiogroup" aria-labelledby={fieldId} className="flex flex-wrap gap-x-5">
            {[
              { scheduled: false, label: "立即开始" },
              { scheduled: true, label: "预约开始" }
            ].map((option) => (
              <ManagedRunRadioOption
                key={option.label}
                name={fieldId}
                checked={scheduled === option.scheduled}
                onChange={() => onScheduledChange(option.scheduled)}
                disabled={disabled}
              >
                {option.label}
              </ManagedRunRadioOption>
            ))}
          </div>
        )}
        {scheduled && (
          <>
            <Input
              type="datetime-local"
              aria-label="托管启动时间"
              aria-describedby={`${fieldId}-notice`}
              value={scheduledAt.replace(" ", "T").slice(0, 16)}
              onChange={(event) =>
                onTimeChange(event.target.value ? `${event.target.value.replace("T", " ")}:00` : "")
              }
              disabled={disabled}
            />
            <p id={`${fieldId}-notice`} className="text-xs leading-5 text-muted-foreground">
              应用和电脑处于唤醒状态，到达预约时间后会开始托管运行。
            </p>
          </>
        )}
      </div>
    </div>
  )
}
