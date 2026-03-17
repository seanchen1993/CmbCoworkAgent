import { contextBridge, ipcRenderer } from "electron"
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

// Simple electron API - replaces @electron-toolkit/preload
const electronAPI = {
  ipcRenderer: {
    send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      ipcRenderer.on(channel, (_event, ...args) => listener(...args))
      return () => ipcRenderer.removeListener(channel, listener)
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
      const handler = (): void => { callback() }
      ipcRenderer.on("threads:changed", handler)
      return () => { ipcRenderer.removeListener("threads:changed", handler) }
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
        }>
      >
    },
    getCustomConfig: (id?: string): Promise<{
      id: string
      name: string
      baseUrl: string
      model: string
      hasApiKey: boolean
      maxTokens: number
    } | null> => {
      return ipcRenderer.invoke("models:getCustomConfig", id) as Promise<{
        id: string
        name: string
        baseUrl: string
        model: string
        hasApiKey: boolean
        maxTokens: number
      } | null>
    },
    setCustomConfig: (config: {
      id: string
      name: string
      baseUrl: string
      model: string
      apiKey?: string
      maxTokens?: number
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
    }): Promise<{ id: string }> => {
      return ipcRenderer.invoke("models:upsertCustomConfig", config) as Promise<{ id: string }>
    },
    deleteCustomConfig: (id: string): Promise<void> => {
      return ipcRenderer.invoke("models:deleteCustomConfig", id) as Promise<void>
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
    clearWorktreeContext: (threadId: string): Promise<void> => {
      return ipcRenderer.invoke("workspace:clearWorktreeContext", threadId) as Promise<void>
    },
    saveWorktreeContext: (threadId: string, gitRoot: string, branch: string, baseBranch?: string): Promise<void> => {
      return ipcRenderer.invoke("workspace:saveWorktreeContext", { threadId, gitRoot, branch, baseBranch }) as Promise<void>
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
    createWorktree: (
      gitRoot: string,
      branch: string
    ): Promise<{ success: boolean; path?: string; branch?: string; baseBranch?: string; error?: string }> => {
      return ipcRenderer.invoke("workspace:createWorktree", { gitRoot, branch }) as Promise<{
        success: boolean
        path?: string
        branch?: string
        baseBranch?: string
        error?: string
      }>
    },
    commitWorktree: (worktreePath: string, message: string): Promise<{ success: boolean; error?: string }> => {
      return ipcRenderer.invoke("workspace:commitWorktree", { worktreePath, message }) as Promise<{
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
    listFiles: (skillPath: string): Promise<{ success: boolean; files?: string[]; error?: string }> => {
      return ipcRenderer.invoke("skills:listFiles", skillPath)
    },
    getDisabled: (): Promise<string[]> => {
      return ipcRenderer.invoke("skills:getDisabled")
    },
    setDisabled: (skillNames: string[]): Promise<void> => {
      return ipcRenderer.invoke("skills:setDisabled", skillNames)
    },
    upload: (buffer: ArrayBuffer, fileName: string): Promise<{ success: boolean; skillName?: string; error?: string }> => {
      return ipcRenderer.invoke("skills:upload", { buffer, fileName })
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
      const handler = (): void => { callback() }
      ipcRenderer.on("scheduledTasks:changed", handler)
      return () => { ipcRenderer.removeListener("scheduledTasks:changed", handler) }
    },
    listenToStream: (
      threadId: string,
      callback: (event: { type: string; [key: string]: unknown }) => void
    ): (() => void) => {
      const channel = `scheduler:stream:${threadId}`
      const handler = (_: unknown, data: { type: string; [key: string]: unknown }): void => { callback(data) }
      ipcRenderer.on(channel, handler)
      return () => { ipcRenderer.removeListener(channel, handler) }
    }
  },
  memory: {
    listFiles: (): Promise<Array<{ name: string; size: number; modifiedAt: string }>> =>
      ipcRenderer.invoke("memory:listFiles"),
    readFile: (name: string): Promise<string> =>
      ipcRenderer.invoke("memory:readFile", name),
    deleteFile: (name: string): Promise<void> =>
      ipcRenderer.invoke("memory:deleteFile", name),
    getEnabled: (): Promise<boolean> =>
      ipcRenderer.invoke("memory:getEnabled"),
    setEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("memory:setEnabled", enabled),
    getStats: (): Promise<{ fileCount: number; totalSize: number; indexSize: number; enabled: boolean }> =>
      ipcRenderer.invoke("memory:getStats"),
    onChanged: (callback: () => void): (() => void) => {
      const handler = (): void => { callback() }
      ipcRenderer.on("memory:changed", handler)
      return () => { ipcRenderer.removeListener("memory:changed", handler) }
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
    runNow: (): Promise<void> =>
      ipcRenderer.invoke("heartbeat:runNow") as Promise<void>,
    cancel: (): Promise<void> =>
      ipcRenderer.invoke("heartbeat:cancel") as Promise<void>,
    isRunning: (): Promise<boolean> =>
      ipcRenderer.invoke("heartbeat:isRunning") as Promise<boolean>,
    resetConfig: (): Promise<HeartbeatConfig> =>
      ipcRenderer.invoke("heartbeat:resetConfig") as Promise<HeartbeatConfig>,
    onChanged: (callback: () => void): (() => void) => {
      const handler = (): void => { callback() }
      ipcRenderer.on("heartbeat:changed", handler)
      return () => { ipcRenderer.removeListener("heartbeat:changed", handler) }
    },
    listenToStream: (
      threadId: string,
      callback: (event: { type: string; [key: string]: unknown }) => void
    ): (() => void) => {
      const channel = `heartbeat:stream:${threadId}`
      const handler = (_: unknown, data: { type: string; [key: string]: unknown }): void => { callback(data) }
      ipcRenderer.on(channel, handler)
      return () => { ipcRenderer.removeListener(channel, handler) }
    }
  },
  plugins: {
    list: (): Promise<PluginMetadata[]> =>
      ipcRenderer.invoke("plugins:list") as Promise<PluginMetadata[]>,
    install: (buffer: ArrayBuffer, fileName: string): Promise<{ success: boolean; pluginName?: string; error?: string }> =>
      ipcRenderer.invoke("plugins:install", { buffer, fileName }) as Promise<{ success: boolean; pluginName?: string; error?: string }>,
    installFromDir: (): Promise<{ success: boolean; pluginName?: string; error?: string }> =>
      ipcRenderer.invoke("plugins:installFromDir") as Promise<{ success: boolean; pluginName?: string; error?: string }>,
    delete: (id: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("plugins:delete", id) as Promise<{ success: boolean; error?: string }>,
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("plugins:setEnabled", { id, enabled }) as Promise<void>,
    getDetail: (id: string): Promise<{ skills: string[]; mcpServers: string[]; manifest: PluginManifest | null }> =>
      ipcRenderer.invoke("plugins:getDetail", id) as Promise<{ skills: string[]; mcpServers: string[]; manifest: PluginManifest | null }>
  },
  sandbox: {
    getMode: (): Promise<"none" | "unelevated" | "readonly"> =>
      ipcRenderer.invoke("sandbox:getMode") as Promise<"none" | "unelevated" | "readonly">,
    setMode: (mode: "none" | "unelevated" | "readonly"): Promise<void> =>
      ipcRenderer.invoke("sandbox:setMode", mode) as Promise<void>,
    getYoloMode: (): Promise<boolean> =>
      ipcRenderer.invoke("sandbox:getYoloMode") as Promise<boolean>,
    setYoloMode: (yolo: boolean): Promise<void> =>
      ipcRenderer.invoke("sandbox:setYoloMode", yolo) as Promise<void>,
    onChanged: (callback: () => void): (() => void) => {
      const handler = (): void => { callback() }
      ipcRenderer.on("sandbox:changed", handler)
      return () => { ipcRenderer.removeListener("sandbox:changed", handler) }
    }
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
