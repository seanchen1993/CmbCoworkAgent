import { join, relative, extname } from "path"
import { readFileSync, readdirSync, unlinkSync, existsSync, statSync } from "fs"
import { stat, readFile } from "fs/promises"
import { createHash } from "crypto"
import { app } from "electron"
import { BrowserWindow } from "electron"
import ignore, { type Ignore } from "ignore"
import { CodeIndexStore, CODE_INDEX_DIR } from "./store"
import { CodeParser } from "./parser"
import { createEmbedder, type EmbeddingProvider } from "./embedder"
import { DirectoryScanner } from "./scanner"
import { CodeIndexWatcher } from "./watcher"
import { hybridSearch } from "./search"
import type { CodeSearchResult, IndexingStatus, IndexingState, CodeIndexSettings } from "./types"
import { EMBEDDING_BATCH_SIZE, MAX_FILE_SIZE_BYTES, SUPPORTED_EXTENSIONS } from "./constants"

export class CodeIndexManager {
  private store: CodeIndexStore
  private parser: CodeParser
  private embedder: EmbeddingProvider | null = null
  private scanner: DirectoryScanner
  private watcher: CodeIndexWatcher | null = null
  private abortController: AbortController | null = null
  private indexingPromise: Promise<void> | null = null
  private incrementalPromise: Promise<void> | null = null
  private pendingIncrementalPaths: Set<string> = new Set()
  private ig: Ignore
  private status: IndexingStatus

  constructor(
    private workspacePath: string,
    wasmDir: string,
  ) {
    this.store = new CodeIndexStore(workspacePath)
    this.parser = new CodeParser(wasmDir)
    this.scanner = new DirectoryScanner(workspacePath)
    // Load .gitignore + .indexignore for watcher filtering (consistent with scanner)
    this.ig = ignore()
    for (const name of [".gitignore", ".indexignore"]) {
      try {
        this.ig.add(readFileSync(join(workspacePath, name), "utf-8"))
      } catch { /* file not found */ }
    }
    this.status = {
      state: "idle",
      message: "",
      totalFiles: 0,
      processedFiles: 0,
      totalChunks: 0,
      embeddedChunks: 0,
      workspacePath,
    }
  }

  async init(settings: CodeIndexSettings): Promise<void> {
    await this.store.init()

    if (!settings.enabled) return

    this.embedder = createEmbedder(settings)

    // Check if embedding config changed → need to clear embeddings
    const storedModel = this.store.getMeta("embedding_model")
    const storedDims = this.store.getMeta("embedding_dimensions")
    const storedBaseUrl = this.store.getMeta("embedding_base_url")
    const configChanged = storedModel !== null && storedDims !== null && (
      storedModel !== settings.embeddingModel ||
      storedDims !== String(settings.embeddingDimensions) ||
      (storedBaseUrl ?? "") !== settings.embeddingBaseUrl
    )
    if (configChanged) {
      console.log("[CodeIndex] Embedding config changed, stopping current indexing and clearing index")
      // Stop any in-progress indexing before clearing
      this.abortController?.abort()
      if (this.watcher) { await this.watcher.stop(); this.watcher = null }
      // Clear pending paths so drainIncrementalQueue won't start new work
      this.pendingIncrementalPaths.clear()
      if (this.indexingPromise) {
        await this.indexingPromise.catch(() => {})
      }
      if (this.incrementalPromise) {
        await this.incrementalPromise.catch(() => {})
      }
      this.store.clearAll()
      this.setStatus("idle", "Config changed, awaiting re-index")
      // Restart watcher since we stopped it above
      this.startWatching()
    }

    this.store.setMeta("embedding_model", settings.embeddingModel)
    this.store.setMeta("embedding_dimensions", String(settings.embeddingDimensions))
    this.store.setMeta("embedding_base_url", settings.embeddingBaseUrl)
    this.store.setMeta("workspace_path", this.workspacePath)
  }

  /**
   * Full scan: parse all files, generate embeddings, store.
   * Runs in background — safe to await or fire-and-forget.
   */
  async fullIndex(): Promise<void> {
    // If already running, just wait for it to finish (no duplicate runs)
    if (this.indexingPromise) {
      return this.indexingPromise
    }
    // Immediately claim the slot to prevent concurrent entry
    this.indexingPromise = (async () => {
      if (this.incrementalPromise) {
        await this.incrementalPromise.catch(() => {})
      }
      await this.doFullIndex()
    })()
    try {
      await this.indexingPromise
    } finally {
      this.indexingPromise = null
    }
  }

