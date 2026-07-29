import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, Copy, Download, Video, Loader2, Pause } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip"
import type {
  AiRecordedBrowserAction,
  AiRecordingSession
} from "../../../../shared/browser-types"

interface BrowserAiRecordingControlsProps {
  threadId?: string | null
  browserCreated: boolean
}

const AI_RECORDING_POLL_MS = 800
const EMPTY_AI_RECORDING: AiRecordingSession = {
  status: "idle",
  actions: [],
  script: ""
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatAiRecordingTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return "--:--:--"
  return date.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  })
}

function describeAiRecordedAction(action: AiRecordedBrowserAction): string {
  switch (action.kind) {
    case "navigate":
      return `打开页面 ${action.url}`
    case "click":
      return action.doubleClick
        ? `双击 ${action.target || "目标元素"}`
        : `点击 ${action.target || "目标元素"}`
    case "fill":
      return action.sensitive
        ? `填写 ${action.target || "输入框"}（敏感值已脱敏）`
        : `填写 ${action.target || "输入框"} = ${action.value || "(空值)"}`
    case "selectOption":
      return `在 ${action.target || "下拉框"} 中选择 ${action.values.join(", ") || "(空值)"}`
    case "press":
      return action.target ? `在 ${action.target} 上按下 ${action.key}` : `按下 ${action.key}`
  }
}

