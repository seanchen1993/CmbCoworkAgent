import { Layers } from "lucide-react"
import { IconPopoverButton } from "@/components/ui/icon-popover-button"
import { cn } from "@/lib/utils"

interface ChatVirtualizationStatusProps {
  isVirtualized: boolean
  messageCount: number
  threshold: number
}

export function ChatVirtualizationStatus({
  isVirtualized,
  messageCount,
  threshold
}: ChatVirtualizationStatusProps): React.JSX.Element {
  const label = isVirtualized ? "虚拟列表已启用" : "普通列表"

  return (
    <IconPopoverButton
      icon={<Layers className="size-3.5" />}
      popoverContent={
        <div className="space-y-0.5 leading-relaxed">
          <p className="font-medium text-foreground">{label}</p>
          <p className="text-muted-foreground">
            {isVirtualized
              ? `当前 ${messageCount} 条消息，仅渲染可视区域。`
              : `当前 ${messageCount} 条消息，达到 ${threshold} 条时自动启用虚拟列表。`}
          </p>
        </div>
      }
      className={cn(
        "size-5 shrink-0 rounded-sm p-0",
        isVirtualized ? "text-emerald-600 dark:text-emerald-300" : "text-muted-foreground/60"
      )}
      aria-label={label}
      popoverClassName="max-w-52"
    />
  )
}
