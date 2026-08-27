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

let temporaryDirectory = ""

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "thread-message-count-"))
  storageState.databasePath = join(temporaryDirectory, "threads.sqlite")
  await threadDb.initializeDatabase()
})

afterAll(async () => {
  await threadDb.closeDatabase()
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

describe("thread message count", () => {
  it("reads only the bucket and never parses a huge message or its fragments", () => {
    const threadId = "huge-first-message"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (?, 'huge', 'assistant', ?, 0, 0)`,
      [threadId, `"${"x".repeat(2 * 1024 * 1024)}"`]
    )
    database.run(
      `INSERT INTO thread_message_fragments (
         thread_id, message_id, content_text, created_at
       ) VALUES (?, 'huge', ?, 0)`,
      [threadId, "y".repeat(2 * 1024 * 1024)]
    )
    database.run(
      `INSERT OR REPLACE INTO thread_message_buckets (
         thread_id, message_count, next_ordinal, updated_at
       ) VALUES (?, 1, 1, ?)`,
      [threadId, Date.now()]
    )

    const originalParse = JSON.parse
    JSON.parse = (() => {
      throw new Error("message count must not parse content")
    }) as typeof JSON.parse
    try {
      expect(threadDb.getThreadMessageCount(threadId)).toBe(1)
      expect(threadDb.hasThreadMessages(threadId)).toBe(true)
    } finally {
      JSON.parse = originalParse
    }
  })

  it("repairs a missing legacy bucket with COUNT without reading message payloads", () => {
    const threadId = "missing-legacy-bucket"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (?, 'legacy-huge', 'assistant', ?, 0, 7)`,
      [threadId, `"${"z".repeat(2 * 1024 * 1024)}"`]
    )
    database.run("DELETE FROM thread_message_buckets WHERE thread_id = ?", [threadId])

    const originalParse = JSON.parse
    JSON.parse = (() => {
      throw new Error("bucket repair must not parse content")
    }) as typeof JSON.parse
    try {
      expect(threadDb.getThreadMessageCount(threadId)).toBe(1)
    } finally {
      JSON.parse = originalParse
    }
    const repaired = database.prepare(
      "SELECT message_count, next_ordinal FROM thread_message_buckets WHERE thread_id = ?"
    )
    repaired.bind([threadId])
    try {
      expect(repaired.step()).toBe(true)
      expect(repaired.getAsObject()).toMatchObject({ message_count: 1, next_ordinal: 8 })
    } finally {
      repaired.free()
    }
  })
})
