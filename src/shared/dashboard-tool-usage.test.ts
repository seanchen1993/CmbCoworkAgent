import { describe, expect, it } from "vitest"
import {
  buildToolUsageAggs,
  parseToolUsageAggs,
  resolveUserInputRequestCount,
  toolRankingCountLabel
} from "./dashboard-tool-usage"

describe("dashboard tool counts", () => {
  it("sums numeric counts inside nested scope and keeps totals outside ranking limits", () => {
    const query = buildToolUsageAggs(["read_file"])
    expect(query.tool_usage_complete.aggs.usage.nested.path).toBe("toolUsage")
    expect(query.tool_usage_complete.aggs.usage.aggs.calls).toEqual({
      sum: { field: "toolUsage.count" }
    })
    const result = parseToolUsageAggs({
      tool_usage_trace_docs: { value: 5 },
      tool_usage_complete: {
        doc_count: 3,
        usage: {
          calls: { value: 40 },
          kinds: { value: 3 },
          by_name: {
            sum_other_doc_count: 1,
            buckets: [{ key: "read_file", doc_count: 2, calls: { value: 30 } }]
          },
          filtered: {
            calls: { value: 10 },
            kinds: { value: 2 },
            by_name: { buckets: [{ key: "request_user_input", doc_count: 1, calls: { value: 8 } }] }
          }
        }
      }
    })
    expect(result.byToolAll[0].count).toBe(30)
    expect(result.byTool[0].count).toBe(8)
    expect(result.totalToolCalls).toBe(40)
    expect(result.toolUsageCoverage).toMatchObject({
      metric: "calls",
      traceCount: 5,
      completeTraceCount: 3,
      filteredCalls: 10,
      rankingTruncated: true
    })
    expect(toolRankingCountLabel(result.toolUsageCoverage)).toBe("调用次数")
  })
  it("falls back to trace counts, labelled as such, when no trace in range has complete counts", () => {
    const query = buildToolUsageAggs(["read_file"])
    // Exclude terms, not documents: a trace that also used read_file still counts.
    expect(query.tool_usage_legacy_filtered.terms.exclude).toEqual(["read_file"])
    const result = parseToolUsageAggs({
      tool_usage_trace_docs: { value: 54 },
      tool_usage_complete: { doc_count: 0, usage: { doc_count: 0, calls: { value: 0 } } },
      tool_usage_legacy_kinds: { value: 2 },
      tool_usage_legacy_all: {
        buckets: [
          { key: "read_file", doc_count: 54 },
          { key: "request_user_input", doc_count: 12 }
        ]
      },
      tool_usage_legacy_filtered: { buckets: [{ key: "request_user_input", doc_count: 12 }] }
    })
    expect(result.byToolAll).toEqual([
      { tool: "read_file", count: 54 },
      { tool: "request_user_input", count: 12 }
    ])
    expect(result.byTool).toEqual([{ tool: "request_user_input", count: 12 }])
    expect(result.totalTools).toBe(2)
    expect(result.totalToolCalls).toBe(0)
    expect(result.toolUsageCoverage).toMatchObject({
      metric: "traces",
      available: true,
      traceCount: 54,
      completeTraceCount: 0,
      filteredCalls: 0,
      filteredTools: 1
    })
    expect(toolRankingCountLabel(result.toolUsageCoverage)).toBe("用过该工具的 Trace 数")
  })
  it("keeps the trace-count ranking when the nested aggregation was dropped", () => {
    const result = parseToolUsageAggs({
      tool_usage_trace_docs: { value: 3 },
      tool_usage_legacy_all: { buckets: [{ key: "read_file", doc_count: 3 }] }
    })
    expect(result.toolUsageCoverage).toMatchObject({ metric: "traces", available: false })
    expect(result.byToolAllFull).toEqual([{ tool: "read_file", count: 3 }])
  })
  it("prefers scalar zero to partial raw counts and falls back only when missing", () => {
    expect(resolveUserInputRequestCount(0, 2, 3)).toBe(0)
    expect(resolveUserInputRequestCount(undefined, 2, 3)).toBe(2)
    expect(resolveUserInputRequestCount(undefined, undefined, 3)).toBe(3)
    expect(resolveUserInputRequestCount(NaN, -1, 3)).toBe(3)
  })
})
