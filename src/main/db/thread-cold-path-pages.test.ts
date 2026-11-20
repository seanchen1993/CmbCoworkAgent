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
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cmb-thread-cold-pages-"))
  storageState.databasePath = join(temporaryDirectory, "threads.sqlite")
  await threadDb.initializeDatabase()
})

afterAll(async () => {
  await threadDb.closeDatabase()
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

describe("thread cold-path bounded pages", () => {
  it("limits durable tail parsing before poison rows", () => {
    const threadId = "bounded-durable-tail"
    threadDb.createThread(threadId, { title: "Bounded durable tail" })
    threadDb.upsertThreadMessages(
      threadId,
      Array.from({ length: 1_205 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: index <= 1_001 ? `safe-${index}` : `TAIL_POISON_${index}`,
        created_at: new Date(index)
      })),
      { preserveExistingOrder: true }
    )

    const originalJsonParse = JSON.parse
    JSON.parse = ((text, reviver) => {
      if (text.includes("TAIL_POISON")) {
        throw new Error("bounded durable-tail lookup parsed beyond LIMIT")
      }
      return originalJsonParse(text, reviver)
    }) as typeof JSON.parse
    try {
      const tail = threadDb.getThreadMessagesAfterAnyId(threadId, ["message-0"], 1_001)
      expect(tail).toHaveLength(1_001)
      expect(tail.at(-1)?.id).toBe("message-1001")
    } finally {
      JSON.parse = originalJsonParse
    }
  })

  it("copies a manifest bucket through advancing bounded keyset pages", () => {
    const sourceThreadId = "subagent-page-source"
    const targetThreadId = "subagent-page-target"
    const subagentId = "execution-1"
    threadDb.createThread(sourceThreadId, { title: "Source" })
    threadDb.createThread(targetThreadId, { title: "Target" })
    threadDb.upsertThreadSubagentManifestMessages(
      sourceThreadId,
      subagentId,
      Array.from({ length: 301 }, (_, index) => ({
        id: `manifest-${index}`,
        role: "assistant",
        content: `manifest ${index}`
      }))
    )

    let cursor: Parameters<typeof threadDb.copyThreadSubagentManifestRowsPage>[0]["after"]
    let copied = 0
    let pages = 0
    while (true) {
      const page = threadDb.copyThreadSubagentManifestRowsPage({
        sourceThreadId,
        targetThreadId,
        subagentId,
        after: cursor,
        limit: 50
      })
      expect(page.copied).toBeLessThanOrEqual(50)
      copied += page.copied
      pages += 1
      if (!page.hasMore) break
      expect(page.nextCursor).toBeDefined()
      cursor = page.nextCursor
    }

    expect(copied).toBe(301)
    expect(pages).toBe(7)
    const targetPage = threadDb.getThreadSubagentManifestPage(
      targetThreadId,
      subagentId,
      undefined,
      500
    )
    expect(targetPage.total).toBe(301)
    expect(targetPage.messages).toHaveLength(301)
  })
})
