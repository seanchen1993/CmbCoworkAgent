import { describe, expect, it } from "vitest"
import { formatRankingMatchStatus } from "./dashboard-ranking-status"

describe("ranking match status", () => {
  const items = [{ count: 1200 }, { count: 35 }]

  it("includes the total call count for filtered Tool results", () => {
    expect(formatRankingMatchStatus(items, true)).toBe("匹配 2 项 · 1,235 次调用")
  })

  it("keeps the shared Skill status unchanged", () => {
    expect(formatRankingMatchStatus(items)).toBe("匹配 2 项")
  })
})
