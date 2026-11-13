import { parentPort, workerData } from "node:worker_threads"
import { DatabaseSync } from "node:sqlite"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { applyCheckpointStorageSchemaMaintenance, publishCheckpointStorageSchema,
  type CheckpointForkBoundaryBackfill } from "./checkpoint-storage-schema"
import { createDefaultCheckpointMetadataCodec, prepareCheckpointMetadataBackfill }
  from "./checkpoint-metadata-codec"
import { assertCheckpointDatabaseFileIdentity, type CheckpointDatabaseFileIdentity }
  from "./checkpoint-database-identity"

const port = parentPort
if (!port) throw new Error("Checkpoint storage maintenance needs its original parent")
const request = workerData as { databasePath: string; backfill: CheckpointForkBoundaryBackfill[];
  defaultCodec: boolean; file: CheckpointDatabaseFileIdentity }
async function main(): Promise<void> {
  let database: NativeSqliteAdapter | undefined
  try {
    await assertCheckpointDatabaseFileIdentity(request.databasePath, request.file)
    database = new NativeSqliteAdapter(new DatabaseSync(request.databasePath, { timeout: 5000 }))
    await assertCheckpointDatabaseFileIdentity(request.databasePath, request.file)
    publishCheckpointStorageSchema(database)
    const needsMetadata = !database.exec("SELECT 1 FROM checkpoint_schema_migrations WHERE migration_id=?",
      ["checkpoint-columns-and-fork-boundary-v1"])[0]?.values.length
    const backfill = request.defaultCodec && needsMetadata ? await prepareCheckpointMetadataBackfill(database,
      createDefaultCheckpointMetadataCodec(), () => {}) : request.backfill
    applyCheckpointStorageSchemaMaintenance(database, backfill)
    await assertCheckpointDatabaseFileIdentity(request.databasePath, request.file)
    database.close({ checkpoint: false })
    database = undefined
    port!.postMessage({ ok: true })
  } catch (error) {
    try { database?.close({ checkpoint: false }) } catch { /* Preserve the migration error. */ }
    port!.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) })
  } finally { port!.close() }
}
void main()
