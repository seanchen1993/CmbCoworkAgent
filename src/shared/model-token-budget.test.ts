import { describe, expect, it } from "vitest"
import {
  calculateMaxCompatibleOutputTokens,
  calculateModelInputBudgetTokens,
  calculateSummarizationKeepTokens,
  calculateSummarizationTriggerTokens
} from "./model-token-budget"

describe("calculateSummarizationTriggerTokens", () => {
  it("retains the same 10% recent-context fraction as DeepAgents Python", () => {
    expect(calculateSummarizationKeepTokens(16_000)).toBe(1_600)
    expect(calculateSummarizationKeepTokens(32_000)).toBe(3_200)
    expect(calculateSummarizationKeepTokens(128_000)).toBe(12_800)
  })

  it("keeps the established 75% trigger when it already reserves enough output space", () => {
    expect(calculateSummarizationTriggerTokens(128_000, 8_192)).toBe(96_000)
  })

  it("lowers the trigger for small windows or large configured outputs", () => {
    expect(calculateSummarizationTriggerTokens(32_000, 8_192)).toBe(22_808)
    expect(calculateSummarizationTriggerTokens(128_000, 100_000)).toBe(27_000)
  })

  it("exposes the full post-reservation input budget for final request checks", () => {
    expect(calculateModelInputBudgetTokens(128_000, 100_000)).toBe(27_000)
    expect(calculateModelInputBudgetTokens(32_000, 8_192)).toBe(22_808)
  })

  it("rejects a configuration that leaves no usable input beyond the safety buffer", () => {
    expect(() => calculateSummarizationTriggerTokens(32_000, 31_000)).toThrow(
      "must leave more than 1000 tokens"
    )
  })

  it("rejects a trigger that cannot exceed the retained recent context", () => {
    expect(calculateSummarizationKeepTokens(32_000)).toBe(3_200)
    expect(() => calculateSummarizationTriggerTokens(32_000, 28_000)).toThrow(
      "compaction trigger 3000 must exceed retained context 3200"
    )
  })

  it("calculates the largest output budget that still leaves retained input", () => {
    expect(calculateMaxCompatibleOutputTokens(32_000)).toBe(27_799)
    expect(calculateSummarizationTriggerTokens(32_000, 27_799)).toBe(3_201)
  })
})