  private async doFullIndex(): Promise<void> {
    if (!this.embedder) {
      this.setStatus("error", "Embedding provider not configured")
      return
    }

    this.abortController = new AbortController()
    const signal = this.abortController.signal
    this.store.setBatchMode(true)

    try {
      this.setStatus("scanning", "Scanning workspace...")
      this.notifyRenderer()

      const storedEntries = this.store.getAllFileEntries()
      const { changed: changedFiles, allPaths: currentPaths } = await this.scanner.scan(storedEntries, signal)

      if (signal.aborted) {
        this.setStatus("idle", "Indexing cancelled")
        return
      }

      this.setStatus("scanning", `Found ${changedFiles.length} files to index`)
      this.notifyRenderer()

      // Remove stale chunks for files no longer in scan results (deleted or gitignored)
      const indexedPaths = this.store.getAllIndexedPaths()
      for (const p of indexedPaths) {
        if (!currentPaths.has(p)) {
          this.store.removeFileChunks(p)
        }
      }

      if (changedFiles.length === 0) {
        this.status.totalChunks = this.store.getChunkCount()
        this.status.embeddedChunks = this.store.getEmbeddedChunkCount()
        this.setStatus("indexed", `Index up to date: ${this.status.totalChunks} chunks`)
        this.notifyRenderer()
        return
      }

      // Parse and embed files
      this.setStatus("indexing", `Indexing ${changedFiles.length} files...`)
      this.status.totalFiles = changedFiles.length
      this.status.processedFiles = 0
      this.notifyRenderer()

      for (const file of changedFiles) {
        if (signal.aborted) break

        try {
          // Parse file into blocks
          const blocks = await this.parser.parseFile(
            file.filePath,
            file.relativePath,
            file.content,
            file.fileHash,
          )

          if (blocks.length === 0) {
            this.store.updateFileHash(file.filePath, file.fileHash, file.mtimeMs, file.size)
            this.status.processedFiles++
            continue
          }

          // Batch embed (before touching DB so abort won't leave partial state)
          const embeddings: (Float32Array | null)[] = []
          for (let i = 0; i < blocks.length; i += EMBEDDING_BATCH_SIZE) {
            if (signal.aborted) break

            const batch = blocks.slice(i, i + EMBEDDING_BATCH_SIZE)
            const texts = batch.map((b) => {
              const prefix = b.identifier
                ? `${b.identifier} in ${file.relativePath}`
                : file.relativePath
              return `${prefix}\n${b.content}`
            })

            try {
              const batchEmbeddings = await this.embedder!.embedBatch(texts, signal)
              embeddings.push(...batchEmbeddings)
            } catch (e) {
              console.warn(`[CodeIndex] Embedding batch failed for ${file.relativePath}:`, e)
              embeddings.push(...batch.map(() => null))
            }
          }

          if (signal.aborted) break

          // If ALL embeddings failed, remove stale chunks but skip hash update so file gets retried next time
          const allFailed = embeddings.length > 0 && embeddings.every((e) => e === null)
          if (allFailed) {
            console.warn(`[CodeIndex] All embeddings failed for ${file.relativePath}, will retry next index`)
            this.store.runInTransaction(() => {
              this.store.removeFileChunks(file.filePath)
            })
            this.status.processedFiles++
            continue
          }

          // Atomic: remove old + insert new in a single transaction
          this.store.runInTransaction(() => {
            this.store.removeFileChunks(file.filePath)
            this.store.upsertChunks(blocks, embeddings)
            this.store.updateFileHash(file.filePath, file.fileHash, file.mtimeMs, file.size)
          })
        } catch (e) {
          console.warn(`[CodeIndex] Failed to index ${file.relativePath}:`, e)
        }

        this.status.processedFiles++
        if (this.status.processedFiles % 10 === 0 || this.status.processedFiles === changedFiles.length) {
          this.setStatus(
            "indexing",
            `Indexed ${this.status.processedFiles}/${changedFiles.length} files`,
          )
          this.notifyRenderer()
        }
      }

      this.store.forceSave()

      if (signal.aborted) {
        this.setStatus("idle", "Indexing cancelled")
      } else {
        this.status.totalChunks = this.store.getChunkCount()
        this.status.embeddedChunks = this.store.getEmbeddedChunkCount()
        this.setStatus(
          "indexed",
          `Index complete: ${this.status.totalChunks} chunks from ${this.status.processedFiles} files`,
        )
      }
      this.notifyRenderer()
    } catch (e) {
      console.error("[CodeIndex] fullIndex error:", e)
      this.setStatus("error", `Indexing failed: ${e instanceof Error ? e.message : String(e)}`)
      this.notifyRenderer()
    } finally {
      this.store.setBatchMode(false)
    }
  }

