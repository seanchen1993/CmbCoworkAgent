import { closeSync, fsyncSync, lstatSync, openSync, realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { BotDomainError } from "../../shared/bot-types"

const kinds = [
  "bot",
  "artifact",
  "memory",
  "shared-memory",
  "memory-hash",
  "teach",
  "routine",
  "shared-skill",
  "private-skill"
] as const
type Kind = (typeof kinds)[number]
type Deletion = { kind: Kind; key: string; owner: string }
const rowsSchema = `(
 kind TEXT NOT NULL CHECK(kind IN (${kinds.map((kind) => `'${kind}'`).join(",")})),
 key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 256),
 owner TEXT NOT NULL DEFAULT '' CHECK(length(owner)<=256), PRIMARY KEY(kind,key,owner)
) WITHOUT ROWID`
export const BOT_DELETION_OUTBOX_SCHEMA = `CREATE TABLE IF NOT EXISTS bot_deletion_outbox ${rowsSchema};`
const unavailable = () =>
  new BotDomainError(
    "deletion_ledger_unavailable",
    "删除记录暂时无法保存或读取，请检查本机存储后重试。"
  )

const softDeletes = [
  ["bot", "bots", "id", "deleted_at IS NOT NULL"],
  ["artifact", "bot_artifact_lifecycle", "artifact_id", "deleted_at IS NOT NULL"],
  ["memory", "bot_memories", "id", "deleted_at IS NOT NULL"],
  ["shared-memory", "bot_shared_memories", "id", "deleted_at IS NOT NULL"],
  ["teach", "bot_teach_sessions", "id", "phase='discarded'"]
] as const
const hardDeletes = [
  ["routine", "bot_routines"],
  ["shared-skill", "bot_skill_library"]
] as const

/** TEMP triggers belong to this writer, not sealed backups or old schema migrations.
 * The outbox commits atomically with domain changes, including toolOnce mutations. */
export function installBotDeletionTriggers(db: DatabaseSync): void {
  for (const [kind, table, key, condition] of softDeletes)
    for (const op of ["INSERT", "UPDATE"])
      db.exec(`CREATE TEMP TRIGGER bot_delete_${table}_${op} AFTER ${op} ON main.${table}
        WHEN NEW.${condition} BEGIN INSERT OR IGNORE INTO bot_deletion_outbox(kind,key)
        VALUES('${kind}',NEW.${key}); END;`)
  for (const [kind, table] of hardDeletes)
    db.exec(`CREATE TEMP TRIGGER bot_delete_${table} AFTER DELETE ON main.${table}
      BEGIN INSERT OR IGNORE INTO bot_deletion_outbox(kind,key) VALUES('${kind}',OLD.id); END;`)
  db.exec(`CREATE TEMP TRIGGER bot_delete_memory_hash AFTER INSERT ON main.bot_memory_tombstones
    BEGIN INSERT OR IGNORE INTO bot_deletion_outbox(kind,key,owner)
    VALUES('memory-hash',NEW.content_hash,NEW.bot_id); END;`)
  db.exec(`CREATE TEMP TRIGGER bot_delete_private_skill AFTER INSERT ON main.bot_skill_tombstones
    BEGIN INSERT OR IGNORE INTO bot_deletion_outbox(kind,key,owner)
    VALUES('private-skill',NEW.skill_id,NEW.bot_id); END;`)
}

/** Monotonic metadata outside the set replaced by restore. No message text, file
 * contents, credentials or executable authority belongs here. A failed flush is
 * never acknowledged as success; the committed main-DB outbox retries on reopen.
 * The exclusive Host/maintenance lock owns both connections. */
export class BotDeletionLedger {
  private readonly db: DatabaseSync
  private readonly path?: string
  private readonly identity?: { dev: bigint; ino: bigint }
  private closed = false

  constructor(databasePath: string) {
    let db: DatabaseSync | undefined
    try {
      if (databasePath !== ":memory:") {
        this.path = join(realpathSync(dirname(databasePath)), `${basename(databasePath)}.deletions`)
        try {
          const fd = openSync(this.path, "wx", 0o600)
          closeSync(fd)
          if (process.platform !== "win32") {
            const parent = openSync(dirname(this.path), "r")
            try {
              fsyncSync(parent)
            } finally {
              closeSync(parent)
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
        const info = lstatSync(this.path, { bigint: true })
        if (!info.isFile() || info.nlink !== 1n) throw unavailable()
        this.identity = info
        // SQLite may open its rollback journal itself; refuse foreign links first.
        for (const suffix of ["-journal", "-wal", "-shm"]) {
          try {
            const sidecar = lstatSync(`${this.path}${suffix}`)
            if (!sidecar.isFile() || sidecar.nlink !== 1) throw unavailable()
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }
        }
      }
      db = new DatabaseSync(this.path ?? ":memory:")
      db.exec("PRAGMA busy_timeout=5000")
      const version = db.prepare("PRAGMA user_version").get()?.user_version
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      if (
        (version !== 0 && version !== 1 && version !== 2) ||
        (version === 0 && tables.length !== 0) ||
        (version !== 0 && (tables.length !== 1 || tables[0].name !== "deletions")) ||
        db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok"
      )
        throw unavailable()
      // Bound monotonic metadata to 64 MiB. Capacity errors preserve the outbox.
      const pages = Math.floor(
        (64 * 1024 ** 2) / Number(db.prepare("PRAGMA page_size").get()?.page_size)
      )
      db.exec(
        `PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=${pages};`
      )
      if (version === 0)
        db.exec(
          `BEGIN IMMEDIATE; CREATE TABLE deletions ${rowsSchema}; PRAGMA user_version=2; COMMIT;`
        )
      if (version === 1) {
        db.exec("BEGIN IMMEDIATE")
        try {
          db.exec(`ALTER TABLE deletions RENAME TO deletions_v1;
            CREATE TABLE deletions ${rowsSchema};
            INSERT INTO deletions SELECT * FROM deletions_v1;
            DROP TABLE deletions_v1; PRAGMA user_version=2; COMMIT;`)
        } catch (error) {
          db.exec("ROLLBACK")
          throw error
        }
      }
      this.db = db
      this.assertIdentity()
    } catch {
      db?.close()
      throw unavailable()
    }
  }

  private assertIdentity(): void {
    if (this.closed) throw unavailable()
    if (!this.path) return
    const info = lstatSync(this.path, { bigint: true })
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      info.dev !== this.identity!.dev ||
      info.ino !== this.identity!.ino
    )
      throw unavailable()
  }

  private save(rows: Iterable<Deletion>): void {
    this.assertIdentity()
    const insert = this.db.prepare("INSERT OR IGNORE INTO deletions(kind,key,owner) VALUES(?,?,?)")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      for (const row of rows) insert.run(row.kind, row.key, row.owner)
      this.assertIdentity()
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  /** Upgrade/bootstrap and offline restore also collect existing tombstones.
   * Legacy snapshots may predate some tables; they are never modified here. */
  collect(source: DatabaseSync): void {
    const tables = new Set(
      source
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name)
    )
    const queries = softDeletes
      .filter(([, table]) => tables.has(table))
      .map(
        ([kind, table, key, condition]) =>
          `SELECT '${kind}' kind,${key} key,'' owner FROM ${table} WHERE ${condition}`
      )
    if (tables.has("bot_memory_tombstones"))
      queries.push(
        "SELECT 'memory-hash' kind,content_hash key,bot_id owner FROM bot_memory_tombstones"
      )
    if (tables.has("bot_skill_tombstones"))
      queries.push(
        "SELECT 'private-skill' kind,skill_id key,bot_id owner FROM bot_skill_tombstones"
      )
    // Earlier versions retained hard-delete identities in their append-only audit log.
    if (tables.has("bot_events"))
      queries.push(
        "SELECT CASE kind WHEN 'routine.deleted' THEN 'routine' ELSE 'shared-skill' END kind,entity_id key,'' owner FROM bot_events WHERE kind IN ('routine.deleted','skill.withdrawn')"
      )
    if (tables.has("bot_deletion_outbox"))
      queries.push("SELECT kind,key,owner FROM bot_deletion_outbox")
    if (queries.length)
      this.save(source.prepare(queries.join(" UNION ALL ")).iterate() as Iterable<Deletion>)
  }

  /** Called after COMMIT and before replying. Metadata reaches its own FULL-sync
   * transaction before outbox acknowledgement; either crash window is retryable. */
  flush(source: DatabaseSync): void {
    const read = source.prepare("SELECT kind,key,owner FROM bot_deletion_outbox LIMIT 256")
    const remove = source.prepare(
      "DELETE FROM bot_deletion_outbox WHERE kind=? AND key=? AND owner=?"
    )
    for (;;) {
      const rows = read.all() as Deletion[]
      if (!rows.length) return
      this.save(rows)
      source.exec("BEGIN IMMEDIATE")
      try {
        for (const row of rows) remove.run(row.kind, row.key, row.owner)
        source.exec("COMMIT")
      } catch (error) {
        source.exec("ROLLBACK")
        throw error
      }
    }
  }

  /** The caller owns the verified staging DB transaction. Never run this against
   * a live Host: cancelled tasks and memory barriers are applied by restore. */
  apply(target: DatabaseSync): void {
    this.assertIdentity()
    const statements = {
      bot: target.prepare(
        "UPDATE bots SET deleted_at=COALESCE(deleted_at,?),updated_at=?,revision=revision+1 WHERE id=? AND deleted_at IS NULL"
      ),
      memory: target.prepare(
        "UPDATE bot_memories SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=? AND deleted_at IS NULL"
      ),
      "shared-memory": target.prepare(
        "UPDATE bot_shared_memories SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=? AND deleted_at IS NULL"
      ),
      artifact: target.prepare(`INSERT INTO bot_artifact_lifecycle(artifact_id,deleted_at,purged_at)
        SELECT id,?,NULL FROM bot_artifacts WHERE id=?
        ON CONFLICT(artifact_id) DO UPDATE SET deleted_at=COALESCE(bot_artifact_lifecycle.deleted_at,excluded.deleted_at),purged_at=NULL`),
      "memory-hash": target.prepare(
        "INSERT OR IGNORE INTO bot_memory_tombstones(bot_id,content_hash) SELECT id,? FROM bots WHERE id=?"
      ),
      teach: target.prepare(
        "UPDATE bot_teach_sessions SET phase='discarded',revision=revision+1,video=NULL,bytes=0,frame_count=0,event_count=0,error=NULL WHERE id=? AND phase<>'discarded'"
      ),
      routine: target.prepare("DELETE FROM bot_routines WHERE id=?"),
      "shared-skill": target.prepare("DELETE FROM bot_skill_library WHERE id=?"),
      "private-skill":
        target.prepare(`INSERT INTO bot_skill_tombstones(skill_id,bot_id,version,deleted_at)
        SELECT id,bot_id,MAX(version),? FROM bot_skills WHERE id=? AND bot_id=? GROUP BY id,bot_id
        ON CONFLICT(skill_id) DO NOTHING`)
    }
    const now = Date.now()
    for (const row of this.db
      .prepare("SELECT kind,key,owner FROM deletions")
      .iterate() as Iterable<Deletion>) {
      if (row.kind === "bot" || row.kind === "memory" || row.kind === "shared-memory")
        statements[row.kind].run(now, now, row.key)
      else if (row.kind === "artifact") statements.artifact.run(now, row.key)
      else if (row.kind === "memory-hash") statements["memory-hash"].run(row.key, row.owner)
      else if (row.kind === "private-skill")
        statements["private-skill"].run(now, row.key, row.owner)
      else statements[row.kind].run(row.key)
    }
    // Restore retains the old reference for audit, but never re-enables its schedule.
    target.exec(`UPDATE bot_routines SET enabled=0,next_at=NULL,activation_required=1,revision=revision+1
      WHERE (enabled<>0 OR next_at IS NOT NULL OR activation_required<>1) AND EXISTS(
        SELECT 1 FROM bot_routine_skills s,json_each(s.refs) ref JOIN bot_skill_tombstones t
          ON t.skill_id=json_extract(ref.value,'$.id') AND t.bot_id=json_extract(ref.value,'$.botId')
        WHERE s.routine_id=bot_routines.id)`)
    for (const table of ["bot_teach_frames", "bot_teach_events", "bot_teach_reads"])
      target.exec(
        `DELETE FROM ${table} WHERE session_id IN (SELECT id FROM bot_teach_sessions WHERE phase='discarded')`
      )
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
