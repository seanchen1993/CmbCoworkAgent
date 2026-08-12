import { useCallback, useEffect, useMemo, useState } from "react"
import { flushSync } from "react-dom"
import { toast } from "sonner"
import {
  extractScriptRecordingVariables,
  generateScriptRecording,
  type ScriptRecordingVariable
} from "../../../../shared/browser-script-recording"
import type {
  BrowserRecordingSession,
  BrowserScriptExecutionState,
  BrowserScriptLibraryEntry
} from "../../../../shared/browser-types"
import { BrowserScriptRecordingControl } from "./BrowserScriptRecordingControl"
import { BrowserPlaybackControl } from "./BrowserPlaybackControl"
import {
  getRecordingLabel,
  getRecordingStatusDotClassName,
  getRecordingStatusText,
  isRecordingSessionActive
} from "./BrowserScriptRecordingControl.utils"
import { BrowserScriptRecordingResultDialog } from "./BrowserScriptRecordingResultDialog"
import {
  BrowserRecordingListDialog,
  type BrowserRecordingListDialogProps
} from "./BrowserRecordingListDialog"
import { BrowserScriptVariableDialog } from "./BrowserScriptVariableDialog"

interface BrowserScriptRecordingControlsProps {
  browserCreated: boolean
  currentUrl?: string | null
  threadId?: string | null
  workspacePath?: string | null
}

