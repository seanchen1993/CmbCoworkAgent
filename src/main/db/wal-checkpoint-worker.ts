import { workerData } from "node:worker_threads"
import { DatabaseSync } from "node:sqlite"

// PASSIVE does not wait for readers/writers. The normal connection policy will
// checkpoint any pages still pinned by a concurrent reader on a later commit.
const database = new DatabaseSync(workerData as string, { timeout: 0 })
try {
  database.exec("PRAGMA wal_checkpoint(PASSIVE)")
} finally {
  database.close()
}
