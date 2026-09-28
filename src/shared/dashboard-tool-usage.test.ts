import { describe, expect, it } from "vitest"
import {
  buildToolUsageAggs,
  parseToolUsageAggs,
  resolveUserInputRequestCount
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
      traceCount: 5,
      completeTraceCount: 3,
      filteredCalls: 10,
      rankingTruncated: true
    })
  })
  it("never presents legacy doc_count as invocation counts", () => {
    const result = parseToolUsageAggs({
      by_tool: { buckets: [{ key: "read_file", doc_count: 54 }] }
    })
    expect(result.byTool).toEqual([])
    expect(result.toolUsageCoverage.available).toBe(false)
  })
  it("prefers scalar zero to partial raw counts and falls back only when missing", () => {
    expect(resolveUserInputRequestCount(0, 2, 3)).toBe(0)
    expect(resolveUserInputRequestCount(undefined, 2, 3)).toBe(2)
    expect(resolveUserInputRequestCount(undefined, undefined, 3)).toBe(3)
    expect(resolveUserInputRequestCount(NaN, -1, 3)).toBe(3)
  })
})
