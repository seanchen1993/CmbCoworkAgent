import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { FunctionPeerRecord, FunctionPeerStatus } from "../../../shared/mods/v2/peer"

/** Separate storage prevents peer traffic changing user turns, checkpoints or approval history. */
export class FunctionPeerLedger {
  private readonly db: DatabaseSync

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file, { timeout: 1000 })
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS peer_messages (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, session_id TEXT NOT NULL,
        run_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS peer_scope ON peer_messages(workspace, session_id, created_at);
    `)
    // A physical run cannot survive a main-process restart. Never replay its uncertain work.
    this.db
      .prepare(
        `UPDATE peer_messages SET status = 'interrupted', updated_at = ?
      WHERE status IN ('queued', 'processing')`
      )
      .run(Date.now())
  }

  insert(record: FunctionPeerRecord): void {
    this.db
      .prepare(`INSERT INTO peer_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id,
        record.workspace,
        record.sessionId,
        record.runId,
        record.status,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record)
      )
  }

  transition(ids: readonly string[], from: FunctionPeerStatus, to: FunctionPeerStatus): void {
    if (!ids.length) return
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const statement = this.db.prepare(
        "UPDATE peer_messages SET status = ?, updated_at = ? WHERE id = ? AND status = ?"
      )
      const now = Date.now()
      for (const id of ids) {
        if (statement.run(to, now, id, from).changes !== 1)
          throw new Error("MODS_PEER_RECEIPT_CONFLICT")
      }
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  list(workspace: string, sessionId: string): FunctionPeerRecord[] {
    const rows = this.db
      .prepare(
        `SELECT payload, status, updated_at FROM peer_messages
      WHERE workspace = ? AND session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100`
      )
      .all(workspace, sessionId) as {
      payload: string
      status: FunctionPeerStatus
      updated_at: number
    }[]
    return rows.reverse().map((row) => ({
      ...JSON.parse(row.payload),
      status: row.status,
      updatedAt: row.updated_at
    }))
  }

  close(): void {
    this.db.close()
  }
}
