import { Filesystem } from "@electron/asar/lib/filesystem.js"
import { Pickle } from "@electron/asar/lib/pickle.js"
import { isAbsolute, join } from "node:path"
import type { StableFileHandle } from "./stable-file-handle"

export interface StableAsarHeader {
  filesystem: Filesystem
  dataOffset: number
}

/** Parse the bounded header from the same physical handle used for member reads.
 * Electron's synthetic member stats are not filesystem identities. */
export async function readStableAsarHeader(opened: StableFileHandle): Promise<StableAsarHeader> {
  const prefix = Buffer.alloc(8)
  if ((await opened.handle.read(prefix, 0, 8, 0)).bytesRead !== 8 || prefix.readUInt32LE(0) !== 4)
    throw new Error("Invalid application archive header")
  const headerBytes = prefix.readUInt32LE(4)
  if (headerBytes < 8 || headerBytes > 16 * 1024 * 1024 || headerBytes + 8 > opened.size)
    throw new Error("Application archive header exceeds its limit")
  const header = Buffer.alloc(headerBytes)
  let read = 0
  while (read < headerBytes) {
    const part = await opened.handle.read(header, read, headerBytes - read, 8 + read)
    if (!part.bytesRead) throw new Error("Application archive header was truncated")
    read += part.bytesRead
  }
  const stringBytes = header.readInt32LE(4)
  if (
    header.readUInt32LE(0) !== headerBytes - 4 ||
    stringBytes < 0 ||
    stringBytes > headerBytes - 8 ||
    4 + Math.ceil((4 + stringBytes) / 4) * 4 !== headerBytes
  )
    throw new Error("Invalid application archive header payload")
  const filesystem = new Filesystem(opened.filePath)
  filesystem.setHeader(
    JSON.parse(Pickle.createFromBuffer(header).createIterator().readString()),
    headerBytes
  )
  return { filesystem, dataOffset: 8 + headerBytes }
}

/** Every parent and the member itself must be real metadata entries, never links.
 * The caller owns physical unpacked-file checks and final archive revalidation. */
export function locateStableAsarMember(
  opened: StableFileHandle,
  header: StableAsarHeader,
  member: string,
  maximum: number
): { size: number; offset: number } | { size: number; unpackedPath: string } {
  const parts = member.split(/[\\/]/)
  if (
    isAbsolute(member) ||
    parts.some((part) => !part || part === "." || part === ".." || part.includes("\0")) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 0
  )
    throw new Error("Invalid compiled archive member")
  for (let index = 1; index < parts.length; index++) {
    if (!("files" in header.filesystem.getFile(join(...parts.slice(0, index)), false)))
      throw new Error("Compiled archive directory cannot be a link")
  }
  const info = header.filesystem.getFile(join(...parts), false)
  if (!("size" in info) || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > maximum)
    throw new Error("Compiled archive member exceeds its limit or is a link")
  if (info.unpacked)
    return { size: info.size, unpackedPath: join(`${opened.filePath}.unpacked`, ...parts) }
  if (!/^\d+$/.test(info.offset)) throw new Error("Invalid compiled archive member offset")
  const offset = header.dataOffset + Number(info.offset)
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(offset + info.size) ||
    offset < header.dataOffset ||
    offset + info.size > opened.size
  )
    throw new Error("Compiled archive member is outside the archive")
  return { size: info.size, offset }
}
