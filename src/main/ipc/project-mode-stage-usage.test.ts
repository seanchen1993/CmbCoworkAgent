import { describe, it, expect, vi } from "vitest"
import {
  buildProjectModeStageAnalysisAggs,
  parseProjectModeStageAnalysis
} from "./project-mode-stage-analysis"
import { queryWithStageUsageMappingFallback } from "./project-mode-stage-usage"
import { projectModeMainAgentConversationFilter } from "./dashboard-stage-buckets"

describe("mixed-version stage cost queries", () => {
  it("uses exclusive new/legacy costs and splits complete main-agent stage durations", () => {
    const aggs = buildProjectModeStageAnalysisAggs("未归因", 50) as {
      by_node: {
        aggs: {
          legacy_cost: { filter: { bool: { must_not: unknown[] } } }
          legacy_conversations: {
            filter: { bool: { filter: unknown[]; must_not: unknown[] } }
          }
        }
      }
      stage_usage: { filter: unknown }
      stage_duration: {
        filter: { bool: { filter: unknown[] } }
        aggs: { usage: { nested: { path: string } } }
      }
    }
    const json = JSON.stringify(aggs)
    expect(json).toContain('"nested":{"path":"stageUsage"}')
    expect(json).toContain('"reverse_nested":{}')
    expect(aggs.by_node.aggs.legacy_cost.filter.bool.must_not).toEqual([aggs.stage_usage.filter])
    expect(aggs.stage_duration.aggs.usage.nested.path).toBe("stageDuration")
    const mainAgent = projectModeMainAgentConversationFilter()
    const completeDuration = {
      bool: {
        filter: [
          { term: { stageDurationSchemaVersion: 1 } },
          { term: { stageDurationComplete: true } }
        ]
      }
    }
    expect(aggs.stage_duration.filter.bool.filter).toEqual([mainAgent, completeDuration])
    expect(aggs.by_node.aggs.legacy_conversations.filter.bool).toEqual({
      filter: [mainAgent],
      must_not: [completeDuration]
    })
  })

  it("falls back to main-agent turn durations when split duration mapping is unavailable", () => {
    const fallback = buildProjectModeStageAnalysisAggs("未归因", 50, true, false)
    expect(fallback).not.toHaveProperty("stage_duration")
    expect(fallback).toHaveProperty("stage_usage")
    const byNode = fallback.by_node as {
      aggs: {
        legacy_conversations: { filter: { bool: { filter: unknown[] } } }
        legacy_cost: { filter: { bool: { must_not: unknown[] } } }
      }
    }
    expect(byNode.aggs.legacy_conversations.filter.bool).toEqual({
      filter: [projectModeMainAgentConversationFilter()]
    })
    expect(byNode.aggs.legacy_cost.filter.bool.must_not).toEqual([
      (fallback.stage_usage as { filter: unknown }).filter
    ])
  })

  it("merges legacy costs and call-stage costs once, including stages with no starting conversations", () => {
    const parsed = parseProjectModeStageAnalysis("p", {
      run_cost_trace_docs: { value: 3 },
      run_cost_tool_calls: { value: 10 },
      by_node: {
        buckets: [
          {
            key: "plan",
            main_agent_conversations: { doc_count: 2, duration_stats: { sum: 100, avg: 50 } },
            legacy_cost: {
              doc_count: 1,
              run_cost_trace_docs: { value: 1 },
              run_cost_tool_calls: { value: 7 }
            }
          }
        ]
      },
      stage_usage: {
        doc_count: 2,
        usage: {
          model_calls: { value: 2 },
          token_usage_reported_calls: { value: 1 },
          by_node: {
            buckets: [
              {
                key: "plan",
                toolCalls: { value: 1 },
                modelCalls: { value: 1 },
                traces: { doc_count: 1 }
              },
              {
                key: "dev",
                toolCalls: { value: 2 },
                modelCalls: { value: 1 },
                traces: { doc_count: 2 }
              }
            ]
          }
        }
      }
    })
    expect(
      parsed.stages.map((x) => [
        x.nodeName,
        x.metrics.runCost.toolCalls,
        x.metrics.conversationCount
      ])
    ).toEqual([
      ["plan", 8, 2],
      ["dev", 2, 0]
    ])
    expect(parsed.total.runCost.toolCalls).toBe(10)
    expect(parsed.costAttribution).toMatchObject({
      callStartTraceCount: 2,
      turnStartTraceCount: 1,
      tokenUsageReportedCalls: 1,
      modelCalls: 2
    })
  })

  it("retries only nested mapping errors and retains the original access filters", async () => {
    const legacy = buildProjectModeStageAnalysisAggs("未归因", 50, false)
    const body = {
      query: { bool: { filter: [{ term: { sapId: "allowed" } }] } },
      size: 0,
      aggs: buildProjectModeStageAnalysisAggs("未归因", 50)
    }
    const execute = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("[nested] failed to find nested object under path [stageUsage]")
      )
      .mockResolvedValueOnce({ ok: true })
    await expect(queryWithStageUsageMappingFallback(execute, body, legacy)).resolves.toEqual({
      ok: true
    })
    expect(execute.mock.calls[1][0]).toEqual({ ...body, aggs: legacy })
    const failed = vi.fn().mockRejectedValue(new Error("permission denied"))
    await expect(queryWithStageUsageMappingFallback(failed, body, legacy)).rejects.toThrow(
      "permission denied"
    )
    expect(failed).toHaveBeenCalledTimes(1)
  })

  it("recognises the mapping error inside the worker's flattened cause chain", async () => {
    const legacy = buildProjectModeStageAnalysisAggs("未归因", 50, false)
    const body = { size: 0, aggs: buildProjectModeStageAnalysisAggs("未归因", 50) }
    // esQuery on the worker path: the ES body sits in a plain-object cause, not an Error.
    const fromWorker = new Error("请检查网络连接后重试", {
      cause: {
        code: "DASHBOARD_ES_HTTP_ERROR",
        message:
          'ES 400: {"error":{"root_cause":[{"reason":"[nested] nested path [stageUsage] is not nested"}]'
      }
    })
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("请检查网络连接后重试", { cause: fromWorker }))
      .mockResolvedValueOnce({ ok: true })
    await expect(queryWithStageUsageMappingFallback(execute, body, legacy)).resolves.toEqual({
      ok: true
    })
    expect(execute.mock.calls[1][0]).toEqual({ ...body, aggs: legacy })
  })
})
