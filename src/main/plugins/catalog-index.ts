import { randomUUID } from "node:crypto"
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { basename, dirname, join } from "node:path"

const MAX_INDEX_BYTES = 4 * 1024 * 1024

export interface PluginCatalogSnapshot {
  readonly raw: string | null
}

function readIndex(file: string): string | null {
  let stat
  try {
    stat = lstatSync(file, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > MAX_INDEX_BYTES)
    throw Error("PLUGIN_CATALOG_INVALID")
  const same = (other: typeof stat) =>
    other.isFile() &&
    !other.isSymbolicLink() &&
    other.dev === stat.dev &&
    other.ino === stat.ino &&
    other.nlink === stat.nlink &&
    other.size === stat.size &&
    other.mtimeNs === stat.mtimeNs &&
    other.ctimeNs === stat.ctimeNs
  const fd = openSync(file, "r")
  try {
    if (!same(fstatSync(fd, { bigint: true }))) throw Error("PLUGIN_CATALOG_CHANGED")
    const buffer = Buffer.alloc(Number(stat.size) + 1)
    let read = 0
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read)
      if (!count) break
      read += count
    }
    if (
      read !== Number(stat.size) ||
      !same(fstatSync(fd, { bigint: true })) ||
      !same(lstatSync(file, { bigint: true }))
    )
      throw Error("PLUGIN_CATALOG_CHANGED")
    const bytes = buffer.subarray(0, read),
      text = bytes.toString("utf8")
    if (!Buffer.from(text).equals(bytes)) throw Error("PLUGIN_CATALOG_INVALID")
    return text
  } finally {
    closeSync(fd)
  }
}

/** Exact-text CAS under the application's shared writer queue; not an OS-wide CAS. */
export class PluginCatalogIndex {
  private readonly snapshots = new WeakSet<PluginCatalogSnapshot>()

  constructor(private readonly file: string) {}

  capture(): PluginCatalogSnapshot {
    const snapshot = Object.freeze({ raw: readIndex(this.file) })
    this.snapshots.add(snapshot)
    return snapshot
  }

  assertCurrent(snapshot: PluginCatalogSnapshot): void {
    if (!this.snapshots.has(snapshot) || readIndex(this.file) !== snapshot.raw)
      throw Error("PLUGIN_CATALOG_CHANGED")
  }

  replace(snapshot: PluginCatalogSnapshot, next: string): PluginCatalogSnapshot {
    if (
      typeof next !== "string" ||
      next.length > MAX_INDEX_BYTES ||
      Buffer.byteLength(next) > MAX_INDEX_BYTES ||
      Buffer.from(next).toString("utf8") !== next
    )
      throw Error("PLUGIN_CATALOG_INVALID")
    const parsed: unknown = JSON.parse(next)
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          typeof item.id !== "string" ||
          typeof item.name !== "string" ||
          typeof item.path !== "string"
      ) ||
      new Set(parsed.map((item) => item.id)).size !== parsed.length
    )
      throw Error("PLUGIN_CATALOG_INVALID")
    this.assertCurrent(snapshot)
    const temporary = join(dirname(this.file), `.${basename(this.file)}.${randomUUID()}.pending`)
    let fd: number | undefined
    let created = false
    try {
      fd = openSync(temporary, "wx", 0o600)
      created = true
      writeFileSync(fd, next, "utf8")
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      // This catches local changes during preparation. An external writer can still race rename.
      this.assertCurrent(snapshot)
      renameSync(temporary, this.file)
      created = false
      const applied = this.capture()
      if (applied.raw !== next) throw Error("PLUGIN_CATALOG_CHANGED_AFTER_WRITE")
      return applied
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (created) unlinkSync(temporary)
    }
  }
}
