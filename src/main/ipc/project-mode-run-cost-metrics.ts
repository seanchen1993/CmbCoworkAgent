/**
 * 项目模式的「运行开销」四项：工具调用数、模型调用数、Token 数、请求用户回答次数。
 *
 * 四个都是 trace 顶层标量，直接 sum 就行，不用碰 `_raw`：
 *
 *   totalToolCalls        —— collector 取五个信号的 max（见 getTotalToolCalls），最准的那个
 *   modelCallCount        —— 服务端存的标量，取自客户端实时累加的 totalModelCalls
 *   totalTokens           —— 输入+输出+缓存
 *   userInputRequestCount —— 本轮调用 request_user_input 的次数
 *
 * 后两个字段是后加的，一度只能从 `_raw` 算。但会话记录列表（`_raw` 被刻意排除的预览
 * 路径）照样能正确显示它们，走的是 `asNumber(source.userInputRequestCount)`——这说明
 * 索引里确实有，可以聚合。
 *
 * ── 为什么每个 sum 都配一个 value_count ──────────────────────────
 *
 * ES 的 sum 对「字段不存在」返回 0，不是 null。这两个字段是 forward-only 的，老 trace
 * 上没有，所以时间范围一旦跨到字段上线之前，sum 会**悄悄少算且不报错**。
 *
 * value_count 数的是真正带该字段的文档数。它明显小于桶的 doc_count，就说明这段时间里
 * 混着没有该字段的老数据，界面该标注「部分数据缺失」，而不是把一个偏小的数当真值展示。
 *
 * 这个坑在本仓库已经踩过一次：Token 总量的兜底写成 `asNumber(sum, 输入+输出)`，而 sum
 * 缺字段时返回 0（有限数），兜底分支永远走不到，那一列长期恒显 0。见 dashboard-token-totals.ts。
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

/** 四项指标各自对应的 trace 字段。改名时这里和下面的 agg 键是一一对应的。 */
const RUN_COST_FIELDS = {
  toolCalls: "totalToolCalls",
  modelCalls: "modelCallCount",
  totalTokens: "totalTokens",
  userInputRequests: "userInputRequestCount"
} as const

export type ProjectModeRunCostKey = keyof typeof RUN_COST_FIELDS

export interface ProjectModeRunCost {
  toolCalls: number
  modelCalls: number
  totalTokens: number
  userInputRequests: number
  /**
   * 带 userInputRequestCount 字段的文档数。小于同桶的 conversationCount 时，说明这段
   * 时间里有老 trace 没这个字段，上面的 userInputRequests 是个下限而不是真值。
   *
   * 只对这一项做覆盖度检查：它是四项里最晚加的，另外三项在本仓库有记录以来一直都在。
   */
  userInputRequestDocs: number
}

export const EMPTY_PROJECT_MODE_RUN_COST: ProjectModeRunCost = {
  toolCalls: 0,
  modelCalls: 0,
  totalTokens: 0,
  userInputRequests: 0,
  userInputRequestDocs: 0
}

/**
 * 四项 sum + 一个覆盖度探针。
 *
 * 调用方要把它放进 `mainAgentConversationAggs(...)` 的 inner 里，和「对话数」同一个
 * filter。不这么做的话，同一行里会出现「对话数 5、模型调用数含着 50 个子 Agent 的
 * 调用」，看着像 bug 其实是口径差。
 */
export function buildProjectModeRunCostAggs(): Record<string, unknown> {
  return {
    run_cost_tool_calls: { sum: { field: RUN_COST_FIELDS.toolCalls } },
    run_cost_model_calls: { sum: { field: RUN_COST_FIELDS.modelCalls } },
    run_cost_total_tokens: { sum: { field: RUN_COST_FIELDS.totalTokens } },
    run_cost_user_input_requests: { sum: { field: RUN_COST_FIELDS.userInputRequests } },
    run_cost_user_input_docs: { value_count: { field: RUN_COST_FIELDS.userInputRequests } }
  }
}

/** 从一个已经解包到主 Agent 口径的桶里读出四项。桶不存在时全零。 */
export function parseProjectModeRunCost(container: unknown): ProjectModeRunCost {
  const bucket = asRecord(container)
  return {
    toolCalls: asCount(asRecord(bucket.run_cost_tool_calls).value),
    modelCalls: asCount(asRecord(bucket.run_cost_model_calls).value),
    totalTokens: asCount(asRecord(bucket.run_cost_total_tokens).value),
    userInputRequests: asCount(asRecord(bucket.run_cost_user_input_requests).value),
    userInputRequestDocs: asCount(asRecord(bucket.run_cost_user_input_docs).value)
  }
}

/**
 * 「请求用户回答次数」这个数是不是完整的。
 *
 * conversationCount 是同一个桶里的轮次数。带字段的文档数少于轮次数，就说明有老 trace
 * 不带这个字段，展示时要标注，而不是让人把下限当真值。
 *
 * 轮次数为 0 时没有什么可缺的，返回 true。
 */
export function isUserInputRequestCountComplete(
  runCost: ProjectModeRunCost,
  conversationCount: number
): boolean {
  if (conversationCount <= 0) return true
  return runCost.userInputRequestDocs >= conversationCount
}
