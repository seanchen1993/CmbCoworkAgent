import { ensureThreadMessageFragmentStorage } from "../db/thread-message-fragment-storage"

export function installThreadSearchSchema(db: { run(sql: string): unknown },
  hasColumn: (table: string, column: string) => boolean): void {
  ensureThreadMessageFragmentStorage(db.run.bind(db), hasColumn)
  db.run(`CREATE TABLE IF NOT EXISTS thread_row_lifetimes (
    thread_id TEXT PRIMARY KEY, token TEXT NOT NULL
  )`)
  db.run(`CREATE TRIGGER IF NOT EXISTS thread_row_lifetime_insert AFTER INSERT ON threads
    BEGIN
      INSERT INTO thread_row_lifetimes VALUES (NEW.thread_id, hex(randomblob(16)))
        ON CONFLICT(thread_id) DO UPDATE SET token = excluded.token;
    END`)
  db.run(`CREATE TRIGGER IF NOT EXISTS thread_row_lifetime_delete AFTER DELETE ON threads
    BEGIN DELETE FROM thread_row_lifetimes WHERE thread_id = OLD.thread_id; END`)
  db.run(`
    CREATE TABLE IF NOT EXISTS thread_search_structure_versions (
      thread_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL
    )
  `)
  db.run(`CREATE TABLE IF NOT EXISTS thread_search_coverage (
    thread_id TEXT NOT NULL, incarnation TEXT NOT NULL, source TEXT NOT NULL,
    epoch INTEGER NOT NULL, status TEXT NOT NULL, checked_at INTEGER NOT NULL, occurrence_version INTEGER,
    PRIMARY KEY(thread_id, incarnation)
  )`)
  if (!hasColumn("thread_search_coverage", "occurrence_version"))
    db.run("ALTER TABLE thread_search_coverage ADD COLUMN occurrence_version INTEGER")
  db.run(`CREATE TABLE IF NOT EXISTS thread_search_message_versions (
    thread_id TEXT NOT NULL, message_id TEXT NOT NULL, version INTEGER NOT NULL,
    PRIMARY KEY(thread_id, message_id)
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS thread_search_occurrence_versions (
    thread_id TEXT PRIMARY KEY, version INTEGER NOT NULL
  )`)
  // A competing occurrence may appear or change its payload without changing
  // the target row's version or shifting a previously published ordinal.
  const bumpOccurrence = `INSERT INTO thread_search_occurrence_versions VALUES (NEW.thread_id, 1)
    ON CONFLICT(thread_id) DO UPDATE SET version = version + 1;`
  for (const [name, table, event] of [
    ["new_row", "thread_messages", "INSERT"],
    ["new_revision", "thread_search_message_versions", "INSERT"],
    ["changed_revision", "thread_search_message_versions", "UPDATE"]
  ]) {
    db.run(`CREATE TRIGGER IF NOT EXISTS search_occurrence_${name}
      AFTER ${event} ON ${table} BEGIN ${bumpOccurrence} END`)
  }
  db.run(`CREATE TRIGGER IF NOT EXISTS search_occurrence_message_moved
    AFTER UPDATE OF ordinal, message_id ON thread_messages
    WHEN NEW.ordinal IS NOT OLD.ordinal OR NEW.message_id IS NOT OLD.message_id
    BEGIN ${bumpOccurrence} END`)
  db.run(`CREATE TRIGGER IF NOT EXISTS search_occurrence_message_deleted
    AFTER DELETE ON thread_messages BEGIN ${bumpOccurrence.replace("NEW.", "OLD.")} END`)
  db.run(`CREATE TRIGGER IF NOT EXISTS search_occurrence_thread_delete AFTER DELETE ON threads
    BEGIN DELETE FROM thread_search_occurrence_versions WHERE thread_id = OLD.thread_id; END`)
  const bump = (threadRef: string) => `
    INSERT INTO thread_search_structure_versions VALUES (${threadRef}.thread_id, 1)
      ON CONFLICT(thread_id) DO UPDATE SET epoch = epoch + 1;
  `
  for (const [name, event, table, condition] of [
    [
      "message_reorder",
      "UPDATE OF ordinal, message_id",
      "thread_messages",
      "WHEN NEW.ordinal IS NOT OLD.ordinal OR NEW.message_id IS NOT OLD.message_id"
    ],
    ["message_delete", "DELETE", "thread_messages", ""],
    [
      "goal_anchor_change",
      "UPDATE OF goal_id, active_window_id",
      "thread_messages",
      "WHEN NEW.goal_id IS NOT OLD.goal_id OR NEW.active_window_id IS NOT OLD.active_window_id"
    ],
    ["goal_change", "UPDATE", "thread_goal_events", ""],
    ["goal_delete", "DELETE", "thread_goal_events", ""]
  ]) {
    db.run(`CREATE TRIGGER IF NOT EXISTS search_${name} AFTER ${event} ON ${table}
      ${condition} BEGIN ${bump("OLD")} END`)
  }
  db.run(`
    CREATE TRIGGER IF NOT EXISTS search_message_insert AFTER INSERT ON thread_messages
    WHEN EXISTS (SELECT 1 FROM thread_messages
      WHERE thread_id = NEW.thread_id AND ordinal > NEW.ordinal LIMIT 1)
    BEGIN ${bump("NEW")} END
  `)
  if (hasColumn("thread_graph_transcript_boundaries", "ordinal")) {
    for (const event of ["INSERT", "UPDATE OF ordinal", "DELETE"]) {
      const name = event.split(" ")[0].toLowerCase()
      const ref = event === "DELETE" ? "OLD" : "NEW"
      db.run(`CREATE TRIGGER IF NOT EXISTS search_graph_boundary_${name}
        AFTER ${event} ON thread_graph_transcript_boundaries
        BEGIN ${bump(ref)} ${bumpOccurrence.replace("NEW.", ref + ".")} END`)
    }
  }
  db.run(`
    CREATE TRIGGER IF NOT EXISTS search_thread_delete AFTER DELETE ON threads
    BEGIN
      DELETE FROM thread_search_structure_versions WHERE thread_id = OLD.thread_id;
      DELETE FROM thread_search_coverage WHERE thread_id = OLD.thread_id;
    END
  `)
  const bumpMessage = (ref: "NEW" | "OLD") => `
    INSERT INTO thread_search_message_versions VALUES (${ref}.thread_id, ${ref}.message_id, 1)
      ON CONFLICT(thread_id, message_id) DO UPDATE SET version = version + 1;
  `
  db.run(`
    CREATE TRIGGER IF NOT EXISTS search_message_payload_change
    AFTER UPDATE OF role, content_json, reasoning, tool_calls_json ON thread_messages
    WHEN NEW.role IS NOT OLD.role OR NEW.content_json IS NOT OLD.content_json
      OR NEW.reasoning IS NOT OLD.reasoning OR NEW.tool_calls_json IS NOT OLD.tool_calls_json
    BEGIN ${bumpMessage("NEW")} END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS search_message_provider_change
    AFTER UPDATE OF provider_source_id, provider_occurrence ON thread_messages
    WHEN NEW.provider_source_id IS NOT OLD.provider_source_id
      OR NEW.provider_occurrence IS NOT OLD.provider_occurrence
    BEGIN ${bumpMessage("NEW")} END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS search_message_legacy_exact_change
    AFTER UPDATE OF tool_call_id, name, status, is_error ON thread_messages
    WHEN NEW.tool_call_id IS NOT OLD.tool_call_id OR NEW.name IS NOT OLD.name
      OR NEW.status IS NOT OLD.status OR NEW.is_error IS NOT OLD.is_error
    BEGIN ${bumpMessage("NEW")} END
  `)
  for (const column of ["stream_authority", "end_at", "recovery_integrity", "fragment_generation"]) {
    db.run(`CREATE TRIGGER IF NOT EXISTS search_message_copy_${column}
      AFTER UPDATE OF ${column} ON thread_messages
      WHEN NEW.${column} IS NOT OLD.${column}
      BEGIN ${bumpMessage("NEW")} END`)
  }
  for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
    const row = event === "DELETE" ? "OLD" : "NEW"
    db.run(`DROP TRIGGER IF EXISTS search_fragment_${event.toLowerCase()}`)
    db.run(`CREATE TRIGGER IF NOT EXISTS search_published_fragment_${event.toLowerCase()}
      AFTER ${event} ON thread_message_fragments
      WHEN EXISTS (SELECT 1 FROM thread_messages
        WHERE thread_id = ${row}.thread_id AND message_id = ${row}.message_id
          AND fragment_generation = ${row}.generation)
      BEGIN ${bumpMessage(row)} END`)
  }
  db.run(`CREATE TRIGGER IF NOT EXISTS search_message_payload_delete AFTER DELETE ON thread_messages
    BEGIN DELETE FROM thread_search_message_versions
      WHERE thread_id = OLD.thread_id AND message_id = OLD.message_id; END`)
  db.run(`CREATE TRIGGER IF NOT EXISTS search_message_payload_rename
    AFTER UPDATE OF message_id ON thread_messages WHEN NEW.message_id IS NOT OLD.message_id
    BEGIN DELETE FROM thread_search_message_versions
      WHERE thread_id = OLD.thread_id AND message_id = OLD.message_id; END`)
  db.run(`CREATE TRIGGER IF NOT EXISTS search_thread_payload_delete AFTER DELETE ON threads
    BEGIN DELETE FROM thread_search_message_versions WHERE thread_id = OLD.thread_id; END`)
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_thread_search_order ON threads(updated_at DESC, thread_id DESC)"
  )
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_thread_search_message_order
    ON thread_messages(thread_id, ordinal DESC, message_id DESC)
    WHERE role <> 'tool'
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_thread_messages_goal_legacy_anchor
    ON thread_messages(thread_id, active_window_id, created_at)
    WHERE role = 'user' AND active_window_id != ''`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_thread_search_goal_user_time
    ON thread_messages(thread_id, created_at) WHERE role = 'user'`)
}
