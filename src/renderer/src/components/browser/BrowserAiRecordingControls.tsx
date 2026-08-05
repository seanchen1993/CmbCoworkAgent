import { useCallback, useEffect, useMemo, useState } from "react"
import { flushSync } from "react-dom"
import { toast } from "sonner"
import {
  extractAiRecordingVariables,
  generateAiRecordingScript,
  type AiRecordingScriptVariable
} from "../../../../shared/browser-ai-recording-script"
import type {
  AiRecordingSession,
  BrowserRecordingSource,
  BrowserScriptExecutionState,
  BrowserScriptLibraryEntry
} from "../../../../shared/browser-types"
import { BrowserAiRecordingControl } from "./BrowserAiRecordingControl"
import { BrowserPlaybackControl } from "./BrowserPlaybackControl"
import {
  getRecordingLabel,
  getRecordingStatusDotClassName,
  getRecordingStatusText,
  isRecordingSessionActive
} from "./BrowserAiRecordingControl.utils"
import { BrowserAiRecordingResultDialog } from "./BrowserAiRecordingResultDialog"
import {
  BrowserRecordingListDialog,
  type BrowserRecordingListDialogProps
} from "./BrowserRecordingListDialog"
import { BrowserScriptVariableDialog } from "./BrowserScriptVariableDialog"

interface BrowserAiRecordingControlsProps {
  browserCreated: boolean
  currentUrl?: string | null
  threadId?: string | null
  workspacePath?: string | null
}

const RECORDING_POLL_MS = 800
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
const DEFAULT_PLAYBACK_LABEL = "当前脚本"

interface PendingScriptExecution {
  script: string
  options: {
    label: string
    fileName?: string
    workspacePath?: string | null
  }
}

interface PlaybackModeState {
  active: boolean
  key: number
  label: string
}

