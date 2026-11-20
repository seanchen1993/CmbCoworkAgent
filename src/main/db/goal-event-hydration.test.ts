import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it, vi } from "vitest"
import { GOAL_USER_MESSAGE_EVENT_PREFIX } from "../../shared/goal-events"
import { readThreadGoalEventsProjection } from "../thread-metadata-hydration/reader"
import {
  isVisibleCheckpointTranscriptMessage,
  mergeGoalUserEventsIntoDurablePage
} from "../../renderer/src/lib/goal-transcript"
import * as db from "./index"

const storage = vi.hoisted(() => ({ path: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => storage.path,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))

it("restores Goal commands after reopening SQLite without using a different window's anchor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-goal-event-hydration-"))
  storage.path = join(directory, "threads.sqlite")
  const thread = "goal-history"
  const goal = "goal"
  try {
    await db.initializeDatabase()
    db.createThread(thread)
    db.upsertThreadMessages(thread, [
      {
        id: "start",
        role: "user",
        content: "/goal Audit the transcript",
        goal_id: goal,
        active_window_id: "started",
        created_at: new Date(1_000)
      },
      {
        id: "reply",
        role: "assistant",
        content: "First response",
        created_at: new Date(2_000)
      },
      {
        id: "later",
        role: "user",
        content: "Later question",
        created_at: new Date(4_000)
      },
      {
        id: "other-user",
        role: "user",
        content: "Unrelated row in the same window",
        goal_id: goal,
        active_window_id: "resumed-with-row",
        created_at: new Date(5_000)
      },
      {
        id: "resume",
        role: "user",
        content: "/goal resume",
        created_at: new Date(20_000)
      }
    ])
    db.addThreadGoalEvent(
      thread,
      `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal Audit the transcript`,
      goal,
      1_000,
      "started",
      "start"
    )
    db.addThreadGoalEvent(
      thread,
      `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal resume`,
      goal,
      3_000,
      "resume-without-row"
    )
    db.addThreadGoalEvent(
      thread,
      `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal resume`,
      goal,
      5_000,
      "resumed-with-row",
      "resume"
    )
    db.addThreadGoalEvent(
      thread,
      `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal Tail without a user row`,
      "tail-goal",
      21_000,
      "tail"
    )
    await db.closeDatabase()
    await db.initializeDatabase()

    const readerDb = new DatabaseSync(storage.path, { readOnly: true })
    const workerEvents = (() => {
      try {
        return readThreadGoalEventsProjection(readerDb, {
          requestId: 1,
          databasePath: storage.path,
          type: "read-goal-events",
          cancellationBuffer: new SharedArrayBuffer(4),
          threadId: thread,
          restore: true,
          recentLimit: 20,
          scanLimit: 50,
          byteBudget: 512 * 1024
        }).events
      } finally {
        readerDb.close()
      }
    })()
    const fallbackEvents = db.getThreadGoalEventsHydrationFallback(thread, { restore: true })
    expect(fallbackEvents).toEqual(workerEvents)
    expect(
      workerEvents.map((event) => [event.transcript_message_id, event.transcript_ordinal])
    ).toEqual([
      ["start", 0],
      [null, null],
      ["resume", 4],
      [null, null]
    ])

    const latest = db.getThreadMessagesPage(thread, { limit: 3 })
    expect(latest.hasMore).toBe(true)
    if (latest.beforeOrdinal === null || latest.beforeMessageId === null) {
      throw new Error("Expected an earlier durable page")
    }
    const earlier = db.getThreadMessagesPage(thread, {
      limit: 3,
      beforeOrdinal: latest.beforeOrdinal,
      beforeMessageId: latest.beforeMessageId
    })
    const latestVisible = mergeGoalUserEventsIntoDurablePage(
      latest.messages.filter(isVisibleCheckpointTranscriptMessage),
      workerEvents,
      latest.messages,
      { hasEarlierMessages: latest.hasMore }
    )
    const earlierVisible = mergeGoalUserEventsIntoDurablePage(
      earlier.messages.filter(isVisibleCheckpointTranscriptMessage),
      workerEvents,
      earlier.messages,
      {
        hasEarlierMessages: earlier.hasMore,
        newerBoundary: {
          ordinal: latest.beforeOrdinal,
          createdAt: latest.messages[0]?.created_at
        }
      }
    )
    expect([...earlierVisible, ...latestVisible].map((message) => message.content)).toEqual([
      "/goal Audit the transcript",
      "First response",
      "/goal resume",
      "Later question",
      "Unrelated row in the same window",
      "/goal resume",
      "/goal Tail without a user row"
    ])
  } finally {
    await db.closeDatabase()
    rmSync(directory, { recursive: true, force: true })
  }
})
