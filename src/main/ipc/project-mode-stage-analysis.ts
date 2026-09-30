import {
  mainAgentConversationAggs,
  projectModeMainAgentConversationFilter,
  readMainAgentConversations
} from "./dashboard-stage-buckets"
import {
  buildProjectModeRunCostAggs,
  parseProjectModeRunCost,
  EMPTY_PROJECT_MODE_RUN_COST
} from "./project-mode-run-cost-metrics"
import type { ProjectModeRunCost } from "./project-mode-run-cost-metrics"
import { extractHarnessNodeGroup } from "../../shared/harness-stage-bucket"
import {
  legacyStageCostAgg,
  stageUsageAgg,
  readStageUsage,
  readLegacyStageCost,
  addStageCosts
} from "./project-mode-stage-usage"

/**
 * 单个项目的「阶段耗时分析」：把这个项目在所选时间范围内的轮次按工作流阶段拆开，
 * 每个阶段给出耗时、Token 和调用次数，用来回答「跑插件慢在哪个阶段」。
 *
 * ── 一个必须说清楚的口径 ──────────────────────────────────────
 *
 * 新 trace 按主会话期间观察到的阶段变化拆分忙碌时长；旧 trace 回退到开始阶段。
 *
 * 两者能差一个数量级：一个阶段可能跨三天，其中 Agent 只跑了 20 分钟。要算阶段真实
 * 墙钟耗时，得有阶段流转的时间戳，而节点状态是从工作区文件里读出来的，应用只是观察
 * 者，唯一的记录 harness.project.snapshot 还是 20 分钟一次的覆盖写，没有历史。
 *
 * 当前需求问的是「模型工作的时间太长」，正好就是 Agent 忙碌时长，所以这个口径对题。
 * 但界面上必须写明白，否则会被当成阶段周期读。
 *
 * ── 为什么平均和 P95 都要 ────────────────────────────────────
 *
 * 总耗时主要由轮次数决定，阶段之间轮次差很多时，总耗时排名基本等于轮次排名，看不出
 * 「慢」。平均每轮耗时才是「模型工作时间长不长」的直接指标。P95 用来分辨「整体都慢」
 * 和「大部分正常、少数几轮拖长了」——这两种情况的排查方向完全不同。
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0
  return value
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** P95：分辨「整体都慢」和「少数几轮拖长了」。 */
const DURATION_PERCENTS = [95] as const

export interface ProjectModeStageMetrics {
  /** 主动触发的主 Agent 轮次数，与项目列表的「对话数」同口径。 */
  conversationCount: number
  /** 归属到该阶段的 Agent 忙碌总时长，不是阶段的墙钟周期。 */
  totalDurationMs: number
  avgDurationMs: number
  /** 单轮耗时的 P95。轮次太少时 ES 给的是近似值，展示要留意。 */
  p95DurationMs: number
  /** Mixed old/new durations cannot be merged into an exact ES percentile. */
  p95Available?: boolean
  runCost: ProjectModeRunCost
}

export interface ProjectModeStageRow {
  /** 原始 harnessNodeName，形如 `dev-编码实现`；无阶段归属的轮次落在未归因桶。 */
  nodeName: string
  /** 阶段大类（`${group}-${label}` 里的 group），取不到时为 null。 */
  group: string | null
  metrics: ProjectModeStageMetrics
}

export interface ProjectModeStageAnalysis {
  durationAttribution?: { splitTurnCount: number; legacyTurnCount: number; truncated: boolean }
  costAttribution?: {
    callStartTraceCount: number
    turnStartTraceCount: number
    tokenUsageReportedCalls: number
    modelCalls: number
    truncated: boolean
  }
  projectId: string
  /** 全项目合计，弹窗顶部展示；不等于各阶段之和的场景见下面的注释。 */
  total: ProjectModeStageMetrics
  stages: ProjectModeStageRow[]
}

function emptyMetrics(): ProjectModeStageMetrics {
  return {
    conversationCount: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    p95DurationMs: 0,
    runCost: { ...EMPTY_PROJECT_MODE_RUN_COST }
  }
}

