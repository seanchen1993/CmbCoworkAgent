import { describe, expect, it, vi } from "vitest"
import {
  buildProjectModeStageAnalysisAggs,
  parseProjectModeStageAnalysis
} from "./project-mode-stage-analysis"
import {
  completeRunAnalysisStages,
  partitionRunAnalysisStageAggs,
  type StagePartition
} from "./project-run-analysis-stages"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous ES query/aggregation fixtures are interpreted by these tests.
type Json = Record<string, any>
const names = [...Array.from({ length: 451 }, (_, i) => `stage-${i}`), "未归因"]
const hash = (key: string) => [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0)
function metrics(n: number): Json {
  return { run_cost_tool_calls: { value: n }, run_cost_model_calls: { value: 1 } }
}
function stageResponse(aggs: Json): Json {
  const select = (terms: Json, make: (key: string, i: number) => Json) => {
    const partition = terms.include as StagePartition | undefined
    const keys = names.filter(
      (key) => !partition || hash(key) % partition.num_partitions === partition.partition
    )
    return {
      buckets: keys.slice(0, terms.size).map((key) => make(key, names.indexOf(key))),
      sum_other_doc_count: Math.max(0, keys.length - terms.size)
    }
  }
  return {
    main_agent_conversations: {
      doc_count: 1000,
      duration_stats: { sum: 99999, avg: 99 },
      duration_percentiles: { values: { "95.0": 120 } }
    },
    run_cost_trace_docs: { value: 1400 },
    ...metrics(9999),
    by_node: select(aggs.by_node.terms, (key, i) => ({
      key,
      legacy_conversations: {
        doc_count: 1,
        duration_stats: { sum: 10 + i, avg: 10 + i },
        duration_percentiles: { values: { "95.0": 10 + i } }
      },
      legacy_cost: metrics(i + 1)
    })),
    stage_duration: {
      doc_count: 600,
      usage: {
        by_node: select(aggs.stage_duration.aggs.usage.aggs.by_node.terms, (key, i) => ({
          key,
          doc_count: 2,
          duration_stats: { sum: 100 + i },
          duration_percentiles: { values: { "95.0": 100 + i } }
        }))
      }
    },
    stage_usage: {
      doc_count: 800,
      usage: {
        model_calls: { value: 7000 },
        token_usage_reported_calls: { value: 7000 },
        by_node: select(aggs.stage_usage.aggs.usage.aggs.by_node.terms, (key, i) => ({
          key,
          toolCalls: { value: 200 + i },
          modelCalls: { value: 2 },
          traces: { doc_count: 2 }
        }))
      }
    }
  }
}
const base = buildProjectModeStageAnalysisAggs("未归因", 200)
const initial = parseProjectModeStageAnalysis("project", stageResponse(base))

describe("runtime diagnosis complete mixed stage attribution", () => {
  it("partitions all three stage trees, retains missing stage and merges >200 mixed legacy/new stages without duplicating totals", async () => {
    expect(initial.costAttribution?.truncated).toBe(true)
    let active = 0,
      max = 0
    const execute = vi.fn(async (partition: StagePartition) => {
      active++
      max = Math.max(max, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      const aggs = partitionRunAnalysisStageAggs(base, partition) as Json
      expect(aggs.by_node.terms.include).toEqual(partition)
      expect(aggs.stage_duration.aggs.usage.aggs.by_node.terms.include).toEqual(partition)
      expect(aggs.stage_usage.aggs.usage.aggs.by_node.terms.include).toEqual(partition)
      expect(aggs.by_node.terms.missing).toBe("未归因")
      return parseProjectModeStageAnalysis("project", stageResponse(aggs))
    })
    const full = await completeRunAnalysisStages(initial, execute)
    expect(full.stages).toHaveLength(452)
    expect(new Set(full.stages.map((s) => s.nodeName)).size).toBe(452)
    expect(full.stages.find((s) => s.nodeName === "未归因")).toBeDefined()
    expect(full.stages.find((s) => s.nodeName === "stage-300")?.metrics).toMatchObject({
      conversationCount: 3,
      totalDurationMs: 710,
      runCost: { toolCalls: 801, modelCalls: 3 }
    })
    expect(full.total).toEqual(initial.total)
    expect(full.total.conversationCount).toBe(1000)
    expect(full.durationAttribution).toMatchObject({
      splitTurnCount: 600,
      legacyTurnCount: 400,
      truncated: false
    })
    expect(full.costAttribution).toMatchObject({
      callStartTraceCount: 800,
      turnStartTraceCount: 600,
      truncated: false
    })
    expect(max).toBe(2)
    expect(execute).toHaveBeenCalledTimes(6)
    expect((base as Json).by_node.terms).not.toHaveProperty("include")
  })
  it("returns the normal small diagnosis without additional queries", async () => {
    const execute = vi.fn()
    const full = {
      ...initial,
      costAttribution: { ...initial.costAttribution!, truncated: false },
      durationAttribution: { ...initial.durationAttribution!, truncated: false }
    }
    expect(await completeRunAnalysisStages(full, execute)).toBe(full)
    expect(execute).not.toHaveBeenCalled()
  })
  it("supports a scalar-only aggregation tree after old-ES nested mapping fallback", async () => {
    const fallback = buildProjectModeStageAnalysisAggs("未归因", 200, false, false)
    const partitioned = partitionRunAnalysisStageAggs(fallback, {
      partition: 0,
      num_partitions: 4
    }) as Json
    expect(partitioned).not.toHaveProperty("stage_duration")
    expect(partitioned).not.toHaveProperty("stage_usage")
    expect(partitioned.by_node.terms.include).toEqual({ partition: 0, num_partitions: 4 })
    const parsed = parseProjectModeStageAnalysis("p", {
      main_agent_conversations: { doc_count: 1 },
      by_node: {
        buckets: [
          {
            key: "未归因",
            legacy_conversations: { doc_count: 1, duration_stats: { sum: 10 } },
            ...metrics(3)
          }
        ]
      }
    })
    expect(parsed.stages[0]).toMatchObject({
      nodeName: "未归因",
      metrics: { conversationCount: 1, totalDurationMs: 10, runCost: { toolCalls: 3 } }
    })
  })
  it("fails without returning partial data at the explicit partition bound or on duplicate partition labels", async () => {
    await expect(completeRunAnalysisStages(initial, async () => initial, 4)).rejects.toThrow(
      "未展示不完整结果"
    )
    const duplicated = {
      ...initial,
      stages: [initial.stages[0]],
      costAttribution: { ...initial.costAttribution!, truncated: false },
      durationAttribution: { ...initial.durationAttribution!, truncated: false }
    }
    await expect(completeRunAnalysisStages(initial, async () => duplicated, 2)).rejects.toThrow(
      "重复标签"
    )
  })
  it("propagates a failing partition and never returns the other successful partition alone", async () => {
    await expect(
      completeRunAnalysisStages(initial, async (p) => {
        if (p.partition === 1) throw new Error("failed shard")
        return initial
      })
    ).rejects.toThrow("failed shard")
  })
})
