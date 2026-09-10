import {
  FileCode2,
  FolderOpen,
  Loader2,
  MousePointerClick,
  Pause,
  Play,
  Square
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { BrowserRecordingSession } from "../../../../shared/browser-types"
import {
  isRecordingSessionActive,
  recordingSessionHasOutput
} from "./BrowserScriptRecordingControl.utils"

interface BrowserScriptRecordingControlProps {
  browserCreated: boolean
  scriptRecording: BrowserRecordingSession
  isBusy: boolean
  hasPendingUnsaved: boolean
  onOpenRecordingDialog: () => void
  onOpenScriptLibrary: () => void
  onStartScriptRecording: () => void
  onStopScriptRecording: () => void
  onPauseScriptRecording: () => void
  onResumeScriptRecording: () => void
}

export function BrowserScriptRecordingControl({
  browserCreated,
  scriptRecording,
  isBusy,
  hasPendingUnsaved,
  onOpenRecordingDialog,
  onOpenScriptLibrary,
  onStartScriptRecording,
  onStopScriptRecording,
  onPauseScriptRecording,
  onResumeScriptRecording
}: BrowserScriptRecordingControlProps): React.JSX.Element {
  const isRecordingActive = isRecordingSessionActive(scriptRecording)
  const hasResult =
    scriptRecording.status === "completed" &&
    recordingSessionHasOutput(scriptRecording) &&
    hasPendingUnsaved
  const isRecordingPaused = scriptRecording.status === "paused"
  const startDisabledReason = !browserCreated
    ? "浏览器尚未就绪，请等待页面加载完成"
    : isBusy
      ? "正在处理中，请稍候"
      : null

  return (
    <>
      {hasResult ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={onOpenRecordingDialog}
        >
          <FileCode2 className="size-3.5" strokeWidth={1.8} />
          查看录制
          {scriptRecording.actions.length > 0 ? (
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {scriptRecording.actions.length}
            </span>
          ) : null}
        </Button>
      ) : null}

      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={onOpenScriptLibrary}
      >
        <FolderOpen className="size-3.5" strokeWidth={1.8} />
        列表
      </Button>

      {isRecordingActive ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={isBusy}
            className="h-8 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={onOpenRecordingDialog}
          >
            <FileCode2 className="size-3.5" strokeWidth={1.8} />
            详情
          </Button>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={isBusy}
            className="h-8 rounded-md px-2.5 text-[11px] shadow-none"
            onClick={onStopScriptRecording}
          >
            {isBusy ? (
              <Loader2 className="size-3 animate-spin" strokeWidth={1.8} />
            ) : (
              <Square className="size-3 text-red-500" strokeWidth={1.8} />
            )}
            {isBusy ? "处理中..." : "终止"}
          </Button>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={isBusy}
            className="h-8 rounded-md px-2.5 text-[11px] shadow-none"
            onClick={isRecordingPaused ? onResumeScriptRecording : onPauseScriptRecording}
          >
            {isBusy ? (
              <Loader2 className="size-3 animate-spin" strokeWidth={1.8} />
            ) : isRecordingPaused ? (
              <Play className="size-3 text-green-600" strokeWidth={1.8} />
            ) : (
              <Pause className="size-3" strokeWidth={1.8} />
            )}
            {isBusy ? "处理中..." : isRecordingPaused ? "继续" : "暂停"}
          </Button>
        </>
      ) : (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              {startDisabledReason ? (
                <span className="inline-flex cursor-not-allowed">
                  <Button
                    type="button"
                    size="sm"
                    variant="info"
                    disabled
                    className="h-8 rounded-md px-2.5 text-[11px] shadow-none"
                  >
                    <MousePointerClick className="size-3.5" strokeWidth={1.8} />
                    录制脚本
                  </Button>
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="info"
                  className="h-8 rounded-md px-2.5 text-[11px] shadow-none"
                  onClick={onStartScriptRecording}
                >
                  <MousePointerClick className="size-3.5" strokeWidth={1.8} />
                  录制脚本
                </Button>
              )}
            </TooltipTrigger>
            {startDisabledReason ? (
              <TooltipContent side="top">
                <p>{startDisabledReason}</p>
              </TooltipContent>
            ) : null}
          </Tooltip>
        </TooltipProvider>
      )}
    </>
  )
}
