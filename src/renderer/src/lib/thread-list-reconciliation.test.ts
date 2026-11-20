import { describe, expect, it } from "vitest"
import type { Thread } from "@/types"
import { reconcileThreadSummaries } from "./thread-list-reconciliation"

function thread(
  id: string,
  updatedAt: number,
  metadata: Record<string, unknown> = {}
): Thread {
  return {
    thread_id: id,
    created_at: new Date(1),
    updated_at: new Date(updatedAt),
    status: "idle",
    title: id,
    metadata
  }
}

describe("reconcileThreadSummaries", () => {
  it("keeps the complete snapshot stable after a no-op focus refresh", () => {
    const previous = [thread("a", 3, { large: "x".repeat(100_000) }), thread("b", 2)]
    const incoming = [thread("a", 3, { large: "x".repeat(100_000) }), thread("b", 2)]

    const result = reconcileThreadSummaries(previous, incoming)

    expect(result).toBe(previous)
    expect(result[0]).toBe(previous[0])
    expect(result[1]).toBe(previous[1])
  })

  it("replaces only the changed row and preserves ordering changes", () => {
    const previous = [thread("a", 3), thread("b", 2)]
    const incoming = [thread("b", 4, { changed: true }), thread("a", 3)]

    const result = reconcileThreadSummaries(previous, incoming)

    expect(result).not.toBe(previous)
    expect(result[0]).toBe(incoming[0])
    expect(result[1]).toBe(previous[0])
  })
})
