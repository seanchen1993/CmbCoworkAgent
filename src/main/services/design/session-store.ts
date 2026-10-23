import type { NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
import type {
  DesignSessionSnapshot,
  DesignRunRequest,
  Message
} from "../../../shared/managed-design-session"

/** Separate from model checkpoints: this is the durable, user-visible transcript. */
export class DesignSessionStore {
  constructor(private readonly db: NativeSqliteAdapter) {
    db.run(`
      CREATE TABLE IF NOT EXISTS design_sessions (
        id TEXT PRIMARY KEY, seq INTEGER NOT NULL, meta TEXT NOT NULL,
        state TEXT NOT NULL, workspace_path TEXT, active_run_id TEXT,
        last_seen_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS design_messages (
        session_id TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(session_id, id)
      );
      CREATE INDEX IF NOT EXISTS design_messages_order ON design_messages(session_id, ordinal);
      CREATE TABLE IF NOT EXISTS design_runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL, request TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS design_session_events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS design_session_tombstones (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS design_draft_previews (
        session_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, revision INTEGER NOT NULL, html TEXT NOT NULL
      );
    `)
  }

  private rows(sql: string, values: unknown[] = []): Record<string, unknown>[] {
    const statement = this.db.prepare(sql)
    try {
      statement.bind(values)
      const result: Record<string, unknown>[] = []
      while (statement.step()) result.push(statement.getAsObject())
      return result
    } finally {
      statement.free()
    }
  }

  list(): DesignSessionSnapshot[] {
    return this.rows(
      "SELECT * FROM design_sessions ORDER BY json_extract(meta, '$.updatedAt') DESC"
    ).map((row) => this.decode(row))
  }

  get(id: string): DesignSessionSnapshot | null {
    const row = this.rows("SELECT * FROM design_sessions WHERE id = ?", [id])[0]
    return row ? this.decode(row) : null
  }

  wasDeleted(id: string): boolean {
    return this.rows("SELECT id FROM design_session_tombstones WHERE id = ?", [id]).length > 0
  }

  private decode(row: Record<string, unknown>): DesignSessionSnapshot {
    const messages = this.rows(
      "SELECT payload FROM design_messages WHERE session_id = ? ORDER BY ordinal",
      [row.id]
    ).map((message) => JSON.parse(String(message.payload)) as Message)
    const state = { ...JSON.parse(String(row.state)), messages }
    if (state.draftPreview) {
      const draft = this.rows(
        "SELECT html FROM design_draft_previews WHERE session_id = ? AND run_id = ?",
        [row.id, state.draftPreview.runId]
      )[0]
      if (draft) state.draftPreview.html = String(draft.html)
    }
    return {
      id: String(row.id),
      seq: Number(row.seq),
      meta: JSON.parse(String(row.meta)),
      state,
      workspacePath: row.workspace_path == null ? null : String(row.workspace_path),
      activeRunId: row.active_run_id == null ? null : String(row.active_run_id),
      lastSeenSeq: Number(row.last_seen_seq)
    }
  }

  /** Message projection, journal cursor and run status advance in one transaction. */
  save(
    snapshot: DesignSessionSnapshot,
    events: unknown[],
    request?: DesignRunRequest,
    completedRun?: { id: string; status: string }
  ): void {
    const { messages, ...state } = snapshot.state
    this.db.run("BEGIN IMMEDIATE")
    try {
      const draft = state.draftPreview
      if (draft)
        this.db.run(
          `INSERT INTO design_draft_previews VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET run_id=excluded.run_id, revision=excluded.revision, html=excluded.html
         WHERE run_id != excluded.run_id OR revision != excluded.revision`,
          [snapshot.id, draft.runId, draft.revision, draft.html]
        )
      else this.db.run("DELETE FROM design_draft_previews WHERE session_id = ?", [snapshot.id])
      this.db.run(
        `INSERT INTO design_sessions VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET seq=excluded.seq, meta=excluded.meta,
        state=excluded.state, workspace_path=excluded.workspace_path,
        active_run_id=excluded.active_run_id, last_seen_seq=excluded.last_seen_seq`,
        [
          snapshot.id,
          snapshot.seq,
          JSON.stringify(snapshot.meta),
          JSON.stringify(draft ? { ...state, draftPreview: { ...draft, html: "" } } : state),
          snapshot.workspacePath,
          snapshot.activeRunId,
          snapshot.lastSeenSeq
        ]
      )
      messages.forEach((message, ordinal) => {
        this.db.run(
          "DELETE FROM design_messages WHERE session_id = ? AND ordinal = ? AND id != ?",
          [snapshot.id, ordinal, message.id]
        )
        this.db.run(
          `INSERT INTO design_messages VALUES (?, ?, ?, ?)
          ON CONFLICT(session_id, id) DO UPDATE SET ordinal=excluded.ordinal, payload=excluded.payload
          WHERE payload != excluded.payload OR ordinal != excluded.ordinal`,
          [snapshot.id, message.id, ordinal, JSON.stringify(message)]
        )
      })
      // The ordinal boundary also handles explicit retry removing the last error bubble.
      this.db.run("DELETE FROM design_messages WHERE session_id = ? AND ordinal >= ?", [
        snapshot.id,
        messages.length
      ])
      if (events.length)
        this.db.run("INSERT INTO design_session_events VALUES (?, ?, ?)", [
          snapshot.id,
          snapshot.seq,
          JSON.stringify(
            events.map((event) => {
              if ((event as { type?: string }).type !== "preview") return event
              const preview = (event as { preview: { html?: string } }).preview
              return { ...(event as object), preview: { ...preview, html: undefined } }
            })
          )
        ])
      if (request && snapshot.activeRunId) {
        this.db.run("INSERT INTO design_runs VALUES (?, ?, ?, ?, ?)", [
          snapshot.activeRunId,
          snapshot.id,
          request.requestId,
          snapshot.state.generationState,
          JSON.stringify(request)
        ])
      }
      if (completedRun)
        this.db.run("UPDATE design_runs SET status = ? WHERE id = ?", [
          completedRun.status,
          completedRun.id
        ])
      this.db.run("COMMIT")
    } catch (error) {
      this.db.run("ROLLBACK")
      throw error
    }
  }

  latestRequest(id: string): DesignRunRequest | null {
    const row = this.rows(
      "SELECT request FROM design_runs WHERE session_id = ? ORDER BY rowid DESC LIMIT 1",
      [id]
    )[0]
    return row ? JSON.parse(String(row.request)) : null
  }

  findRequest(requestId: string): { sessionId: string; runId: string } | null {
    const row = this.rows("SELECT id, session_id FROM design_runs WHERE request_id = ?", [
      requestId
    ])[0]
    return row ? { sessionId: String(row.session_id), runId: String(row.id) } : null
  }

  remove(id: string): void {
    this.db.run("BEGIN IMMEDIATE")
    try {
      for (const table of [
        "design_messages",
        "design_runs",
        "design_session_events",
        "design_draft_previews"
      ]) {
        this.db.run(`DELETE FROM ${table} WHERE session_id = ?`, [id])
      }
      this.db.run("DELETE FROM design_sessions WHERE id = ?", [id])
      this.db.run("INSERT OR IGNORE INTO design_session_tombstones VALUES (?)", [id])
      this.db.run("COMMIT")
    } catch (error) {
      this.db.run("ROLLBACK")
      throw error
    }
  }
}
