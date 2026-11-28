import type { ComponentProps } from "react"
import { SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  EFFICIENCY_FILTER_MENU,
  EFFICIENCY_FILTER_OPTION,
  EFFICIENCY_FILTER_TRIGGER
} from "./efficiency-filter-styles"

export function EfficiencySelectTrigger({
  className,
  ...props
}: ComponentProps<typeof SelectTrigger>): React.JSX.Element {
  return <SelectTrigger className={cn(EFFICIENCY_FILTER_TRIGGER, className)} {...props} />
}

export function EfficiencySelectContent({
  className,
  viewportClassName,
  ...props
}: ComponentProps<typeof SelectContent>): React.JSX.Element {
  return (
    <SelectContent
      align="start"
      className={cn(
        EFFICIENCY_FILTER_MENU,
        "w-[var(--radix-select-trigger-width)] min-w-0 max-w-[calc(100vw-2rem)]",
        className
      )}
      viewportClassName={cn("h-auto max-h-64 space-y-0.5 p-1", viewportClassName)}
      {...props}
    />
  )
}

export function EfficiencySelectItem({
  className,
  ...props
}: ComponentProps<typeof SelectItem>): React.JSX.Element {
  return (
    <SelectItem
      className={cn(EFFICIENCY_FILTER_OPTION, "pr-8 [&>span>svg]:size-3.5", className)}
      {...props}
    />
  )
}
