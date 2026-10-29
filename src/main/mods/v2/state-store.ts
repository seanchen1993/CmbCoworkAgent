import type { DatabaseSync } from "node:sqlite"
import type { ModJson } from "../../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

export interface FunctionStateAccess {
  get(key: string, signal: AbortSignal): Promise<ModJson | undefined>
  set(key: string, value: ModJson, signal: AbortSignal): Promise<void>
  delete(key: string): void
  keys(signal: AbortSignal): Promise<string[]>
}

/** Uses the control database's transaction and backup boundary; never evaluates stored data. */
export class FunctionStateStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS mods_function_state (
      namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(namespace, key)
    )`)
  }

  private checkKey(key: string): void {
    if (
      typeof key !== "string" ||
      Buffer.byteLength(key) > 4096 ||
      Buffer.from(key, "utf8").toString("utf8") !== key
    )
      throw new ModFunctionError("MODS_STORE_KEY")
  }

  get(namespace: string, key: string): ModJson | undefined {
    this.checkKey(key)
    const row = this.db
      .prepare("SELECT value FROM mods_function_state WHERE namespace=? AND key=?")
      .get(namespace, key)
    return row ? (parseModJson(String(row.value)) as ModJson) : undefined
  }

  set(namespace: string, key: string, value: ModJson): void {
    this.checkKey(key)
    const text = encodeModJson(value)
    this.db.exec("BEGIN IMMEDIATE")
    try {
      // UPDATE keeps insertion order; INSERT OR REPLACE would allocate a new rowid.
      this.db
        .prepare(
          `INSERT INTO mods_function_state VALUES(?,?,?)
        ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value`
        )
        .run(namespace, key, text)
      // Measure inside SQLite instead of copying the entire store into JS on each small update.
      const quota = this.db
        .prepare(
          `SELECT COUNT(*) AS count,
        COALESCE(SUM(length(CAST(json_quote(key) AS BLOB)) + length(CAST(value AS BLOB)) + 1), 0) AS bytes
        FROM mods_function_state WHERE namespace=?`
        )
        .get(namespace)!
      const count = Number(quota.count)
      const bytes = 2 + Math.max(0, count - 1) + Number(quota.bytes)
      if (bytes > 4 * 1024 * 1024 || count > 8192) throw new ModFunctionError("MODS_STORE_QUOTA")
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  delete(namespace: string, key: string): void {
    this.checkKey(key)
    this.db
      .prepare("DELETE FROM mods_function_state WHERE namespace=? AND key=?")
      .run(namespace, key)
  }

  keys(namespace: string): string[] {
    return this.db
      .prepare("SELECT key FROM mods_function_state WHERE namespace=? ORDER BY rowid")
      .all(namespace)
      .map((row) => String(row.key))
  }
}
