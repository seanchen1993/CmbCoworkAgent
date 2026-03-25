import { IpcMain, dialog, app } from "electron"
import Store from "electron-store"
import * as fs from "fs/promises"
import * as path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import type {
  ModelConfig,
  Provider,
  WorkspaceSetParams,
  WorkspaceLoadParams,
  WorkspaceFileParams
} from "../types"
import { startWatching, stopWatching } from "../services/workspace-watcher"
import { tryStartCodeIndex as _tryStartCodeIndex } from "../code-index/manager"
import { getCodeIndexSettings } from "../storage"

const execFileAsync = promisify(execFile)

const MAX_WORKTREES = 10

/** Fire-and-forget: start code indexing for a workspace if enabled */
function tryStartCodeIndex(workspacePath: string): void {
  _tryStartCodeIndex(workspacePath, getCodeIndexSettings())
}

export interface WorktreeInfo {
  path: string
  branch: string
  isMain: boolean
  createdAt?: Date
}

async function getGitRoot(folderPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", folderPath, "rev-parse", "--show-toplevel"])
    return stdout.trim()
  } catch {
    return null
  }
}

async function listWorktrees(gitRoot: string): Promise<WorktreeInfo[]> {
  const { stdout } = await execFileAsync("git", ["-C", gitRoot, "worktree", "list", "--porcelain"])
  const worktrees: WorktreeInfo[] = []
  const blocks = stdout.trim().split(/\n\n+/)

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block.trim()) continue
    const lines = block.trim().split("\n")
    const worktreePath = lines.find((l) => l.startsWith("worktree "))?.slice(9).trim() ?? ""
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).trim().replace("refs/heads/", "") ?? "(detached)"
    const isMain = lines.some((l) => l === "bare") || i === 0

    let createdAt: Date | undefined
    try {
      const stat = await fs.stat(worktreePath)
      createdAt = stat.birthtime
    } catch {
      createdAt = undefined
    }

    if (worktreePath) {
      worktrees.push({ path: worktreePath, branch, isMain, createdAt })
    }
  }

  return worktrees
}

import {
  getOpenworkDir,
  getCustomModelPublicConfigById,
  getCustomModelPublicConfigs,
  getCustomModelConfigById,
  setCustomModelConfig,
  upsertCustomModelConfig,
  deleteCustomModelConfig,
  upsertUserInfoConfig,
  getUserInfo,
  DEFAULT_MAX_TOKENS,
  MIN_MAX_TOKENS,
  MAX_MAX_TOKENS
} from "../storage"
import type { CustomModelConfig } from "../storage"

// Store for non-sensitive settings only (no encryption needed)
const store = new Store({
  name: "settings",
  cwd: getOpenworkDir()
})

const PROVIDERS: Omit<Provider, "hasAnyModelApiKey">[] = [
  { id: "custom", name: "Custom" }
]

function resolveDefaultModelId(): string {
  const customConfigs = getCustomModelPublicConfigs()
  return customConfigs.length > 0 ? `custom:${customConfigs[0].id}` : ""
}

