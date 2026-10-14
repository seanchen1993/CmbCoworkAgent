import fs from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { readBoundedAuthoringVersionFile } from "./authoring-version-file"
import type { AuthoringPreparationInspection } from "../../../shared/mods/authoring-install"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_BYTES = 4 * 1024 * 1024
function identity(file: string) {
  const value = fs.lstatSync(file, { bigint: true })
  if (value.isSymbolicLink()) throw Error("AUTHORING_VERSION_DIRECTORY")
  return [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs].join(":")
}
function rootToken(file: string) {
  directory(file)
  const stat = fs.lstatSync(file, { bigint: true })
  return `${stat.dev}:${stat.ino}`
}
function directory(file: string) {
  const value = fs.lstatSync(file)
  if (value.isSymbolicLink() || !value.isDirectory()) throw Error("AUTHORING_VERSION_DIRECTORY")
}
function inventory(root: string) {
  const files: string[] = []
  let bytes = 0,
    entries = 0
  const walk = (file: string, depth = 0) => {
    const stat = fs.lstatSync(file)
    if (++entries > 4096 || depth > 64 || stat.isSymbolicLink())
      throw Error("AUTHORING_VERSION_LIMIT")
    files.push(file + ":" + identity(file))
    if (stat.isDirectory())
      for (const name of fs.readdirSync(file).sort()) walk(join(file, name), depth + 1)
    else if (stat.isFile() && stat.nlink === 1) {
      bytes += stat.size
      if (bytes > MAX_BYTES) throw Error("AUTHORING_VERSION_LIMIT")
    } else throw Error("AUTHORING_VERSION_DIRECTORY")
  }
  if (fs.existsSync(root)) walk(root)
  return { bytes, fingerprint: createHash("sha256").update(JSON.stringify(files)).digest("hex") }
}
/** Preserved crash artifacts count against quota and never become executable version authority. */
export function measureAuthoringQuarantine(root: string) {
  const quarantine = join(root, ".quarantine")
  if (!fs.existsSync(quarantine)) return { bytes: 0, count: 0 }
  directory(quarantine)
  const entries = fs.readdirSync(quarantine)
  if (entries.length > 16 || entries.some((name) => !UUID.test(name)))
    throw Error("AUTHORING_VERSION_LIMIT")
  return { bytes: inventory(quarantine).bytes, count: entries.length }
}
function observe(root: string, workspace: string) {
  const lock = join(root, ".prepare-lock")
  if (!fs.existsSync(root) || !fs.existsSync(lock)) return undefined
  directory(root)
  const rootId = identity(root),
    lockId = identity(lock)
  const raw = readBoundedAuthoringVersionFile(lock, 8192)
  let owner: { schemaVersion: number; pid: number; workspace: string; versionId: string }
  try {
    owner = JSON.parse(raw)
  } catch {
    throw Error("AUTHORING_PREPARATION_UNKNOWN")
  }
  if (
    !owner ||
    owner.schemaVersion !== 1 ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    owner.workspace !== workspace ||
    !UUID.test(owner.versionId)
  )
    throw Error("AUTHORING_PREPARATION_UNKNOWN")
  let state: "live" | "stale" | "unknown" = "live"
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    state = (error as NodeJS.ErrnoException).code === "ESRCH" ? "stale" : "unknown"
  }
  const source = join(root, owner.versionId),
    quarantine = join(root, ".quarantine"),
    archive = join(quarantine, owner.versionId)
  if (fs.existsSync(quarantine)) directory(quarantine)
  if (fs.existsSync(archive)) {
    directory(archive)
    if (readBoundedAuthoringVersionFile(join(archive, "owner.json"), 8192) !== raw)
      throw Error("AUTHORING_PREPARATION_UNKNOWN")
  }
  const content = inventory(source),
    retained = inventory(archive)
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ rootId, lockId, raw, content, retained, state }))
    .digest("hex")
  return { owner, raw, lockId, rootId, source, archive, quarantine, lock, fingerprint, state }
}
export function inspectAuthoringPreparation(
  root: string,
  workspace: string
): AuthoringPreparationInspection {
  try {
    const value = observe(root, workspace)
    return value
      ? {
          state: value.state,
          versionId: value.owner.versionId,
          fingerprint: value.fingerprint,
          canRecover: value.state === "stale"
        }
      : { state: "none", canRecover: false }
  } catch {
    return { state: "unknown", canRecover: false }
  }
}
/** Cooperative app-writer recovery. Never steals a live PID or assumes a timeout means death. */
export function recoverAuthoringPreparation(
  root: string,
  workspace: string,
  fingerprint: string,
  assertCurrent: () => void,
  validatePublished: (versionId: string) => void
) {
  assertCurrent()
  const value = observe(root, workspace)
  if (!value || value.state !== "stale" || value.fingerprint !== fingerprint)
    throw Error("AUTHORING_PREPARATION_CHANGED")
  const { source, archive, quarantine, lock, raw, owner } = value
  const originalRoot = rootToken(root)
  const current = () => {
    assertCurrent()
    if (rootToken(root) !== originalRoot) throw Error("AUTHORING_PREPARATION_CHANGED")
  }
  const published = fs.existsSync(join(source, "record.json"))
  if (published) validatePublished(owner.versionId)
  const recheck = () => {
    current()
    const observed = observe(root, workspace)
    if (!observed || observed.fingerprint !== fingerprint || observed.state !== "stale")
      throw Error("AUTHORING_PREPARATION_CHANGED")
  }
  recheck()
  if (!published) {
    const measured = measureAuthoringQuarantine(root)
    if (
      (!fs.existsSync(archive) && measured.count >= 16) ||
      measured.bytes + inventory(source).bytes + Buffer.byteLength(raw) > MAX_BYTES
    )
      throw Error("AUTHORING_VERSION_LIMIT")
    recheck()
    fs.mkdirSync(quarantine, { recursive: true })
    directory(quarantine)
    fs.mkdirSync(archive, { recursive: true })
    directory(archive)
    const ownerFile = join(archive, "owner.json")
    if (!fs.existsSync(ownerFile)) {
      const fd = fs.openSync(ownerFile, "wx", 0o600)
      try {
        fs.writeFileSync(fd, raw)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    }
    if (readBoundedAuthoringVersionFile(ownerFile, 8192) !== raw)
      throw Error("AUTHORING_PREPARATION_CHANGED")
    if (fs.existsSync(source)) {
      directory(source)
      if (fs.existsSync(join(source, "record.json")) || fs.existsSync(join(archive, "version")))
        throw Error("AUTHORING_PREPARATION_CHANGED")
      current()
      if (identity(lock) !== value.lockId || readBoundedAuthoringVersionFile(lock, 8192) !== raw)
        throw Error("AUTHORING_PREPARATION_CHANGED")
      // Both paths derive from a validated UUID under the checked application-owned root.
      fs.renameSync(source, join(archive, "version"))
    }
  }
  current()
  if (identity(lock) !== value.lockId || readBoundedAuthoringVersionFile(lock, 8192) !== raw)
    throw Error("AUTHORING_PREPARATION_CHANGED")
  try {
    process.kill(owner.pid, 0)
    throw Error("AUTHORING_PREPARATION_LIVE")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
  fs.unlinkSync(lock)
  assertCurrent()
  return {
    state: "recovered" as const,
    versionId: owner.versionId,
    preserved: published ? ("published" as const) : ("quarantine" as const)
  }
}
