import { createRequire } from "node:module"
import * as defaultIO from "node:fs/promises"
import { dirname, isAbsolute, sep } from "node:path"
import { hashOwnedShellArtifact } from "./owned-shell-artifact"
import { openStableFileHandle } from "../services/stable-file-handle"
import { readStableAsarHeader, locateStableAsarMember } from "../services/stable-asar-reader"

const io: typeof defaultIO = process.versions.electron
  ? createRequire(process.execPath)("original-fs").promises
  : defaultIO
const limit = 16 * 1024 * 1024

/** Resolve only a fixed compiled Main process entry. An ASAR virtual member
 * cannot be granted a Windows kernel ACL, and a same-named sidecar alone is
 * not admission: the archive header must mark it unpacked with identical bytes.
 * No extraction, cache write, PATH search, or fallback to packed execution. */
export async function resolvePhysicalBotProcessArtifact(
  logicalEntry: string
): Promise<{ entry: string; sha256: string }> {
  if (!isAbsolute(logicalEntry) || logicalEntry.includes("\0"))
    throw new Error("Bot process entry must be an absolute fixed build path")
  const parts = logicalEntry.split(sep),
    archiveIndex = parts.findIndex((part) => part.endsWith(".asar"))
  if (archiveIndex < 0) {
    const sha256 = await hashOwnedShellArtifact(logicalEntry)
    if ((await io.realpath(logicalEntry)) !== logicalEntry)
      throw new Error("Bot physical entry contains a path alias")
    return { entry: logicalEntry, sha256 }
  }
  const archive = parts.slice(0, archiveIndex + 1).join(sep),
    member = parts.slice(archiveIndex + 1).join(sep)
  if (!/^out[\\/]main[\\/][A-Za-z0-9][A-Za-z0-9_.-]{0,191}\.(?:js|cjs|mjs)$/.test(member))
    throw new Error("Bot process entry is outside the fixed compiled Main directory")
  const before = await io.lstat(archive, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
    throw new Error("Bot application archive is not a physical file")
  const opened = await openStableFileHandle(dirname(archive), archive, io)
  try {
    if (
      before.dev !== opened.identity.device ||
      before.ino !== opened.identity.inode ||
      before.size !== opened.identity.size ||
      before.mtimeNs !== opened.identity.modifiedNs ||
      before.ctimeNs !== opened.identity.changedNs
    )
      throw new Error("Bot application archive changed before entry resolution")
    const header = await readStableAsarHeader(opened),
      info = locateStableAsarMember(opened, header, member, limit)
    if (!("unpackedPath" in info))
      throw new Error("Bot native process entry must be physically unpacked by packaging")
    const metadata = header.filesystem.getFile(member, false)
    if (
      !("integrity" in metadata) ||
      metadata.integrity.algorithm !== "SHA256" ||
      !/^[a-f0-9]{64}$/.test(metadata.integrity.hash)
    )
      throw new Error("Bot unpacked member has no packaged SHA256 identity")
    const sha256 = await hashOwnedShellArtifact(logicalEntry)
    if (
      sha256 !== metadata.integrity.hash ||
      sha256 !== (await hashOwnedShellArtifact(info.unpackedPath))
    )
      throw new Error("Bot unpacked process entry differs from its packaged member")
    const entry = await io.lstat(info.unpackedPath, { bigint: true })
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.nlink !== 1n ||
      entry.size !== BigInt(info.size) ||
      (await io.realpath(info.unpackedPath)) !== info.unpackedPath
    )
      throw new Error("Bot unpacked process entry is not a canonical physical file")
    await opened.assertPathIdentity()
    const final = await opened.handle.stat({ bigint: true })
    if (
      final.size !== before.size ||
      final.mtimeNs !== before.mtimeNs ||
      final.ctimeNs !== before.ctimeNs
    )
      throw new Error("Bot application archive changed during entry resolution")
    return { entry: info.unpackedPath, sha256 }
  } finally {
    await opened.handle.close()
  }
}