export function registerModelHandlers(ipcMain: IpcMain): void {
  // List available models (custom only)
  ipcMain.handle("models:list", async () => {
    const customConfigs = getCustomModelPublicConfigs()
    const models: ModelConfig[] = customConfigs.map((customConfig) => ({
      id: `custom:${customConfig.id}`,
      name: customConfig.name,
      provider: "custom",
      model: customConfig.model,
      description: customConfig.baseUrl,
      available: customConfig.hasApiKey
    }))

    return models
  })

  ipcMain.handle("models:getCustomConfigs", async () => {
    return getCustomModelPublicConfigs()
  })

  ipcMain.handle("models:getCustomConfig", async (_event, id?: string) => {
    if (id) {
      return getCustomModelPublicConfigById(id)
    }
    const all = getCustomModelPublicConfigs()
    return all[0] || null
  })

  ipcMain.handle("models:setCustomConfig", async (_event, config: CustomModelConfig) => {
    setCustomModelConfig(config)
  })

  ipcMain.handle(
    "models:upsertCustomConfig",
    async (_event, config: Omit<CustomModelConfig, "id"> & { id?: string }) => {
      const id = upsertCustomModelConfig(config)
      return { id }
    }
  )

  ipcMain.handle(
    "models:upsertUserInfo",
    async (_event, config: Omit<CustomModelConfig, "id"> & { id?: string }) => {
      const id = upsertUserInfoConfig(config)
      return { id }
    }
  )

  ipcMain.handle(
    "models:getUserInfo",
    async () => {
      const userInfo = getUserInfo()
      return userInfo
    }
  )

  ipcMain.handle("models:deleteCustomConfig", async (_event, id: string) => {
    if (!id) throw new Error("Model id is required for deletion")
    deleteCustomModelConfig(id)
  })

  // Get default model
  ipcMain.handle("models:getDefault", async () => {
    const stored = store.get("defaultModel", "") as string
    return stored || resolveDefaultModelId()
  })

  // Set default model
  ipcMain.handle("models:setDefault", async (_event, modelId: string) => {
    store.set("defaultModel", modelId)
  })

  // List providers with whether any model has a key configured.
  ipcMain.handle("models:listProviders", async () => {
    const hasAnyModelApiKey = getCustomModelPublicConfigs().some((config) => config.hasApiKey)
    return PROVIDERS.map((provider) => ({
      ...provider,
      hasAnyModelApiKey
    }))
  })

  ipcMain.handle("models:getTokenLimits", async () => {
    return {
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      minMaxTokens: MIN_MAX_TOKENS,
      maxMaxTokens: MAX_MAX_TOKENS
    }
  })

  // Test model connection by sending a minimal chat completions request
  ipcMain.handle(
    "models:testConnection",
    async (
      _event,
      params: { id?: string; baseUrl?: string; model?: string; apiKey?: string }
    ): Promise<{ success: boolean; error?: string; latencyMs?: number }> => {
      let baseUrl: string
      let model: string
      let apiKey: string

      if (params.id) {
        // Test an existing saved config — read API key from storage
        const saved = getCustomModelConfigById(params.id)
        if (!saved) return { success: false, error: "未找到该模型配置" }
        baseUrl = params.baseUrl || saved.baseUrl
        model = params.model || saved.model
        apiKey = params.apiKey || saved.apiKey || ""
      } else {
        baseUrl = params.baseUrl || ""
        model = params.model || ""
        apiKey = params.apiKey || ""
      }

      if (!baseUrl) return { success: false, error: "接口地址不能为空" }
      if (!model) return { success: false, error: "模型名称不能为空" }
      if (!apiKey) return { success: false, error: "API 密钥不能为空" }

      // Normalise URL: parse first, then operate on pathname to handle query params correctly
      let urlObj: URL
      try {
        urlObj = new URL(baseUrl.replace(/\/+$/, ""))
      } catch {
        return { success: false, error: "接口地址格式无效" }
      }
      if (!["http:", "https:"].includes(urlObj.protocol)) {
        return { success: false, error: "仅支持 http/https 协议" }
      }
      urlObj.pathname = urlObj.pathname
        .replace(/\/chat\/completions\/?$/, "")
        .replace(/\/+$/, "") + "/chat/completions"
      const url = urlObj.toString()

      const start = Date.now()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Hi" }],
            max_tokens: 1,
            stream: false
          }),
          signal: controller.signal
        })

        const latencyMs = Date.now() - start

        if (!res.ok) {
          const body = await res.text().catch(() => "")
          let detail = ""
          try {
            const json = JSON.parse(body)
            detail = json.error?.message || json.message || ""
          } catch {
            detail = body.slice(0, 200)
          }
          return {
            success: false,
            error: `HTTP ${res.status}${detail ? ": " + detail : ""}`,
            latencyMs
          }
        }

        return { success: true, latencyMs }
      } catch (e) {
        const latencyMs = Date.now() - start
        const msg =
          e instanceof Error
            ? e.name === "AbortError"
              ? "连接超时（15 秒）"
              : e.message
            : "未知错误"
        return { success: false, error: msg, latencyMs }
      } finally {
        clearTimeout(timeout)
      }
    }
  )

  // Sync version info
  ipcMain.on("app:version", (event) => {
    event.returnValue = app.getVersion()
  })

  // Get workspace path for a thread (from thread metadata)
  ipcMain.handle("workspace:get", async (_event, threadId?: string) => {
    if (!threadId) {
      // Fallback to global setting for backwards compatibility
      return store.get("workspacePath", null) as string | null
    }

    // Get from thread metadata via threads:get
    const { getThread } = await import("../db")
    const thread = getThread(threadId)
    if (!thread?.metadata) return null

    const metadata = JSON.parse(thread.metadata)
    return metadata.workspacePath || null
  })

  // Set workspace path for a thread (stores in thread metadata)
  ipcMain.handle(
    "workspace:set",
    async (_event, { threadId, path: newPath }: WorkspaceSetParams) => {
      if (!threadId) {
        // Fallback to global setting
        if (newPath) {
          store.set("workspacePath", newPath)
        } else {
          store.delete("workspacePath")
        }
        return newPath
      }

      const { getThread, updateThread } = await import("../db")
      const thread = getThread(threadId)
      if (!thread) return null

      const metadata = thread.metadata ? JSON.parse(thread.metadata) : {}
      metadata.workspacePath = newPath
      updateThread(threadId, { metadata: JSON.stringify(metadata) })

      // Update file watcher
      if (newPath) {
        startWatching(threadId, newPath)
        // Start code indexing in background if enabled
        tryStartCodeIndex(newPath)
      } else {
        stopWatching(threadId)
      }

      return newPath
    }
  )

  // Select workspace folder via dialog (for a specific thread)
  ipcMain.handle("workspace:select", async (_event, threadId?: string) => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Select Workspace Folder",
      message: "Choose a folder for the agent to work in"
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const selectedPath = result.filePaths[0]

    if (threadId) {
      const { getThread, updateThread } = await import("../db")
      const thread = getThread(threadId)
      if (thread) {
        const metadata = thread.metadata ? JSON.parse(thread.metadata) : {}
        metadata.workspacePath = selectedPath
        updateThread(threadId, { metadata: JSON.stringify(metadata) })

        // Start watching the new workspace
        startWatching(threadId, selectedPath)
        // Start code indexing in background if enabled
        tryStartCodeIndex(selectedPath)
      }
    } else {
      // Fallback to global
      store.set("workspacePath", selectedPath)
      tryStartCodeIndex(selectedPath)
    }

    return selectedPath
  })

  // Load files from disk into the workspace view
  ipcMain.handle("workspace:loadFromDisk", async (_event, { threadId }: WorkspaceLoadParams) => {
    const { getThread } = await import("../db")

    // Get workspace path from thread metadata
    const thread = getThread(threadId)
    const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
    const workspacePath = metadata.workspacePath as string | null

    if (!workspacePath) {
      return { success: false, error: "No workspace folder linked", files: [] }
    }

    try {
      const files: Array<{
        path: string
        is_dir: boolean
        size?: number
        modified_at?: string
      }> = []

      // Recursively read directory
      async function readDir(dirPath: string, relativePath: string = ""): Promise<void> {
        const entries = await fs.readdir(dirPath, { withFileTypes: true })

        for (const entry of entries) {
          // Skip hidden files and common non-project files
          if (entry.name.startsWith(".") || entry.name === "node_modules") {
            continue
          }

          const fullPath = path.join(dirPath, entry.name)
          const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name

          if (entry.isDirectory()) {
            files.push({
              path: "/" + relPath,
              is_dir: true
            })
            await readDir(fullPath, relPath)
          } else {
            const stat = await fs.stat(fullPath)
            files.push({
              path: "/" + relPath,
              is_dir: false,
              size: stat.size,
              modified_at: stat.mtime.toISOString()
            })
          }
        }
      }

      await readDir(workspacePath)

      // Start watching for file changes
      startWatching(threadId, workspacePath)

      return {
        success: true,
        files,
        workspacePath
      }
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Unknown error",
        files: []
      }
    }
  })

  // Read a single file's contents from disk
  ipcMain.handle(
    "workspace:readFile",
    async (_event, { threadId, filePath }: WorkspaceFileParams) => {
      const { getThread } = await import("../db")

      // Get workspace path from thread metadata
      const thread = getThread(threadId)
      const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
      const workspacePath = metadata.workspacePath as string | null

      if (!workspacePath) {
        return {
          success: false,
          error: "No workspace folder linked"
        }
      }

      try {
        // Convert virtual path to full disk path
        const relativePath = filePath.startsWith("/") ? filePath.slice(1) : filePath
        const fullPath = path.join(workspacePath, relativePath)

        // Security check: ensure the resolved path is within the workspace
        const resolvedPath = path.resolve(fullPath)
        const resolvedWorkspace = path.resolve(workspacePath)
        if (!resolvedPath.startsWith(resolvedWorkspace)) {
          return { success: false, error: "Access denied: path outside workspace" }
        }

        // Check if file exists
        const stat = await fs.stat(fullPath)
        if (stat.isDirectory()) {
          return { success: false, error: "Cannot read directory as file" }
        }

        // Read file contents
        const content = await fs.readFile(fullPath, "utf-8")

        return {
          success: true,
          content,
          size: stat.size,
          modified_at: stat.mtime.toISOString()
        }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "Unknown error"
        }
      }
    }
  )

  // Check if a folder is a git repo and return root path + worktrees
  ipcMain.handle("workspace:isGit", async (_event, folderPath: string) => {
    const gitRoot = await getGitRoot(folderPath)
    if (!gitRoot) return { isGit: false, gitRoot: null, worktrees: [], isWorktreePath: false }

    // Detect if folderPath is itself a worktree (not the main repo).
    // In a worktree, "git rev-parse --git-dir" returns a path like /repo/.git/worktrees/<name>
    let isWorktreePath = false
    try {
      const { stdout } = await execFileAsync("git", ["-C", folderPath, "rev-parse", "--git-dir"])
      isWorktreePath = stdout.trim().includes(`${path.sep}worktrees${path.sep}`) ||
                       stdout.trim().includes("/.git/worktrees/")
    } catch { /* ignore */ }

    const worktrees = await listWorktrees(gitRoot)
    return { isGit: true, gitRoot, worktrees, isWorktreePath }
  })

  // List worktrees for a git repo
  ipcMain.handle("workspace:listWorktrees", async (_event, gitRoot: string) => {
    try {
      return await listWorktrees(gitRoot)
    } catch {
      return []
    }
  })

  // Create a new worktree; enforces MAX_WORKTREES limit
  ipcMain.handle(
    "workspace:createWorktree",
    async (_event, { gitRoot, branch }: { gitRoot: string; branch: string }) => {
      const worktrees = await listWorktrees(gitRoot)
      const nonMain = worktrees.filter((w) => !w.isMain)

      if (nonMain.length >= MAX_WORKTREES) {
        return {
          success: false,
          error: `已达到 Worktree 数量上限（${MAX_WORKTREES} 个），请先删除不用的 Worktree 后再创建。`
        }
      }

      const safeBranch = branch.replace(/[^a-zA-Z0-9\-_./]/g, "-")

      // Check if branch is already checked out in an existing worktree
      const branchConflict = worktrees.find((w) => w.branch === safeBranch)
      if (branchConflict) {
        return {
          success: false,
          error: `分支 "${safeBranch}" 已在 Worktree 中使用（${branchConflict.path}），同一分支不能同时被两个 Worktree 检出。`
        }
      }

      const repoName = path.basename(gitRoot)
      const baseDir = path.join(gitRoot, "..")
      const baseName = `${repoName}-wt-${safeBranch.replace(/\//g, "-")}`

      // Resolve unique path by appending -2, -3... if directory already exists
      let worktreePath = path.join(baseDir, baseName)
      let suffix = 2
      while (true) {
        try {
          await fs.access(worktreePath)
          worktreePath = path.join(baseDir, `${baseName}-${suffix}`)
          suffix++
        } catch {
          break
        }
      }

      try {
        // Get the current branch of the main repo as the base branch
        let baseBranch = "main"
        try {
          const r = await execFileAsync("git", ["-C", gitRoot, "rev-parse", "--abbrev-ref", "HEAD"])
          baseBranch = r.stdout.trim() || "main"
        } catch { /* ignore */ }

        await execFileAsync("git", ["-C", gitRoot, "worktree", "add", "-b", safeBranch, worktreePath])
        return { success: true, path: worktreePath, branch: safeBranch, baseBranch }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "创建 Worktree 失败"
        }
      }
    }
  )

  // Save worktree context (gitRoot, branch, baseBranch) into thread metadata
  ipcMain.handle(
    "workspace:saveWorktreeContext",
    async (
      _event,
      { threadId, gitRoot, branch, baseBranch }: { threadId: string; gitRoot: string; branch: string; baseBranch?: string }
    ) => {
      const { getThread, updateThread } = await import("../db")
      const thread = getThread(threadId)
      if (!thread) return
      let metadata: Record<string, unknown> = {}
      try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { /* corrupted, reset */ }
      metadata.gitRoot = gitRoot
      metadata.isWorktree = true
      metadata.worktreeBranch = branch
      if (baseBranch) metadata.worktreeBaseBranch = baseBranch
      updateThread(threadId, { metadata: JSON.stringify(metadata) })
    }
  )

  // Clear worktree context from thread metadata
  ipcMain.handle("workspace:clearWorktreeContext", async (_event, threadId: string) => {
    const { getThread, updateThread } = await import("../db")
    const thread = getThread(threadId)
    if (!thread) return
    let metadata: Record<string, unknown> = {}
    try { metadata = thread.metadata ? JSON.parse(thread.metadata) : {} } catch { /* corrupted, reset */ }
    delete metadata.isWorktree
    delete metadata.gitRoot
    delete metadata.worktreeBranch
    delete metadata.worktreeBaseBranch
    updateThread(threadId, { metadata: JSON.stringify(metadata) })
  })

  // Commit all changes in a worktree with a user-provided message
  ipcMain.handle(
    "workspace:commitWorktree",
    async (_event, { worktreePath, message }: { worktreePath: string; message: string }) => {
      try {
        const status = await execFileAsync("git", ["-C", worktreePath, "status", "--porcelain"])
        if (!status.stdout.trim()) {
          return { success: false, error: "没有需要提交的改动" }
        }
        await execFileAsync("git", ["-C", worktreePath, "add", "-A"])
        await execFileAsync("git", ["-C", worktreePath, "commit", "-m", message])
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "提交失败" }
      }
    }
  )

  // Read a binary file (images, PDFs, etc.) and return as base64
  ipcMain.handle(
    "workspace:readBinaryFile",
    async (_event, { threadId, filePath }: WorkspaceFileParams) => {
      const { getThread } = await import("../db")

      // Get workspace path from thread metadata
      const thread = getThread(threadId)
      const metadata = thread?.metadata ? JSON.parse(thread.metadata) : {}
      const workspacePath = metadata.workspacePath as string | null

      if (!workspacePath) {
        return {
          success: false,
          error: "No workspace folder linked"
        }
      }

      try {
        // Convert virtual path to full disk path
        const relativePath = filePath.startsWith("/") ? filePath.slice(1) : filePath
        const fullPath = path.join(workspacePath, relativePath)

        // Security check: ensure the resolved path is within the workspace
        const resolvedPath = path.resolve(fullPath)
        const resolvedWorkspace = path.resolve(workspacePath)
        if (!resolvedPath.startsWith(resolvedWorkspace)) {
          return { success: false, error: "Access denied: path outside workspace" }
        }

        // Check if file exists
        const stat = await fs.stat(fullPath)
        if (stat.isDirectory()) {
          return { success: false, error: "Cannot read directory as file" }
        }

        // Read file as binary and convert to base64
        const buffer = await fs.readFile(fullPath)
        const base64 = buffer.toString("base64")

        return {
          success: true,
          content: base64,
          size: stat.size,
          modified_at: stat.mtime.toISOString()
        }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "Unknown error"
        }
      }
    }
  )
}

export function getDefaultModel(): string {
  const stored = store.get("defaultModel", "") as string
  return stored || resolveDefaultModelId()
}
