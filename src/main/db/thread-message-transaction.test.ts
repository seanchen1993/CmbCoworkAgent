import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ path: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => state.path,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as threadDb from "./index"

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-message-transaction-"))
  state.path = join(directory, "threads.sqlite")
  await threadDb.initializeDatabase()
})
afterAll(async () => {
  await threadDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

describe("native transcript writer in an actual caller-owned transaction", () => {
  it("requires an actual SQLite transaction and leaves the original writer usable", () => {
    threadDb.createThread("writer-normal")
    expect(threadDb.getDb().inTransaction).toBe(false)
    const rows = [{ id: "u1", role: "user" as const, content: "Original input",
      created_at: new Date(1) }]
    expect(() => threadDb.upsertThreadMessagesInTransaction("writer-normal", rows)).toThrow(
      "THREAD_MESSAGE_TRANSACTION_REQUIRED"
    )
    expect(threadDb.upsertThreadMessages("writer-normal", rows)).toBe(1)
    expect(threadDb.getDb().inTransaction).toBe(false)
    expect(threadDb.getThreadMessages("writer-normal").map((row) => row.id)).toEqual(["u1"])
  })

  it("does not commit or release the caller transaction and rolls the transcript back with it", () => {
    threadDb.createThread("writer-rollback")
    const database = threadDb.getDb()
    database.run("BEGIN IMMEDIATE")
    expect(
      threadDb.upsertThreadMessagesInTransaction(
        "writer-rollback",
        [{ id: "note-1", role: "user", content: "Hidden note", created_at: new Date(2) }],
        { preserveExistingOrder: true }
      )
    ).toBe(1)
    expect(database.inTransaction).toBe(true)
    expect(threadDb.getThreadMessages("writer-rollback")).toHaveLength(1)
    database.run("ROLLBACK")
    expect(database.inTransaction).toBe(false)
    expect(threadDb.getThreadMessages("writer-rollback")).toEqual([])
  })

  it("commits canonical transcript rows together with another native source record", () => {
    threadDb.createThread("writer-commit")
    const database = threadDb.getDb()
    database.run(
      "CREATE TABLE host_writer_test_receipts (uuid TEXT PRIMARY KEY, kind TEXT NOT NULL)"
    )
    database.run("BEGIN IMMEDIATE")
    threadDb.upsertThreadMessagesInTransaction(
      "writer-commit",
      [
        { id: "u1", role: "user", content: "Original input", created_at: new Date(3) },
        { id: "note-2", role: "user", content: "Committed note", created_at: new Date(4) }
      ],
      { preserveExistingOrder: true }
    )
    database.run("INSERT INTO host_writer_test_receipts VALUES (?, ?)", ["note-2", "plugin-note"])
    expect(database.inTransaction).toBe(true)
    database.run("COMMIT")
    expect(database.exec("SELECT uuid FROM host_writer_test_receipts")[0].values).toEqual([
      ["note-2"]
    ])
    expect(threadDb.getThreadMessages("writer-commit").map((row) => row.id)).toEqual([
      "u1",
      "note-2"
    ])
    expect(
      threadDb.upsertThreadMessages(
        "writer-commit",
        [{ id: "a1", role: "assistant", content: "Existing path after atomic commit",
          created_at: new Date(5) }],
        { preserveExistingOrder: true }
      )
    ).toBe(1)
    expect(database.inTransaction).toBe(false)
  })
})
