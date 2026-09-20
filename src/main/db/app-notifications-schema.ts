import type { NativeSqliteAdapter } from "./native-sqlite-adapter"

export function ensureAppNotificationsSchema(database: NativeSqliteAdapter): void {
  // CREATE IF NOT EXISTS only initializes new tables; deployed schema changes require explicit migrations.
  database.run(`CREATE TABLE IF NOT EXISTS app_messages (
    notification_id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    source_type TEXT NOT NULL,
    status TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )`)
  database.run("DROP INDEX IF EXISTS idx_app_messages_completed")
  database.run(`CREATE INDEX IF NOT EXISTS idx_app_messages_terminal
    ON app_messages(completed_at DESC, notification_id DESC)
    WHERE status IN ('resolved', 'invalidated')`)
  database.run(`CREATE INDEX IF NOT EXISTS idx_app_messages_pending
    ON app_messages(kind, status, created_at DESC, notification_id DESC)`)
}
