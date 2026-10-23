import { constants, realpath as callbackRealpath, type BigIntStats } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"
import { hostStateError } from "./host-state-protocol"
import { runtimeDigest, runtimeRelativePath, type ScopedFileObservation } from "./safe-files"

// fs/promises.realpath uses native Windows spelling; the commit reader uses the
// JS realpath algorithm. Keep both readers' exact path/link fences equivalent.
const realpath = promisify(callbackRealpath)

export async function runtimeDirectoryAsync(root: string): Promise<string> {
  if (!isAbsolute(root)) hostStateError("DIRECTORY_INVALID")
  const path = resolve(root)
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
    hostStateError("DIRECTORY_INVALID")
  return path
}

export async function runtimeDirectoryIdentityAsync(root: string): Promise<string> {
  const directory = await runtimeDirectoryAsync(root)
  const stat = await lstat(directory, { bigint: true })
  return `${directory}:${stat.dev}:${stat.ino}`
}

function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(":")
}

/** Async preview reader with the same inode, hardlink and parent-chain fences as the commit reader. */
export async function readRuntimeScopedFileAsync(
  root: string,
  relative: string,
  maxBytes = 4 * 1024 * 1024,
  signal?: AbortSignal
): Promise<ScopedFileObservation> {
  signal?.throwIfAborted()
  const directory = await runtimeDirectoryAsync(root)
  const scopeIdentity = await runtimeDirectoryIdentityAsync(directory)
  runtimeRelativePath(relative)
  const parents: Array<{ path: string; identity: string }> = []
  let parent = directory
  const parts = relative.split("/")
  const remember = async (path: string) => {
    signal?.throwIfAborted()
    const stat = await lstat(path, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
      hostStateError("FILE_SCOPE_CHANGED")
    parents.push({ path, identity: `${stat.dev}:${stat.ino}` })
  }
  await remember(parent)
  let missingParent = false
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part)
    try {
      await remember(parent)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      missingParent = true
      break
    }
  }
  const checkParents = async () => {
    for (const observed of parents) {
      signal?.throwIfAborted()
      const stat = await lstat(observed.path, { bigint: true })
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await realpath(observed.path)) !== observed.path ||
        `${stat.dev}:${stat.ino}` !== observed.identity
      )
        hostStateError("FILE_SCOPE_CHANGED")
    }
  }
  const absent = async (): Promise<ScopedFileObservation> => {
    await checkParents()
    signal?.throwIfAborted()
    return {
      path: relative,
      present: false,
      fingerprint: runtimeDigest(JSON.stringify([scopeIdentity, relative, "missing"]))
    }
  }
  if (missingParent) return absent()
  const path = join(directory, ...parts)
  let before: BigIntStats
  try {
    before = await lstat(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absent()
    throw error
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    (await realpath(path)) !== path
  )
    hostStateError("FILE_UNSAFE")
  if (before.size > BigInt(maxBytes)) hostStateError("FILE_LIMIT")
  signal?.throwIfAborted()
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const initial = await fd.stat({ bigint: true })
    if (!initial.isFile() || identity(initial) !== identity(before)) hostStateError("FILE_CHANGED")
    const bytes = Buffer.alloc(Number(initial.size))
    let offset = 0
    while (offset < bytes.length) {
      signal?.throwIfAborted()
      const { bytesRead: count } = await fd.read(
        bytes,
        offset,
        Math.min(256 * 1024, bytes.length - offset),
        offset
      )
      if (!count) hostStateError("FILE_CHANGED")
      offset += count
    }
    signal?.throwIfAborted()
    const named = await lstat(path, { bigint: true })
    if (
      identity(await fd.stat({ bigint: true })) !== identity(initial) ||
      identity(named) !== identity(initial) ||
      named.isSymbolicLink() ||
      (await realpath(path)) !== path
    )
      hostStateError("FILE_CHANGED")
    await checkParents()
    signal?.throwIfAborted()
    return {
      path: relative,
      present: true,
      bytes,
      fingerprint: runtimeDigest(JSON.stringify([scopeIdentity, relative, runtimeDigest(bytes)]))
    }
  } finally {
    await fd.close()
  }
}
