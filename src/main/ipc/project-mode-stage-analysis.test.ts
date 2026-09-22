import { describe, expect, it } from "vitest"
import {
  buildProjectModeStageAnalysisAggs,
  parseProjectModeStageAnalysis
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
  }
): Record<string, unknown> {
  return {
    key,
    main_agent_conversations: {
      doc_count: options.docCount,
      duration_stats: { sum: options.sum, avg: options.avg },
      duration_percentiles: { values: { "95.0": options.p95 } }
    },
    run_cost_tool_calls: { value: 100 },
    run_cost_model_calls: { value: 10 },
    run_cost_total_tokens: { value: 1000 },
    run_cost_user_input_requests: { value: 1 },
    run_cost_user_input_docs: { value: options.docCount }
  }
}

describe("阶段分析的聚合条件", () => {
  const aggs = buildProjectModeStageAnalysisAggs(UNATTRIBUTED, 50)

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
      const main = (
        scope.main_agent_conversations as {
          aggs: Record<string, { stats?: { field: string }; percentiles?: { field: string } }>
        }
      ).aggs
      const stats = main.duration_stats
      const percentiles = main.duration_percentiles
      expect(main).not.toHaveProperty("run_cost_model_calls")
      expect(stats.stats?.field).toBe("durationMs")
      expect(percentiles.percentiles?.field).toBe("durationMs")
    }
  })

  it("运行开销各项也按阶段拆，Token 含输入与输出", () => {
    const stageAggs = (aggs.by_node as { aggs: Record<string, unknown> }).aggs
    expect(stageAggs).toHaveProperty("run_cost_tool_calls")
    expect(stageAggs).toHaveProperty("run_cost_model_calls")
    expect(stageAggs).toHaveProperty("run_cost_total_tokens")
    // 输入/输出分开统计，弹窗那两列直接读这两个；总量留着是因为它还含缓存。
    expect(stageAggs).toHaveProperty("run_cost_input_tokens")
    expect(stageAggs).toHaveProperty("run_cost_output_tokens")
    expect(stageAggs).toHaveProperty("run_cost_user_input_requests")
  })

  it("不再按工具分桶", () => {
    // 这一列曾经存在，但两个数都错：terms 的 doc_count 是「多少轮用过」而不是调用
    // 次数，而 exclude 又把 read_file / edit_file 这些大头全过滤掉了，于是「562 次
    // 调用」旁边只列得出一个「6」。拿不到每工具调用次数之前，不如不展示。
    const stageAggs = (aggs.by_node as { aggs: Record<string, unknown> }).aggs
    expect(stageAggs).not.toHaveProperty("by_tool")
  })
})

describe("阶段分析的解析", () => {
  it("阶段按总忙碌时长倒序，最吃时间的排最前", () => {
    const parsed = parseProjectModeStageAnalysis("p1", {
      main_agent_conversations: {
        doc_count: 60,
        duration_stats: { sum: 900_000, avg: 15_000 },
        duration_percentiles: { values: { "95.0": 48_000 } }
      },
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
      main_agent_conversations: {
        doc_count: 40,
        duration_stats: { sum: 700_000, avg: 17_500 },
        duration_percentiles: { values: { "95.0": 52_000 } }
      },
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
      main_agent_conversations: {
        doc_count: 0,
        duration_stats: { sum: null, avg: null },
        duration_percentiles: { values: { "95.0": null } }
      },
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
})

it("keeps root conversation/duration separate from the whole tree cost", () => {
  const parsed = parseProjectModeStageAnalysis("p", {
    main_agent_conversations: {
      doc_count: 1,
      duration_stats: { sum: 1000, avg: 1000 }
    },
    run_cost_tool_calls: { value: 80 },
    run_cost_model_calls: { value: 13 },
    run_cost_total_tokens: { value: 14000 },
    by_node: { buckets: [] }
  })
  expect(parsed.total.conversationCount).toBe(1)
  expect(parsed.total.totalDurationMs).toBe(1000)
  expect(parsed.total.runCost).toMatchObject({ toolCalls: 80, modelCalls: 13, totalTokens: 14000 })
})
