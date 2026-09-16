import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ModExecution, ModJson, ModIdentity } from "../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../shared/mods/validation"
import { ModError } from "./errors"

export interface ModGrant {
  workspace: string
  modId: string
  digest: string
  epoch: number
  enabled: boolean
}

export class ModControlStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path, { timeout: 1000 })
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS mods_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mods_grants (
        workspace TEXT NOT NULL, mod_id TEXT NOT NULL, digest TEXT NOT NULL,
        epoch INTEGER NOT NULL, enabled INTEGER NOT NULL,
        PRIMARY KEY(workspace, mod_id)
      );
      CREATE TABLE IF NOT EXISTS mods_calls (
        id TEXT PRIMARY KEY, args_hash TEXT NOT NULL, status TEXT NOT NULL,
        at INTEGER NOT NULL, finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS mods_state (
        namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(namespace, key)
      );
      CREATE TABLE IF NOT EXISTS mods_cards (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mods_cards_thread ON mods_cards(thread_id,at);
      CREATE TABLE IF NOT EXISTS mods_consumed_actions (id TEXT PRIMARY KEY);
    `)
    const version = this.getSetting("schema", "")
    if (version && version !== "1" && version !== "2") {
      this.db.close()
      throw new ModError("MODS_STORE_VERSION")
    }
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(mods_calls)")
        .all()
        .map((row) => row.name)
    )
    for (const column of ["tool_id", "scope", "final_args_hash"]) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE mods_calls ADD COLUMN ${column} TEXT`)
    }
    this.setSetting("schema", "2")
    // An interrupted operation may have reached an external service. Never replay it.
    this.db.prepare("UPDATE mods_calls SET status = 'unknown' WHERE status = 'running'").run()
  }

  getSetting(key: string, fallback = "false"): string {
    const row = this.db.prepare("SELECT value FROM mods_meta WHERE key = ?").get(key)
    return typeof row?.value === "string" ? row.value : fallback
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO mods_meta(key,value) VALUES(?,?)").run(key, value)
  }

  setSettings(values: Record<string, string>): void {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      for (const [key, value] of Object.entries(values)) this.setSetting(key, value)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  saveCard(id: string, threadId: string, payload: unknown): void {
    const text = encodeModJson(payload)
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare("INSERT INTO mods_cards VALUES(?,?,?,?)").run(id, threadId, text, Date.now())
      this.db
        .prepare(
          "DELETE FROM mods_cards WHERE thread_id=? AND id NOT IN (SELECT id FROM mods_cards WHERE thread_id=? ORDER BY at DESC,rowid DESC LIMIT 50)"
        )
        .run(threadId, threadId)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  cards(threadId: string): unknown[] {
    return this.db
      .prepare("SELECT payload FROM mods_cards WHERE thread_id=? ORDER BY at,rowid")
      .all(threadId)
      .map((row) => parseModJson(String(row.payload)))
  }

  hasCard(id: string, threadId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT id FROM mods_cards WHERE id=? AND thread_id=?").get(id, threadId)
    )
  }

  actionConsumed(id: string): boolean {
    return Boolean(this.db.prepare("SELECT id FROM mods_consumed_actions WHERE id=?").get(id))
  }

  consumeAction(id: string): void {
    if (!this.db.prepare("INSERT OR IGNORE INTO mods_consumed_actions VALUES(?)").run(id).changes) {
      throw new ModError("MODS_ACTION_ALREADY_USED")
    }
  }

  grant(workspace: string, modId: string, digest: string, enabled: boolean): ModGrant {
    this.db
      .prepare(
        `INSERT INTO mods_grants VALUES(?,?,?,1,?)
      ON CONFLICT(workspace,mod_id) DO UPDATE SET digest=excluded.digest,
      epoch=mods_grants.epoch+1, enabled=excluded.enabled`
      )
      .run(workspace, modId, digest, +enabled)
    return this.getGrant(workspace, modId)!
  }

  getGrant(workspace: string, modId: string): ModGrant | null {
    const row = this.db
      .prepare("SELECT * FROM mods_grants WHERE workspace=? AND mod_id=?")
      .get(workspace, modId)
    return row
      ? {
          workspace,
          modId,
          digest: String(row.digest),
          epoch: Number(row.epoch),
          enabled: row.enabled === 1
        }
      : null
  }

  assertGrant(expected: ModGrant): void {
    const actual = this.getGrant(expected.workspace, expected.modId)
    if (!actual?.enabled || actual.digest !== expected.digest || actual.epoch !== expected.epoch) {
      throw new ModError("MODS_GRANT_REVOKED")
    }
  }

  claim(id: string, toolId: string, args: unknown, identity?: ModIdentity): void {
    const hash = createHash("sha256").update(toolId).update(encodeModJson(args)).digest("hex")
    const inserted = this.db
      .prepare(
        "INSERT OR IGNORE INTO mods_calls(id,args_hash,status,at,tool_id,scope) VALUES(?,?,'running',?,?,?)"
      )
      .run(id, hash, Date.now(), toolId, identity ? encodeModJson(identity) : null)
    if (!inserted.changes) {
      const row = this.db.prepare("SELECT args_hash FROM mods_calls WHERE id=?").get(id)
      throw new ModError(
        row?.args_hash === hash ? "MODS_CALL_ALREADY_STARTED" : "MODS_CALL_ID_COLLISION"
      )
    }
  }

  bindFinalInput(id: string, toolId: string, args: unknown): void {
    const row = this.db
      .prepare("SELECT status,tool_id,final_args_hash FROM mods_calls WHERE id=?")
      .get(id)
    if (!row || row.status !== "running" || row.tool_id !== toolId)
      throw new ModError("MODS_FINAL_INPUT_SCOPE")
    const hash = createHash("sha256").update(toolId).update(encodeModJson(args)).digest("hex")
    if (row.final_args_hash === hash) return
    this.db.prepare("UPDATE mods_calls SET final_args_hash=? WHERE id=?").run(hash, id)
  }

  settle(id: string, status: ModExecution): void {
    this.db
      .prepare("UPDATE mods_calls SET status=?,finished_at=? WHERE id=? AND status='running'")
      .run(status, Date.now(), id)
  }

  status(id: string): string | undefined {
    const row = this.db.prepare("SELECT status FROM mods_calls WHERE id=?").get(id)
    return typeof row?.status === "string" ? row.status : undefined
  }

  read(namespace: string, key: string): ModJson {
    this.checkKey(key)
    const row = this.db
      .prepare("SELECT value FROM mods_state WHERE namespace=? AND key=?")
      .get(namespace, key)
    return row ? (parseModJson(String(row.value)) as ModJson) : null
  }

  write(namespace: string, key: string, value: ModJson): void {
    this.checkKey(key)
    const text = encodeModJson(value)
    if (Buffer.byteLength(text) > 64 * 1024) throw new ModError("MODS_STORE_VALUE_LIMIT")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare("INSERT OR REPLACE INTO mods_state VALUES(?,?,?)").run(namespace, key, text)
      const row = this.db
        .prepare(
          "SELECT SUM(length(CAST(value AS BLOB))) AS bytes, COUNT(*) AS count FROM mods_state WHERE namespace=?"
        )
        .get(namespace)
      if (Number(row?.bytes) > 1024 * 1024 || Number(row?.count) > 256) {
        throw new ModError("MODS_STORE_QUOTA")
      }
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  delete(namespace: string, key: string): void {
    this.checkKey(key)
    this.db.prepare("DELETE FROM mods_state WHERE namespace=? AND key=?").run(namespace, key)
  }

  close(): void {
    this.db.close()
  }

  private checkKey(key: string): void {
    if (typeof key !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(key)) {
      throw new ModError("MODS_STORE_KEY")
    }
  }
}
