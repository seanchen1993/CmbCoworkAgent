import type { NativeSqliteAdapter } from "./native-sqlite-adapter"

export function ensureGeneratedImageSchema(db: NativeSqliteAdapter): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS generated_image_actions (
      action_id TEXT PRIMARY KEY,
      scope_key TEXT UNIQUE NOT NULL,
      deployment_id TEXT NOT NULL,
      public_message_id TEXT NOT NULL,
      state TEXT NOT NULL,
      request_id TEXT,
      width INTEGER,
      height INTEGER,
      image_sha TEXT,
      preview_sha TEXT
    );
    CREATE TABLE IF NOT EXISTS generated_image_grants (
      thread_id TEXT NOT NULL,
      incarnation TEXT NOT NULL,
      action_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      original_user_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      audience TEXT NOT NULL,
      PRIMARY KEY (thread_id, incarnation, action_id)
    );
    CREATE INDEX IF NOT EXISTS idx_generated_image_grants_action ON generated_image_grants(action_id);
    CREATE INDEX IF NOT EXISTS idx_generated_image_grants_call ON generated_image_grants(thread_id, incarnation, call_id);
    CREATE INDEX IF NOT EXISTS idx_generated_image_grants_user ON generated_image_grants(thread_id,user_id);
    CREATE TABLE IF NOT EXISTS generated_image_replay_calls (
      action_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      PRIMARY KEY (action_id, call_id)
    );
    CREATE TRIGGER IF NOT EXISTS generated_image_thread_deletion AFTER DELETE ON threads
    BEGIN
      DELETE FROM generated_image_grants WHERE thread_id=OLD.thread_id;
    END;
  `)
  // Developer builds created the tables before user-ID rebinding and public group hints
  // were introduced. Upgrading the schema never guesses an old group message or workspace.
  db.withImmediateWriteTransaction(() => {
    const hasColumn = (table: string, column: string) =>
      db.exec(`PRAGMA table_info(${table})`)[0].values.some((row) => row[1] === column)
    if (!hasColumn("generated_image_grants", "original_user_id")) {
      db.run(
        "ALTER TABLE generated_image_grants ADD COLUMN original_user_id TEXT NOT NULL DEFAULT ''"
      )
      db.run("UPDATE generated_image_grants SET original_user_id=user_id")
    }
    if (!hasColumn("generated_image_actions", "public_message_id")) {
      db.run(
        "ALTER TABLE generated_image_actions ADD COLUMN public_message_id TEXT NOT NULL DEFAULT ''"
      )
    }
  })
}
