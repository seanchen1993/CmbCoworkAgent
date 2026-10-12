import {
  assertBotOwnedShellMaintenance,
  ownedShellMaintenanceOwner
} from "./owned-shell-maintenance-fence"
import {
  checkedBotCheckpointDatabase as checkedDatabase,
  referencedBotCheckpointFiles as referencedFiles,
  fenceBotCheckpointDatabase as fenceRestoredDatabase
} from "./checkpoint-data"
import { BotDeletionLedger } from "./deletion-ledger"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, opendir, readdir, realpath, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import {
  BOT_BACKUP_LIMIT,
  botBackupId,
  botBackupRequest,
  botBackupSelection,
  botBackupSummarySchema,
  type BotBackupRequest,
  type BotBackupResult,
  type BotBackupSummary
} from "../../shared/bot-backup"
import { BotHostLock } from "./host-lock"
import { BotMaintenanceReceipts } from "./maintenance-receipts"
import { BOT_SCHEMA_VERSION } from "./schema"
import { recoverBotWorkspaceMaintenance } from "./workspace-maintenance"
import { recoverBotBrowserMaintenance } from "./browser-maintenance"
import {
  copyBackupFile,
  hashBackupFile,
  present,
  privateDirectory,
  readPrivateJson,
  syncDirectory,
  writePrivateJson
} from "./backup-io"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const size = z
  .number()
  .int()
  .nonnegative()
  .max(20 * 1024 ** 3)
const relativePath = z
  .string()
  .regex(/^(bots\.sqlite|objects\/[a-f0-9]{64}|teach\/[a-f0-9-]{36}\/(?:[0-9]+\.jpg|video\.webm))$/)
const entry = z.object({ path: relativePath, size, sha256: hash }).strict()
const manifestSchema = z
  .object({
    format: z.literal(1),
    id: botBackupId,
    createdAt: z.number().int().nonnegative(),
    reason: z.enum(["manual", "before-restore", "scheduled"]),
    schemaVersion: z.number().int().min(14).max(BOT_SCHEMA_VERSION),
    entries: z.array(entry).min(1).max(50_000)
  })
  .strict()
type Manifest = z.infer<typeof manifestSchema>
const components = [
  "bots.sqlite",
  "bots.sqlite-wal",
  "bots.sqlite-shm",
  "objects",
  "teach"
] as const
const legacyJournalSchema = z
  .object({
    format: z.literal(1),
    nonce: botBackupId,
    stage: botBackupId,
    backup: botBackupSelection,
    safetyBackup: botBackupSummarySchema.optional(),
    recoveryCopy: botBackupId.optional(),
    components: z
      .array(
        z
          .object({ name: z.enum(components), hadOriginal: z.boolean(), hasNext: z.boolean() })
          .strict()
      )
      .length(components.length)
  })
  .strict()
const journalSchema = z.discriminatedUnion("format", [
  legacyJournalSchema,
  legacyJournalSchema.extend({ format: z.literal(2), preparedSha256: hash }).strict()
])
type Journal = z.infer<typeof journalSchema>
const preparedSchema = manifestSchema
  .omit({ id: true, createdAt: true, reason: true })
  .extend({ nonce: botBackupId, backup: botBackupSelection })
  .strict()
type Prepared = z.infer<typeof preparedSchema>
type OwnershipGuard = () => void | Promise<void>
const noGuard: OwnershipGuard = () => {}

async function finishRestoreCleanup(
  directory: string,
  journal: Journal,
  guard: OwnershipGuard
): Promise<void> {
  // Legacy completion has no sealed replacement identity. Keep its displaced
  // originals available instead of assuming that cleanup is still authorized.
  if (journal.format === 1) return
  const stage = join(directory, `.restore-${journal.stage}`)
  if (!(await present(stage))) return
  if (!(await lstat(stage)).isDirectory() || (await realpath(stage)) !== stage)
    throw new Error("恢复暂存目录缺失或无效，原始数据已保留")
  if (journal.recoveryCopy) {
    await privateDirectory(join(directory, "backups"))
    await guard()
    await rename(stage, join(directory, "backups", `recovery-${journal.recoveryCopy}`))
    await syncDirectory(join(directory, "backups"))
  } else {
    await guard()
    await rm(stage, { recursive: true, force: true })
  }
  await syncDirectory(directory)
}

