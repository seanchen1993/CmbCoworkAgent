import { describe, expect, it } from "vitest"
import { calculateContextCompactionBudget } from "../model-token-budget"
import { BOT_CONTEXT_BUDGET_DEFAULT, normalizeBotContextBudget } from "./context-budget"

describe("Bot working context budget", () => {
  it("compacts a 1M model earlier without shrinking its output configuration", () => {
    expect(calculateContextCompactionBudget(1_000_000, 8192, BOT_CONTEXT_BUDGET_DEFAULT)).toEqual({
      triggerTokens: 375000,
      keepTokens: 50000,
      inputBudgetTokens: 500000
    })
  })
  it("keeps the normal model budget when it is smaller or no override is supplied", () => {
    for (const window of [32000, 64000, 128000, 256000, 400000, 500000]) {
      expect(calculateContextCompactionBudget(window, 8192, BOT_CONTEXT_BUDGET_DEFAULT)).toEqual(
        calculateContextCompactionBudget(window, 8192)
      )
    }
    expect(calculateContextCompactionBudget(1_000_000, 8192)).toEqual({
      triggerTokens: 750000,
      keepTokens: 100000,
      inputBudgetTokens: 990808
    })
  })
  it("still reserves the configured provider output when that requires earlier compaction", () => {
    expect(calculateContextCompactionBudget(1_000_000, 820000, BOT_CONTEXT_BUDGET_DEFAULT)).toEqual(
      {
        triggerTokens: 179000,
        keepTokens: 50000,
        inputBudgetTokens: 179000
      }
    )
  })
  it.each([0, -1, NaN, Infinity, 500000.5])("rejects an invalid runtime budget %s", (budget) => {
    expect(() => calculateContextCompactionBudget(1_000_000, 8192, budget)).toThrow()
  })

  it.each([undefined, null, false, "500000", 500, 0, -1, NaN, Infinity, 500000.5])(
    "uses 500K for absent or invalid file setting %s",
    (value) => expect(normalizeBotContextBudget(value)).toBe(500000)
  )

  it.each([16000, 128000, 400000, 600000])("accepts a configured budget of %s", (value) => {
    expect(normalizeBotContextBudget(value)).toBe(value)
  })
})
