import { constants } from "node:fs"
import { open, realpath, stat, type FileHandle } from "node:fs/promises"
import path from "node:path"

export interface StableFileHandle {
  handle: FileHandle
  filePath: string
  size: number
  modified_at: string
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * Open a file once and keep that exact OS handle for all subsequent reads.
 *
 * The realpath and file-identity checks on both sides of `open` prevent a path
 * from being swapped to a symlink/junction between capability validation and
 * I/O. Once this returns, callers must read from `handle`, never from
 * `filePath`, and must close the handle when the capability is released.
 */
export async function openStableFileHandle(
  trustedRootPath: string,
  candidatePath: string
): Promise<StableFileHandle> {
  const [realRoot, initialRealCandidate] = await Promise.all([
    realpath(path.resolve(trustedRootPath)),
    realpath(path.resolve(candidatePath))
  ])
  if (!isPathInside(realRoot, initialRealCandidate)) {
    throw new Error("Access denied: file is outside the trusted root")
  }

  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)
  const handle = await open(initialRealCandidate, constants.O_RDONLY | noFollow)
  try {
    const handleStat = await handle.stat({ bigint: true })
    if (!handleStat.isFile()) throw new Error("Cannot preview a directory")

    const currentRealCandidate = await realpath(initialRealCandidate)
    if (!isPathInside(realRoot, currentRealCandidate)) {
      throw new Error("Access denied: file moved outside the trusted root")
    }
    const currentPathStat = await stat(currentRealCandidate, { bigint: true })
    if (
      !currentPathStat.isFile() ||
      currentPathStat.dev !== handleStat.dev ||
      currentPathStat.ino !== handleStat.ino
    ) {
      throw new Error("File changed while the preview capability was being opened")
    }

    const size = Number(handleStat.size)
    const modifiedMs = Number(handleStat.mtimeMs)
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(modifiedMs)) {
      throw new Error("File metadata exceeds the supported preview range")
    }
    return {
      handle,
      filePath: currentRealCandidate,
      size,
      modified_at: new Date(modifiedMs).toISOString()
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}
