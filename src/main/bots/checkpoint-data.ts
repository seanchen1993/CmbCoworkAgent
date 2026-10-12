import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { BotDeletionLedger } from "./deletion-ledger"
import { pruneDeletedBotGroupMembers } from "./group-membership"
import { initializeBotDatabase } from "./migrations"
import { BOT_SCHEMA_VERSION } from "./schema"
import { computerDataEntry, type ComputerDataManifest } from "./computer-checkpoint-manifest"
const size = z
  .number()
  .int()
  .nonnegative()
  .max(20 * 1024 ** 3)
const hash = z.string().regex(/^[a-f0-9]{64}$/)

/** Extracted from backups.ts; the existing format-1 API imports these helpers
 * without changing its sealed format. Iterators bound enumeration memory. */
export function checkedBotCheckpointDatabase(
  path: string,
  writable = false,
  expectedVersion?: number
): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: !writable })
  try {
    db.exec("PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA threads=1")
    const versions = db.prepare("SELECT version FROM bot_schema LIMIT 2").all()
    if (
      versions.length !== 1 ||
      !Number.isInteger(versions[0].version) ||
      Number(versions[0].version) < 14 ||
      Number(versions[0].version) > BOT_SCHEMA_VERSION ||
      (expectedVersion !== undefined && versions[0].version !== expectedVersion)
    )
      throw new Error("备份的数据版本与当前版本不兼容")
    if (
      db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
      !db.prepare("PRAGMA foreign_key_check").iterate().next().done
    )
      throw new Error("Bot 数据库完整性检查失败")
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/** Enumerate only durable references; deleted files, staging, credentials and browser profiles
 * are intentionally outside this data snapshot. Projects retain paths, not project file copies. */
export function referencedBotCheckpointFiles(
  db: DatabaseSync
): ComputerDataManifest["entries"][number][] {
  const entries = new Map<string, ComputerDataManifest["entries"][number]>()
  let bytes = 0
  const add = (value: ComputerDataManifest["entries"][number]) => {
    const file = computerDataEntry.parse(value),
      previous = entries.get(file.path)
    if (previous && (previous.size !== file.size || previous.sha256 !== file.sha256))
      throw new Error("文件引用校验信息不一致")
    if (!previous) {
      if (entries.size >= 49_999 || bytes + file.size > 20 * 1024 ** 3)
        throw new Error("备份超过引用条目或容量上限")
      bytes += file.size
    }
    entries.set(file.path, file)
  }
  for (const row of db
    .prepare(
      `SELECT a.sha256,a.size FROM bot_artifacts a
    LEFT JOIN bot_artifact_lifecycle l ON l.artifact_id=a.id WHERE l.deleted_at IS NULL`
    )
    .iterate())
    add({ path: `objects/${row.sha256}`, size: Number(row.size), sha256: String(row.sha256) })
  for (const row of db
    .prepare(
      `SELECT f.* FROM bot_teach_frames f JOIN bot_teach_sessions s
    ON s.id=f.session_id WHERE s.phase<>'discarded'`
    )
    .iterate())
    add({
      path: `teach/${row.session_id}/${row.idx}.jpg`,
      size: Number(row.size),
      sha256: String(row.sha256)
    })
  for (const row of db
    .prepare(
      "SELECT id,CASE WHEN length(CAST(video AS BLOB))<=4096 THEN video ELSE NULL END AS video FROM bot_teach_sessions WHERE phase<>'discarded' AND video IS NOT NULL"
    )
    .iterate()) {
    const video = z.object({ size, sha256: hash }).parse(JSON.parse(String(row.video)))
    add({ path: `teach/${row.id}/video.webm`, ...video })
  }
  if (
    entries.size > 49_999 ||
    [...entries.values()].reduce((sum, item) => sum + item.size, 0) > 20 * 1024 ** 3
  )
    throw new Error("备份超过 50,000 个文件或 20 GiB 上限，请先清理不再需要的资料")
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))
}
export function fenceBotCheckpointDatabase(
  path: string,
  epoch: string,
  deletions: BotDeletionLedger,
  options?: { reason: string; event: "computer.restored" | "workspace.restored" },
  guard: () => void = () => {}
): void {
  const db = checkedBotCheckpointDatabase(path, true)
  const reason =
    options?.reason ??
    "已恢复备份，原未完成任务已停止。备份之后的外部操作可能已经发生，请核对后重新交办。"
  try {
    // Migrate only the verified staging copy; the original sealed backup stays unchanged.
    initializeBotDatabase(db, ":memory:")
    guard()
    deletions.collect(db)
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE")
    guard()
    deletions.apply(db)
    pruneDeletedBotGroupMembers(db)
    db.prepare(
      `UPDATE bot_runs SET status='cancelled',lease_owner=NULL,lease_until=NULL,fence=fence+1,
      revision=revision+1,error=?,updated_at=? WHERE status NOT IN ('succeeded','failed','cancelled')`
    ).run(reason, Date.now())
    // Startup exposes interrupted service origins through the ordinary review
    // flow, one per Bot; completed turns may have several outstanding services.
    db.exec(`UPDATE bot_effects SET status='unknown' WHERE status='started';
      UPDATE bot_shell_services SET lease_until=0;
      UPDATE bot_shell_jobs SET status='needs_review',revision=revision+1 WHERE status IN ('queued','running','cancelling');
      UPDATE bot_interactions SET status='expired',revision=revision+1 WHERE status='pending';
      UPDATE bot_hook_notifications SET status='interrupted' WHERE status IN ('running','waiting_input');
      UPDATE bot_routines SET enabled=0,next_at=NULL,activation_required=1,revision=revision+1;
      UPDATE bot_webhooks SET enabled=0,key_hash=NULL,revision=revision+1;
      UPDATE bot_memory_evidence SET state='skipped' WHERE state='pending';
      UPDATE bot_memory_state SET epoch=epoch+1,last_outcome='restored',
        barrier_sequence=(SELECT COALESCE(MAX(sequence),0) FROM bot_messages);
      UPDATE bot_group_cycles SET status='cancelled',current_run_id=NULL WHERE status='active';
      DELETE FROM bot_peer_waits; DELETE FROM bot_run_drains; DELETE FROM bot_browser_sessions;`)
    db.exec(`UPDATE bot_local_tool_policy SET revision=revision+1,record=json_set(record,'$.choice','ask') WHERE json_extract(record,'$.choice')='always';
      UPDATE bot_local_tool_requests SET record=json_set(record,'$.status','retired');
      UPDATE bot_approval_rules SET behavior='ask' WHERE behavior='allow';
      UPDATE bot_approval_policy SET revision=revision+1;`)
    db.exec(
      `UPDATE bot_auto_review_settings SET revision=revision+1,policy=json_set(policy,'$.isEnabled',json('false'));`
    )
    db.exec(`UPDATE bot_primary SET bot_id=NULL,revision=revision+1
      WHERE bot_id IN (SELECT id FROM bots WHERE deleted_at IS NOT NULL);
      UPDATE bot_primary_checkin SET revision=revision+1,
        configuration=json_set(configuration,'$.enabled',json('false')),fingerprint=NULL;`)
    db.exec(`UPDATE bot_backup_schedule SET state=json_set(state,
      '$.enabled',json('false'),'$.revision',json_extract(state,'$.revision')+1,
      '$.pendingId',NULL,'$.nextAt',NULL,'$.retryAt',NULL,'$.error',NULL);`)
    db.prepare(
      `UPDATE bot_teach_sessions SET phase=CASE WHEN phase IN ('queued','learning') THEN 'failed' ELSE 'interrupted' END,revision=revision+1,error=?
      WHERE phase IN ('recording','paused','finalizing','queued','learning')`
    ).run(reason)
    // All restored databases share the existing mutation-generation barrier.
    // The computer-specific audit is additional context, never a substitute.
    const restoreEvent = db.prepare(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES(?,?,?,?)"
    )
    const payload = JSON.stringify({ message: reason }),
      restoredAt = Date.now()
    restoreEvent.run("workspace.restored", epoch, payload, restoredAt)
    if (options?.event === "computer.restored")
      restoreEvent.run("computer.restored", epoch, payload, restoredAt)
    guard()
    db.exec("COMMIT")
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK")
    throw error
  } finally {
    db.close()
  }
}
