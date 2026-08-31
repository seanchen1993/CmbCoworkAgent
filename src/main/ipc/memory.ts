import { IpcMain } from "electron"
import { existsSync, readFileSync, unlinkSync } from "fs"
import { join, basename } from "path"
import { isDreamEnabled, isMemoryEnabled, setDreamEnabled, setMemoryEnabled } from "../storage"
import { getDefaultModelConfig } from "../models/registry"
import { getMemoryStore } from "../memory/store"
import { removeEntryFromManifest } from "../memory/manifest"
import { notifyMemoryChanged } from "../memory/events"
import { consolidateMemories, type ConsolidateResult } from "../memory/consolidate"
import { ChatOpenAI } from "@langchain/openai"
import {
  GLOBAL_MEMORY_DIR,
  PROJECTS_MEMORY_DIR,
  findCanonicalGitRootAsync,
  resolveProjectIdAsync,
  resolveScopedMemoryDir,
  type MemoryNamespace,
  type MemoryScope
} from "../memory/paths"
import { isProjectModeMemoryEnabled } from "../project-mode-memory"
import {
  cancelMemoryCatalogScope,
  readMemoryFileInWorker,
  readMemoryFilesPageInWorker,
  readMemoryProjectsPageInWorker
} from "../memory-catalog/client"
import { memoryCatalogRequestCoordinator } from "../memory-catalog/request-coordinator"
import type {
  MemoryCatalogProject,
  MemoryCatalogStats,
  MemoryFileContent,
  MemoryFilesPage,
  MemoryFilesPageRequest,
  MemoryProjectsPage,
  MemoryProjectsPageRequest
} from "../../shared/memory-catalog"

export interface MemoryScopeRequest {
  scope?: MemoryScope
  workspacePath?: string | null
  projectId?: string | null
}

export type MemoryStats = MemoryCatalogStats
export type MemoryProjectInfo = MemoryCatalogProject

function resolveRequestedNamespace(request?: MemoryScopeRequest): MemoryNamespace | null {
  const namespace = resolveScopedMemoryDir(request)
  if (request?.scope === "project" && namespace.scope !== "project") return null
  return namespace
}

function emptyProjectStats(): MemoryStats {
  return {
    fileCount: 0,
    totalSize: 0,
    indexSize: 0,
    enabled: false,
    dreamEnabled: false,
    dreamState: { lastRunAt: 0, sessionsSinceLastRun: 0 },
    scope: "project",
    memoryDir: ""
  }
}

function requestScope(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 128)
    : "customize-memory"
}

function requestCursor(value: unknown): string | undefined {
  return typeof value === "string" && value ? value.slice(0, 512) : undefined
}

function requestLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined
}

function workspacePath(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.slice(0, 32_768) : null
}

function validProjectId(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{12}$/.test(value) ? value : null
}

async function resolveCatalogNamespace(
  request: MemoryScopeRequest | undefined,
  signal: AbortSignal
): Promise<MemoryNamespace | null> {
  if (request?.scope !== "project") return { scope: "global", dir: GLOBAL_MEMORY_DIR }
  const projectId = validProjectId(request.projectId)
  if (projectId) {
    const requestedWorkspace = workspacePath(request.workspacePath)
    const currentGitRoot = await findCanonicalGitRootAsync(requestedWorkspace, signal)
    const currentProjectId = currentGitRoot ? await resolveProjectIdAsync(currentGitRoot) : null
    if (signal.aborted) throw new Error("Memory catalog request was cancelled")
    return {
      scope: "project",
      dir: join(PROJECTS_MEMORY_DIR, projectId),
      projectId,
      ...(currentGitRoot && currentProjectId === projectId ? { gitRoot: currentGitRoot } : {})
    }
  }
  const gitRoot = await findCanonicalGitRootAsync(workspacePath(request.workspacePath), signal)
  if (!gitRoot) return null
  const resolvedProjectId = await resolveProjectIdAsync(gitRoot)
  if (signal.aborted) throw new Error("Memory catalog request was cancelled")
  return {
    scope: "project",
    dir: join(PROJECTS_MEMORY_DIR, resolvedProjectId),
    projectId: resolvedProjectId,
    gitRoot
  }
}

