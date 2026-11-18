import type { NativeSqliteAdapter } from "./native-sqlite-adapter"

/** Persist unused ordinals so the importer and live transcript move the same slots. */
export function ensureLegacyTranscriptSlots(database: NativeSqliteAdapter): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS legacy_checkpoint_transcript_slots (
      thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
      checkpoint_id TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_id, message_index)
    );
    CREATE INDEX IF NOT EXISTS idx_legacy_checkpoint_transcript_slots_ordinal
      ON legacy_checkpoint_transcript_slots(thread_id, ordinal)
  `)
  const columns =
    database.exec("PRAGMA table_info(legacy_checkpoint_transcript_migrations)")[0]?.values ?? []
  if (!columns.some((column) => column[1] === "reserved_ordinals_json")) {
    database.exec(
      "ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN reserved_ordinals_json TEXT"
    )
  }
  if (!columns.some((column) => column[1] === "scoped_order")) {
    database.exec(
      "ALTER TABLE legacy_checkpoint_transcript_migrations ADD COLUMN scoped_order INTEGER"
    )
  }

  const pendingLegacyMigration = "status = 'migrating' AND scoped_order IS NULL"
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_legacy_checkpoint_transcript_unconverted
      ON legacy_checkpoint_transcript_migrations(thread_id)
      WHERE ${pendingLegacyMigration}
  `)
  const pending = database.exec(`
    SELECT 1 FROM legacy_checkpoint_transcript_migrations WHERE ${pendingLegacyMigration} LIMIT 1
  `)
  if (!pending[0]?.values.length) return

  database.withImmediateWriteTransaction(() => {
    database.exec(`
      INSERT INTO legacy_checkpoint_transcript_slots (thread_id, checkpoint_id, message_index, ordinal)
      SELECT thread_id, checkpoint_id, CAST(slot.key AS INTEGER), slot.value
      FROM legacy_checkpoint_transcript_migrations, json_each(reserved_ordinals_json) AS slot
      WHERE ${pendingLegacyMigration} AND slot.value IS NOT NULL
        AND CAST(slot.key AS INTEGER) >= next_index
    `)
    database.exec(`
      WITH RECURSIVE pending(thread_id, checkpoint_id, message_index, total_messages) AS (
        SELECT thread_id, checkpoint_id, next_index, total_messages
        FROM legacy_checkpoint_transcript_migrations
        WHERE ${pendingLegacyMigration} AND reserved_ordinals_json IS NULL
          AND next_index < total_messages
        UNION ALL
        SELECT thread_id, checkpoint_id, message_index + 1, total_messages FROM pending
        WHERE message_index + 1 < total_messages
      )
      INSERT INTO legacy_checkpoint_transcript_slots (thread_id, checkpoint_id, message_index, ordinal)
      SELECT thread_id, checkpoint_id, message_index, message_index FROM pending
    `)
    database.exec(`
      UPDATE legacy_checkpoint_transcript_migrations
      SET scoped_order = (reserved_ordinals_json IS NOT NULL), reserved_ordinals_json = NULL
      WHERE ${pendingLegacyMigration}
    `)
  })
}
