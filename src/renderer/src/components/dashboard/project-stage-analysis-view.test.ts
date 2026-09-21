import { describe, expect, it } from "vitest"
import {
  formatStageDuration,
  resolveSlowestAvgStage,
  stageDurationShare,
  SLOWEST_AVG_MIN_CONVERSATIONS
} from "./project-stage-analysis-view"
import type { DashboardProjectModeStageRow } from "./use-dashboard"

function stage(
  nodeName: string,
  conversationCount: number,
  avgDurationMs: number
): DashboardProjectModeStageRow {
  return {
    nodeName,
    group: null,
    metrics: {
      conversationCount,
      totalDurationMs: conversationCount * avgDurationMs,
      avgDurationMs,
      p95DurationMs: avgDurationMs * 3,
      runCost: {
        toolCalls: 0,
        modelCalls: 0,
        totalTokens: 0,
        userInputRequests: 0,
        userInputRequestDocs: 0
      }
    },
    topTools: [],
    toolVariety: 0,
    toolVarietyTruncated: false
  }
}

describe("单轮最慢阶段的标记", () => {
  it("挑平均耗时最长的，而不是总耗时最长的", () => {
    // 这就是这个标记存在的理由：表格按总耗时排序，DEV 因为轮次多永远排第一，
    // 但真正慢的是评审——轮次少、单轮耗时接近 DEV 的两倍。
    const slowest = resolveSlowestAvgStage([
      stage("dev-编码实现", 142, 21_400),
      stage("review-代码评审", 18, 47_900),
      stage("test-测试验证", 37, 15_200)
    ])
    expect(slowest).toBe("review-代码评审")
  })

  it("轮次太少的阶段不参与评选", () => {
    // 只跑过 1 轮、恰好卡了 5 分钟的阶段，平均值会碾压所有正常阶段，
    // 但它不是「这个项目慢在哪」的答案。
    const slowest = resolveSlowestAvgStage([
      stage("dev-编码实现", 142, 21_400),
      stage("hotfix-紧急修复", 1, 300_000)
    ])
    expect(slowest).toBe("dev-编码实现")
  })

  it("刚好到门槛的阶段算数", () => {
    const slowest = resolveSlowestAvgStage([
      stage("dev-编码实现", 142, 21_400),
      stage("review-代码评审", SLOWEST_AVG_MIN_CONVERSATIONS, 90_000)
    ])
    expect(slowest).toBe("review-代码评审")
  })

  it("全都不够轮次时返回 null，不退而求其次", () => {
    // 样本量都不足的时候标一个出来，是在误导人。
    expect(resolveSlowestAvgStage([stage("a", 1, 90_000), stage("b", 2, 80_000)])).toBeNull()
    expect(resolveSlowestAvgStage([])).toBeNull()
  })
})

describe("耗时格式", () => {
  it("按量级换单位", () => {
    expect(formatStageDuration(420)).toBe("420ms")
    expect(formatStageDuration(21_400)).toBe("21.4s")
    expect(formatStageDuration(95_000)).toBe("1m35s")
    expect(formatStageDuration(3_600_000 + 12 * 60_000)).toBe("1h12m")
  })

  it("0 和异常值显示为「—」而不是 0ms", () => {
    // 这一列里 0 的含义是「没有数据」。写成 0ms 像个真实测量值，会被当成「非常快」。
    expect(formatStageDuration(0)).toBe("—")
    expect(formatStageDuration(-1)).toBe("—")
    expect(formatStageDuration(Number.NaN)).toBe("—")
  })

  it("分秒补零，宽度稳定", () => {
    // 右对齐的等宽列，不补零会跳动。
    expect(formatStageDuration(61_000)).toBe("1m01s")
    expect(formatStageDuration(3_600_000 + 5 * 60_000)).toBe("1h05m")
  })
})

describe("阶段占比", () => {
  it("按总耗时算比例", () => {
    expect(stageDurationShare(250, 1000)).toBe(0.25)
  })

  it("总耗时为 0 时没有比例，返回 0 而不是 NaN", () => {
    expect(stageDurationShare(0, 0)).toBe(0)
    expect(stageDurationShare(10, 0)).toBe(0)
  })

  it("比例封顶到 1", () => {
    // 阶段之和可能因为 terms 截断而对不上 total，别让进度条溢出。
    expect(stageDurationShare(1200, 1000)).toBe(1)
  })
})
