import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Message, ThreadMessagesPage } from "../types"
import { readThreadMessagesPage } from "../thread-message-hydration/page-reader"

const { readPageMock } = vi.hoisted(() => ({ readPageMock: vi.fn() }))

vi.mock("../thread-message-hydration/client", () => ({
  readThreadMessagesPageInWorker: readPageMock
}))

import { recoverMainCheckpointMessages } from "./checkpoint-message-recovery"

const temporaryDirectories: string[] = []
const databases: DatabaseSync[] = []

afterEach(() => {
  readPageMock.mockReset()
  for (const database of databases.splice(0)) database.close()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function persistedMessage(id: string, role: Message["role"] = "user"): Message {
  return {
    id,
    role,
    content: id,
    created_at: new Date("2026-08-28T00:00:00.000Z")
  }
}

function page(
  messages: Message[],
  options: Partial<ThreadMessagesPage> = {}
): ThreadMessagesPage {
  return {
    messages,
    beforeOrdinal: null,
    beforeMessageId: null,
    hasMore: false,
    total: messages.length,
    legacyCheckpointMigrationStatus: "complete",
    ...options
  }
}

function recoveryContext(options: { interrupt?: boolean; expected?: number } = {}) {
  return {
    threadId: "thread-recovery",
    checkpointNs: "",
    checkpointId: "cp-boundary",
    missingCheckpointId: "cp-parent",
    expectedMessageCount: options.expected ?? 2,
    hasInterrupt: options.interrupt ?? false,
    requiresExactRecovery: options.interrupt ?? false,
    checkpointTs: "2026-08-28T00:00:00.000Z"
  }
}

function createHydrationDatabase(): { database: DatabaseSync; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "cmb-recovery-boundary-"))
  temporaryDirectories.push(directory)
  const path = join(directory, "threads.sqlite")
  const database = new DatabaseSync(path)
  databases.push(database)
  database.exec(`
    CREATE TABLE thread_messages (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      provider_source_id TEXT,
      provider_occurrence INTEGER,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      tool_calls_json TEXT,
      tool_call_id TEXT,
      name TEXT,
      status TEXT,
      is_error INTEGER,
      content_priority INTEGER,
      goal_id TEXT,
      active_window_id TEXT,
      created_at INTEGER NOT NULL,
      start_at INTEGER,
      end_at INTEGER,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY(thread_id, message_id)
    );
    CREATE TABLE thread_message_buckets (
      thread_id TEXT PRIMARY KEY,
      message_count INTEGER NOT NULL,
      next_ordinal INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE thread_message_fragments (
      fragment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      content_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE thread_message_fragment_states (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      total_chars INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(thread_id, message_id)
    );
    CREATE TABLE legacy_checkpoint_transcript_migrations (
      thread_id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL,
      total_messages INTEGER NOT NULL,
      next_index INTEGER NOT NULL,
      current_fragment_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE thread_goal_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      goal_id TEXT,
      active_window_id TEXT,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)
  return { database, path }
}

function insertHydrationMessage(
  database: DatabaseSync,
  id: string,
  ordinal: number,
  createdAt: number
): void {
  database
    .prepare(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES ('legacy', ?, 'user', ?, ?, ?)`
    )
    .run(id, JSON.stringify(id), createdAt, ordinal)
}