  /**
   * Start file watcher for incremental updates.
   */
  startWatching(): void {
    if (this.watcher) return
    this.watcher = new CodeIndexWatcher(this.workspacePath, (changedPaths) => {
      // Queue paths and ensure only one incrementalUpdate runs at a time
      for (const p of changedPaths) this.pendingIncrementalPaths.add(p)
      this.drainIncrementalQueue()
    })
    this.watcher.start().catch((e) => {
      console.warn("[CodeIndex] Watcher start failed:", e)
      // Clear watcher so startWatching() can be retried
      this.watcher = null
    })
    console.log("[CodeIndex] File watcher started for:", this.workspacePath)
  }

  private drainIncrementalQueue(): void {
    if (this.incrementalPromise) return // already running, will drain again when done
    if (this.pendingIncrementalPaths.size === 0) return

    const paths = [...this.pendingIncrementalPaths]
    this.pendingIncrementalPaths.clear()

    this.incrementalPromise = this.incrementalUpdate(paths)
      .catch((e) => console.warn("[CodeIndex] incremental update error:", e))
      .finally(() => {
        this.incrementalPromise = null
        // Drain again if new paths accumulated while we were processing
        this.drainIncrementalQueue()
      })
  }

  /**
   * Process changed files incrementally. Only one instance runs at a time.
   */
  private async incrementalUpdate(changedPaths: string[]): Promise<void> {
    if (!this.embedder) return
    // Wait for fullIndex to finish before processing incremental changes
    if (this.indexingPromise) {
      await this.indexingPromise.catch(() => {})
    }

    for (const filePath of changedPaths) {
      try {
        // Filter: check gitignore and supported extensions
        const relPath = relative(this.workspacePath, filePath)
        if (this.ig.ignores(relPath)) continue
        const ext = extname(filePath).toLowerCase()
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue

        let fileStat
        try {
          fileStat = await stat(filePath)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            this.store.removeFileChunks(filePath)
          }
          continue
        }
        if (!fileStat.isFile()) continue
        if (fileStat.size > MAX_FILE_SIZE_BYTES) continue

        const content = await readFile(filePath, "utf-8")
        const fileHash = createHash("sha256").update(content).digest("hex").slice(0, 16)

        // Check if actually changed
        const storedHash = this.store.getFileHash(filePath)
        if (storedHash === fileHash) continue

        const blocks = await this.parser.parseFile(filePath, relPath, content, fileHash)

        if (blocks.length > 0) {
          const embeddings: (Float32Array | null)[] = []
          for (let i = 0; i < blocks.length; i += EMBEDDING_BATCH_SIZE) {
            const batch = blocks.slice(i, i + EMBEDDING_BATCH_SIZE)
            const texts = batch.map((b) => {
              const prefix = b.identifier ? `${b.identifier} in ${relPath}` : relPath
              return `${prefix}\n${b.content}`
            })
            try {
              const batchEmbeddings = await this.embedder!.embedBatch(texts)
              embeddings.push(...batchEmbeddings)
            } catch {
              embeddings.push(...batch.map(() => null))
            }
          }
          // Atomic: remove old + insert new
          this.store.runInTransaction(() => {
            this.store.removeFileChunks(filePath)
            this.store.upsertChunks(blocks, embeddings)
            this.store.updateFileHash(filePath, fileHash, fileStat.mtimeMs, fileStat.size)
          })
        } else {
          this.store.runInTransaction(() => {
            this.store.removeFileChunks(filePath)
            this.store.updateFileHash(filePath, fileHash, fileStat.mtimeMs, fileStat.size)
          })
        }
      } catch (e) {
        console.warn(`[CodeIndex] incremental update failed for ${filePath}:`, e)
      }
    }

