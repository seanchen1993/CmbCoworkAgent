import chokidar, { type FSWatcher } from "chokidar"
import { extname } from "path"
import { IGNORED_DIRS, SUPPORTED_EXTENSIONS, WATCHER_DEBOUNCE_MS } from "./constants"

export type FileChangeCallback = (changedPaths: string[]) => void

const MAX_DEBOUNCE_WAIT_MS = 5000

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
      const ignoredPatterns = [...IGNORED_DIRS].map((d) => `**/${d}/**`)

      this.watcher = chokidar.watch(this.workspacePath, {
        ignored: [/(^|[\/\\])\../, ...ignoredPatterns], // dotfiles + ignored dirs
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
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
        .on("error", (err) => console.error("[CodeIndexWatcher] error:", err))
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
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null }
    if (this.maxWaitTimer) { clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null }
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }
    this.pendingChanges.clear()
  }
}
