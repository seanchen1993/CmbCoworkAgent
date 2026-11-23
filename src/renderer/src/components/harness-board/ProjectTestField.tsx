import { useId } from "react"
import { Info } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

export function ProjectTestField({
  value,
  onChange
}: {
  value: boolean | undefined
  onChange: (value: boolean) => void
}): React.JSX.Element {
  const id = useId()

  return (
    <div
      role="radiogroup"
      aria-labelledby={`${id}-label`}
      aria-required="true"
      className="grid gap-1.5 text-xs font-medium text-muted-foreground"
    >
      <div className="flex items-center gap-1">
        <span id={`${id}-label`}>是否作为测试项目 *</span>
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="测试项目说明"
                className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="z-[70] max-w-72">
              测试项目将不被计入效能统计数据。
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex min-h-9 items-center gap-4 text-sm font-normal text-foreground">
        {[true, false].map((option) => (
          <label
            key={String(option)}
            className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap"
          >
            <input
              type="radio"
              name={id}
              value={String(option)}
              checked={value === option}
              onChange={() => onChange(option)}
              required
              className="size-3.5 shrink-0 appearance-none rounded-full border border-muted-foreground/60 bg-background checked:border-primary checked:bg-primary checked:shadow-[inset_0_0_0_3px_var(--background)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            />
            {option ? "是" : "否"}
          </label>
        ))}
      </div>
    </div>
  )
}
