import { IpcMain, BrowserWindow } from "electron"
import { existsSync, readdirSync, readFileSync, unlinkSync, statSync } from "fs"
import { join, basename } from "path"
import { homedir } from "os"
import { isMemoryEnabled, setMemoryEnabled } from "../storage"
import { getMemoryStore } from "../memory/store"
import { removeEntryFromManifest, parseFrontmatter, type MemoryType } from "../memory/manifest"

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
}

export interface MemoryStats {
  fileCount: number
  totalSize: number
  indexSize: number
  enabled: boolean
}

function notifyChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("memory:changed")
  }
}

export function registerMemoryHandlers(ipcMain: IpcMain): void {
  console.log("[Memory] Registering memory handlers...")

  ipcMain.handle("memory:listFiles", async (): Promise<MemoryFileInfo[]> => {
    if (!existsSync(MEMORY_DIR)) return []
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
        return {
          name,
          size: st.size,
          modifiedAt: st.mtime.toISOString(),
          type,
          displayName,
          description
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
    notifyChanged()
  })

  ipcMain.handle("memory:getEnabled", async (): Promise<boolean> => {
    return isMemoryEnabled()
  })

  ipcMain.handle("memory:setEnabled", async (_, enabled: boolean): Promise<void> => {
    setMemoryEnabled(enabled)
    notifyChanged()
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
    return { fileCount, totalSize, indexSize, enabled: isMemoryEnabled() }
  })
}
