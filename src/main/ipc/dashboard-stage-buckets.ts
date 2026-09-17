/**
 * 运营面板「项目模式」的两条归因口径：对话数算谁，产出归哪个桶。
 *
 * 抽出来是因为这两条规则原本内联在 dashboard.ts 的若干 ES 查询体里，而它们出错
 * 的方式是静默的：agg 嵌错一层，读取方 `asRecord(...)` 拿到 `{}`、`asNumber` 得
 * 0，界面显示 0 而不是报错，要等有人去翻 ES 才发现。真出过一次——stage×skill
 * 三桶挂在主 Agent filter 之外，一次用户轮次派出 10 个 Task 子代理就被记成 11
 * 次对话，「VibeCoding 对话远多于 Harness」看着像结论，其实是口径差。
 *
 * 所以这里把「agg 键名、过滤条件、嵌套层级、读取入口」收在一处：调用方用
 * `mainAgentConversationAggs` 写、用 `readMainAgentConversations` 读，永远不自己
 * 拼那个键名，嵌错层在结构上就不可能发生。
 *
 * 本模块只有纯函数（进出都是普通对象），可以脱离 Electron 与真实集群单测；访问
 * 控制、时间范围和真正的查询仍由 dashboard.ts 持有。
 */

import {
  STAGE_DONE_LABEL,
  STAGE_IN_PROGRESS_LABEL,
  type StageBucket
} from "../../shared/harness-stage-bucket"

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * 主动触发：`triggerSource=chat`。缺该字段的历史文档按主动触发处理，否则旧时间
 * 范围会整段落空。
 */
export function buildChatTriggeredTraceFilter(): Record<string, unknown> {
  return {
    bool: {
      should: [
        { term: { triggerSource: "chat" } },
        { term: { "triggerSource.keyword": "chat" } },
        { bool: { must_not: { exists: { field: "triggerSource" } } } }
      ],
      minimum_should_match: 1
    }
  }
}

/**
 * 项目模式对话数的唯一口径：主动触发的主 Agent root trace。
 *
 * 子 trace 会从 root 轮次继承 `triggerSource=chat`，所以只判主动触发拦不住
 * coordinator worker / workflow agent / task agent，必须再判 root。多 Agent 可观测
 * 性上线前的文档没有 traceKind 与 parent 字段，按 root 处理以兼容旧时间范围。
 */
export function projectModeMainAgentConversationFilter(): Record<string, unknown> {
  return {
    bool: {
      filter: [
        buildChatTriggeredTraceFilter(),
        {
          bool: {
            should: [
              { term: { traceKind: "root" } },
              { term: { "traceKind.keyword": "root" } },
              {
                bool: {
                  must_not: [
                    { exists: { field: "traceKind" } },
                    { exists: { field: "parentTraceId" } },
                    { exists: { field: "subagentKind" } }
                  ]
                }
              }
            ],
            minimum_should_match: 1
          }
        }
      ]
    }
  }
}

/** 承载主 Agent 口径子聚合的 agg 键。只有本模块拼它，调用方不碰。 */
const MAIN_AGENT_AGG_KEY = "main_agent_conversations"

/**
 * 把一组子聚合收进主 Agent 口径里。返回的对象供调用方展开进 `aggs`，
 * 其 doc_count 即该口径下的对话数。
 */
export function mainAgentConversationAggs(inner: Record<string, unknown>): Record<string, unknown> {
  return {
    [MAIN_AGENT_AGG_KEY]: {
      filter: projectModeMainAgentConversationFilter(),
      aggs: inner
    }
  }
}

/** `mainAgentConversationAggs` 的读取端：从一个桶里取出主 Agent 口径容器。 */
export function readMainAgentConversations(container: unknown): Record<string, unknown> {
  return asRecord(asRecord(container)[MAIN_AGENT_AGG_KEY])
}

/** 单个桶的 ES agg 键（trace 侧与 code 侧共用）。 */
export function stageBucketAggKey(bucket: StageBucket): string {
  return `sb_${bucket}`
}

