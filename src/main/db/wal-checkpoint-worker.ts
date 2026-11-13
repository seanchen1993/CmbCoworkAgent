import { workerData } from "node:worker_threads"
import { DatabaseSync } from "node:sqlite"
import { assertCheckpointDatabaseFileIdentity } from "../checkpointer/checkpoint-database-identity"
import type { WalCheckpointWorkerData } from "./wal-checkpoint"

// PASSIVE does not wait for readers/writers. The normal connection policy will
// checkpoint any pages still pinned by a concurrent reader on a later commit.
async function main(): Promise<void> {
  const request = workerData as WalCheckpointWorkerData
  await assertCheckpointDatabaseFileIdentity(request.databasePath, request.file)
  const database = new DatabaseSync(request.databasePath, { timeout: 0 })
  try {
    await assertCheckpointDatabaseFileIdentity(request.databasePath, request.file)
    database.exec("PRAGMA wal_checkpoint(PASSIVE)")
    await assertCheckpointDatabaseFileIdentity(request.databasePath, request.file)
  } finally {
    database.close()
  }
}
void main().catch((error) => {
  queueMicrotask(() => {
    throw error
  })
})
