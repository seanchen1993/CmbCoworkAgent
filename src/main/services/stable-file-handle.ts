import { constants } from "node:fs"
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises"
import path from "node:path"

export interface StableFileHandle {
  handle: FileHandle
  rootPath: string
  filePath: string
  size: number
  modified_at: string
  identity: {
    device: bigint
    inode: bigint
    size: bigint
    modifiedNs: bigint
    changedNs: bigint
  }
  /** Revalidate that the original path still names this opened inode. */
  assertPathIdentity: () => Promise<void>
}

export interface StableWritableFileHandle extends StableFileHandle {
  /**
   * Revalidate that the authorized path still names this exact, single-link
   * inode. Call immediately before committing a mutation through `handle`.
   */
  assertPathIdentity: () => Promise<void>
}

export type StableBoundedReadFailure = "initial-too-large" | "grew-too-large" | "changed"

/** Structured failure from a bounded capability read so callers can preserve
 * their own domain-specific error/warning text without duplicating the I/O. */
export class StableBoundedReadError extends Error {
  constructor(
    readonly failure: StableBoundedReadFailure,
    readonly observedSize: number
  ) {
    super(
      failure === "initial-too-large"
        ? `File is too large (${observedSize} bytes)`
        : failure === "grew-too-large"
          ? `File grew beyond the read limit (${observedSize} bytes observed)`
          : "File changed while it was being read"
    )
    this.name = "StableBoundedReadError"
  }
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
  // Opening a FIFO for read can itself block before fstat gets a chance to
  // reject it. O_NONBLOCK makes the capability acquisition fail/return promptly;
  // it is harmless for the regular files this helper ultimately accepts.
  const nonBlocking = process.platform === "win32" ? 0 : (constants.O_NONBLOCK ?? 0)
  const handle = await open(initialRealCandidate, constants.O_RDONLY | noFollow | nonBlocking)
  const assertPathIdentity = async (): Promise<void> => {
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
      throw new Error("File changed while the preview capability was active")
    }
  }
  try {
    const handleStat = await handle.stat({ bigint: true })
    if (!handleStat.isFile()) throw new Error("Cannot preview a directory")
    await assertPathIdentity()

    const size = Number(handleStat.size)
    const modifiedMs = Number(handleStat.mtimeMs)
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(modifiedMs)) {
      throw new Error("File metadata exceeds the supported preview range")
    }
    return {
      handle,
      rootPath: realRoot,
      filePath: initialRealCandidate,
      size,
      modified_at: new Date(modifiedMs).toISOString(),
      identity: {
        device: handleStat.dev,
        inode: handleStat.ino,
        size: handleStat.size,
        modifiedNs: handleStat.mtimeNs,
        changedNs: handleStat.ctimeNs
      },
      assertPathIdentity
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

/**
 * Read an already-authorized regular file without trusting its pathname again
 * for content. Memory is bounded to `initial size + 1` (and therefore never
 * exceeds `maxBytes + 1`); the extra byte detects growth after open. A final fstat and pathname/inode
 * check reject truncation, in-place metadata changes, or path replacement that
 * occurred while the read was in flight.
 *
 * Ownership remains with the caller: this helper never closes `opened.handle`.
 */
export async function readStableFileHandleBounded(
  opened: StableFileHandle,
  maxBytes: number
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer")
  }
  if (opened.size > maxBytes) {
    throw new StableBoundedReadError("initial-too-large", opened.size)
  }

  // One byte beyond the authorized initial size is enough to detect any growth;
  // the final fstat tells us whether that growth crossed maxBytes. Do not reserve
  // the caller's entire cap for a tiny file (some consumers allow 128 MiB).
  const buffer = Buffer.allocUnsafe(opened.size + 1)
  let total = 0
  while (total < buffer.byteLength) {
    const { bytesRead } = await opened.handle.read(
      buffer,
      total,
      buffer.byteLength - total,
      total
    )
    if (bytesRead === 0) break
    total += bytesRead
  }
  const finalStat = await opened.handle.stat({ bigint: true })
  if (finalStat.size > BigInt(maxBytes) || total > maxBytes) {
    const observedSize =
      finalStat.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(finalStat.size) : total
    throw new StableBoundedReadError("grew-too-large", observedSize)
  }
  if (
    !finalStat.isFile() ||
    finalStat.dev !== opened.identity.device ||
    finalStat.ino !== opened.identity.inode ||
    finalStat.size !== opened.identity.size ||
    finalStat.mtimeNs !== opened.identity.modifiedNs ||
    finalStat.ctimeNs !== opened.identity.changedNs ||
    BigInt(total) !== opened.identity.size
  ) {
    throw new StableBoundedReadError("changed", total)
  }
  try {
    await opened.assertPathIdentity()
  } catch {
    throw new StableBoundedReadError("changed", total)
  }
  return buffer.subarray(0, total)
}

