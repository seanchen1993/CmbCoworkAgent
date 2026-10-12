import { randomUUID } from "node:crypto"
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  opendirSync,
  realpathSync
} from "node:fs"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { BotMaintenanceReceipts } from "./maintenance-receipts"
import { BotDeletionLedger } from "./deletion-ledger"
import { backupBeforeUpgrade, initializeBotDatabase } from "./migrations"
import { fenceBotCheckpointDatabase } from "./checkpoint-data"
import { BOT_SCHEMA_VERSION } from "./schema"
import type { BotHostLock } from "./host-lock"

export const LEGACY_COMPUTER_GENERATION_REASON =
  "检测到旧版电脑恢复后的数据代次缺失。未完成任务与待审批已停止，自动触发已暂停；Bot、历史和工作文件保留，请核对后重新交办。"

const invalid = () => new Error("旧版电脑恢复的代次校验失败，后台未启动；原数据和恢复日志已保留")
const restoreMarker =
  "SELECT 1 FROM bot_events WHERE kind IN ('workspace.restored','computer.restored') LIMIT 1"
const pendingNames = [
  "computer-recovery/pending.json",
  "restore.json",
  "workspace-maintenance/pending.json",
  "browser-maintenance/pending.json"
]
function stamp(path: string) {
  try {
    const info = lstatSync(path, { bigint: true })
    if (!info.isFile() || info.nlink !== 1n || realpathSync(path) !== resolve(path)) throw invalid()
    return { dev: info.dev, ino: info.ino }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
function table(db: DatabaseSync, name: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
}
function hasDomainData(db: DatabaseSync) {
  for (const row of db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'bot_schema'"
    )
    .iterate()) {
    const name = String(row.name).replaceAll('"', '""')
    // Exact bootstrap seeds are not user state. Any changed revision/order or
    // selected primary/default identity still requires a pre-fence snapshot.
    const changed =
      row.name === "bot_pinned_order"
        ? " WHERE id<>1 OR revision<>0 OR ids<>'[]'"
        : row.name === "bot_primary"
          ? " WHERE id<>1 OR revision<>0 OR bot_id IS NOT NULL OR default_bot_id IS NOT NULL"
          : ""
    if (db.prepare(`SELECT 1 FROM "${name}"${changed} LIMIT 1`).get()) return true
  }
  return false
}
function hasRecoveryWithoutReceipt(directory: string) {
  const path = join(directory, "computer-recovery", "recovery")
  let handle: ReturnType<typeof opendirSync>
  try {
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== resolve(path)) throw invalid()
    handle = opendirSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
  try {
    return handle.readSync() !== null
  } finally {
    handle.closeSync()
  }
}

/** Run after all sealed journals settle and before opening Store/executors.
 * A new compatibility generation is not attributed to any historical nonce. */
export function repairLegacyComputerGeneration(
  directory: string,
  owner: Pick<BotHostLock, "assertCurrent" | "recoveryOwnershipIdentity">
): void {
  const path = join(directory, "bots.sqlite")
  const guard = () => {
    owner.assertCurrent()
    const root = lstatSync(directory, { bigint: true }),
      expected = owner.recoveryOwnershipIdentity().root
    if (
      !root.isDirectory() ||
      realpathSync(directory) !== resolve(directory) ||
      String(root.dev) !== expected.dev ||
      String(root.ino) !== expected.ino
    )
      throw invalid()
    for (const name of pendingNames) {
      try {
        lstatSync(join(directory, name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      throw invalid()
    }
  }
  guard()
  let identity = stamp(path)
  if (identity) {
    const reader = new DatabaseSync(path, { readOnly: true })
    let protectedGeneration = false
    try {
      reader.exec(
        "PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA threads=1"
      )
      protectedGeneration =
        table(reader, "bot_events") && Boolean(reader.prepare(restoreMarker).get())
    } finally {
      reader.close()
    }
    guard()
    const current = stamp(path)
    if (!current || current.dev !== identity.dev || current.ino !== identity.ino) throw invalid()
    if (protectedGeneration) return
  }
  guard()
  const receipts = BotMaintenanceReceipts.readOnly(directory)
  let witnessed: boolean
  try {
    witnessed = receipts?.hasVerifiedCompletedComputerRestore() ?? false
  } finally {
    receipts?.close()
  }
  if (!witnessed) {
    if (hasRecoveryWithoutReceipt(directory)) throw invalid()
    return
  }
  guard()
  if (!identity) {
    const fd = openSync(path, "wx", 0o600)
    try {
      const info = fstatSync(fd, { bigint: true })
      identity = { dev: info.dev, ino: info.ino }
    } finally {
      closeSync(fd)
    }
    // SQLite's FULL transaction sync does not publish a newly created name.
    // Match the original POSIX directory-flush convention before startup opens.
    if (process.platform !== "win32") {
      guard()
      const parent = openSync(directory, "r")
      try {
        fsyncSync(parent)
      } finally {
        closeSync(parent)
      }
    }
  }
  const databaseIdentity = identity
  const assertDatabase = () => {
    guard()
    const current = stamp(path)
    if (!current || current.dev !== databaseIdentity.dev || current.ino !== databaseIdentity.ino)
      throw invalid()
  }
  assertDatabase()
  const db = new DatabaseSync(path)
  try {
    db.exec("PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA threads=1")
    if (
      db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
      !db.prepare("PRAGMA foreign_key_check").iterate().next().done
    )
      throw invalid()
    const established = table(db, "bot_schema")
    if (
      !established &&
      db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get()
    )
      throw invalid()
    const version = established
      ? Number(db.prepare("SELECT version FROM bot_schema").get()?.version)
      : 0
    assertDatabase()
    // The original live-path migration preserves its upgrade VACUUM snapshot.
    initializeBotDatabase(db, path)
    assertDatabase()
    // A current-schema DB also needs its pre-fence state retained. A newly
    // initialized, genuinely empty control schema has no user state to copy.
    if (version === BOT_SCHEMA_VERSION && hasDomainData(db)) {
      backupBeforeUpgrade(db, path, version)
      assertDatabase()
    }
  } finally {
    db.close()
  }
  const deletions = new BotDeletionLedger(path)
  try {
    assertDatabase()
    fenceBotCheckpointDatabase(
      path,
      randomUUID(),
      deletions,
      { event: "workspace.restored", reason: LEGACY_COMPUTER_GENERATION_REASON },
      assertDatabase
    )
  } finally {
    deletions.close()
  }
}
