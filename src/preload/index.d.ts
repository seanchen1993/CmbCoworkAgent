import type {
  Thread,
  ModelConfig,
  Provider,
  StreamEvent,
  HITLDecision,
  SkillMetadata,
  McpConnectorConfig,
  McpConnectorUpsert,
  ScheduledTask,
  ScheduledTaskUpsert,
  HeartbeatConfig,
  LspConfig,
  LspDiagnostic,
  LspLocation,
  LspHoverResult,
  LspSymbol,
  LspCallHierarchyItem,
  LspCallHierarchyIncomingCall,
  LspCallHierarchyOutgoingCall,
  LspStatus,
  ChatXConfig,
  HookLoggingConfig,
  PluginHookMetadata,
  PluginMetadata,
  PluginManifest,
  SkillHookMetadata,
  AgentAutoCommitSettings
} from "../main/types"
import { UserInfoConfig } from "../main/storage"
import type { HookConfig, HookUpsert } from "../main/hooks/types"
import type {
  ManagedSavedCodeExecTool,
  SavedCodeExecPreviewPayload,
  SavedCodeExecPreviewResult,
  SavedCodeExecToolUpdatePayload
} from "../main/ipc/code-exec-tools"

interface ElectronAPI {
  openExternal: (url: string) => Promise<void>
  openLoginWindow: () => void
  closeLoginWindow: () => void
  openLoginPage: () => void
  closeLoginPage: () => void
  onNotifyMsg: (callback: (msg: string) => void) => void
  ipcRenderer: {
    send: (channel: string, ...args: unknown[]) => void
    on: (channel: string, listener: (...args: unknown[]) => void) => () => void
    once: (channel: string, listener: (...args: unknown[]) => void) => void
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  }
  process: {
    platform: NodeJS.Platform
    versions: NodeJS.ProcessVersions
  }
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

interface DashboardTraceNode {
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
}

interface DashboardTraceDetail {
  traceId: string
  threadId: string
  startedAt: string
  endedAt?: string
  durationMs: number
  userMessage: string
  sapId?: string
  ystId?: string
  userName?: string
  orgName?: string
  userIp?: string
  modelId?: string
  modelName?: string
  outcome: string
  totalToolCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  usedSkills: string[]
  nodes?: DashboardTraceNode[]
  rawAvailable: boolean
  rawError?: string
}

interface DashboardCommitDetail {
  eventId: string
  eventTime: string
  userName: string
  sapId?: string
  ystId?: string
  orgName?: string
  userIp?: string
  repoPath?: string
  repositoryName?: string
  repositoryFullName?: string
  repositoryWebUrl?: string
  commitSha?: string
  commitUrl?: string
  pushed: boolean
  pushedAt?: string
  branch?: string
  filesChanged: number
  insertions: number
  deletions: number
  triggeredBy?: string
  threadId?: string
  usedSkills: string[]
  skillCount: number
}

interface DashboardCommitDetailsOptions {
  page?: number
  pageSize?: number
  pushedOnly?: boolean
}

interface DashboardCodeStats {
  generatedLines: number
  deletedLines: number
  effectiveGeneratedLines: number
  measuredGeneratedLines: number
  unmeasuredGeneratedLines: number
  inclusiveEffectiveGeneratedLines: number
  adoptedLines: number
  pushedMeasuredGeneratedLines: number
  pushedEffectiveGeneratedLines: number
  pushedAdoptedLines: number
  pushedCommitCount: number
  measuredAdoptionRate: number | null
  inclusiveAdoptionRate: number | null
  pushedAdoptionRate: number | null
  adoptionRate: number | null
}

interface DashboardSkillDetail {
  stats: DashboardCodeStats
  traces: DashboardTraceDetail[]
  tracePage: number
  tracePageSize: number
  totalTraces: number
}

interface DashboardUserListItem {
  sapId: string
  ystId?: string
  userName: string
  orgName?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
  count: number
  lastActiveAt?: string
  avgDurationMs: number
  totalToolCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
}

interface DashboardUserListData {
  items: DashboardUserListItem[]
  pageSize: number
  nextAfterKey?: Record<string, string | number>
  totalActiveUsers: number
}

interface DashboardUserDetail {
  sapId: string
  ystId?: string
  userName: string
  orgName?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
  totalCalls: number
  avgDurationMs: number
  totalToolCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  bySkill: Array<{ skill: string; count: number }>
  byModel: Array<{ model: string; count: number }>
  byOutcome: Array<{ outcome: string; count: number }>
  traces: DashboardTraceDetail[]
  tracePage: number
  tracePageSize: number
  totalTraces: number
}

interface DashboardUserListOptions {
  pageSize?: number
  afterKey?: Record<string, string | number> | null
  keyword?: string | null
}

interface DashboardAllUserItem {
  sapId: string
  userName: string
  orgName: string
  upperOrgLv0?: string
  upperOrgLv1?: string
}

interface DashboardUserDetailOptions {
  traceLimit?: number
  tracePage?: number
  tracePageSize?: number
}

interface CustomAPI {
  agent: {
    invoke: (
      threadId: string,
      message: string,
      onEvent: (event: StreamEvent) => void,
      modelId?: string,
      userMessageId?: string
    ) => () => void
    streamAgent: (
      threadId: string,
      message: string,
      command: unknown,
      onEvent: (event: StreamEvent) => void,
      modelId?: string,
      userMessageId?: string
    ) => () => void
    interrupt: (
      threadId: string,
      decision: HITLDecision,
      onEvent?: (event: StreamEvent) => void
    ) => () => void
    cancel: (threadId: string) => Promise<void>
  }
  threads: {
    list: () => Promise<Thread[]>
    get: (threadId: string) => Promise<Thread | null>
    create: (metadata?: Record<string, unknown>) => Promise<Thread>
    update: (threadId: string, updates: Partial<Thread>) => Promise<Thread>
    delete: (threadId: string) => Promise<void>
    exportSession: (
      threadId: string
    ) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>
    getHistory: (threadId: string) => Promise<unknown[]>
    generateTitle: (message: string) => Promise<string>
    onThreadsChanged: (callback: () => void) => () => void
  }
  models: {
    list: () => Promise<ModelConfig[]>
    listProviders: () => Promise<Provider[]>
    getDefault: () => Promise<string>
    setDefault: (modelId: string) => Promise<void>
    getTokenLimits: () => Promise<{
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
    getCustomConfigs: () => Promise<
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
        tier?: "premium" | "economy"
      }>
    >
    getCustomConfig: (id?: string) => Promise<{
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
      tier?: "premium" | "economy"
    } | null>
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
      tier?: "premium" | "economy"
    }) => Promise<void>
    // Backward-compatible alias, prefer upsertCustomConfig in new code.
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
      tier?: "premium" | "economy"
    }) => Promise<{ id: string }>
    upsertUserInfo: (config: UserInfoConfig) => Promise<{ id: string }>
    getUserInfo: () => Promise<UserInfoConfig | null>
    deleteCustomConfig: (id: string) => Promise<void>
    testConnection: (params: {
      id?: string
      baseUrl?: string
      model?: string
      apiKey?: string
      maxOutputTokens?: number
      temperature?: number
      topP?: number
      topK?: number
    }) => Promise<{ success: boolean; error?: string; latencyMs?: number }>
  }
  workspace: {
    get: (threadId?: string) => Promise<string | null>
    set: (threadId: string | undefined, path: string | null) => Promise<string | null>
    select: (threadId?: string) => Promise<string | null>
    loadFromDisk: (threadId: string) => Promise<{
      success: boolean
      files: Array<{
        path: string
        is_dir: boolean
        size?: number
        modified_at?: string
      }>
      workspacePath?: string
      error?: string
    }>
    readFile: (
      threadId: string,
      filePath: string
    ) => Promise<{
      success: boolean
      content?: string
      size?: number
      modified_at?: string
      error?: string
    }>
    readBinaryFile: (
      threadId: string,
      filePath: string
    ) => Promise<{
      success: boolean
      content?: string
      size?: number
      modified_at?: string
      error?: string
    }>
    readExternalFile: (filePath: string) => Promise<{
      success: boolean
      content?: string
      size?: number
      modified_at?: string
      error?: string
    }>
    readExternalBinaryFile: (filePath: string) => Promise<{
      success: boolean
      content?: string
      size?: number
      modified_at?: string
      error?: string
    }>
    clearWorktreeContext: (threadId: string) => Promise<void>
    saveWorktreeContext: (
      threadId: string,
      gitRoot: string,
      branch: string,
      baseBranch?: string,
      baseCommit?: string
    ) => Promise<void>
    recordLlmModifiedFiles: (
      threadId: string,
      files: string[]
    ) => Promise<{
      success: boolean
      files?: string[]
      error?: string
    }>
    getGitPanelState: (threadId: string) => Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      taskId: string
      files: Array<{ path: string; diff: string; additions: number; deletions: number }>
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
    getGitPanelMeta: (threadId: string) => Promise<{
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
    getGitPanelDiffs: (threadId: string) => Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      taskId: string
      files: Array<{ path: string; diff: string; additions: number; deletions: number }>
      changedFilesTotal?: number
      omittedFileCount?: number
      totals: { additions: number; deletions: number; fileCount: number }
      hasPendingDiff: boolean
      suggestedCommitMessage?: string
      error?: string
    }>
    getGitPanelSummary: (threadId: string) => Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      hasPendingDiff: boolean
      changedFiles: number
    }>
    isGit: (
      folderPath: string,
      options?: { includeWorktrees?: boolean; threadId?: string }
    ) => Promise<{
      isGit: boolean
      gitRoot: string | null
      worktrees: Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>
      isWorktreePath: boolean
    }>
    listWorktrees: (
      gitRoot: string
    ) => Promise<Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>>
    removeWorktree: (
      gitRoot: string,
      worktreePath: string
    ) => Promise<{
      success: boolean
      error?: string
    }>
    createWorktree: (
      gitRoot: string,
      branch: string
    ) => Promise<{
      success: boolean
      path?: string
      branch?: string
      baseBranch?: string
      baseCommit?: string
      error?: string
    }>
    commitWorktree: (
      threadId: string,
      message: string,
      filePaths?: string[]
    ) => Promise<{
      success: boolean
      error?: string
    }>
    pushWorktree: (
      threadId: string
    ) => Promise<{
      success: boolean
      autoCommitted?: boolean
      error?: string
      steps?: Array<{
        step: "pull" | "commit" | "push" | "verify" | "final"
        status: "ok" | "failed" | "skipped"
        detail: string
      }>
    }>
    pullWorktree: (threadId: string) => Promise<{
      success: boolean
      detail?: string
      error?: string
    }>
    rejectWorktreeChanges: (threadId: string) => Promise<{
      success: boolean
      error?: string
    }>
    rejectWorktreeFile: (
      threadId: string,
      filePath: string
    ) => Promise<{
      success: boolean
      error?: string
    }>
    onFilesChanged: (
      callback: (data: { threadId: string; workspacePath: string }) => void
    ) => () => void
  }
  pet: {
    // 列出内置 pets/ 与 OPENWORK_DIR/pets 下可用宠物。
    list: () => Promise<PetManifest[]>
    getSpriteDataUrl: (
      directoryId: string,
      source?: "builtin" | "custom"
    ) => Promise<{ success: boolean; dataUrl?: string; error?: string }>
    // 将业务状态同步到独立宠物窗口；动画渲染不在 renderer 主 UI 中执行。
    setState: (state: PetState) => void
    // 告知主进程主应用已打开/获得焦点，用于清空宠物完成任务提醒队列。
    clearCompletedTasks: () => void
    getSettings: () => Promise<PetSettings>
    updateSettings: (settings: Partial<PetSettings>) => Promise<PetSettings>
    uploadCustomFolder: () => Promise<{ success: boolean; pet?: PetManifest; error?: string }>
    deleteCustom: (directoryId: string) => Promise<{ success: boolean; error?: string }>
  }
  file: {
    parse: (
      filePath: string,
      maxLength?: number
    ) => Promise<{
      success: boolean
      attachment?: {
        filename: string
        filePath: string
        content: string
        mimeType: string
        size: number
        truncated: boolean
      }
      error?: string
    }>
    getFilePath: (file: File) => string
    select: () => Promise<{ canceled: boolean; filePaths: string[] }>
    selectDirectory: (options?: { title?: string }) => Promise<{ canceled: boolean; filePaths: string[] }>
    supportedExtensions: () => Promise<string[]>
  }
  skills: {
    list: () => Promise<SkillMetadata[]>
    listPlugins: () => Promise<SkillMetadata[]>
    read: (skillPath: string) => Promise<{ success: boolean; content?: string; error?: string }>
    write: (skillPath: string, content: string) => Promise<{ success: boolean; error?: string }>
    readBinary: (
      skillPath: string
    ) => Promise<{ success: boolean; content?: string; mimeType?: string; error?: string }>
    listFiles: (
      skillPath: string
    ) => Promise<{ success: boolean; files?: string[]; error?: string }>
    readTextBundle: (
      skillPath: string
    ) => Promise<{
      success: boolean
      files?: Array<{ path: string; content: string }>
      skipped?: Array<{ path: string; reason: string }>
      error?: string
    }>
    getDisabled: () => Promise<string[]>
    setDisabled: (skillNames: string[]) => Promise<void>
    backupForCloudEvolution: (payload: {
      skillPath: string
      candidateId: string
      skillName: string
      sourceVersion?: string | null
      targetVersion?: string | null
    }) => Promise<{ success: boolean; backupId?: string; backupPath?: string; error?: string }>
    restoreCloudEvolutionBackup: (
      backupId: string
    ) => Promise<{ success: boolean; skillName?: string; error?: string }>
    exportCloudEvolutionBackup: (
      backupId: string,
      targetDir: string
    ) => Promise<{ success: boolean; exportedPath?: string; error?: string }>
    upload: (
      buffer: ArrayBuffer,
      fileName: string,
      options?: { allowNestedNameDuplicates?: boolean }
    ) => Promise<{
      success: boolean
      skillName?: string
      error?: string
      nestedNameConflicts?: Array<{ name: string; relativePath: string }>
    }>
    extractMarkdownFromZip: (
      buffer: ArrayBuffer,
      fileName?: string
    ) => Promise<{ success: boolean; filePath?: string; content?: string; error?: string }>
    exportForMarket: (
      skillPath: string,
      options?: { includeNestedSkills?: boolean }
    ) => Promise<{ success: boolean; fileName?: string; buffer?: ArrayBuffer; error?: string }>
    delete: (skillPath: string) => Promise<{ success: boolean; error?: string }>
  }
  mcp: {
    list: () => Promise<McpConnectorConfig[]>
    create: (config: McpConnectorUpsert) => Promise<{ id: string }>
    update: (config: McpConnectorUpsert & { id: string }) => Promise<{ id: string }>
    delete: (id: string) => Promise<void>
    setEnabled: (id: string, enabled: boolean) => Promise<void>
    testConnection: (params: {
      id?: string
      config?: McpConnectorUpsert
      url?: string
      advanced?: McpConnectorConfig["advanced"]
    }) => Promise<{ success: boolean; tools?: string[]; error?: string }>
  }
  memory: {
    listFiles: () => Promise<Array<{ name: string; size: number; modifiedAt: string }>>
    readFile: (name: string) => Promise<string>
    deleteFile: (name: string) => Promise<void>
    getEnabled: () => Promise<boolean>
    setEnabled: (enabled: boolean) => Promise<void>
    getStats: () => Promise<{
      fileCount: number
      totalSize: number
      indexSize: number
      enabled: boolean
    }>
    onChanged: (callback: () => void) => () => void
  }
  autoCommit: {
    getSettings: () => Promise<AgentAutoCommitSettings>
    saveSettings: (updates: Partial<AgentAutoCommitSettings>) => Promise<AgentAutoCommitSettings>
  }
  lsp: {
    getConfig: () => Promise<LspConfig>
    saveConfig: (updates: Partial<LspConfig>) => Promise<void>
    resetConfig: () => Promise<LspConfig>
    start: (projectRoot: string) => Promise<void>
    stop: (projectRoot: string) => Promise<void>
    isRunning: (projectRoot: string) => Promise<boolean>
    getStatus: (projectRoot: string | null) => Promise<LspStatus>
    getDownloadTarget: () => Promise<{ name: string; filenames: string[] }>
    getDownloadState: () => Promise<{
      isDownloading: boolean
      progress: { percent: number; transferred: number; total: number } | null
    }>
    downloadVsix: () => Promise<{ success: boolean; path?: string; error?: string }>
    importVsix: () => Promise<{ success: boolean; path?: string; error?: string }>
    saveDownloadedVsix: (
      buffer: ArrayBuffer,
      fileName?: string
    ) => Promise<{ success: boolean; path?: string; error?: string }>
    onDownloadState: (
      callback: (state: {
        isDownloading: boolean
        progress: { percent: number; transferred: number; total: number } | null
      }) => void
    ) => () => void
    definition: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }) => Promise<LspLocation[]>
    references: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }) => Promise<LspLocation[]>
    hover: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }) => Promise<LspHoverResult | null>
    implementation: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }) => Promise<LspLocation[]>
    documentSymbols: (params: { projectRoot: string; filePath: string }) => Promise<LspSymbol[]>
    workspaceSymbol: (params: { projectRoot: string; query: string }) => Promise<LspSymbol[]>
    diagnostics: (params: { projectRoot: string; filePath?: string }) => Promise<LspDiagnostic[]>
    prepareCallHierarchy: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }) => Promise<LspCallHierarchyItem[]>
    incomingCalls: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }) => Promise<LspCallHierarchyIncomingCall[]>
    outgoingCalls: (params: {
      projectRoot: string
      filePath: string
      line: number
      column: number
    }) => Promise<LspCallHierarchyOutgoingCall[]>
    detectJavaProject: (dirPath: string) => Promise<boolean>
    onDiagnostics: (callback: (diagnostics: LspDiagnostic[]) => void) => () => void
    onChanged: (callback: () => void) => () => void
  }
  terminal: {
    create: (opts: {
      workDir?: string
      args?: string[]
      cols?: number
      rows?: number
      claudeModelId?: string
      syncSkills?: boolean
      syncMemory?: boolean
    }) => Promise<string>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    dispose: (id: string) => Promise<void>
    selectDir: () => Promise<string | null>
    ack: (id: string, bytes: number) => void
    onData: (id: string, callback: (data: string, bytes: number) => void) => () => void
    onExit: (id: string, callback: (code: number | null) => void) => () => void
  }
  keepAwake: {
    get: () => Promise<boolean>
    set: (enabled: boolean) => Promise<void>
  }
  scheduledTasks: {
    list: () => Promise<ScheduledTask[]>
    create: (config: ScheduledTaskUpsert) => Promise<{ id: string }>
    update: (config: ScheduledTaskUpsert & { id: string }) => Promise<{ id: string }>
    delete: (id: string) => Promise<void>
    setEnabled: (id: string, enabled: boolean) => Promise<void>
    runNow: (id: string) => Promise<void>
    cancel: (id: string) => Promise<void>
    isRunning: (id: string) => Promise<boolean>
    onChanged: (callback: () => void) => () => void
    listenToStream: (
      threadId: string,
      callback: (event: { type: string; [key: string]: unknown }) => void
    ) => () => void
  }
  heartbeat: {
    getConfig: () => Promise<HeartbeatConfig>
    saveConfig: (updates: Partial<HeartbeatConfig>) => Promise<void>
    getContent: () => Promise<string>
    saveContent: (content: string) => Promise<void>
    runNow: () => Promise<void>
    cancel: () => Promise<void>
    isRunning: () => Promise<boolean>
    resetConfig: () => Promise<HeartbeatConfig>
    onChanged: (callback: () => void) => () => void
    listenToStream: (
      threadId: string,
      callback: (event: { type: string; [key: string]: unknown }) => void
    ) => () => void
  }
  plugins: {
    list: () => Promise<PluginMetadata[]>
    install: (
      buffer: ArrayBuffer,
      fileName: string,
      origin?: "market" | "local"
    ) => Promise<{ success: boolean; pluginName?: string; error?: string }>
    installFromDir: () => Promise<{ success: boolean; pluginName?: string; error?: string }>
    exportForMarket: (
      id: string
    ) => Promise<{ success: boolean; fileName?: string; buffer?: ArrayBuffer; error?: string }>
    delete: (id: string) => Promise<{ success: boolean; error?: string }>
    setEnabled: (id: string, enabled: boolean) => Promise<void>
    setOriginsBatch: (
      updates: Array<{ id: string; origin: "market" | "local" }>
    ) => Promise<{ success: boolean; error?: string }>
    getDetail: (id: string) => Promise<{
      skills: string[]
      mcpServers: string[]
      hookCount: number
      hooks: PluginHookMetadata[]
      manifest: PluginManifest | null
    }>
    listHooks: () => Promise<PluginHookMetadata[]>
    setHookEnabled: (
      pluginId: string,
      hookId: string,
      enabled: boolean
    ) => Promise<{ success: boolean; error?: string }>
  }
  chatx: {
    getConfig: () => Promise<ChatXConfig>
    saveConfig: (updates: Partial<ChatXConfig>) => Promise<void>
    restart: () => Promise<void>
    cancelByThread: (threadId: string) => Promise<boolean>
  }
  sandbox: {
    getMode: () => Promise<"none" | "unelevated" | "readonly" | "elevated">
    setMode: (mode: "none" | "unelevated" | "readonly" | "elevated") => Promise<void>
    checkElevatedSetup: () => Promise<{ setupComplete: boolean }>
    runElevatedSetup: (workspacePaths?: string[]) => Promise<{ success: boolean; error?: string }>
    getYoloMode: () => Promise<boolean>
    setYoloMode: (yolo: boolean) => Promise<void>
    isNuxNeeded: () => Promise<boolean>
    completeNux: (mode: "elevated" | "unelevated" | "none") => Promise<void>
    getApprovalRules: () => Promise<Array<{ pattern: string; decision: string }>>
    deleteApprovalRule: (pattern: string) => Promise<void>
    sendApprovalDecision: (decision: {
      requestId: string
      type: string
      tool_call_id: string
      savedToolName?: string
      savedToolDescription?: string
    }) => void
    onApprovalRequest: (threadId: string, callback: (request: unknown) => void) => () => void
    onApprovalTimeout: (
      threadId: string,
      callback: (data: { requestId: string }) => void
    ) => () => void
    onChanged: (callback: () => void) => () => void
  }
  skillEvolution: {
    /** Phase 1 — intent banner: "Want to save this as a skill?" */
    onIntentRequest: (
      callback: (req: {
        threadId?: string
        requestId: string
        summary: string
        toolCallCount: number
        mode: "mode_a_rule" | "mode_b_llm"
        recommendationReason?: string
        /** Opaque context payload — cache in renderer and pass back on retry */
        context: unknown
      }) => void
    ) => () => void
    intentResponse: (requestId: string, accepted: boolean) => Promise<void>
    /**
     * Manually retry a failed skill generation. Skips the intent banner and
     * jumps straight to generate → confirm → write.
     */
    retryGeneration: (
      threadId: string,
      retryContext: { context: unknown; intentMode: string }
    ) => Promise<void>
    /** Phase 2 — full detail dialog: show skill preview for final adoption */
    onConfirmRequest: (
      callback: (req: {
        threadId?: string
        requestId: string
        skillId: string
        name: string
        description: string
        content: string
      }) => void
    ) => () => void
    confirmResponse: (requestId: string, approved: boolean) => Promise<void>
    /** Listen to streaming generation progress from the main process */
    onGenerating: (
      callback: (event: {
        threadId?: string
        phase: "start" | "token" | "done" | "error"
        text: string
      }) => void
    ) => () => void
  }
  optimizer: {
    run: (opts?: {
      threadId?: string
      traceLimit?: number
      mode?: "auto" | "selected"
      traceIds?: string[]
    }) => Promise<{
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
    }>
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
    ) => () => void
    onStreamStart: (cb: () => void) => () => void
    onStreamChunk: (cb: (payload: { chunk: string }) => void) => () => void
    onStreamEnd: (cb: (payload: { success: boolean; error?: string }) => void) => () => void
    getCandidates: () => Promise<
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
    >
    approve: (
      candidateId: string
    ) => Promise<{ success: boolean; skillId?: string; error?: string }>
    reject: (candidateId: string) => Promise<{ success: boolean }>
    clear: () => Promise<void>
    getTraces: (opts?: { threadId?: string; limit?: number }) => Promise<
      Array<{
        traceId: string
        threadId: string
        startedAt: string
        durationMs: number
        userMessage: string
        totalToolCalls: number
        totalInputTokens: number
        totalOutputTokens: number
        totalTokens: number
        outcome: string
        usedSkills: string[]
      }>
    >
    onAutoTriggered: (
      cb: (payload: { threadId: string; toolCallCount: number }) => void
    ) => () => void
    getTraceDetail: (traceId: string) => Promise<{
      traceId: string
      threadId: string
      startedAt: string
      endedAt: string
      durationMs: number
      userMessage: string
      modelId: string
      totalToolCalls: number
      outcome: string
      errorMessage?: string
      usedSkills: string[]
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
    } | null>
    deleteTraces: (traceIds: string[]) => Promise<{
      deletedIds: string[]
      failed: Array<{ traceId: string; error: string }>
    }>
    getOnlineSkillEvolutionEnabled: () => Promise<boolean>
    setOnlineSkillEvolutionEnabled: (enabled: boolean) => Promise<void>
    getAutoPropose: () => Promise<boolean>
    setAutoPropose: (enabled: boolean) => Promise<void>
    getThreshold: () => Promise<number>
    setThreshold: (value: number) => Promise<void>
  }
  hooks: {
    list: () => Promise<HookConfig[]>
    skills: {
      list: () => Promise<SkillHookMetadata[]>
    }
    onChanged: (callback: (data: { reason?: string; at: string }) => void) => () => void
    create: (config: HookUpsert) => Promise<{ id: string }>
    update: (config: HookUpsert & { id: string }) => Promise<{ id: string }>
    delete: (id: string) => Promise<void>
    setEnabled: (id: string, enabled: boolean) => Promise<void>
    workspace: {
      list: (workspacePath: string) => Promise<HookConfig[]>
      untrusted: (
        workspacePath: string
      ) => Promise<{ fileName: string; filePath: string; event: string; command: string }[]>
      trustAll: (workspacePath: string) => Promise<void>
      trustFile: (workspacePath: string, fileName: string, filePath: string) => Promise<void>
      onChanged: (
        callback: (data: { threadId: string; workspacePath: string }) => void
      ) => () => void
    }
    logging: {
      get: () => Promise<HookLoggingConfig>
      save: (updates: Partial<HookLoggingConfig>) => Promise<HookLoggingConfig>
      getLogDir: () => Promise<string>
      openLogDir: () => Promise<{ success: boolean; error?: string }>
      onChanged: (callback: (config: HookLoggingConfig) => void) => () => void
    }
  }
  codeExecTools: {
    list: () => Promise<ManagedSavedCodeExecTool[]>
    getSettings: () => Promise<{ codeExecEnabled: boolean }>
    setCodeExecEnabled: (enabled: boolean) => Promise<void>
    setEnabled: (id: string, enabled: boolean) => Promise<ManagedSavedCodeExecTool>
    setLastPreviewParams: (
      id: string,
      params: Record<string, unknown>
    ) => Promise<ManagedSavedCodeExecTool>
    update: (payload: SavedCodeExecToolUpdatePayload) => Promise<ManagedSavedCodeExecTool>
    delete: (id: string) => Promise<void>
    runPreview: (payload: SavedCodeExecPreviewPayload) => Promise<SavedCodeExecPreviewResult>
  }
  routing: {
    getMode: () => Promise<"auto" | "pinned">
    setMode: (mode: "auto" | "pinned") => Promise<void>
  }
  dashboard: {
    isAllowed: () => Promise<boolean>
    overview: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom"
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    modelStats: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom"
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    userStats: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      opts?: { upperOrgLv1?: string | null }
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    userList: (
      range: { from: string; to: string },
      options?: DashboardUserListOptions
    ) => Promise<{ success: boolean; data?: DashboardUserListData; error?: string }>
    userDetail: (
      sapId: string,
      range: { from: string; to: string },
      options?: DashboardUserDetailOptions
    ) => Promise<{ success: boolean; data?: DashboardUserDetail; error?: string }>
    skillUsageSummary: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      // 可选：指定技能名后，后端按技能名聚合返回用户数。
      skillNames?: string[]
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    skillUserStats: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom",
      skillName: string
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    userProfiles: (
      sapIds: string[]
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    queryAllUser: () => Promise<{
      success: boolean
      data?: DashboardAllUserItem[]
      error?: string
    }>
    productivity: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom"
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    feedback: (
      range: { from: string; to: string },
      granularity: "day" | "week" | "month" | "custom"
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
    skillRecentTraces: (
      skill: string,
      range: { from: string; to: string },
      limit?: number
    ) => Promise<{ success: boolean; data?: DashboardTraceDetail[]; error?: string }>
    marketSkillRecentTraces: (
      skill: string,
      range: { from: string; to: string },
      limit?: number
    ) => Promise<{ success: boolean; data?: DashboardTraceDetail[]; error?: string }>
    skillDetail: (
      skill: string,
      range: { from: string; to: string },
      options?: number | { page?: number; pageSize?: number; limit?: number }
    ) => Promise<{ success: boolean; data?: DashboardSkillDetail; error?: string }>
    commitDetails: (
      range: { from: string; to: string },
      options?: DashboardCommitDetailsOptions
    ) => Promise<{
      success: boolean
      data?: {
        total: number
        page: number
        pageSize: number
        pushedOnly: boolean
        items: DashboardCommitDetail[]
      }
      error?: string
    }>
    exportSkillTraces: (payload: {
      skill: string
      range: { from: string; to: string }
      page: number
      pageSize: number
      totalTraces: number
      traces: DashboardTraceDetail[]
    }) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>
    exportExcel: (
      sheets: Array<{ name: string; header: string[]; rows: (string | number)[][] }>
    ) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>
  }
  update: {
    check: () => Promise<
      | { hasUpdate: false }
      | {
          hasUpdate: true
          version: string
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
        }
    >
    download: () => Promise<{ success: boolean }>
    install: () => Promise<void>
    dismiss: () => Promise<{ success: boolean }>
    rollback: () => Promise<void>
    getStatus: () => Promise<{
      status: string
      update: {
        version: string
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
    }>
    getStartupResult: () => Promise<{ updatedFrom?: string; updatedTo?: string }>
    onAvailable: (
      callback: (info: {
        version: string
        updateType: string
        releaseNotes: string
        size: number
        mandatory: boolean
        autoDownloading?: boolean
      }) => void
    ) => () => void
    onProgress: (
      callback: (progress: {
        percent: number
        transferred: number
        total: number
        speed: string
        phase: "downloading" | "verifying" | "extracting"
        message: string
      }) => void
    ) => () => void
    onDownloaded: (
      callback: (info: {
        version: string
        updateType: string
        releaseNotes?: string
        size?: number
        mandatory?: boolean
      }) => void
    ) => () => void
    onError: (callback: (err: { message: string; silent?: boolean }) => void) => () => void
  }
  git: {
    currentBranch: (
      cwd?: string
    ) => Promise<{ isGitRepo: boolean; branch: string | null; isWorktree: boolean }>
    listBranches: (
      cwd?: string,
      options?: { refreshRemote?: boolean }
    ) => Promise<{ success: boolean; branches: string[]; error?: string }>
    switchBranch: (branch: string, cwd?: string) => Promise<{ success: boolean; error?: string }>
    createBranch: (branch: string, cwd?: string) => Promise<{ success: boolean; error?: string }>
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: CustomAPI
  }
}
