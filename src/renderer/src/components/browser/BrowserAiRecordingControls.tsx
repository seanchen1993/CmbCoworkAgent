import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Check,
  Copy,
  Download,
  FileCode2,
  Loader2,
  Lock,
  Pause,
  Sparkles,
  Video
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { AiRecordedBrowserAction, AiRecordingSession } from "../../../../shared/browser-types"

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

function describeAiRecordedActionKind(kind: AiRecordedBrowserAction["kind"]): string {
  switch (kind) {
    case "navigate":
      return "导航"
    case "click":
      return "点击"
    case "fill":
      return "输入"
    case "selectOption":
      return "选择"
    case "press":
      return "按键"
  }
}

function getAiRecordedActionTone(kind: AiRecordedBrowserAction["kind"]): string {
  switch (kind) {
    case "navigate":
      return "border-status-info/25 bg-status-info/10 text-status-info"
    case "click":
      return "border-primary/25 bg-primary/10 text-foreground"
    case "fill":
      return "border-status-warning/25 bg-status-warning/10 text-status-warning"
    case "selectOption":
      return "border-status-nominal/25 bg-status-nominal/10 text-status-nominal"
    case "press":
      return "border-border/70 bg-background/80 text-muted-foreground"
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
      saveFilenameInputRef.current?.select()
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
    const prefix = "分析这个脚本内容，使用内置浏览器执行这个脚本里面的步骤，不允许使用screenshot 和runcode。脚本为："
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
  const aiRecordingScriptReady = aiRecording.script.trim().length > 0
  const aiRecordingHasOutput =
    aiRecordingOwnedByCurrentThread &&
    (aiRecording.status === "recording" || aiRecordingActionCount > 0 || aiRecordingScriptReady)
  const aiRecordingScriptLineCount = aiRecordingScriptReady
    ? aiRecording.script.split(/\r?\n/).length
    : 0
  const aiRecordingStatusText = aiRecordingLockedByOtherThread
    ? "其他任务正在录制 AI 流程"
    : aiRecording.status === "recording"
      ? `录制进行中，已捕获 ${aiRecordingActionCount} 步`
      : aiRecordingActionCount > 0
        ? `最近一次录制生成了 ${aiRecordingActionCount} 步`
        : "当前任务可开始 AI 录制"
  const aiRecordingStatusBadge = aiRecordingLockedByOtherThread
    ? {
        label: "占用中",
        variant: "warning" as const,
        containerClassName: "border-status-warning/30 bg-status-warning/10",
        iconClassName: "border-status-warning/20 bg-status-warning/15 text-status-warning"
      }
    : aiRecording.status === "recording"
      ? {
          label: "录制中",
          variant: "info" as const,
          containerClassName: "border-status-info/30 bg-status-info/10",
          iconClassName: "border-status-info/20 bg-status-info/15 text-status-info"
        }
      : aiRecordingActionCount > 0 || aiRecordingScriptReady
        ? {
            label: "已生成",
            variant: "nominal" as const,
            containerClassName: "border-status-nominal/25 bg-status-nominal/10",
            iconClassName: "border-status-nominal/20 bg-status-nominal/15 text-status-nominal"
          }
        : browserCreated
          ? {
              label: "就绪",
              variant: "outline" as const,
              containerClassName: "border-border/70 bg-background/85",
              iconClassName: "border-primary/15 bg-primary/10 text-primary"
            }
          : {
              label: "等待浏览器",
              variant: "outline" as const,
              containerClassName: "border-border/70 bg-background/85",
              iconClassName: "border-border/70 bg-muted/60 text-muted-foreground"
            }

  const mainButtonDisabled = isAiRecordingBusy || !browserCreated || aiRecordingLockedByOtherThread
  const mainButtonDisabledReason = useMemo(() => {
    if (isAiRecordingBusy) return "正在处理中，请稍候"
    if (aiRecordingLockedByOtherThread) return "其他任务正在录制 AI 流程，请先停止"
    if (!browserCreated) return "浏览器尚未就绪，请等待页面加载完成"
    return null
  }, [isAiRecordingBusy, browserCreated, aiRecordingLockedByOtherThread])
  const mainButtonIsRecording =
    aiRecording.status === "recording" && !aiRecordingLockedByOtherThread
  const mainButtonLabel = isAiRecordingBusy
    ? "处理中..."
    : mainButtonIsRecording
      ? "停止录制"
      : "开始录制"
  const mainButtonVariant = mainButtonIsRecording ? "warning" : "info"
  const aiRecordingStatusDotClassName = aiRecordingLockedByOtherThread
    ? "bg-status-warning"
    : mainButtonIsRecording
      ? "bg-status-info animate-tactical-pulse"
      : aiRecordingActionCount > 0 || aiRecordingScriptReady
        ? "bg-status-nominal"
        : browserCreated
          ? "bg-primary"
          : "bg-muted-foreground/60"

  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5" role="status" aria-live="polite">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <span className={cn("size-2 shrink-0 rounded-full", aiRecordingStatusDotClassName)} />
          <span className="hidden shrink-0 text-[11px] font-medium text-foreground/85 sm:inline">
            AI 录制
          </span>
          <span className="truncate text-[11px] text-muted-foreground">{aiRecordingStatusText}</span>
        </div>

        {aiRecordingHasOutput && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!aiRecordingOwnedByCurrentThread}
            className="h-8 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setAiRecordingDialogOpen(true)}
          >
            <FileCode2 className="size-3.5" strokeWidth={1.8} />
            查看
            {aiRecordingActionCount > 0 && (
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {aiRecordingActionCount}
              </span>
            )}
          </Button>
        )}

        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              {mainButtonDisabled ? (
                <span className="inline-flex cursor-not-allowed">
                  <Button
                    type="button"
                    size="sm"
                    variant={mainButtonVariant}
                    disabled={mainButtonDisabled}
                    aria-pressed={mainButtonIsRecording}
                    className="h-8 rounded-md px-2.5 text-[11px] shadow-none"
                    onClick={() =>
                      void (mainButtonIsRecording
                        ? stopAiRecordingSession()
                        : startAiRecordingSession())
                    }
                  >
                    {isAiRecordingBusy ? (
                      <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                    ) : mainButtonIsRecording ? (
                      <Pause className="size-3.5" strokeWidth={1.8} />
                    ) : (
                      <Video className="size-3.5" strokeWidth={1.8} />
                    )}
                    {mainButtonLabel}
                  </Button>
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant={mainButtonVariant}
                  disabled={mainButtonDisabled}
                  aria-pressed={mainButtonIsRecording}
                  className="h-8 rounded-md px-2.5 text-[11px] shadow-none"
                  onClick={() =>
                    void (mainButtonIsRecording
                      ? stopAiRecordingSession()
                      : startAiRecordingSession())
                  }
                >
                  {isAiRecordingBusy ? (
                    <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                  ) : mainButtonIsRecording ? (
                    <Pause className="size-3.5" strokeWidth={1.8} />
                  ) : (
                    <Video className="size-3.5" strokeWidth={1.8} />
                  )}
                  {mainButtonLabel}
                </Button>
              )}
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
        <DialogContent className="max-h-[88vh] max-w-5xl gap-0 overflow-hidden border-border/70 p-0 shadow-2xl">
          <DialogHeader className="gap-3 border-b border-border/70 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--primary)_9%,transparent),transparent)] px-5 py-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                    <Sparkles className="size-4" strokeWidth={1.9} />
                  </div>
                  <div className="min-w-0">
                    <DialogTitle className="text-base">自动化脚本录制结果</DialogTitle>
                    <DialogDescription className="mt-1 text-[12px] leading-5">
                      {aiRecordingOwnedByCurrentThread
                        ? aiRecording.status === "recording"
                          ? "Agent 在当前任务中对内置浏览器的成功操作会实时沉淀为 Playwright 草稿。"
                          : "下面是本次 AI 录制生成的步骤和 Playwright 脚本初稿。"
                        : "当前录制属于其他任务，这里不展示其脚本内容。"}
                    </DialogDescription>
                  </div>
                </div>
              </div>

              {aiRecordingOwnedByCurrentThread && (
                <div className="flex flex-wrap items-center gap-2 mr-8">
                  <Badge variant={aiRecordingStatusBadge.variant}>
                    {aiRecordingStatusBadge.label}
                  </Badge>
                  <span className="inline-flex items-center rounded-full border border-border/70 bg-background/80 px-2 py-1 text-[11px] text-muted-foreground">
                    <span className="mr-1 font-medium text-foreground">
                      {aiRecordingActionCount}
                    </span>
                    个步骤
                  </span>
                  <span className="inline-flex items-center rounded-full border border-border/70 bg-background/80 px-2 py-1 text-[11px] text-muted-foreground">
                    <span className="mr-1 font-medium text-foreground">
                      {aiRecordingScriptLineCount}
                    </span>
                    行脚本
                  </span>
                </div>
              )}
            </div>
          </DialogHeader>

          {aiRecordingOwnedByCurrentThread ? (
            <div className="grid min-h-0 flex-1 bg-background md:grid-cols-[300px_minmax(0,1fr)]">
              <div className="border-b border-border/70 bg-muted/20 md:border-b-0 md:border-r">
                <div className="border-b border-border/70 px-4 py-3">
                  <p className="text-sm font-medium text-foreground">步骤列表</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    共 {aiRecordingActionCount} 步，来源为当前任务中的 AI 浏览器操作。
                  </p>
                </div>
                <div className="max-h-[58vh] space-y-2.5 overflow-auto px-3 py-3">
                  {aiRecording.actions.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border/80 bg-background/90 px-4 py-5 text-[12px] leading-5 text-muted-foreground shadow-sm">
                      <div className="mb-3 flex size-9 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-muted-foreground">
                        <Sparkles className="size-4" strokeWidth={1.8} />
                      </div>
                      还没有采集到可生成脚本的操作。先开始录制，再让 Agent
                      导航、点击、输入或选择页面元素。
                    </div>
                  ) : (
                    aiRecording.actions.map((action, index) => (
                      <div
                        key={action.id}
                        className={cn(
                          "rounded-xl border px-3 py-3 transition-colors",
                          aiRecording.status === "recording" &&
                            index === aiRecording.actions.length - 1
                            ? "border-status-info/35 bg-status-info/10 shadow-sm"
                            : "border-border/70 bg-background/90 hover:border-border-emphasis"
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="rounded-full border border-border/60 bg-background/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground/80">
                                Step {index + 1}
                              </span>
                              <span
                                className={cn(
                                  "rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                                  getAiRecordedActionTone(action.kind)
                                )}
                              >
                                {describeAiRecordedActionKind(action.kind)}
                              </span>
                            </div>
                            <p className="mt-1.5 text-[12px] leading-5 text-foreground/90">
                              {describeAiRecordedAction(action)}
                            </p>
                          </div>
                          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                            {formatAiRecordingTime(action.timestamp)}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="flex min-h-0 flex-col">
                <div className="border-b border-border/70 px-4 py-3">
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <div className="flex size-8 items-center justify-center rounded-lg border border-slate-700/70 bg-slate-900 text-slate-200">
                          <FileCode2 className="size-4" strokeWidth={1.8} />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-foreground">Playwright 脚本</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            第一版会优先保留语义化定位；复杂页面仍建议人工复查 locator。
                          </p>
                        </div>
                      </div>
                    </div>

                    {isSavingToWorkspace ? (
                      <div className="flex flex-1 flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-muted/25 p-2 xl:max-w-[420px] xl:justify-end">
                        <Input
                          ref={saveFilenameInputRef}
                          type="text"
                          value={saveFilename}
                          onChange={(e) => setSaveFilename(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") confirmSaveToWorkspace()
                            if (e.key === "Escape") cancelSaveToWorkspace()
                          }}
                          placeholder="输入文件名（不含扩展名）"
                          className="h-9 min-w-[220px] flex-1 rounded-lg border-border/80 bg-background text-xs shadow-none placeholder:text-muted-foreground/80"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="default"
                          className="h-9 rounded-lg"
                          disabled={!saveFilename.trim()}
                          onClick={confirmSaveToWorkspace}
                        >
                          <Check className="size-3.5" strokeWidth={1.8} />
                          保存
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-9 rounded-lg"
                          onClick={cancelSaveToWorkspace}
                        >
                          取消
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-9 rounded-lg"
                          disabled={!aiRecordingScriptReady}
                          onClick={() => void saveAiRecordingScriptToWorkspace()}
                        >
                          <Download className="size-3.5" strokeWidth={1.8} />
                          保存文件
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-9 rounded-lg"
                          disabled={!aiRecordingScriptReady}
                          onClick={() => void copyAiRecordingScriptForBrowser()}
                        >
                          <Copy className="size-3.5" strokeWidth={1.8} />
                          复制给内置浏览器
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className={cn(
                            "h-9 rounded-lg transition-colors",
                            copiedAiScript &&
                              "border-status-nominal/30 bg-status-nominal/10 text-status-nominal hover:bg-status-nominal/15 hover:text-status-nominal"
                          )}
                          disabled={!aiRecordingScriptReady}
                          onClick={() => void copyAiRecordingScript()}
                        >
                          {copiedAiScript ? (
                            <Check className="size-3.5" strokeWidth={1.8} />
                          ) : (
                            <Copy className="size-3.5" strokeWidth={1.8} />
                          )}
                          {copiedAiScript ? "已复制" : "复制脚本"}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>

                <div className="min-h-0 flex-1 p-4 pt-3">
                  <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-slate-900/80 bg-[#0b0f14] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                    <div className="flex items-center justify-between border-b border-white/10 bg-[#11161d] px-4 py-2 text-[11px] text-slate-400">
                      <div className="flex items-center gap-2">
                        <FileCode2 className="size-3.5" strokeWidth={1.8} />
                        <span>playwright.spec.ts 草稿</span>
                      </div>
                      <span className="font-mono tabular-nums">
                        {aiRecordingScriptReady ? `${aiRecordingScriptLineCount} lines` : "waiting"}
                      </span>
                    </div>
                    <pre className="min-h-0 flex-1 overflow-auto px-4 py-4 font-mono text-[12px] leading-6 text-slate-100">
                      <code>{aiRecording.script || "// No script generated yet."}</code>
                    </pre>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="px-5 py-6 text-sm text-muted-foreground">
              <div className="flex items-start gap-3 rounded-xl border border-status-warning/25 bg-status-warning/10 px-4 py-4 text-status-warning">
                <Lock className="mt-0.5 size-4 shrink-0" strokeWidth={1.8} />
                <div className="min-w-0">
                  <p className="font-medium text-foreground">当前录制由其他任务持有</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    请切换回对应任务查看录制详情，或先停止那边的录制。
                  </p>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
