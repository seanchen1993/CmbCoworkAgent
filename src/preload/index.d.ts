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
  ChatXConfig,
  PluginMetadata,
  PluginManifest
} from "../main/types"
import {UserInfoConfig} from '../main/storage'
import type { HookConfig, HookUpsert } from "../main/hooks/types"

interface ElectronAPI {
  openExternal: Promise
  openLoginWindow:()=>void
  closeLoginWindow:()=>void
  onNotifyMsg: (callback: (msg:string)=>void)=>void
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
    upsertUserInfo: (config: UserInfoConfig) => Promise<{ id: string }>
    getUserInfo: () => Promise<UserInfoConfig | null>
    deleteCustomConfig: (id: string) => Promise<void>
    testConnection: (params: {
      id?: string
      baseUrl?: string
      model?: string
      apiKey?: string
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
    sendApprovalDecision: (decision: { requestId: string; type: string; tool_call_id: string }) => void
    onApprovalRequest: (threadId: string, callback: (request: unknown) => void) => () => void
    onApprovalTimeout: (threadId: string, callback: (data: { requestId: string }) => void) => () => void
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
    getCandidates: () => Promise<Array<{
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
    }>>
    approve: (candidateId: string) => Promise<{ success: boolean; skillId?: string; error?: string }>
    reject: (candidateId: string) => Promise<{ success: boolean }>
    clear: () => Promise<void>
    getTraces: (opts?: { threadId?: string; limit?: number }) => Promise<Array<{
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
    }>>
    onAutoTriggered: (cb: (payload: { threadId: string; toolCallCount: number }) => void) => () => void
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
