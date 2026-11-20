import { describe, expect, it } from "vitest"
import type { Message } from "../types"
import {
  advanceThreadMessageWindowAcrossGap,
  attachThreadMessageGapReload,
  createForwardThreadMessagePageWindow,
  createThreadMessagePageWindow,
  createTargetedThreadMessageWindow,
  isThreadMessageForwardPageProgress,
  isThreadMessagePageContinuousWithBoundary,
  getForwardPageBackwardBoundary,
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
  it("refreshes a resident search target without reordering its window or creating a gap", () => {
    const existing = Array.from({ length: 128 }, (_, ordinal) => ({
      ...message(`m${ordinal}`), ordinal
    }))
    existing[127] = { ...existing[127], reasoning: "preserved local reasoning" } as typeof existing[number]
    const page = existing.slice(-64).map((item) =>
      item.id === "m127" ? { ...item, content: "updated match", reasoning: undefined } : item
    )
    const result = createTargetedThreadMessageWindow(existing, page, {
      targetMessageId: "m127", maximumResidentMessages: 300, protectedTailMessages: 128,
      residentOrdinals: new Map(existing.map(({ id, ordinal }) => [id, ordinal]))
    })
    expect(result.gap).toBeNull()
    expect(result.messages.map(({ id }) => id)).toEqual(existing.map(({ id }) => id))
    expect(result.messages.at(-1)?.content).toBe("updated match")
    expect(result.messages.at(-1)?.reasoning).toBe("preserved local reasoning")
  })

  it("rebuilds a changed resident window while preserving the running reply suffix", () => {
    const existing = [
      { ...message("target"), ordinal: 1, content: "saved prefix then live" },
      { ...message("reordered"), ordinal: 2 },
      { ...message("removed"), ordinal: 3 },
      message("local")
    ]
    const page = [
      { ...message("reordered"), ordinal: 1 },
      { ...message("target"), ordinal: 2, content: "saved prefix" }
    ]
    const result = createTargetedThreadMessageWindow(existing, page, {
      targetMessageId: "target", maximumResidentMessages: 20, protectedTailMessages: 10,
      residentOrdinals: new Map([["target", 2], ["reordered", 1], ["removed", null]]),
      activeMessageIds: new Set(["target"])
    })
    expect(result.reusedLayout).toBeFalsy()
    expect(result.messages.map(({ id }) => id)).toEqual(["reordered", "target", "local"])
    expect(result.messages[1].content).toBe("saved prefix then live")
  })

  it("keeps a saved unanchored Goal before its reply when revealing older history", () => {
    const at = (id: string, offset: number, ordinal?: number): Message => ({
      ...message(id), created_at: new Date(createdAt.getTime() + offset), ...(ordinal !== undefined && { ordinal })
    })
    const goal: Message = { ...at("goal-user-event-18", 2), role: "user", content: "/goal resume" }
    const existing = [at("before", 1, 10), goal, at("after", 3, 11), at("local", 4)]
    const result = createTargetedThreadMessageWindow(existing, [at("target", 0, 0)], {
      targetMessageId: "target", maximumResidentMessages: 20, protectedTailMessages: 10,
      residentOrdinals: new Map([["before", 10], ["after", 11]])
    })
    expect(result.messages.map(({ id }) => id)).toEqual(["target", "before", goal.id, "after", "local"])
  })

  it("reuses the physical ID when a local streaming reply first receives a durable provider tuple", () => {
    const current = { ...message("same"), content: "saved and streaming" }
    const saved = { ...message("same"), content: "saved", ordinal: 3,
      provider_source_id: "provider", provider_occurrence: 2 }
    const result = createTargetedThreadMessageWindow([current], [saved], {
      targetMessageId: "same", maximumResidentMessages: 16, protectedTailMessages: 10,
      activeMessageIds: new Set(["same"])
    })
    expect(result.messages).toEqual([{ ...saved, content: "saved and streaming" }])
    expect(result.gap).toBeNull()
  })

  it("does not report a history gap after a verified durable tail with only a timestamped Goal", () => {
    const saved = { ...message("same"), ordinal: 4 }
    const goal = { ...message("goal-user-event-1"), role: "user" as const, content: "/goal resume",
      created_at: new Date(createdAt.getTime() + 1) }
    const result = createTargetedThreadMessageWindow([saved, goal], [saved], {
      targetMessageId: "same", maximumResidentMessages: 16, protectedTailMessages: 10, hasNewerMessages: false,
      residentOrdinals: new Map([["same", 5]])
    })
    expect(result.messages.map(({ id }) => id)).toEqual(["same", goal.id])
    expect(result.gap).toBeNull()
  })

  it("adds a newly hydrated timestamped Goal even when its surrounding target rows were resident", () => {
    const before = { ...message("before"), ordinal: 1 }
    const goal = { ...message("goal-user-event-9"), role: "user" as const, content: "/goal resume" }
    const matched = { ...message("matched"), ordinal: 2 }
    const later = { ...message("later"), ordinal: 3 }
    const result = createTargetedThreadMessageWindow([before, matched, later], [before, goal, matched], {
      targetMessageId: "matched", maximumResidentMessages: 20, protectedTailMessages: 10,
      residentOrdinals: new Map([["before", 1], ["matched", 2], ["later", 3]])
    })
    expect(result.messages.map(({ id }) => id)).toEqual(["before", goal.id, "matched", "later"])
  })

  it("refreshes a forward page without duplicating an active tail row or reopening a finished gap", () => {
    const local = { ...message("same"), content: "saved and live" }
    const saved = { ...message("same"), content: "saved", ordinal: 8,
      provider_source_id: "provider", provider_occurrence: 2 }
    const gap = { afterMessageId: "previous", beforeMessageId: "same", evictedMessageCount: 1,
      reloadBeforeOrdinal: null, reloadBeforeMessageId: null, reloadExactMessageId: null,
      reloadAnchorMessageId: "previous", reloadTargetMessageId: "previous" }
    const result = advanceThreadMessageWindowAcrossGap([message("previous"), local], [saved], {
      gap, maximumResidentMessages: 20, protectedTailMessages: 10, activeMessageIds: new Set(["same"])
    })
    expect(result.messages.map(({ id, content }) => [id, content])).toEqual([["same", "saved and live"]])
    expect(result.gap).toBeNull()
    const goal = { ...message("goal-user-event-9"), role: "user" as const, content: "/goal resume" }
    const hiddenEnd = advanceThreadMessageWindowAcrossGap([message("previous"), local], [goal], {
      gap, maximumResidentMessages: 20, protectedTailMessages: 10, hasMore: false
    })
    expect(hiddenEnd.messages.map(({ id }) => id)).toEqual([goal.id, "same"])
    expect(hiddenEnd.gap).toBeNull()
    const raw = { ...message("raw-hidden"), ordinal: 8 }
    expect(getForwardPageBackwardBoundary(hiddenEnd.messages, [raw])).toBe(raw)
    expect(getForwardPageBackwardBoundary([{ ...goal, ordinal: raw.ordinal }, local], [raw])).toBe(raw)
  })

  it("advances a durable history gap with no retained tail until SQLite reports exhaustion", () => {
    const target = { ...message("target"), ordinal: 2 }
    const hidden = { ...message("hidden-anchor"), ordinal: 3 }
    const targeted = createTargetedThreadMessageWindow([], [target], {
      targetMessageId: target.id, maximumResidentMessages: 20, protectedTailMessages: 10,
      hasNewerMessages: true
    })
    const gap = attachThreadMessageGapReload(targeted.gap, [
      createThreadMessagePageWindow([target], { targetMessageId: target.id }, undefined, [target, hidden]),
      createForwardThreadMessagePageWindow(hidden.id)!
    ])!
    expect(gap).toMatchObject({ beforeMessageId: null, reloadAnchorMessageId: hidden.id })
    const next = { ...message("next"), ordinal: 4 }
    const liveUser = { ...message("new-user"), role: "user" as const, ordinal: 20 }
    const advanced = advanceThreadMessageWindowAcrossGap([...targeted.messages, liveUser], [next], {
      gap, maximumResidentMessages: 20, protectedTailMessages: 10, hasMore: true
    })
    expect(advanced.messages).toEqual([next, liveUser])
    expect(advanced.gap).toMatchObject({ beforeMessageId: liveUser.id, afterMessageId: next.id })
    const closed = advanceThreadMessageWindowAcrossGap(advanced.messages, [{ ...message("last"), ordinal: 5 }], {
      gap: advanced.gap!, maximumResidentMessages: 20, protectedTailMessages: 10, hasMore: false
    })
    expect(closed.messages.at(-1)).toBe(liveUser)
    expect(closed.gap).toBeNull()
  })

  it.each([0, 128])("keeps the original forward interval after loading earlier over the cap (tail=%s)", (tailSize) => {
    const row = (ordinal: number) => ({ ...message(`row-${ordinal}`), ordinal })
    const read = (first: number, last: number) =>
      Array.from({ length: last - first + 1 }, (_, index) => row(first + index))
    const tail = read(7001 - tailSize, 7000)
    let resident = [...read(4501, 5000), ...tail]
    let gap = {
      afterMessageId: "row-5000", beforeMessageId: tail[0]?.id ?? null, evictedMessageCount: 1,
      reloadBeforeOrdinal: null, reloadBeforeMessageId: null, reloadExactMessageId: null,
      reloadAnchorMessageId: "row-5000", reloadTargetMessageId: "row-5000"
    }
    for (const first of [4001, 3501, 3001]) {
      const earlier = read(first, first + 499)
      const bounded = prependBoundedThreadMessagePage(resident, earlier, {
        maximumResidentMessages: 1500, protectedTailMessages: 320, existingGap: gap,
        fallbackReloadBoundaryMessageIds: new Set([...resident, ...earlier].map(({ id }) => id)),
        requireReloadableGap: true
      })
      expect(bounded.gap).toBeDefined()
      expect(bounded.gap?.reloadAnchorMessageId).toBe(bounded.gap?.afterMessageId)
      expect(bounded.gap?.beforeMessageId).toBe(tail[0]?.id ?? null)
      gap = bounded.gap as typeof gap
      resident = bounded.messages as typeof resident
    }
    expect(resident).toEqual([...read(3001, 4500 - tailSize), ...tail])
    const anchor = 4500 - tailSize
    expect(attachThreadMessageGapReload(gap, [])?.reloadAnchorMessageId).toBe(row(anchor).id)
    const forwardPage = read(anchor + 1, anchor + 500)
    const advanced = advanceThreadMessageWindowAcrossGap(resident, forwardPage, {
      gap, maximumResidentMessages: 1500, protectedTailMessages: 320, hasMore: true,
      rawPage: forwardPage
    })
    expect(advanced.messages).toEqual([...forwardPage, ...tail])
    expect(advanced.gap).toMatchObject({ afterMessageId: row(anchor + 500).id,
      beforeMessageId: tail[0]?.id ?? null })
  })

  it("uses the raw first row to reload a target page that begins with a rendered Goal", () => {
    const before = { ...message("earlier"), ordinal: 1 }
    const hidden = { ...message("raw-hidden"), ordinal: 2 }
    const goal = { ...message("goal-user-event-1"), role: "user" as const, ordinal: 2 }
    const target = { ...message("target"), ordinal: 63 }
    const rawPage = [hidden, target]
    const displayPage = [goal, target]
    const old = createThreadMessagePageWindow([before], null)
    const detached = createThreadMessagePageWindow(displayPage, { targetMessageId: target.id }, undefined, rawPage)
    const recovered = attachThreadMessageGapReload({
      afterMessageId: before.id, beforeMessageId: goal.id, evictedMessageCount: 1,
      reloadBeforeOrdinal: null, reloadBeforeMessageId: null, reloadExactMessageId: null,
      reloadAnchorMessageId: null, reloadTargetMessageId: null
    }, [old, detached])
    expect(recovered).toMatchObject({ reloadExactMessageId: target.id, reloadTargetMessageId: hidden.id })
    expect(isThreadMessagePageContinuousWithBoundary(rawPage, hidden.id)).toBe(true)
  })

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
      reloadExactMessageId: null,
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

  it("keeps the saved tail after an ordinal change and discards stale rows", () => {
    const cached = [
      { ...message("earlier"), ordinal: 350 },
      { ...message("latest"), ordinal: 419 },
      { ...message("deleted"), ordinal: 420 },
      message("local")
    ]
    const targetPage = [{ ...message("target"), ordinal: 440 }]
    const result = createTargetedThreadMessageWindow(cached, targetPage, {
      targetMessageId: "target",
      maximumResidentMessages: 10,
      protectedTailMessages: 5,
      residentOrdinals: new Map([["earlier", 420], ["latest", 489], ["deleted", null]])
    })
    expect(result.messages.map((row) => row.id)).toEqual(["target", "latest", "local"])
    expect(result.messages[1].ordinal).toBe(489)
    expect(result.gap).toMatchObject({ afterMessageId: "target", beforeMessageId: "latest" })
  })

  it("retains later composite keys at the same stored ordinal", () => {
    const target = { ...message("target"), ordinal: 999 }
    const cached = [
      { ...message("earlier"), ordinal: 999 },
      { ...message("goal-user-event-1"), ordinal: 999 },
      { ...message("zz-latest"), ordinal: 999 }
    ]
    const result = createTargetedThreadMessageWindow(cached, [target], {
      targetMessageId: target.id,
      maximumResidentMessages: 10,
      protectedTailMessages: 5,
      residentOrdinals: new Map(cached.map((row) => [row.id, row.ordinal])),
      goalAnchors: new Map([["goal-user-event-1", "zz-latest"]])
    })
    expect(result.messages.map((row) => row.id)).toEqual(["target", "goal-user-event-1", "zz-latest"])
    expect(result.gap).toMatchObject({ afterMessageId: "target", beforeMessageId: "goal-user-event-1" })
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
