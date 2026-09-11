import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
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
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cmb-thread-page-bytes-"))
  storageState.databasePath = join(temporaryDirectory, "threads.sqlite")
  await threadDb.initializeDatabase()
})

afterAll(async () => {
  await threadDb.closeDatabase()
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

describe("thread message page byte budget", () => {
  it("materializes only a bounded suffix of 500 legal 120k rows", () => {
    const threadId = "large-page"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    const content = "界".repeat(120_000)
    database.run(
      `WITH RECURSIVE numbers(value) AS (
         SELECT 0
         UNION ALL
         SELECT value + 1 FROM numbers WHERE value < 499
       )
       INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       )
       SELECT ?, printf('large-%04d', value), 'assistant', json_quote(?), value, value
       FROM numbers`,
      [threadId, content]
    )
    database.run(
      `INSERT OR REPLACE INTO thread_message_buckets (
         thread_id, message_count, next_ordinal, updated_at
       ) VALUES (?, 500, 500, ?)`,
      [threadId, Date.now()]
    )

    const originalJsonParse = JSON.parse
    let parsedRows = 0
    JSON.parse = ((text, reviver) => {
      if (text.length > 100_000) parsedRows += 1
      return originalJsonParse(text, reviver)
    }) as typeof JSON.parse
    let firstPage: ReturnType<typeof threadDb.getThreadMessagesPage>
    try {
      firstPage = threadDb.getThreadMessagesPage(threadId)
    } finally {
      JSON.parse = originalJsonParse
    }
    expect(firstPage.messages.length).toBeGreaterThan(0)
    expect(firstPage.messages.length).toBeLessThanOrEqual(12)
    expect(parsedRows).toBe(firstPage.messages.length)
    expect(firstPage.hasMore).toBe(true)
    expect(firstPage.total).toBe(500)
    expect(firstPage.messages.at(-1)?.id).toBe("large-0499")

    const secondPage = threadDb.getThreadMessagesPage(threadId, {
      beforeOrdinal: firstPage.beforeOrdinal ?? undefined,
      beforeMessageId: firstPage.beforeMessageId ?? undefined
    })
    expect(secondPage.messages.length).toBeGreaterThan(0)
    expect(
      secondPage.messages.some((message) =>
        firstPage.messages.some((first) => first.id === message.id)
      )
    ).toBe(false)
    expect(secondPage.messages.at(-1)?.id).not.toBe(firstPage.messages.at(-1)?.id)
  }, 30_000)

  it("returns one oversized row alone and advances its cursor", () => {
    const threadId = "oversized-page"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    const oversized = "x".repeat(threadDb.THREAD_MESSAGES_PAGE_BYTE_BUDGET + 1)
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (?, 'oversized-0', 'assistant', json_quote(?), 0, 0),
                (?, 'oversized-1', 'assistant', '"small"', 1, 1)`,
      [threadId, oversized, threadId]
    )
    database.run(
      `INSERT OR REPLACE INTO thread_message_buckets (
         thread_id, message_count, next_ordinal, updated_at
       ) VALUES (?, 2, 2, ?)`,
      [threadId, Date.now()]
    )
    const latest = threadDb.getThreadMessagesPage(threadId)
    expect(latest.messages.map((message) => message.id)).toEqual(["oversized-1"])
    const older = threadDb.getThreadMessagesPage(threadId, {
      beforeOrdinal: latest.beforeOrdinal ?? undefined,
      beforeMessageId: latest.beforeMessageId ?? undefined
    })
    expect(older.messages).toHaveLength(1)
    expect(older.messages[0].id).toBe("oversized-0")
    expect(older.hasMore).toBe(false)
  }, 30_000)
})