export function BrowserAiRecordingControls({
  threadId,
  browserCreated
}: BrowserAiRecordingControlsProps): React.JSX.Element {
  const [aiRecording, setAiRecording] = useState<AiRecordingSession>(EMPTY_AI_RECORDING)
  const [isAiRecordingBusy, setIsAiRecordingBusy] = useState(false)
  const [aiRecordingDialogOpen, setAiRecordingDialogOpen] = useState(false)
  const [copiedAiScript, setCopiedAiScript] = useState(false)
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false)
  const [saveFilename, setSaveFilename] = useState("")
  const saveFilenameInputRef = useRef<HTMLInputElement>(null)

  const refreshAiRecording = useCallback(async () => {
    try {
      const nextSession = await window.api.browser.getAiRecording()
      setAiRecording(nextSession)
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to refresh AI recording: ${formatError(error)}`
      )
    }
  }, [])

  useEffect(() => {
    void refreshAiRecording()
  }, [refreshAiRecording, threadId])

  useEffect(() => {
    if (aiRecording.status !== "recording") return
    const interval = window.setInterval(() => {
      void refreshAiRecording()
    }, AI_RECORDING_POLL_MS)
    return () => {
      window.clearInterval(interval)
    }
  }, [aiRecording.status, refreshAiRecording])

  useEffect(() => {
    if (isSavingToWorkspace) {
      setSaveFilename("ai-recording")
      saveFilenameInputRef.current?.focus()
    }
  }, [isSavingToWorkspace])

  const startAiRecordingSession = useCallback(async () => {
    setIsAiRecordingBusy(true)
    try {
      const nextSession = await window.api.browser.startAiRecording({
        threadId: threadId ?? undefined
      })
      setAiRecording(nextSession)
      toast.success("AI 录制已开始。让 Agent 在当前任务中操作页面即可。")
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to start AI recording: ${formatError(error)}`
      )
      toast.error(formatError(error) || "启动 AI 录制失败")
    } finally {
      setIsAiRecordingBusy(false)
    }
  }, [threadId])

  const stopAiRecordingSession = useCallback(async () => {
    setIsAiRecordingBusy(true)
    try {
      const nextSession = await window.api.browser.stopAiRecording()
      setAiRecording(nextSession)
      setAiRecordingDialogOpen(true)
      if (nextSession.actions.length > 0) {
        toast.success(`AI 录制已停止，已生成 ${nextSession.actions.length} 个步骤。`)
      } else {
        toast.warning("AI 录制已停止，但还没有采集到可生成脚本的页面操作。")
      }
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to stop AI recording: ${formatError(error)}`
      )
      toast.error("停止 AI 录制失败")
    } finally {
      setIsAiRecordingBusy(false)
    }
  }, [])

  const copyAiRecordingScript = useCallback(async () => {
    if (!aiRecording.script.trim()) return
    try {
      await navigator.clipboard.writeText(aiRecording.script)
      setCopiedAiScript(true)
      window.setTimeout(() => {
        setCopiedAiScript(false)
      }, 1500)
      toast.success("脚本已复制")
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to copy AI recording script: ${formatError(error)}`
      )
      toast.error("复制脚本失败")
    }
  }, [aiRecording.script])

  const copyAiRecordingScriptForBrowser = useCallback(async () => {
    if (!aiRecording.script.trim()) return
    const prefix = "内置浏览器执行这个脚本，不允许使用screenshot 和runcode。脚本为："
    try {
      await navigator.clipboard.writeText(prefix + aiRecording.script)
      toast.success("脚本已复制（内置浏览器使用）")
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to copy AI recording script for browser: ${formatError(error)}`
      )
      toast.error("复制脚本失败")
    }
  }, [aiRecording.script])

  const saveAiRecordingScriptToWorkspace = useCallback(() => {
    if (!aiRecording.script.trim()) return
    setIsSavingToWorkspace(true)
  }, [aiRecording.script])

  const confirmSaveToWorkspace = useCallback(() => {
    const trimmed = saveFilename.trim()
    if (!trimmed) return
    const safeName = trimmed.replace(/[\\/:*?"<>|]/g, "_")
    const blob = new Blob([aiRecording.script], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `${safeName}.spec.ts`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    toast.success(`脚本已保存为 ${safeName}.spec.ts`)
    setIsSavingToWorkspace(false)
    setSaveFilename("")
  }, [saveFilename, aiRecording.script])

  const cancelSaveToWorkspace = useCallback(() => {
    setIsSavingToWorkspace(false)
    setSaveFilename("")
  }, [])

  const aiRecordingOwnedByCurrentThread =
    !aiRecording.threadId || !threadId || aiRecording.threadId === threadId
  const aiRecordingLockedByOtherThread =
    aiRecording.status === "recording" &&
    Boolean(aiRecording.threadId) &&
    aiRecording.threadId !== threadId
  const aiRecordingActionCount = aiRecordingOwnedByCurrentThread ? aiRecording.actions.length : 0
  const aiRecordingHasOutput =
    aiRecordingOwnedByCurrentThread &&
    (aiRecording.status === "recording" ||
      aiRecordingActionCount > 0 ||
      aiRecording.script.length > 0)
  const aiRecordingStatusText = aiRecordingLockedByOtherThread
    ? "其他任务正在录制 AI 流程"
    : aiRecording.status === "recording"
      ? `录制进行中，已捕获 ${aiRecordingActionCount} 步`
      : aiRecordingActionCount > 0
        ? `最近一次录制生成了 ${aiRecordingActionCount} 步`
        : "当前任务可开始 AI 录制"

  const mainButtonDisabled =
    isAiRecordingBusy || !browserCreated || aiRecordingLockedByOtherThread
  const mainButtonDisabledReason = useMemo(() => {
    if (isAiRecordingBusy) return "正在处理中，请稍候"
    if (aiRecordingLockedByOtherThread) return "其他任务正在录制 AI 流程，请先停止"
    if (!browserCreated) return "浏览器尚未就绪，请等待页面加载完成"
    return null
  }, [isAiRecordingBusy, browserCreated, aiRecordingLockedByOtherThread])

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span className="hidden max-w-48 truncate text-[11px] text-muted-foreground md:inline">
          {aiRecordingStatusText}
        </span>
        {aiRecordingHasOutput && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!aiRecordingOwnedByCurrentThread}
            onClick={() => setAiRecordingDialogOpen(true)}
          >
            查看脚本
            {aiRecordingActionCount > 0 ? ` (${aiRecordingActionCount})` : ""}
          </Button>
        )}
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant={"outline"}
                disabled={mainButtonDisabled}
                onClick={() =>
                  void (aiRecording.status === "recording" && !aiRecordingLockedByOtherThread
                    ? stopAiRecordingSession()
                    : startAiRecordingSession())
                }
              >
                {aiRecording.status === "recording" ? (
                  <Pause className="size-3.5" strokeWidth={1.8} />
                ) : isAiRecordingBusy ? (
                  <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                ) : (
                  <Video className="size-3.5" strokeWidth={1.8} />
                )}
                {aiRecording.status === "recording" && !aiRecordingLockedByOtherThread
                  ? "停止 AI 录制"
                  : "开始 AI 录制"}
              </Button>
            </TooltipTrigger>
            {mainButtonDisabledReason && (
              <TooltipContent side="top">
                <p>{mainButtonDisabledReason}</p>
              </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>

      </div>

      <Dialog
        open={aiRecordingDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsSavingToWorkspace(false)
            setSaveFilename("")
          }
          setAiRecordingDialogOpen(open)
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-5xl gap-0 p-0">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle>AI 录制结果</DialogTitle>
            <DialogDescription>
              {aiRecordingOwnedByCurrentThread
                ? aiRecording.status === "recording"
                  ? "Agent 在当前任务中对内置浏览器的成功操作会实时沉淀为 Playwright 草稿。"
                  : "下面是本次 AI 录制生成的步骤和 Playwright 脚本初稿。"
                : "当前录制属于其他任务，这里不展示其脚本内容。"}
            </DialogDescription>
          </DialogHeader>

          {aiRecordingOwnedByCurrentThread ? (
            <div className="grid min-h-0 flex-1 md:grid-cols-[280px_minmax(0,1fr)]">
              <div className="border-b border-border/70 bg-muted/20 md:border-b-0 md:border-r">
                <div className="border-b border-border/70 px-4 py-3">
                  <p className="text-sm font-medium text-foreground">步骤列表</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    共 {aiRecordingActionCount} 步，来源为当前任务中的 AI 浏览器操作。
                  </p>
                </div>
                <div className="max-h-[58vh] space-y-2 overflow-auto px-3 py-3">
                  {aiRecording.actions.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border/80 bg-background px-3 py-4 text-[12px] leading-5 text-muted-foreground">
                      还没有采集到可生成脚本的操作。先开始录制，再让 Agent
                      导航、点击、输入或选择页面元素。
                    </div>
                  ) : (
                    aiRecording.actions.map((action, index) => (
                      <div
                        key={action.id}
                        className="rounded-lg border border-border/70 bg-background px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-foreground">
                            Step {index + 1}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {formatAiRecordingTime(action.timestamp)}
                          </span>
                        </div>
                        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                          {describeAiRecordedAction(action)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="flex min-h-0 flex-col space-y-2">
                <div className="flex flex-col  border-b border-border/70 px-4 py-3 space-y-2 ">
                  <div>
                    <p className="text-sm font-medium text-foreground">Playwright 脚本</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      第一版会优先保留语义化定位；复杂页面仍建议人工复查 locator。
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {isSavingToWorkspace ? (
                      <>
                        <input
                          ref={saveFilenameInputRef}
                          type="text"
                          value={saveFilename}
                          onChange={(e) => setSaveFilename(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") confirmSaveToWorkspace()
                            if (e.key === "Escape") cancelSaveToWorkspace()
                          }}
                          placeholder="输入文件名（不含扩展名）"
                          className="h-8 w-52 rounded-md border border-border bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="default"
                          disabled={!saveFilename.trim()}
                          onClick={confirmSaveToWorkspace}
                        >
                          <Check className="size-3.5" strokeWidth={1.8} />
                          确认
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={cancelSaveToWorkspace}
                        >
                          取消
                        </Button>
                      </>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!aiRecording.script.trim()}
                          onClick={() => void saveAiRecordingScriptToWorkspace()}
                        >
                          <Download className="size-3.5" strokeWidth={1.8} />
                          保存文件到工作区
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!aiRecording.script.trim()}
                          onClick={() => void copyAiRecordingScriptForBrowser()}
                        >
                          <Copy className="size-3.5" strokeWidth={1.8} />
                          复制脚本（内置浏览器使用）
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!aiRecording.script.trim()}
                          onClick={() => void copyAiRecordingScript()}
                        >
                          {copiedAiScript ? (
                            <Check className="size-3.5" strokeWidth={1.8} />
                          ) : (
                            <Copy className="size-3.5" strokeWidth={1.8} />
                          )}
                          复制文本
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
                <pre className="min-h-0 flex-1 overflow-auto bg-[#0b0f14] px-4 py-4 font-mono text-[12px] leading-6 text-slate-100">
                  <code>{aiRecording.script || "// No script generated yet."}</code>
                </pre>
              </div>
            </div>
          ) : (
            <div className="px-5 py-6 text-sm text-muted-foreground">
              当前有另一个任务正在进行 AI 录制。请切换回对应任务查看录制详情，或先停止那边的录制。
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
