import { describe, expect, it } from "vitest"
import {
  buildProjectModeStageAnalysisAggs,
  parseProjectModeStageAnalysis,
  STAGE_TOOL_VARIETY_LIMIT,
  STAGE_TOP_TOOL_LIMIT
} from "./project-mode-stage-analysis"

/**
 * 单项目的阶段耗时分析。
 *
 * 这组用例主要钉三件事：
 *
 * 1. 阶段按总忙碌时长倒序——弹窗是用来找「慢在哪」的，最吃时间的必须排最前。
 * 2. 平均和 P95 都要有。总耗时基本由轮次数决定，光看它排名等于看轮次排名，看不出慢。
 * 3. 缺失的聚合桶一律归零，不把 null / NaN 抛到界面上。ES 在空桶时给 null 百分位，
 *    这是正常返回而不是错误。
 */

const UNATTRIBUTED = "未归因"

function nodeBucket(
  key: string,
  options: {
    docCount: number
    sum: number
    avg: number
    p95: number
    tools?: Array<[string, number]>
  }
): Record<string, unknown> {
  return {
    key,
    doc_count: options.docCount,
    duration_stats: { sum: options.sum, avg: options.avg },
    duration_percentiles: { values: { "95.0": options.p95 } },
    run_cost_tool_calls: { value: 100 },
    run_cost_model_calls: { value: 10 },
    run_cost_total_tokens: { value: 1000 },
    run_cost_user_input_requests: { value: 1 },
    run_cost_user_input_docs: { value: options.docCount },
    by_tool: {
      buckets: (options.tools ?? []).map(([tool, count]) => ({ key: tool, doc_count: count }))
    }
  }
}

describe("阶段分析的聚合条件", () => {
  const aggs = buildProjectModeStageAnalysisAggs(UNATTRIBUTED, 50, ["execute", "read_file"])

  it("按 harnessNodeName 拆阶段，没有阶段归属的落进未归因桶", () => {
    const byNode = (aggs.by_node as { terms: { field: string; size: number; missing: string } })
      .terms
    expect(byNode.field).toBe("harnessNodeName")
    expect(byNode.size).toBe(50)
    // missing 用调用方给的标签，和项目列表里已有的阶段细分保持一致，免得同一个项目
    // 在两处看到不同的阶段清单。
    expect(byNode.missing).toBe(UNATTRIBUTED)
  })

  it("全项目和每个阶段都带耗时统计，不只是总和", () => {
    // 只有 sum 的话，阶段排名基本等于轮次排名，回答不了「哪个阶段慢」。
    for (const scope of [aggs, (aggs.by_node as { aggs: Record<string, unknown> }).aggs]) {
      const stats = (scope as Record<string, { stats?: { field: string } }>).duration_stats
      const percentiles = (scope as Record<string, { percentiles?: { field: string } }>)
        .duration_percentiles
      expect(stats.stats?.field).toBe("durationMs")
      expect(percentiles.percentiles?.field).toBe("durationMs")
    }
  })

  it("工具排行沿用 Tool 使用模块的过滤与字段", () => {
    const byTool = (
      (aggs.by_node as { aggs: Record<string, { terms: Record<string, unknown> }> }).aggs
        .by_tool as { terms: Record<string, unknown> }
    ).terms
    expect(byTool.field).toBe("toolNames")
    // size 取的是种类数统计上限，不是展示条数：同一个聚合既喂徽章也喂「共 N 种」，
    // 多取一些桶才能知道有没有列全，解析时再切到 STAGE_TOP_TOOL_LIMIT。
    expect(byTool.size).toBe(STAGE_TOOL_VARIETY_LIMIT)
    expect(STAGE_TOOL_VARIETY_LIMIT).toBeGreaterThan(STAGE_TOP_TOOL_LIMIT)
    expect(byTool.exclude).toEqual(["execute", "read_file"])
  })

  it("运行开销四项也按阶段拆", () => {
    const stageAggs = (aggs.by_node as { aggs: Record<string, unknown> }).aggs
    expect(stageAggs).toHaveProperty("run_cost_tool_calls")
    expect(stageAggs).toHaveProperty("run_cost_model_calls")
    expect(stageAggs).toHaveProperty("run_cost_total_tokens")
    expect(stageAggs).toHaveProperty("run_cost_user_input_requests")
  })
})