async function cleanupAbandonedStaging(directory: string, guard: OwnershipGuard): Promise<void> {
  await guard()
  for (const name of await readdir(directory))
    if (/^\.restore-[a-f0-9-]{36}$/.test(name)) {
      const stage = join(directory, name)
      if (!(await lstat(stage)).isDirectory() || (await realpath(stage)) !== stage) continue
      // An orphaned directory can contain the only displaced original. Only
      // unpublished staging with no original bytes may be discarded.
      if (await present(join(stage, "old"))) {
        const old = join(stage, "old")
        if (!(await lstat(old)).isDirectory() || (await realpath(old)) !== old) continue
        if ((await readdir(old)).length) continue
      }
      if (
        (await readdir(stage)).every((entry) => ["old", "next", "prepared.json"].includes(entry))
      ) {
        await guard()
        await rm(stage, { recursive: true, force: true })
      }
    } else if (name === "restore.json.pending") {
      await guard()
      await rm(join(directory, name), { force: true })
    }
  const catalog = join(directory, "backups", "snapshots")
  if (await present(catalog)) {
    await privateDirectory(catalog)
    for (const name of await readdir(catalog))
      if (/^\.pending-[a-f0-9-]{36}$/.test(name)) {
        await guard()
        await rm(join(catalog, name), { recursive: true, force: true })
      }
  }
}

function summary(manifest: Manifest, sha256: string): BotBackupSummary {
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    reason: manifest.reason,
    schemaVersion: manifest.schemaVersion,
    sha256,
    files: manifest.entries.length - 1,
    bytes: manifest.entries.reduce((total, item) => total + item.size, 0)
  }
}

async function readManifest(directory: string, id: string, expectedHash?: string) {
  botBackupId.parse(id)
  const root = join(directory, "backups", "snapshots", id)
  if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root)
    throw new Error("备份目录不能是符号链接")
  const { value, sha256 } = await readPrivateJson(root, "manifest.json")
  const manifest = manifestSchema.parse(value)
  if (manifest.id !== id || (expectedHash && sha256 !== expectedHash))
    throw new Error("备份已变化，请刷新后重新选择")
  if (
    manifest.entries[0].path !== "bots.sqlite" ||
    new Set(manifest.entries.map((item) => item.path)).size !== manifest.entries.length ||
    manifest.entries.reduce((sum, item) => sum + item.size, 0) > 20 * 1024 ** 3
  )
    throw new Error("备份清单无效")
  return { root, manifest, summary: summary(manifest, sha256) }
}

export async function listBotBackups(directory: string): Promise<BotBackupSummary[]> {
  if (!(await present(directory))) return []
  directory = await realpath(directory)
  const root = join(directory, "backups", "snapshots")
  if (!(await present(root))) return []
  const result: BotBackupSummary[] = []
  const receipts = BotMaintenanceReceipts.readOnly(directory)
  try {
    for (const folder of await readdir(root, { withFileTypes: true })) {
      if (!folder.isDirectory() || !botBackupId.safeParse(folder.name).success) continue
      if (receipts?.get("backup", folder.name)?.state === "deleted") continue
      const backup = await readManifest(directory, folder.name)
      receipts?.assertActive("backup", folder.name, backup.summary.sha256)
      result.push(backup.summary)
    }
  } finally {
    receipts?.close()
  }
  return result.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
}

