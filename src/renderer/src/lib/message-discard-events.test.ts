import { describe, expect, it } from "vitest"
import {
  advanceMessageAttempts,
  publishMessageDiscard,
  subscribeToMessageDiscard
} from "./message-discard-events"

describe("message discard notifications", () => {
  it("retains skipped reset generations immutably with a bounded ledger", () => {
    const first = advanceMessageAttempts(undefined, new Set(["retry-a"]))
    let current = advanceMessageAttempts(first, new Set(["retry-b"]))
    expect(first.generations.has("retry-b")).toBe(false)
    expect(current.generations.get("retry-a")).toBe(1)
    for (let index = 0; index < 600; index++) {
      current = advanceMessageAttempts(current, new Set([`message-${index}`]))
    }
    expect(current.generations.size).toBe(500)
    expect(current.generations.has("retry-a")).toBe(false)
    const retried = advanceMessageAttempts(current, new Set(["retry-a"]))
    expect(retried.generations.get("retry-a")).toBe(603)
    expect(retried.generations.size).toBe(500)
  })

  it("delivers every reset synchronously and only to the matching thread", () => {
    const events: string[][] = []
    let otherEvents = 0
    const unsubscribe = subscribeToMessageDiscard("discard-a", (ids) => events.push([...ids]))
    const unsubscribeOther = subscribeToMessageDiscard("discard-b", () => otherEvents++)
    try {
      publishMessageDiscard("discard-a", new Set(["first"]), 1)
      publishMessageDiscard("discard-a", new Set(["second"]), 2)
      publishMessageDiscard("discard-a", new Set(), 3)
      expect(events).toEqual([["first"], ["second"], []])
      expect(otherEvents).toBe(0)
    } finally {
      unsubscribe()
      unsubscribeOther()
    }
  })

  it("removes unmounted listeners without removing a later subscription", () => {
    let calls = 0
    const oldCleanup = subscribeToMessageDiscard("discard-cleanup", () => calls++)
    oldCleanup()
    const cleanup = subscribeToMessageDiscard("discard-cleanup", () => calls++)
    oldCleanup()
    publishMessageDiscard("discard-cleanup", new Set(["message"]), 1)
    expect(calls).toBe(1)
    cleanup()
    publishMessageDiscard("discard-cleanup", new Set(["message"]), 1)
    expect(calls).toBe(1)
  })
})