/**
 * Acquire a stable read/write capability for an existing file below a trusted
 * root. Unlike the read-only preview helper, writable capabilities reject file
 * symlinks and hard links: mutating either could modify a second path outside
 * the trusted root. Callers must perform every read and write through the
 * returned handle, and revalidate immediately before writing.
 */
export async function openStableWritableFileHandle(
  trustedRootPath: string,
  candidatePath: string
): Promise<StableWritableFileHandle> {
  const absoluteCandidate = path.resolve(candidatePath)
  const [realRoot, initialRealCandidate] = await Promise.all([
    realpath(path.resolve(trustedRootPath)),
    realpath(absoluteCandidate)
  ])
  if (!isPathInside(realRoot, initialRealCandidate)) {
    throw new Error("Access denied: file is outside the trusted root")
  }

  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)
  const nonBlocking = process.platform === "win32" ? 0 : (constants.O_NONBLOCK ?? 0)
  const handle = await open(
    absoluteCandidate,
    constants.O_RDWR | noFollow | nonBlocking
  )

  const assertPathIdentity = async (): Promise<void> => {
    const handleStat = await handle.stat({ bigint: true })
    if (!handleStat.isFile()) throw new Error("Writable capability is not a regular file")
    if (handleStat.nlink !== 1n) {
      throw new Error("Writable capability must not have hard links")
    }

    const [pathEntry, currentRealCandidate] = await Promise.all([
      lstat(absoluteCandidate, { bigint: true }),
      realpath(absoluteCandidate)
    ])
    if (!pathEntry.isFile() || pathEntry.isSymbolicLink()) {
      throw new Error("Writable capability path is not a regular file")
    }
    if (!isPathInside(realRoot, currentRealCandidate)) {
      throw new Error("Access denied: file moved outside the trusted root")
    }
    const currentPathStat = await stat(currentRealCandidate, { bigint: true })
    if (
      !currentPathStat.isFile() ||
      currentPathStat.dev !== handleStat.dev ||
      currentPathStat.ino !== handleStat.ino ||
      pathEntry.dev !== handleStat.dev ||
      pathEntry.ino !== handleStat.ino
    ) {
      throw new Error("File changed while the writable capability was active")
    }
  }

  try {
    await assertPathIdentity()
    const handleStat = await handle.stat({ bigint: true })
    const size = Number(handleStat.size)
    const modifiedMs = Number(handleStat.mtimeMs)
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(modifiedMs)) {
      throw new Error("File metadata exceeds the supported writable range")
    }
    return {
      handle,
      rootPath: realRoot,
      filePath: initialRealCandidate,
      size,
      modified_at: new Date(modifiedMs).toISOString(),
      identity: {
        device: handleStat.dev,
        inode: handleStat.ino,
        size: handleStat.size,
        modifiedNs: handleStat.mtimeNs,
        changedNs: handleStat.ctimeNs
      },
      assertPathIdentity
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}
