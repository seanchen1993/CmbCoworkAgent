import { describe, expect, it } from "vitest"
import {
  NEW_RATIO_HISTOGRAM_INTERVAL,
  UNCLASSIFIED_CHANGE_KIND,
  buildChangeKindAggs,
  buildComputeEfficiency,
  buildNewRatioHistogramAgg,
  buildPendingScalability,
  computeUnmeasuredRatio,
  normalizeChangeKindBuckets,
  normalizeNewRatioHistogram
} from "./dashboard-efficiency"
import { makeDashboardCodeStats } from "./dashboard-code-stats"

/** Shape one `by_change_kind` bucket the way ES nests the shared code aggs. */
function bucket(
  key: string,
  args: {
    generated?: number
    deleted?: number
    measured?: number
    effective?: number
    adopted?: number
    pushedEffective?: number
    pushedAdopted?: number
  }
): Record<string, unknown> {
  return {
    key,
    code_gen: {
      generated_lines: { value: args.generated ?? 0 },
      deleted_lines: { value: args.deleted ?? 0 }
    },
    code_adopt_measured: {
      measured_generated_lines: { value: args.measured ?? 0 },
      effective_generated_lines: { value: args.effective ?? 0 },
      adopted_lines: { value: args.adopted ?? 0 },
      commit_count: { value: 0 }
    },
    code_adopt_pushed: {
      pushed_measured_generated_lines: { value: 0 },
      pushed_effective_generated_lines: { value: args.pushedEffective ?? 0 },
      pushed_adopted_lines: { value: args.pushedAdopted ?? 0 },
      pushed_commit_count: { value: 0 }
    }
  }
}

describe("buildChangeKindAggs", () => {
  it("nests the shared per-bucket aggs under a changeKind terms bucket", () => {
    const perBucket = { code_gen: { filter: {} } }
    const aggs = buildChangeKindAggs(perBucket) as Record<string, any>
    expect(aggs.by_change_kind.terms.field).toBe("properties.changeKind")
    expect(aggs.by_change_kind.aggs).toBe(perBucket)
  })

  it("folds pre-migration events into an explicit bucket instead of dropping them", () => {
    const aggs = buildChangeKindAggs({}) as Record<string, any>
    expect(aggs.by_change_kind.terms.missing).toBe(UNCLASSIFIED_CHANGE_KIND)
    // size must leave room for new + legacy + unclassified
    expect(aggs.by_change_kind.terms.size).toBeGreaterThanOrEqual(3)
  })
})

describe("buildNewRatioHistogramAgg", () => {
  it("covers the whole [0, 1] range so empty bins are still reported", () => {
    const agg = buildNewRatioHistogramAgg() as Record<string, any>
    expect(agg.new_ratio_histogram.histogram.field).toBe("properties.newRatio")
    expect(agg.new_ratio_histogram.histogram.interval).toBe(NEW_RATIO_HISTOGRAM_INTERVAL)
    expect(agg.new_ratio_histogram.histogram.extended_bounds).toEqual({ min: 0, max: 1 })
    expect(agg.new_ratio_histogram.histogram.min_doc_count).toBe(0)
  })
})

describe("normalizeChangeKindBuckets", () => {
  it("maps each bucket to its own adoption stats", () => {
    const rows = normalizeChangeKindBuckets({
      aggregations: {
        by_change_kind: {
          buckets: [
            bucket("new", { generated: 1000, measured: 1000, effective: 1000, pushedAdopted: 950 }),
            bucket("legacy", { generated: 400, measured: 400, effective: 400, pushedAdopted: 320 })
          ]
        }
      }
    })
    const byKind = Object.fromEntries(rows.map((row) => [row.changeKind, row]))
    expect(byKind.new.inclusivePushedAdoptionRate).toBeCloseTo(0.95)
    expect(byKind.legacy.inclusivePushedAdoptionRate).toBeCloseTo(0.8)
  })

  it("always emits both targets even when a period has no work of one kind", () => {
    const rows = normalizeChangeKindBuckets({
      aggregations: { by_change_kind: { buckets: [bucket("new", { generated: 10 })] } }
    })
    expect(rows.map((row) => row.changeKind)).toEqual(["new", "legacy"])
    const legacy = rows.find((row) => row.changeKind === "legacy")
    expect(legacy?.generatedLines).toBe(0)
    expect(legacy?.inclusivePushedAdoptionRate).toBeNull()
  })

  it("keeps unclassified lines visible so buckets still sum to the total", () => {
    const rows = normalizeChangeKindBuckets({
      aggregations: {
        by_change_kind: {
          buckets: [
            bucket("new", { generated: 100 }),
            bucket("legacy", { generated: 50 }),
            bucket(UNCLASSIFIED_CHANGE_KIND, { generated: 700 })
          ]
        }
      }
    })
    const unclassified = rows.find((row) => row.changeKind === UNCLASSIFIED_CHANGE_KIND)
    expect(unclassified?.generatedLines).toBe(700)
  })

  it("hides the unclassified row when it carries no lines", () => {
    const rows = normalizeChangeKindBuckets({
      aggregations: {
        by_change_kind: {
          buckets: [bucket("new", { generated: 100 }), bucket(UNCLASSIFIED_CHANGE_KIND, {})]
        }
      }
    })
    expect(rows.map((row) => row.changeKind)).toEqual(["new", "legacy"])
  })

  it("ignores unknown bucket keys", () => {
    const rows = normalizeChangeKindBuckets({
      aggregations: { by_change_kind: { buckets: [bucket("bogus", { generated: 999 })] } }
    })
    expect(rows.every((row) => row.generatedLines === 0)).toBe(true)
  })

  it("survives a malformed response", () => {
    expect(normalizeChangeKindBuckets(null).map((row) => row.changeKind)).toEqual(["new", "legacy"])
    expect(normalizeChangeKindBuckets({ aggregations: {} })).toHaveLength(2)
  })
})

