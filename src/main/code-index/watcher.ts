import chokidar, { type FSWatcher } from "chokidar"
import { readdirSync } from "fs"
import { extname, join } from "path"
import { IGNORED_DIRS, SUPPORTED_EXTENSIONS, WATCHER_DEBOUNCE_MS } from "./constants"

export type FileChangeCallback = (changedPaths: string[]) => void

const MAX_DEBOUNCE_WAIT_MS = 5000
const MAX_WATCH_DIRS = 3000

/** Quick count of directories, skipping ignored/dot dirs. Returns early if over limit. */
function countDirs(dir: string, limit: number, count = { n: 0 }): number {
  if (count.n >= limit) return count.n
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || IGNORED_DIRS.has(e.name)) continue
      if (e.isDirectory() && !e.isSymbolicLink()) {
        count.n++
        if (count.n >= limit) return count.n
        countDirs(join(dir, e.name), limit, count)
      }
    }
  } catch { /* permission error etc */ }
  return count.n
}

export class CodeIndexWatcher {
  private watcher: FSWatcher | null = null
  private pendingChanges = new Set<string>()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private workspacePath: string,
    private onChange: FileChangeCallback,
  ) {}

  async start(): Promise<void> {
    await this.stop()
    try {
      // Skip watcher for extremely large workspaces to avoid EMFILE
      const dirCount = countDirs(this.workspacePath, MAX_WATCH_DIRS)
      if (dirCount >= MAX_WATCH_DIRS) {
        console.warn(`[CodeIndexWatcher] Workspace too large (${dirCount}+ dirs), skipping file watcher`)
        return
      }

      const ignoredPatterns = [...IGNORED_DIRS].map((d) => `**/${d}`)

      this.watcher = chokidar.watch(this.workspacePath, {
        ignored: [/(^|[\/\\])\../, ...ignoredPatterns],
        persistent: true,
        ignoreInitial: true,
      })

      const handleChange = (filePath: string): void => {
        const ext = extname(filePath).toLowerCase()
        if (!SUPPORTED_EXTENSIONS.has(ext)) return

        this.pendingChanges.add(filePath)

        // Reset debounce timer on each change
        if (this.debounceTimer) clearTimeout(this.debounceTimer)
        this.debounceTimer = setTimeout(() => this.flush(), WATCHER_DEBOUNCE_MS)

        // Start max-wait timer on first change to ensure flush even during continuous changes
        if (!this.maxWaitTimer) {
          this.maxWaitTimer = setTimeout(() => this.flush(), MAX_DEBOUNCE_WAIT_MS)
        }
      }

      this.watcher
        .on("add", handleChange)
        .on("change", handleChange)
        .on("unlink", handleChange)
        .on("error", (err: unknown) => {
          console.warn("[CodeIndexWatcher] error:", err instanceof Error ? err.message : err)
        })
    } catch (e) {
      console.error("[CodeIndexWatcher] Failed to start:", e)
    }
  }

  private flush(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null }
    if (this.maxWaitTimer) { clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null }
    const paths = Array.from(this.pendingChanges)
    this.pendingChanges.clear()
    if (paths.length > 0) this.onChange(paths)
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer)
      this.maxWaitTimer = null
    }
    this.pendingChanges.clear()
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }
  }
}
