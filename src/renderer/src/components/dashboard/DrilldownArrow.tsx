import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

/** 详情入口的视觉提示；由调用处按实际可点击状态渲染。 */
export function DrilldownArrow({ className }: { className?: string }): React.JSX.Element {
  return (
    <ChevronRight
      aria-hidden="true"
      className={cn(
        "inline-block size-3.5 shrink-0 align-middle text-muted-foreground [[disabled]_&]:hidden",
        className
      )}
    />
  )
}