const EMPTY_PLAYBACK_MODE_STATE: PlaybackModeState = {
  active: false,
  key: 0,
  label: DEFAULT_PLAYBACK_LABEL
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function waitForBrowserPanelRender(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve())
    })
  })
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
  const [isExecuteSubmitting, setIsExecuteSubmitting] = useState(false)
  const [isCancellingPlayback, setIsCancellingPlayback] = useState(false)
  const [scriptVariableDialogOpen, setScriptVariableDialogOpen] = useState(false)
  const [scriptVariables, setScriptVariables] = useState<AiRecordingScriptVariable[]>([])
  const [scriptVariableValues, setScriptVariableValues] = useState<Record<string, string>>({})
  const [pendingScriptExecution, setPendingScriptExecution] =
    useState<PendingScriptExecution | null>(null)
  const [isVariableSubmissionSubmitting, setIsVariableSubmissionSubmitting] = useState(false)
  const [saveDisplayName, setSaveDisplayName] = useState("")
  const [scriptLibraryOpen, setScriptLibraryOpen] = useState(false)
  const [scriptLibraryEntries, setScriptLibraryEntries] = useState<BrowserScriptLibraryEntry[]>([])
  const [isScriptLibraryLoading, setIsScriptLibraryLoading] = useState(false)
  const [scriptLibraryError, setScriptLibraryError] = useState<string | null>(null)
  const [loadingLibraryFileName, setLoadingLibraryFileName] = useState<string | null>(null)
  const [loadingLibraryAction, setLoadingLibraryAction] =
    useState<BrowserRecordingListDialogProps["loadingAction"]>(null)
  const [playbackState, setPlaybackState] = useState<BrowserScriptExecutionState>({
    status: "idle"
  })
  const [playbackMode, setPlaybackMode] = useState<PlaybackModeState>(EMPTY_PLAYBACK_MODE_STATE)
  const hasWorkspace = Boolean(workspacePath?.trim())

  const resetSaveForm = useCallback(() => {
    setSaveDisplayName("")
  }, [])

  const currentRecording = recordingDialogSource === "manual" ? manualRecording : aiRecording
  const aiSessionIsActive = isRecordingSessionActive(aiRecording)
  const manualSessionIsActive = isRecordingSessionActive(manualRecording)

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

  const openPlaybackMode = useCallback((options: PendingScriptExecution["options"]) => {
    const label = options.label?.trim() || options.fileName?.trim() || DEFAULT_PLAYBACK_LABEL
    setPlaybackMode((current) => ({
      active: true,
      key: current.key + 1,
      label
    }))
  }, [])

  const closePlaybackMode = useCallback(() => {
    setPlaybackMode((current) => ({
      ...current,
      active: false
    }))
  }, [])

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
    let cancelled = false
    void window.api.browser
      .getScriptExecutionState()
      .then((state) => {
        if (cancelled) return
        setPlaybackState(state)
        if (state.status === "running") {
          setPlaybackMode((current) => ({
            active: true,
            key: current.key,
            label: state.label?.trim() || current.label
          }))
        }
      })
      .catch((error) => {
        console.error(
          `[BrowserAiRecordingControls] Failed to load playback state: ${formatError(error)}`
        )
      })

    const unsubscribe = window.api.browser.onScriptExecutionState((state) => {
      setPlaybackState(state)
      setIsCancellingPlayback(false)
      if (state.status === "running") {
        setPlaybackMode((current) => ({
          active: true,
          key: current.key,
          label: state.label?.trim() || current.label
        }))
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

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
    setIsScriptLibraryLoading(true)
    setScriptLibraryError(null)
    try {
      const entries = await window.api.browser.listScriptLibraryEntries()
      setScriptLibraryEntries(entries)
    } catch (error) {
      console.error(
        `[BrowserAiRecordingControls] Failed to load browser script library: ${formatError(error)}`
      )
      setScriptLibraryError(formatError(error) || "读取脚本库失败")
    } finally {
      setIsScriptLibraryLoading(false)
    }
  }, [])

  const openScriptLibrary = useCallback(() => {
    setScriptLibraryOpen(true)
    void loadScriptLibraryEntries()
  }, [loadScriptLibraryEntries])

  const cancelPlayback = useCallback(() => {
    setIsCancellingPlayback(true)
    void window.api.browser
      .cancelRecordingScriptExecution()
      .catch((error) => {
        console.error(
          `[BrowserAiRecordingControls] Failed to cancel playback: ${formatError(error)}`
        )
        toast.error(formatError(error) || "终止回放失败")
      })
      .finally(() => {
        setIsCancellingPlayback(false)
      })
  }, [])

  const hasUnnamedVariableActions = variableActionIds.some(
    (actionId) => !variableActionNames[actionId]?.trim()
  )

  const currentRecordingLibraryTarget = useMemo(
    () =>
      currentRecording.libraryFileName?.trim()
        ? {
            fileName: currentRecording.libraryFileName.trim(),
            displayName:
              currentRecording.libraryDisplayName?.trim() || currentRecording.libraryFileName.trim()
          }
        : null,
    [currentRecording.libraryDisplayName, currentRecording.libraryFileName]
  )

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

  const closeDialogsForBrowserExecution = useCallback(() => {
    flushSync(() => {
      setAiRecordingDialogOpen(false)
      setScriptLibraryOpen(false)
      resetSaveForm()
    })
  }, [resetSaveForm])

  const executeScriptInBuiltinBrowser = useCallback(
    async (
      script: string,
      options: {
        label: string
        fileName?: string
        workspacePath?: string | null
      } = { label: "当前脚本" },
      variableValues?: Record<string, string | string[]>
    ): Promise<void> => {
      if (!script.trim()) {
        toast.error("当前没有可执行的脚本内容")
        return
      }
      if (playbackState.status === "running") {
        toast.error("回放正在执行中，请先终止当前回放")
        return
      }

      setIsExecuteSubmitting(true)
      try {
        // BrowserView sits above renderer dialogs, so restore BrowserPanel before CDP execution.
        closeDialogsForBrowserExecution()
        await waitForBrowserPanelRender()
        await window.api.browser.executeRecordingScript({
          script,
          label: options.label,
          fileName: options.fileName ?? options.label,
          threadId: threadId ?? undefined,
          workspacePath: options.workspacePath ?? workspacePath ?? undefined,
          variableValues
        })
      } catch (error) {
        if (error instanceof Error && error.name === "BrowserScriptExecutionCancelledError") {
          return
        }
        console.error(
          `[BrowserAiRecordingControls] Failed to execute browser script: ${formatError(error)}`
        )
      } finally {
        setIsExecuteSubmitting(false)
      }
    },
    [closeDialogsForBrowserExecution, playbackState.status, threadId, workspacePath]
  )

  const requestScriptExecution = useCallback(
    async (
      script: string,
      options: {
        label: string
        fileName?: string
        workspacePath?: string | null
      } = { label: "当前脚本" }
    ): Promise<void> => {
      if (!script.trim()) {
        toast.error("当前没有可执行的脚本内容")
        return
      }
      if (playbackState.status === "running") {
        toast.error("回放正在执行中，请先终止当前回放")
        return
      }

      openPlaybackMode(options)
      const variables = extractAiRecordingVariables(script)
      if (variables.length === 0) {
        await executeScriptInBuiltinBrowser(script, options)
        return
      }

      setPendingScriptExecution({
        script,
        options
      })
      setScriptVariables(variables)
      setScriptVariableValues(
        Object.fromEntries(variables.map((variable) => [variable.identifier, ""]))
      )
      setScriptVariableDialogOpen(true)
    },
    [executeScriptInBuiltinBrowser, openPlaybackMode, playbackState.status]
  )

  const submitScriptVariableExecution = useCallback(async () => {
    if (!pendingScriptExecution) return

    const variableValues = Object.fromEntries(
      scriptVariables.map((variable) => {
        const rawValue = scriptVariableValues[variable.identifier] ?? ""
        return [
          variable.identifier,
          variable.isArray
            ? rawValue
                .split(/\r?\n/u)
                .map((value) => value.trim())
                .filter(Boolean)
            : rawValue
        ]
      })
    )
    const nextExecution = pendingScriptExecution
    setIsVariableSubmissionSubmitting(true)
    setScriptVariableDialogOpen(false)
    setPendingScriptExecution(null)
    try {
      await executeScriptInBuiltinBrowser(
        nextExecution.script,
        nextExecution.options,
        variableValues
      )
    } finally {
      setIsVariableSubmissionSubmitting(false)
      setScriptVariables([])
      setScriptVariableValues({})
    }
  }, [executeScriptInBuiltinBrowser, pendingScriptExecution, scriptVariableValues, scriptVariables])

  const handleScriptVariableDialogOpenChange = useCallback(
    (open: boolean) => {
      setScriptVariableDialogOpen(open)
      if (!open && !isVariableSubmissionSubmitting) {
        setPendingScriptExecution(null)
        setScriptVariables([])
        setScriptVariableValues({})
      }
    },
    [isVariableSubmissionSubmitting]
  )

  const executeLibraryScript = useCallback(
    async (entry: BrowserScriptLibraryEntry, script: string): Promise<void> => {
      setLoadingLibraryFileName(entry.fileName)
      setLoadingLibraryAction("execution")
      try {
        await requestScriptExecution(script, {
          label: entry.displayName || entry.fileName,
          fileName: entry.fileName,
          workspacePath: entry.workspacePath
        })
      } finally {
        setLoadingLibraryFileName(null)
        setLoadingLibraryAction(null)
      }
    },
    [requestScriptExecution]
  )

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

  const updateLibraryScript: BrowserRecordingListDialogProps["onSaveScript"] = useCallback(
    async (entry: BrowserScriptLibraryEntry, script: string, displayName: string) => {
      setLoadingLibraryFileName(entry.fileName)
      setLoadingLibraryAction("save")
      try {
        await window.api.browser.updateScriptLibraryEntry({
          fileName: entry.fileName,
          script,
          displayName
        })
        setScriptLibraryEntries((current) =>
          current.map((item) =>
            item.fileName === entry.fileName
              ? {
                  ...item,
                  displayName,
                  hasVariables: extractAiRecordingVariables(script).length > 0
                }
              : item
          )
        )
        toast.success("脚本内容和文件中文名已保存")
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

  const saveLibraryScriptAs = useCallback(
    async (
      entry: BrowserScriptLibraryEntry,
      script: string,
      displayName: string
    ): Promise<BrowserScriptLibraryEntry> => {
      setLoadingLibraryFileName(entry.fileName)
      setLoadingLibraryAction("saveAs")
      try {
        const savedEntry = await window.api.browser.saveScriptLibraryEntry({
          description: entry.description,
          displayName,
          recordingSource: entry.recordingSource,
          script,
          threadId: threadId ?? entry.threadId ?? undefined,
          workspacePath: workspacePath ?? entry.workspacePath
        })
        const savedEntryWithVariableState = {
          ...savedEntry,
          hasVariables: extractAiRecordingVariables(script).length > 0
        }
        setScriptLibraryEntries((current) => [savedEntryWithVariableState, ...current])
        toast.success(`已另存为：${savedEntry.displayName}`)
        return savedEntryWithVariableState
      } catch (error) {
        console.error(
          `[BrowserAiRecordingControls] Failed to save library script as a new file: ${formatError(error)}`
        )
        toast.error(formatError(error) || "另存为脚本失败")
        throw error
      } finally {
        setLoadingLibraryFileName(null)
        setLoadingLibraryAction(null)
      }
    },
    [threadId, workspacePath]
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

  const canSaveCurrentDraft = currentRecording.status === "paused"
  const playbackModeActive = playbackMode.active
  const playbackStatusActive = playbackState.status === "running"
  const activeRecordingSource = aiSessionIsActive ? "ai" : manualSessionIsActive ? "manual" : null
  const statusSource = activeRecordingSource ?? recordingDialogSource
  const statusSession = statusSource === "manual" ? manualRecording : aiRecording
  const recordingStatusText = getRecordingStatusText(statusSource, statusSession)
  const recordingStatusDotClassName = getRecordingStatusDotClassName(browserCreated, statusSession)
  const isPlaybackBusy = isExecuteSubmitting || playbackStatusActive || isCancellingPlayback
  const showRecordingControls = !playbackModeActive

  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5" role="status" aria-live="polite">
        <BrowserPlaybackControl
          key={playbackMode.key}
          playbackState={playbackState}
          fallbackStatusText={recordingStatusText}
          fallbackDotClassName={recordingStatusDotClassName}
          playbackModeActive={playbackModeActive}
          playbackLabelOverride={playbackMode.label}
          preferFallbackStatusWhenPlaybackInactive
          isCancellingPlayback={isCancellingPlayback}
          onCancelPlayback={cancelPlayback}
          onExitPlaybackMode={closePlaybackMode}
        />

        {showRecordingControls ? (
          <BrowserAiRecordingControl
            browserCreated={browserCreated}
            aiRecording={aiRecording}
            manualRecording={manualRecording}
            busySource={busySource}
            pendingUnsavedBySource={pendingUnsavedBySource}
            onOpenRecordingDialog={openRecordingDialog}
            onOpenScriptLibrary={openScriptLibrary}
            onStartAiRecording={() => void startAiRecordingSession()}
            onStartManualRecording={() => void startManualRecordingSession()}
            onStopAiRecording={() => void stopAiRecordingSession()}
            onStopManualRecording={() => void stopManualRecordingSession()}
            onPauseAiRecording={() => void pauseAiRecordingSession()}
            onPauseManualRecording={() => void pauseManualRecordingSession()}
            onResumeAiRecording={() => void resumeAiRecordingSession()}
            onResumeManualRecording={() => void resumeManualRecordingSession()}
          />
        ) : null}
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
        recordingLabel={getRecordingLabel(recordingDialogSource)}
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
        isLoading={isScriptLibraryLoading}
        error={scriptLibraryError}
        entries={scriptLibraryEntries}
        loadingFileName={loadingLibraryFileName}
        loadingAction={loadingLibraryAction}
        isPlaybackRunning={isPlaybackBusy}
        onRefresh={() => void loadScriptLibraryEntries()}
        onReadScript={readLibraryScript}
        onSaveScript={updateLibraryScript}
        onSaveAsScript={saveLibraryScriptAs}
        onContinueRecording={continueRecordingFromLibrary}
        onExecuteScript={executeLibraryScript}
        onDelete={deleteLibraryEntry}
      />

      <BrowserScriptVariableDialog
        open={scriptVariableDialogOpen}
        variables={scriptVariables}
        values={scriptVariableValues}
        isSubmitting={isVariableSubmissionSubmitting}
        onOpenChange={handleScriptVariableDialogOpenChange}
        onValueChange={(identifier, value) => {
          setScriptVariableValues((current) => ({
            ...current,
            [identifier]: value
          }))
        }}
        onSubmit={() => void submitScriptVariableExecution()}
      />
    </>
  )
}
