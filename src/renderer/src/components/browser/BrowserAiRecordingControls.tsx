import { useCallback, useEffect, useMemo, useState } from "react"
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
  BrowserRecordingSource,
  BrowserScriptLibraryEntry
} from "../../../../shared/browser-types"
import { BrowserAiRecordingResultDialog } from "./BrowserAiRecordingResultDialog"
import { BrowserRecordingListDialog } from "./BrowserRecordingListDialog"

interface BrowserAiRecordingControlsProps {
  browserCreated: boolean
  currentUrl?: string | null
  threadId?: string | null
  workspacePath?: string | null
}

const RECORDING_POLL_MS = 800
const RECORDING_SOURCES: BrowserRecordingSource[] = ["ai", "manual"]
const EMPTY_AI_RECORDING: AiRecordingSession = {
  source: "ai",
  status: "idle",
  actions: [],
  script: ""
}
const EMPTY_MANUAL_RECORDING: AiRecordingSession = {
  source: "manual",
  status: "idle",
  actions: [],
  script: ""
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getRecordingLabel(source: BrowserRecordingSource): string {
  return source === "manual" ? "人工录制" : "AI录制"
}

function getRecordingStatusText(
  source: BrowserRecordingSource,
  session: AiRecordingSession,
  hasOutput: boolean
): string {
  const label = getRecordingLabel(source)
  if (session.status === "recording") {
    return `${label}进行中，已捕获 ${session.actions.length} 步`
  }
  if (session.status === "paused") {
    return `${label}已暂停，当前保留 ${session.actions.length} 步`
  }
  if (hasOutput) {
    return `最近一次${label}生成了 ${session.actions.length} 步`
  }
  return "可开始 AI录制 或 人工录制"
}

function isSessionActive(session: AiRecordingSession): boolean {
  return session.status === "recording" || session.status === "paused"
}

function sessionHasOutput(session: AiRecordingSession): boolean {
  return session.status !== "idle" || session.actions.length > 0 || session.script.trim().length > 0
}

export function BrowserAiRecordingControls({
  browserCreated,
  currentUrl,
  threadId,
  workspacePath
}: BrowserAiRecordingControlsProps): React.JSX.Element {
  const [aiRecording, setAiRecording] = useState<AiRecordingSession>(EMPTY_AI_RECORDING)
  const [manualRecording, setManualRecording] = useState<AiRecordingSession>(EMPTY_MANUAL_RECORDING)
  const [pendingUnsavedBySource, setPendingUnsavedBySource] = useState<
    Record<BrowserRecordingSource, boolean>
  >({
    ai: false,
    manual: false
  })
  const [recordingDialogSource, setRecordingDialogSource] = useState<BrowserRecordingSource>("ai")
  const [draftScript, setDraftScript] = useState("")
  const [isDraftScriptDirty, setIsDraftScriptDirty] = useState(false)
  const [selectedActionIds, setSelectedActionIds] = useState<string[]>([])
  const [variableActionIds, setVariableActionIds] = useState<string[]>([])
  const [variableActionNames, setVariableActionNames] = useState<Record<string, string>>({})
  const [selectionSyncKey, setSelectionSyncKey] = useState("")
  const [busySource, setBusySource] = useState<BrowserRecordingSource | null>(null)
  const [aiRecordingDialogOpen, setAiRecordingDialogOpen] = useState(false)
  const [isDraftSaveSubmitting, setIsDraftSaveSubmitting] = useState(false)
  const [isSaveSubmitting, setIsSaveSubmitting] = useState(false)
  const [saveDisplayName, setSaveDisplayName] = useState("")
  const [scriptLibraryOpen, setScriptLibraryOpen] = useState(false)
  const [scriptLibraryEntries, setScriptLibraryEntries] = useState<BrowserScriptLibraryEntry[]>([])
  const [isScriptLibraryLoading, setIsScriptLibraryLoading] = useState(false)
  const [scriptLibraryError, setScriptLibraryError] = useState<string | null>(null)
  const [loadingLibraryFileName, setLoadingLibraryFileName] = useState<string | null>(null)
  const [loadingLibraryAction, setLoadingLibraryAction] = useState<
    "detail" | "execution" | "save" | "continue" | "delete" | null
  >(null)
  const hasWorkspace = Boolean(workspacePath?.trim())

  const resetSaveForm = useCallback(() => {
    setSaveDisplayName("")
  }, [])

  const currentRecording = recordingDialogSource === "manual" ? manualRecording : aiRecording
  const currentRecordingLabel = getRecordingLabel(recordingDialogSource)
  const aiSessionIsActive = isSessionActive(aiRecording)
  const manualSessionIsActive = isSessionActive(manualRecording)

  const buildDraftScript = useCallback(
    (
      nextSelectedActionIds: string[],
      nextVariableActionIds: string[],
      nextVariableActionNames: Record<string, string>
    ): string => {
      const nextActions = currentRecording.actions.filter((action) =>
        nextSelectedActionIds.includes(action.id)
      )
      const namedVariableActionIds = nextVariableActionIds.filter((actionId) =>
        nextVariableActionNames[actionId]?.trim()
      )

      return generateAiRecordingScript(nextActions, {
        source: recordingDialogSource,
        variableActionIds: namedVariableActionIds,
        variableActionNames: nextVariableActionNames
      })
    },
    [currentRecording.actions, recordingDialogSource]
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

  const refreshManualRecording = useCallback(async () => {
    try {
      const nextSession = await window.api.browser.getManualRecording()
      setManualRecording(nextSession)
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to refresh manual recording: ${formatError(error)}`
      )
    }
  }, [])

  const refreshAllRecordings = useCallback(async () => {
    await Promise.all([refreshAiRecording(), refreshManualRecording()])
  }, [refreshAiRecording, refreshManualRecording])

  const syncRecordingEditorState = useCallback(
    (source: BrowserRecordingSource, session: AiRecordingSession) => {
      const nextSelectionSyncKey = [
        source,
        session.id ?? "idle",
        session.status,
        session.actions.length,
        session.stoppedAt ?? session.startedAt ?? ""
      ].join(":")

      setRecordingDialogSource(source)
      setSelectedActionIds(session.actions.map((action) => action.id))
      setVariableActionIds(session.variableActionIds ?? [])
      setVariableActionNames(session.variableActionNames ?? {})
      setDraftScript(session.script)
      setIsDraftScriptDirty(false)
      setSelectionSyncKey(nextSelectionSyncKey)
    },
    []
  )

  useEffect(() => {
    void refreshAllRecordings()
  }, [refreshAllRecordings])

  useEffect(() => {
    if (aiRecording.status !== "recording" && manualRecording.status !== "recording") return
    const interval = window.setInterval(() => {
      void refreshAllRecordings()
    }, RECORDING_POLL_MS)
    return () => {
      window.clearInterval(interval)
    }
  }, [aiRecording.status, manualRecording.status, refreshAllRecordings])

  useEffect(() => {
    const nextSelectionSyncKey = [
      recordingDialogSource,
      currentRecording.id ?? "idle",
      currentRecording.status,
      currentRecording.actions.length,
      currentRecording.stoppedAt ?? currentRecording.startedAt ?? ""
    ].join(":")

    if (selectionSyncKey === nextSelectionSyncKey) return

    const nextSelectedActionIds = currentRecording.actions.map((action) => action.id)
    const nextVariableActionIds = currentRecording.variableActionIds ?? []
    const nextVariableActionNames = currentRecording.variableActionNames ?? {}
    setSelectedActionIds(nextSelectedActionIds)
    setVariableActionIds(nextVariableActionIds)
    setVariableActionNames(nextVariableActionNames)
    setDraftScript(
      currentRecording.script ||
        generateAiRecordingScript(currentRecording.actions, {
          source: recordingDialogSource,
          variableActionIds: nextVariableActionIds,
          variableActionNames: nextVariableActionNames
        })
    )
    setIsDraftScriptDirty(false)
    setSelectionSyncKey(nextSelectionSyncKey)
  }, [currentRecording, recordingDialogSource, selectionSyncKey])

  const setPendingUnsavedForSource = useCallback(
    (source: BrowserRecordingSource, value: boolean) => {
      setPendingUnsavedBySource((current) => ({
        ...current,
        [source]: value
      }))
    },
    []
  )

  const openRecordingDialog = useCallback((source: BrowserRecordingSource) => {
    setRecordingDialogSource(source)
    setAiRecordingDialogOpen(true)
  }, [])

  const persistRecordingDraft = useCallback(
    async (
      source: BrowserRecordingSource,
      options?: {
        silent?: boolean
      }
    ): Promise<AiRecordingSession> => {
      if (!draftScript.trim()) {
        throw new Error("当前没有可保存的脚本内容")
      }

      setIsDraftSaveSubmitting(true)
      try {
        const nextSession =
          source === "manual"
            ? await window.api.browser.updateManualRecordingDraft({
                script: draftScript
              })
            : await window.api.browser.updateAiRecordingDraft({
                script: draftScript
              })

        if (source === "manual") {
          setManualRecording(nextSession)
        } else {
          setAiRecording(nextSession)
        }
        syncRecordingEditorState(source, nextSession)

        if (!options?.silent) {
          toast.success("草稿已保存，继续录制时会沿用当前内容。")
        }
        return nextSession
      } catch (error) {
        console.error(
          `[BrowserAiRecordingControls] Failed to save ${source} recording draft: ${formatError(error)}`
        )
        toast.error(formatError(error) || "保存草稿失败")
        throw error
      } finally {
        setIsDraftSaveSubmitting(false)
      }
    },
    [draftScript, syncRecordingEditorState]
  )

  const persistActiveDraftIfNeeded = useCallback(
    async (source: BrowserRecordingSource): Promise<boolean> => {
      if (!isDraftScriptDirty || recordingDialogSource !== source) return true
      try {
        await persistRecordingDraft(source, { silent: true })
        return true
      } catch {
        return false
      }
    },
    [isDraftScriptDirty, persistRecordingDraft, recordingDialogSource]
  )

  const startAiRecordingSession = useCallback(async () => {
    if (manualSessionIsActive) {
      toast.error("人工录制正在占用当前会话，请先终止后再开始 AI录制")
      return
    }

    setBusySource("ai")
    try {
      const nextSession = await window.api.browser.startAiRecording({
        threadId: threadId ?? undefined
      })
      setAiRecording(nextSession)
      setRecordingDialogSource("ai")
      setPendingUnsavedForSource("ai", false)
      toast.success("AI录制已开始。让 Agent 在任意会话中操作页面即可。")
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to start AI recording: ${formatError(error)}`
      )
      toast.error(formatError(error) || "启动 AI录制失败")
    } finally {
      setBusySource(null)
    }
  }, [manualSessionIsActive, setPendingUnsavedForSource, threadId])

  const startManualRecordingSession = useCallback(async () => {
    if (aiSessionIsActive) {
      toast.error("AI录制正在占用当前会话，请先终止后再开始人工录制")
      return
    }

    setBusySource("manual")
    try {
      const nextSession = await window.api.browser.startManualRecording({
        currentUrl: currentUrl ?? undefined,
        threadId: threadId ?? undefined
      })
      setManualRecording(nextSession)
      setRecordingDialogSource("manual")
      setPendingUnsavedForSource("manual", false)
      toast.success("人工录制已开始。请直接在内置浏览器里手动操作页面。")
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to start manual recording: ${formatError(error)}`
      )
      toast.error(formatError(error) || "启动人工录制失败")
    } finally {
      setBusySource(null)
    }
  }, [aiSessionIsActive, currentUrl, setPendingUnsavedForSource, threadId])

  const pauseAiRecordingSession = useCallback(async () => {
    setBusySource("ai")
    try {
      const nextSession = await window.api.browser.pauseAiRecording()
      setAiRecording(nextSession)
      setRecordingDialogSource("ai")
      setAiRecordingDialogOpen(true)
      toast.success("AI录制已暂停")
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to pause AI recording: ${formatError(error)}`
      )
      toast.error(formatError(error) || "暂停 AI录制失败")
    } finally {
      setBusySource(null)
    }
  }, [])

  const resumeAiRecordingSession = useCallback(async () => {
    setBusySource("ai")
    try {
      if (!(await persistActiveDraftIfNeeded("ai"))) return
      const nextSession = await window.api.browser.resumeAiRecording()
      setAiRecording(nextSession)
      toast.success("AI录制已继续")
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to resume AI recording: ${formatError(error)}`
      )
      toast.error(formatError(error) || "继续 AI录制失败")
    } finally {
      setBusySource(null)
    }
  }, [persistActiveDraftIfNeeded])

  const stopAiRecordingSession = useCallback(async () => {
    setBusySource("ai")
    try {
      if (!(await persistActiveDraftIfNeeded("ai"))) return
      const nextSession = await window.api.browser.stopAiRecording()
      setAiRecording(nextSession)
      setRecordingDialogSource("ai")
      setPendingUnsavedForSource("ai", true)
      setAiRecordingDialogOpen(true)
      if (nextSession.actions.length > 0) {
        toast.success(`AI录制已停止，已生成 ${nextSession.actions.length} 个步骤。`)
      } else {
        toast.warning("AI录制已停止，但还没有采集到可生成脚本的页面操作。")
      }
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to stop AI recording: ${formatError(error)}`
      )
      toast.error("停止 AI录制失败")
    } finally {
      setBusySource(null)
    }
  }, [persistActiveDraftIfNeeded, setPendingUnsavedForSource])

  const stopManualRecordingSession = useCallback(async () => {
    setBusySource("manual")
    try {
      if (!(await persistActiveDraftIfNeeded("manual"))) return
      const nextSession = await window.api.browser.stopManualRecording()
      setManualRecording(nextSession)
      setRecordingDialogSource("manual")
      setPendingUnsavedForSource("manual", true)
      setAiRecordingDialogOpen(true)
      if (nextSession.actions.length > 0) {
        toast.success(`人工录制已停止，已生成 ${nextSession.actions.length} 个步骤。`)
      } else {
        toast.warning("人工录制已停止，但还没有采集到可生成脚本的页面操作。")
      }
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to stop manual recording: ${formatError(error)}`
      )
      toast.error("停止人工录制失败")
    } finally {
      setBusySource(null)
    }
  }, [persistActiveDraftIfNeeded, setPendingUnsavedForSource])

  const pauseManualRecordingSession = useCallback(async () => {
    setBusySource("manual")
    try {
      const nextSession = await window.api.browser.pauseManualRecording()
      setManualRecording(nextSession)
      setRecordingDialogSource("manual")
      setAiRecordingDialogOpen(true)
      toast.success("人工录制已暂停")
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to pause manual recording: ${formatError(error)}`
      )
      toast.error(formatError(error) || "暂停人工录制失败")
    } finally {
      setBusySource(null)
    }
  }, [])

  const resumeManualRecordingSession = useCallback(async () => {
    setBusySource("manual")
    try {
      if (!(await persistActiveDraftIfNeeded("manual"))) return
      const nextSession = await window.api.browser.resumeManualRecording()
      setManualRecording(nextSession)
      toast.success("人工录制已继续")
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to resume manual recording: ${formatError(error)}`
      )
      toast.error(formatError(error) || "继续人工录制失败")
    } finally {
      setBusySource(null)
    }
  }, [persistActiveDraftIfNeeded])

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

  const currentRecordingLibraryTarget = currentRecording.libraryFileName?.trim()
    ? {
        fileName: currentRecording.libraryFileName.trim(),
        displayName:
          currentRecording.libraryDisplayName?.trim() || currentRecording.libraryFileName.trim()
      }
    : null

  const confirmSaveToLibrary = useCallback(async () => {
    if (!draftScript.trim()) {
      toast.error("当前没有可保存的脚本内容")
      return
    }
    if (hasUnnamedVariableActions) {
      toast.error("请先为已标记为变量的步骤填写变量名")
      return
    }

    const displayName = saveDisplayName.trim()
    const trimmedWorkspacePath = workspacePath?.trim() ?? ""
    if (!currentRecordingLibraryTarget) {
      if (!displayName) {
        toast.error("请输入文件中文名")
        return
      }
      if (!trimmedWorkspacePath) {
        toast.error("当前会话还没有选择工作区")
        return
      }
    }

    setIsSaveSubmitting(true)
    try {
      if (currentRecordingLibraryTarget) {
        await window.api.browser.updateScriptLibraryEntry({
          fileName: currentRecordingLibraryTarget.fileName,
          script: draftScript
        })
        toast.success(`已保存到原脚本：${currentRecordingLibraryTarget.displayName}`)
      } else {
        await window.api.browser.saveScriptLibraryEntry({
          displayName,
          recordingSource: recordingDialogSource,
          script: draftScript,
          threadId,
          workspacePath: trimmedWorkspacePath
        })
        toast.success("脚本已保存")
      }
      setPendingUnsavedForSource(recordingDialogSource, false)
      setAiRecordingDialogOpen(false)
      resetSaveForm()
      if (trimmedWorkspacePath) {
        void loadScriptLibraryEntries()
      }
      if (!currentRecordingLibraryTarget) {
        setScriptLibraryOpen(true)
      }
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
    currentRecordingLibraryTarget,
    recordingDialogSource,
    resetSaveForm,
    saveDisplayName,
    setPendingUnsavedForSource,
    threadId,
    workspacePath
  ])

  const readLibraryScript = useCallback(async (entry: BrowserScriptLibraryEntry) => {
    setLoadingLibraryFileName(entry.fileName)
    setLoadingLibraryAction("detail")
    try {
      return await window.api.browser.readScriptLibraryScript({
        fileName: entry.fileName
      })
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to read library script ${entry.fileName}: ${formatError(error)}`
      )
      toast.error(formatError(error) || "读取脚本失败")
      throw error
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

  const updateLibraryScript = useCallback(
    async (entry: BrowserScriptLibraryEntry, script: string) => {
      setLoadingLibraryFileName(entry.fileName)
      setLoadingLibraryAction("save")
      try {
        await window.api.browser.updateScriptLibraryEntry({
          fileName: entry.fileName,
          script
        })
        toast.success("脚本内容已保存")
      } catch (error) {
        console.error(
          `[BrowserAiRecordingControls] Failed to update library script ${entry.fileName}: ${formatError(error)}`
        )
        toast.error(formatError(error) || "保存脚本失败")
        throw error
      } finally {
        setLoadingLibraryFileName(null)
        setLoadingLibraryAction(null)
      }
    },
    []
  )

  const continueRecordingFromLibrary = useCallback(
    async (entry: BrowserScriptLibraryEntry, script: string) => {
      if (!script.trim()) {
        toast.error("当前脚本内容为空，请先编辑脚本后再继续录制")
        return
      }
      if (aiSessionIsActive || manualSessionIsActive) {
        toast.error("已有录制会话正在进行，请先终止当前录制")
        return
      }

      setLoadingLibraryFileName(entry.fileName)
      setLoadingLibraryAction("continue")
      setBusySource(entry.recordingSource)
      try {
        const nextSession =
          entry.recordingSource === "manual"
            ? await window.api.browser.startManualRecording({
                threadId: threadId ?? undefined,
                seedScript: script,
                libraryFileName: entry.fileName,
                libraryDisplayName: entry.displayName
              })
            : await window.api.browser.startAiRecording({
                threadId: threadId ?? undefined,
                seedScript: script,
                libraryFileName: entry.fileName,
                libraryDisplayName: entry.displayName
              })

        if (entry.recordingSource === "manual") {
          setManualRecording(nextSession)
        } else {
          setAiRecording(nextSession)
        }
        setRecordingDialogSource(entry.recordingSource)
        setPendingUnsavedForSource(entry.recordingSource, false)
        setScriptLibraryOpen(false)
        setAiRecordingDialogOpen(false)
        toast.success(`${getRecordingLabel(entry.recordingSource)}已从当前脚本继续`)
      } catch (error) {
        console.error(
          `[BrowserAiRecordingControls] Failed to continue library script ${entry.fileName}: ${formatError(error)}`
        )
        toast.error(formatError(error) || "继续录制失败")
        throw error
      } finally {
        setBusySource(null)
        setLoadingLibraryFileName(null)
        setLoadingLibraryAction(null)
      }
    },
    [aiSessionIsActive, manualSessionIsActive, setPendingUnsavedForSource, threadId]
  )

  const toggleActionSelection = useCallback(
    (actionId: string) => {
      setSelectedActionIds((current) => {
        const currentSet = new Set(current)
        if (currentSet.has(actionId)) {
          currentSet.delete(actionId)
        } else {
          currentSet.add(actionId)
        }

        const nextSelectedActionIds = currentRecording.actions
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
      buildDraftScript,
      currentRecording.actions,
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

        const nextVariableActionIds = currentRecording.actions
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
      buildDraftScript,
      currentRecording.actions,
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

  const currentRecordingHasOutput = sessionHasOutput(currentRecording)
  const canSaveCurrentDraft = currentRecording.status === "paused"
  const resultSources = RECORDING_SOURCES.filter((source) => {
    const session = source === "manual" ? manualRecording : aiRecording
    return (
      session.status === "completed" && sessionHasOutput(session) && pendingUnsavedBySource[source]
    )
  })

  const activeRecordingSource = aiSessionIsActive ? "ai" : manualSessionIsActive ? "manual" : null
  const statusSource =
    activeRecordingSource ??
    (currentRecordingHasOutput
      ? recordingDialogSource
      : sessionHasOutput(manualRecording)
        ? "manual"
        : "ai")
  const statusSession = statusSource === "manual" ? manualRecording : aiRecording
  const statusHasOutput = sessionHasOutput(statusSession)
  const statusText = getRecordingStatusText(statusSource, statusSession, statusHasOutput)
  const statusDotClassName =
    statusSession.status === "recording"
      ? "bg-status-info animate-tactical-pulse"
      : statusSession.status === "paused"
        ? "bg-status-warning"
        : statusHasOutput
          ? "bg-status-nominal"
          : browserCreated
            ? "bg-primary"
            : "bg-muted-foreground/60"

  const aiButtonDisabledReason = useMemo(() => {
    if (!browserCreated) return "浏览器尚未就绪，请等待页面加载完成"
    if (busySource) return "正在处理中，请稍候"
    if (manualSessionIsActive) {
      return "人工录制进行中，请先终止当前录制"
    }
    return null
  }, [browserCreated, busySource, manualSessionIsActive])
  const manualButtonDisabledReason = useMemo(() => {
    if (!browserCreated) return "浏览器尚未就绪，请等待页面加载完成"
    if (busySource) return "正在处理中，请稍候"
    if (aiSessionIsActive) {
      return "AI录制进行中，请先终止当前录制"
    }
    return null
  }, [aiSessionIsActive, browserCreated, busySource])

  const aiButtonDisabled = aiButtonDisabledReason !== null
  const manualButtonDisabled = manualButtonDisabledReason !== null
  const activeSession =
    activeRecordingSource === "manual"
      ? manualRecording
      : activeRecordingSource === "ai"
        ? aiRecording
        : null
  const activeRecordingIsBusy = activeRecordingSource ? busySource === activeRecordingSource : false

  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5" role="status" aria-live="polite">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <span className={cn("size-2 shrink-0 rounded-full", statusDotClassName)} />
          <span className="truncate text-[11px] text-muted-foreground">{statusText}</span>
        </div>

        {resultSources.map((source) => {
          const session = source === "manual" ? manualRecording : aiRecording
          return (
            <Button
              key={`result-${source}`}
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => openRecordingDialog(source)}
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
          disabled={!hasWorkspace}
          onClick={openScriptLibrary}
        >
          <FolderOpen className="size-3.5" strokeWidth={1.8} />
          列表
        </Button>

        {activeRecordingSource && activeSession ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={activeRecordingIsBusy}
              className="h-8 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => openRecordingDialog(activeRecordingSource)}
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
                void (activeRecordingSource === "manual"
                  ? stopManualRecordingSession()
                  : stopAiRecordingSession())
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
                void (activeRecordingSource === "manual"
                  ? activeSession.status === "paused"
                    ? resumeManualRecordingSession()
                    : pauseManualRecordingSession()
                  : activeSession.status === "paused"
                    ? resumeAiRecordingSession()
                    : pauseAiRecordingSession())
              }
            >
              {activeRecordingIsBusy ? (
                <Loader2 className="size-3 animate-spin" strokeWidth={1.8} />
              ) : activeSession.status === "paused" ? (
                <Play className="size-3 text-green-600" strokeWidth={1.8} />
              ) : (
                <Pause className="size-3" strokeWidth={1.8} />
              )}
              {activeRecordingIsBusy
                ? "处理中..."
                : activeSession.status === "paused"
                  ? "继续"
                  : "暂停"}
            </Button>
          </>
        ) : (
          <>
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  {aiButtonDisabled ? (
                    <span className="inline-flex cursor-not-allowed">
                      <Button
                        type="button"
                        size="sm"
                        variant="info"
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
                      variant="info"
                      className="h-8 rounded-md px-2.5 text-[11px] shadow-none"
                      onClick={() => void startAiRecordingSession()}
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
                  {manualButtonDisabled ? (
                    <span className="inline-flex cursor-not-allowed">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
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
                      variant="secondary"
                      className="h-8 rounded-md px-2.5 text-[11px] shadow-none"
                      onClick={() => void startManualRecordingSession()}
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
      </div>

      <BrowserAiRecordingResultDialog
        open={aiRecordingDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            resetSaveForm()
          }
          setAiRecordingDialogOpen(open)
        }}
        aiRecording={currentRecording}
        recordingSource={recordingDialogSource}
        recordingLabel={currentRecordingLabel}
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
        isDraftDirty={isDraftScriptDirty}
        canSaveDraft={canSaveCurrentDraft}
        isDraftSaveSubmitting={isDraftSaveSubmitting}
        onSaveDraft={() => void persistRecordingDraft(recordingDialogSource)}
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
        onReadScript={readLibraryScript}
        onSaveScript={updateLibraryScript}
        onContinueRecording={continueRecordingFromLibrary}
        onCopyExecution={copyLibraryExecutionPrompt}
        onDelete={deleteLibraryEntry}
      />
    </>
  )
}
