import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const storageState = vi.hoisted(() => ({ databasePath: "" }))

vi.mock("../storage", () => ({
  getDbPath: () => storageState.databasePath,
  getMemorySessionOptInMigrationState: () => ({
    migrated: true,
    legacyMemoryEnabled: false,
    legacyDreamEnabled: false
  }),
  markMemorySessionOptInMigrated: vi.fn()
}))

import * as threadDb from "./index"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation,
  THREAD_INCARNATION_METADATA_KEY
} from "../services/thread-incarnation"

let temporaryDirectory = ""

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "thread-incarnation-"))
  storageState.databasePath = join(temporaryDirectory, "threads.sqlite")
  await threadDb.initializeDatabase()
})

afterAll(async () => {
  await threadDb.closeDatabase()
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

describe("thread incarnation", () => {
  it("requires an existing native transaction for an imported thread identity", () => {
    expect(() => threadDb.createThreadInTransaction("outside-import"))
      .toThrow("THREAD_CREATE_TRANSACTION_REQUIRED")
    expect(threadDb.getThreadCore("outside-import")).toBeNull()
  })

  it("rolls back a preparing import and its actual new thread together", () => {
    const database = threadDb.getDb()
    database.run("CREATE TABLE native_import_probe(thread_id TEXT PRIMARY KEY,token TEXT)")
    database.run("BEGIN IMMEDIATE")
    try {
      const row = threadDb.createThreadInTransaction("rolled-back-import", { workspacePath: "C:/repo" })
      const token = captureThreadIncarnation(row).token
      expect(token).toBeTruthy()
      database.run("INSERT INTO native_import_probe VALUES (?,?)", [row.thread_id, token])
      expect(database.inTransaction).toBe(true)
    } finally {
      database.run("ROLLBACK")
    }
    expect(threadDb.getThreadCore("rolled-back-import")).toBeNull()
    expect(database.exec("SELECT * FROM native_import_probe")[0].values).toEqual([])
  })

  it("persists the joined import identity once and keeps its fresh token across restart", async () => {
    const source = threadDb.createThread("import-source", { workspacePath: "C:/repo" })
    const database = threadDb.getDb()
    database.run("CREATE TABLE IF NOT EXISTS native_import_probe(thread_id TEXT PRIMARY KEY,token TEXT)")
    database.run("BEGIN IMMEDIATE")
    let expected: ReturnType<typeof captureThreadIncarnation>
    try {
      const row = threadDb.createThreadInTransaction("committed-import", {
        workspacePath: "C:/repo", [THREAD_INCARNATION_METADATA_KEY]: captureThreadIncarnation(source).token
      })
      expected = captureThreadIncarnation(row)
      expect(expected.token).not.toBe(captureThreadIncarnation(source).token)
      database.run("INSERT INTO native_import_probe VALUES (?,?)", [row.thread_id, expected.token])
      database.run("COMMIT")
    } catch (error) {
      database.run("ROLLBACK")
      throw error
    }
    await threadDb.closeDatabase()
    await threadDb.initializeDatabase()
    expect(matchesThreadIncarnation(threadDb.getThreadCore("committed-import"), expected)).toBe(true)
    expect(threadDb.getDb().exec("SELECT token FROM native_import_probe WHERE thread_id=?",
      ["committed-import"])[0].values).toEqual([[expected.token]])
  })

  it("survives process restart because the creation token is persisted", async () => {
    const created = threadDb.createThread("restart-stable", {
      workspacePath: "C:/repo",
      agentMode: "normal"
    })
    const expected = captureThreadIncarnation(created)

    await threadDb.closeDatabase()
    await threadDb.initializeDatabase()
    const reloaded = threadDb.getThreadCore("restart-stable")
    expect(matchesThreadIncarnation(reloaded, expected)).toBe(true)
  })

  it("distinguishes same-id delete/recreate even when Date.now and metadata are identical", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(123_456)
    try {
      const original = threadDb.createThread("reused", {
        workspacePath: "C:/repo",
        agentMode: "normal"
      })
      const expected = captureThreadIncarnation(original)

      threadDb.deleteThread("reused")
      const recreated = threadDb.createThread("reused", {
        workspacePath: "C:/repo",
        agentMode: "normal"
      })

      expect(recreated.created_at).toBe(original.created_at)
      expect(matchesThreadIncarnation(recreated, expected)).toBe(false)
    } finally {
      now.mockRestore()
    }
  })

  it("prevents an old async metadata continuation from mutating the recreated row", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(234_567)
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const original = threadDb.createThread("interleaved", {
        workspacePath: "C:/repo",
        agentMode: "normal"
      })
      const expected = captureThreadIncarnation(original)
      const staleContinuation = (async () => {
        await barrier
        const latest = threadDb.getThreadCore("interleaved")
        if (!matchesThreadIncarnation(latest, expected)) return false
        threadDb.updateThread("interleaved", {
          metadata: JSON.stringify({ workspacePath: "C:/stale" })
        })
        return true
      })()

      threadDb.deleteThread("interleaved")
      threadDb.createThread("interleaved", {
        workspacePath: "C:/repo",
        agentMode: "normal"
      })
      release()

      await expect(staleContinuation).resolves.toBe(false)
      const recreated = threadDb.getThreadCore("interleaved")
      expect(JSON.parse(recreated?.metadata ?? "{}")).toMatchObject({
        workspacePath: "C:/repo",
        agentMode: "normal"
      })
    } finally {
      now.mockRestore()
    }
  })

  it("preserves the database-owned token across whole metadata replacements", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(345_678)
    try {
      const original = threadDb.createThread("replacement-reuse", {
        workspacePath: "C:/repo",
        agentMode: "normal"
      })
      const originalToken = captureThreadIncarnation(original).token
      expect(originalToken).toBeTruthy()

      const updatedOriginal = threadDb.updateThread("replacement-reuse", {
        metadata: JSON.stringify({ workspacePath: "C:/repo", agentMode: "normal" })
      })
      expect(captureThreadIncarnation(updatedOriginal!).token).toBe(originalToken)
      const expected = captureThreadIncarnation(updatedOriginal!)

      threadDb.deleteThread("replacement-reuse")
      const recreated = threadDb.createThread("replacement-reuse", {
        workspacePath: "C:/repo",
        agentMode: "normal"
      })
      const recreatedToken = captureThreadIncarnation(recreated).token
      expect(recreatedToken).toBeTruthy()
      expect(recreatedToken).not.toBe(originalToken)

      const updatedRecreated = threadDb.updateThread("replacement-reuse", {
        metadata: JSON.stringify({
          workspacePath: "C:/repo",
          agentMode: "normal",
          [THREAD_INCARNATION_METADATA_KEY]: originalToken
        })
      })
      expect(captureThreadIncarnation(updatedRecreated!).token).toBe(recreatedToken)
      expect(matchesThreadIncarnation(updatedRecreated, expected)).toBe(false)
    } finally {
      now.mockRestore()
    }
  })

  it("does not let a whole replacement invent a token for a legacy row", () => {
    threadDb.getDb().run(
      `INSERT INTO threads (thread_id, created_at, updated_at, metadata, status)
       VALUES ('legacy-tokenless', 77, 77, '{}', 'idle')`
    )

    const updated = threadDb.updateThread("legacy-tokenless", {
      metadata: JSON.stringify({
        workspacePath: "C:/repo",
        [THREAD_INCARNATION_METADATA_KEY]: "caller-chosen"
      })
    })

    expect(captureThreadIncarnation(updated!).token).toBeNull()
    expect(JSON.parse(updated?.metadata ?? "{}")).not.toHaveProperty(
      THREAD_INCARNATION_METADATA_KEY
    )
  })
})
