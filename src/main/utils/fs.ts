import { mkdir, readdir, copyFile, stat, chmod, lstat } from "fs/promises"
import { join } from "path"

/**
 * Recursively copy a directory tree from src to dest.
 * Preserves executable permission bits (no-op on Windows but harmless).
 * Skips symbolic links to prevent symlink-based path traversal attacks.
 */
export async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)

    // Skip symbolic links to prevent path traversal attacks
    const linkStat = await lstat(srcPath)
    if (linkStat.isSymbolicLink()) {
      console.warn(`[copyDirRecursive] Skipping symlink: ${srcPath}`)
      continue
    }

    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath)
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath)
      try {
        const srcStat = await stat(srcPath)
        await chmod(destPath, srcStat.mode)
      } catch {
        /* ignore permission errors on restricted filesystems */
      }
    }
  }
}

/**
 * Simple async mutex for serializing read-modify-write operations on a file.
 * Usage:
 *   const lock = createAsyncMutex()
 *   await lock.acquire()
 *   try { ... } finally { lock.release() }
 */
export function createAsyncMutex(): { acquire: () => Promise<void>; release: () => void } {
  const _queue: Array<() => void> = []
  let _locked = false

  return {
    acquire(): Promise<void> {
      if (!_locked) {
        _locked = true
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        _queue.push(resolve)
      })
    },
    release(): void {
      if (_queue.length > 0) {
        const next = _queue.shift()!
        next()
      } else {
        _locked = false
      }
    }
  }
}
