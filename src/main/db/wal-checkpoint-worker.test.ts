import { transformSync } from "esbuild"
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Worker } from "node:worker_threads"
import { expect, it } from "vitest"

it("checkpoints committed WAL pages from a real worker while the owner connection remains open", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-deletion-wal-"))
  const databasePath = join(root, "messages.sqlite")
  const database = new DatabaseSync(databasePath)
  try {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0")
    database.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT)")
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    database.exec("BEGIN")
    const insert = database.prepare("INSERT INTO messages VALUES (?, ?)")
    for (let id = 0; id < 1000; id++) insert.run(id, "x".repeat(2048))
    database.exec("DELETE FROM messages WHERE id = 0; COMMIT")
    const code = transformSync(
      readFileSync(new URL("./wal-checkpoint-worker.ts", import.meta.url), "utf8"),
      { loader: "ts", format: "cjs" }
    ).code
    const worker = new Worker(code, { eval: true, workerData: databasePath })
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once("error", reject)
        worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
      })
    } finally {
      await worker.terminate()
    }
    // Copy only the main file, excluding WAL: the worker must have materialized the commit.
    const snapshotPath = join(root, "snapshot.sqlite")
    copyFileSync(databasePath, snapshotPath)
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
    try {
      expect(snapshot.prepare("SELECT count(*) AS count FROM messages").get()?.count).toBe(999)
      expect(snapshot.prepare("SELECT id FROM messages WHERE id = 0").get()).toBeUndefined()
    } finally {
      snapshot.close()
    }
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
})
