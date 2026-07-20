import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"
import { isHarnessProjectModeThread } from "@/lib/thread-classification"
import { useAllStreamLoadingStates, useAllThreadStates } from "@/lib/thread-context"
import { cn } from "@/lib/utils"

export function KanbanHeader({ className }: { className?: string }): React.JSX.Element {
  const { showSubagentsInKanban, setShowSubagentsInKanban, threads } = useAppStore()
  const loadingStates = useAllStreamLoadingStates()
  const allThreadStates = useAllThreadStates()

  const activeCount = threads.filter((t) => {
    if (isHarnessProjectModeThread(t)) return false
    const isLoading = loadingStates[t.thread_id] ?? false
    const hasPendingApproval = Boolean(allThreadStates[t.thread_id]?.pendingApproval)
    return isLoading || hasPendingApproval || t.status === "busy" || t.status === "interrupted"
  }).length

  return (
    <div
      className={cn(
        "flex items-center justify-between px-3 app-no-drag relative overflow-hidden",
        className
      )}
    >
      {/* Scan line effect */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.03]">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 2px, currentColor 2px, currentColor 3px)",
            backgroundSize: "100% 3px"
          }}
        />
      </div>

      {/* Left side - Status indicator */}
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <div
          className={cn(
            "size-1.5 rounded-full",
            activeCount > 0 ? "bg-status-nominal animate-tactical-pulse" : "bg-muted-foreground"
          )}
        />
        <span>{activeCount > 0 ? <><span className="font-mono tabular-nums">{activeCount}</span> 个活跃</> : "空闲"}</span>
      </div>

      {/* Right side - Controls */}
      <Button
        variant={showSubagentsInKanban ? "secondary" : "ghost"}
        size="sm"
        onClick={() => setShowSubagentsInKanban(!showSubagentsInKanban)}
        className="gap-2 h-7 relative"
      >
        <span className="text-sm leading-none">🦞</span>
        {showSubagentsInKanban ? "隐藏" : "显示"}子代理
      </Button>
    </div>
  )
}