    // Update stats once after all files processed (not per-file)
    this.status.totalChunks = this.store.getChunkCount()
    this.status.embeddedChunks = this.store.getEmbeddedChunkCount()
    // Flush to disk after incremental update (crash safety)
    this.store.forceSave()
    // Notify renderer so UI updates without waiting for polling
    this.notifyRenderer()
  }

  /**
   * Search the index.
   */
  async search(query: string, limit?: number, settings?: CodeIndexSettings): Promise<CodeSearchResult[]> {
    return hybridSearch(
      this.store,
      this.embedder,
      query,
      limit,
      settings?.vectorWeight,
      settings?.ftsWeight,
    )
  }

  getStatus(): IndexingStatus {
    return { ...this.status }
  }

  stopIndexing(): void {
    this.abortController?.abort()
  }

  /** Clear all indexed data (for full rebuild) */
  clearIndex(): void {
    this.store.clearAll()
    this.setStatus("idle", "Index cleared, ready for rebuild")
  }

  /** Stop current indexing, wait for it to finish, clear data, then rebuild */
  async reindex(): Promise<void> {
    // Pause watcher to prevent new incremental updates during reindex
    if (this.watcher) { await this.watcher.stop(); this.watcher = null }
    this.abortController?.abort()
    this.pendingIncrementalPaths.clear()
    // Wait for all in-flight operations to complete before clearing
    if (this.indexingPromise) await this.indexingPromise.catch(() => {})
    if (this.incrementalPromise) await this.incrementalPromise.catch(() => {})
    this.store.clearAll()
    this.setStatus("idle", "Rebuilding index...")
    try {
      await this.fullIndex()
    } finally {
      this.startWatching()
    }
  }

  async close(): Promise<void> {
    this.abortController?.abort()
    this.pendingIncrementalPaths.clear()
    if (this.watcher) { await this.watcher.stop(); this.watcher = null }
    // Wait for in-flight async operations before closing the DB
    if (this.indexingPromise) await this.indexingPromise.catch(() => {})
    if (this.incrementalPromise) await this.incrementalPromise.catch(() => {})
    this.parser.dispose()
    await this.store.close()
  }

  private setStatus(state: IndexingState, message: string): void {
    this.status = { ...this.status, state, message }
  }

  private notifyRenderer(): void {
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("code-index:status", this.status)
      }
    } catch { /* ignore if no windows */ }
  }
}

// ── Singleton cache per workspace ──

const managers = new Map<string, CodeIndexManager>()

/** Get existing manager without creating one (safe for status queries) */
export function getExistingCodeIndexManager(workspacePath: string): CodeIndexManager | null {
  return managers.get(workspacePath.replace(/\/+$/, "")) ?? null
}

function getTreeSitterWasmDir(): string {
  try {
    if (app.isPackaged) {
      return join(process.resourcesPath, "tree-sitter-wasms")
    }
  } catch { /* app may not be ready */ }
  // Dev mode: resolve from node_modules
  return join(__dirname, "../../node_modules/tree-sitter-wasms/out")
}

const pendingCreations = new Map<string, Promise<CodeIndexManager | null>>()

export function getCodeIndexManager(
  workspacePath: string,
  settings: CodeIndexSettings,
): Promise<CodeIndexManager | null> {
  if (!settings.enabled) return Promise.resolve(null)

  // Normalize path to prevent duplicate managers for same directory
  workspacePath = workspacePath.replace(/\/+$/, "")

  // If there's already a creation in flight for this workspace, wait for it
  const pending = pendingCreations.get(workspacePath)
  if (pending) return pending

  const p = doGetOrCreateManager(workspacePath, settings)
    .finally(() => pendingCreations.delete(workspacePath))
  pendingCreations.set(workspacePath, p)
  return p
}

async function doGetOrCreateManager(
  workspacePath: string,
  settings: CodeIndexSettings,
): Promise<CodeIndexManager | null> {
  let manager = managers.get(workspacePath)
  if (manager) {
    await manager.init(settings)
    return manager
  }

  const wasmDir = getTreeSitterWasmDir()
  manager = new CodeIndexManager(workspacePath, wasmDir)
  await manager.init(settings)
  managers.set(workspacePath, manager)
  return manager
}

