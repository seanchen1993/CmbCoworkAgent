import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import * as db from "./index"
import { GOAL_USER_MESSAGE_EVENT_PREFIX } from "../../shared/goal-events"
import type { Message } from "../../renderer/src/types"
import {
  getGoalTranscriptPageRange,
  isVisibleCheckpointTranscriptMessage,
  mergeGoalUserEventsIntoDurablePage,
  type GoalTranscriptPageExtent
} from "../../renderer/src/lib/goal-transcript"
import {
  advanceThreadMessageWindowAcrossGap,
  attachThreadMessageGapReload,
  createForwardThreadMessagePageWindow,
  createTargetedThreadMessageWindow,
  createThreadMessagePageWindow,
  prependBoundedThreadMessagePage,
  prependThreadMessagePageWindow,
  restoreLatestThreadMessageWindow,
  type ThreadMessagePageWindow
} from "../../renderer/src/lib/thread-message-pages"

const storage = vi.hoisted(() => ({ path: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => storage.path,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))

it("restores legacy Goal commands across real backward, targeted, and released transcript pages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-goal-page-windows-"))
  storage.path = join(directory, "threads.sqlite")
  const threadId = "goal-pages"
  const rowId = (index: number) => `row-${index}`
  const rowTime = (index: number) => (index + 10) * 1_000
  const limits = { maximumResidentMessages: 1_500, protectedTailMessages: 320 }
  try {
    await db.initializeDatabase()
    db.createThread(threadId)
    db.upsertThreadMessages(
      threadId,
      Array.from({ length: 1_600 }, (_, index) => ({
        id: rowId(index),
        role: index % 2 === 0 ? "user" : "assistant",
        content: `Durable row ${index}`,
        created_at: new Date(rowTime(index))
      })),
      { preserveExistingOrder: true }
    )
    const sidecarByIndex = new Map(
      [590, 599, 1_099, 1_100, 1_471, 1_599].map((index) => {
        const event = db.addThreadGoalEvent(
          threadId,
          `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal resume`,
          "goal",
          rowTime(index) + 1,
          `older-window-${index}`
        )
        return [index, `goal-user-event-${event.event_id}`]
      })
    )
    const events = db
      .getThreadGoalEventsHydrationFallback(threadId, { restore: true })
      .map((event) => ({ ...event, created_at: new Date(event.created_at) }))
    expect(events.every((event) => event.transcript_ordinal === null)).toBe(true)

    const project = (
      page: ReturnType<typeof db.getThreadMessagesPage>,
      extent?: GoalTranscriptPageExtent,
      messages = page.messages.filter(isVisibleCheckpointTranscriptMessage)
    ) =>
      mergeGoalUserEventsIntoDurablePage(
        messages,
        events,
        page.messages,
        getGoalTranscriptPageRange(page.messages, page.hasMore, extent)
      )
    const expectAfter = (messages: readonly Message[], index: number) => {
      const id = sidecarByIndex.get(index)
      const position = messages.findIndex((message) => message.id === id)
      expect(position).toBeGreaterThan(0)
      expect(messages[position - 1].id).toBe(rowId(index))
      if (index < 1_599) expect(messages[position + 1]?.id).toBe(rowId(index + 1))
      expect(messages.filter((message) => message.id === id)).toHaveLength(1)
    }

    let page = db.getThreadMessagesPage(threadId, { limit: 128 })
    const latest = project(page)
    expectAfter(latest, 1_599)
    let resident = latest
    let windows: ThreadMessagePageWindow[] = [createThreadMessagePageWindow(page.messages, null)]
    let gap: ReturnType<typeof attachThreadMessageGapReload> = null
    while (page.beforeOrdinal !== null && page.beforeMessageId !== null) {
      const cursor = { beforeOrdinal: page.beforeOrdinal, beforeMessageId: page.beforeMessageId }
      const createdAt = page.messages[0].created_at
      page = db.getThreadMessagesPage(threadId, { ...cursor, limit: 500 })
      const older = project(page, {
        kind: "backward",
        boundary: { ordinal: cursor.beforeOrdinal, createdAt }
      })
      windows = prependThreadMessagePageWindow(
        windows,
        createThreadMessagePageWindow(page.messages, cursor, createdAt)
      )
      const window = prependBoundedThreadMessagePage(resident, older, {
        ...limits,
        existingGap: gap,
        preferredPrefixBoundaryMessageIds: new Set(windows.map((item) => item.lastMessageId))
      })
      resident = window.messages
      gap = attachThreadMessageGapReload(window.gap, windows)
      if (cursor.beforeOrdinal === 1_472) {
        expectAfter(resident, 1_100)
        expectAfter(resident, 1_471)
      }
    }
    expect(gap?.reloadBeforeOrdinal).toBe(1_472)
    const releasedCursor = {
      beforeOrdinal: gap!.reloadBeforeOrdinal!,
      beforeMessageId: gap!.reloadBeforeMessageId!
    }
    const releasedPage = db.getThreadMessagesPage(threadId, { ...releasedCursor, limit: 500 })
    const releasedWindow = advanceThreadMessageWindowAcrossGap(resident, releasedPage.messages, {
      ...limits,
      gap: gap!
    })
    const released = project(
      releasedPage,
      {
        kind: "backward",
        boundary: {
          ordinal: releasedCursor.beforeOrdinal,
          createdAt: windows.find((window) => window.firstMessageId === gap!.reloadTargetMessageId)
            ?.beforeCreatedAt
        }
      },
      releasedWindow.messages
    )
    expectAfter(released, 1_100)
    expectAfter(released, 1_471)

    const targetId = rowId(599)
    const target = db.getThreadMessagesPage(threadId, { targetMessageId: targetId, limit: 500 })
    const targeted = createTargetedThreadMessageWindow(released, target.messages, {
      ...limits,
      targetMessageId: targetId,
      existingGap: releasedWindow.gap
    })
    resident = project(target, { kind: "target" }, targeted.messages)
    expectAfter(resident, 590)
    expect(resident.some((message) => message.id === sidecarByIndex.get(599))).toBe(false)
    expect(targeted.gap?.afterMessageId).toBe(targetId)

    windows = [
      createThreadMessagePageWindow(target.messages, { targetMessageId: targetId }),
      createForwardThreadMessagePageWindow(targetId)!,
      windows.at(-1)!
    ]
    gap = attachThreadMessageGapReload(targeted.gap, windows)
    for (const expectedAnchor of [599, 1_099]) {
      const anchorMessageId = gap?.reloadAnchorMessageId
      expect(anchorMessageId).toBe(rowId(expectedAnchor))
      const anchor = resident.find((message) => message.id === anchorMessageId)
      const forward = db.getThreadMessagesPage(threadId, {
        anchorMessageId: anchorMessageId!,
        limit: 500
      })
      expect(forward.verifiedAnchorMessageId).toBe(anchorMessageId)
      const window = advanceThreadMessageWindowAcrossGap(resident, forward.messages, {
        ...limits,
        gap: gap!
      })
      resident = project(forward, { kind: "forward", anchor }, window.messages)
      // Forward advances release the old prefix. The event follows the
      // released anchor and must lead the next visible page.
      expect(resident[0].id).toBe(sidecarByIndex.get(expectedAnchor))
      expect(resident[1].id).toBe(rowId(expectedAnchor + 1))
      const descriptor = createThreadMessagePageWindow(forward.messages, {
        anchorMessageId: anchorMessageId!
      })
      windows = [
        descriptor,
        createForwardThreadMessagePageWindow(descriptor.lastMessageId)!,
        windows.at(-1)!
      ]
      gap = attachThreadMessageGapReload(window.gap, windows)
    }
    expect(gap).toBeNull()
    expectAfter(resident, 1_100)
    expectAfter(resident, 1_471)
    expectAfter(resident, 1_599)

    const latestPage = db.getThreadMessagesPage(threadId, { limit: 500 })
    const returned = restoreLatestThreadMessageWindow(targeted.messages, latestPage.messages, {
      maximumResidentMessages: limits.maximumResidentMessages,
      protectedLocalTailMessages: limits.protectedTailMessages,
      existingGap: targeted.gap
    })
    const returnedLatest = project(latestPage, undefined, returned.messages)
    expectAfter(returnedLatest, 1_100)
    expectAfter(returnedLatest, 1_599)
    expect(project(latestPage, undefined, returnedLatest)).toBe(returnedLatest)
  } finally {
    await db.closeDatabase()
    rmSync(directory, { recursive: true, force: true })
  }
})
