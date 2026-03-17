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
  PluginMetadata,
  PluginManifest,
  HookConfig,
  HookUpsert
} from "../main/types"

interface ElectronAPI {
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

interface CustomAPI {
  agent: {
    invoke: (
      threadId: string,
      message: string,
      onEvent: (event: StreamEvent) => void,
      modelId?: string
    ) => () => void
    streamAgent: (
      threadId: string,
      message: string,
      command: unknown,
      onEvent: (event: StreamEvent) => void,
      modelId?: string
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
    }>
    getCustomConfigs: () => Promise<
      Array<{
        id: string
        name: string
        baseUrl: string
        model: string
        hasApiKey: boolean
        maxTokens: number
      }>
    >
    getCustomConfig: (id?: string) => Promise<{
      id: string
      name: string
      baseUrl: string
      model: string
      hasApiKey: boolean
      maxTokens: number
    } | null>
    setCustomConfig: (config: {
      id: string
      name: string
      baseUrl: string
      model: string
      apiKey?: string
      maxTokens?: number
    }) => Promise<void>
    // Backward-compatible alias, prefer upsertCustomConfig in new code.
    upsertCustomConfig: (config: {
      id?: string
      name: string
      baseUrl: string
      model: string
      apiKey?: string
      maxTokens?: number
    }) => Promise<{ id: string }>
    deleteCustomConfig: (id: string) => Promise<void>
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
    clearWorktreeContext: (threadId: string) => Promise<void>
    saveWorktreeContext: (threadId: string, gitRoot: string, branch: string, baseBranch?: string) => Promise<void>
    isGit: (folderPath: string) => Promise<{
      isGit: boolean
      gitRoot: string | null
      worktrees: Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>
      isWorktreePath: boolean
    }>
    listWorktrees: (gitRoot: string) => Promise<
      Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>
    >
    createWorktree: (gitRoot: string, branch: string) => Promise<{
      success: boolean
      path?: string
      branch?: string
      baseBranch?: string
      error?: string
    }>
    commitWorktree: (worktreePath: string, message: string) => Promise<{
      success: boolean
      error?: string
    }>
    onFilesChanged: (
      callback: (data: { threadId: string; workspacePath: string }) => void
    ) => () => void
  }
  skills: {
    list: () => Promise<SkillMetadata[]>
    read: (skillPath: string) => Promise<{ success: boolean; content?: string; error?: string }>
    readBinary: (
      skillPath: string
    ) => Promise<{ success: boolean; content?: string; mimeType?: string; error?: string }>
    listFiles: (skillPath: string) => Promise<{ success: boolean; files?: string[]; error?: string }>
    getDisabled: () => Promise<string[]>
    setDisabled: (skillNames: string[]) => Promise<void>
    upload: (buffer: ArrayBuffer, fileName: string) => Promise<{ success: boolean; skillName?: string; error?: string }>
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
    getStats: () => Promise<{ fileCount: number; totalSize: number; indexSize: number; enabled: boolean }>
    onChanged: (callback: () => void) => () => void
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
    install: (buffer: ArrayBuffer, fileName: string) => Promise<{ success: boolean; pluginName?: string; error?: string }>
    installFromDir: () => Promise<{ success: boolean; pluginName?: string; error?: string }>
    delete: (id: string) => Promise<{ success: boolean; error?: string }>
    setEnabled: (id: string, enabled: boolean) => Promise<void>
    getDetail: (id: string) => Promise<{ skills: string[]; mcpServers: string[]; manifest: PluginManifest | null }>
  }
  sandbox: {
    getMode: () => Promise<"none" | "unelevated">
    setMode: (mode: "none" | "unelevated") => Promise<void>
    getYoloMode: () => Promise<boolean>
    setYoloMode: (yolo: boolean) => Promise<void>
    onChanged: (callback: () => void) => () => void
  }
  hooks: {
    list: () => Promise<HookConfig[]>
    create: (config: HookUpsert) => Promise<{ id: string }>
    update: (config: HookUpsert & { id: string }) => Promise<{ id: string }>
    delete: (id: string) => Promise<void>
    setEnabled: (id: string, enabled: boolean) => Promise<void>
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: CustomAPI
  }
}
