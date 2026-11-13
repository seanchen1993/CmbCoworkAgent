import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { createHash } from "node:crypto"
import { ensureMessageSnapshotGeneration, MESSAGE_SNAPSHOT_GENERATION_MIGRATION }
  from "./message-snapshot-schema"
import { ensureCheckpointTimestamps, CHECKPOINT_TIMESTAMP_MIGRATION }
  from "./checkpoint-timestamp-schema"

export const CHECKPOINT_SCHEMA_MIGRATION_ID = "checkpoint-columns-and-fork-boundary-v1"
export interface CheckpointForkBoundaryBackfill {
  threadId: string
  checkpointNs: string
  checkpointId: string
  metadataType: string | null
  metadataDigest: string
}

export function checkpointMetadataPayloadDigest(payload: string | Uint8Array): string {
  return createHash("sha256").update(typeof payload === "string" ? "text:" : "blob:")
    .update(payload).digest("hex")
}

export function checkpointStorageSchemaNeedsMaintenance(database: NativeSqliteAdapter): boolean {
  const tables = new Set((database.exec(`SELECT name FROM sqlite_master WHERE type='table'`)[0]?.values ?? [])
    .map(row => String(row[0])))
  if (!["checkpoints", "writes", "checkpoint_message_snapshots", "checkpoint_runtime_projections",
    "checkpoint_schema_migrations"].every(name => tables.has(name))) return true
  const columns = new Set((database.exec("PRAGMA table_info(checkpoints)")[0]?.values ?? [])
    .map(row => String(row[1])))
  if (!columns.has("checkpoint_ts") || !columns.has("fork_boundary_marker")) return true
  const markers = database.exec("SELECT migration_id FROM checkpoint_schema_migrations")[0]?.values ?? []
  const applied = new Set(markers.map(row => row[0]))
  if (![CHECKPOINT_SCHEMA_MIGRATION_ID, MESSAGE_SNAPSHOT_GENERATION_MIGRATION,
    CHECKPOINT_TIMESTAMP_MIGRATION].every(id => applied.has(id))) return true
  return Boolean(database.exec(`SELECT 1 FROM checkpoints
    WHERE checkpoint_ts IS NULL OR checkpoint_ts = checkpoint_id LIMIT 1`)[0]?.values.length)
}

/** BLOB length uses SQLite's record size; no checkpoint body crosses to Main. */
export function checkpointStorageMaintenanceBytes(database: NativeSqliteAdapter): number {
  const rows = database.exec(`SELECT
    (SELECT COALESCE(SUM(length(CAST(checkpoint AS BLOB))),0) FROM checkpoints) +
    (SELECT COALESCE(SUM(length(CAST(suffix AS BLOB))),0) FROM checkpoint_message_snapshots)`)
  return Number(rows[0]?.values[0]?.[0] ?? 0)
}

