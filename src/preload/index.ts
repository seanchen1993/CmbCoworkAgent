import { contextBridge, ipcRenderer, shell, webUtils } from "electron"
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
  ChatXConfig
} from "../main/types"
import type { HookConfig, HookUpsert } from "../main/hooks/types"
import { UserInfoConfig } from "../main/storage"

// Simple electron API - replaces @electron-toolkit/preload
const electronAPI = {
  openExternal: (url: string) => shell.openExternal(url),
  openLoginWindow: () => ipcRenderer.invoke("open-login-window"),
  closeLoginWindow: () => ipcRenderer.invoke("close-login-window"),
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

// Custom APIs for renderer
const api = {
  agent: {
    // Send message and receive events via callback
    invoke: (
      threadId: string,
      message: string,
      onEvent: (event: StreamEvent) => void,
      modelId?: string
    ): (() => void) => {
      const channel = `agent:stream:${threadId}`

      const handler = (_: unknown, data: StreamEvent): void => {
        onEvent(data)
        if (data.type === "done" || data.type === "error") {
          ipcRenderer.removeListener(channel, handler)
        }
      }

      ipcRenderer.on(channel, handler)
      ipcRenderer.send("agent:invoke", { threadId, message, modelId })

      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    streamAgent: (
      threadId: string,
      message: string,
      command: unknown,
      onEvent: (event: StreamEvent) => void,
      modelId?: string
    ): (() => void) => {
      const channel = `agent:stream:${threadId}`

      const handler = (_: unknown, data: StreamEvent): void => {
        onEvent(data)
        if (data.type === "done" || data.type === "error") {
          ipcRenderer.removeListener(channel, handler)
        }
      }

      ipcRenderer.on(channel, handler)

      if (command) {
        ipcRenderer.send("agent:resume", { threadId, command, modelId })
      } else {
        ipcRenderer.send("agent:invoke", { threadId, message, modelId })
      }

      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    interrupt: (
      threadId: string,
      decision: HITLDecision,
      onEvent?: (event: StreamEvent) => void
    ): (() => void) => {
      const channel = `agent:stream:${threadId}`

      const handler = (_: unknown, data: StreamEvent): void => {
        onEvent?.(data)
        if (data.type === "done" || data.type === "error") {
          ipcRenderer.removeListener(channel, handler)
        }
      }

      ipcRenderer.on(channel, handler)
      ipcRenderer.send("agent:interrupt", { threadId, decision })

      // Return cleanup function
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    cancel: (threadId: string): Promise<void> => {
      return ipcRenderer.invoke("agent:cancel", { threadId })
    }
  },
  threads: {
    list: (): Promise<Thread[]> => {
      return ipcRenderer.invoke("threads:list")
    },
    get: (threadId: string): Promise<Thread | null> => {
      return ipcRenderer.invoke("threads:get", threadId)
    },
    create: (metadata?: Record<string, unknown>): Promise<Thread> => {
      return ipcRenderer.invoke("threads:create", metadata)
    },
    update: (threadId: string, updates: Partial<Thread>): Promise<Thread> => {
      return ipcRenderer.invoke("threads:update", { threadId, updates })
    },
    delete: (threadId: string): Promise<void> => {
      return ipcRenderer.invoke("threads:delete", threadId)
    },
    getHistory: (threadId: string): Promise<unknown[]> => {
      return ipcRenderer.invoke("threads:history", threadId)
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
    getTokenLimits: (): Promise<{
      defaultMaxTokens: number
      minMaxTokens: number
      maxMaxTokens: number
    }> => {
      return ipcRenderer.invoke("models:getTokenLimits") as Promise<{
        defaultMaxTokens: number
        minMaxTokens: number
        maxMaxTokens: number
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
        interleavedThinking?: boolean
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
          interleavedThinking?: boolean
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
      interleavedThinking?: boolean
      tier?: "premium" | "economy"
    } | null> => {
      return ipcRenderer.invoke("models:getCustomConfig", id) as Promise<{
        id: string
        name: string
        baseUrl: string
        model: string
        hasApiKey: boolean
        maxTokens: number
        interleavedThinking?: boolean
        tier?: "premium" | "economy"
      } | null>
    },
    setCustomConfig: (config: {
      id: string
      name: string
      baseUrl: string
      model: string
      apiKey?: string
      maxTokens?: number
      interleavedThinking?: boolean
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
      interleavedThinking?: boolean
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
    }): Promise<{ success: boolean; error?: string; latencyMs?: number }> => {
      return ipcRenderer.invoke("models:testConnection", params) as Promise<{
        success: boolean
        error?: string
        latencyMs?: number
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
      threadId: string
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
    }> => {
      return ipcRenderer.invoke("workspace:loadFromDisk", { threadId })
    },
    readFile: (
      threadId: string,
      filePath: string
    ): Promise<{
      success: boolean
      content?: string
      size?: number
      modified_at?: string
      error?: string
    }> => {
      return ipcRenderer.invoke("workspace:readFile", { threadId, filePath })
    },
    readBinaryFile: (
      threadId: string,
      filePath: string
    ): Promise<{
      success: boolean
      content?: string
      size?: number
      modified_at?: string
      error?: string
    }> => {
      return ipcRenderer.invoke("workspace:readBinaryFile", { threadId, filePath })
    },
    readExternalFile: (
      filePath: string
    ): Promise<{
      success: boolean
      content?: string
      size?: number
      modified_at?: string
      error?: string
    }> => {
      return ipcRenderer.invoke("workspace:readExternalFile", filePath)
    },
    readExternalBinaryFile: (
      filePath: string
    ): Promise<{
      success: boolean
      content?: string
      size?: number
      modified_at?: string
      error?: string
    }> => {
      return ipcRenderer.invoke("workspace:readExternalBinaryFile", filePath)
    },
    clearWorktreeContext: (threadId: string): Promise<void> => {
      return ipcRenderer.invoke("workspace:clearWorktreeContext", threadId) as Promise<void>
    },
    saveWorktreeContext: (threadId: string, gitRoot: string, branch: string, baseBranch?: string, baseCommit?: string): Promise<void> => {
      return ipcRenderer.invoke("workspace:saveWorktreeContext", { threadId, gitRoot, branch, baseBranch, baseCommit }) as Promise<void>
    },
    recordLlmModifiedFiles: (threadId: string, files: string[]): Promise<{ success: boolean; files?: string[]; error?: string }> => {
      return ipcRenderer.invoke("workspace:recordLlmModifiedFiles", { threadId, files }) as Promise<{
        success: boolean
        files?: string[]
        error?: string
      }>
    },
    getGitPanelState: (threadId: string): Promise<{
      success: boolean
      isWorktree: boolean
      isGitRepo?: boolean
      taskId: string
      files: Array<{ path: string; diff: string; additions: number; deletions: number }>
      totals: { additions: number; deletions: number; fileCount: number }
      hasPendingDiff: boolean
      hasPushableCommit: boolean
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
        files: Array<{ path: string; diff: string; additions: number; deletions: number }>
        totals: { additions: number; deletions: number; fileCount: number }
        hasPendingDiff: boolean
        hasPushableCommit: boolean
        trackedFiles?: string[]
        worktreeBranch?: string | null
        suggestedCommitMessage?: string
        error?: string
      }>
    },
    getGitPanelSummary: (threadId: string): Promise<{
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
    isGit: (
      folderPath: string
    ): Promise<{
      isGit: boolean
      gitRoot: string | null
      worktrees: Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>
      isWorktreePath: boolean
    }> => {
      return ipcRenderer.invoke("workspace:isGit", folderPath) as Promise<{
        isGit: boolean
        gitRoot: string | null
        worktrees: Array<{ path: string; branch: string; isMain: boolean; createdAt?: Date }>
        isWorktreePath: boolean
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
      gitRoot: string,
      worktreePath: string
    ): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("workspace:removeWorktree", {
        gitRoot,
        worktreePath
      }) as Promise<{ success: boolean; error?: string }>
    },
    createWorktree: (
      gitRoot: string,
      branch: string
    ): Promise<{ success: boolean; path?: string; branch?: string; baseBranch?: string; baseCommit?: string; error?: string }> => {
      return ipcRenderer.invoke("workspace:createWorktree", { gitRoot, branch }) as Promise<{
        success: boolean
        path?: string
        branch?: string
        baseBranch?: string
        baseCommit?: string
        error?: string
      }>
    },
    commitWorktree: (threadId: string, message: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("workspace:commitWorktree", { threadId, message }) as Promise<{
        success: boolean
        error?: string
      }>
    },
    pushWorktree: (threadId: string, message?: string): Promise<{
      success: boolean
      autoCommitted?: boolean
      error?: string
      steps?: Array<{ step: "pull" | "commit" | "push" | "verify" | "final"; status: "ok" | "failed" | "skipped"; detail: string }>
    }> => {
      return ipcRenderer.invoke("workspace:pushWorktree", { threadId, message }) as Promise<{
        success: boolean
        autoCommitted?: boolean
        error?: string
        steps?: Array<{ step: "pull" | "commit" | "push" | "verify" | "final"; status: "ok" | "failed" | "skipped"; detail: string }>
      }>
    },
    rejectWorktreeChanges: (threadId: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("workspace:rejectWorktreeChanges", { threadId }) as Promise<{
        success: boolean
        error?: string
      }>
    },
    rejectWorktreeFile: (threadId: string, filePath: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("workspace:rejectWorktreeFile", { threadId, filePath }) as Promise<{
        success: boolean
        error?: string
      }>
    },
    // Listen for file changes in the workspace
    onFilesChanged: (
      callback: (data: { threadId: string; workspacePath: string }) => void
    ): (() => void) => {
      const handler = (_: unknown, data: { threadId: string; workspacePath: string }): void => {
        callback(data)
      }
      ipcRenderer.on("workspace:files-changed", handler)
      // Return cleanup function
      return () => {
        ipcRenderer.removeListener("workspace:files-changed", handler)
      }
    }
  },
  file: {
    parse: (
      filePath: string,
      maxLength?: number
    ): Promise<{
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
    }> => {
      return ipcRenderer.invoke("file:parse", filePath, maxLength)
    },
    getFilePath: (file: File): string => {
      return webUtils.getPathForFile(file)
    },
    select: (): Promise<{ canceled: boolean; filePaths: string[] }> => {
      return ipcRenderer.invoke("file:select")
    },
    supportedExtensions: (): Promise<string[]> => {
      return ipcRenderer.invoke("file:supportedExtensions")
    }
  },
  skills: {
    list: (): Promise<SkillMetadata[]> => {
      return ipcRenderer.invoke("skills:list")
    },
    read: (skillPath: string): Promise<{ success: boolean; content?: string; error?: string }> => {
      return ipcRenderer.invoke("skills:read", skillPath)
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
    getDisabled: (): Promise<string[]> => {
      return ipcRenderer.invoke("skills:getDisabled")
    },
    setDisabled: (skillNames: string[]): Promise<void> => {
      return ipcRenderer.invoke("skills:setDisabled", skillNames)
    },
    upload: (
      buffer: ArrayBuffer,
      fileName: string
    ): Promise<{ success: boolean; skillName?: string; error?: string }> => {
      return ipcRenderer.invoke("skills:upload", { buffer, fileName })
    },
    extractMarkdownFromZip: (
      buffer: ArrayBuffer,
      fileName?: string
    ): Promise<{ success: boolean; filePath?: string; content?: string; error?: string }> => {
      return ipcRenderer.invoke("skills:extractMarkdownFromZip", { buffer, fileName })
    },
    delete: (skillPath: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("skills:delete", skillPath)
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
      url?: string
      advanced?: McpConnectorConfig["advanced"]
    }): Promise<{ success: boolean; tools?: string[]; error?: string }> =>
      ipcRenderer.invoke("mcp:testConnection", params)
  },
  terminal: {
    create: (opts: { workDir?: string; args?: string[]; cols?: number; rows?: number; claudeModelId?: string }): Promise<string> =>
      ipcRenderer.invoke("terminal:create", opts),
    write: (id: string, data: string): void =>
      ipcRenderer.send("terminal:write", { id, data }),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send("terminal:resize", { id, cols, rows }),
    dispose: (id: string): Promise<void> =>
      ipcRenderer.invoke("terminal:dispose", id),
    selectDir: (): Promise<string | null> =>
      ipcRenderer.invoke("terminal:selectDir"),
    ack: (id: string, bytes: number): void =>
      ipcRenderer.send("terminal:ack", { id, bytes }),
    onData: (id: string, callback: (data: string, bytes: number) => void): (() => void) => {
      const channel = `terminal:data:${id}`
      const handler = (_: unknown, data: string, bytes: number): void => { callback(data, bytes) }
      ipcRenderer.on(channel, handler)
      return () => { ipcRenderer.removeListener(channel, handler) }
    },
    onExit: (id: string, callback: (code: number) => void): (() => void) => {
      const channel = `terminal:exit:${id}`
      const handler = (_: unknown, code: number): void => { callback(code) }
      ipcRenderer.on(channel, handler)
      return () => { ipcRenderer.removeListener(channel, handler) }
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
    }
  },
  memory: {
    listFiles: (): Promise<Array<{ name: string; size: number; modifiedAt: string }>> =>
      ipcRenderer.invoke("memory:listFiles"),
    readFile: (name: string): Promise<string> => ipcRenderer.invoke("memory:readFile", name),
    deleteFile: (name: string): Promise<void> => ipcRenderer.invoke("memory:deleteFile", name),
    getEnabled: (): Promise<boolean> => ipcRenderer.invoke("memory:getEnabled"),
    setEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("memory:setEnabled", enabled),
    getStats: (): Promise<{
      fileCount: number
      totalSize: number
      indexSize: number
      enabled: boolean
    }> => ipcRenderer.invoke("memory:getStats"),
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
  skillEvolution: {
    // ── Phase 1: Intent banner ("Want to save as skill?") ──────────
    onIntentRequest: (
      callback: (req: {
        threadId?: string
        requestId: string
        summary: string
        toolCallCount: number
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
    confirmResponse: (requestId: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke("skill:confirmResponse", { requestId, approved }) as Promise<void>,

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
      fileName: string
    ): Promise<{ success: boolean; pluginName?: string; error?: string }> =>
      ipcRenderer.invoke("plugins:install", { buffer, fileName }) as Promise<{
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
    delete: (id: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("plugins:delete", id) as Promise<{ success: boolean; error?: string }>,
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("plugins:setEnabled", { id, enabled }) as Promise<void>,
    getDetail: (
      id: string
    ): Promise<{ skills: string[]; mcpServers: string[]; manifest: PluginManifest | null }> =>
      ipcRenderer.invoke("plugins:getDetail", id) as Promise<{
        skills: string[]
        mcpServers: string[]
        manifest: PluginManifest | null
      }>
  },
  chatx: {
    getConfig: (): Promise<ChatXConfig> =>
      ipcRenderer.invoke("chatx:get-config") as Promise<ChatXConfig>,
    saveConfig: (updates: Partial<ChatXConfig>): Promise<void> =>
      ipcRenderer.invoke("chatx:save-config", updates) as Promise<void>,
    restart: (): Promise<void> => ipcRenderer.invoke("chatx:restart") as Promise<void>,
    cancelByThread: (threadId: string): Promise<boolean> =>
      ipcRenderer.invoke("chatx:cancel-by-thread", threadId) as Promise<boolean>
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
      type: string
      tool_call_id: string
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
      candidateId: string
    ): Promise<{ success: boolean; skillId?: string; error?: string }> =>
      ipcRenderer.invoke("optimizer:approve", { candidateId }) as Promise<{
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
    > =>
      ipcRenderer.invoke("optimizer:traces", opts) as Promise<
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
    } | null> =>
      ipcRenderer.invoke("optimizer:traceDetail", { traceId }) as Promise<{
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
      ipcRenderer.invoke("optimizer:setThreshold", value) as Promise<void>
  },
  hooks: {
    list: (): Promise<HookConfig[]> => ipcRenderer.invoke("hooks:list"),
    create: (config: HookUpsert): Promise<{ id: string }> =>
      ipcRenderer.invoke("hooks:create", config),
    update: (config: HookUpsert & { id: string }): Promise<{ id: string }> =>
      ipcRenderer.invoke("hooks:update", config),
    delete: (id: string): Promise<void> => ipcRenderer.invoke("hooks:delete", id),
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("hooks:setEnabled", { id, enabled })
  },
  routing: {
    getMode: (): Promise<"auto" | "pinned"> => ipcRenderer.invoke("routing:getMode"),
    setMode: (mode: "auto" | "pinned"): Promise<void> => ipcRenderer.invoke("routing:setMode", mode)
  },
  update: {
    check: (): Promise<
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
    > => ipcRenderer.invoke("update:check"),
    download: (): Promise<{ success: boolean }> => ipcRenderer.invoke("update:download"),
    install: (): Promise<void> => ipcRenderer.invoke("update:install"),
    dismiss: (): Promise<{ success: boolean }> => ipcRenderer.invoke("update:dismiss"),
    rollback: (): Promise<void> => ipcRenderer.invoke("update:rollback"),
    getStatus: (): Promise<{
      status: string
      update: { version: string; updateType: string; releaseNotes: string; size: number; mandatory: boolean } | null
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
    }> => ipcRenderer.invoke("update:get-status"),
    getStartupResult: (): Promise<{ updatedFrom?: string; updatedTo?: string }> =>
      ipcRenderer.invoke("update:get-startup-result"),
    onAvailable: (
      callback: (info: {
        version: string
        updateType: string
        releaseNotes: string
        size: number
        mandatory: boolean
        autoDownloading?: boolean
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
    onDownloaded: (callback: (info: { version: string; updateType: string; releaseNotes?: string; size?: number; mandatory?: boolean }) => void) => {
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
