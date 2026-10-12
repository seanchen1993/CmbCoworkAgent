import { lstat, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { dirname, isAbsolute, sep } from "node:path"
import { openStableFileHandle, type StableFileHandle } from "../services/stable-file-handle"
import { locateStableAsarMember, readStableAsarHeader } from "../services/stable-asar-reader"

const memberLimit = 16 * 1024 * 1024
// Electron patches even the archive pathname itself as a virtual directory.
// Only this trusted code read uses its built-in physical filesystem.
const physicalIO: typeof import("node:fs/promises") | undefined = process.versions.electron
  ? createRequire(process.execPath)("original-fs").promises
  : undefined

async function hashRange(opened: StableFileHandle, offset: number, size: number): Promise<string> {
  const hash = createHash("sha256"),
    buffer = Buffer.allocUnsafe(Math.max(1, Math.min(1024 * 1024, size)))
  let read = 0
  while (read < size) {
    const part = await opened.handle.read(
      buffer,
      0,
      Math.min(buffer.length, size - read),
      offset + read
    )
    if (!part.bytesRead) throw new Error("Owned shell artifact was truncated")
    hash.update(buffer.subarray(0, part.bytesRead))
    read += part.bytesRead
  }
  return hash.digest("hex")
}

async function physical<T>(
  path: string,
  maximum: number,
  read: (opened: StableFileHandle) => Promise<T>
): Promise<T> {
  const io = physicalIO ?? { lstat, realpath },
    before = await io.lstat(path, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(maximum)
  )
    throw new Error("Owned shell artifact is unsafe")
  const opened = await openStableFileHandle(dirname(path), path, physicalIO)
  try {
    if (
      before.dev !== opened.identity.device ||
      before.ino !== opened.identity.inode ||
      before.size !== opened.identity.size ||
      before.mtimeNs !== opened.identity.modifiedNs ||
      before.ctimeNs !== opened.identity.changedNs
    )
      throw new Error("Owned shell artifact changed")
    const value = await read(opened)
    await opened.assertPathIdentity()
    const after = await io.lstat(path, { bigint: true }),
      final = await opened.handle.stat({ bigint: true })
    for (const current of [after, final]) {
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1n ||
        before.dev !== current.dev ||
        before.ino !== current.ino ||
        before.size !== current.size ||
        before.mtimeNs !== current.mtimeNs ||
        before.ctimeNs !== current.ctimeNs
      )
        throw new Error("Owned shell artifact changed")
    }
    if ((await io.realpath(path)) !== opened.filePath)
      throw new Error("Owned shell artifact changed")
    return value
  } finally {
    await opened.handle.close()
  }
}

/** Hash the physical file or one bounded ASAR member through pinned handles.
 * A package update during either header or member reading fails closed. */
export async function hashOwnedShellArtifact(entry: string): Promise<string> {
  if (!isAbsolute(entry)) throw new Error("Owned shell artifact is invalid")
  const parts = entry.split(sep),
    archiveIndex = parts.findIndex((part) => part.endsWith(".asar"))
  if (archiveIndex < 0 || archiveIndex === parts.length - 1)
    return physical(entry, memberLimit, (opened) => hashRange(opened, 0, opened.size))
  const archive = parts.slice(0, archiveIndex + 1).join(sep),
    member = parts.slice(archiveIndex + 1).join(sep)
  return physical(archive, Number.MAX_SAFE_INTEGER, async (opened) => {
    const header = await readStableAsarHeader(opened),
      info = locateStableAsarMember(opened, header, member, memberLimit)
    if ("unpackedPath" in info)
      return physical(info.unpackedPath, info.size, async (file) => {
        if (file.size !== info.size) throw new Error("Owned shell artifact changed")
        return hashRange(file, 0, file.size)
      })
    return hashRange(opened, info.offset, info.size)
  })
}

/** A private immutable runtime artifact, never a PATH lookup. The integration
 * additionally pins its package/source/protocol provenance in Host policy. */
export async function verifyOwnedShellArtifact(artifact: {
  entry: string
  sha256: string
}): Promise<void> {
  if (!isAbsolute(artifact.entry) || !/^[a-f0-9]{64}$/.test(artifact.sha256))
    throw new Error("Owned shell artifact is invalid")
  if ((await hashOwnedShellArtifact(artifact.entry)) !== artifact.sha256)
    throw new Error("Owned shell artifact changed")
}