describe("normalizeNewRatioHistogram", () => {
  it("reads bin edges and counts", () => {
    const bins = normalizeNewRatioHistogram({
      aggregations: {
        new_ratio_histogram: {
          buckets: [
            { key: 0, doc_count: 3 },
            { key: 0.7, doc_count: 42 }
          ]
        }
      }
    })
    expect(bins).toEqual([
      { from: 0, docCount: 3 },
      { from: 0.7, docCount: 42 }
    ])
  })

  it("returns empty on a malformed response", () => {
    expect(normalizeNewRatioHistogram(undefined)).toEqual([])
  })
})

describe("computeUnmeasuredRatio", () => {
  it("reports the share of the denominator that can never be adopted", () => {
    // 1000 generated, only 600 ever measured → 400 unmeasured out of a 1000-line
    // inclusive denominator.
    const stats = makeDashboardCodeStats({
      generatedLines: 1000,
      deletedLines: 0,
      measuredGeneratedLines: 600,
      effectiveGeneratedLines: 600,
      adoptedLines: 500
    })
    expect(computeUnmeasuredRatio(stats)).toBeCloseTo(0.4)
  })

  it("returns null when nothing was generated", () => {
    const stats = makeDashboardCodeStats({
      generatedLines: 0,
      deletedLines: 0,
      measuredGeneratedLines: 0,
      effectiveGeneratedLines: 0,
      adoptedLines: 0
    })
    expect(computeUnmeasuredRatio(stats)).toBeNull()
  })
})

describe("buildComputeEfficiency", () => {
  it("divides total tokens by pushed adopted lines", () => {
    const result = buildComputeEfficiency({
      totalInputTokens: 900_000,
      totalOutputTokens: 100_000,
      totalTokens: 1_000_000,
      cacheReadTokens: 800_000,
      cacheCreationTokens: 40_000,
      nonCachedInputTokens: 60_000,
      pushedAdoptedLines: 500,
      traceCount: 200,
      codeProducingTraceCount: 80
    })
    expect(result.tokensPerAdoptedLine).toBe(2000)
    expect(result.codeProducingTraceRatio).toBeCloseTo(0.4)
  })

  it("does not re-sum input and output into the numerator", () => {
    // totalTokens is already input + output on the trace index; summing again
    // would double the figure.
    const result = buildComputeEfficiency({
      totalInputTokens: 900_000,
      totalOutputTokens: 100_000,
      totalTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      nonCachedInputTokens: 900_000,
      pushedAdoptedLines: 1000,
      traceCount: 1,
      codeProducingTraceCount: 1
    })
    expect(result.tokensPerAdoptedLine).toBe(1000)
  })

  it("returns null per-line cost when no code landed", () => {
    const result = buildComputeEfficiency({
      totalInputTokens: 5,
      totalOutputTokens: 5,
      totalTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      nonCachedInputTokens: 5,
      pushedAdoptedLines: 0,
      traceCount: 0,
      codeProducingTraceCount: 0
    })
    expect(result.tokensPerAdoptedLine).toBeNull()
    expect(result.codeProducingTraceRatio).toBeNull()
  })

  it("clamps negative inputs rather than emitting nonsense ratios", () => {
    const result = buildComputeEfficiency({
      totalInputTokens: -1,
      totalOutputTokens: -1,
      totalTokens: -1,
      cacheReadTokens: -1,
      cacheCreationTokens: -1,
      nonCachedInputTokens: -1,
      pushedAdoptedLines: -1,
      traceCount: -1,
      codeProducingTraceCount: -1
    })
    expect(result.totalTokens).toBe(0)
    expect(result.tokensPerAdoptedLine).toBeNull()
  })

  it("flags the input split as consistent when the three parts add up", () => {
    const result = buildComputeEfficiency({
      totalInputTokens: 1_000_000,
      totalOutputTokens: 50_000,
      totalTokens: 1_050_000,
      cacheReadTokens: 820_000,
      cacheCreationTokens: 30_000,
      nonCachedInputTokens: 150_000,
      pushedAdoptedLines: 100,
      traceCount: 1,
      codeProducingTraceCount: 1
    })
    expect(result.inputSplitConsistent).toBe(true)
  })

  it("flags a mismatch when the index derives input differently", () => {
    // Cloud-side double-counting of cache would roughly double totalInputTokens
    // relative to the client-side split.
    const result = buildComputeEfficiency({
      totalInputTokens: 1_850_000,
      totalOutputTokens: 50_000,
      totalTokens: 1_900_000,
      cacheReadTokens: 820_000,
      cacheCreationTokens: 30_000,
      nonCachedInputTokens: 150_000,
      pushedAdoptedLines: 100,
      traceCount: 1,
      codeProducingTraceCount: 1
    })
    expect(result.inputSplitConsistent).toBe(false)
  })

  it("tolerates a small shortfall from traces predating the flattened fields", () => {
    const result = buildComputeEfficiency({
      totalInputTokens: 1_000_000,
      totalOutputTokens: 0,
      totalTokens: 1_000_000,
      cacheReadTokens: 800_000,
      cacheCreationTokens: 0,
      nonCachedInputTokens: 195_000, // 0.5% short
      pushedAdoptedLines: 100,
      traceCount: 1,
      codeProducingTraceCount: 1
    })
    expect(result.inputSplitConsistent).toBe(true)
  })
})

describe("buildPendingScalability", () => {
  it("declares the gap instead of reporting a zero slope", () => {
    const scalability = buildPendingScalability()
    expect(scalability.slope).toBeNull()
    expect(scalability.pendingReason).toContain("需求特性")
  })
})