export function getAllCodeIndexStatuses(): IndexingStatus[] {
  const statuses: IndexingStatus[] = []
  for (const manager of managers.values()) {
    statuses.push(manager.getStatus())
  }
  return statuses
}

export async function closeCodeIndexManager(workspacePath: string): Promise<void> {
  const normalized = workspacePath.replace(/\/+$/, "")
  const manager = managers.get(normalized)
  if (manager) {
    await manager.close()
    managers.delete(normalized)
  }
}

export async function closeAllCodeIndexManagers(): Promise<void> {
  // Wait for any pending creations to finish first
  if (pendingCreations.size > 0) {
    await Promise.all([...pendingCreations.values()]).catch(() => {})
  }
  pendingCreations.clear()

  const closePromises: Promise<void>[] = []
  for (const manager of managers.values()) {
    closePromises.push(manager.close())
  }
  await Promise.all(closePromises)
  managers.clear()
}

/**
 * Start indexing for a single workspace (fire-and-forget).
 * Used by startup, settings change, and workspace switch.
 */
export function tryStartCodeIndex(workspacePath: string, settings: CodeIndexSettings): void {
  if (!settings.enabled || !settings.embeddingBaseUrl || !settings.embeddingModel) return
  getCodeIndexManager(workspacePath, settings)
    .then((manager) => {
      if (manager) {
        const state = manager.getStatus().state
        if (state === "idle" || state === "error") {
          manager.fullIndex().catch((e) => console.warn("[CodeIndex] background index error:", e))
        }
        manager.startWatching()
      }
    })
    .catch((e) => console.warn("[CodeIndex] init error:", e))
}

/**
 * Start indexing for the most recent workspaces from thread history.
 */
export async function startIndexingForRecentWorkspaces(settings: CodeIndexSettings, maxCount = 3): Promise<void> {
  if (!settings.enabled || !settings.embeddingBaseUrl || !settings.embeddingModel) return
  const { listThreads } = await import("../db")
  const threads = listThreads()
  const seen = new Set<string>()
  for (const t of threads) {
    if (seen.size >= maxCount) break
    if (!t.metadata) continue
    try {
      const meta = JSON.parse(t.metadata)
      if (meta.workspacePath && !seen.has(meta.workspacePath)) {
        seen.add(meta.workspacePath)
        tryStartCodeIndex(meta.workspacePath, settings)
      }
    } catch { /* skip invalid metadata */ }
  }
}

/**
 * List all index database files with their sizes.
 * Used by UI to show which indexes exist and allow cleanup.
 */
export function listIndexFiles(): Array<{ path: string; sizeMB: number }> {
  if (!existsSync(CODE_INDEX_DIR)) return []
  try {
    return readdirSync(CODE_INDEX_DIR)
      .filter((f) => f.endsWith(".sqlite"))
      .map((f) => {
        const fullPath = join(CODE_INDEX_DIR, f)
        const s = statSync(fullPath)
        return { path: fullPath, sizeMB: Math.round(s.size / 1024 / 1024 * 10) / 10 }
      })
  } catch { return [] }
}

/**
 * Remove index databases that are not actively managed.
 * Returns the number of cleaned files.
 */
export function cleanupUnusedIndexes(): number {
  if (!existsSync(CODE_INDEX_DIR)) return 0

  // Safety: don't cleanup if no managers are active (e.g. app just started)
  if (managers.size === 0 && pendingCreations.size === 0) return 0

  // Pre-compute active file names (including pending creations)
  const activeFiles = new Set<string>()
  for (const wp of [...managers.keys(), ...pendingCreations.keys()]) {
    const hash = createHash("sha256").update(wp).digest("hex").slice(0, 16)
    activeFiles.add(`${hash}.sqlite`)
  }

  const files = readdirSync(CODE_INDEX_DIR).filter((f) => f.endsWith(".sqlite"))
  let cleaned = 0

  for (const file of files) {
    if (activeFiles.has(file)) continue

    try {
      unlinkSync(join(CODE_INDEX_DIR, file))
      cleaned++
    } catch { /* skip */ }
  }
  return cleaned
}