describe("阶段分析的解析", () => {
  it("阶段按总忙碌时长倒序，最吃时间的排最前", () => {
    const parsed = parseProjectModeStageAnalysis("p1", {
      doc_count: 60,
      duration_stats: { sum: 900_000, avg: 15_000 },
      duration_percentiles: { values: { "95.0": 48_000 } },
      by_node: {
        buckets: [
          nodeBucket("plan-方案设计", { docCount: 10, sum: 100_000, avg: 10_000, p95: 20_000 }),
          nodeBucket("dev-编码实现", { docCount: 40, sum: 700_000, avg: 17_500, p95: 52_000 }),
          nodeBucket("test-测试验证", { docCount: 10, sum: 100_000, avg: 10_000, p95: 18_000 })
        ]
      }
    })

    expect(parsed.stages.map((stage) => stage.nodeName)).toEqual([
      "dev-编码实现",
      "plan-方案设计",
      "test-测试验证"
    ])
  })

  it("从节点名切出阶段大类", () => {
    const parsed = parseProjectModeStageAnalysis("p1", {
      doc_count: 1,
      by_node: {
        buckets: [
          nodeBucket("dev-编码实现", { docCount: 1, sum: 1, avg: 1, p95: 1 }),
          nodeBucket(UNATTRIBUTED, { docCount: 1, sum: 0, avg: 0, p95: 0 })
        ]
      }
    })

    const byName = new Map(parsed.stages.map((stage) => [stage.nodeName, stage.group]))
    expect(byName.get("dev-编码实现")).toBe("dev")
    // 未归因桶不是 `${group}-${label}` 形状，切不出大类，这是预期而不是错误。
    expect(byName.get(UNATTRIBUTED)).toBeNull()
  })

  it("平均和 P95 分别落位，不会互相串", () => {
    const parsed = parseProjectModeStageAnalysis("p1", {
      doc_count: 40,
      duration_stats: { sum: 700_000, avg: 17_500 },
      duration_percentiles: { values: { "95.0": 52_000 } },
      by_node: { buckets: [] }
    })

    expect(parsed.total.totalDurationMs).toBe(700_000)
    expect(parsed.total.avgDurationMs).toBe(17_500)
    expect(parsed.total.p95DurationMs).toBe(52_000)
    expect(parsed.total.conversationCount).toBe(40)
  })

  it("空桶的百分位是 null，按 0 处理而不是 NaN", () => {
    // ES 对空桶返回 {"95.0": null}，这是正常返回，不是错误。
    const parsed = parseProjectModeStageAnalysis("p1", {
      doc_count: 0,
      duration_stats: { sum: null, avg: null },
      duration_percentiles: { values: { "95.0": null } },
      by_node: { buckets: [] }
    })

    expect(parsed.total.p95DurationMs).toBe(0)
    expect(parsed.total.avgDurationMs).toBe(0)
    expect(Number.isNaN(parsed.total.totalDurationMs)).toBe(false)
  })

  it("聚合整个缺失时给空结果，不抛异常", () => {
    expect(parseProjectModeStageAnalysis("p1", undefined).stages).toEqual([])
    expect(parseProjectModeStageAnalysis("p1", {}).stages).toEqual([])
    expect(parseProjectModeStageAnalysis("p1", { by_node: { buckets: "坏数据" } }).stages).toEqual(
      []
    )
  })

  it("工具排行按桶原样带出，key 为空的桶丢掉", () => {
    const parsed = parseProjectModeStageAnalysis("p1", {
      doc_count: 5,
      by_node: {
        buckets: [
          nodeBucket("dev-编码实现", {
            docCount: 5,
            sum: 10,
            avg: 2,
            p95: 3,
            tools: [
              ["edit_file", 12],
              ["", 99],
              ["bash", 7]
            ]
          })
        ]
      }
    })

    expect(parsed.stages[0].topTools).toEqual([
      { tool: "edit_file", count: 12 },
      { tool: "bash", count: 7 }
    ])
  })
})

/**
 * 「共 N 种」存在的理由：徽章只列前几个，而截断本身在界面上是看不出来的。
 * 所以种类数必须和徽章同口径（同一个 terms 聚合、同一套 exclude），否则这个数
 * 会把被过滤掉的内置工具也算进去，比不显示更误导。
 */
describe("阶段的工具种类数", () => {
  function stageWithTools(count: number): ReturnType<typeof parseProjectModeStageAnalysis> {
    const tools: Array<[string, number]> = Array.from({ length: count }, (_, index) => [
      `tool_${index}`,
      count - index
    ])
    return parseProjectModeStageAnalysis("p1", {
      doc_count: 5,
      by_node: {
        buckets: [nodeBucket("dev-编码实现", { docCount: 5, sum: 10, avg: 2, p95: 3, tools })]
      }
    })
  }

  it("徽章只留前 STAGE_TOP_TOOL_LIMIT 条，种类数是拿回来的全部", () => {
    const stage = stageWithTools(20).stages[0]
    expect(stage.topTools).toHaveLength(STAGE_TOP_TOOL_LIMIT)
    expect(stage.toolVariety).toBe(20)
    expect(stage.toolVarietyTruncated).toBe(false)
  })

  it("没超过展示条数时，种类数与徽章条数相等（界面据此不显示）", () => {
    const stage = stageWithTools(3).stages[0]
    expect(stage.topTools).toHaveLength(3)
    expect(stage.toolVariety).toBe(3)
  })

  it("触到统计上限时标记为截断，展示成 N+ 种", () => {
    const stage = stageWithTools(STAGE_TOOL_VARIETY_LIMIT).stages[0]
    expect(stage.toolVariety).toBe(STAGE_TOOL_VARIETY_LIMIT)
    expect(stage.toolVarietyTruncated).toBe(true)
  })

  it("key 为空的桶不计入种类数", () => {
    // 空 key 的桶已经被徽章过滤掉了，种类数必须用同一套过滤，否则会多算一种。
    const stage = parseProjectModeStageAnalysis("p1", {
      doc_count: 5,
      by_node: {
        buckets: [
          nodeBucket("dev-编码实现", {
            docCount: 5,
            sum: 10,
            avg: 2,
            p95: 3,
            tools: [
              ["edit_file", 12],
              ["", 99],
              ["bash", 7]
            ]
          })
        ]
      }
    }).stages[0]
    expect(stage.topTools).toHaveLength(2)
    expect(stage.toolVariety).toBe(2)
  })

  it("聚合缺失时种类数为 0", () => {
    const stage = parseProjectModeStageAnalysis("p1", {
      doc_count: 0,
      by_node: { buckets: [nodeBucket("dev-编码实现", { docCount: 0, sum: 0, avg: 0, p95: 0 })] }
    }).stages[0]
    expect(stage.toolVariety).toBe(0)
    expect(stage.toolVarietyTruncated).toBe(false)
  })
})
