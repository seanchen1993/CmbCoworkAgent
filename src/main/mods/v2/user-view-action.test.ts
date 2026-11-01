import { afterEach, expect, it, vi } from "vitest"
import { captureUserViewAction, consumeUserViewAction, withUserViewAction } from "./user-view-action"

afterEach(() => vi.useRealTimers())
it("admits one exact-source action, rechecks its owner and expires on return", async () => {
  expect(() => consumeUserViewAction("a")).toThrow("REQUIRES_USER_ACTION")
  let live = true
  let retained: (() => void) | undefined
  await withUserViewAction(
    "a",
    () => {
      if (!live) throw Error("STALE_DRAWING")
    },
    async () => {
      expect(() => consumeUserViewAction("b")).toThrow("REQUIRES_USER_ACTION")
      retained = consumeUserViewAction("a")
      retained()
      expect(() => consumeUserViewAction("a")).toThrow("INTENT_USED")
      live = false
      expect(retained).toThrow("STALE_DRAWING")
      live = true
    }
  )
  expect(retained).toThrow("REQUIRES_USER_ACTION")
})
it("rejects elapsed permits even while the original callback remains pending", async () => {
  vi.useFakeTimers()
  await withUserViewAction(
    "a",
    () => {},
    async () => {
      vi.advanceTimersByTime(15001)
      expect(() => consumeUserViewAction("a")).toThrow("REQUIRES_USER_ACTION")
    }
  )
})
it("keeps asynchronous Client delivery one-shot and bounded by the original click time", async () => {
  vi.useFakeTimers()
  const deliver = captureUserViewAction("a", () => { /* Valid drawing for this fixture. */ })
  vi.advanceTimersByTime(14000)
  await deliver(async () => { consumeUserViewAction("a")() })
  await expect(deliver(async () => undefined)).rejects.toThrow("REQUIRES_USER_ACTION")
  const late = captureUserViewAction("a", () => { /* Valid but elapsed drawing. */ })
  vi.advanceTimersByTime(15001)
  await late(async () => {
    expect(() => consumeUserViewAction("a")).toThrow("REQUIRES_USER_ACTION")
  })
})
it("preserves an accepted ordinary callback after redraw while denying its view capability", async () => {
  let calls = 0
  await withUserViewAction("a", () => { throw Error("MODS_UI_STALE_ACTION") }, async () => {
    calls++
    expect(() => consumeUserViewAction("a")).toThrow("MODS_UI_STALE_ACTION")
  })
  expect(calls).toBe(1)
})
