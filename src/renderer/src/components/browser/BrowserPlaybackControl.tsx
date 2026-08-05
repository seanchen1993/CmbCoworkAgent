import { Loader2, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { BrowserScriptExecutionState } from "../../../../shared/browser-types"

interface BrowserPlaybackControlProps {
  playbackState: BrowserScriptExecutionState
  fallbackStatusText: string
  fallbackDotClassName: string
  preferFallbackStatusWhenPlaybackInactive?: boolean
  isCancellingPlayback: boolean
  onCancelPlayback: () => void
}

function getPlaybackStatusText(state: BrowserScriptExecutionState): string {
  switch (state.status) {
    case "running":
      return "正在回放中"
    case "completed":
      return "回放完成"
    case "error":
      return "回放异常"
    case "cancelled":
      return "回放已终止"
    default:
      return "回放就绪"
  }
}

function getPlaybackStatusDotClassName(status: BrowserScriptExecutionState["status"]): string {
  switch (status) {
    case "running":
      return "bg-status-info animate-tactical-pulse"
    case "completed":
      return "bg-status-nominal"
    case "error":
    case "cancelled":
      return "bg-status-warning"
    default:
      return "bg-primary"
  }
}

export function getPlaybackStatusDetail(state: BrowserScriptExecutionState): string {
  if (typeof state.progressPercent === "number" && Number.isFinite(state.progressPercent)) {
    const percent = Math.max(0, Math.min(100, Math.round(state.progressPercent)))
    return `${percent}%`
  }
  return state.label || state.fileName || "当前脚本"
}

export function shouldShowPlaybackSummary(
  state: BrowserScriptExecutionState,
  preferFallbackStatusWhenPlaybackInactive = false
): boolean {
  if (state.status === "idle") return false
  if (state.status === "running") return true
  return !preferFallbackStatusWhenPlaybackInactive
}

export function BrowserPlaybackControl({
  playbackState,
  fallbackStatusText,
  fallbackDotClassName,
  preferFallbackStatusWhenPlaybackInactive = false,
  isCancellingPlayback,
  onCancelPlayback
}: BrowserPlaybackControlProps): React.JSX.Element {
  const playbackHasOutput = shouldShowPlaybackSummary(
    playbackState,
    preferFallbackStatusWhenPlaybackInactive
  )
  const playbackStatusActive = playbackState.status === "running"
  const statusDotClassName = playbackHasOutput
    ? getPlaybackStatusDotClassName(playbackState.status)
    : fallbackDotClassName
  const statusLine = playbackHasOutput
    ? `${getPlaybackStatusText(playbackState)} · ${getPlaybackStatusDetail(playbackState)}`
    : fallbackStatusText

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <span className={cn("size-2 shrink-0 rounded-full", statusDotClassName)} />
          <span className="truncate text-[11px] text-foreground">{statusLine}</span>
        </div>
      </div>

      {playbackStatusActive ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 rounded-md px-2.5 text-[11px] text-muted-foreground hover:text-foreground"
          disabled={isCancellingPlayback}
          onClick={onCancelPlayback}
        >
          {isCancellingPlayback ? (
            <Loader2 className="size-3 animate-spin" strokeWidth={1.8} />
          ) : (
            <Square className="size-3 text-red-500" strokeWidth={1.8} />
          )}
          {isCancellingPlayback ? "终止中..." : "终止回放"}
        </Button>
      ) : null}
    </>
  )
}
