import { describe, expect, it } from "vitest"
import { compareDesignSessionOrder, withDesignSessionOrder } from "./design-session-order"
import type { SessionMeta } from "./managed-design-session"

const meta = (id: string, createdAt: number, lastSubmittedAt?: number): SessionMeta => ({
  id, title: id, createdAt, updatedAt: 1000, lastSubmittedAt
})

describe("design session order", () => {
  it("uses submission time, then creation time and ID to give ties a deterministic order", () => {
    const sessions = [meta("b", 20, 30), meta("a", 20, 30), meta("old", 10, 30), meta("latest", 1, 40)]
    expect(sessions.sort(compareDesignSessionOrder).map((entry) => entry.id))
      .toEqual(["latest", "a", "b", "old"])
    expect([meta("new", 20), meta("old", 10)].sort(compareDesignSessionOrder).map((entry) => entry.id))
      .toEqual(["new", "old"])
  })

  it("freezes a legacy update time and keeps it through further metadata-only responses", () => {
    const legacy = withDesignSessionOrder({ ...meta("legacy", 1), updatedAt: 10 })
    const later = withDesignSessionOrder({ ...meta("legacy", 1), updatedAt: 100 }, legacy.lastSubmittedAt)
    expect(later.lastSubmittedAt).toBe(10)
    expect(withDesignSessionOrder({ ...later, lastSubmittedAt: 200 }).lastSubmittedAt).toBe(200)
  })
})
