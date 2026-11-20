import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"

export const MESSAGE_SNAPSHOT_GENERATION_MIGRATION = "checkpoint-message-generation-v1"

/** Called only after checkpoint_schema_migrations has been published. */
export function ensureMessageSnapshotGeneration(database: NativeSqliteAdapter): void {
  const applied = () =>
    Boolean(
      database.exec("SELECT 1 FROM checkpoint_schema_migrations WHERE migration_id = ? LIMIT 1", [
        MESSAGE_SNAPSHOT_GENERATION_MIGRATION
      ])[0]?.values.length
    )
  // Ordinary reopen must neither scan snapshots nor acquire a writer lock.
  if (applied()) return

  let transactionStarted = false
  try {
    database.run("BEGIN IMMEDIATE")
    transactionStarted = true
    // The worker and main process may both have observed an unapplied upgrade.
    if (!applied()) {
      const columns = database.exec("PRAGMA table_info(checkpoint_message_snapshots)")
      if (!columns[0]?.values.some((column) => column[1] === "generation")) {
        database.run(
          "ALTER TABLE checkpoint_message_snapshots ADD COLUMN generation TEXT NOT NULL DEFAULT ''"
        )
      }
      database.run(
        `UPDATE checkpoint_message_snapshots
         SET generation = lower(hex(randomblob(16)))
         WHERE generation IS NULL OR typeof(generation) != 'text' OR length(generation) = 0`
      )
      database.run(
        "INSERT INTO checkpoint_schema_migrations (migration_id, applied_at) VALUES (?, ?)",
        [MESSAGE_SNAPSHOT_GENERATION_MIGRATION, Date.now()]
      )
    }
    database.run("COMMIT")
    transactionStarted = false
  } catch (error) {
    if (transactionStarted) {
      try {
        database.run("ROLLBACK")
      } catch {
        // Preserve the migration failure; its marker must never survive alone.
      }
    }
    throw error
  }
}
