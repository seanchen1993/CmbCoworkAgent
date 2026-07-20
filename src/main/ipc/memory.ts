import { IpcMain } from "electron"
import { existsSync, readdirSync, readFileSync, unlinkSync, statSync } from "fs"
import { join, basename } from "path"
import { isDreamEnabled, isMemoryEnabled, setDreamEnabled, setMemoryEnabled } from "../storage"
import { getDefaultModelConfig } from "../models/registry"
import { getMemoryStore } from "../memory/store"
import { removeEntryFromManifest, parseFrontmatter, type MemoryType } from "../memory/manifest"
import { notifyMemoryChanged } from "../memory/events"
import { consolidateMemories, type ConsolidateResult } from "../memory/consolidate"
import { ChatOpenAI } from "@langchain/openai"
import {
  getProjectMemoryDir,
  listProjectMemoryDirs,
  resolveScopedMemoryDir,
  type MemoryNamespace,
  type MemoryScope
} from "../memory/paths"
import { isProjectModeMemoryEnabled } from "../project-mode-memory"

const DREAM_STATE_FILE = ".dream_state.json"

function readDreamStateInfo(memoryDir: string): DreamStateInfo {
  try {
    const p = join(memoryDir, DREAM_STATE_FILE)
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<DreamStateInfo>
      return {
        lastRunAt: raw.lastRunAt ?? 0,
        sessionsSinceLastRun: raw.sessionsSinceLastRun ?? 0
      }
    }
  } catch {
    /* ignore */
  }
  return { lastRunAt: 0, sessionsSinceLastRun: 0 }
}

const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"])

export interface MemoryScopeRequest {
  scope?: MemoryScope
  workspacePath?: string | null
  projectId?: string | null
}

export interface MemoryFileInfo {
  name: string
  size: number
  modifiedAt: string
  /** Memory category from frontmatter, or null for legacy/index files. */
  type: MemoryType | null
  /** Human-readable name from frontmatter. Falls back to filename in the UI. */
  displayName: string | null
  /** One-line description from frontmatter. */
  description: string | null
  /** How many times this file's chunks were retrieved via memory_search. */
  recallCount: number
}

export interface DreamStateInfo {
  lastRunAt: number
  sessionsSinceLastRun: number
}

export interface MemoryStats {
  fileCount: number
  totalSize: number
  indexSize: number
  enabled: boolean
  dreamEnabled: boolean
  dreamState: DreamStateInfo
  scope: MemoryScope
  memoryDir: string
  projectId?: string
  gitRoot?: string
}

export interface MemoryProjectInfo {
  projectId: string
  displayName: string
  memoryDir: string
  gitRoot?: string
  fileCount: number
  totalSize: number
  indexSize: number
  isCurrent: boolean
}

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
    enabled: isMemoryEnabled(),
    dreamEnabled: isDreamEnabled(),
    dreamState: { lastRunAt: 0, sessionsSinceLastRun: 0 },
    scope: "project",
    memoryDir: ""
  }
}

function basenameFromPath(value?: string): string {
  if (!value) return ""
  return basename(value.replace(/[\\/]+$/, "")) || value
}

function collectMemoryDirStats(
  memoryDir: string
): Pick<MemoryStats, "fileCount" | "totalSize" | "indexSize"> {
  let fileCount = 0
  let totalSize = 0
  let indexSize = 0
  if (existsSync(memoryDir)) {
    const files = readdirSync(memoryDir)
    for (const f of files) {
      const st = statSync(join(memoryDir, f))
      if (f.endsWith(".md")) {
        fileCount++
        totalSize += st.size
      } else if (f === "index.sqlite") {
        indexSize = st.size
      }
    }
  }
  return { fileCount, totalSize, indexSize }
}

