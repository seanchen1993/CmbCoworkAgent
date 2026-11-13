import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"

export const CHECKPOINT_TIMESTAMP_MIGRATION = "checkpoint-native-timestamp-v2"

/** Old IDs are not comparable to new ISO timestamps. Read only the original JSON ts in SQLite. */
export function ensureCheckpointTimestamps(database: NativeSqliteAdapter): void {
  const applied = () => Boolean(database.exec(
    "SELECT 1 FROM checkpoint_schema_migrations WHERE migration_id=? LIMIT 1",
    [CHECKPOINT_TIMESTAMP_MIGRATION]
  )[0]?.values.length)
  const pending = () => Boolean(database.exec(`SELECT 1 FROM checkpoints
    WHERE checkpoint_ts IS NULL OR checkpoint_ts = checkpoint_id LIMIT 1`)[0]?.values.length)
  // A downgraded application can append old-schema rows after this marker exists.
  // The partial index keeps the usual no-work check independent of history size.
  if (applied() && !pending()) return
  let transaction = false
  try {
    database.run("BEGIN IMMEDIATE")
    transaction = true
    if (!applied() || pending()) {
      database.run(`UPDATE checkpoints SET checkpoint_ts = (
        SELECT strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(CAST(checkpoint AS TEXT), '$.ts'))
      ) WHERE (checkpoint_ts IS NULL OR checkpoint_ts = checkpoint_id)
        AND COALESCE(type, 'json') = 'json'
        AND CASE WHEN json_valid(CAST(checkpoint AS TEXT)) THEN
          json_type(CAST(checkpoint AS TEXT), '$.ts') = 'text'
          AND (SELECT COUNT(*) FROM json_each(CAST(checkpoint AS TEXT)) WHERE key='ts') = 1
          AND length(json_extract(CAST(checkpoint AS TEXT), '$.ts')) BETWEEN 20 AND 35
          AND strftime('%Y-%m-%d', substr(json_extract(CAST(checkpoint AS TEXT), '$.ts'), 1, 10))
            = substr(json_extract(CAST(checkpoint AS TEXT), '$.ts'), 1, 10)
          AND substr(json_extract(CAST(checkpoint AS TEXT), '$.ts'), 12, 2) BETWEEN '00' AND '23'
          AND substr(json_extract(CAST(checkpoint AS TEXT), '$.ts'), 15, 2) BETWEEN '00' AND '59'
          AND substr(json_extract(CAST(checkpoint AS TEXT), '$.ts'), 18, 2) BETWEEN '00' AND '59'
          AND strftime('%Y-%m-%dT%H:%M:%fZ',
            json_extract(CAST(checkpoint AS TEXT), '$.ts')) IS NOT NULL
        ELSE 0 END`)
      // Unknown historical times sort below every valid native ISO timestamp.
      // Keep checkpoint_id only as the stable tie-breaker, never as a guessed time.
      database.run(`UPDATE checkpoints SET checkpoint_ts = ''
        WHERE checkpoint_ts IS NULL OR checkpoint_ts = checkpoint_id`)
      if (database.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoint_runtime_projections'")[0]?.values.length) {
        database.run(`UPDATE checkpoint_runtime_projections AS projection SET checkpoint_ts = (
          SELECT checkpoint.checkpoint_ts FROM checkpoints AS checkpoint
          WHERE checkpoint.thread_id = projection.thread_id
            AND checkpoint.checkpoint_ns = projection.checkpoint_ns
            AND checkpoint.checkpoint_id = projection.checkpoint_id
        ) WHERE projection.checkpoint_ts = projection.checkpoint_id
          AND EXISTS (
            SELECT 1 FROM checkpoints AS checkpoint
            WHERE checkpoint.thread_id = projection.thread_id
              AND checkpoint.checkpoint_ns = projection.checkpoint_ns
              AND checkpoint.checkpoint_id = projection.checkpoint_id
              AND checkpoint.checkpoint_ts IS NOT NULL
              AND checkpoint.checkpoint_ts != checkpoint.checkpoint_id
          )`)
      }
      database.run(`CREATE INDEX IF NOT EXISTS checkpoint_pending_native_timestamp
        ON checkpoints(checkpoint_ts) WHERE checkpoint_ts IS NULL OR checkpoint_ts = checkpoint_id`)
      database.run("INSERT OR IGNORE INTO checkpoint_schema_migrations(migration_id,applied_at) VALUES(?,?)",
        [CHECKPOINT_TIMESTAMP_MIGRATION, Date.now()])
    }
    database.run("COMMIT")
    transaction = false
  } catch (error) {
    if (transaction) {
      try { database.run("ROLLBACK") } catch { /* Preserve the original migration error. */ }
    }
    throw error
  }
}
