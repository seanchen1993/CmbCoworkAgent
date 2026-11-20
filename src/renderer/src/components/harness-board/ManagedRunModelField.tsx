import { useId } from "react"
import { Info } from "lucide-react"
import type { ManagedRunModelSelection } from "../../../../shared/managed-run-model"
import { IDLE_MODEL_NAME } from "../../../../shared/model-catalog"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { ManagedRunRadioOption } from "./ManagedRunRadioOption"

export function ManagedRunModelField({
  value,
  onChange,
  disabled
}: {
  value: ManagedRunModelSelection
  onChange: (value: ManagedRunModelSelection) => void
  disabled?: boolean
}): React.JSX.Element {
  const groupId = useId()
  return (
    <div className="grid gap-2 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-x-4">
      <div id={groupId} className="flex h-9 items-center gap-1.5 text-sm font-medium">
        模型
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="查看托管模型说明"
                className="rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="z-[70] max-w-72 text-xs leading-5">
              托管可沿用默认模型，也可固定使用{IDLE_MODEL_NAME}。
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div role="radiogroup" aria-labelledby={groupId} className="min-w-0 flex flex-wrap gap-x-5">
        {(
          [
            { value: "default", label: "默认模型" },
            { value: "ultra", label: IDLE_MODEL_NAME }
          ] as const
        ).map((option) => (
          <ManagedRunRadioOption
            key={option.value}
            name={groupId}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            disabled={disabled}
          >
            {option.label}
          </ManagedRunRadioOption>
        ))}
      </div>
    </div>
  )
}
