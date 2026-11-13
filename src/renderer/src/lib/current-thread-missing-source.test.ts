import { describe, expect, it } from "vitest"
import { CurrentThreadMissingSource } from "./current-thread-missing-source"
import type { ThreadTranscriptSourceScope } from "../../../shared/thread-transcript-source-scope"

const scope = (token: string | null = "old", createdAt = 1) => ({
  threadId: "A", incarnation: { token, legacyCreatedAt: createdAt }
})
const present = (source: ThreadTranscriptSourceScope = scope()) => ({ currentThreadId: "A", account: 0,
  retired: false, rowPresent: true, scope: source })

describe("selected missing source recovery", () => {
  it("consumes a new actual incarnation once without waiting for a selection change", () => {
    const marker = new CurrentThreadMissingSource()
    marker.remember("A", scope(), 0)
    expect(marker.observe(present())).toBeUndefined()
    expect(marker.observe(present({ ...scope(), workspacePath: "C:/changed" }))).toBeUndefined()
    expect(marker.observe(present(scope("new")))).toEqual(scope("new"))
    expect(marker.observe(present(scope("new")))).toBeUndefined()
  })

  it("retries the same incarnation only after an actual absent-to-present transition", () => {
    const marker = new CurrentThreadMissingSource()
    marker.remember("A", scope(), 0)
    expect(marker.observe({ ...present(), rowPresent: false, scope: undefined })).toBeUndefined()
    expect(marker.observe(present())).toEqual(scope())
    expect(marker.observe(present())).toBeUndefined()
  })

  it("does not mistake malformed directory scope or another thread for disappearance", () => {
    const marker = new CurrentThreadMissingSource()
    marker.remember("A", scope(), 0)
    expect(marker.observe({ ...present(), scope: undefined })).toBeUndefined()
    expect(marker.observe(present({ ...scope("new"), threadId: "B" }))).toBeUndefined()
    expect(marker.observe(present())).toBeUndefined()
    expect(marker.threadId).toBe("A")
  })

  it("clears on selection, account or retirement and cannot revive on an ABA return", () => {
    for (const change of [{ currentThreadId: "B" }, { currentThreadId: null },
      { account: 1 }, { retired: true }]) {
      const marker = new CurrentThreadMissingSource()
      marker.remember("A", scope(), 0)
      expect(marker.observe({ ...present(scope("new")), ...change })).toBeUndefined()
      expect(marker.observe(present(scope("new")))).toBeUndefined()
    }
  })

  it("keeps only one copied known scope and supports legacy incarnation timestamps", () => {
    const marker = new CurrentThreadMissingSource()
    const original = scope(null)
    marker.remember("A", original, 0)
    original.incarnation.legacyCreatedAt = 2
    expect(marker.observe(present(scope(null)))).toBeUndefined()
    expect(marker.observe(present(scope(null, 2)))).toEqual(scope(null, 2))
    marker.remember("A", scope(), 0)
    marker.remember("B", { ...scope(), threadId: "B" }, 0)
    expect(marker.threadId).toBe("B")
  })

  it("does not guess an unknown old scope and exact cleanup cannot clear another id", () => {
    const marker = new CurrentThreadMissingSource()
    marker.remember("A", undefined, 0)
    expect(marker.observe(present(scope("new")))).toBeUndefined()
    marker.remember("A", scope(), 0)
    marker.clear("B")
    expect(marker.threadId).toBe("A")
    marker.clear("A")
    expect(marker.observe(present(scope("new")))).toBeUndefined()
    marker.remember("A", scope(), 0)
    marker.clear()
    expect(marker.threadId).toBeUndefined()
  })
})
