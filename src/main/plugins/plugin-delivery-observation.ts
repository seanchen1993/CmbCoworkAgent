import { createHash } from "node:crypto"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { lstatSync, readdirSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import type { PluginMetadata } from "../types"
import { derivationContentIdentity, snapshotDerivationSource } from "./derivation-source"

export type ProjectDeliveryObservation = {
  outcome: "installed" | "exported" | "not-executed" | "conflict" | "unknown"
  reason?: string
}
const pathIdentity = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path)

/** Unlike ordinary discovery, an unreadable inventory must not be interpreted as uninstall.
 * The only missing-file exception is the proven empty directory of a pristine profile. */
export function readProjectDeliveryInventory(
  root: string,
  readIds: () => ReadonlySet<string>,
  readPlugins: () => PluginMetadata[]
): PluginMetadata[] {
  let knownInventory = false
  try {
    const ids = readIds()
    knownInventory = ids.size > 0
    const plugins = readPlugins()
    if (
      plugins.length !== ids.size ||
      new Set(plugins.map((plugin) => plugin.id)).size !== ids.size ||
      plugins.some((plugin) => !ids.has(plugin.id) || !plugin.name || !plugin.path)
    )
      throw Error("PROJECT_DELIVERY_INVENTORY_INVALID")
    return plugins
  } catch (error) {
    if (!knownInventory && (error as NodeJS.ErrnoException).code === "ENOENT") {
      const stat = lstatSync(root)
      if (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        pathIdentity(realpathSync.native(root)) === pathIdentity(root) &&
        readdirSync(root).length === 0
      )
        return []
    }
    throw error
  }
}

/** Read the exact regular file without accepting links, replacements or partial writes. */
export async function readProjectDeliveryArchive(path: string, guard: () => void): Promise<Buffer> {
  const absolute = resolve(path)
  const before = await lstat(absolute)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > 80 * 1024 * 1024 ||
    pathIdentity(await realpath(absolute)) !== pathIdentity(absolute)
  )
    throw Error("PROJECT_DELIVERY_ARCHIVE_CHANGED")
  const file = await open(absolute, "r")
  try {
    const opened = await file.stat()
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size)
      throw Error("PROJECT_DELIVERY_ARCHIVE_CHANGED")
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(
        bytes,
        offset,
        Math.min(1024 * 1024, bytes.length - offset),
        offset
      )
      if (!read.bytesRead) throw Error("PROJECT_DELIVERY_ARCHIVE_CHANGED")
      offset += read.bytesRead
    }
    const after = await file.stat()
    const current = await lstat(absolute)
    guard()
    if (
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      current.isSymbolicLink() ||
      current.ino !== opened.ino ||
      current.dev !== opened.dev ||
      current.nlink !== 1 ||
      current.size !== opened.size ||
      pathIdentity(await realpath(absolute)) !== pathIdentity(absolute)
    )
      throw Error("PROJECT_DELIVERY_ARCHIVE_CHANGED")
    guard()
    return bytes
  } finally {
    await file.close()
  }
}

/** Caller holds the native catalogue writer lock and supplies a strict, current inventory.
 * Absence is accepted only if neither registry identity nor any possible native install directory
 * remains. A same-name or orphan copy cannot become this attempt's successful installation.
 */
export async function observeProjectDeliveryInstallation(
  root: string,
  inventory: () => PluginMetadata[],
  input: { pluginId: string; name: string; version: string; digest: string },
  guard: () => void
): Promise<ProjectDeliveryObservation> {
  guard()
  const before = inventory().map((item) => ({ ...item }))
  const ids = new Set(before.map((item) => item.id))
  if (ids.size !== before.length || before.some((item) => !item.id || !item.name || !item.path))
    throw Error("PROJECT_DELIVERY_INVENTORY_INVALID")
  const exact = before.filter((item) => item.id === input.pluginId)
  const names = before.filter((item) => item.name.toLowerCase() === input.name.toLowerCase())
  if (exact.length !== 1 || names.length !== 1 || exact[0] !== names[0]) {
    if (exact.length || names.length)
      return { outcome: "conflict", reason: "PROJECT_DELIVERY_INSTALL_IDENTITY_CONFLICT" }
    // The native installer sanitizes this already restricted identifier unchanged and may add
    // numeric collision suffixes. A leftover directory is uncertain even without a registry row.
    const original = resolve(root)
    const stat = await lstat(original)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      pathIdentity(await realpath(original)) !== pathIdentity(original)
    )
      throw Error("PROJECT_DELIVERY_INSTALL_ROOT_CHANGED")
    const entries = await readdir(original, { withFileTypes: true })
    const name = (
      input.name
        .replace(/[^a-zA-Z0-9-_.\u4e00-\u9fff]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64) || "plugin"
    ).toLowerCase()
    if (
      entries.some(
        (entry) =>
          entry.name.toLowerCase() === name ||
          (entry.name.toLowerCase().startsWith(`${name}-`) &&
            /^\d+$/.test(entry.name.slice(name.length + 1)))
      )
    )
      return { outcome: "conflict", reason: "PROJECT_DELIVERY_INSTALL_DIRECTORY_UNCONFIRMED" }
    const current = await lstat(original)
    if (
      current.isSymbolicLink() ||
      current.ino !== stat.ino ||
      current.dev !== stat.dev ||
      pathIdentity(await realpath(original)) !== pathIdentity(original) ||
      JSON.stringify((await readdir(original)).sort()) !==
        JSON.stringify(entries.map((entry) => entry.name).sort())
    )
      throw Error("PROJECT_DELIVERY_INSTALL_ROOT_CHANGED")
    guard()
    if (JSON.stringify(inventory()) !== JSON.stringify(before))
      throw Error("PROJECT_DELIVERY_OBSERVATION_CHANGED")
    return { outcome: "not-executed", reason: "PROJECT_DELIVERY_INSTALL_NOT_PRESENT" }
  }
  const plugin = exact[0]
  if (plugin.name !== input.name || plugin.version !== input.version)
    return { outcome: "conflict", reason: "PROJECT_DELIVERY_INSTALL_IDENTITY_CONFLICT" }
  const first = await snapshotDerivationSource(plugin.path)
  guard()
  if (first.name !== input.name || derivationContentIdentity(first.files) !== input.digest)
    return { outcome: "conflict", reason: "PROJECT_DELIVERY_INSTALLED_CONTENT_CHANGED" }
  const second = await snapshotDerivationSource(plugin.path)
  guard()
  if (second.digest !== first.digest || JSON.stringify(inventory()) !== JSON.stringify(before))
    throw Error("PROJECT_DELIVERY_OBSERVATION_CHANGED")
  return { outcome: "installed" }
}

export async function observeProjectDeliveryExport(
  intent: { output: string; digest: string; bytes: number },
  guard: () => void
): Promise<ProjectDeliveryObservation> {
  try {
    const bytes = await readProjectDeliveryArchive(intent.output, guard)
    if (
      bytes.length !== intent.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== intent.digest
    )
      return { outcome: "conflict", reason: "PROJECT_DELIVERY_EXPORT_CONTENT_CHANGED" }
    guard()
    return { outcome: "exported" }
  } catch (error) {
    guard()
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { outcome: "not-executed", reason: "PROJECT_DELIVERY_EXPORT_NOT_PRESENT" }
    return { outcome: "conflict", reason: "PROJECT_DELIVERY_EXPORT_OBSERVATION_UNAVAILABLE" }
  }
}
