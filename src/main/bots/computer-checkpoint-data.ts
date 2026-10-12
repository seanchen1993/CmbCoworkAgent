import { lstat, mkdir, opendir, realpath } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import {
  copyBackupFile,
  hashBackupFile,
  present,
  readPrivateJson,
  syncDirectory,
  writePrivateJson
} from "./backup-io"
import type { ComputerNativeSQLite } from "./computer-checkpoint-native"
import {
  computerDataManifest,
  type ComputerComponent,
  type ComputerDataManifest
} from "./computer-checkpoint-manifest"
import {
  type ComputerCaptureInput,
  type ComputerPreparationInput,
  type ComponentLocations
} from "./computer-checkpoint-ports"

const failed = () => new Error("电脑恢复点的数据、引用文件或目录结构校验失败")
const stamp = async (path: string) => {
  const info = await lstat(path, { bigint: true })
  if (!info.isFile() || info.nlink !== 1n || (await realpath(path)) !== resolve(path))
    throw failed()
  return { dev: info.dev, ino: info.ino }
}
const shape = (manifest: ComputerDataManifest) => {
  // Count both content files and retained Teach session directories in the
  // common budget. Empty objects/teach roots are fixed protocol slots.
  const parents = new Set(
    manifest.entries.filter((e) => e.path.startsWith("teach/")).map((e) => e.path.split("/")[1])
  )
  return {
    entries: manifest.entries.length + parents.size,
    bytes: manifest.entries.reduce((sum, e) => sum + e.size, 0)
  }
}
async function verifyReferences(
  database: string,
  manifest: ComputerDataManifest,
  native: ComputerNativeSQLite
) {
  // Verify the raw post-fence DB before SQLite ever opens it. A staged WAL or
  // journal is never accepted as a way to turn different raw bytes into it.
  await hashBackupFile(dirname(database), "bots.sqlite", manifest.entries[0])
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (await present(database + suffix)) throw failed()
  const value = await native.read(database)
  if (
    value.schemaVersion !== manifest.schemaVersion ||
    JSON.stringify(value.references) !== JSON.stringify(manifest.entries.slice(1))
  )
    throw failed()
}
async function verifyTree(
  root: string,
  scope: "objects" | "teach",
  entries: ComputerDataManifest["entries"]
) {
  if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== resolve(root)) throw failed()
  const files = new Map(
    entries
      .filter((e) => e.path.startsWith(scope + "/"))
      .map((e) => [e.path.slice(scope.length + 1), e])
  )
  const directories = new Set(
    [...files.keys()].filter((p) => p.includes("/")).map((p) => p.split("/")[0])
  )
  let visited = 0
  const visit = async (path: string) => {
    if (++visited > 50_000) throw failed()
    const info = await lstat(join(root, path))
    if (info.isDirectory() && directories.delete(path)) {
      const directory = await opendir(join(root, path))
      for await (const child of directory) await visit(`${path}/${child.name}`)
    } else {
      const entry = files.get(path)
      if (!entry) throw failed()
      await hashBackupFile(root, path, entry)
      files.delete(path)
    }
  }
  const directory = await opendir(root)
  for await (const child of directory) await visit(child.name)
  if (files.size || directories.size) throw failed()
}
export async function verifyComputerData(
  root: string,
  manifest: ComputerDataManifest,
  native: ComputerNativeSQLite,
  locations?: ComponentLocations
) {
  const database = locations?.get("database") ?? join(root, "bots.sqlite"),
    objects = locations?.get("objects") ?? join(root, "objects"),
    teach = locations?.get("teach") ?? join(root, "teach")
  await verifyReferences(database, manifest, native)
  await verifyTree(objects, "objects", manifest.entries)
  await verifyTree(teach, "teach", manifest.entries)
}
export async function captureComputerData(
  input: ComputerCaptureInput,
  native: ComputerNativeSQLite
): Promise<ComputerComponent> {
  const source = join(input.directory, "bots.sqlite")
  if (!(await present(source))) return { state: "absent" }
  input.owner.assertCurrent()
  input.signal.throwIfAborted()
  const before = await stamp(source),
    root = join(input.destination, "data")
  await mkdir(root, { mode: 0o700 })
  const snapshot = await native.capture(
    basename(input.destination).replace(/^\.pending-/, ""),
    input.budget.remaining().bytes
  )
  const after = await stamp(source)
  if (before.dev !== after.dev || before.ino !== after.ino) throw failed()
  const entries = [await hashBackupFile(root, "bots.sqlite"), ...snapshot.references],
    schemaVersion = snapshot.schemaVersion
  const manifest = computerDataManifest.parse({ format: 1, schemaVersion, entries }),
    totals = shape(manifest)
  input.budget.consume(totals.entries, totals.bytes)
  await mkdir(join(root, "objects"), { mode: 0o700 })
  await mkdir(join(root, "teach"), { mode: 0o700 })
  for (const entry of entries.slice(1)) {
    input.owner.assertCurrent()
    input.signal.throwIfAborted()
    await copyBackupFile(input.directory, entry.path, root, entry)
  }
  await verifyComputerData(root, manifest, native)
  await writePrivateJson(join(root, "manifest.json"), manifest)
  await syncDirectory(root)
  return {
    state: "established",
    sha256: (await readPrivateJson(root, "manifest.json")).sha256,
    ...totals
  }
}
export async function readComputerData(
  root: string,
  component: ComputerComponent,
  native: ComputerNativeSQLite
) {
  if (component.state === "absent") {
    if (await present(root)) throw failed()
    return undefined
  }
  const sealed = await readPrivateJson(root, "manifest.json"),
    manifest = computerDataManifest.parse(sealed.value)
  if (
    sealed.sha256 !== component.sha256 ||
    JSON.stringify(shape(manifest)) !==
      JSON.stringify({ entries: component.entries, bytes: component.bytes })
  )
    throw failed()
  await verifyComputerData(root, manifest, native)
  const allowed = new Set(["bots.sqlite", "objects", "teach", "manifest.json"]),
    directory = await opendir(root)
  for await (const entry of directory) if (!allowed.delete(entry.name)) throw failed()
  if (allowed.size) throw failed()
  return manifest
}
export async function prepareComputerData(
  input: ComputerPreparationInput,
  component: ComputerComponent,
  native: ComputerNativeSQLite
): Promise<ComputerComponent> {
  const root = join(input.pointRoot, "data"),
    manifest = await readComputerData(root, component, native)
  // A source without user data still needs a fresh control database, so the
  // next Host cannot accept pre-restore initial-generation requests.
  const next = join(input.hostStage, "next")
  await mkdir(join(next, "objects"), { mode: 0o700 })
  await mkdir(join(next, "teach"), { mode: 0o700 })
  for (const entry of manifest?.entries ?? []) {
    input.signal.throwIfAborted()
    input.owner.assertCurrent()
    await copyBackupFile(root, entry.path, next, entry)
  }
  const fenced = await native.fence(
    basename(input.hostStage).replace(/^\.restore-/, ""),
    input.nonce,
    !manifest
  )
  const retained = computerDataManifest.parse({
    format: 1,
    schemaVersion: fenced.schemaVersion,
    entries: [await hashBackupFile(next, "bots.sqlite"), ...fenced.references]
  })
  // Deletion barriers may remove references. Their copied bytes must also be
  // removed before publishing the new exact objects/Teach tree.
  const allowed = new Set(retained.entries.map((e) => e.path))
  const { rm } = await import("node:fs/promises")
  for (const entry of manifest?.entries.slice(1) ?? [])
    if (!allowed.has(entry.path)) {
      input.owner.assertCurrent()
      await rm(join(next, entry.path))
    }
  const sessionDirs = new Set(
    (manifest?.entries ?? [])
      .filter((e) => e.path.startsWith("teach/"))
      .map((e) => e.path.split("/")[1])
  )
  for (const session of sessionDirs)
    if (!retained.entries.some((e) => e.path.startsWith(`teach/${session}/`))) {
      input.owner.assertCurrent()
      await rm(join(next, "teach", session), { recursive: true })
    }
  await verifyComputerData(next, retained, native)
  await writePrivateJson(join(input.hostStage, "prepared-data.json"), retained)
  return {
    state: "established",
    sha256: (await readPrivateJson(input.hostStage, "prepared-data.json")).sha256,
    ...shape(retained)
  }
}