export function registerMemoryHandlers(ipcMain: IpcMain): void {
  console.log("[Memory] Registering memory handlers...")

  ipcMain.handle(
    "memory:listProjects",
    async (
      _event,
      request?: Pick<MemoryScopeRequest, "workspacePath">
    ): Promise<MemoryProjectInfo[]> => {
      const projects = listProjectMemoryDirs(request?.workspacePath)
      const currentProjectId = getProjectMemoryDir(request?.workspacePath)?.projectId ?? null
      return projects
        .map((project) => {
          const stats = collectMemoryDirStats(project.dir)
          return {
            projectId: project.projectId ?? "",
            displayName:
              basenameFromPath(project.gitRoot) || project.projectId || "Unknown project",
            memoryDir: project.dir,
            gitRoot: project.gitRoot,
            ...stats,
            isCurrent: Boolean(project.projectId && project.projectId === currentProjectId)
          }
        })
        .filter((project) => project.projectId)
        .sort((a, b) => {
          if (a.isCurrent && !b.isCurrent) return -1
          if (!a.isCurrent && b.isCurrent) return 1
          return a.displayName.localeCompare(b.displayName)
        })
    }
  )

  ipcMain.handle(
    "memory:listFiles",
    async (_event, request?: MemoryScopeRequest): Promise<MemoryFileInfo[]> => {
      const namespace = resolveRequestedNamespace(request)
      if (!namespace) return []
      const memoryDir = namespace.dir
      if (!existsSync(memoryDir)) return []

      // Load recall stats once so we can annotate each file without extra I/O.
      let recallMap: Map<string, { totalRecalls: number }> = new Map()
      try {
        const store = await getMemoryStore(memoryDir)
        recallMap = store.getRecallStats()
      } catch {
        /* non-critical */
      }

      const files: MemoryFileInfo[] = readdirSync(memoryDir)
        .filter((f) => f.endsWith(".md"))
        .map((name) => {
          const fullPath = join(memoryDir, name)
          const st = statSync(fullPath)
          let type: MemoryType | null = null
          let displayName: string | null = null
          let description: string | null = null
          // Read just the first ~2KB to extract frontmatter from per-fact files.
          // MEMORY.md and legacy daily files have no frontmatter — fields stay null.
          try {
            const head = readFileSync(fullPath, "utf-8").slice(0, 2048)
            const { frontmatter } = parseFrontmatter(head)
            const candidate = frontmatter.type as MemoryType | undefined
            if (candidate && VALID_TYPES.has(candidate)) type = candidate
            if (frontmatter.name) displayName = frontmatter.name
            if (frontmatter.description) description = frontmatter.description
          } catch {
            /* unreadable file — leave fields null */
          }
          const recallCount = recallMap.get(fullPath)?.totalRecalls ?? 0
          return {
            name,
            size: st.size,
            modifiedAt: st.mtime.toISOString(),
            type,
            displayName,
            description,
            recallCount
          }
        })
      // MEMORY.md first, then per-fact files by mtime desc, then legacy daily files by name desc.
      files.sort((a, b) => {
        if (a.name === "MEMORY.md") return -1
        if (b.name === "MEMORY.md") return 1
        const aIsFact = a.type !== null
        const bIsFact = b.type !== null
        if (aIsFact && !bIsFact) return -1
        if (!aIsFact && bIsFact) return 1
        if (aIsFact && bIsFact) {
          return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
        }
        return b.name.localeCompare(a.name)
      })
      return files
    }
  )

  ipcMain.handle(
    "memory:readFile",
    async (_, name: string, request?: MemoryScopeRequest): Promise<string> => {
      const namespace = resolveRequestedNamespace(request)
      if (!namespace) return ""
      const memoryDir = namespace.dir
      const safeName = basename(name)
      if (!safeName.endsWith(".md")) return ""
      const fullPath = join(memoryDir, safeName)
      if (!existsSync(fullPath)) return ""
      return readFileSync(fullPath, "utf-8")
    }
  )

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
    async (_event, request?: MemoryScopeRequest): Promise<MemoryStats> => {
      const namespace = resolveRequestedNamespace(request)
      if (!namespace) return emptyProjectStats()
      const memoryDir = namespace.dir
      const { fileCount, totalSize, indexSize } = collectMemoryDirStats(memoryDir)
      return {
        fileCount,
        totalSize,
        indexSize,
        enabled: isMemoryEnabled(),
        dreamEnabled: isDreamEnabled(),
        dreamState: readDreamStateInfo(memoryDir),
        scope: namespace.scope,
        memoryDir,
        projectId: namespace.projectId,
        gitRoot: namespace.gitRoot
      }
    }
  )
}
