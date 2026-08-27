import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  createForwardThreadMessagePageWindow
} from "../../renderer/src/lib/thread-message-pages"

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
  temporaryDirectory = mkdtempSync(join(tmpdir(), "cmb-thread-forward-page-"))
  storageState.databasePath = join(temporaryDirectory, "threads.sqlite")
  await threadDb.initializeDatabase()
})

afterAll(async () => {
  await threadDb.closeDatabase()
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

function insertOrdinalRows(
  threadId: string,
  rows: ReadonlyArray<{ id: string; ordinal: number }>
): void {
  threadDb.createThread(threadId)
  const database = threadDb.getDb()
  database.run("BEGIN")
  try {
    for (const row of rows) {
      database.run(
        `INSERT INTO thread_messages (
           thread_id, message_id, role, content_json, created_at, ordinal
         ) VALUES (?, ?, 'assistant', ?, ?, ?)`,
        [threadId, row.id, JSON.stringify(row.id), row.ordinal, row.ordinal]
      )
    }
    const nextOrdinal = rows.reduce((maximum, row) => Math.max(maximum, row.ordinal + 1), 0)
    database.run(
      `INSERT OR REPLACE INTO thread_message_buckets (
         thread_id, message_count, next_ordinal, updated_at
       ) VALUES (?, ?, ?, ?)`,
      [threadId, rows.length, nextOrdinal, Date.now()]
    )
    database.run("COMMIT")
  } catch (error) {
    database.run("ROLLBACK")
    throw error
  }
}

function readWindow(threadId: string, boundaryId: string) {
  const descriptor = createForwardThreadMessagePageWindow(boundaryId)
  expect(descriptor?.reloadCursor).not.toBeNull()
  const cursor = descriptor?.reloadCursor
  if (!cursor) throw new Error("forward cursor was not created")
  return {
    descriptor,
    page: threadDb.getThreadMessagesPage(threadId, { ...cursor, limit: 500 })
  }
}

describe("thread message explicit forward pages", () => {
  it("verifies the dense anchor and returns two strictly newer 500-row steps", () => {
    const threadId = "dense-forward-pages"
    insertOrdinalRows(
      threadId,
      Array.from({ length: 1_200 }, (_, ordinal) => ({
        id: `dense-${ordinal.toString().padStart(4, "0")}`,
        ordinal
      }))
    )

    const first = readWindow(threadId, "dense-0100")
    expect(first.descriptor.reloadCursor).toEqual({ anchorMessageId: "dense-0100" })
    expect(first.page.verifiedAnchorMessageId).toBe("dense-0100")
    expect(first.page.messages[0]?.id).toBe("dense-0101")
    expect(first.page.messages.at(-1)?.id).toBe("dense-0600")

    const second = readWindow(threadId, "dense-0600")
    expect(second.descriptor.reloadCursor).toEqual({ anchorMessageId: "dense-0600" })
    expect(second.page.verifiedAnchorMessageId).toBe("dense-0600")
    expect(second.page.messages[0]?.id).toBe("dense-0601")
    expect(second.page.messages.at(-1)?.id).toBe("dense-1100")
  })

  it("continues through repeated ordinals without skipping the overlap boundary", () => {
    const threadId = "duplicate-ordinal-forward-page"
    insertOrdinalRows(threadId, [
      { id: "duplicate-boundary", ordinal: 100 },
      ...Array.from({ length: 501 }, (_, index) => ({
        id: `duplicate-top-${index.toString().padStart(4, "0")}`,
        ordinal: 599
      }))
    ])

    const first = readWindow(threadId, "duplicate-boundary")
    expect(first.page.messages).toHaveLength(500)
    expect(first.page.verifiedAnchorMessageId).toBe("duplicate-boundary")
    expect(first.page.messages[0]?.id).toBe("duplicate-top-0000")
    const second = readWindow(
      threadId,
      first.page.messages.at(-1)?.id ?? "missing-page-tail"
    )
    expect(second.page.verifiedAnchorMessageId).toBe(first.page.messages.at(-1)?.id)
    expect(second.page.messages.at(-1)?.id).toBe("duplicate-top-0500")
    expect(
      new Set([...first.page.messages, ...second.page.messages].map((message) => message.id)).size
    ).toBe(501)
    expect(
      new Set([
        "duplicate-boundary",
        ...first.page.messages.map((message) => message.id),
        ...second.page.messages.map((message) => message.id)
      ]).size
    ).toBe(502)
  })

  it("advances sparse ordinals from the exact verified page tail", () => {
    const threadId = "sparse-ordinal-forward-page"
    insertOrdinalRows(threadId, [
      { id: "sparse-boundary", ordinal: 100 },
      { id: "sparse-0150", ordinal: 150 },
      { id: "sparse-0300", ordinal: 300 },
      { id: "sparse-0598", ordinal: 598 },
      ...Array.from({ length: 499 }, (_, index) => {
        const ordinal = 600 + index
        return { id: `sparse-${ordinal.toString().padStart(4, "0")}`, ordinal }
      })
    ])

    const first = readWindow(threadId, "sparse-boundary")
    expect(
      first.page.verifiedAnchorMessageId
    ).toBe("sparse-boundary")
    expect(first.page.messages[0]?.id).toBe("sparse-0150")
    expect(first.page.messages.at(-1)?.id).toBe("sparse-1096")

    const second = readWindow(threadId, "sparse-1096")
    expect(second.page.messages[0]?.id).toBe("sparse-1097")
    expect(second.page.messages.at(-1)?.id).toBe("sparse-1098")
    expect(second.page.verifiedAnchorMessageId).toBe("sparse-1096")
    expect(
      new Set([...first.page.messages, ...second.page.messages].map((message) => message.id)).size
    ).toBe(502)
    expect(
      new Set([
        "sparse-boundary",
        ...first.page.messages.map((message) => message.id),
        ...second.page.messages.map((message) => message.id)
      ]).size
    ).toBe(503)
  })

  it("does not let an oversized anchor body consume the forward byte budget", () => {
    const threadId = "oversized-forward-anchor"
    insertOrdinalRows(threadId, [
      { id: "oversized-anchor", ordinal: 0 },
      { id: "newer-one", ordinal: 1 },
      { id: "newer-two", ordinal: 2 }
    ])
    threadDb.getDb().run(
      "UPDATE thread_messages SET content_json = ? WHERE thread_id = ? AND message_id = ?",
      [JSON.stringify("x".repeat(2_000_000)), threadId, "oversized-anchor"]
    )

    const page = threadDb.getThreadMessagesPage(threadId, {
      anchorMessageId: "oversized-anchor",
      limit: 2,
      byteBudget: 4_096
    })
    expect(page.verifiedAnchorMessageId).toBe("oversized-anchor")
    expect(page.messages.map((message) => message.id)).toEqual(["newer-one", "newer-two"])
    expect(page.messages.some((message) => message.id === "oversized-anchor")).toBe(false)
    const end = threadDb.getThreadMessagesPage(threadId, {
      anchorMessageId: "newer-two",
      limit: 2,
      byteBudget: 4_096
    })
    expect(end).toMatchObject({
      messages: [],
      hasMore: false,
      verifiedAnchorMessageId: "newer-two"
    })
    expect(() =>
      threadDb.getThreadMessagesPage(threadId, { anchorMessageId: "missing-anchor" })
    ).toThrow(/anchor was not found/)
    expect(() =>
      threadDb.getThreadMessagesPage(threadId, {
        anchorMessageId: "oversized-anchor",
        beforeOrdinal: 1,
        beforeMessageId: "newer-one"
      })
    ).toThrow(/mutually exclusive/)
  })
})
