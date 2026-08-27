import { describe, expect, it } from "vitest"
import type { Message } from "../types"
import {
  advanceThreadMessageWindowAcrossGap,
  attachThreadMessageGapReload,
  createForwardThreadMessagePageWindow,
  createThreadMessagePageWindow,
  createTargetedThreadMessageWindow,
  isThreadMessageForwardPageProgress,
  prependBoundedThreadMessagePage,
  prependThreadMessagePageWindow,
  restoreLatestThreadMessageWindow,
  upsertLatestThreadMessagePageWindow
} from "./thread-message-pages"

const createdAt = new Date("2026-08-21T00:00:00.000Z")
const message = (id: string): Message => ({
  id,
  role: "assistant",
  content: id,
  created_at: createdAt
})

describe("resident thread message windows", () => {
  it("requires both a verified anchor and a strictly newer row for forward progress", () => {
    expect(isThreadMessageForwardPageProgress([], "anchor", "anchor")).toBe(false)
    expect(
      isThreadMessageForwardPageProgress([message("newer")], "wrong", "anchor")
    ).toBe(false)
    expect(
      isThreadMessageForwardPageProgress([message("newer")], "anchor", "anchor")
    ).toBe(true)
  })

  it("bounds repeated older-page loads while protecting the live tail", () => {
    const tail = Array.from({ length: 300 }, (_, index) => message(`tail-${index}`))
    const firstPage = Array.from({ length: 500 }, (_, index) => message(`older-${index}`))
    const first = prependBoundedThreadMessagePage(tail, firstPage, {
      maximumResidentMessages: 600,
      protectedTailMessages: 100
    })
    const secondPage = Array.from({ length: 500 }, (_, index) => message(`ancient-${index}`))
    const second = prependBoundedThreadMessagePage(first.messages, secondPage, {
      maximumResidentMessages: 600,
      protectedTailMessages: 100,
      existingGap: first.gap
    })

    expect(first.messages).toHaveLength(600)
    expect(first.messages.slice(-3).map((item) => item.id)).toEqual([
      "tail-297",
      "tail-298",
      "tail-299"
    ])
    expect(first.gap).toEqual({
      afterMessageId: "older-499",
      beforeMessageId: "tail-200",
      evictedMessageCount: 200,
      reloadBeforeOrdinal: null,
      reloadBeforeMessageId: null,
      reloadAnchorMessageId: null,
      reloadTargetMessageId: null
    })
    expect(second.messages).toHaveLength(600)
    expect(second.messages[0].id).toBe("ancient-0")
    expect(second.messages[500].id).toBe("tail-200")
    expect(second.gap?.evictedMessageCount).toBe(700)
  })

  it("hydrates an evicted search result and can return to the latest window", () => {
    const resident = Array.from({ length: 600 }, (_, index) => message(`resident-${index}`))
    const targetPage = Array.from({ length: 240 }, (_, index) => message(`target-${index}`))
    const targeted = createTargetedThreadMessageWindow(resident, targetPage, {
      targetMessageId: "target-200",
      protectedTailMessages: 100,
      maximumResidentMessages: 600
    })
    const secondTargetPage = Array.from({ length: 240 }, (_, index) =>
      message(`second-target-${index}`)
    )
    const retargeted = createTargetedThreadMessageWindow(targeted.messages, secondTargetPage, {
      targetMessageId: "second-target-200",
      protectedTailMessages: 100,
      maximumResidentMessages: 600,
      existingGap: targeted.gap
    })
    const latestPage = Array.from({ length: 500 }, (_, index) => message(`latest-${index}`))
    const restored = restoreLatestThreadMessageWindow(retargeted.messages, latestPage, {
      maximumResidentMessages: 600,
      protectedLocalTailMessages: 100,
      existingGap: retargeted.gap
    })

    expect(targeted.messages.some((item) => item.id === "target-200")).toBe(true)
    expect(targeted.messages.slice(-1)[0].id).toBe("resident-599")
    expect(targeted.gap).not.toBeNull()
    expect(retargeted.messages.slice(-1)[0].id).toBe("resident-599")
    expect(retargeted.messages.some((item) => item.id.startsWith("target-"))).toBe(false)
    expect(restored.messages.length).toBeLessThanOrEqual(600)
    expect(restored.messages.some((item) => item.id === "latest-499")).toBe(true)
    expect(restored.messages.at(-1)?.id).toBe("resident-599")
    expect(restored.messages.some((item) => item.id.startsWith("target-"))).toBe(false)
    expect(restored.gap).toBeNull()
  })

  it("aligns eviction to page boundaries and reloads the released middle in order", () => {
    const latest = Array.from({ length: 320 }, (_, index) => message(`latest-${index}`))
    const page3 = Array.from({ length: 500 }, (_, index) => message(`page-3-${index}`))
    const page2 = Array.from({ length: 500 }, (_, index) => message(`page-2-${index}`))
    const page1 = Array.from({ length: 500 }, (_, index) => message(`page-1-${index}`))
    let windows = [createThreadMessagePageWindow(latest, null)]
    windows = prependThreadMessagePageWindow(
      windows,
      createThreadMessagePageWindow(page3, { beforeOrdinal: 2_000, beforeMessageId: "latest-0" })
    )
    windows = prependThreadMessagePageWindow(
      windows,
      createThreadMessagePageWindow(page2, { beforeOrdinal: 1_500, beforeMessageId: "page-3-0" })
    )
    windows = prependThreadMessagePageWindow(
      windows,
      createThreadMessagePageWindow(page1, { beforeOrdinal: 1_000, beforeMessageId: "page-2-0" })
    )
    const boundaryIds = new Set(windows.map((window) => window.lastMessageId))
    const bounded = prependBoundedThreadMessagePage(
      [...page2, ...page3, ...latest],
      page1,
      {
        maximumResidentMessages: 1_500,
        protectedTailMessages: 320,
        preferredPrefixBoundaryMessageIds: boundaryIds
      }
    )
    const reloadableGap = attachThreadMessageGapReload(bounded.gap, windows)

    expect(bounded.messages.length).toBeLessThanOrEqual(1_500)
    expect(reloadableGap).toMatchObject({
      afterMessageId: "page-2-499",
      reloadBeforeOrdinal: 2_000,
      reloadBeforeMessageId: "latest-0",
      reloadAnchorMessageId: null,
      reloadTargetMessageId: "page-3-0"
    })

    const advanced = advanceThreadMessageWindowAcrossGap(
      bounded.messages,
      page3,
      {
        gap: reloadableGap as NonNullable<typeof reloadableGap>,
        maximumResidentMessages: 1_500,
        protectedTailMessages: 320
      }
    )
    expect(advanced.messages.length).toBeLessThanOrEqual(1_500)
    expect(advanced.messages[0].id).toBe("page-3-0")
    expect(advanced.messages.at(-1)?.id).toBe("latest-319")
    const latestGap = attachThreadMessageGapReload(advanced.gap, windows)
    expect(latestGap).toMatchObject({
      afterMessageId: "page-3-499",
      reloadBeforeOrdinal: null,
      reloadBeforeMessageId: null,
      reloadAnchorMessageId: null,
      reloadTargetMessageId: "latest-0"
    })

    const closed = advanceThreadMessageWindowAcrossGap(
      advanced.messages,
      latest,
      {
        gap: latestGap as NonNullable<typeof latestGap>,
        maximumResidentMessages: 1_500,
        protectedTailMessages: 320
      }
    )
    expect(closed.messages[0].id).toBe("latest-0")
    expect(closed.messages.at(-1)?.id).toBe("latest-319")
    expect(closed.gap).toBeNull()
  })

  it("refreshes the latest descriptor and keeps it adjacent to a targeted window", () => {
    const initialLatest = Array.from({ length: 128 }, (_, index) =>
      message(`latest-${index + 372}`)
    )
    const completeLatest = Array.from({ length: 500 }, (_, index) => message(`latest-${index}`))
    const older = Array.from({ length: 500 }, (_, index) => message(`older-${index}`))
    const targetPage = Array.from({ length: 500 }, (_, index) => message(`target-${index}`))
    let windows = [createThreadMessagePageWindow(initialLatest, null)]
    windows = prependThreadMessagePageWindow(
      windows,
      createThreadMessagePageWindow(older, {
        beforeOrdinal: 2_000,
        beforeMessageId: "latest-372"
      })
    )

    windows = upsertLatestThreadMessagePageWindow(
      windows,
      createThreadMessagePageWindow(completeLatest, null)
    )
    const targeted = createTargetedThreadMessageWindow(completeLatest, targetPage, {
      targetMessageId: "target-499",
      protectedTailMessages: 320,
      maximumResidentMessages: 1_500
    })
    const targetWindow = createThreadMessagePageWindow(targetPage, {
      beforeOrdinal: 1_001,
      beforeMessageId: "target-499"
    })
    const forwardWindow = createForwardThreadMessagePageWindow("target-499")
    const targetedWindows = [
      targetWindow,
      ...(forwardWindow ? [forwardWindow] : []),
      ...windows.filter((window) => window.reloadCursor === null)
    ]
    const gap = attachThreadMessageGapReload(targeted.gap, targetedWindows)

    expect(windows.map((window) => window.firstMessageId)).toEqual([
      "older-0",
      "latest-0"
    ])
    expect(gap).toMatchObject({
      afterMessageId: "target-499",
      reloadBeforeOrdinal: null,
      reloadBeforeMessageId: null,
      reloadAnchorMessageId: "target-499",
      reloadTargetMessageId: "target-499"
    })

    const forwardMessages = Array.from({ length: 500 }, (_, index) =>
      message(`forward-${index}`)
    )
    const advanced = advanceThreadMessageWindowAcrossGap(
      targeted.messages,
      forwardMessages,
      {
        gap: gap as NonNullable<typeof gap>,
        maximumResidentMessages: 1_500,
        protectedTailMessages: 320
      }
    )
    const currentForwardWindow = createThreadMessagePageWindow(
      forwardMessages,
      forwardWindow?.reloadCursor ?? null
    )
    const nextForwardWindow = createForwardThreadMessagePageWindow(
      "forward-499"
    )
    const nextGap = attachThreadMessageGapReload(advanced.gap, [
      currentForwardWindow,
      ...(nextForwardWindow ? [nextForwardWindow] : []),
      ...windows.filter((window) => window.reloadCursor === null)
    ])

    expect(advanced.messages[0].id).toBe("forward-0")
    expect(advanced.messages.at(-1)?.id).toBe("latest-499")
    expect(nextGap).toMatchObject({
      afterMessageId: "forward-499",
      reloadBeforeOrdinal: null,
      reloadBeforeMessageId: null,
      reloadAnchorMessageId: "forward-499",
      reloadTargetMessageId: "forward-499"
    })
  })

  it("uses a contiguous suffix when the only durable boundary is adjacent to the tail", () => {
    const transcript = Array.from({ length: 2_000 }, (_, index) => message(`long-${index}`))
    const latestPage = transcript.slice(-500)
    const latestWindow = createThreadMessagePageWindow(latestPage, null)
    const bounded = prependBoundedThreadMessagePage(transcript, [], {
      maximumResidentMessages: 1_500,
      protectedTailMessages: 320,
      preferredPrefixBoundaryMessageIds: new Set([latestWindow.lastMessageId]),
      fallbackReloadBoundaryMessageIds: new Set(latestPage.map((item) => item.id)),
      requireReloadableGap: true
    })
    const reloadableGap = attachThreadMessageGapReload(
      bounded.gap,
      [latestWindow],
      new Set(latestPage.map((item) => item.id))
    )

    expect(bounded.messages).toHaveLength(1_500)
    expect(bounded.messages[0]?.id).toBe("long-500")
    expect(bounded.messages.at(-1)?.id).toBe("long-1999")
    expect(reloadableGap).toBeNull()
  })

  it("skips renderer-only cap rows and advances from a verified durable anchor", () => {
    const transcript = Array.from({ length: 2_000 }, (_, index) =>
      message(index === 1_179 ? "renderer-only-goal" : `durable-${index}`)
    )
    const latestPage = transcript.slice(-500)
    const latestWindow = createThreadMessagePageWindow(latestPage, null)
    const durableIds = new Set(
      transcript
        .filter((item) => item.id !== "renderer-only-goal")
        .map((item) => item.id)
    )
    const bounded = prependBoundedThreadMessagePage(transcript, [], {
      maximumResidentMessages: 1_500,
      protectedTailMessages: 320,
      preferredPrefixBoundaryMessageIds: new Set([latestWindow.lastMessageId]),
      fallbackReloadBoundaryMessageIds: durableIds,
      requireReloadableGap: true
    })
    const firstGap = attachThreadMessageGapReload(
      bounded.gap,
      [latestWindow],
      durableIds
    )

    expect(firstGap).toMatchObject({
      afterMessageId: "durable-1178",
      beforeMessageId: "durable-1680",
      reloadAnchorMessageId: "durable-1178",
      reloadTargetMessageId: "durable-1178"
    })
    expect(firstGap?.afterMessageId).not.toBe("renderer-only-goal")

    const firstForwardPage = transcript.slice(1_180, 1_680)
    const firstAdvance = advanceThreadMessageWindowAcrossGap(
      bounded.messages,
      firstForwardPage,
      {
        gap: firstGap as NonNullable<typeof firstGap>,
        maximumResidentMessages: 1_500,
        protectedTailMessages: 320
      }
    )
    const firstForwardWindow = createThreadMessagePageWindow(
      firstForwardPage,
      { anchorMessageId: "durable-1178" }
    )
    const secondForwardWindow = createForwardThreadMessagePageWindow("durable-1679")
    const secondGap = attachThreadMessageGapReload(firstAdvance.gap, [
      firstForwardWindow,
      ...(secondForwardWindow ? [secondForwardWindow] : []),
      latestWindow
    ])
    expect(secondGap).toMatchObject({
      afterMessageId: "durable-1679",
      reloadAnchorMessageId: "durable-1679",
      reloadTargetMessageId: "durable-1679"
    })

    const closed = advanceThreadMessageWindowAcrossGap(
      firstAdvance.messages,
      transcript.slice(1_680),
      {
        gap: secondGap as NonNullable<typeof secondGap>,
        maximumResidentMessages: 1_500,
        protectedTailMessages: 320
      }
    )
    expect(closed.gap).toBeNull()
    expect(closed.messages.at(-1)?.id).toBe("durable-1999")
  })

  it("never publishes an unverifiable gap when no page descriptor bounds the cut", () => {
    const transcript = Array.from({ length: 2_000 }, (_, index) => message(`orphan-${index}`))
    const bounded = prependBoundedThreadMessagePage(transcript, [], {
      maximumResidentMessages: 1_500,
      protectedTailMessages: 320,
      requireReloadableGap: true
    })

    expect(bounded.messages).toHaveLength(1_500)
    expect(bounded.messages[0]?.id).toBe("orphan-500")
    expect(bounded.messages.at(-1)?.id).toBe("orphan-1999")
    expect(bounded.gap).toBeNull()
  })
})
