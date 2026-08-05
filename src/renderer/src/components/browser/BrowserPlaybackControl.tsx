import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, ArrowLeft, Check, Copy, Loader2, Square, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { BrowserScriptExecutionState } from "../../../../shared/browser-types"

interface BrowserPlaybackControlProps {
  playbackState: BrowserScriptExecutionState
  fallbackStatusText: string
  fallbackDotClassName: string
  playbackModeActive?: boolean
  playbackLabelOverride?: string | null
  preferFallbackStatusWhenPlaybackInactive?: boolean
  isCancellingPlayback: boolean
  onCancelPlayback: () => void
  onExitPlaybackMode?: () => void
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

// eslint-disable-next-line react-refresh/only-export-components
export function getPlaybackStatusDetail(state: BrowserScriptExecutionState): string {
  if (typeof state.progressPercent === "number" && Number.isFinite(state.progressPercent)) {
    const percent = Math.max(0, Math.min(100, Math.round(state.progressPercent)))
    return `${percent}%`
  }
  return state.label || state.fileName || "当前脚本"
}

// eslint-disable-next-line react-refresh/only-export-components
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
  playbackModeActive = false,
  playbackLabelOverride,
  preferFallbackStatusWhenPlaybackInactive = false,
  isCancellingPlayback,
  onCancelPlayback,
  onExitPlaybackMode
}: BrowserPlaybackControlProps): React.JSX.Element {
  const [dismissedErrorKey, setDismissedErrorKey] = useState<string | null>(null)
  const [copiedErrorKey, setCopiedErrorKey] = useState<string | null>(null)
  const playbackHasOutput = playbackModeActive
    ? true
    : shouldShowPlaybackSummary(playbackState, preferFallbackStatusWhenPlaybackInactive)
  const playbackStatusActive = playbackState.status === "running"
  const playbackDetailLabel = getPlaybackStatusDetail(playbackState)
  const playbackScriptLabel =
    playbackLabelOverride?.trim() || playbackState.label?.trim() || playbackState.fileName?.trim()
  const playbackErrorKey = useMemo(() => {
    const errorMessage = playbackState.status === "error" ? playbackState.error?.trim() : ""
    if (!errorMessage) return null
    return [playbackState.startedAt ?? "", playbackState.endedAt ?? "", errorMessage].join("::")
  }, [playbackState.endedAt, playbackState.error, playbackState.startedAt, playbackState.status])
  const playbackErrorMessage =
    playbackState.status === "error" ? (playbackState.error?.trim() ?? "") : ""
  const showPlaybackError =
    playbackModeActive &&
    Boolean(playbackErrorKey) &&
    playbackErrorKey !== dismissedErrorKey &&
    playbackErrorMessage
  const statusDotClassName = playbackHasOutput
    ? getPlaybackStatusDotClassName(playbackState.status)
    : fallbackDotClassName
  const statusLine = playbackHasOutput
    ? playbackModeActive && playbackScriptLabel
      ? `"${playbackScriptLabel}"脚本 - ${getPlaybackStatusText(playbackState)} · ${playbackDetailLabel}`
      : `${getPlaybackStatusText(playbackState)} · ${playbackDetailLabel}`
    : fallbackStatusText

  useEffect(() => {
    if (!copiedErrorKey) return
    const timeoutId = window.setTimeout(() => {
      setCopiedErrorKey((current) => (current === copiedErrorKey ? null : current))
    }, 2000)
    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [copiedErrorKey])

  const copyPlaybackError = useCallback(async () => {
    if (!playbackErrorMessage || !playbackErrorKey) return
    try {
      await navigator.clipboard.writeText(playbackErrorMessage)
      setCopiedErrorKey(playbackErrorKey)
    } catch (error) {
      console.error("[BrowserPlaybackControl] Failed to copy playback error:", error)
    }
  }, [playbackErrorKey, playbackErrorMessage])

  return (
    <div className={'w-full'}>
      <div className={'w-full'}>
        {showPlaybackError ? (
          <div
            className="flex min-w-0 items-center gap-1 overflow-hidden text-[10px] leading-none text-destructive"
            role="alert"
            aria-live="polite"
          >
            <AlertTriangle className="size-3 shrink-0" strokeWidth={1.8} />
            <span className="min-w-0 flex-1 truncate" title={playbackErrorMessage}>
              {playbackErrorMessage}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-4 rounded-sm p-0 text-destructive/70 hover:bg-transparent hover:text-destructive"
              onClick={() => void copyPlaybackError()}
              aria-label="复制异常信息"
              title="复制异常信息"
            >
              {copiedErrorKey === playbackErrorKey ? (
                <Check className="size-2.5" strokeWidth={2} />
              ) : (
                <Copy className="size-2.5" strokeWidth={1.8} />
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-4 rounded-sm p-0 text-destructive/70 hover:bg-transparent hover:text-destructive"
              onClick={() => {
                if (playbackErrorKey) setDismissedErrorKey(playbackErrorKey)
              }}
              aria-label="关闭异常信息"
              title="关闭异常信息"
            >
              <X className="size-2.5" strokeWidth={1.8} />
            </Button>
          </div>
        ) : null}
      </div>

      <div className={'flex justify-between'}>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 overflow-hidden">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <span className={cn("size-2 shrink-0 rounded-full", statusDotClassName)} />
            <span
              className={cn(
                "truncate text-[11px] text-foreground",
                playbackModeActive ? "max-w-[320px]" : "max-w-full"
              )}
              title={statusLine}
            >
              {statusLine}
            </span>
          </div>
        </div>

        {playbackModeActive && playbackStatusActive ? (
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
        ) : playbackModeActive ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 rounded-md px-2.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={onExitPlaybackMode}
          >
            <ArrowLeft className="size-3" strokeWidth={1.8} />
            返回
          </Button>
        ) : null}
      </div>
    </div>
  )
}
