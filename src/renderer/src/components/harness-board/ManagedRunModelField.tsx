import { useId } from "react"
import { Info } from "lucide-react"
import type { ManagedRunModelSelection } from "../../../../shared/managed-run-model"
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
              默认模型：使用默认模型 内置 Ultra：使用夜间闲时算力
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="min-w-0">
        <div role="radiogroup" aria-labelledby={groupId} className="flex flex-wrap gap-x-5">
          {(
            [
              { value: "default", label: "默认模型" },
              { value: "ultra", label: "内置 Ultra" }
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
              {option.value === "ultra" && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  夜间
                </span>
              )}
            </ManagedRunRadioOption>
          ))}
        </div>
        {value === "ultra" && (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            22:00–次日 07:00 可用
          </p>
        )}
      </div>
    </div>
  )
}
