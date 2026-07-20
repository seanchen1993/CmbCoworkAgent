/**
 * Regression test for the memory session opt-in migration.
 *
 * Run:
 *   npx tsx tests/memory-session-migration.spec.ts
 */

import assert from "assert"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import initSqlJs from "sql.js"

async function createLegacyDatabase(dbPath: string): Promise<void> {
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  const now = Date.now()
  db.run(`
    CREATE TABLE threads (
      thread_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT,
      status TEXT DEFAULT 'idle',
      thread_values TEXT,
      title TEXT
    )
  `)
  db.run(
    `INSERT INTO threads (thread_id, created_at, updated_at, metadata, status, title)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      "legacy-thread",
      now,
      now,
      JSON.stringify({ title: "Legacy thread", workspacePath: "C:\\repo" }),
      "idle",
      "Legacy thread"
    ]
  )
  await writeFile(dbPath, Buffer.from(db.export()))
  db.close()
}

async function main(): Promise<void> {
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  const home = await mkdtemp(join(tmpdir(), "cmb-memory-session-migration-"))
  let closeDatabase: (() => Promise<void>) | null = null

  try {
    process.env.HOME = home
    process.env.USERPROFILE = home

    const openworkDir = join(home, ".cmbcoworkagent")
    await mkdir(openworkDir, { recursive: true })
    await createLegacyDatabase(join(openworkDir, "cmbcoworkagent.sqlite"))

    const db = await import("../src/main/db/index")
    const storage = await import("../src/main/storage")
    closeDatabase = db.closeDatabase
    await db.initializeDatabase()

    const legacyThread = db.getThread("legacy-thread")
    assert(legacyThread, "legacy thread should still exist")
    const legacyMetadata = JSON.parse(legacyThread.metadata ?? "{}") as Record<string, unknown>
    assert(legacyMetadata.memoryEnabled === true, "legacy threads are explicitly opted in")
    assert(storage.isMemoryEnabled(), "legacy installs keep global memory enabled")
    assert(storage.isDreamEnabled(), "legacy installs keep dream memory enabled")
    assert(storage.isThreadMemoryEnabled(legacyMetadata), "legacy thread can use memory")

    db.createThread("new-thread", { title: "New thread" })
    const newThread = db.getThread("new-thread")
    assert(newThread, "new thread should be created")
    const newMetadata = JSON.parse(newThread.metadata ?? "{}") as Record<string, unknown>
    assert(newMetadata.memoryEnabled !== true, "new threads remain session opt-in by default")
    assert(!storage.isThreadMemoryEnabled(newMetadata), "new threads do not use memory by default")

    const settings = JSON.parse(
      await readFile(join(openworkDir, "memory-settings.json"), "utf-8")
    ) as Record<string, unknown>
    assert(settings.sessionOptInMigrated === true, "migration is marked as complete")
    await closeDatabase()
    closeDatabase = null

    console.log(
      "PASS memory session migration preserves legacy threads while keeping new threads opt-in"
    )
  } finally {
    if (closeDatabase) await closeDatabase().catch(() => undefined)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    await rm(home, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
