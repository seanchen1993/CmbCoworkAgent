import { readdir, stat, readFile } from "fs/promises"
import { readFileSync } from "fs"
import { join, relative, extname } from "path"
import { createHash } from "crypto"
import ignore, { type Ignore } from "ignore"
import { IGNORED_DIRS, MAX_FILE_SIZE_BYTES, MAX_FILES_TO_SCAN, SUPPORTED_EXTENSIONS } from "./constants"

export interface ScanResult {
  filePath: string
  relativePath: string
  content: string
  fileHash: string
  mtimeMs: number
  size: number
}

export interface StoredFileEntry {
  hash: string
  mtimeMs: number
  size: number
}

export class DirectoryScanner {
  private ig: Ignore

  constructor(private workspacePath: string) {
    this.ig = ignore()
    // Load .gitignore if exists (sync is fine — only runs once at construction)
    try {
      const content = readFileSync(join(workspacePath, ".gitignore"), "utf-8")
      this.ig.add(content)
    } catch { /* no .gitignore */ }
    try {
      const content = readFileSync(join(workspacePath, ".indexignore"), "utf-8")
      this.ig.add(content)
    } catch { /* no .indexignore */ }
  }

  /**
   * Single-pass async scan: returns changed files and all current paths.
   */
  async scan(storedEntries: Map<string, StoredFileEntry>, signal?: AbortSignal): Promise<{ changed: ScanResult[]; allPaths: Set<string> }> {
    const changed: ScanResult[] = []
    const allPaths = new Set<string>()
    await this.walkDir(this.workspacePath, changed, allPaths, storedEntries, signal)
    return { changed, allPaths }
  }

  private async walkDir(
    dir: string,
    changed: ScanResult[],
    allPaths: Set<string>,
    storedEntries: Map<string, StoredFileEntry>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return
    if (allPaths.size >= MAX_FILES_TO_SCAN) {
      if (allPaths.size === MAX_FILES_TO_SCAN) {
        console.warn(`[CodeIndex] Reached MAX_FILES_TO_SCAN (${MAX_FILES_TO_SCAN}), some files may not be indexed`)
      }
      return
    }

    let entries: import("fs").Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (signal?.aborted) return
      if (allPaths.size >= MAX_FILES_TO_SCAN) return
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue
      if (entry.isSymbolicLink()) continue // skip symlinks to avoid infinite recursion

      const fullPath = join(dir, entry.name)
      const relPath = relative(this.workspacePath, fullPath)

      if (this.ig.ignores(relPath)) continue

      if (entry.isDirectory()) {
        await this.walkDir(fullPath, changed, allPaths, storedEntries, signal)
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue

        let fileStat
        try {
          fileStat = await stat(fullPath)
        } catch { continue }
        if (fileStat.size > MAX_FILE_SIZE_BYTES) continue

        allPaths.add(fullPath)

        try {
          // Quick pre-check: skip files with unchanged mtime + size
          const stored = storedEntries.get(fullPath)
          if (stored && stored.mtimeMs === fileStat.mtimeMs && stored.size === fileStat.size) {
            continue
          }

          const content = await readFile(fullPath, "utf-8")
          const fileHash = createHash("sha256").update(content).digest("hex").slice(0, 16)

          // Double-check with content hash (mtime can change without content change)
          if (stored && stored.hash === fileHash) continue

          changed.push({ filePath: fullPath, relativePath: relPath, content, fileHash, mtimeMs: fileStat.mtimeMs, size: fileStat.size })
        } catch { /* skip unreadable */ }
      }
    }
  }
}
