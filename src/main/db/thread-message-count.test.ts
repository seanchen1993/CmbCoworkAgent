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
import { WORKFLOW_NOTIFICATION_TURN_PROMPT } from "../../shared/checkpoint-transcript"
import { GOAL_USER_MESSAGE_EVENT_PREFIX } from "../../shared/goal-events"

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

  it("distinguishes internal plumbing rows from a visible conversation", () => {
    const threadId = "internal-only-transcript"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    const insert = database.prepare(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    const internalRows = [
      {
        id: "goal-prompt",
        role: "user",
        content:
          "[Continuing active goal]\n<untrusted_objective>keep working</untrusted_objective>"
      },
      {
        id: "goal-notice",
        role: "system",
        content: "Goal 已继续：keep working"
      },
      {
        id: "workflow-trigger",
        role: "user",
        content: WORKFLOW_NOTIFICATION_TURN_PROMPT
      }
    ] as const
    internalRows.forEach((row, ordinal) => {
      insert.bind([
        threadId,
        row.id,
        row.role,
        JSON.stringify(row.content),
        ordinal,
        ordinal
      ])
      insert.step()
      insert.reset()
    })
    insert.free()
    database.run(
      `INSERT OR REPLACE INTO thread_message_buckets (
         thread_id, message_count, next_ordinal, updated_at
       ) VALUES (?, ?, ?, ?)`,
      [threadId, internalRows.length, internalRows.length, Date.now()]
    )

    expect(threadDb.getThreadMessageCount(threadId)).toBe(3)
    expect(threadDb.hasVisibleThreadMessages(threadId)).toBe(false)
    expect(
      threadDb.getThreadMessagesPage(threadId, {
        limit: 1,
        includeVisibleMessagePresence: true
      })
    ).toMatchObject({
      hasVisibleMessages: false,
      legacyCheckpointMigrationStatus: null
    })
    expect(threadDb.getThreadMessagesPage(threadId, { limit: 1 }).hasVisibleMessages).toBeUndefined()

    database.run(
      `INSERT INTO legacy_checkpoint_transcript_migrations (
         thread_id, checkpoint_id, total_messages, next_index,
         current_fragment_index, status, updated_at
       ) VALUES (?, 'checkpoint-1', 4, 3, 0, 'migrating', ?)`,
      [threadId, Date.now()]
    )
    expect(threadDb.getLegacyCheckpointMigrationStatus(threadId)).toBe("migrating")
    expect(
      threadDb.getThreadMessagesPage(threadId, {
        limit: 1,
        includeVisibleMessagePresence: true
      }).legacyCheckpointMigrationStatus
    ).toBe("migrating")

    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (?, 'real-user', 'user', ?, 4, 4)`,
      [threadId, JSON.stringify("请修复这个问题")]
    )
    database.run(
      `UPDATE thread_message_buckets
       SET message_count = 4, next_ordinal = 5, updated_at = ?
       WHERE thread_id = ?`,
      [Date.now(), threadId]
    )

    expect(threadDb.hasVisibleThreadMessages(threadId)).toBe(true)
    database.run(
      `UPDATE legacy_checkpoint_transcript_migrations
       SET next_index = total_messages, status = 'complete', updated_at = ?
       WHERE thread_id = ?`,
      [Date.now(), threadId]
    )
    expect(threadDb.getLegacyCheckpointMigrationStatus(threadId)).toBe("complete")
  })

  it("fails closed without scanning an unbounded internal-only transcript on main", () => {
    const threadId = "bounded-internal-only-transcript"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    const insert = database.prepare(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (?, ?, 'user', ?, ?, ?)`
    )
    for (let ordinal = 0; ordinal <= threadDb.THREAD_MODE_VISIBLE_MESSAGE_SCAN_LIMIT; ordinal += 1) {
      insert.bind([
        threadId,
        `internal-${ordinal}`,
        JSON.stringify(WORKFLOW_NOTIFICATION_TURN_PROMPT),
        ordinal,
        ordinal
      ])
      insert.step()
      insert.reset()
    }
    insert.free()
    const count = threadDb.THREAD_MODE_VISIBLE_MESSAGE_SCAN_LIMIT + 1
    database.run(
      `INSERT OR REPLACE INTO thread_message_buckets (
         thread_id, message_count, next_ordinal, updated_at
       ) VALUES (?, ?, ?, ?)`,
      [threadId, count, count, Date.now()]
    )

    expect(threadDb.getBoundedThreadVisibleMessagePresence(threadId)).toBe("unknown")
    expect(threadDb.hasVisibleThreadMessages(threadId)).toBe(true)
  })

  it("counts restored starting-goal and sidecar user bubbles as conversation state", () => {
    const database = threadDb.getDb()
    const startingThreadId = "starting-goal-presence"
    threadDb.createThread(startingThreadId)
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (?, 'starting-goal', 'user', ?, 0, 0)`,
      [
        startingThreadId,
        JSON.stringify(
          "[Starting active goal]\n<untrusted_objective>ship it</untrusted_objective>"
        )
      ]
    )
    expect(threadDb.getBoundedThreadConversationPresence(startingThreadId)).toBe("nonempty")

    const continuingThreadId = "continuing-goal-presence"
    threadDb.createThread(continuingThreadId)
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (?, 'continuing-goal', 'user', ?, 0, 0)`,
      [
        continuingThreadId,
        JSON.stringify(
          "[Continuing active goal]\n<untrusted_objective>ship it</untrusted_objective>"
        )
      ]
    )
    database.run(
      `INSERT INTO thread_goal_events (thread_id, message, created_at)
       VALUES (?, ?, 0), (?, ?, 1)`,
      [
        continuingThreadId,
        `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal status`,
        continuingThreadId,
        `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal pause`
      ]
    )
    expect(threadDb.getBoundedThreadConversationPresence(continuingThreadId)).toBe("empty")

    database.run(
      `INSERT INTO thread_goal_events (thread_id, message, created_at)
       VALUES (?, ?, 2)`,
      [continuingThreadId, `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal resume`]
    )
    expect(threadDb.getBoundedThreadConversationPresence(continuingThreadId)).toBe("nonempty")
  })

  it("does not transfer or parse an oversized transcript row on Electron main", () => {
    const threadId = "oversized-mode-presence-row"
    threadDb.createThread(threadId)
    const database = threadDb.getDb()
    database.run(
      `INSERT INTO thread_messages (
         thread_id, message_id, role, content_json, created_at, ordinal
       ) VALUES (?, 'oversized-internal', 'user', ?, 0, 0)`,
      [threadId, JSON.stringify(`${WORKFLOW_NOTIFICATION_TURN_PROMPT}${"x".repeat(2 * 1024 * 1024)}`)]
    )

    const originalParse = JSON.parse
    JSON.parse = (() => {
      throw new Error("oversized presence rows must be classified before JSON parsing")
    }) as typeof JSON.parse
    try {
      expect(threadDb.getBoundedThreadVisibleMessagePresence(threadId)).toBe("unknown")
    } finally {
      JSON.parse = originalParse
    }
  })
})