/**
 * 单个桶的 trace 侧过滤条件（字段无 `properties.` 前缀，用于 trace 索引）。
 * 单一来源：既给 stageBucketTraceAggs 的分桶用，也给「查看对话」按桶过滤 trace 用。
 *  - 插件约束（Harness）= 进行中 + 有 Skill
 *  - VibeCoding        = 进行中但无 Skill ∪ 已完成（不论 Skill）
 *  - 未归因            = 其余状态 / 无状态
 */
export function stageBucketTraceFilterClause(bucket: StageBucket): Record<string, unknown> {
  const inProgress = { term: { harnessNodeStatus: STAGE_IN_PROGRESS_LABEL } }
  const done = { term: { harnessNodeStatus: STAGE_DONE_LABEL } }
  const hasSkill = { exists: { field: "usedSkills" } }
  switch (bucket) {
    case "plugin_constrained":
      return { bool: { filter: [inProgress, hasSkill] } }
    case "vibecoding":
      return {
        bool: {
          should: [{ bool: { filter: [inProgress], must_not: [hasSkill] } }, done],
          minimum_should_match: 1
        }
      }
    case "unattributed":
      return {
        bool: {
          must_not: [{ terms: { harnessNodeStatus: [STAGE_IN_PROGRESS_LABEL, STAGE_DONE_LABEL] } }]
        }
      }
  }
}

/** trace 侧三桶（只数对话，无子聚合）。 */
export function stageBucketTraceAggs(): Record<string, unknown> {
  return {
    [stageBucketAggKey("plugin_constrained")]: {
      filter: stageBucketTraceFilterClause("plugin_constrained")
    },
    [stageBucketAggKey("vibecoding")]: {
      filter: stageBucketTraceFilterClause("vibecoding")
    },
    [stageBucketAggKey("unattributed")]: {
      filter: stageBucketTraceFilterClause("unattributed")
    }
  }
}

/**
 * code 侧三桶：每桶各包一份相同的 `perBucketAggs`（code_gen/code_adopt/pushed），
 * 于是每桶都能独立产出一份干净的 DashboardCodeStats，不会把不同状态的采纳率混加。
 * `unattributed` 取 进行中/已完成 的补集，因此也会收进缺 harnessNodeStatus 的
 * 历史或未解析事件。
 *
 * 注意与 trace 侧的字段差异：事件索引上这些字段带 `properties.` 前缀。
 */
export function stageBucketCodeAggs(
  perBucketAggs: Record<string, unknown>
): Record<string, unknown> {
  const inProgress = { term: { "properties.harnessNodeStatus": STAGE_IN_PROGRESS_LABEL } }
  const done = { term: { "properties.harnessNodeStatus": STAGE_DONE_LABEL } }
  const hasSkill = { exists: { field: "properties.usedSkills" } }
  return {
    [stageBucketAggKey("plugin_constrained")]: {
      filter: { bool: { filter: [inProgress, hasSkill] } },
      aggs: perBucketAggs
    },
    // VibeCoding = 进行中但绕过插件（无 Skill）∪ 已完成后的自由产出。
    [stageBucketAggKey("vibecoding")]: {
      filter: {
        bool: {
          should: [{ bool: { filter: [inProgress], must_not: [hasSkill] } }, done],
          minimum_should_match: 1
        }
      },
      aggs: perBucketAggs
    },
    [stageBucketAggKey("unattributed")]: {
      filter: {
        bool: {
          must_not: [
            {
              terms: { "properties.harnessNodeStatus": [STAGE_IN_PROGRESS_LABEL, STAGE_DONE_LABEL] }
            }
          ]
        }
      },
      aggs: perBucketAggs
    }
  }
}

/** 从一个带 `sb_*` 过滤桶的容器里读出每桶对话数。 */
export function parseStageBucketConversations(container: unknown): Record<StageBucket, number> {
  const c = asRecord(container)
  const read = (bucket: StageBucket): number =>
    asNumber(asRecord(c[stageBucketAggKey(bucket)]).doc_count)
  return {
    plugin_constrained: read("plugin_constrained"),
    vibecoding: read("vibecoding"),
    unattributed: read("unattributed")
  }
}
