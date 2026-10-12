import { parentPort, workerData } from "node:worker_threads"
import { closeSync, fstatSync, lstatSync, openSync, realpathSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { initializeBotDatabase } from "./migrations"
import { join, resolve } from "node:path"
import { BotHostLock } from "./host-lock"
import { botWorktreeRecord } from "./worktree-contract"
import { computerBrowserManifest } from "./computer-checkpoint-manifest"
import { BotDeletionLedger } from "./deletion-ledger"
import {
  checkedBotCheckpointDatabase,
  fenceBotCheckpointDatabase,
  referencedBotCheckpointFiles
} from "./checkpoint-data"
import {
  computerNativeRequest,
  computerNativeResult,
  computerNativeBindingsResult
} from "./computer-checkpoint-native-contract"
if (!parentPort) throw new Error("Native checkpoint requires an owning coordinator thread")
try {
  const input = computerNativeRequest.parse(workerData),
    owner = BotHostLock.observe(input.directory)
  const guard = () => {
    owner.assertCurrent()
    const current = owner.recoveryOwnershipIdentity()
    if (JSON.stringify(current) !== JSON.stringify(input.owner)) throw new Error("电脑恢复锁已丢失")
  }
  const check = (path: string) => {
    const info = lstatSync(path, { bigint: true })
    if (!info.isFile() || info.nlink !== 1n || realpathSync(path) !== resolve(path))
      throw new Error("电脑数据库位置无效")
    return info
  }
  guard()
  let path: string
  if (input.action === "capture") {
    path = join(
      input.directory,
      "computer-recovery",
      "points",
      `.pending-${input.nonce}`,
      "data",
      "bots.sqlite"
    )
    const source = join(input.directory, "bots.sqlite")
    check(source)
    const db = checkedBotCheckpointDatabase(source)
    try {
      const estimate =
        Number(db.prepare("PRAGMA page_count").get()?.page_count) *
        Number(db.prepare("PRAGMA page_size").get()?.page_size)
      if (!Number.isSafeInteger(estimate) || estimate > input.maxBytes)
        throw new Error("数据库超过电脑恢复点剩余空间预算")
      guard()
      db.prepare("VACUUM INTO ?").run(path)
    } finally {
      db.close()
    }
  } else if (input.action === "fence") {
    path = join(
      input.directory,
      "computer-recovery",
      `.restore-${input.stage}`,
      "next",
      "bots.sqlite"
    )
    if (input.empty) {
      // Only a verified absent source uses this trusted private action. Publish
      // the empty schema through the same prepared manifest/DB slot journal.
      guard()
      const fd = openSync(path, "wx", 0o600)
      let identity: ReturnType<typeof check>
      try {
        identity = fstatSync(fd, { bigint: true })
      } finally {
        closeSync(fd)
      }
      const assertEmpty = () => {
        guard()
        const current = check(path)
        if (current.dev !== identity.dev || current.ino !== identity.ino)
          throw new Error("电脑空数据库位置已变化")
      }
      assertEmpty()
      const empty = new DatabaseSync(path)
      try {
        empty.exec(
          "PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA threads=1"
        )
        initializeBotDatabase(empty, path)
        empty.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL")
        assertEmpty()
      } finally {
        empty.close()
      }
    }
    check(path)
    const deletions = new BotDeletionLedger(join(input.directory, "bots.sqlite"))
    try {
      guard()
      fenceBotCheckpointDatabase(
        path,
        input.nonce,
        deletions,
        {
          event: "computer.restored",
          reason:
            "已恢复电脑恢复点。未完成任务与主动触发已停止，工作文件和浏览器已恢复，请核对既有外部操作后重新交办。"
        },
        guard
      )
    } finally {
      deletions.close()
    }
    const detached = checkedBotCheckpointDatabase(path, true)
    try {
      guard()
      detached.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; DELETE FROM bot_worktrees; DELETE FROM bot_worktree_sources; DELETE FROM bot_worktree_actions;"
      )
      guard()
      detached.exec("COMMIT")
    } catch (error) {
      if (detached.isTransaction) detached.exec("ROLLBACK")
      throw error
    } finally {
      detached.close()
    }
  } else path = join(input.directory, input.database)
  check(path)
  guard()
  const db = checkedBotCheckpointDatabase(path)
  try {
    let result: ReturnType<typeof computerNativeResult.parse>
    if (input.action === "bindings") {
      const pages: ReturnType<typeof computerBrowserManifest.parse>["pages"] = [],
        records: ReturnType<typeof botWorktreeRecord.parse>[] = []
      let bytes = 0
      for (const row of db
        .prepare(
          "SELECT CASE WHEN length(CAST(bot_id AS BLOB))=36 THEN bot_id ELSE NULL END AS bot_id,CASE WHEN length(CAST(manifest AS BLOB))<=65536 THEN manifest ELSE NULL END AS manifest FROM bot_browser_sessions ORDER BY bot_id LIMIT 2049"
        )
        .iterate()) {
        if (pages.length >= 2048 || row.manifest === null)
          throw new Error("浏览器工作页记录超过恢复点容量")
        bytes += Buffer.byteLength(String(row.manifest))
        if (bytes > 8 * 1024 ** 2) throw new Error("浏览器与代码工作区元数据超过 8 MiB")
        const saved = JSON.parse(String(row.manifest)) as { urls: string[]; active: number }
        pages.push({ botId: String(row.bot_id), urls: saved.urls, active: saved.active })
      }
      for (const row of db
        .prepare(
          "SELECT CASE WHEN length(CAST(record AS BLOB))<=65536 THEN record ELSE NULL END AS record FROM bot_worktrees WHERE CASE WHEN length(CAST(record AS BLOB))>65536 THEN 1 ELSE json_extract(record,'$.status') NOT IN ('merged','discarded') END LIMIT 2049"
        )
        .iterate()) {
        if (records.length >= 2048 || row.record === null)
          throw new Error("代码工作区记录超过恢复点容量")
        bytes += Buffer.byteLength(String(row.record))
        if (bytes > 8 * 1024 ** 2) throw new Error("浏览器与代码工作区元数据超过 8 MiB")
        records.push(botWorktreeRecord.parse(JSON.parse(String(row.record))))
      }
      result = computerNativeBindingsResult.parse({ kind: "bindings", pages, records })
    } else
      result = computerNativeResult.parse({
        kind: "data",
        schemaVersion: Number(db.prepare("SELECT version FROM bot_schema").get()!.version),
        references: referencedBotCheckpointFiles(db)
      })
    guard()
    parentPort.postMessage({ result })
  } finally {
    db.close()
  }
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : "电脑数据库处理失败" })
} finally {
  parentPort.close()
}
