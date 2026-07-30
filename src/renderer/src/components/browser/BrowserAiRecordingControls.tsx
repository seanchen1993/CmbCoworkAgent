import { useCallback, useEffect, useMemo, useState } from "react"
import { FileCode2, FolderOpen, Loader2, Pause, Video } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  extractAiRecordingVariableNames,
  generateAiRecordingScript
} from "../../../../shared/browser-ai-recording-script"
import type {
  AiRecordingSession,
  BrowserScriptLibraryEntry
} from "../../../../shared/browser-types"
import { BrowserAiRecordingResultDialog } from "./BrowserAiRecordingResultDialog"
import { BrowserRecordingListDialog } from "./BrowserRecordingListDialog"

interface BrowserAiRecordingControlsProps {
  browserCreated: boolean
  threadId?: string | null
  workspacePath?: string | null
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

export function BrowserAiRecordingControls({
  browserCreated,
  threadId,
  workspacePath
}: BrowserAiRecordingControlsProps): React.JSX.Element {
  const [aiRecording, setAiRecording] = useState<AiRecordingSession>(EMPTY_AI_RECORDING)
  const [hasPendingUnsavedAiRecording, setHasPendingUnsavedAiRecording] = useState(false)
  const [draftScript, setDraftScript] = useState("")
  const [isDraftScriptDirty, setIsDraftScriptDirty] = useState(false)
  const [selectedActionIds, setSelectedActionIds] = useState<string[]>([])
  const [variableActionIds, setVariableActionIds] = useState<string[]>([])
  const [variableActionNames, setVariableActionNames] = useState<Record<string, string>>({})
  const [selectionSyncKey, setSelectionSyncKey] = useState("")
  const [isAiRecordingBusy, setIsAiRecordingBusy] = useState(false)
  const [aiRecordingDialogOpen, setAiRecordingDialogOpen] = useState(false)
  const [isSaveSubmitting, setIsSaveSubmitting] = useState(false)
  const [saveDisplayName, setSaveDisplayName] = useState("")
  const [scriptLibraryOpen, setScriptLibraryOpen] = useState(false)
  const [scriptLibraryEntries, setScriptLibraryEntries] = useState<BrowserScriptLibraryEntry[]>([])
  const [isScriptLibraryLoading, setIsScriptLibraryLoading] = useState(false)
  const [scriptLibraryError, setScriptLibraryError] = useState<string | null>(null)
  const [loadingLibraryFileName, setLoadingLibraryFileName] = useState<string | null>(null)
  const [loadingLibraryAction, setLoadingLibraryAction] = useState<
    "copy" | "execution" | "delete" | null
  >(null)
  const hasWorkspace = Boolean(workspacePath?.trim())

  const resetSaveForm = useCallback(() => {
    setSaveDisplayName("")
  }, [])

  const buildDraftScript = useCallback(
    (
      nextSelectedActionIds: string[],
      nextVariableActionIds: string[],
      nextVariableActionNames: Record<string, string>
    ): string => {
      const nextActions = aiRecording.actions.filter((action) =>
        nextSelectedActionIds.includes(action.id)
      )
      const namedVariableActionIds = nextVariableActionIds.filter((actionId) =>
        nextVariableActionNames[actionId]?.trim()
      )

      return generateAiRecordingScript(nextActions, {
        variableActionIds: namedVariableActionIds,
        variableActionNames: nextVariableActionNames
      })
    },
    [aiRecording.actions]
  )

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
  }, [refreshAiRecording])

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
    const nextSelectionSyncKey = [
      aiRecording.id ?? "idle",
      aiRecording.status,
      aiRecording.actions.length,
      aiRecording.stoppedAt ?? aiRecording.startedAt ?? ""
    ].join(":")

    if (selectionSyncKey === nextSelectionSyncKey) return

    const nextSelectedActionIds = aiRecording.actions.map((action) => action.id)
    setSelectedActionIds(nextSelectedActionIds)
    setVariableActionIds([])
    setVariableActionNames({})
    setDraftScript(generateAiRecordingScript(aiRecording.actions))
    setIsDraftScriptDirty(false)
    setSelectionSyncKey(nextSelectionSyncKey)
  }, [aiRecording, selectionSyncKey])

  const startAiRecordingSession = useCallback(async () => {
    setIsAiRecordingBusy(true)
    try {
      const nextSession = await window.api.browser.startAiRecording()
      setAiRecording(nextSession)
      setHasPendingUnsavedAiRecording(false)
      toast.success("AI 录制已开始。让 Agent 在任意会话中操作页面即可。")
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to start AI recording: ${formatError(error)}`
      )
      toast.error(formatError(error) || "启动 AI 录制失败")
    } finally {
      setIsAiRecordingBusy(false)
    }
  }, [])

  const stopAiRecordingSession = useCallback(async () => {
    setIsAiRecordingBusy(true)
    try {
      const nextSession = await window.api.browser.stopAiRecording()
      setAiRecording(nextSession)
      setHasPendingUnsavedAiRecording(true)
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

  const loadScriptLibraryEntries = useCallback(async () => {
    if (!workspacePath?.trim()) {
      setScriptLibraryEntries([])
      setScriptLibraryError("当前会话还没有选择工作区")
      return
    }

    setIsScriptLibraryLoading(true)
    setScriptLibraryError(null)
    try {
      const entries = await window.api.browser.listScriptLibraryEntries({ workspacePath })
      setScriptLibraryEntries(entries)
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to load browser script library: ${formatError(error)}`
      )
      setScriptLibraryError(formatError(error) || "读取脚本库失败")
    } finally {
      setIsScriptLibraryLoading(false)
    }
  }, [workspacePath])

  const openScriptLibrary = useCallback(() => {
    setScriptLibraryOpen(true)
    void loadScriptLibraryEntries()
  }, [loadScriptLibraryEntries])

  const hasUnnamedVariableActions = variableActionIds.some(
    (actionId) => !variableActionNames[actionId]?.trim()
  )

  const confirmSaveToLibrary = useCallback(async () => {
    const displayName = saveDisplayName.trim()
    if (!displayName) {
      toast.error("请输入文件中文名")
      return
    }
    if (!workspacePath?.trim()) {
      toast.error("当前会话还没有选择工作区")
      return
    }
    if (!draftScript.trim()) {
      toast.error("当前没有可保存的脚本内容")
      return
    }
    if (hasUnnamedVariableActions) {
      toast.error("请先为已标记为变量的步骤填写变量名")
      return
    }

    setIsSaveSubmitting(true)
    try {
      await window.api.browser.saveScriptLibraryEntry({
        displayName,
        script: draftScript,
        threadId,
        workspacePath
      })
      toast.success(`脚本已保存`)
      setHasPendingUnsavedAiRecording(false)
      setAiRecordingDialogOpen(false)
      setScriptLibraryOpen(true)
      resetSaveForm()
      void loadScriptLibraryEntries()
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to save browser script library entry: ${formatError(error)}`
      )
      toast.error(formatError(error) || "保存脚本失败")
    } finally {
      setIsSaveSubmitting(false)
    }
  }, [
    draftScript,
    hasUnnamedVariableActions,
    loadScriptLibraryEntries,
    resetSaveForm,
    saveDisplayName,
    threadId,
    workspacePath
  ])

  const copyLibraryScript = useCallback(async (entry: BrowserScriptLibraryEntry) => {
    setLoadingLibraryFileName(entry.fileName)
    setLoadingLibraryAction("copy")
    try {
      const script = await window.api.browser.readScriptLibraryScript({
        fileName: entry.fileName
      })
      await navigator.clipboard.writeText(script)
      toast.success("脚本已复制")
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to copy library script ${entry.fileName}: ${formatError(error)}`
      )
      toast.error(formatError(error) || "复制脚本失败")
    } finally {
      setLoadingLibraryFileName(null)
      setLoadingLibraryAction(null)
    }
  }, [])

  const copyLibraryExecutionPrompt = useCallback(async (entry: BrowserScriptLibraryEntry) => {
    setLoadingLibraryFileName(entry.fileName)
    setLoadingLibraryAction("execution")
    try {
      const script = await window.api.browser.readScriptLibraryScript({
        fileName: entry.fileName
      })
      const variableNames = extractAiRecordingVariableNames(script)
      const variableAssignments = variableNames
        .map((variableName) => `${variableName}=用户输入；`)
        .join("")
      const prompt = `${variableAssignments} \n\n读取这个脚本内容~/.cmbcoworkagent/browser/${entry.fileName}，分析里面的操作步骤，然后使用内置浏览器来执行里面的操作，禁止使用screenshot和runcode。`
      await navigator.clipboard.writeText(prompt)
      toast.success("已复制，会话输入框里粘贴使用")
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to copy browser execution prompt ${entry.fileName}: ${formatError(error)}`
      )
      toast.error("复制执行指令失败")
    } finally {
      setLoadingLibraryFileName(null)
      setLoadingLibraryAction(null)
    }
  }, [])

  const deleteLibraryEntry = useCallback(async (entry: BrowserScriptLibraryEntry) => {
    setLoadingLibraryFileName(entry.fileName)
    setLoadingLibraryAction("delete")
    try {
      await window.api.browser.deleteScriptLibraryEntry({ fileName: entry.fileName })
      setScriptLibraryEntries((current) =>
        current.filter((item) => item.fileName !== entry.fileName)
      )
      toast.success("脚本文件及映射已删除")
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to delete library script ${entry.fileName}: ${formatError(error)}`
      )
      toast.error(formatError(error) || "删除脚本失败")
    } finally {
      setLoadingLibraryFileName(null)
      setLoadingLibraryAction(null)
    }
  }, [])

  const toggleActionSelection = useCallback(
    (actionId: string) => {
      setSelectedActionIds((current) => {
        const currentSet = new Set(current)
        if (currentSet.has(actionId)) {
          currentSet.delete(actionId)
        } else {
          currentSet.add(actionId)
        }

        const nextSelectedActionIds = aiRecording.actions
          .map((action) => action.id)
          .filter((id) => currentSet.has(id))
        const nextVariableActionIds = variableActionIds.filter((id) => currentSet.has(id))

        if (isDraftScriptDirty) {
          toast.info("已按勾选步骤重新生成脚本草稿，未保存的手动修改已覆盖。")
        }

        setVariableActionIds(nextVariableActionIds)
        setDraftScript(
          buildDraftScript(nextSelectedActionIds, nextVariableActionIds, variableActionNames)
        )
        setIsDraftScriptDirty(false)
        return nextSelectedActionIds
      })
    },
    [
      aiRecording.actions,
      buildDraftScript,
      isDraftScriptDirty,
      variableActionIds,
      variableActionNames
    ]
  )

  const toggleActionVariable = useCallback(
    (actionId: string) => {
      setVariableActionIds((current) => {
        const currentSet = new Set(current)
        if (currentSet.has(actionId)) {
          currentSet.delete(actionId)
        } else {
          currentSet.add(actionId)
        }

        const nextVariableActionIds = aiRecording.actions
          .map((action) => action.id)
          .filter((id) => selectedActionIds.includes(id) && currentSet.has(id))
        if (isDraftScriptDirty) {
          toast.info("已按变量标记重新生成脚本草稿，未保存的手动修改已覆盖。")
        }

        setDraftScript(
          buildDraftScript(selectedActionIds, nextVariableActionIds, variableActionNames)
        )
        setIsDraftScriptDirty(false)
        return nextVariableActionIds
      })
    },
    [
      aiRecording.actions,
      buildDraftScript,
      isDraftScriptDirty,
      selectedActionIds,
      variableActionNames
    ]
  )

  const updateActionVariableName = useCallback(
    (actionId: string, value: string) => {
      setVariableActionNames((current) => {
        const nextVariableActionNames = {
          ...current,
          [actionId]: value
        }

        if (isDraftScriptDirty) {
          toast.info("已按变量名重新生成脚本草稿，未保存的手动修改已覆盖。")
        }

        setDraftScript(
          buildDraftScript(selectedActionIds, variableActionIds, nextVariableActionNames)
        )
        setIsDraftScriptDirty(false)
        return nextVariableActionNames
      })
    },
    [buildDraftScript, isDraftScriptDirty, selectedActionIds, variableActionIds]
  )

  const aiRecordingActionCount = aiRecording.actions.length
  const aiRecordingScriptReady = draftScript.trim().length > 0
  const aiRecordingHasOutput =
    aiRecording.status === "recording" || aiRecordingActionCount > 0 || aiRecordingScriptReady
  const showAiRecordingResultButton =
    aiRecording.status === "completed" && aiRecordingHasOutput && hasPendingUnsavedAiRecording
  const aiRecordingStatusText =
    aiRecording.status === "recording"
      ? `录制进行中，已捕获 ${aiRecordingActionCount} 步`
      : aiRecordingActionCount > 0
        ? `最近一次录制生成了 ${aiRecordingActionCount} 步`
        : "可开始 AI 录制"

  const mainButtonDisabled = isAiRecordingBusy || !browserCreated
  const mainButtonDisabledReason = useMemo(() => {
    if (isAiRecordingBusy) return "正在处理中，请稍候"
    if (!browserCreated) return "浏览器尚未就绪，请等待页面加载完成"
    return null
  }, [isAiRecordingBusy, browserCreated])
  const mainButtonIsRecording = aiRecording.status === "recording"
  const mainButtonLabel = isAiRecordingBusy
    ? "处理中..."
    : mainButtonIsRecording
      ? "停止录制"
      : "开始录制"
  const mainButtonVariant = mainButtonIsRecording ? "warning" : "info"
  const aiRecordingStatusDotClassName = mainButtonIsRecording
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
          <span className="truncate text-[11px] text-muted-foreground">
            {aiRecordingStatusText}
          </span>
        </div>

        {showAiRecordingResultButton ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setAiRecordingDialogOpen(true)}
          >
            <FileCode2 className="size-3.5" strokeWidth={1.8} />
            查看
            {aiRecordingActionCount > 0 ? (
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {aiRecordingActionCount}
              </span>
            ) : null}
          </Button>
        ) : null}

        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
          disabled={!hasWorkspace}
          onClick={openScriptLibrary}
        >
          <FolderOpen className="size-3.5" strokeWidth={1.8} />
          录制列表
        </Button>

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
            {mainButtonDisabledReason ? (
              <TooltipContent side="top">
                <p>{mainButtonDisabledReason}</p>
              </TooltipContent>
            ) : null}
          </Tooltip>
        </TooltipProvider>
      </div>

      <BrowserAiRecordingResultDialog
        open={aiRecordingDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            resetSaveForm()
          }
          setAiRecordingDialogOpen(open)
        }}
        aiRecording={aiRecording}
        selectedActionIds={selectedActionIds}
        onToggleActionSelection={(actionId) => toggleActionSelection(actionId)}
        variableActionIds={variableActionIds}
        onToggleActionVariable={(actionId) => toggleActionVariable(actionId)}
        variableActionNames={variableActionNames}
        onVariableActionNameChange={(actionId, value) => updateActionVariableName(actionId, value)}
        draftScript={draftScript}
        onDraftScriptChange={(value) => {
          setDraftScript(value)
          setIsDraftScriptDirty(true)
        }}
        saveDisplayName={saveDisplayName}
        onSaveDisplayNameChange={setSaveDisplayName}
        isSaveSubmitting={isSaveSubmitting}
        hasWorkspace={hasWorkspace}
        hasUnnamedVariableActions={hasUnnamedVariableActions}
        onConfirmSave={() => void confirmSaveToLibrary()}
      />

      <BrowserRecordingListDialog
        open={scriptLibraryOpen}
        onOpenChange={setScriptLibraryOpen}
        hasWorkspace={hasWorkspace}
        isLoading={isScriptLibraryLoading}
        error={scriptLibraryError}
        entries={scriptLibraryEntries}
        currentThreadId={threadId}
        loadingFileName={loadingLibraryFileName}
        loadingAction={loadingLibraryAction}
        onRefresh={() => void loadScriptLibraryEntries()}
        onCopyScript={(entry) => void copyLibraryScript(entry)}
        onCopyExecution={(entry) => void copyLibraryExecutionPrompt(entry)}
        onDelete={(entry) => void deleteLibraryEntry(entry)}
      />
    </>
  )
}