const RECORDING_POLL_MS = 800
const EMPTY_SCRIPT_RECORDING: BrowserRecordingSession = {
  source: "script",
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

export function BrowserScriptRecordingControls({
  browserCreated,
  currentUrl,
  threadId,
  workspacePath
}: BrowserScriptRecordingControlsProps): React.JSX.Element {
  const [scriptRecording, setScriptRecording] =
    useState<BrowserRecordingSession>(EMPTY_SCRIPT_RECORDING)
  const [hasPendingUnsaved, setHasPendingUnsaved] = useState(false)
  const [draftScript, setDraftScript] = useState("")
  const [isDraftScriptDirty, setIsDraftScriptDirty] = useState(false)
  const [isRecordingEdited, setIsRecordingEdited] = useState(false)
  const [selectedActionIds, setSelectedActionIds] = useState<string[]>([])
  const [variableActionIds, setVariableActionIds] = useState<string[]>([])
  const [variableActionNames, setVariableActionNames] = useState<Record<string, string>>({})
  const [selectionSyncKey, setSelectionSyncKey] = useState("")
  const [isBusy, setIsBusy] = useState(false)
  const [recordingDialogOpen, setRecordingDialogOpen] = useState(false)
  const [isDraftSaveSubmitting, setIsDraftSaveSubmitting] = useState(false)
  const [isSaveSubmitting, setIsSaveSubmitting] = useState(false)
  const [isExecuteSubmitting, setIsExecuteSubmitting] = useState(false)
  const [isCancellingPlayback, setIsCancellingPlayback] = useState(false)
  const [scriptVariableDialogOpen, setScriptVariableDialogOpen] = useState(false)
  const [scriptVariables, setScriptVariables] = useState<ScriptRecordingVariable[]>([])
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
  const scriptSessionIsActive = isRecordingSessionActive(scriptRecording)

  const resetSaveForm = useCallback(() => {
    setSaveDisplayName("")
  }, [])

  const syncRecordingEditorState = useCallback((session: BrowserRecordingSession) => {
    const nextSelectionSyncKey = [
      session.id ?? "idle",
      session.status,
      session.actions.length,
      session.stoppedAt ?? session.startedAt ?? ""
    ].join(":")

    setSelectedActionIds(session.actions.map((action) => action.id))
    setVariableActionIds(session.variableActionIds ?? [])
    setVariableActionNames(session.variableActionNames ?? {})
    setDraftScript(session.script)
    setIsDraftScriptDirty(false)
    setSelectionSyncKey(nextSelectionSyncKey)
  }, [])

  const buildDraftScript = useCallback(
    (
      nextSelectedActionIds: string[],
      nextVariableActionIds: string[],
      nextVariableActionNames: Record<string, string>
    ): string => {
      const nextActions = scriptRecording.actions.filter((action) =>
        nextSelectedActionIds.includes(action.id)
      )
      const namedVariableActionIds = nextVariableActionIds.filter((actionId) =>
        nextVariableActionNames[actionId]?.trim()
      )

      return generateScriptRecording(nextActions, {
        source: "script",
        variableActionIds: namedVariableActionIds,
        variableActionNames: nextVariableActionNames
      })
    },
    [scriptRecording.actions]
  )

  const refreshScriptRecording = useCallback(async () => {
    try {
      const nextSession = await window.api.browser.getScriptRecording()
      setScriptRecording(nextSession)
    } catch (error) {
      console.error(
        `[BrowserScriptRecordingControls] Failed to refresh script recording: ${formatError(error)}`
      )
    }
  }, [])

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

  useEffect(() => {
    void refreshScriptRecording()
  }, [refreshScriptRecording])

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
          `[BrowserScriptRecordingControls] Failed to load playback state: ${formatError(error)}`
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
    if (scriptRecording.status !== "recording") return
    const interval = window.setInterval(() => {
      void refreshScriptRecording()
    }, RECORDING_POLL_MS)
    return () => {
      window.clearInterval(interval)
    }
  }, [scriptRecording.status, refreshScriptRecording])

  useEffect(() => {
    const nextSelectionSyncKey = [
      scriptRecording.id ?? "idle",
      scriptRecording.status,
      scriptRecording.actions.length,
      scriptRecording.stoppedAt ?? scriptRecording.startedAt ?? ""
    ].join(":")

    if (selectionSyncKey === nextSelectionSyncKey) return

    const nextSelectedActionIds = scriptRecording.actions.map((action) => action.id)
    const nextVariableActionIds = scriptRecording.variableActionIds ?? []
    const nextVariableActionNames = scriptRecording.variableActionNames ?? {}
    setSelectedActionIds(nextSelectedActionIds)
    setVariableActionIds(nextVariableActionIds)
    setVariableActionNames(nextVariableActionNames)
    setDraftScript(
      scriptRecording.script ||
        generateScriptRecording(scriptRecording.actions, {
          source: "script",
          variableActionIds: nextVariableActionIds,
          variableActionNames: nextVariableActionNames
        })
    )
    setIsDraftScriptDirty(false)
    setSelectionSyncKey(nextSelectionSyncKey)
  }, [scriptRecording, selectionSyncKey])

  const openRecordingDialog = useCallback(() => {
    setRecordingDialogOpen(true)
  }, [])

  const persistRecordingDraft = useCallback(
    async (options?: { silent?: boolean }): Promise<BrowserRecordingSession> => {
      if (!draftScript.trim()) {
        throw new Error("当前没有可保存的脚本内容")
      }

      setIsDraftSaveSubmitting(true)
      try {
        const nextSession = await window.api.browser.updateScriptRecordingDraft({
          script: draftScript
        })
        setScriptRecording(nextSession)
        syncRecordingEditorState(nextSession)

        if (!options?.silent) {
          toast.success("草稿已保存，继续录制时会沿用当前内容。")
        }
        return nextSession
      } catch (error) {
        console.error(
          `[BrowserScriptRecordingControls] Failed to save script recording draft: ${formatError(error)}`
        )
        toast.error(formatError(error) || "保存草稿失败")
        throw error
      } finally {
        setIsDraftSaveSubmitting(false)
      }
    },
    [draftScript, syncRecordingEditorState]
  )

  const persistActiveDraftIfNeeded = useCallback(async (): Promise<boolean> => {
    if (!isDraftScriptDirty) return true
    try {
      await persistRecordingDraft({ silent: true })
      return true
    } catch {
      return false
    }
  }, [isDraftScriptDirty, persistRecordingDraft])

  const startScriptRecordingSession = useCallback(async () => {
    setIsBusy(true)
    try {
      const nextSession = await window.api.browser.startScriptRecording({
        currentUrl: currentUrl ?? undefined,
        threadId: threadId ?? undefined
      })
      setScriptRecording(nextSession)
      setIsRecordingEdited(false)
      setHasPendingUnsaved(false)
      toast.success("录制脚本已开始。请直接在内置浏览器里直接操作页面。")
    } catch (error) {
      console.error(
        `[BrowserScriptRecordingControls] Failed to start script recording: ${formatError(error)}`
      )
      toast.error(formatError(error) || "启动录制脚本失败")
    } finally {
      setIsBusy(false)
    }
  }, [currentUrl, threadId])

  const pauseScriptRecordingSession = useCallback(async () => {
    setIsBusy(true)
    try {
      const nextSession = await window.api.browser.pauseScriptRecording()
      setScriptRecording(nextSession)
      setRecordingDialogOpen(true)
      toast.success("录制脚本已暂停")
    } catch (error) {
      console.error(
        `[BrowserScriptRecordingControls] Failed to pause script recording: ${formatError(error)}`
      )
      toast.error(formatError(error) || "暂停录制脚本失败")
    } finally {
      setIsBusy(false)
    }
  }, [])

  const resumeScriptRecordingSession = useCallback(async () => {
    setIsBusy(true)
    try {
      if (!(await persistActiveDraftIfNeeded())) return
      const nextSession = await window.api.browser.resumeScriptRecording()
      setScriptRecording(nextSession)
      toast.success("录制脚本已继续")
    } catch (error) {
      console.error(
        `[BrowserScriptRecordingControls] Failed to resume script recording: ${formatError(error)}`
      )
      toast.error(formatError(error) || "继续录制脚本失败")
    } finally {
      setIsBusy(false)
    }
  }, [persistActiveDraftIfNeeded])

  const stopScriptRecordingSession = useCallback(async () => {
    setIsBusy(true)
    try {
      if (!(await persistActiveDraftIfNeeded())) return
      const nextSession = await window.api.browser.stopScriptRecording()
      setScriptRecording(nextSession)
      setHasPendingUnsaved(true)
      setRecordingDialogOpen(true)
      if (nextSession.actions.length > 0) {
        toast.success(`录制脚本已停止，已生成 ${nextSession.actions.length} 个步骤。`)
      } else {
        toast.warning("录制脚本已停止，但还没有采集到可生成脚本的页面操作。")
      }
    } catch (error) {
      console.error(
        `[BrowserScriptRecordingControls] Failed to stop script recording: ${formatError(error)}`
      )
      toast.error("停止录制脚本失败")
    } finally {
      setIsBusy(false)
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
        `[BrowserScriptRecordingControls] Failed to load browser script library: ${formatError(error)}`
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
          `[BrowserScriptRecordingControls] Failed to cancel playback: ${formatError(error)}`
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
      scriptRecording.libraryFileName?.trim()
        ? {
            fileName: scriptRecording.libraryFileName.trim(),
            displayName:
              scriptRecording.libraryDisplayName?.trim() || scriptRecording.libraryFileName.trim()
          }
        : null,
    [scriptRecording.libraryDisplayName, scriptRecording.libraryFileName]
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
          script: draftScript,
          isEdited: isRecordingEdited || extractScriptRecordingVariables(draftScript).length > 0
        })
        toast.success(`已保存到原脚本：${currentRecordingLibraryTarget.displayName}`)
      } else {
        await window.api.browser.saveScriptLibraryEntry({
          displayName,
          isEdited: isRecordingEdited || extractScriptRecordingVariables(draftScript).length > 0,
          recordingSource: "script",
          script: draftScript,
          threadId,
          workspacePath: trimmedWorkspacePath
        })
        toast.success("脚本已保存")
      }
      setHasPendingUnsaved(false)
      setRecordingDialogOpen(false)
      resetSaveForm()
      if (trimmedWorkspacePath) {
        void loadScriptLibraryEntries()
      }
      if (!currentRecordingLibraryTarget) {
        setScriptLibraryOpen(true)
      }
    } catch (error) {
      console.error(
        `[BrowserScriptRecordingControls] Failed to save browser script library entry: ${formatError(error)}`
      )
      toast.error(formatError(error) || "保存脚本失败")
    } finally {
      setIsSaveSubmitting(false)
    }
  }, [
    currentRecordingLibraryTarget,
    draftScript,
    hasUnnamedVariableActions,
    isRecordingEdited,
    loadScriptLibraryEntries,
    resetSaveForm,
    saveDisplayName,
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
        `[BrowserScriptRecordingControls] Failed to read library script ${entry.fileName}: ${formatError(error)}`
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
      setRecordingDialogOpen(false)
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
          `[BrowserScriptRecordingControls] Failed to execute browser script: ${formatError(error)}`
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
      const variables = extractScriptRecordingVariables(script)
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
        `[BrowserScriptRecordingControls] Failed to delete library script ${entry.fileName}: ${formatError(error)}`
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
          displayName,
          isEdited: true
        })
        setScriptLibraryEntries((current) =>
          current.map((item) =>
            item.fileName === entry.fileName
              ? {
                  ...item,
                  displayName,
                  isEdited: true,
                  hasVariables: extractScriptRecordingVariables(script).length > 0
                }
              : item
          )
        )
        toast.success("脚本内容和文件中文名已保存")
      } catch (error) {
        console.error(
          `[BrowserScriptRecordingControls] Failed to update library script ${entry.fileName}: ${formatError(error)}`
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
          isEdited: true,
          recordingSource: "script",
          script,
          threadId: threadId ?? entry.threadId ?? undefined,
          workspacePath: workspacePath ?? entry.workspacePath
        })
        const savedEntryWithVariableState = {
          ...savedEntry,
          isEdited: true,
          hasVariables: extractScriptRecordingVariables(script).length > 0
        }
        setScriptLibraryEntries((current) => [savedEntryWithVariableState, ...current])
        toast.success(`已另存为：${savedEntry.displayName}`)
        return savedEntryWithVariableState
      } catch (error) {
        console.error(
          `[BrowserScriptRecordingControls] Failed to save library script as a new file: ${formatError(error)}`
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
      if (scriptSessionIsActive) {
        toast.error("已有录制会话正在进行，请先终止当前录制")
        return
      }

      setLoadingLibraryFileName(entry.fileName)
      setLoadingLibraryAction("continue")
      setIsBusy(true)
      try {
        const nextSession = await window.api.browser.startScriptRecording({
          threadId: threadId ?? undefined,
          seedScript: script,
          libraryFileName: entry.fileName,
          libraryDisplayName: entry.displayName
        })
        setScriptRecording(nextSession)
        setIsRecordingEdited(false)
        setHasPendingUnsaved(false)
        setScriptLibraryOpen(false)
        setRecordingDialogOpen(false)
        toast.success(`${getRecordingLabel("script")}已从当前脚本继续`)
      } catch (error) {
        console.error(
          `[BrowserScriptRecordingControls] Failed to continue library script ${entry.fileName}: ${formatError(error)}`
        )
        toast.error(formatError(error) || "继续录制失败")
        throw error
      } finally {
        setIsBusy(false)
        setLoadingLibraryFileName(null)
        setLoadingLibraryAction(null)
      }
    },
    [scriptSessionIsActive, threadId]
  )

  const markRecordingEdited = useCallback(() => {
    setIsRecordingEdited(true)
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

        const nextSelectedActionIds = scriptRecording.actions
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
        markRecordingEdited()
        setIsDraftScriptDirty(false)
        return nextSelectedActionIds
      })
    },
    [
      buildDraftScript,
      isDraftScriptDirty,
      scriptRecording.actions,
      markRecordingEdited,
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

        const nextVariableActionIds = scriptRecording.actions
          .map((action) => action.id)
          .filter((id) => selectedActionIds.includes(id) && currentSet.has(id))
        if (isDraftScriptDirty) {
          toast.info("已按变量标记重新生成脚本草稿，未保存的手动修改已覆盖。")
        }

        setDraftScript(
          buildDraftScript(selectedActionIds, nextVariableActionIds, variableActionNames)
        )
        markRecordingEdited()
        setIsDraftScriptDirty(false)
        return nextVariableActionIds
      })
    },
    [
      buildDraftScript,
      isDraftScriptDirty,
      scriptRecording.actions,
      markRecordingEdited,
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
        markRecordingEdited()
        setIsDraftScriptDirty(false)
        return nextVariableActionNames
      })
    },
    [
      buildDraftScript,
      isDraftScriptDirty,
      markRecordingEdited,
      selectedActionIds,
      variableActionIds
    ]
  )

  const canSaveCurrentDraft = scriptRecording.status === "paused"
  const playbackModeActive = playbackMode.active
  const playbackStatusActive = playbackState.status === "running"
  const recordingStatusText = getRecordingStatusText("script", scriptRecording)
  const recordingStatusDotClassName = getRecordingStatusDotClassName(
    browserCreated,
    scriptRecording
  )
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
          <BrowserScriptRecordingControl
            browserCreated={browserCreated}
            scriptRecording={scriptRecording}
            isBusy={isBusy}
            hasPendingUnsaved={hasPendingUnsaved}
            onOpenRecordingDialog={openRecordingDialog}
            onOpenScriptLibrary={openScriptLibrary}
            onStartScriptRecording={() => void startScriptRecordingSession()}
            onStopScriptRecording={() => void stopScriptRecordingSession()}
            onPauseScriptRecording={() => void pauseScriptRecordingSession()}
            onResumeScriptRecording={() => void resumeScriptRecordingSession()}
          />
        ) : null}
      </div>

      <BrowserScriptRecordingResultDialog
        open={recordingDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            resetSaveForm()
          }
          setRecordingDialogOpen(open)
        }}
        scriptRecording={scriptRecording}
        recordingLabel={getRecordingLabel("script")}
        selectedActionIds={selectedActionIds}
        onToggleActionSelection={(actionId) => toggleActionSelection(actionId)}
        variableActionIds={variableActionIds}
        onToggleActionVariable={(actionId) => toggleActionVariable(actionId)}
        variableActionNames={variableActionNames}
        onVariableActionNameChange={(actionId, value) => updateActionVariableName(actionId, value)}
        draftScript={draftScript}
        onDraftScriptChange={(value) => {
          setDraftScript(value)
          markRecordingEdited()
          setIsDraftScriptDirty(true)
        }}
        isDraftDirty={isDraftScriptDirty}
        canSaveDraft={canSaveCurrentDraft}
        isDraftSaveSubmitting={isDraftSaveSubmitting}
        onSaveDraft={() => void persistRecordingDraft()}
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
        onValueChange={(identifier, value) =>
          setScriptVariableValues((current) => ({
            ...current,
            [identifier]: value
          }))
        }
        onSubmit={() => void submitScriptVariableExecution()}
      />
    </>
  )
}
