import { IpcMain } from "electron"
import { existsSync, readdirSync, readFileSync, unlinkSync, statSync } from "fs"
import { join, basename } from "path"
import { homedir } from "os"
import {
  isDreamEnabled,
  isMemoryEnabled,
  setDreamEnabled,
  setMemoryEnabled,
  getCustomModelConfigs
} from "../storage"
import { getMemoryStore } from "../memory/store"
import { removeEntryFromManifest, parseFrontmatter, type MemoryType } from "../memory/manifest"
import { notifyMemoryChanged } from "../memory/events"
import { consolidateMemories, type ConsolidateResult } from "../memory/consolidate"
import { ChatOpenAI } from "@langchain/openai"

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
  } catch { /* ignore */ }
  return { lastRunAt: 0, sessionsSinceLastRun: 0 }
}

const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"])

const MEMORY_DIR = join(homedir(), ".cmbcoworkagent", "memory")

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
}

export function registerMemoryHandlers(ipcMain: IpcMain): void {
  console.log("[Memory] Registering memory handlers...")

  ipcMain.handle("memory:listFiles", async (): Promise<MemoryFileInfo[]> => {
    if (!existsSync(MEMORY_DIR)) return []

    // Load recall stats once so we can annotate each file without extra I/O.
    let recallMap: Map<string, { totalRecalls: number }> = new Map()
    try {
      const store = await getMemoryStore()
      recallMap = store.getRecallStats()
    } catch { /* non-critical */ }

    const files: MemoryFileInfo[] = readdirSync(MEMORY_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((name) => {
        const fullPath = join(MEMORY_DIR, name)
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
  })

  ipcMain.handle("memory:readFile", async (_, name: string): Promise<string> => {
    const safeName = basename(name)
    if (!safeName.endsWith(".md")) return ""
    const fullPath = join(MEMORY_DIR, safeName)
    if (!existsSync(fullPath)) return ""
    return readFileSync(fullPath, "utf-8")
  })

  ipcMain.handle("memory:deleteFile", async (_, name: string): Promise<void> => {
    const safeName = basename(name)
    if (safeName === "MEMORY.md" || !safeName.endsWith(".md")) return
    const fullPath = join(MEMORY_DIR, safeName)
    if (!existsSync(fullPath)) return
    unlinkSync(fullPath)
    try {
      const store = await getMemoryStore()
      store.removeDocument(fullPath)
    } catch (e) {
      console.warn("[Memory] Failed to remove document from index:", e)
    }
    // Surgically remove this entry's line from MEMORY.md so we don't
    // clobber any other content the summarizer LLM has curated there.
    try {
      const removed = removeEntryFromManifest(MEMORY_DIR, safeName)
      if (removed) {
        const memoryMd = join(MEMORY_DIR, "MEMORY.md")
        if (existsSync(memoryMd)) {
          const store = await getMemoryStore()
          store.addDocument(memoryMd, readFileSync(memoryMd, "utf-8"))
        }
      }
    } catch (e) {
      console.warn("[Memory] Failed to update manifest after delete:", e)
    }
    notifyMemoryChanged()
  })

  ipcMain.handle("memory:getEnabled", async (): Promise<boolean> => {
    return isMemoryEnabled()
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
  ipcMain.handle("memory:consolidate", async (): Promise<ConsolidateResult> => {
    if (!isMemoryEnabled() || !isDreamEnabled()) {
      return { archived: 0, merged: 0, created: 0, skipped: 0 }
    }
    const allConfigs = getCustomModelConfigs()
    const config = allConfigs[0]
    if (!config?.apiKey) {
      return { archived: 0, merged: 0, created: 0, skipped: 0 }
    }
    return consolidateMemories({
      model: new ChatOpenAI({
        model: config.model,
        apiKey: config.apiKey,
        configuration: { baseURL: config.baseUrl }
      }),
      memoryDir: MEMORY_DIR
    })
  })

  ipcMain.handle("memory:getStats", async (): Promise<MemoryStats> => {
    let fileCount = 0
    let totalSize = 0
    let indexSize = 0
    if (existsSync(MEMORY_DIR)) {
      const files = readdirSync(MEMORY_DIR)
      for (const f of files) {
        const st = statSync(join(MEMORY_DIR, f))
        if (f.endsWith(".md")) {
          fileCount++
          totalSize += st.size
        } else if (f === "index.sqlite") {
          indexSize = st.size
        }
      }
    }
    return {
      fileCount,
      totalSize,
      indexSize,
      enabled: isMemoryEnabled(),
      dreamEnabled: isDreamEnabled(),
      dreamState: readDreamStateInfo(MEMORY_DIR)
    }
  })
}
