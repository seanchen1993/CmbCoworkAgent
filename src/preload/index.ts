import { contextBridge, ipcRenderer, shell } from "electron"
import { randomUUID } from "node:crypto"
import type { UpdateSourceInfo } from "../main/updater/channel-config"
import {
  isWindowCloseBehavior,
  type CloseToTrayPromptAction,
  type CloseToTrayPromptEvent,
  type WindowCloseBehavior
} from "../shared/close-to-tray"
import type { ChatScrollSettings } from "../shared/chat-scroll"
import type { AgentRuntimeSettings } from "../shared/agent-runtime-limits"
import type {
  Thread,
  Message,
  ModelConfig,
  Provider,
  StreamEvent,
  HITLDecision,
  SkillMetadata,
  McpConnectorConfig,
  McpConnectorUpsert,
  McpImportApplyResult,
  McpImportConfigApplyRequest,
  McpImportConfigRequest,
  McpImportPreviewResult,
  ScheduledTask,
  ScheduledTaskUpsert,
  HeartbeatConfig,
  BuiltinRobotGrantableFeature,
  BuiltinRobotRemoteAccessOverview,
  BuiltinRobotSettings,
  BuiltinRobotStatus,
  LspConfig,
  LspDiagnostic,
  LspLocation,
  LspHoverResult,
  LspSymbol,
  LspCallHierarchyItem,
  LspCallHierarchyIncomingCall,
  LspCallHierarchyOutgoingCall,
  LspStatus,
  PluginHookMetadata,
  PluginDetail,
  PluginMetadata,
  SkillHookMetadata,
  HookCatalogPage,
  HookCatalogPageInput,
  SkillPluginCatalogPage,
  SkillPluginCatalogPageInput,
  HookLoggingConfig,
  AgentAutoCommitSettings,
  AgentAutoCommitWorkspaceCard,
  UserInputRequest,
  UserInputResponse,
  ConfigurePreferredIdeRequest,
  ConfigurePreferredIdeResult,
  IdeSettings,
  OpenIdeRequest,
  PreferredIde,
  ForkableCheckpoint,
  ThreadForkCheckpointForMessageParams,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadMetadataPatch,
  ThreadMessageSearchOptions,
  ThreadMessageSearchPage,
  ThreadSummaryPage,
  ThreadSummaryPageOptions,
  ThreadGroupIdsOptions,
  ThreadGroupIdsResult,
  ThreadDeleteOptions,
  ThreadMessagesPage,
  ThreadMessagesPageOptions,
  ThreadLegacyCheckpointBootstrapResult,
  SubagentTranscriptPage,
  SubagentTranscriptBlobExportResult,
  SubagentTranscriptBlobField
} from "../main/types"
import {
  classifyAgentStreamDelivery,
  resolveAgentStreamRequestChannel
} from "../shared/agent-stream-channel"
import {
  normalizeWorkspaceFilesChangedPayload,
  type WorkspaceFilesChangedPayload
} from "../shared/workspace-files-changed"
import type {
  WorkspaceFileScanOpenResult,
  WorkspaceFileScanPageResult
} from "../shared/workspace-file-scan"
import type {
  WorkspaceFilePreviewCancelRequest,
  WorkspaceFilePreviewOpenMediaRequest,
  WorkspaceFilePreviewOpenMediaResult,
  WorkspaceFilePreviewReadRequest,
  WorkspaceFilePreviewReadResult,
  WorkspaceFilePreviewReleaseRequest
} from "../shared/workspace-file-preview"
import type {
  AttachmentBytesParseRequest,
  AttachmentFileSelectionResult,
  AttachmentGrantParseRequest
} from "../shared/file-attachment"
import type { ParsedAttachment } from "../main/file-parser"
import type { SkillPreviewGrantRequest, SkillPreviewGrantResult } from "../shared/skill-preview"
import type { HookConfig, HookUpsert } from "../main/hooks/types"
import { UserInfoConfig } from "../main/storage"
import type {
  ManagedSavedCodeExecTool,
  SavedCodeExecPreviewPayload,
  SavedCodeExecPreviewResult,
  SavedCodeExecRewritePayload,
  SavedCodeExecRewriteResult,
  SavedCodeExecToolUpdatePayload
} from "../main/ipc/code-exec-tools"
import type {
  HarnessDeployUnitSearchInput,
  HarnessDeployUnitSearchResult,
  HarnessEnterpriseProjectDetailInput,
  HarnessEnterpriseProjectDetailResult,
  HarnessEnterpriseProjectSearchInput,
  HarnessEnterpriseProjectSearchResult,
  HarnessPipelineLabelQueryInput,
  HarnessPipelineLabelQueryResult,
  HarnessPipelineQueryInput,
  HarnessPipelineQueryResult,
  HarnessProjectCreateInput,
  HarnessProjectConstraintSyncResult,
  HarnessKnowledgePreviewResult,
  HarnessProjectReviewInput,
  HarnessProjectReviewResult,
  HarnessFeatureCreateInput,
  HarnessFeatureCreateResult,
  HarnessFeatureDeployUnitBinding,
  HarnessFeatureDeployUnitUpdateInput,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadata,
  HarnessProjectMetadataUpdateInput,
  HarnessRunDetailViewModel,
  HarnessRunArtifactGrantRefreshInput,
  HarnessRunArtifactGrantRefreshResult,
  HarnessRunArtifactRevealInput,
  HarnessRunArtifactRevealResult,
  HarnessDeployUnitMapping,
  HarnessLeanTokenConfig,
  HarnessSkipNodeInput,
  HarnessSkipNodeResult,
  HarnessAdapterRegistryItem,
  HarnessDynamicWorkflowConfig,
  HarnessWatchRefChangedEvent
} from "../shared/harness-board-types"
import type { ProjectMetricFilters, ProjectMetricListOptions } from "../shared/project-metrics"
import type {
  HarnessBoardCatalogPageInput,
  HarnessBoardCatalogPageResult
} from "../shared/harness-board-types"
import type {
  FeatureGateCheckOptions,
  FeatureGateCheckResult,
  FeatureGateKey
} from "../shared/feature-gates"
import type {
  TaskMmdCompileModelInfo,
  TaskMmdSettings,
  TaskMmdSnapshot
} from "../main/agent/task-mmd/types"
import type { GitCommitHistoryRecord } from "../shared/git-commit-history"
import type {
  WorkflowWorktreeAction,
  WorkflowWorktreeActionResponse
} from "../main/ipc/workflow-worktree-payload"
import type { TaskCardsListResult, TaskCardsQuery } from "../shared/task-card-types"
import { BROWSER_PANEL_REQUEST_CHANNEL, BROWSER_SESSION_ID } from "../shared/browser-types"
import type {
  BrowserRecordingSession,
  BrowserAttachOptions,
  BrowserBounds,
  BrowserCdpConfig,
  BrowserScriptLibraryDeleteInput,
  BrowserNavigateOptions,
  BrowserPanelRequest,
  BrowserProfileImportOptions,
  BrowserProfileImportResult,
  BrowserScriptExecutionInput,
  BrowserScriptExecutionState,
  BrowserScreenshotResult,
  ScriptRecordingStartOptions,
  BrowserScriptLibraryEntry,
  BrowserScriptLibraryListOptions,
  BrowserScriptLibraryReadInput,
  BrowserRecordingDraftUpdateInput,
  BrowserScriptLibrarySaveInput,
  BrowserScriptLibraryUpdateInput,
  BrowserState
} from "../shared/browser-types"
import { BROWSER_SCRIPT_EXECUTION_STATE_CHANNEL } from "../shared/browser-types"
import type { ExpertAgentEntry } from "../shared/expert-agent-types"
import {
  APP_ATTENTION_CHANNEL,
  getAgentStreamAttentionKind,
  type AppAttentionKind
} from "../shared/app-attention"

interface LspDownloadProgress {
  percent: number
  transferred: number
  total: number
}

interface LspDownloadState {
  isDownloading: boolean
  progress: LspDownloadProgress | null
}

interface PetManifest {
  // 宠物资源清单，来自 pets/<directoryId>/pet.json。
  id: string
  directoryId: string
  source: "builtin" | "custom"
  key: string
  canDelete: boolean
  name?: string
  displayName?: string
  description?: string
  spritesheetPath: string
  frameWidth?: number
  frameHeight?: number
  columns?: number
  rows?: number
  states?: Record<string, { y: number; frames: number; fps?: number }>
}

interface PetSettings {
  enabled: boolean
  selectedPetKey: string | null
}

type PetState =
  // 与主进程 PetState 保持一致，renderer 只能通过 preload 发送这些状态。
  | "idle"
  | "busy"
  | "waiting"
  | "done"
  | "error"
  | "crying"
  | "prompt"
  | "running"
  | "interaction"
  | "hover"

const CLOSE_TO_TRAY_PROMPT_CHANNEL = "app:close-to-tray-prompt"
const CLOSE_TO_TRAY_PROMPT_RESPONSE_CHANNEL = "app:close-to-tray-prompt-response"
const WINDOW_CLOSE_BEHAVIOR_GET_CHANNEL = "app:get-window-close-behavior"
const WINDOW_CLOSE_BEHAVIOR_SET_CHANNEL = "app:set-window-close-behavior"
const WINDOW_CLOSE_BEHAVIOR_CHANGED_CHANNEL = "app:window-close-behavior-changed"
const CHAT_SCROLL_SETTINGS_GET_CHANNEL = "app:get-chat-scroll-settings"
const CHAT_SCROLL_SETTINGS_SET_CHANNEL = "app:set-chat-scroll-settings"
const CHAT_SCROLL_SETTINGS_CHANGED_CHANNEL = "app:chat-scroll-settings-changed"
const AGENT_RUNTIME_SETTINGS_GET_CHANNEL = "app:get-agent-runtime-settings"
const AGENT_RUNTIME_RECURSION_LIMIT_SET_CHANNEL = "app:set-agent-runtime-recursion-limit"
const WORKFLOW_WORKTREE_TIMEOUT_SET_CHANNEL = "app:set-workflow-worktree-timeout"
const WORKFLOW_WORKTREE_REMOVE_TIMEOUT_SET_CHANNEL = "app:set-workflow-worktree-remove-timeout"
const PET_SETTINGS_CHANGED_CHANNEL = "pet:settingsChanged"

function notifyAppAttention(kind: AppAttentionKind, threadId?: string): void {
  ipcRenderer.send(APP_ATTENTION_CHANNEL, { kind, threadId })
}

const CANCELLED_AGENT_ATTENTION_TTL_MS = 30_000
const cancelledAgentAttentionThreads = new Map<string, number>()

function notifyForAgentStreamEvent(event: unknown, threadId?: string): void {
  const kind = getAgentStreamAttentionKind(event)
  if (!kind) return
  if (threadId) {
    const cancelledAt = cancelledAgentAttentionThreads.get(threadId)
    if (cancelledAt !== undefined) {
      cancelledAgentAttentionThreads.delete(threadId)
      if (Date.now() - cancelledAt <= CANCELLED_AGENT_ATTENTION_TTL_MS) return
    }
  }
  notifyAppAttention(kind, threadId)
}