/** 耗时的三个数一起取：sum 和 avg 来自同一个 stats agg，省一次遍历。 */
function durationAggs(): Record<string, unknown> {
  return {
    duration_stats: { stats: { field: "durationMs" } },
    duration_percentiles: {
      percentiles: { field: "durationMs", percents: [...DURATION_PERCENTS] }
    }
  }
}

/** 阶段和全项目共用的一组指标聚合。 */
function metricsAggs(): Record<string, unknown> {
  return {
    ...buildProjectModeRunCostAggs(),
    ...mainAgentConversationAggs(durationAggs())
  }
}

const completeStageDurationFilter = {
  bool: {
    filter: [{ term: { stageDurationSchemaVersion: 1 } }, { term: { stageDurationComplete: true } }]
  }
}

function splitDurationAgg(unattributed: string, limit: number): Record<string, unknown> {
  return {
    filter: {
      bool: { filter: [projectModeMainAgentConversationFilter(), completeStageDurationFilter] }
    },
    aggs: {
      usage: {
        nested: { path: "stageDuration" },
        aggs: {
          by_node: {
            terms: {
              field: "stageDuration.nodeName",
              missing: unattributed,
              size: Math.max(1, limit)
            },
            aggs: {
              duration_stats: { stats: { field: "stageDuration.durationMs" } },
              duration_percentiles: {
                percentiles: { field: "stageDuration.durationMs", percents: [...DURATION_PERCENTS] }
              }
            }
          }
        }
      }
    }
  }
}

/**
 * 弹窗的聚合树直接放在项目范围内：开销包含子 Agent，对话数与耗时仅取主 Agent。
 *
 * by_node 的 missing 桶用调用方给的未归因标签，和项目列表里已有的阶段细分保持一致，
 * 免得同一个项目在两处看到不同的阶段清单。
 */
export function buildProjectModeStageAnalysisAggs(
  unattributedNodeName: string,
  nodeLimit: number,
  includeStageUsage = true,
  includeStageDuration = true
): Record<string, unknown> {
  return {
    ...metricsAggs(),
    ...(includeStageUsage ? { stage_usage: stageUsageAgg(unattributedNodeName, nodeLimit) } : {}),
    ...(includeStageDuration
      ? { stage_duration: splitDurationAgg(unattributedNodeName, nodeLimit) }
      : {}),
    by_node: {
      terms: {
        field: "harnessNodeName",
        size: Math.max(1, nodeLimit),
        missing: unattributedNodeName
      },
      aggs: {
        legacy_conversations: {
          filter: {
            bool: {
              filter: [projectModeMainAgentConversationFilter()],
              ...(includeStageDuration ? { must_not: [completeStageDurationFilter] } : {})
            }
          },
          aggs: durationAggs()
        },
        ...(includeStageUsage ? { legacy_cost: legacyStageCostAgg() } : buildProjectModeRunCostAggs())
      }
    }
  }
}

function parseMetrics(container: unknown): ProjectModeStageMetrics {
  const bucket = asRecord(container)
  const conversations = readMainAgentConversations(bucket)
  const stats = asRecord(conversations.duration_stats)
  const percentileValues = asRecord(asRecord(conversations.duration_percentiles).values)
  return {
    conversationCount: asCount(conversations.doc_count),
    totalDurationMs: asCount(stats.sum),
    avgDurationMs: asCount(stats.avg),
    // ES 在桶为空时给 null，桶里只有一条时给那一条的值。两种都不是错误。
    p95DurationMs: asCount(percentileValues["95.0"]),
    runCost: parseProjectModeRunCost(bucket)
  }
}

function parseLegacyDuration(container: unknown): ProjectModeStageMetrics {
  const bucket = asRecord(container)
  const stats = asRecord(bucket.duration_stats)
  const values = asRecord(asRecord(bucket.duration_percentiles).values)
  return {
    ...emptyMetrics(),
    conversationCount: asCount(bucket.doc_count),
    totalDurationMs: asCount(stats.sum),
    avgDurationMs: asCount(stats.avg),
    p95DurationMs: asCount(values["95.0"])
  }
}