describe("checkpoint message recovery source", () => {
  it("uses a bounded checkpoint fence and removes duplicate durable ids", async () => {
    readPageMock.mockImplementation(async (_threadId, options) => {
      expect(options).toMatchObject({
        limit: 1_000,
        byteBudget: 4 * 1024 * 1024,
        includeVisibleMessagePresence: true,
        notAfterCreatedAt: Date.parse("2026-08-28T00:00:00.000Z"),
        recoveryCheckpointId: "cp-boundary"
      })
      return page([
        persistedMessage("u-1"),
        persistedMessage("u-1"),
        persistedMessage("a-1", "assistant")
      ])
    })

    const recovered = await recoverMainCheckpointMessages(recoveryContext())
    expect(recovered?.messages.map((message) => (message as { id?: string }).id)).toEqual([
      "u-1",
      "a-1"
    ])
    expect(recovered?.complete).toBe(true)
    expect(recovered?.boundedByHistory).toBe(false)
  })

  it("fails closed while legacy transcript migration is incomplete", async () => {
    readPageMock.mockResolvedValue(
      page([persistedMessage("u-partial")], {
        legacyCheckpointMigrationStatus: "migrating"
      })
    )
    await expect(recoverMainCheckpointMessages(recoveryContext())).resolves.toBeNull()
  })

  it("fails closed when an interrupt has a complete but stale durable tail", async () => {
    readPageMock.mockResolvedValue(
      page([persistedMessage("u-1"), persistedMessage("a-1", "assistant")])
    )
    await expect(
      recoverMainCheckpointMessages(recoveryContext({ interrupt: true, expected: 1 }))
    ).resolves.toBeNull()
  })

  it("does not replace a nonempty checkpoint from an empty unbootstrapped transcript", async () => {
    readPageMock.mockResolvedValue(
      page([], {
        legacyCheckpointMigrationStatus: null
      })
    )
    await expect(recoverMainCheckpointMessages(recoveryContext())).resolves.toBeNull()
  })

  it("rejects durable rows beyond the external checkpoint marker", async () => {
    readPageMock.mockResolvedValue(
      page([persistedMessage("u-1"), persistedMessage("a-1", "assistant")])
    )
    await expect(
      recoverMainCheckpointMessages({
        ...recoveryContext({ expected: 1 }),
        requiresExactRecovery: false
      })
    ).resolves.toBeNull()
  })

  it("never persists an oversized message preview as checkpoint authority", async () => {
    readPageMock.mockResolvedValue(
      page([persistedMessage("oversized-preview")], {
        hasMore: false,
        truncatedMessageIds: ["oversized-preview"]
      })
    )
    await expect(
      recoverMainCheckpointMessages({
        ...recoveryContext({ expected: 1 }),
        requiresExactRecovery: false
      })
    ).resolves.toBeNull()
  })
})

describe("checkpoint recovery hydration boundary", () => {
  it("excludes a durable user row written after the checkpoint", () => {
    const { database, path } = createHydrationDatabase()
    const checkpointTime = Date.parse("2026-08-28T00:00:00.000Z")
    insertHydrationMessage(database, "checkpoint-user", 0, checkpointTime - 1)
    insertHydrationMessage(database, "current-question", 1, checkpointTime + 1)
    database
      .prepare(
        `INSERT INTO thread_message_buckets
         (thread_id, message_count, next_ordinal, updated_at) VALUES ('legacy', 2, 2, ?)`
      )
      .run(checkpointTime)

    const result = readThreadMessagesPage(database, {
      type: "read-page",
      requestId: 1,
      databasePath: path,
      threadId: "legacy",
      options: {
        limit: 10,
        byteBudget: 512 * 1024,
        includeVisibleMessagePresence: true,
        notAfterCreatedAt: checkpointTime,
        recoveryCheckpointId: "cp-current"
      },
      cancellationBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    })

    expect(result.page.messages.map((message) => message.id)).toEqual(["checkpoint-user"])
  })

  it("keeps every completed legacy row even when created_at advances past checkpoint ts", () => {
    const { database, path } = createHydrationDatabase()
    const checkpointTime = Date.parse("2026-08-28T00:00:00.000Z")
    insertHydrationMessage(database, "legacy-0", 0, checkpointTime)
    insertHydrationMessage(database, "legacy-1", 1, checkpointTime + 1)
    insertHydrationMessage(database, "legacy-2", 2, checkpointTime + 2)
    insertHydrationMessage(database, "future-user", 3, checkpointTime + 100)
    database
      .prepare(
        `INSERT INTO thread_message_buckets
         (thread_id, message_count, next_ordinal, updated_at) VALUES ('legacy', 4, 4, ?)`
      )
      .run(checkpointTime)
    database
      .prepare(
        `INSERT INTO legacy_checkpoint_transcript_migrations
         (thread_id, checkpoint_id, total_messages, next_index,
          current_fragment_index, status, updated_at)
         VALUES ('legacy', 'cp-legacy', 3, 3, 0, 'complete', ?)`
      )
      .run(checkpointTime)

    const result = readThreadMessagesPage(database, {
      type: "read-page",
      requestId: 1,
      databasePath: path,
      threadId: "legacy",
      options: {
        limit: 10,
        byteBudget: 512 * 1024,
        includeVisibleMessagePresence: true,
        notAfterCreatedAt: checkpointTime,
        recoveryCheckpointId: "cp-legacy"
      },
      cancellationBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    })

    expect(result.page.messages.map((message) => message.id)).toEqual([
      "legacy-0",
      "legacy-1",
      "legacy-2"
    ])
    expect(result.page.legacyCheckpointMigrationStatus).toBe("complete")
    expect(result.page.hasMore).toBe(false)
  })
})