export function applyCheckpointStorageSchemaMaintenance(database: NativeSqliteAdapter,
  forkBoundaryBackfill: readonly CheckpointForkBoundaryBackfill[]): void {
  const applied = database.exec("SELECT 1 FROM checkpoint_schema_migrations WHERE migration_id=?",
    [CHECKPOINT_SCHEMA_MIGRATION_ID])[0]?.values.length
  if (!applied) {
    let migrationStarted = false
    try {
      database.run("BEGIN IMMEDIATE")
      migrationStarted = true

      // Another process may have completed the migration while metadata was
      // decoded. Recheck both the marker and live schema under the writer lock.
      const concurrentlyApplied = database.exec(
        `SELECT 1 FROM checkpoint_schema_migrations WHERE migration_id = ? LIMIT 1`,
        [CHECKPOINT_SCHEMA_MIGRATION_ID]
      )
      if (concurrentlyApplied[0]?.values.length) {
        database.run("COMMIT")
        migrationStarted = false
        ensureMessageSnapshotGeneration(database)
        ensureCheckpointTimestamps(database)
        return
      }

      const tableInfo = database.exec("PRAGMA table_info(checkpoints)")
      const columns = new Set((tableInfo[0]?.values ?? []).map((row) => String(row[1] ?? "")))
      if (!columns.has("checkpoint_ts")) {
        database.run(`ALTER TABLE checkpoints ADD COLUMN checkpoint_ts TEXT`)
      }
      if (!columns.has("fork_boundary_marker")) {
        database.run(
          `ALTER TABLE checkpoints
           ADD COLUMN fork_boundary_marker INTEGER NOT NULL DEFAULT 0`
        )
      }
      database.run(
        `UPDATE checkpoints
         SET fork_boundary_marker = 1
         WHERE fork_boundary_marker = 0 AND metadata LIKE '%cmb_fork_boundary%'`
      )
      for (const candidate of forkBoundaryBackfill) {
        const current = database.exec(`SELECT type,metadata FROM checkpoints
          WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`,
          [candidate.threadId, candidate.checkpointNs, candidate.checkpointId])[0]?.values[0]
        const payload = current?.[1]
        if (!current || current[0] !== candidate.metadataType ||
          !(typeof payload === "string" || payload instanceof Uint8Array) ||
          checkpointMetadataPayloadDigest(payload) !== candidate.metadataDigest) continue
        database.run(
          `UPDATE checkpoints
           SET fork_boundary_marker = 1
           WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
             AND fork_boundary_marker = 0 AND type IS ? AND metadata = ?`,
          [
            candidate.threadId,
            candidate.checkpointNs,
            candidate.checkpointId,
            candidate.metadataType,
            payload
          ]
        )
      }
      database.run(
        `INSERT INTO checkpoint_schema_migrations (migration_id, applied_at) VALUES (?, ?)`,
        [CHECKPOINT_SCHEMA_MIGRATION_ID, Date.now()]
      )
      database.run("COMMIT")
      migrationStarted = false
    } catch (error) {
      if (migrationStarted) {
        try {
          database.run("ROLLBACK")
        } catch {
          // Preserve the migration error; a failed BEGIN has no transaction.
        }
      }
      throw error
    }

  }
  ensureMessageSnapshotGeneration(database)
  ensureCheckpointTimestamps(database)
}

/** The same base layout is published by inline empty setup and the dedicated cold worker. */
export function publishCheckpointStorageSchema(database: NativeSqliteAdapter): void {
    // Create tables
    database.run(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint TEXT,
        metadata TEXT,
        checkpoint_ts TEXT,
        fork_boundary_marker INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )
    `)

    database.run(`
      CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value TEXT,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )
    `)

    database.run(`
      CREATE TABLE IF NOT EXISTS checkpoint_message_snapshots (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        prefix_length INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL,
        generation TEXT NOT NULL DEFAULT '',
        type TEXT,
        suffix BLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )
    `)

    database.run(`
      CREATE INDEX IF NOT EXISTS idx_checkpoint_message_snapshot_parent
      ON checkpoint_message_snapshots (thread_id, checkpoint_ns, parent_checkpoint_id)
    `)
    database.run(`
      CREATE TABLE IF NOT EXISTS checkpoint_runtime_projections (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        checkpoint_ts TEXT NOT NULL,
        projection_version INTEGER NOT NULL DEFAULT 1,
        type TEXT NOT NULL,
        runtime_checkpoint BLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns)
      )
    `)
    const runtimeProjectionColumns = database.exec(
      "PRAGMA table_info(checkpoint_runtime_projections)"
    )
    const hasRuntimeProjectionVersion = (runtimeProjectionColumns[0]?.values ?? []).some(
      (column) => column[1] === "projection_version"
    )
    if (!hasRuntimeProjectionVersion) {
      // Rows written by the pre-projection-version implementation are not
      // trusted as bounded; the worker rebuilds them from the authoritative
      // checkpoint before Electron main reads the payload.
      database.run(
        "ALTER TABLE checkpoint_runtime_projections ADD COLUMN projection_version INTEGER NOT NULL DEFAULT 0"
      )
    }

  database.run(`CREATE TABLE IF NOT EXISTS checkpoint_schema_migrations (
    migration_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
}