/**
 * 解析成弹窗要的形状，阶段按「归属到该阶段的总忙碌时长」倒序——弹窗是用来找「慢在
 * 哪」的，最吃时间的排最前面。
 *
 * 注意各阶段之和不一定等于 total：by_node 的 terms 有 size 上限，阶段特别多时尾部
 * 会被截掉，而 total 没有截断。两个数不一致时以 total 为准。
 */
export function parseProjectModeStageAnalysis(
  projectId: string,
  traceContainer: unknown
): ProjectModeStageAnalysis {
  const container = asRecord(traceContainer)
  const nodeBuckets = asRecord(container.by_node).buckets
  const stages: ProjectModeStageRow[] = Array.isArray(nodeBuckets)
    ? nodeBuckets
        .map((entry) => {
          const bucket = asRecord(entry)
          const nodeName = asText(bucket.key)
          return {
            nodeName,
            group: extractHarnessNodeGroup(nodeName),
            metrics: {
              ...(bucket.legacy_conversations
                ? parseLegacyDuration(bucket.legacy_conversations)
                : parseMetrics(bucket)),
              runCost: readLegacyStageCost(bucket)
            }
          }
        })
        .filter((stage) => stage.nodeName.length > 0)
    : []

  const { costs, ...costAttribution } = readStageUsage(container)
  const stagesByName = new Map(stages.map((stage) => [stage.nodeName, stage]))
  const durationScope = asRecord(container.stage_duration)
  const splitBuckets = asRecord(asRecord(durationScope.usage).by_node).buckets
  if (Array.isArray(splitBuckets))
    for (const value of splitBuckets) {
      const bucket = asRecord(value)
      const nodeName = asText(bucket.key)
      if (!nodeName) continue
      const splitCount = asCount(bucket.doc_count)
      const splitStats = asRecord(bucket.duration_stats)
      const splitSum = asCount(splitStats.sum)
      const splitP95 = asCount(asRecord(asRecord(bucket.duration_percentiles).values)["95.0"])
      let row = stagesByName.get(nodeName)
      if (!row) {
        row = { nodeName, group: extractHarnessNodeGroup(nodeName), metrics: emptyMetrics() }
        stages.push(row)
        stagesByName.set(nodeName, row)
      }
      const oldCount = row.metrics.conversationCount
      row.metrics.conversationCount += splitCount
      row.metrics.totalDurationMs += splitSum
      row.metrics.avgDurationMs =
        row.metrics.conversationCount > 0
          ? row.metrics.totalDurationMs / row.metrics.conversationCount
          : 0
      row.metrics.p95Available = oldCount === 0 || splitCount === 0
      row.metrics.p95DurationMs = oldCount === 0 ? splitP95 : row.metrics.p95DurationMs
    }
  for (const [nodeName, runCost] of costs) {
    const existing = stagesByName.get(nodeName)
    if (existing) existing.metrics.runCost = addStageCosts(existing.metrics.runCost, runCost)
    else
      stages.push({
        nodeName,
        group: extractHarnessNodeGroup(nodeName),
        metrics: { ...emptyMetrics(), runCost }
      })
  }
  stages.sort(
    (a, b) =>
      b.metrics.totalDurationMs - a.metrics.totalDurationMs || a.nodeName.localeCompare(b.nodeName)
  )
  return {
    projectId,
    durationAttribution: {
      splitTurnCount: asCount(durationScope.doc_count),
      legacyTurnCount: Math.max(
        0,
        asCount(readMainAgentConversations(container).doc_count) - asCount(durationScope.doc_count)
      ),
      truncated: asCount(asRecord(asRecord(durationScope.usage).by_node).sum_other_doc_count) > 0
    },
    costAttribution,
    total:
      Array.isArray(nodeBuckets) || container.doc_count !== undefined
        ? parseMetrics(container)
        : emptyMetrics(),
    stages
  }
}

export { emptyMetrics as emptyProjectModeStageMetrics }
