import {
  FileCode2,
  FolderOpen,
  Loader2,
  MousePointerClick,
  Pause,
  Play,
  Square,
  Video
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { AiRecordingSession, BrowserRecordingSource } from "../../../../shared/browser-types"
import {
  isRecordingSessionActive,
  recordingSessionHasOutput
} from "./BrowserAiRecordingControl.utils"

interface BrowserAiRecordingControlProps {
  browserCreated: boolean
  aiRecording: AiRecordingSession
  manualRecording: AiRecordingSession
  busySource: BrowserRecordingSource | null
  pendingUnsavedBySource: Record<BrowserRecordingSource, boolean>
  onOpenRecordingDialog: (source: BrowserRecordingSource) => void
  onOpenScriptLibrary: () => void
  onStartAiRecording: () => void
  onStartManualRecording: () => void
  onStopAiRecording: () => void
  onStopManualRecording: () => void
  onPauseAiRecording: () => void
  onPauseManualRecording: () => void
  onResumeAiRecording: () => void
  onResumeManualRecording: () => void
}

const RECORDING_SOURCES: BrowserRecordingSource[] = ["ai", "manual"]

export function BrowserAiRecordingControl({
  browserCreated,
  aiRecording,
  manualRecording,
  busySource,
  pendingUnsavedBySource,
  onOpenRecordingDialog,
  onOpenScriptLibrary,
  onStartAiRecording,
  onStartManualRecording,
  onStopAiRecording,
  onStopManualRecording,
  onPauseAiRecording,
  onPauseManualRecording,
  onResumeAiRecording,
  onResumeManualRecording
}: BrowserAiRecordingControlProps): React.JSX.Element {
  const activeRecordingSource = isRecordingSessionActive(aiRecording)
    ? "ai"
    : isRecordingSessionActive(manualRecording)
      ? "manual"
      : null
  const resultSources = RECORDING_SOURCES.filter((source) => {
    const session = source === "manual" ? manualRecording : aiRecording
    return (
      session.status === "completed" &&
      recordingSessionHasOutput(session) &&
      pendingUnsavedBySource[source]
    )
  })
  const activeSession =
    activeRecordingSource === "manual"
      ? manualRecording
      : activeRecordingSource === "ai"
        ? aiRecording
        : null
  const activeRecordingIsBusy = activeRecordingSource ? busySource === activeRecordingSource : false
  const activeRecordingIsPaused = activeSession?.status === "paused"
  const aiButtonDisabledReason = !browserCreated
    ? "浏览器尚未就绪，请等待页面加载完成"
    : busySource
      ? "正在处理中，请稍候"
      : isRecordingSessionActive(manualRecording)
        ? "人工录制进行中，请先终止当前录制"
        : null
  const manualButtonDisabledReason = !browserCreated
    ? "浏览器尚未就绪，请等待页面加载完成"
    : busySource
      ? "正在处理中，请稍候"
      : isRecordingSessionActive(aiRecording)
        ? "AI录制进行中，请先终止当前录制"
        : null

  return (
    <>
      {resultSources.map((source) => {
        const session = source === "manual" ? manualRecording : aiRecording
        return (
          <Button
            key={`result-${source}`}
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => onOpenRecordingDialog(source)}
          >
            <FileCode2 className="size-3.5" strokeWidth={1.8} />
            查看{source === "manual" ? "人工" : "AI"}
            {session.actions.length > 0 ? (
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {session.actions.length}
              </span>
            ) : null}
          </Button>
        )
      })}

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

      {activeRecordingSource ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={activeRecordingIsBusy}
            className="h-8 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => onOpenRecordingDialog(activeRecordingSource)}
          >
            <FileCode2 className="size-3.5" strokeWidth={1.8} />
            详情
          </Button>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={activeRecordingIsBusy}
            className="h-8 rounded-md px-2.5 text-[11px] shadow-none"
            onClick={() =>
              activeRecordingSource === "manual" ? onStopManualRecording() : onStopAiRecording()
            }
          >
            {activeRecordingIsBusy ? (
              <Loader2 className="size-3 animate-spin" strokeWidth={1.8} />
            ) : (
              <Square className="size-3 text-red-500" strokeWidth={1.8} />
            )}
            {activeRecordingIsBusy ? "处理中..." : "终止"}
          </Button>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={activeRecordingIsBusy}
            className="h-8 rounded-md px-2.5 text-[11px] shadow-none"
            onClick={() =>
              activeRecordingSource === "manual"
                ? activeRecordingIsPaused
                  ? onResumeManualRecording()
                  : onPauseManualRecording()
                : activeRecordingIsPaused
                  ? onResumeAiRecording()
                  : onPauseAiRecording()
            }
          >
            {activeRecordingIsBusy ? (
              <Loader2 className="size-3 animate-spin" strokeWidth={1.8} />
            ) : activeRecordingIsPaused ? (
              <Play className="size-3 text-green-600" strokeWidth={1.8} />
            ) : (
              <Pause className="size-3" strokeWidth={1.8} />
            )}
            {activeRecordingIsBusy ? "处理中..." : activeRecordingIsPaused ? "继续" : "暂停"}
          </Button>
        </>
      ) : (
        <>
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                {aiButtonDisabledReason ? (
                  <span className="inline-flex cursor-not-allowed">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled
                      className="h-8 rounded-md px-2.5 text-[11px] shadow-none"
                    >
                      <Video className="size-3.5" strokeWidth={1.8} />
                      AI录制
                    </Button>
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-8 rounded-md px-2.5 text-[11px] shadow-none"
                    onClick={onStartAiRecording}
                  >
                    <Video className="size-3.5" strokeWidth={1.8} />
                    AI录制
                  </Button>
                )}
              </TooltipTrigger>
              {aiButtonDisabledReason ? (
                <TooltipContent side="top">
                  <p>{aiButtonDisabledReason}</p>
                </TooltipContent>
              ) : null}
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                {manualButtonDisabledReason ? (
                  <span className="inline-flex cursor-not-allowed">
                    <Button
                      type="button"
                      size="sm"
                      variant="info"
                      disabled
                      className="h-8 rounded-md px-2.5 text-[11px] shadow-none"
                    >
                      <MousePointerClick className="size-3.5" strokeWidth={1.8} />
                      人工录制
                    </Button>
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="info"
                    className="h-8 rounded-md px-2.5 text-[11px] shadow-none"
                    onClick={onStartManualRecording}
                  >
                    <MousePointerClick className="size-3.5" strokeWidth={1.8} />
                    人工录制
                  </Button>
                )}
              </TooltipTrigger>
              {manualButtonDisabledReason ? (
                <TooltipContent side="top">
                  <p>{manualButtonDisabledReason}</p>
                </TooltipContent>
              ) : null}
            </Tooltip>
          </TooltipProvider>
        </>
      )}
    </>
  )
}