async function withWorkerCancellation<T>(
  signal: AbortSignal,
  workerScope: string,
  operation: () => Promise<T>
): Promise<T> {
  const cancel = (): void => cancelMemoryCatalogScope(workerScope)
  if (signal.aborted) {
    cancel()
    throw new Error("Memory catalog request was cancelled")
  }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    return await operation()
  } finally {
    signal.removeEventListener("abort", cancel)
  }
}

export function registerMemoryHandlers(ipcMain: IpcMain): void {
  console.log("[Memory] Registering memory handlers...")

  ipcMain.handle(
    "memory:listProjects",
    async (event, rawRequest?: MemoryProjectsPageRequest): Promise<MemoryProjectsPage> => {
      const scope = requestScope(rawRequest?.requestScope)
      const coordinatorScope = `${scope}:projects`
      const workerScope = `${event.sender.id}:${coordinatorScope}`
      return memoryCatalogRequestCoordinator.run(event.sender, coordinatorScope, async (signal) => {
        const requestedWorkspace = workspacePath(rawRequest?.workspacePath)
        const gitRoot = await findCanonicalGitRootAsync(requestedWorkspace, signal)
        const projectId = gitRoot ? await resolveProjectIdAsync(gitRoot) : null
        if (signal.aborted) throw new Error("Memory project request was cancelled")
        return withWorkerCancellation(signal, workerScope, () =>
          readMemoryProjectsPageInWorker(
            {
              kind: "projects",
              ...(requestCursor(rawRequest?.cursor) ? { cursor: requestCursor(rawRequest?.cursor) } : {}),
              ...(requestLimit(rawRequest?.limit) !== undefined
                ? { limit: requestLimit(rawRequest?.limit) }
                : {}),
              ...(gitRoot && projectId
                ? {
                    currentProject: {
                      projectId,
                      gitRoot,
                      memoryDir: join(PROJECTS_MEMORY_DIR, projectId)
                    }
                  }
                : {})
            },
            workerScope
          )
        )
      })
    }
  )

  ipcMain.handle(
    "memory:listFiles",
    async (event, rawRequest?: MemoryFilesPageRequest): Promise<MemoryFilesPage> => {
      const scope = requestScope(rawRequest?.requestScope)
      const coordinatorScope = `${scope}:files`
      const workerScope = `${event.sender.id}:${coordinatorScope}`
      return memoryCatalogRequestCoordinator.run(event.sender, coordinatorScope, async (signal) => {
        const namespace = await resolveCatalogNamespace(rawRequest, signal)
        if (!namespace) {
          return {
            items: [],
            hasMore: false,
            totalCount: 0,
            truncated: false,
            truncatedReasons: [],
            scanStats: { scannedEntries: 0, scannedFiles: 0, readBytes: 0 },
            stats: emptyProjectStats()
          }
        }
        return withWorkerCancellation(signal, workerScope, () =>
          readMemoryFilesPageInWorker(
            {
              kind: "files",
              scope: namespace.scope,
              memoryDir: namespace.dir,
              ...(namespace.projectId ? { projectId: namespace.projectId } : {}),
              ...(namespace.gitRoot ? { gitRoot: namespace.gitRoot } : {}),
              ...(requestCursor(rawRequest?.cursor) ? { cursor: requestCursor(rawRequest?.cursor) } : {}),
              ...(requestLimit(rawRequest?.limit) !== undefined
                ? { limit: requestLimit(rawRequest?.limit) }
                : {})
            },
            workerScope
          )
        )
      })
    }
  )

  ipcMain.handle(
    "memory:readFile",
    async (
      event,
      name: string,
      rawRequest?: MemoryFilesPageRequest
    ): Promise<MemoryFileContent> => {
      const scope = requestScope(rawRequest?.requestScope)
      const coordinatorScope = `${scope}:file`
      const workerScope = `${event.sender.id}:${coordinatorScope}`
      return memoryCatalogRequestCoordinator.run(event.sender, coordinatorScope, async (signal) => {
        const namespace = await resolveCatalogNamespace(rawRequest, signal)
        if (!namespace) {
          return { content: "", bytesRead: 0, totalBytes: 0, truncated: false }
        }
        return withWorkerCancellation(signal, workerScope, () =>
          readMemoryFileInWorker(
            { kind: "file", memoryDir: namespace.dir, name: String(name).slice(0, 4_096) },
            workerScope
          )
        )
      })
    }
  )

  ipcMain.handle("memory:cancelCatalog", (event, rawScope?: string): void => {
    const scope = requestScope(rawScope)
    memoryCatalogRequestCoordinator.cancel(event.sender.id, scope)
    for (const kind of ["projects", "files", "file", "stats"] as const) {
      cancelMemoryCatalogScope(`${event.sender.id}:${scope}:${kind}`)
    }
  })

  ipcMain.handle(
    "memory:deleteFile",
    async (_, name: string, request?: MemoryScopeRequest): Promise<void> => {
      const namespace = resolveRequestedNamespace(request)
      if (!namespace) return
      const memoryDir = namespace.dir
      const safeName = basename(name)
      if (safeName === "MEMORY.md" || !safeName.endsWith(".md")) return
      const fullPath = join(memoryDir, safeName)
      if (!existsSync(fullPath)) return
      unlinkSync(fullPath)
      try {
        const store = await getMemoryStore(memoryDir)
        store.removeDocument(fullPath)
      } catch (e) {
        console.warn("[Memory] Failed to remove document from index:", e)
      }
      // Surgically remove this entry's line from MEMORY.md so we don't
      // clobber any other content the summarizer LLM has curated there.
      try {
        const removed = removeEntryFromManifest(memoryDir, safeName)
        if (removed) {
          const memoryMd = join(memoryDir, "MEMORY.md")
          if (existsSync(memoryMd)) {
            const store = await getMemoryStore(memoryDir)
            store.addDocument(memoryMd, readFileSync(memoryMd, "utf-8"))
          }
        }
      } catch (e) {
        console.warn("[Memory] Failed to update manifest after delete:", e)
      }
      notifyMemoryChanged()
    }
  )

  ipcMain.handle("memory:getEnabled", async (): Promise<boolean> => {
    return isMemoryEnabled()
  })

  ipcMain.handle("memory:getProjectModeEnabled", async (): Promise<boolean> => {
    return isProjectModeMemoryEnabled()
  })

  ipcMain.handle("memory:setEnabled", async (_, enabled: boolean): Promise<void> => {
    setMemoryEnabled(enabled)
    notifyMemoryChanged()
  })

  ipcMain.handle("memory:getDreamEnabled", async (): Promise<boolean> => {
    return isDreamEnabled()
  })

  ipcMain.handle("memory:setDreamEnabled", async (_, enabled: boolean): Promise<void> => {
    setDreamEnabled(enabled)
    notifyMemoryChanged()
  })

  /**
   * Manual Dream trigger — consolidates memories immediately, returns a result summary.
   * The frontend can call this from a "Consolidate memories" button in MemoryPanel.
   */
  ipcMain.handle(
    "memory:consolidate",
    async (_event, request?: MemoryScopeRequest): Promise<ConsolidateResult> => {
      const namespace = resolveRequestedNamespace(request)
      if (!namespace) return { archived: 0, merged: 0, created: 0, skipped: 0 }
      const memoryDir = namespace.dir
      if (!isMemoryEnabled() || !isDreamEnabled()) {
        return { archived: 0, merged: 0, created: 0, skipped: 0 }
      }
      const config = getDefaultModelConfig()
      if (!config?.apiKey) {
        return { archived: 0, merged: 0, created: 0, skipped: 0 }
      }
      return consolidateMemories({
        model: new ChatOpenAI({
          model: config.model,
          apiKey: config.apiKey,
          configuration: { baseURL: config.baseUrl }
        }),
        memoryDir
      })
    }
  )

  ipcMain.handle(
    "memory:getStats",
    async (event, rawRequest?: MemoryFilesPageRequest): Promise<MemoryStats> => {
      const scope = requestScope(rawRequest?.requestScope)
      const coordinatorScope = `${scope}:stats`
      const workerScope = `${event.sender.id}:${coordinatorScope}`
      return memoryCatalogRequestCoordinator.run(event.sender, coordinatorScope, async (signal) => {
        const namespace = await resolveCatalogNamespace(rawRequest, signal)
        if (!namespace) return emptyProjectStats()
        const page = await withWorkerCancellation(signal, workerScope, () =>
          readMemoryFilesPageInWorker(
            {
              kind: "files",
              scope: namespace.scope,
              memoryDir: namespace.dir,
              ...(namespace.projectId ? { projectId: namespace.projectId } : {}),
              ...(namespace.gitRoot ? { gitRoot: namespace.gitRoot } : {}),
              limit: 1
            },
            workerScope
          )
        )
        return page.stats
      })
    }
  )
}
