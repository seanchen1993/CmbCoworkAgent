import {
  buildProjectModeRunCostAggs,
  parseProjectModeRunCost
} from "./project-mode-run-cost-metrics"
import type { ProjectModeRunCost } from "./project-mode-run-cost-metrics"
import { extractHarnessNodeGroup } from "../../shared/harness-stage-bucket"

/**
 * 单个项目的「阶段耗时分析」：把这个项目在所选时间范围内的轮次按工作流阶段拆开，
 * 每个阶段给出耗时、Token 和调用次数，用来回答「跑插件慢在哪个阶段」。
 *
 * ── 一个必须说清楚的口径 ──────────────────────────────────────
 *
 * trace 上的 harnessNodeName 记的是「这轮对话开始时，特性处在哪个阶段」。所以这里
 * 的耗时是**归属到该阶段的 Agent 忙碌时长**，不是「这个阶段花了多久」。
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

/** 每阶段展示的工具排行条数。弹窗是给人看的，不是给人翻的。 */
export const STAGE_TOP_TOOL_LIMIT = 8

/**
 * 工具种类数的统计上限。
 *
 * 用同一个 terms 聚合多取一些桶、再在解析时切出前 8 条，而不是另起一个
 * cardinality：cardinality 不支持 exclude，算出来会把被过滤掉的内置工具也计进去，
 * 于是「共 N 种」和下面列出的徽章不是一个口径，反而更误导。
 *
 * 30 是按实际工具数取的：排除内置工具后，一个阶段能用到的自定义 / MCP 工具通常
 * 十几个。真超过就显示「30+ 种」，因为此时精确值已经不影响判断了。
 */
export const STAGE_TOOL_VARIETY_LIMIT = 30

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
  runCost: ProjectModeRunCost
}

export interface ProjectModeStageToolCount {
  tool: string
  /** 口径与「Tool 使用」模块完全一致，未做去重语义的修正。 */
  count: number
}

export interface ProjectModeStageRow {
  /** 原始 harnessNodeName，形如 `dev-编码实现`；无阶段归属的轮次落在未归因桶。 */
  nodeName: string
  /** 阶段大类（`${group}-${label}` 里的 group），取不到时为 null。 */
  group: string | null
  metrics: ProjectModeStageMetrics
  /** 调用次数最高的若干个，最多 STAGE_TOP_TOOL_LIMIT 条。 */
  topTools: ProjectModeStageToolCount[]
  /** 该阶段用到的工具种类数，与 topTools 同口径（同样排除了内置工具）。 */
  toolVariety: number
  /** 种类数触到统计上限，真实值只多不少，展示成「30+ 种」。 */
  toolVarietyTruncated: boolean
}

export interface ProjectModeStageAnalysis {
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
    runCost: {
      toolCalls: 0,
      modelCalls: 0,
      totalTokens: 0,
      userInputRequests: 0,
      userInputRequestDocs: 0
    }
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
    ...durationAggs()
  }
}

/**
 * 弹窗的聚合树。调用方要把它放进 mainAgentConversationAggs 里，和项目列表同口径。
 *
 * by_node 的 missing 桶用调用方给的未归因标签，和项目列表里已有的阶段细分保持一致，
 * 免得同一个项目在两处看到不同的阶段清单。
 */
export function buildProjectModeStageAnalysisAggs(
  unattributedNodeName: string,
  nodeLimit: number,
  toolExcludes: readonly string[]
): Record<string, unknown> {
  return {
    ...metricsAggs(),
    by_node: {
      terms: {
        field: "harnessNodeName",
        size: Math.max(1, nodeLimit),
        missing: unattributedNodeName
      },
      aggs: {
        ...metricsAggs(),
        by_tool: {
          terms: {
            field: "toolNames",
            size: STAGE_TOOL_VARIETY_LIMIT,
            exclude: [...toolExcludes]
          }
        }
      }
    }
  }
}

function parseMetrics(container: unknown): ProjectModeStageMetrics {
  const bucket = asRecord(container)
  const stats = asRecord(bucket.duration_stats)
  const percentileValues = asRecord(asRecord(bucket.duration_percentiles).values)
  return {
    conversationCount: asCount(bucket.doc_count),
    totalDurationMs: asCount(stats.sum),
    avgDurationMs: asCount(stats.avg),
    // ES 在桶为空时给 null，桶里只有一条时给那一条的值。两种都不是错误。
    p95DurationMs: asCount(percentileValues["95.0"]),
    runCost: parseProjectModeRunCost(bucket)
  }
}

function parseStageTools(container: unknown): {
  topTools: ProjectModeStageToolCount[]
  toolVariety: number
  toolVarietyTruncated: boolean
} {
  const buckets = asRecord(asRecord(container).by_tool).buckets
  if (!Array.isArray(buckets)) {
    return { topTools: [], toolVariety: 0, toolVarietyTruncated: false }
  }
  const tools = buckets
    .map((entry) => {
      const bucket = asRecord(entry)
      return { tool: asText(bucket.key), count: asCount(bucket.doc_count) }
    })
    .filter((item) => item.tool.length > 0)
  return {
    // 只展示前几条，但种类数按拿回来的全部桶算，这样「共 N 种」能告诉人下面
    // 那几个徽章不是全部。
    topTools: tools.slice(0, STAGE_TOP_TOOL_LIMIT),
    toolVariety: tools.length,
    toolVarietyTruncated: tools.length >= STAGE_TOOL_VARIETY_LIMIT
  }
}

/**
 * 解析成弹窗要的形状，阶段按「归属到该阶段的总忙碌时长」倒序——弹窗是用来找「慢在
 * 哪」的，最吃时间的排最前面。
 *
 * 注意各阶段之和不一定等于 total：工具排行做了 size 截断，而 total 没有；另外
 * by_node 的 terms 也有 size 上限，阶段特别多时尾部会被截掉。两个数不一致时以
 * total 为准。
 */
export function parseProjectModeStageAnalysis(
  projectId: string,
  mainAgentContainer: unknown
): ProjectModeStageAnalysis {
  const container = asRecord(mainAgentContainer)
  const nodeBuckets = asRecord(container.by_node).buckets
  const stages: ProjectModeStageRow[] = Array.isArray(nodeBuckets)
    ? nodeBuckets
        .map((entry) => {
          const bucket = asRecord(entry)
          const nodeName = asText(bucket.key)
          return {
            nodeName,
            group: extractHarnessNodeGroup(nodeName),
            metrics: parseMetrics(bucket),
            ...parseStageTools(bucket)
          }
        })
        .filter((stage) => stage.nodeName.length > 0)
        .sort((a, b) => b.metrics.totalDurationMs - a.metrics.totalDurationMs)
    : []

  return {
    projectId,
    total:
      Array.isArray(nodeBuckets) || container.doc_count !== undefined
        ? parseMetrics(container)
        : emptyMetrics(),
    stages
  }
}

export { emptyMetrics as emptyProjectModeStageMetrics }
