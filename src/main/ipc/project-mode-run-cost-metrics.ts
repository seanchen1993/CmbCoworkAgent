import { mainAgentConversationAggs } from "./dashboard-stage-buckets"
/**
 * 项目模式的「运行开销」：工具调用数、模型调用数、Token（总量 / 输入 / 输出）、
 * 请求用户回答次数。
 *
 * 全都是 trace 顶层标量，直接 sum 就行，不用碰 `_raw`：
 *
 *   totalToolCalls        —— collector 多路计数信号取 max（见 getTotalToolCalls），最准的那个
 *   modelCallCount        —— 服务端存的标量，取自客户端实时累加的 totalModelCalls
 *   totalTokens           —— 模型返回的总量，缺省时按输入+输出累计
 *   totalInputTokens      —— 模型上报的输入量（缓存子集不重复相加）
 *   totalOutputTokens     —— 只算输出
 *   userInputRequestCount —— 采集端完整观察工具调用后输出的请求输入次数。
 *
 * 字段缺失表示历史或不完整采集，不能解释为零。覆盖度以同范围所有 trace 为分母。
 * 采集端从同一工具计数器生成标量与每工具汇总，服务端必须显式透传此字段。

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

/** 每项指标对应的 trace 字段。改名时这里和下面的 agg 键是一一对应的。 */
const RUN_COST_FIELDS = {
  toolCalls: "totalToolCalls",
  modelCalls: "modelCallCount",
  totalTokens: "totalTokens",
  inputTokens: "totalInputTokens",
  outputTokens: "totalOutputTokens",
  userInputRequests: "userInputRequestCount"
} as const

export type ProjectModeRunCostKey = keyof typeof RUN_COST_FIELDS

export interface ProjectModeRunCost {
  toolCalls: number
  modelCalls: number
  totalTokens: number
  /**
   * 输入 / 输出分开的 token。
   *
   * totalTokens 优先使用模型返回的总量；缓存可能已经包含在 inputTokens 中，
   * 不应再次加到输入或总量。
   */
  inputTokens: number
  outputTokens: number
  userInputRequests: number
  /**
   * 带 userInputRequestCount 字段的文档数。小于同桶的 traceDocs 时，说明这段
   * 时间里有老 trace 没这个字段，上面的 userInputRequests 是个下限而不是真值。
   *
   * 这只识别字段缺失，无法识别历史上采集遗漏却已写成 0 的模型指标。
   */
  userInputRequestDocs: number
  /** Number of traces in the cost scope, including child agents. */
  traceDocs?: number
}

export const EMPTY_PROJECT_MODE_RUN_COST: ProjectModeRunCost = {
  toolCalls: 0,
  modelCalls: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  userInputRequests: 0,
  userInputRequestDocs: 0
}

/**
 * 各项 sum + 一个覆盖度探针。
 *
 * 放在项目或阶段桶内，与主 Agent 对话数过滤器平级。每条 trace 只记录自己的开销，
 * 因此这里必须包含主、子 Agent；不能用对话轮数的过滤器排除实际执行工作。
 */
export function buildProjectModeRunCostAggs(): Record<string, unknown> {
  return {
    run_cost_trace_docs: { value_count: { field: "traceId" } },
    run_cost_tool_calls: { sum: { field: RUN_COST_FIELDS.toolCalls } },
    run_cost_model_calls: { sum: { field: RUN_COST_FIELDS.modelCalls } },
    run_cost_total_tokens: { sum: { field: RUN_COST_FIELDS.totalTokens } },
    run_cost_input_tokens: { sum: { field: RUN_COST_FIELDS.inputTokens } },
    run_cost_output_tokens: { sum: { field: RUN_COST_FIELDS.outputTokens } },
    run_cost_user_input_requests: { sum: { field: RUN_COST_FIELDS.userInputRequests } },
    run_cost_user_input_docs: { value_count: { field: RUN_COST_FIELDS.userInputRequests } }
  }
}

/** Keep project costs outside the root-only conversation filter. */
export function buildProjectModeConversationAndCostAggs(
  conversations: Record<string, unknown>
): Record<string, unknown> {
  return { ...mainAgentConversationAggs(conversations), ...buildProjectModeRunCostAggs() }
}

/** 从项目或阶段的全量 trace 桶里读出各项。桶不存在时全零。 */
export function parseProjectModeRunCost(container: unknown): ProjectModeRunCost {
  const bucket = asRecord(container)
  return {
    ...(bucket.run_cost_trace_docs
      ? { traceDocs: asCount(asRecord(bucket.run_cost_trace_docs).value) }
      : {}),
    toolCalls: asCount(asRecord(bucket.run_cost_tool_calls).value),
    modelCalls: asCount(asRecord(bucket.run_cost_model_calls).value),
    totalTokens: asCount(asRecord(bucket.run_cost_total_tokens).value),
    inputTokens: asCount(asRecord(bucket.run_cost_input_tokens).value),
    outputTokens: asCount(asRecord(bucket.run_cost_output_tokens).value),
    userInputRequests: asCount(asRecord(bucket.run_cost_user_input_requests).value),
    userInputRequestDocs: asCount(asRecord(bucket.run_cost_user_input_docs).value)
  }
}

/**
 * 「请求用户回答次数」这个数是不是完整的。
 *
 * traceDocs 是开销范围内的文档数；旧响应缺少它时才用 conversationCount。文档数不足说明有老 trace
 * 不带这个字段，展示时要标注，而不是让人把下限当真值。
 *
 * 轮次数为 0 时没有什么可缺的，返回 true。
 */
export function isUserInputRequestCountComplete(
  runCost: ProjectModeRunCost,
  conversationCount: number
): boolean {
  const expectedDocs = runCost.traceDocs ?? conversationCount
  if (expectedDocs <= 0) return true
  return runCost.userInputRequestDocs >= expectedDocs
}
