import { mkdir, realpath, stat, lstat } from "node:fs/promises"
import { dirname, basename, resolve, join } from "node:path"

export interface CheckpointDatabaseFileIdentity { dev: string; ino: string; birthtime: string }
interface DatabaseGroup { readonly key: string }
export interface CheckpointDatabaseIdentity { readonly key: string; readonly path: string; readonly logicalPath: string;
 readonly capturedFile?: CheckpointDatabaseFileIdentity; readonly group: object }
const groups = new Map<string, WeakRef<DatabaseGroup>>()
const files = new Map<string, WeakRef<DatabaseGroup>>()
const finalized = new FinalizationRegistry<{ paths: string[]; fileIds: string[] }>(record => {
  for (const path of record.paths) if (!groups.get(path)?.deref()) groups.delete(path)
  for (const id of record.fileIds) if (!files.get(id)?.deref()) files.delete(id)
})
const records = new WeakMap<DatabaseGroup, { paths: string[]; fileIds: string[] }>()
const keyPath = (path: string) => process.platform === "win32" ? path.toLowerCase() : path
const fileKey = (file: CheckpointDatabaseFileIdentity) => `${file.dev}:${file.ino}`

export async function readCheckpointDatabaseFileIdentity(path: string): Promise<CheckpointDatabaseFileIdentity> {
  const file = await stat(path, { bigint: true })
  if (!file.isFile() || file.nlink > 1n)
    throw new Error("SQLJS_SAVER_HARD_LINK_DATABASE_UNSUPPORTED")
  return { dev: String(file.dev), ino: String(file.ino), birthtime: String(file.birthtimeNs) }
}
/** Resolve a real parent before creation, so aliases cannot acquire a second setup gate. */
export async function resolveCheckpointDatabaseIdentity(path: string,
  options: { createParent?: boolean } = {}): Promise<CheckpointDatabaseIdentity> {
  const absolute = resolve(path)
  if (options.createParent !== false) await mkdir(dirname(absolute), { recursive: true })
  let canonical = join(await realpath(dirname(absolute)), basename(absolute))
  let file: CheckpointDatabaseFileIdentity | undefined
  try { canonical = await realpath(canonical); file = await readCheckpointDatabaseFileIdentity(canonical) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    // A missing leaf is creatable. A dangling symlink must never be followed by SQLite.
    const leaf = await lstat(canonical).catch(missing => {
      if ((missing as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw missing
    })
    if (leaf?.isSymbolicLink()) throw new Error("SQLJS_SAVER_DATABASE_IDENTITY_CHANGED")
  }
  const normalized = keyPath(canonical)
  let group = (file && files.get(fileKey(file))?.deref()) || groups.get(normalized)?.deref()
  if (!group) {
    group = Object.freeze({ key: normalized })
    const record = { paths: [normalized], fileIds: [] as string[] }
    records.set(group, record)
    finalized.register(group, record)
  }
  groups.set(normalized, new WeakRef(group))
  const record = records.get(group)!
  if (!record.paths.includes(normalized)) record.paths.push(normalized)
  if (file) {
    const id = fileKey(file)
    files.set(id, new WeakRef(group))
    if (!record.fileIds.includes(id)) record.fileIds.push(id)
  }
  return Object.freeze({ key: group.key, path: canonical, logicalPath: absolute, capturedFile: file, group })
}
export async function assertCheckpointDatabaseFileIdentity(path: string,
  expected: CheckpointDatabaseFileIdentity): Promise<void> {
  let actual: CheckpointDatabaseFileIdentity
  try { actual = await readCheckpointDatabaseFileIdentity(path) }
  catch (cause) { throw new Error("SQLJS_SAVER_DATABASE_IDENTITY_CHANGED", { cause }) }
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.birthtime !== expected.birthtime)
    throw new Error("SQLJS_SAVER_DATABASE_IDENTITY_CHANGED")
}

export async function assertCheckpointDatabasePathCurrent(identity: CheckpointDatabaseIdentity): Promise<void> {
  let current: CheckpointDatabaseIdentity
  try { current = await resolveCheckpointDatabaseIdentity(identity.logicalPath, { createParent: false }) }
  catch (cause) { throw new Error("SQLJS_SAVER_DATABASE_IDENTITY_CHANGED", { cause }) }
  if (keyPath(current.path) !== keyPath(identity.path) || current.key !== identity.key)
    throw new Error("SQLJS_SAVER_DATABASE_IDENTITY_CHANGED")
}