async function createSnapshot(
  directory: string,
  id: string,
  reason: Manifest["reason"],
  receipts: BotMaintenanceReceipts,
  afterSnapshot?: () => Promise<void>,
  guard: OwnershipGuard = noGuard
): Promise<BotBackupSummary> {
  await guard()
  receipts.assertActive("backup", id)
  const catalog = join(directory, "backups", "snapshots"),
    destination = join(catalog, id)
  await privateDirectory(catalog)
  if (await present(destination)) {
    const existing = await readManifest(directory, id)
    if (existing.manifest.reason !== reason) throw new Error("备份标识已用于其他操作")
    await guard()
    receipts.publish("backup", id, reason, existing.summary.sha256)
    return existing.summary
  }
  if (receipts.get("backup", id)?.state === "published")
    throw new Error("恢复点文件已丢失，未重新生成；请发起新的保存操作")
  if ((await listBotBackups(directory)).length >= BOT_BACKUP_LIMIT)
    throw new Error(`已保留 ${BOT_BACKUP_LIMIT} 份备份，请删除不再需要的备份后重试`)
  const pending = join(catalog, `.pending-${id}`)
  await guard()
  receipts.reserve("backup", id, reason)
  let published = false
  // A crashed create can be retried with the same nonce while holding the Host lock.
  await rm(pending, { recursive: true, force: true })
  await privateDirectory(pending)
  try {
    await guard()
    const db = checkedDatabase(join(directory, "bots.sqlite"))
    try {
      db.prepare("VACUUM INTO ?").run(join(pending, "snapshot.sqlite"))
    } finally {
      db.close()
    }
    const file = await open(join(pending, "snapshot.sqlite"), "r+")
    try {
      await file.chmod(0o600)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(join(pending, "snapshot.sqlite"), join(pending, "bots.sqlite"))
    const snapshot = checkedDatabase(join(pending, "bots.sqlite"))
    let refs: z.infer<typeof entry>[]
    let schemaVersion: number
    try {
      refs = referencedFiles(snapshot)
      schemaVersion = Number(snapshot.prepare("SELECT version FROM bot_schema").get()!.version)
    } finally {
      snapshot.close()
    }
    // Refuse oversized sets before copying their contents, including a large
    // live database. Each subsequent copy still checks exact size and digest.
    const databaseSize = (await lstat(join(pending, "bots.sqlite"))).size
    if (refs.reduce((total, item) => total + item.size, databaseSize) > 20 * 1024 ** 3)
      throw new Error("备份超过 20 GiB 上限")
    await afterSnapshot?.()
    await guard()
    const database = await hashBackupFile(pending, "bots.sqlite")
    const entries = [database]
    for (const ref of refs) entries.push(await copyBackupFile(directory, ref.path, pending, ref))
    const manifest: Manifest = {
      format: 1,
      id,
      createdAt: Date.now(),
      reason,
      schemaVersion,
      entries
    }
    manifestSchema.parse(manifest)
    if (entries.reduce((total, item) => total + item.size, 0) > 20 * 1024 ** 3)
      throw new Error("备份超过 20 GiB 上限")
    await guard()
    await writePrivateJson(join(pending, "manifest.json"), manifest)
    await guard()
    await rename(pending, destination)
    published = true
    await syncDirectory(catalog)
    const saved = (await readManifest(directory, id)).summary
    await guard()
    receipts.publish("backup", id, reason, saved.sha256)
    return saved
  } finally {
    await guard()
    await rm(pending, { recursive: true, force: true })
    if (!published) receipts.releaseReservation("backup", id)
  }
}

/** The Host owns the lifetime lock. A read-only VACUUM snapshot captures committed
 * WAL state while tasks continue. Referenced objects must match that exact DB;
 * a concurrently removed/changed file fails the snapshot instead of publishing
 * an incomplete backup. The disposable worker exits when its parent disconnects. */
export async function createScheduledBotSnapshot(
  directory: string,
  nonce: string,
  afterSnapshot?: () => Promise<void>,
  guard: OwnershipGuard = noGuard
): Promise<BotBackupSummary> {
  await guard()
  const id = botBackupId.parse(nonce)
  directory = await realpath(directory)
  const receipts = new BotMaintenanceReceipts(directory)
  try {
    return await createSnapshot(directory, id, "scheduled", receipts, afterSnapshot, guard)
  } finally {
    receipts.close()
  }
}

/** A delete intent is durable before its bytes are removed. Finish an interrupted
 * removal under the Host lock; ordinary catalog reads only hide retired entries. */
async function cleanupDeletedSnapshots(directory: string, guard: OwnershipGuard): Promise<void> {
  await guard()
  const receipts = BotMaintenanceReceipts.readOnly(directory)
  if (!receipts) return
  const root = join(directory, "backups", "snapshots")
  try {
    if (!(await present(root))) return
    for (const folder of await readdir(root, { withFileTypes: true })) {
      if (!folder.isDirectory() || !botBackupId.safeParse(folder.name).success) continue
      const receipt = receipts.get("backup", folder.name)
      if (receipt?.state !== "deleted") continue
      const path = join(root, folder.name)
      if ((await realpath(path)) !== path) throw new Error("备份目录不能是符号链接")
      // The manifest itself may already have been removed by an interrupted rm.
      // The durable delete intent still owns this exact managed catalog entry.
      await guard()
      await rm(path, { recursive: true })
      await syncDirectory(root)
    }
  } finally {
    receipts.close()
  }
}

const invalidPrepared = () =>
  new Error("恢复准备数据校验失败，已停止启动；恢复日志、原始数据和暂存文件均已保留")

/** Validate the entire replacement, including files already moved before a
 * crash. The post-fence DB hash is intentionally different from its backup. */
async function verifyPreparedRestore(
  directory: string,
  stage: string,
  journal: Extract<Journal, { format: 2 }>,
  completed = false
): Promise<void> {
  const { value, sha256 } = await readPrivateJson(stage, "prepared.json"),
    prepared = preparedSchema.parse(value)
  if (
    sha256 !== journal.preparedSha256 ||
    prepared.nonce !== journal.nonce ||
    prepared.backup.id !== journal.backup.id ||
    prepared.backup.sha256 !== journal.backup.sha256 ||
    prepared.entries[0].path !== "bots.sqlite" ||
    new Set(prepared.entries.map((file) => file.path)).size !== prepared.entries.length ||
    prepared.entries.reduce((total, file) => total + file.size, 0) > 20 * 1024 ** 3
  )
    throw invalidPrepared()
  const next = join(stage, "next")
  for (const parent of [next, join(stage, "old")]) {
    if (!(await lstat(parent)).isDirectory() || (await realpath(parent)) !== parent)
      throw invalidPrepared()
  }
  if ((await readdir(next)).some((name) => !["bots.sqlite", "objects", "teach"].includes(name)))
    throw invalidPrepared()
  const locations = new Map<string, string>()
  for (const name of ["bots.sqlite", "objects", "teach"] as const) {
    const candidate = join(next, name)
    if (await present(candidate)) locations.set(name, next)
    else {
      const item = journal.components.find((component) => component.name === name)!
      // A missing next is only a completed move when the displaced original
      // still exists (or the target did not exist before this operation).
      if (item.hadOriginal && !(await present(join(stage, "old", name)))) throw invalidPrepared()
      locations.set(name, directory)
    }
  }
  const expected = new Map(prepared.entries.map((file) => [file.path, file]))
  await hashBackupFile(locations.get("bots.sqlite")!, "bots.sqlite", expected.get("bots.sqlite"))
  expected.delete("bots.sqlite")
  let visited = 0
  for (const name of ["objects", "teach"] as const) {
    const root = locations.get(name)!,
      tree = join(root, name)
    if (!(await lstat(tree)).isDirectory() || (await realpath(tree)) !== tree)
      throw invalidPrepared()
    const visit = async (relative: string): Promise<void> => {
      if (++visited > 100_000) throw invalidPrepared()
      const path = join(root, relative),
        info = await lstat(path)
      if (info.isSymbolicLink()) throw invalidPrepared()
      if (info.isDirectory()) {
        // Filtered Teach evidence may leave an empty session directory. Other
        // directories are not part of this flat, sealed component contract.
        if (!/^teach\/[a-f0-9-]{36}$/.test(relative)) throw invalidPrepared()
        const children = await opendir(path)
        for await (const child of children) await visit(`${relative}/${child.name}`)
      } else {
        const file = expected.get(relative)
        if (!file) throw invalidPrepared()
        await hashBackupFile(root, relative, file)
        expected.delete(relative)
      }
    }
    const children = await opendir(tree)
    for await (const child of children) await visit(`${name}/${child.name}`)
  }
  if (expected.size) throw invalidPrepared()
  if (!completed) return
  // Old WAL/SHM must be displaced before opening the new main DB. Otherwise a
  // valid old WAL could be interpreted as part of the restored database.
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (await present(join(directory, "bots.sqlite" + suffix))) throw invalidPrepared()
  const db = checkedDatabase(join(directory, "bots.sqlite"), false, prepared.schemaVersion)
  try {
    const refs = referencedFiles(db),
      files = new Map(prepared.entries.slice(1).map((file) => [file.path, file]))
    if (
      refs.length !== files.size ||
      refs.some((ref) => {
        const file = files.get(ref.path)
        return !file || file.size !== ref.size || file.sha256 !== ref.sha256
      }) ||
      !db
        .prepare("SELECT 1 FROM bot_events WHERE kind='workspace.restored' AND entity_id=?")
        .get(journal.nonce)
    )
      throw invalidPrepared()
  } finally {
    db.close()
  }
}

/** Must run under the same lifetime lock, before any Store, browser or runtime is opened.
 * A durable journal rolls forward interrupted multi-directory replacement. */
export async function recoverBotRestore(
  directory: string,
  afterMove?: (name: string) => void,
  guard: OwnershipGuard = noGuard
): Promise<void> {
  await guard()
  directory = await realpath(directory)
  const journal = (await present(join(directory, "restore.json")))
    ? journalSchema.parse((await readPrivateJson(directory, "restore.json", 64 * 1024)).value)
    : undefined
  if (journal?.format === 1)
    throw new Error(
      "旧版恢复日志缺少可验证的准备摘要，已停止恢复；原始数据和暂存目录均已保留，请保留这些文件并从原备份重新准备恢复。"
    )
  await guard()
  await recoverBotWorkspaceMaintenance(directory)
  await recoverBotBrowserMaintenance(directory, undefined, guard)
  await cleanupDeletedSnapshots(directory, guard)
  if (!journal) {
    if (await present(join(directory, "restore-completed.json"))) {
      const completed = journalSchema.parse(
        (await readPrivateJson(directory, "restore-completed.json", 64 * 1024)).value
      )
      await finishRestoreCleanup(directory, completed, guard)
    }
    await cleanupAbandonedStaging(directory, guard)
    return
  }
  if (journal.components.some((item, index) => item.name !== components[index]))
    throw new Error("恢复日志的文件范围无效")
  if (
    journal.components.some(
      (item) => item.hasNext !== !["bots.sqlite-wal", "bots.sqlite-shm"].includes(item.name)
    )
  )
    throw new Error("恢复日志的新文件范围无效")
  const stage = join(directory, `.restore-${journal.stage}`)
  if (!(await lstat(stage)).isDirectory() || (await realpath(stage)) !== stage)
    throw invalidPrepared()
  await verifyPreparedRestore(directory, stage, journal)
  for (const item of journal.components) {
    const current = join(directory, item.name),
      old = join(stage, "old", item.name),
      next = join(stage, "next", item.name)
    if (item.hadOriginal && !(await present(old))) {
      if (!(await present(current))) throw new Error("恢复原文件缺失，已停止启动")
      await guard()
      await rename(current, old)
      await syncDirectory(directory)
      await syncDirectory(join(stage, "old"))
      afterMove?.(`old:${item.name}`)
    }
    if (item.hasNext && (await present(next))) {
      if (await present(current)) throw new Error("恢复目标已被占用，已停止启动")
      await guard()
      await rename(next, current)
      await syncDirectory(directory)
      await syncDirectory(join(stage, "next"))
      afterMove?.(`next:${item.name}`)
    }
    if (item.hasNext && !(await present(current))) throw new Error("恢复文件缺失，已停止启动")
  }
  await verifyPreparedRestore(directory, stage, journal, true)
  // Keep the completed receipt for retry after the desktop loses the response.
  await guard()
  await rename(join(directory, "restore.json"), join(directory, "restore-completed.json"))
  await syncDirectory(directory)
  await finishRestoreCleanup(directory, journal, guard)
}

async function restoreSnapshot(
  directory: string,
  input: Extract<BotBackupRequest, { action: "restore" }>,
  receipts: BotMaintenanceReceipts,
  afterMove?: (name: string) => void,
  guard: OwnershipGuard = noGuard
): Promise<BotBackupResult> {
  await guard()
  if (await present(join(directory, "restore-completed.json"))) {
    const previous = journalSchema.parse(
      (await readPrivateJson(directory, "restore-completed.json", 64 * 1024)).value
    )
    if (previous.nonce === input.nonce) {
      if (previous.backup.id !== input.backup.id || previous.backup.sha256 !== input.backup.sha256)
        throw new Error("恢复标识已用于其他备份")
      return {
        action: "restore",
        ...(previous.safetyBackup ? { safetyBackup: previous.safetyBackup } : {}),
        ...(previous.recoveryCopy ? { recoveryCopy: previous.recoveryCopy } : {})
      }
    }
  }
  receipts.assertActive("backup", input.backup.id, input.backup.sha256)
  const backup = await readManifest(directory, input.backup.id, input.backup.sha256)
  const id = randomUUID(),
    stage = join(directory, `.restore-${id}`),
    next = join(stage, "next")
  await privateDirectory(join(stage, "old"))
  await privateDirectory(join(next, "objects"))
  await privateDirectory(join(next, "teach"))
  let published = false
  try {
    for (const file of backup.manifest.entries)
      await copyBackupFile(backup.root, file.path, next, file)
    const db = checkedDatabase(join(next, "bots.sqlite"), false, backup.manifest.schemaVersion)
    try {
      const refs = referencedFiles(db),
        actual = new Map(backup.manifest.entries.slice(1).map((item) => [item.path, item]))
      if (
        refs.length !== actual.size ||
        refs.some((ref) => {
          const file = actual.get(ref.path)
          return !file || file.size !== ref.size || file.sha256 !== ref.sha256
        })
      )
        throw new Error("备份清单与数据库引用不一致")
    } finally {
      db.close()
    }
    const deletions = new BotDeletionLedger(join(directory, "bots.sqlite"))
    try {
      let current: DatabaseSync | undefined
      try {
        current = checkedDatabase(join(directory, "bots.sqlite"))
      } catch {
        // A damaged main DB can still use acknowledged deletions in the independent ledger.
        // The existing recovery-copy path below retains all original bytes.
      }
      try {
        if (current) deletions.collect(current)
      } finally {
        current?.close()
      }
      await guard()
      fenceRestoredDatabase(join(next, "bots.sqlite"), input.nonce, deletions)
    } finally {
      deletions.close()
    }
    const filtered = checkedDatabase(join(next, "bots.sqlite"))
    let retained: Set<string>, preparedVersion: number
    try {
      retained = new Set(referencedFiles(filtered).map((file) => file.path))
      preparedVersion = Number(filtered.prepare("SELECT version FROM bot_schema").get()!.version)
    } finally {
      filtered.close()
    }
    // Delete only verified staging copies that lost their final live reference.
    // Content shared by an undeleted artifact remains available.
    const changedDirectories = new Set<string>()
    await guard()
    for (const file of backup.manifest.entries.slice(1))
      if (!retained.has(file.path)) {
        const removed = join(next, file.path)
        await rm(removed, { force: true })
        changedDirectories.add(dirname(removed))
      }
    for (const directory of changedDirectories) await syncDirectory(directory)
    const file = await open(join(next, "bots.sqlite"), "r")
    try {
      await file.sync()
    } finally {
      await file.close()
    }
    const prepared: Prepared = {
      format: 1,
      nonce: input.nonce,
      backup: input.backup,
      schemaVersion: preparedVersion,
      entries: [
        await hashBackupFile(next, "bots.sqlite"),
        ...backup.manifest.entries.slice(1).filter((file) => retained.has(file.path))
      ]
    }
    await guard()
    await writePrivateJson(join(stage, "prepared.json"), preparedSchema.parse(prepared))
    const preparedSha256 = (await readPrivateJson(stage, "prepared.json")).sha256
    let safetyBackup: BotBackupSummary | undefined
    let recoveryCopy: string | undefined
    try {
      safetyBackup = await createSnapshot(
        directory,
        randomUUID(),
        "before-restore",
        receipts,
        undefined,
        guard
      )
    } catch {
      await guard()
      // A damaged current database must not make its valid backup unusable.
      // Preserve the original database/WAL/objects as raw evidence instead of deleting it.
      const backupRoot = join(directory, "backups")
      await privateDirectory(backupRoot)
      if (
        (await readdir(backupRoot)).filter((name) => /^recovery-[a-f0-9-]{36}$/.test(name))
          .length >= 5
      )
        throw new Error("已有 5 份恢复前原始数据，请在备份目录中另存并清理后重试")
      recoveryCopy = input.nonce
    }
    const journal: Journal = {
      format: 2,
      preparedSha256,
      nonce: input.nonce,
      stage: id,
      backup: input.backup,
      ...(safetyBackup ? { safetyBackup } : { recoveryCopy }),
      components: []
    }
    for (const name of components)
      journal.components.push({
        name,
        hadOriginal: await present(join(directory, name)),
        hasNext: await present(join(next, name))
      })
    await guard()
    await writePrivateJson(join(directory, "restore.json"), journal)
    published = true
    await recoverBotRestore(directory, afterMove, guard)
    return { action: "restore", ...(safetyBackup ? { safetyBackup } : { recoveryCopy }) }
  } finally {
    if (!published) {
      await guard()
      await rm(stage, { recursive: true, force: true })
    }
  }
}

/** Offline only. The OS lock rejects live Hosts and concurrent maintenance processes. */
export async function executeBotBackup(
  directory: string,
  untrusted: unknown,
  afterMove?: (name: string) => void
): Promise<BotBackupResult> {
  const input = botBackupRequest.parse(untrusted)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  directory = await realpath(directory)
  const lock = BotHostLock.acquire(directory)
  if (!lock) throw new Error("Bot 后台仍在运行，请稍后重试")
  const guard = () => lock.assertCurrent()
  try {
    await assertBotOwnedShellMaintenance(directory, ownedShellMaintenanceOwner(lock))
    await recoverBotRestore(directory, undefined, guard)
    const receipts = new BotMaintenanceReceipts(directory)
    try {
      if (input.action === "create")
        return {
          action: "create",
          backup: await createSnapshot(directory, input.nonce, "manual", receipts, undefined, guard)
        }
      if (input.action === "restore")
        return await restoreSnapshot(directory, input, receipts, afterMove, guard)
      const path = join(directory, "backups", "snapshots", input.backup.id)
      const existing = (await present(path))
        ? await readManifest(directory, input.backup.id, input.backup.sha256)
        : undefined
      await guard()
      receipts.retire("backup", input.backup.id, input.backup.sha256, existing?.manifest.reason)
      if (existing) {
        await guard()
        await rm(path, { recursive: true })
        await syncDirectory(join(directory, "backups", "snapshots"))
      }
      return { action: "delete" }
    } finally {
      receipts.close()
    }
  } finally {
    lock.release()
  }
}
