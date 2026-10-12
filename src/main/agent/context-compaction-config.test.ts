import { describe, expect, it } from "vitest"
import {
  createContextCompactionConfig,
  CMB_COWORK_SUMMARY_PROMPT
} from "./context-compaction-config"

describe("shared desktop and Bot context budgets", () => {
  it.each([
    [32_000, 20_000, 11_000, 11_000, 3_200, 6_000, 11_000],
    [128_000, 8_192, 96_000, 118_808, 12_800, 10_240, 83_200],
    [128_000, 100_000, 27_000, 27_000, 12_800, 10_240, 83_200],
    [1_000_000, 100_000, 750_000, 899_000, 100_000, 20_000, 650_000]
  ])(
    "preserves original Cmb parameters for context %i and output %i",
    (context, output, trigger, input, keep, evict, retry) => {
      const config = createContextCompactionConfig(context, output)
      expect(config.graphOptions).toEqual({
        summarizationTrigger: { type: "tokens", value: trigger },
        summarizationKeep: { type: "tokens", value: keep },
        toolTokenLimitBeforeEvict: evict,
        trimTokensToSummarize: retry,
        summarizationMaxInputTokens: context,
        summarizationPostCompactionInputBudgetTokens: input,
        summarizationSummaryPrompt: CMB_COWORK_SUMMARY_PROMPT,
        summarizationTruncateArgsSettings: {
          trigger: { type: "tokens", value: trigger },
          keep: { type: "tokens", value: keep },
          maxLength: 2000
        }
      })
      expect(config.summaryMaxOutputTokens).toBe(Math.min(output, 20_000))
      expect(config.summaryInputBudget).toBe(context - Math.min(output, 20_000) - 1000)
    }
  )

  it.each([
    [32_000, 31_000],
    [32_000, 28_000]
  ])("rejects an unusable context/output reservation (%i/%i)", (context, output) =>
    expect(() => createContextCompactionConfig(context, output)).toThrow()
  )
})