// Simple electron API - replaces @electron-toolkit/preload
const electronAPI = {
  openExternal: (url: string) => shell.openExternal(url),
  openManagedLink: (id: "skillEvalDoc" | "knowledgeGuide") =>
    ipcRenderer.invoke("managed-links:open", id) as Promise<void>,
  openLoginWindow: () => ipcRenderer.invoke("open-login-window"),
  closeLoginWindow: () => ipcRenderer.invoke("close-login-window"),
  openLoginPage: () => ipcRenderer.invoke("open-login-page"),
  closeLoginPage: () => ipcRenderer.invoke("close-login-page"),
  onCloseToTrayPrompt: (callback: (request: CloseToTrayPromptEvent) => void) => {
    const handler = (_event: unknown, payload: CloseToTrayPromptEvent): void => {
      callback(payload)
    }
    ipcRenderer.on(CLOSE_TO_TRAY_PROMPT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(CLOSE_TO_TRAY_PROMPT_CHANNEL, handler)
  },
  respondCloseToTrayPrompt: (
    requestId: number,
    action: CloseToTrayPromptAction,
    rememberChoice = false
  ): void => {
    ipcRenderer.send(CLOSE_TO_TRAY_PROMPT_RESPONSE_CHANNEL, {
      requestId,
      action,
      rememberChoice
    })
  },
  getWindowCloseBehavior: (): Promise<WindowCloseBehavior> =>
    ipcRenderer.invoke(WINDOW_CLOSE_BEHAVIOR_GET_CHANNEL) as Promise<WindowCloseBehavior>,
  setWindowCloseBehavior: (behavior: WindowCloseBehavior): Promise<WindowCloseBehavior> =>
    ipcRenderer.invoke(WINDOW_CLOSE_BEHAVIOR_SET_CHANNEL, behavior) as Promise<WindowCloseBehavior>,
  onWindowCloseBehaviorChanged: (callback: (behavior: WindowCloseBehavior) => void) => {
    const handler = (_event: unknown, behavior: unknown): void => {
      if (isWindowCloseBehavior(behavior)) callback(behavior)
    }
    ipcRenderer.on(WINDOW_CLOSE_BEHAVIOR_CHANGED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(WINDOW_CLOSE_BEHAVIOR_CHANGED_CHANNEL, handler)
  },
  getChatScrollSettings: (): Promise<ChatScrollSettings> =>
    ipcRenderer.invoke(CHAT_SCROLL_SETTINGS_GET_CHANNEL) as Promise<ChatScrollSettings>,
  setChatScrollSettings: (settings: Partial<ChatScrollSettings>): Promise<ChatScrollSettings> =>
    ipcRenderer.invoke(CHAT_SCROLL_SETTINGS_SET_CHANNEL, settings) as Promise<ChatScrollSettings>,
  onChatScrollSettingsChanged: (callback: (settings: ChatScrollSettings) => void) => {
    const handler = (_event: unknown, settings: unknown): void => {
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) return
      callback(settings as ChatScrollSettings)
    }
    ipcRenderer.on(CHAT_SCROLL_SETTINGS_CHANGED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(CHAT_SCROLL_SETTINGS_CHANGED_CHANNEL, handler)
  },
  getAgentRuntimeSettings: (): Promise<AgentRuntimeSettings> =>
    ipcRenderer.invoke(AGENT_RUNTIME_SETTINGS_GET_CHANNEL) as Promise<AgentRuntimeSettings>,
  setAgentRuntimeRecursionLimit: (value: number): Promise<AgentRuntimeSettings> =>
    ipcRenderer.invoke(
      AGENT_RUNTIME_RECURSION_LIMIT_SET_CHANNEL,
      value
    ) as Promise<AgentRuntimeSettings>,
  setWorkflowWorktreeTimeoutMinutes: (value: number): Promise<AgentRuntimeSettings> =>
    ipcRenderer.invoke(
      WORKFLOW_WORKTREE_TIMEOUT_SET_CHANNEL,
      value
    ) as Promise<AgentRuntimeSettings>,
  setWorkflowWorktreeRemoveTimeoutMinutes: (value: number): Promise<AgentRuntimeSettings> =>
    ipcRenderer.invoke(
      WORKFLOW_WORKTREE_REMOVE_TIMEOUT_SET_CHANNEL,
      value
    ) as Promise<AgentRuntimeSettings>,
  onNotifyMsg: (callback: (msg: string) => void) => {
    ipcRenderer.on("notify-login-msg", (_event, data) => {
      callback(data)
    })
  },
  ipcRenderer: {
    send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      const wrapper = (_event: unknown, ...args: unknown[]): void => listener(...args)
      ipcRenderer.on(channel, wrapper)
      return () => ipcRenderer.removeListener(channel, wrapper)
    },
    once: (channel: string, listener: (...args: unknown[]) => void) => {
      ipcRenderer.once(channel, (_event, ...args) => listener(...args))
    },
    invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
  },
  process: {
    platform: process.platform,
    versions: process.versions
  }
}

function createBrowserApi() {
  return {
    attach: (options?: BrowserAttachOptions): Promise<BrowserState> => {
      return ipcRenderer.invoke("browser:attach", options) as Promise<BrowserState>
    },
    detach: (): Promise<BrowserState> => {
      return ipcRenderer.invoke("browser:detach") as Promise<BrowserState>
    },
    setBounds: (bounds: BrowserBounds, visible?: boolean): Promise<BrowserState> => {
      return ipcRenderer.invoke("browser:setBounds", bounds, visible) as Promise<BrowserState>
    },
    navigate: (url: string, options?: BrowserNavigateOptions): Promise<BrowserState> => {
      return ipcRenderer.invoke("browser:navigate", url, options) as Promise<BrowserState>
    },
    goBack: (): Promise<BrowserState> =>
      ipcRenderer.invoke("browser:goBack") as Promise<BrowserState>,
    goForward: (): Promise<BrowserState> =>
      ipcRenderer.invoke("browser:goForward") as Promise<BrowserState>,
    reload: (): Promise<BrowserState> =>
      ipcRenderer.invoke("browser:reload") as Promise<BrowserState>,
    stop: (): Promise<BrowserState> => ipcRenderer.invoke("browser:stop") as Promise<BrowserState>,
    clearConsole: (): Promise<BrowserState> =>
      ipcRenderer.invoke("browser:clearConsole") as Promise<BrowserState>,
    getState: (): Promise<BrowserState> =>
      ipcRenderer.invoke("browser:getState") as Promise<BrowserState>,
    startScriptRecording: (
      options?: ScriptRecordingStartOptions
    ): Promise<BrowserRecordingSession> =>
      ipcRenderer.invoke(
        "browser:startScriptRecording",
        options
      ) as Promise<BrowserRecordingSession>,
    pauseScriptRecording: (): Promise<BrowserRecordingSession> =>
      ipcRenderer.invoke("browser:pauseScriptRecording") as Promise<BrowserRecordingSession>,
    updateScriptRecordingDraft: (
      input: BrowserRecordingDraftUpdateInput
    ): Promise<BrowserRecordingSession> =>
      ipcRenderer.invoke(
        "browser:updateScriptRecordingDraft",
        input
      ) as Promise<BrowserRecordingSession>,
    resumeScriptRecording: (): Promise<BrowserRecordingSession> =>
      ipcRenderer.invoke("browser:resumeScriptRecording") as Promise<BrowserRecordingSession>,
    stopScriptRecording: (): Promise<BrowserRecordingSession> =>
      ipcRenderer.invoke("browser:stopScriptRecording") as Promise<BrowserRecordingSession>,
    getScriptRecording: (): Promise<BrowserRecordingSession> =>
      ipcRenderer.invoke("browser:getScriptRecording") as Promise<BrowserRecordingSession>,
    saveScriptLibraryEntry: (
      input: BrowserScriptLibrarySaveInput
    ): Promise<BrowserScriptLibraryEntry> =>
      ipcRenderer.invoke(
        "browser:saveScriptLibraryEntry",
        input
      ) as Promise<BrowserScriptLibraryEntry>,
    listScriptLibraryEntries: (
      options?: BrowserScriptLibraryListOptions
    ): Promise<BrowserScriptLibraryEntry[]> =>
      ipcRenderer.invoke("browser:listScriptLibraryEntries", options) as Promise<
        BrowserScriptLibraryEntry[]
      >,
    readScriptLibraryScript: (input: BrowserScriptLibraryReadInput): Promise<string> =>
      ipcRenderer.invoke("browser:readScriptLibraryScript", input) as Promise<string>,
    updateScriptLibraryEntry: (input: BrowserScriptLibraryUpdateInput): Promise<void> =>
      ipcRenderer.invoke("browser:updateScriptLibraryEntry", input) as Promise<void>,
    deleteScriptLibraryEntry: (input: BrowserScriptLibraryDeleteInput): Promise<void> =>
      ipcRenderer.invoke("browser:deleteScriptLibraryEntry", input) as Promise<void>,
    executeRecordingScript: (input: BrowserScriptExecutionInput): Promise<void> =>
      ipcRenderer.invoke("browser:executeRecordingScript", input) as Promise<void>,
    getScriptExecutionState: (): Promise<BrowserScriptExecutionState> =>
      ipcRenderer.invoke("browser:getScriptExecutionState") as Promise<BrowserScriptExecutionState>,
    cancelRecordingScriptExecution: (): Promise<boolean> =>
      ipcRenderer.invoke("browser:cancelRecordingScriptExecution") as Promise<boolean>,
    getCdpConfig: (): Promise<BrowserCdpConfig> =>
      ipcRenderer.invoke("browser:getCdpConfig") as Promise<BrowserCdpConfig>,
    isProfileImportRuntimeEnabled: (): Promise<boolean> =>
      ipcRenderer.invoke("browser:isProfileImportRuntimeEnabled") as Promise<boolean>,
    saveCdpConfig: (updates: Partial<BrowserCdpConfig>): Promise<BrowserCdpConfig> =>
      ipcRenderer.invoke("browser:saveCdpConfig", updates) as Promise<BrowserCdpConfig>,
    captureScreenshot: (): Promise<BrowserScreenshotResult> =>
      ipcRenderer.invoke("browser:captureScreenshot") as Promise<BrowserScreenshotResult>,
    importProfileData: (
      options: BrowserProfileImportOptions
    ): Promise<BrowserProfileImportResult> =>
      ipcRenderer.invoke(
        "browser:importProfileData",
        options
      ) as Promise<BrowserProfileImportResult>,
    disposeAllForRendererUnload: (): void => {
      ipcRenderer.send("browser:disposeAllForRendererUnload")
    },
    onState: (callback: (state: BrowserState) => void): (() => void) => {
      const channel = `browser:state:${BROWSER_SESSION_ID}`
      const handler = (_: unknown, state: BrowserState): void => {
        callback(state)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    onPanelRequest: (callback: (request: BrowserPanelRequest) => void): (() => void) => {
      const handler = (_: unknown, request: BrowserPanelRequest): void => {
        callback(request)
      }
      ipcRenderer.on(BROWSER_PANEL_REQUEST_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(BROWSER_PANEL_REQUEST_CHANNEL, handler)
      }
    },
    onScriptExecutionState: (
      callback: (state: BrowserScriptExecutionState) => void
    ): (() => void) => {
      const handler = (_: unknown, state: BrowserScriptExecutionState): void => {
        callback(state)
      }
      ipcRenderer.on(BROWSER_SCRIPT_EXECUTION_STATE_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(BROWSER_SCRIPT_EXECUTION_STATE_CHANNEL, handler)
      }
    }
  }
}

function listenForAgentStreamRequest(
  ambientChannel: string,
  requestChannel: string,
  threadId: string,
  onEvent: (event: StreamEvent) => void,
  notifyUser: boolean
): () => void {
  let listening = true
  const cleanup = (): void => {
    if (!listening) return
    listening = false
    ipcRenderer.removeListener(requestChannel, requestHandler)
    if (requestChannel !== ambientChannel) {
      ipcRenderer.removeListener(ambientChannel, ambientHandler)
    }
  }
  const deliver = (data: StreamEvent): void => {
    onEvent(data)
    if (notifyUser) notifyForAgentStreamEvent(data, threadId)
  }
  const requestHandler = (_: unknown, data: StreamEvent): void => {
    const decision = classifyAgentStreamDelivery("request", data.type)
    deliver(data)
    if (decision === "deliver-and-close") cleanup()
  }
  const ambientHandler = (_: unknown, data: StreamEvent): void => {
    // Thread-scoped broadcasts carry asynchronous worker, hook, and message-id
    // events. A terminal event always belongs to a concrete request and must not
    // detach another request that is queued behind the replacement lock.
    if (classifyAgentStreamDelivery("ambient", data.type) === "ignore") return
    deliver(data)
  }

  ipcRenderer.on(requestChannel, requestHandler)
  if (requestChannel !== ambientChannel) ipcRenderer.on(ambientChannel, ambientHandler)
  return cleanup
}

// Custom APIs for renderer
const api = {
  agent: {
    // Send message and receive events via callback
    invoke: (
      threadId: string,
      message: string,
      onEvent: (event: StreamEvent) => void,
      modelId?: string,
      agentMode?: "normal" | "coordinator" | "workflow",
      coordinatorInternalNotification?: boolean,
      userMessageId?: string
    ): (() => void) => {
      const ambientChannel = coordinatorInternalNotification
        ? `agent:stream:${threadId}:coordinator-internal`
        : `agent:stream:${threadId}`
      const streamRequestId = randomUUID()
      const requestChannel = resolveAgentStreamRequestChannel(ambientChannel, streamRequestId)
      const cleanup = listenForAgentStreamRequest(
        ambientChannel,
        requestChannel,
        threadId,
        onEvent,
        !coordinatorInternalNotification
      )
      ipcRenderer.send("agent:invoke", {
        threadId,
        streamRequestId,
        message,
        modelId,
        agentMode,
        coordinatorInternalNotification,
        userMessageId
      })

      return cleanup
    },
    streamAgent: (
      threadId: string,
      message: string,
      command: unknown,
      onEvent: (event: StreamEvent) => void,
      modelId?: string,
      agentMode?: "normal" | "coordinator" | "workflow",
      coordinatorInternalNotification?: boolean,
      userMessageId?: string
    ): (() => void) => {
      const ambientChannel = command
        ? `agent:stream:${threadId}`
        : coordinatorInternalNotification
          ? `agent:stream:${threadId}:coordinator-internal`
          : `agent:stream:${threadId}`
      const streamRequestId = randomUUID()
      const requestChannel = resolveAgentStreamRequestChannel(ambientChannel, streamRequestId)
      const cleanup = listenForAgentStreamRequest(
        ambientChannel,
        requestChannel,
        threadId,
        onEvent,
        !coordinatorInternalNotification
      )

      if (command) {
        ipcRenderer.send("agent:resume", {
          threadId,
          streamRequestId,
          command,
          modelId,
          agentMode
        })
      } else {
        ipcRenderer.send("agent:invoke", {
          threadId,
          streamRequestId,
          message,
          modelId,
          agentMode,
          coordinatorInternalNotification,
          userMessageId
        })
      }

      return cleanup
    },
    interrupt: (
      threadId: string,
      decision: HITLDecision,
      onEvent?: (event: StreamEvent) => void
    ): (() => void) => {
      const ambientChannel = `agent:stream:${threadId}`
      const streamRequestId = randomUUID()
      const requestChannel = resolveAgentStreamRequestChannel(ambientChannel, streamRequestId)
      const cleanup = listenForAgentStreamRequest(
        ambientChannel,
        requestChannel,
        threadId,
        (data) => onEvent?.(data),
        true
      )
      ipcRenderer.send("agent:interrupt", { threadId, streamRequestId, decision })
      return cleanup
    },
    goalControl: (
      threadId: string,
      message: string
    ): Promise<{
      handled: boolean
      terminatedCurrentRun: boolean
      notice?: {
        message: string
        goalId: string | null
        activeWindowId: string | null
        eventId: number | null
        createdAt: number
      }
    }> => {
      return ipcRenderer.invoke("agent:goal-control", { threadId, message }) as Promise<{
        handled: boolean
        terminatedCurrentRun: boolean
        notice?: {
          message: string
          goalId: string | null
          activeWindowId: string | null
          eventId: number | null
          createdAt: number
        }
      }>
    },
    cancel: (threadId: string, options?: { cancelWorkers?: boolean }): Promise<void> => {
      if (options?.cancelWorkers) {
        return ipcRenderer.invoke("agent:cancel", { threadId, ...options }).then(() => undefined)
      }
      const cancelledAt = Date.now()
      cancelledAgentAttentionThreads.set(threadId, cancelledAt)
      setTimeout(() => {
        if (cancelledAgentAttentionThreads.get(threadId) === cancelledAt) {
          cancelledAgentAttentionThreads.delete(threadId)
        }
      }, CANCELLED_AGENT_ATTENTION_TTL_MS)
      return ipcRenderer
        .invoke("agent:cancel", { threadId, ...options })
        .then((cancelled: unknown) => {
          if (cancelled !== true) cancelledAgentAttentionThreads.delete(threadId)
        })
        .catch((error) => {
          cancelledAgentAttentionThreads.delete(threadId)
          throw error
        })
    },
    // Steer a queued draft into the running turn on this thread. Resolves with
    // { queued:false, reason } when there is no active foreground run.
    queueCurrentRunMessage: (
      threadId: string,
      message: { id: string; content: string; displayContent?: string }
    ): Promise<{ queued: boolean; reason?: string; message?: string }> => {
      return ipcRenderer.invoke("agent:queueCurrentRunMessage", { threadId, message }) as Promise<{
        queued: boolean
        reason?: string
        message?: string
      }>
    },
    // Un-steer a message that hasn't been injected yet.
    deleteCurrentRunQueuedMessage: (threadId: string, messageId: string): Promise<void> => {
      return ipcRenderer.invoke("agent:deleteCurrentRunQueuedMessage", { threadId, messageId })
    },
    reconcileCurrentRunQueuedMessages: (
      threadId: string,
      messageIds: string[]
    ): Promise<{ pendingIds: string[]; injectedIds: string[]; durableIds: string[] }> => {
      return ipcRenderer.invoke("agent:reconcileCurrentRunQueuedMessages", {
        threadId,
        messageIds
      })
    },
    // Subscribe to injection notifications for a thread. The main process fires
    // this when steered messages are drained into the model loop, so the renderer
    // can drop them from its draft queue and render them as committed user turns.
    onQueuedMessagesInjected: (
      threadId: string,
      callback: (payload: {
        messages: Array<{ id: string; content: string }>
        assistantIdAlias?: { sourceId: string; id: string }
      }) => void
    ): (() => void) => {
      const channel = `agent:queueInjected:${threadId}`
      const handler = (
        _event: unknown,
        payload: {
          messages: Array<{ id: string; content: string }>
          assistantIdAlias?: { sourceId: string; id: string }
        }
      ): void => {
        callback(payload)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    getCoordinatorWorkers: (
      threadId: string,
      options?: { subscribeUpdates?: boolean }
    ): Promise<unknown[]> => {
      if (!options) {
        return ipcRenderer.invoke("agent:coordinator-workers", { threadId }) as Promise<unknown[]>
      }
      return ipcRenderer.invoke("agent:coordinator-workers", {
        threadId,
        ...options
      }) as Promise<unknown[]>
    },
    unbindCoordinatorWorkers: (threadId: string): Promise<void> => {
      return ipcRenderer.invoke("agent:coordinator-workers-unsubscribe", {
        threadId
      }) as Promise<void>
    },
    hasCoordinatorWorkerNotifications: (threadId: string): Promise<boolean> => {
      return ipcRenderer.invoke("agent:coordinator-worker-notifications-pending", {
        threadId
      }) as Promise<boolean>
    },
    onCoordinatorWorkerStream: (
      threadId: string,
      callback: (event: {
        type: "stream"
        mode: "messages" | "values"
        data: unknown
        workerTurn?: number
        valuesSnapshotKind?: "full" | "append" | "tail"
      }) => void
    ): (() => void) => {
      const channel = `agent:coordinator-worker-stream:${threadId}`
      const handler = (
        _: unknown,
        data: {
          type: "stream"
          mode: "messages" | "values"
          data: unknown
          workerTurn?: number
          valuesSnapshotKind?: "full" | "append" | "tail"
        }
      ): void => {
        callback(data)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    onCoordinatorWorkerHook: (
      threadId: string,
      callback: (envelope: unknown) => void
    ): (() => void) => {
      // Durable per-thread channel for coordinator-worker hook records. Unlike
      // the run stream, this survives past the spawning turn so async worker
      // hooks still reach the renderer. Payload is the raw hook envelope
      // (`type: "hook_executed"`), fed straight into handleCustomEvent.
      const channel = `agent:coordinator-worker-hook:${threadId}`
      const handler = (_: unknown, data: unknown): void => {
        callback(data)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    setCoordinatorWorkerStreamFocus: (
      threadId: string,
      workerThreadId: string | null,
      options?: {
        expectedWorkerThreadId?: string | null
        focusToken?: string | null
        expectedFocusToken?: string | null
      }
    ): Promise<void> => {
      return ipcRenderer.invoke("agent:coordinator-worker-stream-focus", {
        threadId,
        workerThreadId,
        expectedWorkerThreadId: options?.expectedWorkerThreadId,
        focusToken: options?.focusToken,
        expectedFocusToken: options?.expectedFocusToken
      }) as Promise<void>
    },
    isCoordinatorModeForced: (threadId?: string): Promise<boolean> => {
      return ipcRenderer.invoke("agent:coordinator-mode-forced", threadId) as Promise<boolean>
    },
    canPreviewSystemPrompt: (): Promise<boolean> => {
      return ipcRenderer.invoke("agent:system-prompt-preview-access") as Promise<boolean>
    },
    getSystemPromptPreview: (
      threadId: string
    ): Promise<{ prompt: string | null; updatedAt: number | null }> => {
      return ipcRenderer.invoke("agent:system-prompt-preview", { threadId }) as Promise<{
        prompt: string | null
        updatedAt: number | null
      }>
    }
  },
  workflows: {
    listRuns: (
      threadId: string,
      options?: { cursor?: string | null; limit?: number }
    ): Promise<{ runs: unknown[]; nextCursor: string | null }> => {
      return ipcRenderer.invoke("workflow:list-runs", {
        threadId,
        cursor: options?.cursor,
        limit: options?.limit
      }) as Promise<{ runs: unknown[]; nextCursor: string | null }>
    },
    getRun: (threadId: string, runId: string): Promise<unknown | null> => {
      return ipcRenderer.invoke("workflow:get-run", { threadId, runId }) as Promise<unknown | null>
    },
    cancelRun: (threadId: string, runId?: string): Promise<boolean> => {
      return ipcRenderer.invoke("workflow:cancel-run", { threadId, runId }) as Promise<boolean>
    },
    worktreeAction: (
      threadId: string,
      runId: string,
      worktreeId: string,
      action: WorkflowWorktreeAction
    ): Promise<WorkflowWorktreeActionResponse> => {
      return ipcRenderer.invoke("workflow:worktree-action", {
        threadId,
        runId,
        worktreeId,
        action
      }) as Promise<WorkflowWorktreeActionResponse>
    },
    setAgentStreamInterest: (
      threadId: string,
      runId: string,
      agentIndex: number,
      interested: boolean
    ): Promise<boolean> => {
      // Tell main whether the focus panel is viewing THIS running agent, so the
      // display-only live tap only serializes/broadcasts the one agent you're watching.
      return ipcRenderer.invoke("workflow:set-agent-stream-interest", {
        threadId,
        runId,
        agentIndex,
        interested
      }) as Promise<boolean>
    },
    getAgentToolStream: (
      threadId: string,
      runId: string,
      agentIndex: number
    ): Promise<unknown[] | null> => {
      // Lazily read ONE finished subagent's persisted complete tool flow on click.
      return ipcRenderer.invoke("workflow:get-agent-toolstream", {
        threadId,
        runId,
        agentIndex
      }) as Promise<unknown[] | null>
    },
    hydrate: (threadId: string): Promise<unknown> => {
      return ipcRenderer.invoke("workflow:hydrate", { threadId }) as Promise<unknown>
    },
    onWorkflowEvents: (threadId: string, callback: (payload: unknown) => void): (() => void) => {
      // Durable per-thread channel for background workflow runs. Unlike the
      // run stream, this survives past the launching turn so progress and the
      // completion notification still reach the renderer.
      const channel = `agent:workflow-events:${threadId}`
      const handler = (_: unknown, data: unknown): void => {
        callback(data)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    onWorkflowAgentStream: (
      threadId: string,
      callback: (payload: unknown) => void
    ): (() => void) => {
      // Display-only live tool-stream of a workflow run's subagents (keyed by the
      // PARENT threadId; payload carries runId+agentIndex so the renderer filters).
      const channel = `agent:workflow-agent-stream:${threadId}`
      const handler = (_: unknown, data: unknown): void => {
        callback(data)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    }
  },
  threads: {
    list: async (): Promise<Thread[]> => {
      const threads: Thread[] = []
      let beforeUpdatedAt: number | undefined
      let beforeThreadId: string | undefined
      while (true) {
        const page = (await ipcRenderer.invoke("threads:list-page", {
          ...(beforeUpdatedAt === undefined ? {} : { beforeUpdatedAt }),
          ...(beforeThreadId === undefined ? {} : { beforeThreadId }),
          limit: 128,
          byteBudget: 512 * 1024
        })) as ThreadSummaryPage
        threads.push(...page.threads)
        if (!page.hasMore || page.beforeUpdatedAt === null || page.beforeThreadId === null) break
        beforeUpdatedAt = page.beforeUpdatedAt
        beforeThreadId = page.beforeThreadId
      }
      return threads
    },
    listPage: (options?: ThreadSummaryPageOptions): Promise<ThreadSummaryPage> => {
      return ipcRenderer.invoke("threads:list-page", options)
    },
    listGroupIds: (options: ThreadGroupIdsOptions): Promise<ThreadGroupIdsResult> => {
      return ipcRenderer.invoke("threads:list-group-ids", options)
    },
    get: (
      threadId: string,
      options?: { requestScope?: "foreground-hydration" }
    ): Promise<Thread | null> => {
      return ipcRenderer.invoke("threads:get", threadId, options)
    },
    create: (metadata?: Record<string, unknown>): Promise<Thread> => {
      return ipcRenderer.invoke("threads:create", metadata)
    },
    fork: (params: ThreadForkParams): Promise<ThreadForkResponse> => {
      return ipcRenderer.invoke("threads:fork", params)
    },
    listForkableCheckpoints: (threadId: string): Promise<ForkableCheckpoint[]> => {
      return ipcRenderer.invoke("threads:list-forkable-checkpoints", threadId)
    },
    resolveForkCheckpointForMessage: (
      params: ThreadForkCheckpointForMessageParams
    ): Promise<ForkableCheckpoint | null> => {
      return ipcRenderer.invoke("threads:resolve-fork-checkpoint-for-message", params)
    },
    update: (threadId: string, updates: Partial<Thread>): Promise<Thread> => {
      return ipcRenderer.invoke("threads:update", { threadId, updates })
    },
    patchMetadata: (threadId: string, patch: ThreadMetadataPatch): Promise<Thread> => {
      return ipcRenderer.invoke("threads:patchMetadata", { threadId, patch })
    },
    mergeThreadValues: (threadId: string, patch: Record<string, unknown>): Promise<Thread> => {
      return ipcRenderer.invoke("threads:mergeThreadValues", { threadId, patch })
    },
    getSubagentTranscripts: (
      threadId: string,
      options?: { requestScope?: "foreground-hydration" }
    ): Promise<Record<string, unknown>> => {
      return ipcRenderer.invoke("threads:getSubagentTranscripts", threadId, options)
    },
    getSubagentTranscript: (
      threadId: string,
      subagentId: string,
      before?: number
    ): Promise<SubagentTranscriptPage> => {
      return ipcRenderer.invoke("threads:getSubagentTranscript", { threadId, subagentId, before })
    },
    exportSubagentTranscriptBlob: (
      threadId: string,
      subagentId: string,
      messageIndex: number,
      expectedMessageId: string,
      field: SubagentTranscriptBlobField
    ): Promise<SubagentTranscriptBlobExportResult> => {
      return ipcRenderer.invoke("threads:exportSubagentTranscriptBlob", {
        threadId,
        subagentId,
        messageIndex,
        expectedMessageId,
        field
      })
    },
    persistSubagentTranscripts: (
      threadId: string,
      transcripts: Record<string, unknown>
    ): Promise<Record<string, unknown>> => {
      return ipcRenderer.invoke("threads:persistSubagentTranscripts", {
        threadId,
        transcripts
      })
    },
    delete: (threadId: string, options?: ThreadDeleteOptions): Promise<void> => {
      return ipcRenderer.invoke("threads:delete", threadId, options)
    },
    getMessages: (threadId: string): Promise<Message[]> => {
      return ipcRenderer.invoke("threads:messages", threadId)
    },
    getMessagesPage: (
      threadId: string,
      options?: ThreadMessagesPageOptions
    ): Promise<ThreadMessagesPage> => {
      return ipcRenderer.invoke("threads:messages-page", { threadId, options })
    },
    searchMessages: (
      threadId: string,
      query: string,
      options?: ThreadMessageSearchOptions
    ): Promise<ThreadMessageSearchPage> => {
      return ipcRenderer.invoke("threads:search-messages", { threadId, query, options })
    },
    appendMessages: (threadId: string, messages: Message[]): Promise<{ count: number }> => {
      return ipcRenderer.invoke("threads:appendMessages", { threadId, messages })
    },
    replaceMessageId: (
      threadId: string,
      fromId: string,
      toId: string,
      role?: Message["role"]
    ): Promise<{ replaced: boolean }> => {
      return ipcRenderer.invoke("threads:replaceMessageId", { threadId, fromId, toId, role })
    },
    exportSession: (
      threadId: string
    ): Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }> => {
      return ipcRenderer.invoke("threads:exportSession", threadId)
    },
    getHistory: (threadId: string): Promise<unknown[]> => {
      return ipcRenderer.invoke("threads:history", threadId)
    },
    getLatestCheckpoint: (threadId: string): Promise<unknown | null> => {
      return ipcRenderer.invoke("threads:latest-checkpoint", threadId)
    },
    getLatestCheckpointRuntimeState: (threadId: string): Promise<unknown | null> => {
      return ipcRenderer.invoke("threads:latest-checkpoint-runtime-state", threadId)
    },
    bootstrapLegacyCheckpointTranscript: (
      threadId: string
    ): Promise<ThreadLegacyCheckpointBootstrapResult | null> => {
      return ipcRenderer.invoke("threads:bootstrap-legacy-checkpoint-transcript", threadId)
    },
    getGoalEvents: (
      threadId: string,
      options?: { restore?: boolean; limit?: number }
    ): Promise<
      Array<{
        event_id: number
        thread_id: string
        goal_id: string | null
        active_window_id: string | null
        message: string
        created_at: Date | string | number
      }>
    > => {
      return ipcRenderer.invoke("threads:goalEvents", threadId, options) as Promise<
        Array<{
          event_id: number
          thread_id: string
          goal_id: string | null
          active_window_id: string | null
          message: string
          created_at: Date | string | number
        }>
      >
    },
    getGoalState: (
      threadId: string,
      options?: { includeEvents?: boolean }
    ): Promise<{
      goal: {
        threadId: string
        goalId: string
        activeWindowId: string
        objective: string
        completionCondition: string
        context: {
          explicitSkill?: { name: string; path: string }
          transportSummary?: string
        }
        status: "active" | "paused" | "complete"
        turnsUsed: number
        maxTurns: number
        lastVerdict: string | null
        lastReason: string | null
        pausedReason: string | null
        consecutiveParseFailures: number
        ledger: {
          progress: string[]
          evidence: string[]
          blockers: string[]
        }
        createdAt: number
        updatedAt: number
      } | null
      events: Array<{
        event_id: number
        thread_id: string
        goal_id: string | null
        active_window_id: string | null
        message: string
        created_at: Date | string | number
      }>
    }> => {
      return ipcRenderer.invoke("threads:goalState", threadId, options) as Promise<{
        goal: {
          threadId: string
          goalId: string
          activeWindowId: string
          objective: string
          completionCondition: string
          context: {
            explicitSkill?: { name: string; path: string }
            transportSummary?: string
          }
          status: "active" | "paused" | "complete"
          turnsUsed: number
          maxTurns: number
          lastVerdict: string | null
          lastReason: string | null
          pausedReason: string | null
          consecutiveParseFailures: number
          ledger: {
            progress: string[]
            evidence: string[]
            blockers: string[]
          }
          createdAt: number
          updatedAt: number
        } | null
        events: Array<{
          event_id: number
          thread_id: string
          goal_id: string | null
          active_window_id: string | null
          message: string
          created_at: Date | string | number
        }>
      }>
    },
    generateTitle: (message: string): Promise<string> => {
      return ipcRenderer.invoke("threads:generateTitle", message)
    },
    onThreadsChanged: (callback: () => void): (() => void) => {
      const handler = (): void => {
        callback()
      }
      ipcRenderer.on("threads:changed", handler)
      return () => {
        ipcRenderer.removeListener("threads:changed", handler)
      }
    }
  },
  models: {
    getCatalog: (): Promise<{
      models: ModelConfig[]
      providers: Provider[]
      defaultModelId: string
      routingMode: "auto" | "pinned"
    }> => {
      return ipcRenderer.invoke("models:getCatalog")
    },
    list: (): Promise<ModelConfig[]> => {
      return ipcRenderer.invoke("models:list")
    },
    listProviders: (): Promise<Provider[]> => {
      return ipcRenderer.invoke("models:listProviders")
    },
    getDefault: (): Promise<string> => {
      return ipcRenderer.invoke("models:getDefault")
    },
    setDefault: (modelId: string): Promise<void> => {
      return ipcRenderer.invoke("models:setDefault", modelId)
    },
    getGoalSettings: (): Promise<{ evaluatorModelId?: string }> => {
      return ipcRenderer.invoke("models:getGoalSettings") as Promise<{ evaluatorModelId?: string }>
    },
    setGoalSettings: (settings: { evaluatorModelId?: string }): Promise<void> => {
      return ipcRenderer.invoke("models:setGoalSettings", settings) as Promise<void>
    },
    getTokenLimits: (): Promise<{
      defaultMaxTokens: number
      minMaxTokens: number
      maxMaxTokens: number
      defaultMaxOutputTokens: number
      minMaxOutputTokens: number
      maxMaxOutputTokens: number
      defaultTemperature: number
      maxTemperature: number
      defaultTopP: number
      maxTopP: number
      defaultTopK: number
      minTopK: number
      maxTopK: number
    }> => {
      return ipcRenderer.invoke("models:getTokenLimits") as Promise<{
        defaultMaxTokens: number
        minMaxTokens: number
        maxMaxTokens: number
        defaultMaxOutputTokens: number
        minMaxOutputTokens: number
        maxMaxOutputTokens: number
        defaultTemperature: number
        maxTemperature: number
        defaultTopP: number
        maxTopP: number
        defaultTopK: number
        minTopK: number
        maxTopK: number
      }>
    },
    getCustomConfigs: (): Promise<
      Array<{
        id: string
        name: string
        baseUrl: string
        model: string
        hasApiKey: boolean
        maxTokens: number
        maxOutputTokens: number
        temperature: number
        topP: number
        topK: number
        interleavedThinking?: boolean
        enableThinking?: boolean
        enableThinkingEffort?: boolean
        thinkingEffort?: "high" | "max"
        tier?: "premium" | "economy"
      }>
    > => {
      return ipcRenderer.invoke("models:getCustomConfigs") as Promise<
        Array<{
          id: string
          name: string
          baseUrl: string
          model: string
          hasApiKey: boolean
          maxTokens: number
          maxOutputTokens: number
          temperature: number
          topP: number
          topK: number
          interleavedThinking?: boolean
          enableThinking?: boolean
          enableThinkingEffort?: boolean
          thinkingEffort?: "high" | "max"
          tier?: "premium" | "economy"
        }>
      >
    },
    getCustomConfig: (
      id?: string
    ): Promise<{
      id: string
      name: string
      baseUrl: string
      model: string
      hasApiKey: boolean
      maxTokens: number
      maxOutputTokens: number
      temperature: number
      topP: number
      topK: number
      interleavedThinking?: boolean
      enableThinking?: boolean
      enableThinkingEffort?: boolean
      thinkingEffort?: "high" | "max"
      tier?: "premium" | "economy"
    } | null> => {
      return ipcRenderer.invoke("models:getCustomConfig", id) as Promise<{
        id: string
        name: string
        baseUrl: string
        model: string
        hasApiKey: boolean
        maxTokens: number
        maxOutputTokens: number
        temperature: number
        topP: number
        topK: number
        interleavedThinking?: boolean
        enableThinking?: boolean
        enableThinkingEffort?: boolean
        thinkingEffort?: "high" | "max"
        tier?: "premium" | "economy"
      } | null>
    },
    getBuiltinConfigs: (): Promise<
      Array<{
        id: string
        ref: `builtin:${string}`
        source: "builtin"
        origin: "remote" | "fallback"
        name: string
        baseUrl: string
        model: string
        hasApiKey: boolean
        maxTokens: number
        maxOutputTokens: number
        temperature: number
        topP: number
        topK: number
        interleavedThinking?: boolean
        enableThinking?: boolean
        enableThinkingEffort?: boolean
        thinkingEffort?: "high" | "max"
        tier?: "premium" | "economy"
        lockedFields: Array<"baseUrl" | "model" | "apiKey">
      }>
    > => {
      return ipcRenderer.invoke("models:getBuiltinConfigs")
    },
    updateBuiltinConfig: (
      id: string,
      config: {
        name?: string
        maxTokens?: number
        maxOutputTokens?: number
        temperature?: number
        topP?: number
        topK?: number
        interleavedThinking?: boolean
        enableThinking?: boolean
        enableThinkingEffort?: boolean
        thinkingEffort?: "high" | "max"
        tier?: "premium" | "economy"
      }
    ): Promise<void> => {
      return ipcRenderer.invoke("models:updateBuiltinConfig", id, config)
    },
    resetBuiltinConfig: (id: string): Promise<void> => {
      return ipcRenderer.invoke("models:resetBuiltinConfig", id)
    },
    onChanged: (callback: () => void): (() => void) => {
      const handler = (): void => callback()
      ipcRenderer.on("models:changed", handler)
      return () => ipcRenderer.removeListener("models:changed", handler)
    },
    setCustomConfig: (config: {
      id: string
      name: string
      baseUrl: string
      model: string
      apiKey?: string
      maxTokens?: number
      maxOutputTokens?: number
      temperature?: number
      topP?: number
      topK?: number
      interleavedThinking?: boolean
      enableThinking?: boolean
      enableThinkingEffort?: boolean
      thinkingEffort?: "high" | "max"
      tier?: "premium" | "economy"
    }): Promise<void> => {
      return ipcRenderer.invoke("models:setCustomConfig", config) as Promise<void>
    },
    upsertCustomConfig: (config: {
      id?: string
      name: string
      baseUrl: string
      model: string
      apiKey?: string
      maxTokens?: number
      maxOutputTokens?: number
      temperature?: number
      topP?: number
      topK?: number
      interleavedThinking?: boolean
      enableThinking?: boolean
      enableThinkingEffort?: boolean
      thinkingEffort?: "high" | "max"
      tier?: "premium" | "economy"
    }): Promise<{ id: string }> => {
      return ipcRenderer.invoke("models:upsertCustomConfig", config) as Promise<{ id: string }>
    },
    upsertUserInfo: (config: UserInfoConfig): Promise<{ id: string }> => {
      return ipcRenderer.invoke("models:upsertUserInfo", config) as Promise<{ id: string }>
    },
    getUserInfo: (): Promise<UserInfoConfig | null> => {
      return ipcRenderer.invoke("models:getUserInfo") as Promise<UserInfoConfig | null>
    },
    deleteCustomConfig: (id: string): Promise<void> => {
      return ipcRenderer.invoke("models:deleteCustomConfig", id) as Promise<void>
    },
    testConnection: (params: {
      id?: string
      baseUrl?: string
      model?: string
      apiKey?: string
      maxOutputTokens?: number
      temperature?: number
      topP?: number
      topK?: number
      enableThinking?: boolean
      enableThinkingEffort?: boolean
      thinkingEffort?: "high" | "max"
    }): Promise<{ success: boolean; error?: string; latencyMs?: number }> => {
      return ipcRenderer.invoke("models:testConnection", params) as Promise<{
        success: boolean
        error?: string
        latencyMs?: number
      }>
    }
  },
  ide: {
    getPreferred: (): Promise<PreferredIde> => {
      return ipcRenderer.invoke("ide:getPreferred") as Promise<PreferredIde>
    },
    getSettings: (): Promise<IdeSettings> => {
      return ipcRenderer.invoke("ide:getSettings") as Promise<IdeSettings>
    },
    setPreferred: (preferredIde: PreferredIde): Promise<PreferredIde> => {
      return ipcRenderer.invoke("ide:setPreferred", preferredIde) as Promise<PreferredIde>
    },
    configurePreferred: (
      request: ConfigurePreferredIdeRequest
    ): Promise<ConfigurePreferredIdeResult> => {
      return ipcRenderer.invoke(
        "ide:configurePreferred",
        request
      ) as Promise<ConfigurePreferredIdeResult>
    },
    open: (
      request: OpenIdeRequest
    ): Promise<{
      editor: string
      mode: "workspace+file+line" | "workspace+file" | "workspace"
    }> => {
      return ipcRenderer.invoke("ide:open", request) as Promise<{
        editor: string
        mode: "workspace+file+line" | "workspace+file" | "workspace"
      }>
    }
  },
  workspace: {
    get: (threadId?: string): Promise<string | null> => {
      return ipcRenderer.invoke("workspace:get", threadId)
    },
    set: (threadId: string | undefined, path: string | null): Promise<string | null> => {
      return ipcRenderer.invoke("workspace:set", { threadId, path })
    },
    select: (threadId?: string): Promise<string | null> => {
      return ipcRenderer.invoke("workspace:select", threadId)
    },
    loadFromDisk: (
      threadId: string,
      workspacePath?: string
    ): Promise<{
      success: boolean
      files: Array<{
        path: string
        is_dir: boolean
        size?: number
        modified_at?: string
      }>
      workspacePath?: string
      error?: string
      truncated?: boolean
      continuationAvailable?: boolean
    }> => {
      // Compatibility facade is retention-bounded too. It returns at most one
      // worker segment and closes the scan; callers that support explicit
      // continuation use the lower-level methods below.
      return (async () => {
        const opened = (await ipcRenderer.invoke("workspace:fileScanOpen", {
          threadId,
          workspacePath
        })) as WorkspaceFileScanOpenResult
        if (!opened.success || !opened.scanId) {
          return {
            success: false,
            files: [],
            error: opened.error,
            workspacePath: opened.workspacePath
          }
        }
        const files: WorkspaceFileScanPageResult["files"] = []
        try {
          while (true) {
            const page = (await ipcRenderer.invoke("workspace:fileScanNext", {
              scanId: opened.scanId,
              threadId
            })) as WorkspaceFileScanPageResult
            if (!page.success) {
              return {
                success: false,
                files: [],
                error: page.error,
                workspacePath: page.workspacePath
              }
            }
            files.push(...page.files)
            if (page.truncated) {
              return {
                success: true,
                files,
                workspacePath: page.workspacePath,
                truncated: true,
                continuationAvailable: false
              }
            }
            if (page.done) {
              return {
                success: true,
                files,
                workspacePath: page.workspacePath,
                truncated: false,
                continuationAvailable: false
              }
            }
          }
        } finally {
          void ipcRenderer.invoke("workspace:fileScanCancel", { scanId: opened.scanId })
        }
      })()
    },
    fileScanOpen: (
      threadId: string,
      workspacePath?: string
    ): Promise<WorkspaceFileScanOpenResult> => {
      return ipcRenderer.invoke("workspace:fileScanOpen", { threadId, workspacePath })
    },
    fileScanNext: (
      scanId: string,
      threadId: string,
      continuation?: string
    ): Promise<WorkspaceFileScanPageResult> => {
      return ipcRenderer.invoke("workspace:fileScanNext", { scanId, threadId, continuation })
    },
    fileScanCancel: (scanId: string): Promise<{ success: boolean }> => {
      return ipcRenderer.invoke("workspace:fileScanCancel", { scanId })
    },
    ensureWatching: (threadId: string): Promise<{ success: boolean; restarted?: boolean }> => {
      return ipcRenderer.invoke("workspace:ensureWatching", { threadId })
    },
    setActiveThread: (
      threadId: string | null
    ): Promise<{ success: boolean; restarted?: boolean; workspacePath?: string | null }> => {
      return ipcRenderer.invoke("workspace:setActiveThread", { threadId })
    },
    readFilePreview: (
      request: WorkspaceFilePreviewReadRequest
    ): Promise<WorkspaceFilePreviewReadResult> => {
      return ipcRenderer.invoke("workspace:filePreviewRead", request)
    },
    openMediaPreview: (
      request: WorkspaceFilePreviewOpenMediaRequest
    ): Promise<WorkspaceFilePreviewOpenMediaResult> => {
      return ipcRenderer.invoke("workspace:filePreviewOpenMedia", request)
    },
    cancelFilePreview: (
      request: WorkspaceFilePreviewCancelRequest
    ): Promise<{ success: boolean }> => {
      return ipcRenderer.invoke("workspace:filePreviewCancel", request)
    },
    releaseFilePreview: (
      request: WorkspaceFilePreviewReleaseRequest
    ): Promise<{ success: boolean }> => {
      return ipcRenderer.invoke("workspace:filePreviewRelease", request)
    },
    clearWorktreeContext: (expected: {
      threadId: string
      workspacePath: string
      gitRoot: string
      branch: string
    }): Promise<void> => {
      return ipcRenderer.invoke("workspace:clearWorktreeContext", expected) as Promise<void>
    },
    saveWorktreeContext: (
      threadId: string,
      expectedWorkspacePath: string,
      gitRoot: string,
      branch: string,
      baseBranch?: string,
      baseCommit?: string
    ): Promise<void> => {
      return ipcRenderer.invoke("workspace:saveWorktreeContext", {
        threadId,
        expectedWorkspacePath,
        gitRoot,
        branch,
        baseBranch,
        baseCommit
      }) as Promise<void>
    },
    recordLlmModifiedFiles: (
      threadId: string,
      files: string[]
    ): Promise<{ success: boolean; files?: string[]; error?: string }> => {
      return ipcRenderer.invoke("workspace:recordLlmModifiedFiles", {
        threadId,
        files
      }) as Promise<{
        success: boolean
        files?: string[]
        error?: string
      }>
    },
    getGitPanelState: (
      threadId: string
    ): Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      taskId: string
      repositories?: Array<{ path: string; displayPath: string; gitRoot: string }>
      files: Array<{
        path: string
        previousPath?: string
        status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"
        diff: string
        diffLoaded?: boolean
        additions: number
        deletions: number
      }>
      changedFiles?: string[]
      changedFilesTotal?: number
      omittedFileCount?: number
      totals: { additions: number; deletions: number; fileCount: number }
      hasPendingDiff: boolean
      hasPushableCommit: boolean
      pendingCommits?: Array<{ hash: string; message: string; date: string }>
      trackedFiles?: string[]
      worktreeBranch?: string | null
      suggestedCommitMessage?: string
      error?: string
    }> => {
      return ipcRenderer.invoke("workspace:getGitPanelState", { threadId }) as Promise<{
        success: boolean
        isWorktree: boolean
        isGitRepo?: boolean
        taskId: string
        repositories?: Array<{ path: string; displayPath: string; gitRoot: string }>
        files: Array<{
          path: string
          previousPath?: string
          status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"
          diff: string
          diffLoaded?: boolean
          additions: number
          deletions: number
        }>
        changedFiles?: string[]
        changedFilesTotal?: number
        omittedFileCount?: number
        totals: { additions: number; deletions: number; fileCount: number }
        hasPendingDiff: boolean
        hasPushableCommit: boolean
        pendingCommits?: Array<{ hash: string; message: string; date: string }>
        trackedFiles?: string[]
        worktreeBranch?: string | null
        suggestedCommitMessage?: string
        error?: string
      }>
    },
    getGitPanelMeta: (
      threadId: string,
      options?: {
        worktreePath?: string
        includeSummary?: boolean
        includePushability?: boolean
      }
    ): Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      taskId: string
      changedFilesTotal?: number
      hasPendingDiff: boolean
      hasPushableCommit: boolean
      pendingCommits?: Array<{ hash: string; message: string; date: string }>
      trackedFiles?: string[]
      worktreeBranch?: string | null
      error?: string
    }> => {
      return ipcRenderer.invoke("workspace:getGitPanelMeta", { threadId, options }) as Promise<{
        success: boolean
        isWorktree: boolean
        isGitRepo?: boolean
        taskId: string
        changedFilesTotal?: number
        hasPendingDiff: boolean
        hasPushableCommit: boolean
        pendingCommits?: Array<{ hash: string; message: string; date: string }>
        trackedFiles?: string[]
        worktreeBranch?: string | null
        error?: string
      }>
    },
    getGitPanelDiffs: (
      threadId: string,
      options?: {
        includeDiffs?: boolean
        includeChangedFiles?: boolean
        statusUntrackedMode?: "all" | "normal" | "no"
        visibleFileLimit?: number
        worktreePath?: string
      }
    ): Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      taskId: string
      files: Array<{
        path: string
        previousPath?: string
        status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"
        diff: string
        diffLoaded?: boolean
        additions: number
        deletions: number
      }>
      changedFiles?: string[]
      changedFilesTotal?: number
      omittedFileCount?: number
      totals: { additions: number; deletions: number; fileCount: number }
      hasPendingDiff: boolean
      suggestedCommitMessage?: string
      error?: string
    }> => {
      return ipcRenderer.invoke("workspace:getGitPanelDiffs", { threadId, options }) as Promise<{
        success: boolean
        isWorktree: boolean
        isGitRepo?: boolean
        taskId: string
        files: Array<{
          path: string
          previousPath?: string
          status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"
          diff: string
          diffLoaded?: boolean
          additions: number
          deletions: number
        }>
        changedFiles?: string[]
        changedFilesTotal?: number
        omittedFileCount?: number
        totals: { additions: number; deletions: number; fileCount: number }
        hasPendingDiff: boolean
        suggestedCommitMessage?: string
        error?: string
      }>
    },
    getGitPanelFileDiff: (
      threadId: string,
      filePath: string,
      options?: { worktreePath?: string }
    ): Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      taskId: string
      file?: {
        path: string
        previousPath?: string
        status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"
        diff: string
        diffLoaded?: boolean
        additions: number
        deletions: number
      }
      error?: string
    }> => {
      return ipcRenderer.invoke("workspace:getGitPanelFileDiff", {
        threadId,
        filePath,
        options
      }) as Promise<{
        success: boolean
        isWorktree: boolean
        isGitRepo?: boolean
        taskId: string
        file?: {
          path: string
          previousPath?: string
          status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"
          diff: string
          diffLoaded?: boolean
          additions: number
          deletions: number
        }
        error?: string
      }>
    },
    getGitChangedFilesSummary: (
      threadId: string
    ): Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      taskId: string
      files: Array<{
        path: string
        previousPath?: string
        status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"
      }>
      changedFilesTotal: number
      omittedFileCount: number
      hasPendingDiff: boolean
      error?: string
    }> => {
      return ipcRenderer.invoke("workspace:getGitChangedFilesSummary", { threadId }) as Promise<{
        success: boolean
        isWorktree: boolean
        isGitRepo?: boolean
        taskId: string
        files: Array<{
          path: string
          previousPath?: string
          status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"
        }>
        changedFilesTotal: number
        omittedFileCount: number
        hasPendingDiff: boolean
        error?: string
      }>
    },
    getGitPanelSummary: (
      threadId: string
    ): Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      hasPendingDiff: boolean
      changedFiles: number
    }> => {
      return ipcRenderer.invoke("workspace:getGitPanelSummary", { threadId }) as Promise<{
        success: boolean
        isWorktree: boolean
        isGitRepo?: boolean
        hasPendingDiff: boolean
        changedFiles: number
      }>
    },
    cancelGitPanelReads: (
      family?: "panel" | "changed-summary" | "summary" | "workspace-probe"
    ): Promise<void> => {
      return ipcRenderer.invoke("workspace:cancelGitPanelReads", family) as Promise<void>
    },
    isGit: (
      folderPath: string,
      options?: { includeWorktrees?: boolean; threadId?: string }
    ): Promise<{
      isGit: boolean
      gitRoot: string | null
      worktrees: Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>
      isWorktreePath: boolean
      repositories?: Array<{ path: string; displayPath: string; gitRoot: string }>
    }> => {
      return ipcRenderer.invoke("workspace:isGit", {
        folderPath,
        includeWorktrees: options?.includeWorktrees,
        threadId: options?.threadId
      }) as Promise<{
        isGit: boolean
        gitRoot: string | null
        worktrees: Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>
        isWorktreePath: boolean
        repositories?: Array<{ path: string; displayPath: string; gitRoot: string }>
      }>
    },
    listWorktrees: (
      gitRoot: string
    ): Promise<Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>> => {
      return ipcRenderer.invoke("workspace:listWorktrees", gitRoot) as Promise<
        Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>
      >
    },
    removeWorktree: (
      threadId: string,
      worktreePath: string
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("workspace:removeWorktree", {
        threadId,
        worktreePath
      }) as Promise<{ success: boolean; error?: string }>
    },
    createWorktree: (
      threadId: string,
      gitRoot: string,
      branch: string
    ): Promise<{
      success: boolean
      path?: string
      branch?: string
      baseBranch?: string
      baseCommit?: string
      error?: string
    }> => {
      return ipcRenderer.invoke("workspace:createWorktree", {
        threadId,
        gitRoot,
        branch
      }) as Promise<{
        success: boolean
        path?: string
        branch?: string
        baseBranch?: string
        baseCommit?: string
        error?: string
      }>
    },
    commitWorktree: (
      threadId: string,
      message: string,
      filePaths?: string[],
      options?: { worktreePath?: string; agentInitiated?: boolean }
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("workspace:commitWorktree", {
        threadId,
        message,
        filePaths,
        options
      }) as Promise<{
        success: boolean
        error?: string
      }>
    },
    pushWorktree: (
      threadId: string,
      options?: { worktreePath?: string }
    ): Promise<{
      success: boolean
      autoCommitted?: boolean
      error?: string
      steps?: Array<{
        step: "pull" | "commit" | "push" | "verify" | "final"
        status: "ok" | "failed" | "skipped"
        detail: string
      }>
    }> => {
      return ipcRenderer.invoke("workspace:pushWorktree", { threadId, options }) as Promise<{
        success: boolean
        autoCommitted?: boolean
        error?: string
        steps?: Array<{
          step: "pull" | "commit" | "push" | "verify" | "final"
          status: "ok" | "failed" | "skipped"
          detail: string
        }>
      }>
    },
    pullWorktree: (
      threadId: string,
      options?: { worktreePath?: string }
    ): Promise<{ success: boolean; detail?: string; error?: string }> => {
      return ipcRenderer.invoke("workspace:pullWorktree", { threadId, options }) as Promise<{
        success: boolean
        detail?: string
        error?: string
      }>
    },
    rejectWorktreeChanges: (
      threadId: string,
      filePaths?: string[],
      options?: { worktreePath?: string }
    ): Promise<{ success: boolean; revertedFileCount?: number; error?: string }> => {
      return ipcRenderer.invoke("workspace:rejectWorktreeChanges", {
        threadId,
        filePaths,
        options
      }) as Promise<{
        success: boolean
        revertedFileCount?: number
        error?: string
      }>
    },
    rejectWorktreeFile: (
      threadId: string,
      filePath: string,
      options?: { worktreePath?: string }
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("workspace:rejectWorktreeFile", {
        threadId,
        filePath,
        options
      }) as Promise<{
        success: boolean
        error?: string
      }>
    },
    // Listen for file changes in the workspace
    onFilesChanged: (callback: (data: WorkspaceFilesChangedPayload) => void): (() => void) => {
      const handler = (_: unknown, data: unknown): void => {
        const payload = normalizeWorkspaceFilesChangedPayload(data)
        if (payload) callback(payload)
      }
      ipcRenderer.on("workspace:files-changed", handler)
      // Return cleanup function
      return () => {
        ipcRenderer.removeListener("workspace:files-changed", handler)
      }
    }
  },
  pet: {
    // 列出内置 pets/ 与 OPENWORK_DIR/pets 下可用宠物。
    list: (): Promise<PetManifest[]> => {
      return ipcRenderer.invoke("pet:list") as Promise<PetManifest[]>
    },
    getSpriteBytes: (
      directoryId: string,
      source?: "builtin" | "custom"
    ): Promise<{ success: boolean; bytes?: Uint8Array; mimeType?: string; error?: string }> => {
      return ipcRenderer.invoke("pet:getSpriteBytes", directoryId, source) as Promise<{
        success: boolean
        bytes?: Uint8Array
        mimeType?: string
        error?: string
      }>
    },
    // 将业务状态同步到独立宠物窗口；动画渲染不在 renderer 主 UI 中执行。
    setState: (state: PetState): void => {
      ipcRenderer.send("pet:setState", state)
    },
    // 告知主进程主应用已打开/获得焦点，用于清空宠物完成任务提醒队列。
    clearCompletedTasks: (): void => {
      ipcRenderer.send("pet:clearCompletedTasks")
    },
    getSettings: (): Promise<PetSettings> => {
      return ipcRenderer.invoke("pet:getSettings") as Promise<PetSettings>
    },
    updateSettings: (settings: Partial<PetSettings>): Promise<PetSettings> => {
      return ipcRenderer.invoke("pet:updateSettings", settings) as Promise<PetSettings>
    },
    onSettingsChanged: (callback: (settings: PetSettings) => void): (() => void) => {
      const handler = (_event: unknown, settings: PetSettings): void => callback(settings)
      ipcRenderer.on(PET_SETTINGS_CHANGED_CHANNEL, handler)
      return () => ipcRenderer.removeListener(PET_SETTINGS_CHANGED_CHANNEL, handler)
    },
    uploadCustomFolder: (): Promise<{ success: boolean; pet?: PetManifest; error?: string }> => {
      return ipcRenderer.invoke("pet:uploadCustomFolder") as Promise<{
        success: boolean
        pet?: PetManifest
        error?: string
      }>
    },
    deleteCustom: (directoryId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("pet:deleteCustom", directoryId) as Promise<{
        success: boolean
        error?: string
      }>
    }
  },
  file: {
    parseSelected: (
      request: AttachmentGrantParseRequest
    ): Promise<{
      success: boolean
      attachment?: ParsedAttachment
      error?: string
    }> => {
      return ipcRenderer.invoke("file:parseSelected", request)
    },
    parseBytes: (
      request: AttachmentBytesParseRequest
    ): Promise<{
      success: boolean
      attachment?: ParsedAttachment
      error?: string
    }> => {
      return ipcRenderer.invoke("file:parseBytes", request)
    },
    select: (): Promise<AttachmentFileSelectionResult> => {
      return ipcRenderer.invoke("file:select")
    },
    selectDirectory: (options?: {
      title?: string
    }): Promise<{ canceled: boolean; filePaths: string[] }> => {
      return ipcRenderer.invoke("file:selectDirectory", options)
    },
    supportedExtensions: (): Promise<string[]> => {
      return ipcRenderer.invoke("file:supportedExtensions")
    }
  },
  skills: {
    catalog: {
      read: (
        input: SkillPluginCatalogPageInput,
        requestScope: string
      ): Promise<SkillPluginCatalogPage> => {
        return ipcRenderer.invoke("skills:catalog:read", {
          input,
          scope: requestScope
        }) as Promise<SkillPluginCatalogPage>
      },
      cancel: (requestScope: string): Promise<void> => {
        return ipcRenderer.invoke("skills:catalog:cancel", requestScope) as Promise<void>
      }
    },
    list: (): Promise<SkillMetadata[]> => {
      return ipcRenderer.invoke("skills:list")
    },
    listPlugins: (): Promise<SkillMetadata[]> => {
      return ipcRenderer.invoke("skills:listPlugins")
    },
    requestPreviewGrant: (request: SkillPreviewGrantRequest): Promise<SkillPreviewGrantResult> => {
      return ipcRenderer.invoke("skills:requestPreviewGrant", request)
    },
    cancelPreviewGrant: (): Promise<void> => {
      return ipcRenderer.invoke("skills:cancelPreviewGrant") as Promise<void>
    },
    read: (skillPath: string): Promise<{ success: boolean; content?: string; error?: string }> => {
      return ipcRenderer.invoke("skills:read", skillPath)
    },
    write: (skillPath: string, content: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("skills:write", { skillPath, content })
    },
    readBinary: (
      skillPath: string
    ): Promise<{ success: boolean; content?: string; mimeType?: string; error?: string }> => {
      return ipcRenderer.invoke("skills:readBinary", skillPath)
    },
    listFiles: (
      skillPath: string
    ): Promise<{ success: boolean; files?: string[]; error?: string }> => {
      return ipcRenderer.invoke("skills:listFiles", skillPath)
    },
    readTextBundle: (
      skillPath: string
    ): Promise<{
      success: boolean
      files?: Array<{ path: string; content: string }>
      skipped?: Array<{ path: string; reason: string }>
      error?: string
    }> => {
      return ipcRenderer.invoke("skills:readTextBundle", skillPath)
    },
    getDisabled: (): Promise<string[]> => {
      return ipcRenderer.invoke("skills:getDisabled")
    },
    setDisabled: (skillNames: string[]): Promise<void> => {
      return ipcRenderer.invoke("skills:setDisabled", skillNames)
    },
    setDisabledState: (skillId: string, disabled: boolean): Promise<string[]> => {
      return ipcRenderer.invoke("skills:setDisabledState", { skillId, disabled })
    },
    backupForCloudEvolution: (payload: {
      skillPath: string
      candidateId: string
      skillName: string
      sourceVersion?: string | null
      targetVersion?: string | null
    }): Promise<{ success: boolean; backupId?: string; backupPath?: string; error?: string }> => {
      return ipcRenderer.invoke("skills:backupForCloudEvolution", payload)
    },
    restoreCloudEvolutionBackup: (
      backupId: string
    ): Promise<{ success: boolean; skillName?: string; error?: string }> => {
      return ipcRenderer.invoke("skills:restoreCloudEvolutionBackup", backupId)
    },
    applyPluginSkillEvolution: (payload: {
      skillPath: string
      candidateId: string
      skillName: string
      buffer: ArrayBuffer
      fileName: string
      sourceVersion?: string | null
      targetVersion?: string | null
    }): Promise<{ success: boolean; backupId?: string; error?: string }> => {
      return ipcRenderer.invoke("skills:applyPluginSkillEvolution", payload)
    },
    rollbackPluginSkillEvolution: (
      backupId: string
    ): Promise<{ success: boolean; skillName?: string; error?: string }> => {
      return ipcRenderer.invoke("skills:rollbackPluginSkillEvolution", backupId)
    },
    exportCloudEvolutionBackup: (
      backupId: string,
      targetDir: string
    ): Promise<{ success: boolean; exportedPath?: string; error?: string }> => {
      return ipcRenderer.invoke("skills:exportCloudEvolutionBackup", { backupId, targetDir })
    },
    upload: (
      buffer: ArrayBuffer,
      fileName: string,
      options?: { allowNestedNameDuplicates?: boolean }
    ): Promise<{
      success: boolean
      skillName?: string
      error?: string
      nestedNameConflicts?: Array<{ name: string; relativePath: string }>
    }> => {
      return ipcRenderer.invoke("skills:upload", { buffer, fileName, options })
    },
    extractMarkdownFromZip: (
      buffer: ArrayBuffer,
      fileName?: string
    ): Promise<{ success: boolean; filePath?: string; content?: string; error?: string }> => {
      return ipcRenderer.invoke("skills:extractMarkdownFromZip", { buffer, fileName })
    },
    exportForMarket: (
      skillPath: string,
      options?: { includeNestedSkills?: boolean }
    ): Promise<{ success: boolean; fileName?: string; buffer?: ArrayBuffer; error?: string }> => {
      return ipcRenderer.invoke("skills:exportForMarket", skillPath, options)
    },
    delete: (skillPath: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("skills:delete", skillPath)
    },
    /**
     * Subscribe to skill-set changes pushed by main (`skills:changed` event).
     * Triggered after skill evolution / optimizer writes and plugin SKILL.md
     * edits — anywhere a downstream surface (slash popover, right panel)
     * needs to re-pull `skills.list()` + `skills.listPlugins()`.
     *
     * Returns an unsubscribe handle in the same shape as the rest of the
     * preload's `onChanged` listeners.
     */
    onChanged: (callback: (payload: { reason?: string }) => void): (() => void) => {
      const listener = (_event: unknown, payload: unknown): void => {
        const reason =
          payload && typeof payload === "object"
            ? (payload as { reason?: unknown }).reason
            : undefined
        callback({ reason: typeof reason === "string" ? reason : undefined })
      }
      ipcRenderer.on("skills:changed", listener)
      return () => ipcRenderer.removeListener("skills:changed", listener)
    }
  },
  mcp: {
    list: (): Promise<McpConnectorConfig[]> => ipcRenderer.invoke("mcp:list"),
    create: (config: McpConnectorUpsert): Promise<{ id: string }> =>
      ipcRenderer.invoke("mcp:create", config),
    update: (config: McpConnectorUpsert & { id: string }): Promise<{ id: string }> =>
      ipcRenderer.invoke("mcp:update", config),
    delete: (id: string): Promise<void> => ipcRenderer.invoke("mcp:delete", id),
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("mcp:setEnabled", { id, enabled }),
    testConnection: (params: {
      id?: string
      config?: McpConnectorUpsert
      url?: string
      advanced?: McpConnectorConfig["advanced"]
    }): Promise<{ success: boolean; tools?: string[]; error?: string }> =>
      ipcRenderer.invoke("mcp:testConnection", params),
    previewImport: (params: McpImportConfigRequest): Promise<McpImportPreviewResult> =>
      ipcRenderer.invoke("mcp:previewImport", params),
    importConfig: (params: McpImportConfigApplyRequest): Promise<McpImportApplyResult> =>
      ipcRenderer.invoke("mcp:importConfig", params)
  },
  lsp: {
    getConfig: (): Promise<LspConfig> => ipcRenderer.invoke("lsp:getConfig") as Promise<LspConfig>,
    saveConfig: (updates: Partial<LspConfig>): Promise<void> =>
      ipcRenderer.invoke("lsp:saveConfig", updates) as Promise<void>,
    resetConfig: (): Promise<LspConfig> =>
      ipcRenderer.invoke("lsp:resetConfig") as Promise<LspConfig>,
    start: (projectRoot: string): Promise<void> =>
      ipcRenderer.invoke("lsp:start", projectRoot) as Promise<void>,
    stop: (projectRoot: string): Promise<void> =>
      ipcRenderer.invoke("lsp:stop", projectRoot) as Promise<void>,
    isRunning: (projectRoot: string): Promise<boolean> =>
      ipcRenderer.invoke("lsp:isRunning", projectRoot) as Promise<boolean>,
    getStatus: (projectRoot: string | null): Promise<LspStatus> =>
      ipcRenderer.invoke("lsp:getStatus", projectRoot) as Promise<LspStatus>,
    getDownloadTarget: (): Promise<{ name: string; filenames: string[] }> =>
      ipcRenderer.invoke("lsp:getDownloadTarget") as Promise<{ name: string; filenames: string[] }>,
    getDownloadState: (): Promise<LspDownloadState> =>
      ipcRenderer.invoke("lsp:getDownloadState") as Promise<LspDownloadState>,
    downloadVsix: (): Promise<{ success: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke("lsp:downloadVsix") as Promise<{
        success: boolean
        path?: string
        error?: string
      }>,
    importVsix: (): Promise<{ success: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke("lsp:importVsix") as Promise<{
        success: boolean
        path?: string
        error?: string
      }>,
    saveDownloadedVsix: (
      buffer: ArrayBuffer,
      fileName?: string
    ): Promise<{ success: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke("lsp:saveDownloadedVsix", { buffer, fileName }) as Promise<{
        success: boolean
        path?: string
        error?: string
      }>,
    definition: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }): Promise<LspLocation[]> =>
      ipcRenderer.invoke("lsp:definition", params) as Promise<LspLocation[]>,
    references: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }): Promise<LspLocation[]> =>
      ipcRenderer.invoke("lsp:references", params) as Promise<LspLocation[]>,
    hover: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }): Promise<LspHoverResult | null> =>
      ipcRenderer.invoke("lsp:hover", params) as Promise<LspHoverResult | null>,
    implementation: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }): Promise<LspLocation[]> =>
      ipcRenderer.invoke("lsp:implementation", params) as Promise<LspLocation[]>,
    documentSymbols: (params: { projectRoot: string; filePath: string }): Promise<LspSymbol[]> =>
      ipcRenderer.invoke("lsp:documentSymbols", params) as Promise<LspSymbol[]>,
    workspaceSymbol: (params: { projectRoot: string; query: string }): Promise<LspSymbol[]> =>
      ipcRenderer.invoke("lsp:workspaceSymbol", params) as Promise<LspSymbol[]>,
    diagnostics: (params: { projectRoot: string; filePath?: string }): Promise<LspDiagnostic[]> =>
      ipcRenderer.invoke("lsp:diagnostics", params) as Promise<LspDiagnostic[]>,
    prepareCallHierarchy: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }): Promise<LspCallHierarchyItem[]> =>
      ipcRenderer.invoke("lsp:prepareCallHierarchy", params) as Promise<LspCallHierarchyItem[]>,
    incomingCalls: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }): Promise<LspCallHierarchyIncomingCall[]> =>
      ipcRenderer.invoke("lsp:incomingCalls", params) as Promise<LspCallHierarchyIncomingCall[]>,
    outgoingCalls: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }): Promise<LspCallHierarchyOutgoingCall[]> =>
      ipcRenderer.invoke("lsp:outgoingCalls", params) as Promise<LspCallHierarchyOutgoingCall[]>,
    detectJavaProject: (dirPath: string): Promise<boolean> =>
      ipcRenderer.invoke("lsp:detectJavaProject", dirPath) as Promise<boolean>,
    onDiagnostics: (callback: (diagnostics: LspDiagnostic[]) => void): (() => void) => {
      const handler = (_: unknown, diagnostics: LspDiagnostic[]): void => {
        callback(diagnostics)
      }
      ipcRenderer.on("lsp:diagnostics", handler)
      return () => {
        ipcRenderer.removeListener("lsp:diagnostics", handler)
      }
    },
    onChanged: (callback: () => void): (() => void) => {
      const handler = (): void => {
        callback()
      }
      ipcRenderer.on("lsp:changed", handler)
      return () => {
        ipcRenderer.removeListener("lsp:changed", handler)
      }
    },
    onDownloadState: (callback: (state: LspDownloadState) => void): (() => void) => {
      const handler = (_: unknown, state: LspDownloadState): void => {
        callback(state)
      }
      ipcRenderer.on("lsp:download-state", handler)
      return () => {
        ipcRenderer.removeListener("lsp:download-state", handler)
      }
    }
  },
  terminal: {
    create: (opts: {
      workDir?: string
      args?: string[]
      cols?: number
      rows?: number
      claudeModelId?: string
      syncSkills?: boolean
      syncMemory?: boolean
      launchSource?: "select_dir" | "restart"
    }): Promise<string> => ipcRenderer.invoke("terminal:create", opts),
    write: (id: string, data: string): void => ipcRenderer.send("terminal:write", { id, data }),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send("terminal:resize", { id, cols, rows }),
    dispose: (id: string): Promise<void> => ipcRenderer.invoke("terminal:dispose", id),
    selectDir: (): Promise<string | null> => ipcRenderer.invoke("terminal:selectDir"),
    ack: (id: string, bytes: number): void => ipcRenderer.send("terminal:ack", { id, bytes }),
    onData: (id: string, callback: (data: string, bytes: number) => void): (() => void) => {
      const channel = `terminal:data:${id}`
      const handler = (_: unknown, data: string, bytes: number): void => {
        callback(data, bytes)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    onExit: (id: string, callback: (code: number | null) => void): (() => void) => {
      const channel = `terminal:exit:${id}`
      // code 为 null 时表示主进程因 host 通信故障/spawn 失败强制 tear-down，没有真实退出码
      const handler = (_: unknown, code: number | null): void => {
        callback(code)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    }
  },
  keepAwake: {
    get: (): Promise<boolean> => ipcRenderer.invoke("keepAwake:get"),
    set: (enabled: boolean): Promise<void> => ipcRenderer.invoke("keepAwake:set", enabled)
  },
  scheduledTasks: {
    list: (): Promise<ScheduledTask[]> => ipcRenderer.invoke("scheduledTasks:list"),
    create: (config: ScheduledTaskUpsert): Promise<{ id: string }> =>
      ipcRenderer.invoke("scheduledTasks:create", config),
    update: (config: ScheduledTaskUpsert & { id: string }): Promise<{ id: string }> =>
      ipcRenderer.invoke("scheduledTasks:update", config),
    delete: (id: string): Promise<void> => ipcRenderer.invoke("scheduledTasks:delete", id),
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("scheduledTasks:setEnabled", { id, enabled }),
    runNow: (id: string): Promise<void> => ipcRenderer.invoke("scheduledTasks:runNow", id),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke("scheduledTasks:cancel", id),
    isRunning: (id: string): Promise<boolean> => ipcRenderer.invoke("scheduledTasks:isRunning", id),
    onChanged: (callback: () => void): (() => void) => {
      const handler = (): void => {
        callback()
      }
      ipcRenderer.on("scheduledTasks:changed", handler)
      return () => {
        ipcRenderer.removeListener("scheduledTasks:changed", handler)
      }
    },
    listenToStream: (
      threadId: string,
      callback: (event: { type: string; [key: string]: unknown }) => void
    ): (() => void) => {
      const channel = `scheduler:stream:${threadId}`
      const handler = (_: unknown, data: { type: string; [key: string]: unknown }): void => {
        callback(data)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    listenToThreadActivity: (
      callback: (activity: { threadId: string; type: string }) => void
    ): (() => void) => {
      const channel = "scheduler:thread-activity"
      const handler = (_: unknown, activity: { threadId: string; type: string }): void => {
        callback(activity)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    }
  },
  memory: {
    listProjects: (request?: {
      workspacePath?: string | null
      requestScope?: string
      cursor?: string
      limit?: number
    }): Promise<{
      items: Array<{
        projectId: string
        displayName: string
        memoryDir: string
        gitRoot?: string
        fileCount: number
        totalSize: number
        indexSize: number
        isCurrent: boolean
      }>
      nextCursor?: string
      hasMore: boolean
      totalCount: number
      truncated: boolean
      truncatedReasons: string[]
      scanStats: { scannedEntries: number; scannedFiles: number; readBytes: number }
    }> => ipcRenderer.invoke("memory:listProjects", request),
    listFiles: (request?: {
      scope?: "global" | "project"
      workspacePath?: string | null
      projectId?: string | null
      requestScope?: string
      cursor?: string
      limit?: number
    }): Promise<{
      items: Array<{
        name: string
        size: number
        modifiedAt: string
        type: "user" | "feedback" | "project" | "reference" | null
        displayName: string | null
        description: string | null
        recallCount: number
      }>
      nextCursor?: string
      hasMore: boolean
      totalCount: number
      truncated: boolean
      truncatedReasons: string[]
      scanStats: { scannedEntries: number; scannedFiles: number; readBytes: number }
      stats: {
        fileCount: number
        totalSize: number
        indexSize: number
        enabled: boolean
        dreamEnabled: boolean
        dreamState: { lastRunAt: number; sessionsSinceLastRun: number }
        scope: "global" | "project"
        memoryDir: string
        projectId?: string
        gitRoot?: string
      }
    }> => ipcRenderer.invoke("memory:listFiles", request),
    readFile: (
      name: string,
      request?: {
        scope?: "global" | "project"
        workspacePath?: string | null
        projectId?: string | null
        requestScope?: string
      }
    ): Promise<{
      content: string
      bytesRead: number
      totalBytes: number
      truncated: boolean
      truncatedReason?: "response-bytes" | "file-size"
    }> => ipcRenderer.invoke("memory:readFile", name, request),
    cancelCatalog: (requestScope?: string): Promise<void> =>
      ipcRenderer.invoke("memory:cancelCatalog", requestScope),
    deleteFile: (
      name: string,
      request?: {
        scope?: "global" | "project"
        workspacePath?: string | null
        projectId?: string | null
      }
    ): Promise<void> => ipcRenderer.invoke("memory:deleteFile", name, request),
    getEnabled: (): Promise<boolean> => ipcRenderer.invoke("memory:getEnabled"),
    getProjectModeEnabled: (): Promise<boolean> =>
      ipcRenderer.invoke("memory:getProjectModeEnabled"),
    setEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("memory:setEnabled", enabled),
    getDreamEnabled: (): Promise<boolean> => ipcRenderer.invoke("memory:getDreamEnabled"),
    setDreamEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("memory:setDreamEnabled", enabled),
    getStats: (request?: {
      scope?: "global" | "project"
      workspacePath?: string | null
      projectId?: string | null
      requestScope?: string
    }): Promise<{
      fileCount: number
      totalSize: number
      indexSize: number
      enabled: boolean
      dreamEnabled: boolean
      dreamState: { lastRunAt: number; sessionsSinceLastRun: number }
      scope: "global" | "project"
      memoryDir: string
      projectId?: string
      gitRoot?: string
    }> => ipcRenderer.invoke("memory:getStats", request),
    consolidate: (request?: {
      scope?: "global" | "project"
      workspacePath?: string | null
      projectId?: string | null
    }): Promise<{
      archived: number
      merged: number
      created: number
      skipped: number
    }> => ipcRenderer.invoke("memory:consolidate", request),
    onChanged: (callback: () => void): (() => void) => {
      const handler = (): void => {
        callback()
      }
      ipcRenderer.on("memory:changed", handler)
      return () => {
        ipcRenderer.removeListener("memory:changed", handler)
      }
    }
  },
  taskMmd: {
    getSettings: (): Promise<TaskMmdSettings> =>
      ipcRenderer.invoke("taskMmd:getSettings") as Promise<TaskMmdSettings>,
    setSettings: (patch: Partial<TaskMmdSettings>): Promise<TaskMmdSettings> =>
      ipcRenderer.invoke("taskMmd:setSettings", patch) as Promise<TaskMmdSettings>,
    getSnapshot: (threadId: string): Promise<TaskMmdSnapshot> =>
      ipcRenderer.invoke("taskMmd:getSnapshot", threadId) as Promise<TaskMmdSnapshot>,
    clearThread: (threadId: string): Promise<void> =>
      ipcRenderer.invoke("taskMmd:clearThread", threadId) as Promise<void>,
    getDirectorySize: (threadId: string): Promise<number> =>
      ipcRenderer.invoke("taskMmd:getDirectorySize", threadId) as Promise<number>,
    getCompileModelInfo: (threadId: string): Promise<TaskMmdCompileModelInfo> =>
      ipcRenderer.invoke(
        "taskMmd:getCompileModelInfo",
        threadId
      ) as Promise<TaskMmdCompileModelInfo>,
    onChanged: (callback: (payload: { threadId?: string }) => void): (() => void) => {
      const handler = (_: unknown, payload: { threadId?: string }): void => {
        callback(payload ?? {})
      }
      ipcRenderer.on("taskMmd:changed", handler)
      return () => {
        ipcRenderer.removeListener("taskMmd:changed", handler)
      }
    }
  },
  autoCommit: {
    getSettings: (): Promise<AgentAutoCommitSettings> =>
      ipcRenderer.invoke("autoCommit:getSettings") as Promise<AgentAutoCommitSettings>,
    saveSettings: (updates: Partial<AgentAutoCommitSettings>): Promise<AgentAutoCommitSettings> =>
      ipcRenderer.invoke("autoCommit:saveSettings", updates) as Promise<AgentAutoCommitSettings>,
    getWorkspaceCard: (workspacePath: string): Promise<AgentAutoCommitWorkspaceCard> =>
      ipcRenderer.invoke(
        "autoCommit:getWorkspaceCard",
        workspacePath
      ) as Promise<AgentAutoCommitWorkspaceCard>,
    saveWorkspaceCard: (
      workspacePath: string,
      cardNumber?: string
    ): Promise<AgentAutoCommitWorkspaceCard> =>
      ipcRenderer.invoke("autoCommit:saveWorkspaceCard", {
        workspacePath,
        cardNumber
      }) as Promise<AgentAutoCommitWorkspaceCard>
  },
  expertAgents: {
    list: (): Promise<ExpertAgentEntry[]> =>
      ipcRenderer.invoke("expertAgents:list") as Promise<ExpertAgentEntry[]>,
    setEnabled: (name: string, enabled: boolean): Promise<string[]> =>
      ipcRenderer.invoke("expertAgents:setEnabled", { name, enabled }) as Promise<string[]>
  },
  taskCards: {
    list: (query?: TaskCardsQuery): Promise<TaskCardsListResult> =>
      ipcRenderer.invoke("taskCards:list", query) as Promise<TaskCardsListResult>
  },
  browser: createBrowserApi(),
  heartbeat: {
    getConfig: (): Promise<HeartbeatConfig> =>
      ipcRenderer.invoke("heartbeat:getConfig") as Promise<HeartbeatConfig>,
    saveConfig: (updates: Partial<HeartbeatConfig>): Promise<void> =>
      ipcRenderer.invoke("heartbeat:saveConfig", updates) as Promise<void>,
    getContent: (): Promise<string> =>
      ipcRenderer.invoke("heartbeat:getContent") as Promise<string>,
    saveContent: (content: string): Promise<void> =>
      ipcRenderer.invoke("heartbeat:saveContent", content) as Promise<void>,
    runNow: (): Promise<void> => ipcRenderer.invoke("heartbeat:runNow") as Promise<void>,
    cancel: (): Promise<void> => ipcRenderer.invoke("heartbeat:cancel") as Promise<void>,
    isRunning: (): Promise<boolean> =>
      ipcRenderer.invoke("heartbeat:isRunning") as Promise<boolean>,
    resetConfig: (): Promise<HeartbeatConfig> =>
      ipcRenderer.invoke("heartbeat:resetConfig") as Promise<HeartbeatConfig>,
    onChanged: (callback: () => void): (() => void) => {
      const handler = (): void => {
        callback()
      }
      ipcRenderer.on("heartbeat:changed", handler)
      return () => {
        ipcRenderer.removeListener("heartbeat:changed", handler)
      }
    },
    listenToStream: (
      threadId: string,
      callback: (event: { type: string; [key: string]: unknown }) => void
    ): (() => void) => {
      const channel = `heartbeat:stream:${threadId}`
      const handler = (_: unknown, data: { type: string; [key: string]: unknown }): void => {
        callback(data)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    }
  },
  builtinRobot: {
    getStatus: (): Promise<BuiltinRobotStatus> =>
      ipcRenderer.invoke("builtinRobot:getStatus") as Promise<BuiltinRobotStatus>,
    getRemoteAccess: (): Promise<BuiltinRobotRemoteAccessOverview> =>
      ipcRenderer.invoke(
        "builtinRobot:getRemoteAccess"
      ) as Promise<BuiltinRobotRemoteAccessOverview>,
    setThreadRemoteAccess: (
      threadId: string,
      enabled: boolean
    ): Promise<BuiltinRobotRemoteAccessOverview> =>
      ipcRenderer.invoke("builtinRobot:setThreadRemoteAccess", {
        id: threadId,
        enabled
      }) as Promise<BuiltinRobotRemoteAccessOverview>,
    setFeatureRemoteAccess: (
      projectId: string,
      featureSlug: string,
      enabled: boolean
    ): Promise<BuiltinRobotRemoteAccessOverview> =>
      ipcRenderer.invoke("builtinRobot:setFeatureRemoteAccess", {
        projectId,
        featureSlug,
        enabled
      }) as Promise<BuiltinRobotRemoteAccessOverview>,
    listGrantableFeatures: (): Promise<BuiltinRobotGrantableFeature[]> =>
      ipcRenderer.invoke("builtinRobot:listGrantableFeatures") as Promise<
        BuiltinRobotGrantableFeature[]
      >,
    saveSettings: (updates: Partial<BuiltinRobotSettings>): Promise<BuiltinRobotStatus> =>
      ipcRenderer.invoke("builtinRobot:saveSettings", updates) as Promise<BuiltinRobotStatus>,
    reconnect: (): Promise<BuiltinRobotStatus> =>
      ipcRenderer.invoke("builtinRobot:reconnect") as Promise<BuiltinRobotStatus>,
    disconnect: (): Promise<BuiltinRobotStatus> =>
      ipcRenderer.invoke("builtinRobot:disconnect") as Promise<BuiltinRobotStatus>,
    cleanupLegacy: (): Promise<BuiltinRobotStatus> =>
      ipcRenderer.invoke("builtinRobot:cleanupLegacy", {
        confirmed: true
      }) as Promise<BuiltinRobotStatus>,
    onStatus: (callback: (status: BuiltinRobotStatus) => void): (() => void) => {
      const handler = (_event: unknown, status: BuiltinRobotStatus): void => callback(status)
      ipcRenderer.on("builtinRobot:status", handler)
      return () => ipcRenderer.removeListener("builtinRobot:status", handler)
    }
  },
  skillEvolution: {
    // ── Phase 1: Intent banner ("Want to save as skill?") ──────────
    onIntentRequest: (
      callback: (req: {
        threadId?: string
        requestId: string
        summary: string
        toolCallCount: number
        turnCount: number
        mode: "mode_a_rule" | "mode_b_llm"
        recommendationReason?: string
        context: unknown
      }) => void
    ): (() => void) => {
      const handler = (
        _: unknown,
        req: {
          threadId?: string
          requestId: string
          summary: string
          toolCallCount: number
          turnCount: number
          mode: "mode_a_rule" | "mode_b_llm"
          recommendationReason?: string
          context: unknown
        }
      ): void => {
        callback(req)
      }
      ipcRenderer.on("skill:intentRequest", handler)
      return () => {
        ipcRenderer.removeListener("skill:intentRequest", handler)
      }
    },
    intentResponse: (requestId: string, accepted: boolean): Promise<void> =>
      ipcRenderer.invoke("skill:intentResponse", { requestId, accepted }) as Promise<void>,
    retryGeneration: (
      threadId: string,
      retryContext: { context: unknown; intentMode: string }
    ): Promise<void> =>
      ipcRenderer.invoke("skill:retryGeneration", {
        threadId,
        context: retryContext.context,
        intentMode: retryContext.intentMode
      }) as Promise<void>,

    // ── Phase 2: Full confirmation dialog ("Adopt / Reject") ───────
    onConfirmRequest: (
      callback: (req: {
        threadId?: string
        requestId: string
        skillId: string
        name: string
        description: string
        content: string
      }) => void
    ): (() => void) => {
      const handler = (
        _: unknown,
        req: {
          threadId?: string
          requestId: string
          skillId: string
          name: string
          description: string
          content: string
        }
      ): void => {
        callback(req)
      }
      ipcRenderer.on("skill:confirmRequest", handler)
      return () => {
        ipcRenderer.removeListener("skill:confirmRequest", handler)
      }
    },
    confirmResponse: (requestId: string, approved: boolean, content?: string): Promise<void> =>
      ipcRenderer.invoke("skill:confirmResponse", {
        requestId,
        approved,
        content
      }) as Promise<void>,

    // ── Streaming generation progress ──────────────────────────
    onGenerating: (
      callback: (event: {
        threadId?: string
        phase: "start" | "token" | "done" | "error"
        text: string
      }) => void
    ): (() => void) => {
      const handler = (
        _: unknown,
        evt: {
          threadId?: string
          phase: "start" | "token" | "done" | "error"
          text: string
        }
      ): void => {
        callback(evt)
      }
      ipcRenderer.on("skill:generating", handler)
      return () => {
        ipcRenderer.removeListener("skill:generating", handler)
      }
    }
  },
  plugins: {
    list: (): Promise<PluginMetadata[]> =>
      ipcRenderer.invoke("plugins:list") as Promise<PluginMetadata[]>,
    install: (
      buffer: ArrayBuffer,
      fileName: string,
      origin?: "market" | "local",
      version?: string
    ): Promise<{ success: boolean; pluginName?: string; error?: string }> =>
      ipcRenderer.invoke("plugins:install", { buffer, fileName, origin, version }) as Promise<{
        success: boolean
        pluginName?: string
        error?: string
      }>,
    installFromDir: (): Promise<{ success: boolean; pluginName?: string; error?: string }> =>
      ipcRenderer.invoke("plugins:installFromDir") as Promise<{
        success: boolean
        pluginName?: string
        error?: string
      }>,
    exportForMarket: (
      id: string,
      options?: { version?: string | null }
    ): Promise<{ success: boolean; fileName?: string; buffer?: ArrayBuffer; error?: string }> =>
      ipcRenderer.invoke("plugins:exportForMarket", { id, version: options?.version }) as Promise<{
        success: boolean
        fileName?: string
        buffer?: ArrayBuffer
        error?: string
      }>,
    delete: (id: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("plugins:delete", id) as Promise<{ success: boolean; error?: string }>,
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("plugins:setEnabled", { id, enabled }) as Promise<void>,
    setOriginsBatch: (
      updates: Array<{ id: string; origin: "market" | "local" }>
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("plugins:setOriginsBatch", { updates }) as Promise<{
        success: boolean
        error?: string
      }>,
    getDetail: (id: string): Promise<PluginDetail> =>
      ipcRenderer.invoke("plugins:getDetail", id) as Promise<PluginDetail>,
    inspectZip: (buffer: ArrayBuffer): Promise<PluginDetail> =>
      ipcRenderer.invoke("plugins:inspectZip", { buffer }) as Promise<PluginDetail>,
    listHooks: (): Promise<PluginHookMetadata[]> =>
      ipcRenderer.invoke("plugins:listHooks") as Promise<PluginHookMetadata[]>,
    setHookEnabled: (
      pluginId: string,
      hookId: string,
      enabled: boolean
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("plugins:setHookEnabled", {
        pluginId,
        hookId,
        enabled
      }) as Promise<{ success: boolean; error?: string }>,
    listFiles: (
      pluginId: string
    ): Promise<{
      success: boolean
      files?: Array<{ path: string; relativePath: string; editable: boolean }>
      root?: string
      pluginEditable?: boolean
      error?: string
    }> =>
      ipcRenderer.invoke("plugins:listFiles", pluginId) as Promise<{
        success: boolean
        files?: Array<{ path: string; relativePath: string; editable: boolean }>
        root?: string
        pluginEditable?: boolean
        error?: string
      }>,
    readFile: (
      pluginId: string,
      filePath: string
    ): Promise<{ success: boolean; content?: string; editable?: boolean; error?: string }> =>
      ipcRenderer.invoke("plugins:read", { pluginId, filePath }) as Promise<{
        success: boolean
        content?: string
        editable?: boolean
        error?: string
      }>,
    writeFile: (
      pluginId: string,
      filePath: string,
      content: string
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("plugins:write", { pluginId, filePath, content }) as Promise<{
        success: boolean
        error?: string
      }>
  },
  sandbox: {
    getMode: (): Promise<"none" | "unelevated" | "readonly" | "elevated"> =>
      ipcRenderer.invoke("sandbox:getMode") as Promise<
        "none" | "unelevated" | "readonly" | "elevated"
      >,
    setMode: (mode: "none" | "unelevated" | "readonly" | "elevated"): Promise<void> =>
      ipcRenderer.invoke("sandbox:setMode", mode) as Promise<void>,
    checkElevatedSetup: (): Promise<{ setupComplete: boolean }> =>
      ipcRenderer.invoke("sandbox:checkElevatedSetup") as Promise<{ setupComplete: boolean }>,
    runElevatedSetup: (workspacePaths?: string[]): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("sandbox:runElevatedSetup", workspacePaths) as Promise<{
        success: boolean
        error?: string
      }>,
    getYoloMode: (): Promise<boolean> =>
      ipcRenderer.invoke("sandbox:getYoloMode") as Promise<boolean>,
    setYoloMode: (yolo: boolean): Promise<void> =>
      ipcRenderer.invoke("sandbox:setYoloMode", yolo) as Promise<void>,
    getFailureFuseWarning: (): Promise<boolean> =>
      ipcRenderer.invoke("sandbox:getFailureFuseWarning") as Promise<boolean>,
    setFailureFuseWarning: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("sandbox:setFailureFuseWarning", enabled) as Promise<void>,
    getFailureFuseModelFeedback: (): Promise<boolean> =>
      ipcRenderer.invoke("sandbox:getFailureFuseModelFeedback") as Promise<boolean>,
    setFailureFuseModelFeedback: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("sandbox:setFailureFuseModelFeedback", enabled) as Promise<void>,
    getFailureFuseDebug: (): Promise<boolean> =>
      ipcRenderer.invoke("sandbox:getFailureFuseDebug") as Promise<boolean>,
    setFailureFuseDebug: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("sandbox:setFailureFuseDebug", enabled) as Promise<void>,
    getPendingApprovals: (threadId: string): Promise<unknown[]> =>
      ipcRenderer.invoke("sandbox:getPendingApprovals", threadId) as Promise<unknown[]>,
    // NUX (first-run sandbox setup)
    isNuxNeeded: (): Promise<boolean> =>
      ipcRenderer.invoke("sandbox:isNuxNeeded") as Promise<boolean>,
    completeNux: (mode: "elevated" | "unelevated" | "none"): Promise<void> =>
      ipcRenderer.invoke("sandbox:completeNux", mode) as Promise<void>,
    // Approval rules management
    getApprovalRules: (): Promise<Array<{ pattern: string; decision: string }>> =>
      ipcRenderer.invoke("sandbox:getApprovalRules") as Promise<
        Array<{ pattern: string; decision: string }>
      >,
    deleteApprovalRule: (pattern: string): Promise<void> =>
      ipcRenderer.invoke("sandbox:deleteApprovalRule", pattern) as Promise<void>,
    // Approval decision from renderer → main
    sendApprovalDecision: (decision: {
      requestId: string
      type: "approve" | "approve_session" | "approve_permanent" | "reject" | "error"
      tool_call_id: string
      savedToolName?: string
      savedToolDescription?: string
      commitResult?: { success: boolean; commitMessage?: string; error?: string }
      pushResult?: { success: boolean; error?: string }
    }): void => {
      ipcRenderer.send("sandbox:approvalDecision", decision)
    },
    // Listen for approval requests from main → renderer
    onApprovalRequest: (threadId: string, callback: (request: unknown) => void): (() => void) => {
      const channel = `approval:request:${threadId}`
      const handler = (_: unknown, data: unknown): void => {
        callback(data)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    // Listen for approval decisions completed outside the desktop renderer (for example via IM).
    onApprovalResolved: (
      threadId: string,
      callback: (data: { requestId: string; decision: "approve" | "reject" }) => void
    ): (() => void) => {
      const channel = `approval:resolved:${threadId}`
      const handler = (
        _: unknown,
        data: { requestId: string; decision: "approve" | "reject" }
      ): void => {
        callback(data)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    // Listen for approval timeout notifications from main → renderer
    onApprovalTimeout: (
      threadId: string,
      callback: (data: { requestId: string }) => void
    ): (() => void) => {
      const channel = `approval:timeout:${threadId}`
      const handler = (_: unknown, data: { requestId: string }): void => {
        callback(data)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    // Listen for approval cancel notifications from main → renderer
    onApprovalCancel: (
      threadId: string,
      callback: (data: { requestId: string; reason?: string }) => void
    ): (() => void) => {
      const channel = `approval:cancel:${threadId}`
      const handler = (_: unknown, data: { requestId: string; reason?: string }): void => {
        callback(data)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    onChanged: (callback: () => void): (() => void) => {
      const handler = (): void => {
        callback()
      }
      ipcRenderer.on("sandbox:changed", handler)
      return () => {
        ipcRenderer.removeListener("sandbox:changed", handler)
      }
    }
  },
  userInput: {
    sendResponse: (response: UserInputResponse): void => {
      ipcRenderer.send("userInput:response", response)
    },
    getPending: (threadId: string): Promise<UserInputRequest | null> =>
      ipcRenderer.invoke("userInput:getPending", threadId) as Promise<UserInputRequest | null>,
    onRequest: (threadId: string, callback: (request: UserInputRequest) => void): (() => void) => {
      const channel = `userInput:request:${threadId}`
      const handler = (_: unknown, request: UserInputRequest): void => {
        ipcRenderer.send("userInput:ack", {
          requestId: request.requestId,
          threadId: request.threadId
        })
        callback(request)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    onCancel: (
      threadId: string,
      callback: (data: { requestId: string; reason?: string }) => void
    ): (() => void) => {
      const channel = `userInput:cancel:${threadId}`
      const handler = (_: unknown, data: { requestId: string; reason?: string }): void => {
        callback(data)
      }
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    }
  },
  optimizer: {
    /** Run the offline optimization loop — returns candidates for review */
    run: (opts?: {
      threadId?: string
      traceLimit?: number
      mode?: "auto" | "selected"
      traceIds?: string[]
    }): Promise<{
      startedAt: string
      endedAt: string
      tracesAnalyzed: number
      candidates: Array<{
        candidateId: string
        action: "create" | "patch"
        skillId: string
        name: string
        description: string
        proposedContent: string
        rationale: string
        sourceTraceIds: string[]
        generatedAt: string
        status: "pending" | "approved" | "rejected"
      }>
      summary: string
    }> =>
      ipcRenderer.invoke("optimizer:run", opts) as Promise<{
        startedAt: string
        endedAt: string
        tracesAnalyzed: number
        candidates: Array<{
          candidateId: string
          action: "create" | "patch"
          skillId: string
          name: string
          description: string
          proposedContent: string
          rationale: string
          sourceTraceIds: string[]
          generatedAt: string
          status: "pending" | "approved" | "rejected"
        }>
        summary: string
      }>,
    /** Listen to selected-trace optimizer progress (serial task updates). */
    onRunProgress: (
      cb: (payload: {
        runId: string
        traceId: string
        index: number
        total: number
        status: "pending" | "running" | "completed" | "failed"
        message?: string
        candidateCount?: number
      }) => void
    ): (() => void) => {
      const handler = (_: unknown, payload: unknown) =>
        cb(
          payload as {
            runId: string
            traceId: string
            index: number
            total: number
            status: "pending" | "running" | "completed" | "failed"
            message?: string
            candidateCount?: number
          }
        )
      ipcRenderer.on("optimizer:runProgress", handler)
      return () => ipcRenderer.removeListener("optimizer:runProgress", handler)
    },
    /** Listen to optimizer LLM stream start (resets buffer). */
    onStreamStart: (cb: () => void): (() => void) => {
      const handler = () => cb()
      ipcRenderer.on("optimizer:streamStart", handler)
      return () => ipcRenderer.removeListener("optimizer:streamStart", handler)
    },
    /** Listen to optimizer LLM stream chunks. */
    onStreamChunk: (cb: (payload: { chunk: string }) => void): (() => void) => {
      const handler = (_: unknown, payload: unknown) => cb(payload as { chunk: string })
      ipcRenderer.on("optimizer:streamChunk", handler)
      return () => ipcRenderer.removeListener("optimizer:streamChunk", handler)
    },
    /** Listen to optimizer LLM stream end. */
    onStreamEnd: (cb: (payload: { success: boolean; error?: string }) => void): (() => void) => {
      const handler = (_: unknown, payload: unknown) =>
        cb(payload as { success: boolean; error?: string })
      ipcRenderer.on("optimizer:streamEnd", handler)
      return () => ipcRenderer.removeListener("optimizer:streamEnd", handler)
    },
    /** Get current in-memory candidates */
    getCandidates: (): Promise<
      Array<{
        candidateId: string
        action: "create" | "patch"
        skillId: string
        name: string
        description: string
        proposedContent: string
        rationale: string
        sourceTraceIds: string[]
        generatedAt: string
        status: "pending" | "approved" | "rejected"
      }>
    > =>
      ipcRenderer.invoke("optimizer:candidates") as Promise<
        Array<{
          candidateId: string
          action: "create" | "patch"
          skillId: string
          name: string
          description: string
          proposedContent: string
          rationale: string
          sourceTraceIds: string[]
          generatedAt: string
          status: "pending" | "approved" | "rejected"
        }>
      >,
    /** Approve a candidate — writes the skill to disk */
    approve: (
      candidateId: string,
      proposedContent?: string
    ): Promise<{ success: boolean; skillId?: string; error?: string }> =>
      ipcRenderer.invoke("optimizer:approve", { candidateId, proposedContent }) as Promise<{
        success: boolean
        skillId?: string
        error?: string
      }>,
    /** Reject a candidate */
    reject: (candidateId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke("optimizer:reject", { candidateId }) as Promise<{ success: boolean }>,
    /** Clear all candidates */
    clear: (): Promise<void> => ipcRenderer.invoke("optimizer:clear") as Promise<void>,
    /** List recent traces (metadata only) */
    getTraces: (opts?: {
      threadId?: string
      limit?: number
    }): Promise<
      Array<{
        traceId: string
        threadId: string
        observabilitySchemaVersion?: number
        traceKind?: string
        executionMode?: string
        rootTraceId?: string
        rootThreadId?: string
        parentTraceId?: string
        parentThreadId?: string
        parentSpanId?: string
        linkType?: string
        subagentKind?: string
        subagentRunId?: string
        subagentThreadId?: string
        handoffAction?: string
        handoffSourceAgent?: string
        handoffTargetAgent?: string
        coordinatorWorkerId?: string
        coordinatorWorkerTurn?: number
        coordinatorWorkerRole?: string
        coordinatorWorkerWorkload?: string
        workflowRunId?: string
        workflowAgentIndex?: number
        workflowPhase?: string
        workflowAgentLabel?: string
        startedAt: string
        durationMs: number
        userMessage: string
        totalToolCalls: number
        totalInputTokens: number
        totalOutputTokens: number
        totalTokens: number
        outcome: string
        usedSkills: string[]
        evolvedSkills: string[]
        triggerSource?: string
      }>
    > =>
      ipcRenderer.invoke("optimizer:traces", opts) as Promise<
        Array<{
          traceId: string
          threadId: string
          observabilitySchemaVersion?: number
          traceKind?: string
          executionMode?: string
          rootTraceId?: string
          rootThreadId?: string
          parentTraceId?: string
          parentThreadId?: string
          parentSpanId?: string
          linkType?: string
          subagentKind?: string
          subagentRunId?: string
          subagentThreadId?: string
          handoffAction?: string
          handoffSourceAgent?: string
          handoffTargetAgent?: string
          coordinatorWorkerId?: string
          coordinatorWorkerTurn?: number
          coordinatorWorkerRole?: string
          coordinatorWorkerWorkload?: string
          workflowRunId?: string
          workflowAgentIndex?: number
          workflowPhase?: string
          workflowAgentLabel?: string
          startedAt: string
          durationMs: number
          userMessage: string
          totalToolCalls: number
          totalInputTokens: number
          totalOutputTokens: number
          totalTokens: number
          outcome: string
          usedSkills: string[]
          evolvedSkills: string[]
          triggerSource?: string
        }>
      >,
    /** Listen for auto-triggered skill evolution (main process fires this after threshold) */
    onAutoTriggered: (
      cb: (payload: { threadId: string; toolCallCount: number }) => void
    ): (() => void) => {
      const handler = (_: unknown, payload: unknown) =>
        cb(payload as { threadId: string; toolCallCount: number })
      ipcRenderer.on("optimizer:autoTriggered", handler)
      return () => ipcRenderer.removeListener("optimizer:autoTriggered", handler)
    },
    /** Get full trace detail (steps + tool calls) by traceId */
    getTraceDetail: (
      traceId: string
    ): Promise<{
      traceId: string
      threadId: string
      observabilitySchemaVersion?: number
      traceKind?: string
      executionMode?: string
      rootTraceId?: string
      rootThreadId?: string
      parentTraceId?: string
      parentThreadId?: string
      parentSpanId?: string
      linkType?: string
      subagentKind?: string
      subagentRunId?: string
      subagentThreadId?: string
      handoffAction?: string
      handoffSourceAgent?: string
      handoffTargetAgent?: string
      coordinatorWorkerId?: string
      coordinatorWorkerTurn?: number
      coordinatorWorkerRole?: string
      coordinatorWorkerWorkload?: string
      workflowRunId?: string
      workflowAgentIndex?: number
      workflowPhase?: string
      workflowAgentLabel?: string
      startedAt: string
      endedAt: string
      durationMs: number
      userMessage: string
      modelId: string
      totalToolCalls: number
      outcome: string
      errorMessage?: string
      usedSkills: string[]
      evolvedSkills: string[]
      triggerSource?: string
      nodes?: Array<{
        id: string
        type: "trace" | "llm" | "tool" | "tool_result" | "message" | "error" | "cancel"
        parentId: string | null
        name?: string
        status?: "running" | "success" | "error" | "cancelled" | "unknown"
        startedAt: string
        endedAt?: string
        input?: unknown
        output?: unknown
        metadata?: Record<string, unknown>
      }>
      modelCalls?: Array<{
        messageId?: string
        startedAt: string
        inputMessages: Array<{
          role: "system" | "user" | "assistant" | "tool" | "unknown"
          content: string
          name?: string
          toolCallId?: string
        }>
        outputMessage: {
          role: "system" | "user" | "assistant" | "tool" | "unknown"
          content: string
          name?: string
          toolCallId?: string
        }
        toolCalls: Array<{
          name: string
          args: Record<string, unknown>
          result?: string
          durationMs?: number
        }>
        tokenUsage?: {
          inputTokens?: number
          outputTokens?: number
          totalTokens?: number
          cacheReadTokens?: number
          cacheCreationTokens?: number
        }
      }>
      steps: Array<{
        index: number
        startedAt: string
        assistantText: string
        toolCalls: Array<{
          name: string
          args: Record<string, unknown>
          result?: string
          durationMs?: number
        }>
      }>
    } | null> =>
      ipcRenderer.invoke("optimizer:traceDetail", { traceId }) as Promise<{
        traceId: string
        threadId: string
        observabilitySchemaVersion?: number
        traceKind?: string
        executionMode?: string
        rootTraceId?: string
        rootThreadId?: string
        parentTraceId?: string
        parentThreadId?: string
        parentSpanId?: string
        linkType?: string
        subagentKind?: string
        subagentRunId?: string
        subagentThreadId?: string
        handoffAction?: string
        handoffSourceAgent?: string
        handoffTargetAgent?: string
        coordinatorWorkerId?: string
        coordinatorWorkerTurn?: number
        coordinatorWorkerRole?: string
        coordinatorWorkerWorkload?: string
        workflowRunId?: string
        workflowAgentIndex?: number
        workflowPhase?: string
        workflowAgentLabel?: string
        startedAt: string
        endedAt: string
        durationMs: number
        userMessage: string
        modelId: string
        totalToolCalls: number
        outcome: string
        errorMessage?: string
        usedSkills: string[]
        evolvedSkills: string[]
        triggerSource?: string
        nodes?: Array<{
          id: string
          type: "trace" | "llm" | "tool" | "tool_result" | "message" | "error" | "cancel"
          parentId: string | null
          name?: string
          status?: "running" | "success" | "error" | "cancelled" | "unknown"
          startedAt: string
          endedAt?: string
          input?: unknown
          output?: unknown
          metadata?: Record<string, unknown>
        }>
        modelCalls?: Array<{
          messageId?: string
          startedAt: string
          inputMessages: Array<{
            role: "system" | "user" | "assistant" | "tool" | "unknown"
            content: string
            name?: string
            toolCallId?: string
          }>
          outputMessage: {
            role: "system" | "user" | "assistant" | "tool" | "unknown"
            content: string
            name?: string
            toolCallId?: string
          }
          toolCalls: Array<{
            name: string
            args: Record<string, unknown>
            result?: string
            durationMs?: number
          }>
          tokenUsage?: {
            inputTokens?: number
            outputTokens?: number
            totalTokens?: number
            cacheReadTokens?: number
            cacheCreationTokens?: number
          }
        }>
        steps: Array<{
          index: number
          startedAt: string
          assistantText: string
          toolCalls: Array<{
            name: string
            args: Record<string, unknown>
            result?: string
            durationMs?: number
          }>
        }>
      } | null>,
    deleteTraces: (
      traceIds: string[]
    ): Promise<{
      deletedIds: string[]
      failed: Array<{ traceId: string; error: string }>
    }> =>
      ipcRenderer.invoke("optimizer:deleteTraces", { traceIds }) as Promise<{
        deletedIds: string[]
        failed: Array<{ traceId: string; error: string }>
      }>,
    getOnlineSkillEvolutionEnabled: (): Promise<boolean> =>
      ipcRenderer.invoke("optimizer:getOnlineSkillEvolutionEnabled") as Promise<boolean>,
    setOnlineSkillEvolutionEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("optimizer:setOnlineSkillEvolutionEnabled", enabled) as Promise<void>,
    getAutoPropose: (): Promise<boolean> =>
      ipcRenderer.invoke("optimizer:getAutoPropose") as Promise<boolean>,
    setAutoPropose: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("optimizer:setAutoPropose", enabled) as Promise<void>,
    getThreshold: (): Promise<number> =>
      ipcRenderer.invoke("optimizer:getThreshold") as Promise<number>,
    setThreshold: (value: number): Promise<void> =>
      ipcRenderer.invoke("optimizer:setThreshold", value) as Promise<void>,
    getTurnThreshold: (): Promise<number> =>
      ipcRenderer.invoke("optimizer:getTurnThreshold") as Promise<number>,
    setTurnThreshold: (value: number): Promise<void> =>
      ipcRenderer.invoke("optimizer:setTurnThreshold", value) as Promise<void>
  },
  hooks: {
    catalog: {
      read: (input: HookCatalogPageInput): Promise<HookCatalogPage> =>
        ipcRenderer.invoke("hooks:catalog:read", input) as Promise<HookCatalogPage>,
      cancel: (requestScope: string): Promise<void> =>
        ipcRenderer.invoke("hooks:catalog:cancel", requestScope) as Promise<void>
    },
    list: (): Promise<HookConfig[]> => ipcRenderer.invoke("hooks:list"),
    skills: {
      list: (): Promise<SkillHookMetadata[]> => ipcRenderer.invoke("hooks:skills:list")
    },
    onChanged: (callback: (data: { reason?: string; at: string }) => void): (() => void) => {
      const handler = (_: unknown, data: { reason?: string; at: string }): void => {
        callback(data)
      }
      ipcRenderer.on("hooks:changed", handler)
      return () => {
        ipcRenderer.removeListener("hooks:changed", handler)
      }
    },
    create: (config: HookUpsert): Promise<{ id: string }> =>
      ipcRenderer.invoke("hooks:create", config),
    update: (config: HookUpsert & { id: string }): Promise<{ id: string }> =>
      ipcRenderer.invoke("hooks:update", config),
    delete: (id: string): Promise<void> => ipcRenderer.invoke("hooks:delete", id),
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("hooks:setEnabled", { id, enabled }),
    workspace: {
      list: (workspacePath: string): Promise<HookConfig[]> =>
        ipcRenderer.invoke("hooks:workspace:list", workspacePath),
      untrusted: (
        workspacePath: string
      ): Promise<{ fileName: string; filePath: string; event: string; command: string }[]> =>
        ipcRenderer.invoke("hooks:workspace:untrusted", workspacePath),
      trustAll: (workspacePath: string): Promise<void> =>
        ipcRenderer.invoke("hooks:workspace:trustAll", workspacePath),
      trustFile: (workspacePath: string, fileName: string, filePath: string): Promise<void> =>
        ipcRenderer.invoke("hooks:workspace:trustFile", { workspacePath, fileName, filePath }),
      // PR-11 — fire Setup(maintenance) for the current workspace.
      runSetupMaintenance: (workspacePath: string): Promise<void> =>
        ipcRenderer.invoke("hooks:setup:maintenance", workspacePath),
      onChanged: (
        callback: (data: { threadId: string; workspacePath: string }) => void
      ): (() => void) => {
        const handler = (_: unknown, data: { threadId: string; workspacePath: string }): void => {
          callback(data)
        }
        ipcRenderer.on("hooks:workspace:changed", handler)
        return () => {
          ipcRenderer.removeListener("hooks:workspace:changed", handler)
        }
      }
    },
    logging: {
      get: (): Promise<HookLoggingConfig> => ipcRenderer.invoke("hooks:logging:get"),
      save: (updates: Partial<HookLoggingConfig>): Promise<HookLoggingConfig> =>
        ipcRenderer.invoke("hooks:logging:save", updates),
      getLogDir: (): Promise<string> => ipcRenderer.invoke("hooks:logging:getLogDir"),
      openLogDir: (): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke("hooks:logging:openLogDir"),
      onChanged: (callback: (config: HookLoggingConfig) => void): (() => void) => {
        const handler = (
          _: unknown,
          data: { config: HookLoggingConfig; at: string } | HookLoggingConfig
        ): void => {
          callback("config" in data ? data.config : data)
        }
        ipcRenderer.on("hooks:logging:changed", handler)
        return () => {
          ipcRenderer.removeListener("hooks:logging:changed", handler)
        }
      }
    }
  },
  codeExecTools: {
    list: (): Promise<ManagedSavedCodeExecTool[]> => ipcRenderer.invoke("codeExecTools:list"),
    getSettings: (): Promise<{ codeExecEnabled: boolean }> =>
      ipcRenderer.invoke("codeExecTools:getSettings"),
    setCodeExecEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("codeExecTools:setCodeExecEnabled", enabled),
    setEnabled: (id: string, enabled: boolean): Promise<ManagedSavedCodeExecTool> =>
      ipcRenderer.invoke("codeExecTools:setEnabled", { id, enabled }),
    setLastPreviewParams: (
      id: string,
      params: Record<string, unknown>
    ): Promise<ManagedSavedCodeExecTool> =>
      ipcRenderer.invoke("codeExecTools:setLastPreviewParams", { id, params }),
    rewrite: (payload: SavedCodeExecRewritePayload): Promise<SavedCodeExecRewriteResult> =>
      ipcRenderer.invoke("codeExecTools:rewrite", payload),
    update: (payload: SavedCodeExecToolUpdatePayload): Promise<ManagedSavedCodeExecTool> =>
      ipcRenderer.invoke("codeExecTools:update", payload),
    delete: (id: string): Promise<void> => ipcRenderer.invoke("codeExecTools:delete", id),
    runPreview: (payload: SavedCodeExecPreviewPayload): Promise<SavedCodeExecPreviewResult> =>
      ipcRenderer.invoke("codeExecTools:runPreview", payload)
  },
  routing: {
    getMode: (): Promise<"auto" | "pinned"> => ipcRenderer.invoke("routing:getMode"),
    setMode: (mode: "auto" | "pinned"): Promise<void> => ipcRenderer.invoke("routing:setMode", mode)
  },
  featureGates: {
    isEnabled: (
      name: FeatureGateKey,
      options?: FeatureGateCheckOptions
    ): Promise<FeatureGateCheckResult> =>
      ipcRenderer.invoke("featureGates:isEnabled", name, options)
  },
  dashboard: {
    cancelRequests: (families?: string[]): Promise<{ cancelled: number }> =>
      ipcRenderer.invoke("dashboard:cancelRequests", families),
    isAllowed: (): Promise<boolean> => ipcRenderer.invoke("dashboard:isAllowed"),
    isProjectModeAllowed: (): Promise<boolean> =>
      ipcRenderer.invoke("dashboard:isProjectModeAllowed"),
    isAnalysisAgentAllowed: (): Promise<boolean> =>
      ipcRenderer.invoke("dashboard:isAnalysisAgentAllowed"),
    isTraceEvolverReviewAdmin: (): Promise<boolean> =>
      ipcRenderer.invoke("dashboard:isTraceEvolverReviewAdmin"),
    isUncommittedAnalysisAllowed: (): Promise<boolean> =>
      ipcRenderer.invoke("dashboard:isUncommittedAnalysisAllowed"),
    isAwardsAdmin: (): Promise<boolean> => ipcRenderer.invoke("dashboard:isAwardsAdmin"),
    isSkillEvalAllowed: (): Promise<boolean> => ipcRenderer.invoke("dashboard:isSkillEvalAllowed"),
    awardsSkillContributions: (
      range: { from: string; to: string },
      skillNames: string[]
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:awardsSkillContributions", range, skillNames),
    awardsUserApplications: (range: {
      from: string
      to: string
    }): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:awardsUserApplications", range),
    awardsTeamBenchmark: (range: {
      from: string
      to: string
    }): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:awardsTeamBenchmark", range),
    awardsTeamSkillCoverage: (
      range: { from: string; to: string },
      groups: Array<{ shi: string; skillNames: string[] }>
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:awardsTeamSkillCoverage", range, groups),
    esQuery: (input: {
      indexAlias: "event" | "trace"
      operation: "search" | "msearch" | "count" | "mapping" | "field_caps"
      body?: unknown
      context?: {
        scope?: "platform" | "project"
        upperOrgLv1?: string | string[] | null
        projectId?: string | null
        featureSlug?: string | null
      }
    }): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:esQuery", input),
    analysisAgent: (input: {
      question: string
      messages?: Array<{ role: "user" | "assistant"; content: string }>
      context?: {
        scope?: "platform" | "project"
        range?: { from: string; to: string }
        upperOrgLv1?: string | string[] | null
        projectId?: string | null
        featureSlug?: string | null
        panelSnapshot?: Record<string, unknown> | null
      }
    }): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:analysisAgent", input),
    projectMode: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      opts?: { upperOrgLv1?: string | string[] | null }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:projectMode", range, granularity, opts),
    projectModeCodeStats: (
      range: { from: string; to: string },
      opts: { upperOrgLv1?: string | string[] | null; fromLeanOnly?: boolean | null } | undefined,
      source: string | null
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:projectModeCodeStats", range, opts, source),
    efficiency: (
      range: { from: string; to: string },
      opts?: { upperOrgLv1?: string | string[] | null }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:efficiency", range, opts),
    projectMetricSummary: (
      filters: ProjectMetricFilters
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:projectMetricSummary", filters),
    projectMetricProjects: (
      filters: ProjectMetricFilters,
      options?: ProjectMetricListOptions
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:projectMetricProjects", filters, options),
    projectModeProjects: (
      range: { from: string; to: string },
      options?: {
        upperOrgLv1?: string | string[] | null
        status?: "active" | "archived" | null
        page?: number
        pageSize?: number
        keyword?: string | null
        adapterName?: string | null
        creatorKeyword?: string | null
        creatorOrgKeyword?: string | null
      }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:projectModeProjects", range, options),
    projectModeExportData: (
      range: { from: string; to: string },
      opts?: { upperOrgLv1?: string | string[] | null; fromLeanOnly?: boolean | null }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:projectModeExportData", range, opts),
    projectModeTraces: (
      projectId: string,
      range: { from: string; to: string },
      options?: {
        limit?: number
        page?: number
        pageSize?: number
        tracePage?: number
        tracePageSize?: number
        mode?: "thread" | "trace"
        viewMode?: "thread" | "trace"
        triggerScope?: "active" | "all"
        featureSlug?: string
        nodeName?: string
        nodeStatus?: string
      }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:projectModeTraces", projectId, range, options),
    projectModeFeatureNodes: (
      projectId: string,
      featureSlug: string,
      range: { from: string; to: string }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:projectModeFeatureNodes", projectId, featureSlug, range),
    projectModeOperationalDetails: (
      scope: { projectId: string; featureSlug?: string; nodeName?: string },
      range: { from: string; to: string },
      opts?: { upperOrgLv1?: string | string[] | null }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:projectModeOperationalDetails", scope, range, opts),
    pluginAggregate: (
      adapterName: string,
      range: { from: string; to: string }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:pluginAggregate", adapterName, range),
    projectModeFeatureCommits: (
      projectId: string,
      featureSlug: string,
      range: { from: string; to: string },
      options?: {
        page?: number
        pageSize?: number
        pushedOnly?: boolean
        upperOrgLv1?: string | null
        userKeyword?: string | null
        orgLv1List?: string[]
      }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke(
        "dashboard:projectModeFeatureCommits",
        projectId,
        featureSlug,
        range,
        options
      ),
    projectModeProjectCommits: (
      projectId: string,
      range: { from: string; to: string },
      options?: {
        page?: number
        pageSize?: number
        pushedOnly?: boolean
        upperOrgLv1?: string | null
        userKeyword?: string | null
        orgLv1List?: string[]
      }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:projectModeProjectCommits", projectId, range, options),
    overview: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      opts?: { upperOrgLv1?: string | string[] | null }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:overview", range, granularity, opts),
    modelStats: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      opts?: { upperOrgLv1?: string | string[] | null }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:modelStats", range, granularity, opts),
    orgOptions: (range: {
      from: string
      to: string
    }): Promise<{ success: boolean; data?: string[]; error?: string }> =>
      ipcRenderer.invoke("dashboard:orgOptions", range),
    userStats: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      opts?: { upperOrgLv1?: string | string[] | null }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:userStats", range, granularity, opts),
    userList: (
      range: { from: string; to: string },
      options?: {
        pageSize?: number
        afterKey?: Record<string, string | number> | null
        keyword?: string | null
        upperOrgLv1?: string | null
      }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:userList", range, options),
    userDetail: (
      sapId: string,
      range: { from: string; to: string },
      options?: {
        traceLimit?: number
        tracePage?: number
        tracePageSize?: number
        mode?: "thread" | "trace"
        viewMode?: "thread" | "trace"
        triggerScope?: "active" | "all"
        projectMode?: boolean
      }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:userDetail", sapId, range, options),
    uncommittedRanking: (
      range: { from: string; to: string },
      options?: {
        upperOrgLv1?: string | string[] | null
        projectMode?: boolean
        projectId?: string | null
        featureSlug?: string | null
        usedSkillsOnly?: boolean
        source?: string | null
        userKeyword?: string | null
      }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:uncommittedRanking", range, options),
    uncommittedDetail: (
      sapId: string,
      range: { from: string; to: string },
      options?: {
        upperOrgLv1?: string | string[] | null
        projectMode?: boolean
        projectId?: string | null
        featureSlug?: string | null
        usedSkillsOnly?: boolean
        source?: string | null
        userKeyword?: string | null
      }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:uncommittedDetail", sapId, range, options),
    skillUsageSummary: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      // 可选：传入技能名列表，后端将按技能名做 filters 聚合（更精确用户数）。
      skillNames?: string[]
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:skillUsageSummary", range, granularity, skillNames),
    skillUserStats: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      skillName: string
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:skillUserStats", range, granularity, skillName),
    skillEvalSummary: (
      range: { from: string; to: string },
      options?: {
        limit?: number
        recentPage?: number
        recentPageSize?: number
        skillPage?: number
        skillPageSize?: number
        skillSearch?: string
        skillName?: string
        skillVersion?: string
        skillNames?: string[]
        upperOrgLv1?: string | string[] | null
        defaultRecentToLatestSkill?: boolean
        recentOnly?: boolean
        listOnly?: boolean
        statsOnly?: boolean
      }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:skillEvalSummary", range, options),
    userProfiles: (
      sapIds: string[],
      options?: {
        family?: "dashboard-market" | "project-mode-market" | "harness-market" | "customize-market"
      }
    ): Promise<{
      success: boolean
      data?: Array<{
        sapId: string
        userName: string
        orgName: string
        upperOrgLv0?: string
        upperOrgLv1?: string
      }>
      error?: string
    }> => ipcRenderer.invoke("dashboard:userProfiles", sapIds, options),
    queryAllUser: (): Promise<{
      success: boolean
      data?: Array<{
        sapId: string
        userName: string
        orgName: string
        upperOrgLv0?: string
        upperOrgLv1?: string
      }>
      error?: string
    }> => ipcRenderer.invoke("dashboard:queryAllUser"),
    productivity: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      opts?: { upperOrgLv1?: string | string[] | null }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:productivity", range, granularity, opts),
    feedback: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      opts?: { upperOrgLv1?: string | string[] | null }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:feedback", range, granularity, opts),
    advancedFeatures: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      opts?: { upperOrgLv1?: string | string[] | null }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:advancedFeatures", range, granularity, opts),
    skillRecentTraces: (
      skill: string,
      range: { from: string; to: string },
      limit?: number,
      mode?: "thread" | "trace",
      triggerScope?: "active" | "all"
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:skillRecentTraces", skill, range, limit, mode, triggerScope),
    threadTraces: (
      threadId: string,
      options?: { scope?: "platform" | "project" }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:threadTraces", threadId, options),
    marketSkillRecentTraces: (
      skill: string,
      range: { from: string; to: string },
      limit?: number,
      mode?: "thread" | "trace",
      triggerScope?: "active" | "all"
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke(
        "dashboard:marketSkillRecentTraces",
        skill,
        range,
        limit,
        mode,
        triggerScope
      ),
    skillDetail: (
      skill: string,
      range: { from: string; to: string },
      options?:
        | number
        | {
            page?: number
            pageSize?: number
            limit?: number
            mode?: "thread" | "trace"
            viewMode?: "thread" | "trace"
            triggerScope?: "active" | "all"
          }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:skillDetail", skill, range, options),
    commitDetails: (
      range: { from: string; to: string },
      options?: {
        page?: number
        pageSize?: number
        pushedOnly?: boolean
        upperOrgLv1?: string | null
        userKeyword?: string | null
        orgLv1List?: string[]
      }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:commitDetails", range, options),
    nonGitAdoptionReports: (
      range: { from: string; to: string },
      options?: {
        page?: number
        pageSize?: number
        upperOrgLv1?: string | null
        userKeyword?: string | null
        orgLv1List?: string[]
        projectMode?: boolean
        projectId?: string | null
        featureSlug?: string | null
        usedSkillsOnly?: boolean
      }
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:nonGitAdoptionReports", range, options),
    commitAdoptionEvents: (
      commitSha: string
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("dashboard:commitAdoptionEvents", commitSha),
    exportSkillTraces: (payload: {
      skill: string
      range: { from: string; to: string }
      page: number
      pageSize: number
      totalTraces: number
      traces: unknown[]
    }): Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke("dashboard:exportSkillTraces", payload),
    exportUserTraces: (payload: {
      sapId: string
      ystId?: string
      userName: string
      range: { from: string; to: string }
      page: number
      pageSize: number
      totalItems: number
      viewMode: "thread" | "trace"
      triggerScope: "active" | "all"
      projectMode: boolean
      traces: unknown[]
    }): Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke("dashboard:exportUserTraces", payload),
    exportExcel: (
      sheets: Array<{
        name: string
        header: string[]
        rows: (string | number)[][]
        summaryRows?: (string | number)[][]
      }>,
      options?: { fileName?: string }
    ): Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke("dashboard:exportExcel", sheets, options)
  },
  adoption: {
    commitLines: (
      commitSha: string,
      genEventIds: string[]
    ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      ipcRenderer.invoke("adoption:commitLines", commitSha, genEventIds)
  },
  harnessBoard: {
    catalogPage: (input: HarnessBoardCatalogPageInput): Promise<HarnessBoardCatalogPageResult> =>
      ipcRenderer.invoke(
        "harnessBoard:catalogPage",
        input
      ) as Promise<HarnessBoardCatalogPageResult>,
    cancelCatalogRequests: (
      scope?: "board" | "board-registry" | "board-sidebar" | "board-settings" | "chat-binding"
    ): Promise<void> =>
      ipcRenderer.invoke("harnessBoard:cancelCatalogRequests", scope) as Promise<void>,
    catalog: (): Promise<{
      projects: HarnessProjectListItem[]
      registry: HarnessAdapterRegistryItem[]
    }> =>
      ipcRenderer.invoke("harnessBoard:catalog") as Promise<{
        projects: HarnessProjectListItem[]
        registry: HarnessAdapterRegistryItem[]
      }>,
    registry: (): Promise<HarnessAdapterRegistryItem[]> =>
      ipcRenderer.invoke("harnessBoard:registry") as Promise<HarnessAdapterRegistryItem[]>,
    listProjects: (): Promise<HarnessProjectListItem[]> =>
      ipcRenderer.invoke("harnessBoard:listProjects") as Promise<HarnessProjectListItem[]>,
    getDeployUnitMappings: (): Promise<HarnessDeployUnitMapping[]> =>
      ipcRenderer.invoke("harnessBoard:getDeployUnitMappings") as Promise<
        HarnessDeployUnitMapping[]
      >,
    getLeanTokenConfig: (): Promise<HarnessLeanTokenConfig> =>
      ipcRenderer.invoke("harnessBoard:getLeanTokenConfig") as Promise<HarnessLeanTokenConfig>,
    saveDeployUnitMappings: (
      mappings: HarnessDeployUnitMapping[]
    ): Promise<HarnessDeployUnitMapping[]> =>
      ipcRenderer.invoke("harnessBoard:saveDeployUnitMappings", mappings) as Promise<
        HarnessDeployUnitMapping[]
      >,
    saveLeanTokenConfig: (input: HarnessLeanTokenConfig): Promise<HarnessLeanTokenConfig> =>
      ipcRenderer.invoke(
        "harnessBoard:saveLeanTokenConfig",
        input
      ) as Promise<HarnessLeanTokenConfig>,
    syncProjectConstraints: (adapterId: string): Promise<HarnessProjectConstraintSyncResult> =>
      ipcRenderer.invoke(
        "harnessBoard:syncProjectConstraints",
        adapterId
      ) as Promise<HarnessProjectConstraintSyncResult>,
    getKnowledgePreview: (adapterId: string): Promise<HarnessKnowledgePreviewResult> =>
      ipcRenderer.invoke(
        "harnessBoard:getKnowledgePreview",
        adapterId
      ) as Promise<HarnessKnowledgePreviewResult>,
    cancelKnowledgePreviewRequests: (): Promise<void> =>
      ipcRenderer.invoke("harnessBoard:cancelKnowledgePreviewRequests") as Promise<void>,
    createProject: (input: HarnessProjectCreateInput): Promise<HarnessProjectMetadata> =>
      ipcRenderer.invoke("harnessBoard:createProject", input) as Promise<HarnessProjectMetadata>,
    searchEnterpriseProjects: (
      input: HarnessEnterpriseProjectSearchInput
    ): Promise<HarnessEnterpriseProjectSearchResult> =>
      ipcRenderer.invoke(
        "harnessBoard:searchEnterpriseProjects",
        input
      ) as Promise<HarnessEnterpriseProjectSearchResult>,
    searchDeployUnits: (
      input: HarnessDeployUnitSearchInput
    ): Promise<HarnessDeployUnitSearchResult> =>
      ipcRenderer.invoke(
        "harnessBoard:searchDeployUnits",
        input
      ) as Promise<HarnessDeployUnitSearchResult>,
    queryPipelines: (input: HarnessPipelineQueryInput): Promise<HarnessPipelineQueryResult> =>
      ipcRenderer.invoke(
        "harnessBoard:queryPipelines",
        input
      ) as Promise<HarnessPipelineQueryResult>,
    queryPipelineLabels: (
      input: HarnessPipelineLabelQueryInput
    ): Promise<HarnessPipelineLabelQueryResult> =>
      ipcRenderer.invoke(
        "harnessBoard:queryPipelineLabels",
        input
      ) as Promise<HarnessPipelineLabelQueryResult>,
    getEnterpriseProjectDetails: (
      input: HarnessEnterpriseProjectDetailInput
    ): Promise<HarnessEnterpriseProjectDetailResult> =>
      ipcRenderer.invoke(
        "harnessBoard:getEnterpriseProjectDetails",
        input
      ) as Promise<HarnessEnterpriseProjectDetailResult>,
    getProjectReviews: (input: HarnessProjectReviewInput): Promise<HarnessProjectReviewResult> =>
      ipcRenderer.invoke(
        "harnessBoard:getProjectReviews",
        input
      ) as Promise<HarnessProjectReviewResult>,
    cancelEnterpriseRequests: (
      requestScope: "board-batch" | "selected-project" | "reviews"
    ): Promise<void> =>
      ipcRenderer.invoke("harnessBoard:cancelEnterpriseRequests", requestScope) as Promise<void>,
    createFeature: (input: HarnessFeatureCreateInput): Promise<HarnessFeatureCreateResult> =>
      ipcRenderer.invoke(
        "harnessBoard:createFeature",
        input
      ) as Promise<HarnessFeatureCreateResult>,
    updateFeatureDeployUnits: (
      input: HarnessFeatureDeployUnitUpdateInput
    ): Promise<HarnessFeatureDeployUnitBinding> =>
      ipcRenderer.invoke(
        "harnessBoard:updateFeatureDeployUnits",
        input
      ) as Promise<HarnessFeatureDeployUnitBinding>,
    getDynamicWorkflowConfig: (projectId: string): Promise<HarnessDynamicWorkflowConfig | null> =>
      ipcRenderer.invoke(
        "harnessBoard:getDynamicWorkflowConfig",
        projectId
      ) as Promise<HarnessDynamicWorkflowConfig | null>,
    getPublicAgentmdDeployUnits: (projectId: string): Promise<string[]> =>
      ipcRenderer.invoke("harnessBoard:getPublicAgentmdDeployUnits", projectId) as Promise<
        string[]
      >,
    getLocalAgentmdDeployUnitMappings: (mappings: HarnessDeployUnitMapping[]): Promise<string[]> =>
      ipcRenderer.invoke("harnessBoard:getLocalAgentmdDeployUnitMappings", mappings) as Promise<
        string[]
      >,
    updateProject: (
      projectId: string,
      input: HarnessProjectMetadataUpdateInput
    ): Promise<HarnessProjectMetadata> =>
      ipcRenderer.invoke("harnessBoard:updateProject", {
        projectId,
        input
      }) as Promise<HarnessProjectMetadata>,
    archiveProject: (projectId: string): Promise<HarnessProjectMetadata> =>
      ipcRenderer.invoke(
        "harnessBoard:archiveProject",
        projectId
      ) as Promise<HarnessProjectMetadata>,
    deleteProject: (projectId: string): Promise<HarnessProjectMetadata> =>
      ipcRenderer.invoke(
        "harnessBoard:deleteProject",
        projectId
      ) as Promise<HarnessProjectMetadata>,
    getProjectDetail: (projectId: string): Promise<HarnessProjectDetailViewModel> =>
      ipcRenderer.invoke(
        "harnessBoard:getProjectDetail",
        projectId
      ) as Promise<HarnessProjectDetailViewModel>,
    getProjectDetails: (
      projectIds: string[],
      options?: { watchRefs?: boolean }
    ): Promise<Record<string, HarnessProjectDetailViewModel>> =>
      ipcRenderer.invoke("harnessBoard:getProjectDetails", {
        projectIds,
        watchRefs: options?.watchRefs !== false
      }) as Promise<Record<string, HarnessProjectDetailViewModel>>,
    stopWatchRefs: (scopeKey?: string): Promise<void> =>
      ipcRenderer.invoke("harnessBoard:stopWatchRefs", scopeKey) as Promise<void>,
    getRunDetail: (projectId: string, slug: string): Promise<HarnessRunDetailViewModel> =>
      ipcRenderer.invoke("harnessBoard:getRunDetail", {
        projectId,
        slug
      }) as Promise<HarnessRunDetailViewModel>,
    refreshRunArtifactGrant: (
      input: HarnessRunArtifactGrantRefreshInput
    ): Promise<HarnessRunArtifactGrantRefreshResult> =>
      ipcRenderer.invoke(
        "harnessBoard:refreshRunArtifactGrant",
        input
      ) as Promise<HarnessRunArtifactGrantRefreshResult>,
    revealRunArtifact: (
      input: HarnessRunArtifactRevealInput
    ): Promise<HarnessRunArtifactRevealResult> =>
      ipcRenderer.invoke(
        "harnessBoard:revealRunArtifact",
        input
      ) as Promise<HarnessRunArtifactRevealResult>,
    skipNode: (input: HarnessSkipNodeInput): Promise<HarnessSkipNodeResult> =>
      ipcRenderer.invoke("harnessBoard:skipNode", input) as Promise<HarnessSkipNodeResult>,
    getDialogTips: (projectId: string, slug: string): Promise<string | null> =>
      ipcRenderer.invoke("harnessBoard:getDialogTips", { projectId, slug }) as Promise<
        string | null
      >,
    cancelDialogTips: (): Promise<void> =>
      ipcRenderer.invoke("harnessBoard:cancelDialogTips") as Promise<void>,
    onWatchRefsChanged: (callback: (event: HarnessWatchRefChangedEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: HarnessWatchRefChangedEvent): void =>
        callback(payload)
      ipcRenderer.on("harnessBoard:watchRefsChanged", handler)
      return () => ipcRenderer.removeListener("harnessBoard:watchRefsChanged", handler)
    }
  },
  app: {
    restart: (): Promise<void> => ipcRenderer.invoke("app:restart") as Promise<void>
  },
  update: {
    check: (): Promise<
      | { hasUpdate: false; source?: UpdateSourceInfo | null }
      | {
          hasUpdate: true
          version: string
          targetVersion: string
          updateType: string
          releaseNotes: string
          size: number
          mandatory: boolean
          currentStatus?: string
          currentProgress?: {
            percent: number
            transferred: number
            total: number
            speed: string
            phase: "downloading" | "verifying" | "extracting"
            message: string
          } | null
          currentError?: string | null
          source?: UpdateSourceInfo | null
        }
    > => ipcRenderer.invoke("update:check"),
    download: (): Promise<{ success: boolean }> => ipcRenderer.invoke("update:download"),
    install: (): Promise<void> => ipcRenderer.invoke("update:install"),
    dismiss: (): Promise<{ success: boolean }> => ipcRenderer.invoke("update:dismiss"),
    rollback: (): Promise<void> => ipcRenderer.invoke("update:rollback"),
    getStatus: (): Promise<{
      status: string
      update: {
        version: string
        targetVersion: string
        updateType: string
        releaseNotes: string
        size: number
        mandatory: boolean
      } | null
      progress: {
        percent: number
        transferred: number
        total: number
        speed: string
        phase: "downloading" | "verifying" | "extracting"
        message: string
      } | null
      errorMessage: string | null
      canRollback: boolean
      source: UpdateSourceInfo | null
    }> => ipcRenderer.invoke("update:get-status"),
    getStartupResult: (): Promise<{ updatedFrom?: string; updatedTo?: string }> =>
      ipcRenderer.invoke("update:get-startup-result"),
    onAvailable: (
      callback: (info: {
        version: string
        targetVersion: string
        updateType: string
        releaseNotes: string
        size: number
        mandatory: boolean
        autoDownloading?: boolean
        source?: UpdateSourceInfo | null
      }) => void
    ) => {
      const wrapper = (_event: unknown, info: Parameters<typeof callback>[0]): void =>
        callback(info)
      ipcRenderer.on("update:available", wrapper)
      return () => ipcRenderer.removeListener("update:available", wrapper)
    },
    onProgress: (
      callback: (progress: {
        percent: number
        transferred: number
        total: number
        speed: string
        phase: "downloading" | "verifying" | "extracting"
        message: string
      }) => void
    ) => {
      const wrapper = (_event: unknown, progress: Parameters<typeof callback>[0]): void =>
        callback(progress)
      ipcRenderer.on("update:progress", wrapper)
      return () => ipcRenderer.removeListener("update:progress", wrapper)
    },
    onDownloaded: (
      callback: (info: {
        version: string
        targetVersion: string
        updateType: string
        releaseNotes?: string
        size?: number
        mandatory?: boolean
        source?: UpdateSourceInfo | null
      }) => void
    ) => {
      const wrapper = (_event: unknown, info: Parameters<typeof callback>[0]): void =>
        callback(info)
      ipcRenderer.on("update:downloaded", wrapper)
      return () => ipcRenderer.removeListener("update:downloaded", wrapper)
    },
    onError: (callback: (err: { message: string; silent?: boolean }) => void) => {
      const wrapper = (_event: unknown, err: Parameters<typeof callback>[0]): void => callback(err)
      ipcRenderer.on("update:error", wrapper)
      return () => ipcRenderer.removeListener("update:error", wrapper)
    }
  },
  gitPanel: {
    getCommitHistory: (
      threadId: string
    ): Promise<{
      success: boolean
      projectPath: string | null
      records: GitCommitHistoryRecord[]
      error?: string
    }> =>
      ipcRenderer.invoke("git-panel:getCommitHistory", { threadId }) as Promise<{
        success: boolean
        projectPath: string | null
        records: GitCommitHistoryRecord[]
        error?: string
      }>,
    recordCommitHistory: (
      threadId: string,
      fullMessage: string
    ): Promise<{
      success: boolean
      record: GitCommitHistoryRecord | null
      error?: string
    }> =>
      ipcRenderer.invoke("git-panel:recordCommitHistory", { threadId, fullMessage }) as Promise<{
        success: boolean
        record: GitCommitHistoryRecord | null
        error?: string
      }>
  },
  git: {
    currentBranch: (
      cwd?: string
    ): Promise<{
      isGitRepo: boolean
      branch: string | null
      isWorktree: boolean
      isMultiRepo?: boolean
      repositories?: Array<{ path: string; displayPath: string; gitRoot: string }>
      error?: string
    }> =>
      ipcRenderer.invoke("git:currentBranch", cwd) as Promise<{
        isGitRepo: boolean
        branch: string | null
        isWorktree: boolean
        isMultiRepo?: boolean
        repositories?: Array<{ path: string; displayPath: string; gitRoot: string }>
        error?: string
      }>,
    listBranches: (
      cwd?: string,
      options?: { refreshRemote?: boolean }
    ): Promise<{ success: boolean; branches: string[]; error?: string }> =>
      ipcRenderer.invoke("git:listBranches", {
        cwd,
        refreshRemote: Boolean(options?.refreshRemote)
      }) as Promise<{
        success: boolean
        branches: string[]
        error?: string
      }>,
    switchBranch: (branch: string, cwd?: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("git:switchBranch", { branch, cwd }) as Promise<{
        success: boolean
        error?: string
      }>,
    createBranch: (branch: string, cwd?: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("git:createBranch", { branch, cwd }) as Promise<{
        success: boolean
        error?: string
      }>
  }
}

// Use `contextBridge` APIs to expose Electron APIs to renderer
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI)
    contextBridge.exposeInMainWorld("api", api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
