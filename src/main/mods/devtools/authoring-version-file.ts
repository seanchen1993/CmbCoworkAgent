import fs from "node:fs"

/** Always bounds allocation/read bytes, including concurrent growth after an initial stat. */
export function readBoundedAuthoringVersionFile(path: string, maxBytes: number): string {
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const before = fs.fstatSync(descriptor, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes))
      throw Error("AUTHORING_VERSION_CHANGED")
    const buffer = Buffer.alloc(Number(before.size) + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytes, buffer.length - bytes, bytes)
      if (!count) break
      bytes += count
    }
    const after = fs.fstatSync(descriptor, { bigint: true })
    const current = fs.lstatSync(path, { bigint: true })
    const identity = (stat: typeof before) =>
      [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
    if (
      bytes !== Number(before.size) ||
      current.isSymbolicLink() ||
      identity(before) !== identity(after) ||
      identity(after) !== identity(current)
    )
      throw Error("AUTHORING_VERSION_CHANGED")
    const text = buffer.subarray(0, bytes).toString("utf8")
    if (!Buffer.from(text, "utf8").equals(buffer.subarray(0, bytes)))
      throw Error("AUTHORING_VERSION_CHANGED")
    return text
  } finally {
    fs.closeSync(descriptor)
  }
}
