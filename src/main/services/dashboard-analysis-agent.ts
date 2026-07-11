import Store from "electron-store"
import { tool } from "langchain"
import { ChatOpenAI } from "@langchain/openai"
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import { z } from "zod"
import {
  getCustomModelConfigs,
  getOpenworkDir,
  type CustomModelConfig
} from "../storage"
import type {
  DashboardEsIndexAlias,
  DashboardEsQueryInput,
  DashboardEsQueryResult
} from "./dashboard-es-query"

export type DashboardAnalysisScope = "platform" | "project"

export interface DashboardAnalysisContext {
  scope?: DashboardAnalysisScope
  range?: { from: string; to: string }
  upperOrgLv1?: string | string[] | null
  projectId?: string | null
  featureSlug?: string | null
  panelSnapshot?: Record<string, unknown> | null
}

export interface DashboardAnalysisMessage {
  role: "user" | "assistant"
  content: string
}

export interface DashboardAnalysisAgentInput {
  question: string
  messages?: DashboardAnalysisMessage[]
  context?: DashboardAnalysisContext
}

export interface DashboardAnalysisToolCallSummary {
  name: string
  indexAlias?: DashboardEsIndexAlias
  operation?: string
  bodyHash?: string
  elapsedMs?: number
  warnings?: string[]
  error?: string
}

export interface DashboardAnalysisAgentResult {
  content: string
  modelId: string
  modelName: string
  toolCallCount: number
  toolCalls: DashboardAnalysisToolCallSummary[]
}

export type DashboardAnalysisQueryExecutor = (
  input: DashboardEsQueryInput
) => Promise<DashboardEsQueryResult>

export interface DashboardAnalysisAgentOptions {
  executeQuery: DashboardAnalysisQueryExecutor
}

const settingsStore = new Store({
  name: "settings",
  cwd: getOpenworkDir()
})

const dashboardEsQuerySchema = z.object({
  indexAlias: z.enum(["event", "trace"]).describe(
    "Allowed dashboard ES index alias. Use event for devclaw_event telemetry, trace for devclaw_trace agent traces."
  ),
  operation: z.enum(["search", "msearch", "count", "mapping", "field_caps"]).describe(
    "Read-only ES operation. Write/update/delete/index/cluster APIs are not available."
  ),
  body: z.unknown().optional().describe(
    "Elasticsearch Query DSL body. Do not include URL, HTTP method, credentials, or index names."
  ),
  context: z
    .object({
      scope: z.enum(["platform", "project"]).optional(),
      upperOrgLv1: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
      projectId: z.string().nullable().optional(),
      featureSlug: z.string().nullable().optional()
    })
    .optional()
    .describe("Optional extra dashboard context. The current panel context is enforced by the backend.")
})

type DashboardEsQueryToolArgs = z.infer<typeof dashboardEsQuerySchema>

const MAX_HISTORY_MESSAGES = 8
const MAX_TOOL_ROUNDS = 5
const MAX_TOOL_OUTPUT_CHARS = 80_000

function normalizeConfiguredModelId(modelId: string, configs: CustomModelConfig[]): string {
  const trimmed = modelId.trim()
  if (!trimmed) return ""
  const normalizedId = trimmed.startsWith("custom:") ? trimmed.slice("custom:".length) : trimmed

  const matchedById = configs.find((config) => config.id === normalizedId)
  if (matchedById) return matchedById.id

  const matchedByModel = configs.find(
    (config) => config.model === trimmed || config.model === normalizedId
  )
  return matchedByModel?.id ?? ""
}

export function resolveDashboardAnalysisModelConfig(): CustomModelConfig | null {
  const configs = getCustomModelConfigs()
  if (configs.length === 0) return null

  const stored = String(settingsStore.get("defaultModel", "") || "")
  const normalizedId = normalizeConfiguredModelId(stored, configs)
  if (normalizedId) {
    return configs.find((config) => config.id === normalizedId) ?? configs[0] ?? null
  }
  return configs[0] ?? null
}

function createDashboardAnalysisModel(config: CustomModelConfig): ChatOpenAI {
  if (!config.apiKey) throw new Error("未配置默认模型 API Key，无法启动运营指标分析 Agent")
  if (!config.model.trim()) throw new Error("默认模型名称为空，无法启动运营指标分析 Agent")

  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseUrl },
    maxTokens: config.maxOutputTokens,
    temperature: config.temperature,
    topP: config.topP,
    maxRetries: 0,
    modelKwargs: {
      parallel_tool_calls: false,
      ...(config.topK && config.topK > 0 ? { top_k: config.topK } : {})
    }
  })
}

export function mergeDashboardAnalysisToolContext(
  toolInput: DashboardEsQueryInput,
  enforcedContext?: DashboardAnalysisContext
): DashboardEsQueryInput {
  const toolContext = toolInput.context ?? {}
  return {
    ...toolInput,
    context: {
      ...toolContext,
      ...(enforcedContext?.scope !== undefined ? { scope: enforcedContext.scope } : {}),
      ...(enforcedContext?.upperOrgLv1 !== undefined
        ? { upperOrgLv1: enforcedContext.upperOrgLv1 }
        : {}),
      ...(enforcedContext?.projectId !== undefined ? { projectId: enforcedContext.projectId } : {}),
      ...(enforcedContext?.featureSlug !== undefined
        ? { featureSlug: enforcedContext.featureSlug }
        : {})
    }
  }
}

function truncateToolOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[Tool output truncated at ${MAX_TOOL_OUTPUT_CHARS} chars. Refine the query with aggregations or smaller size.]`
}

function contentToText(content: AIMessage["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return String(content ?? "")
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text
        return typeof text === "string" ? text : ""
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function describeDashboardAnalysisError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function buildDashboardToolRetryMessage(error: unknown): string {
  return [
    `dashboard_es_query tool call failed: ${describeDashboardAnalysisError(error)}`,
    "",
    "Please retry with corrected tool arguments.",
    "Requirements:",
    "- The tool arguments must be a strict JSON object.",
    "- indexAlias must be \"event\" or \"trace\".",
    "- operation must be one of \"search\", \"msearch\", \"count\", \"mapping\", \"field_caps\".",
    "- body must be a JSON object, not a string, Markdown code block, JavaScript object literal, or JSON with comments/trailing commas.",
    "- Do not include URL, HTTP method, credentials, or index names."
  ].join("\n")
}

function getInvalidToolCallRetryMessage(response: AIMessage): string | null {
  const record = response as unknown as Record<string, unknown>
  const invalidToolCalls = record.invalid_tool_calls
  const additionalKwargs = record.additional_kwargs as Record<string, unknown> | undefined
  const rawToolCalls = additionalKwargs?.tool_calls
  const hasInvalidToolCall =
    (Array.isArray(invalidToolCalls) && invalidToolCalls.length > 0) ||
    (Array.isArray(rawToolCalls) && rawToolCalls.length > 0)

  if (!hasInvalidToolCall) return null
  return buildDashboardToolRetryMessage(
    "The model produced an invalid tool call. The dashboard_es_query arguments were not valid strict JSON."
  )
}

function buildContextPrompt(context?: DashboardAnalysisContext): string {
  const scopeLabel = context?.scope === "project" ? "项目运营概览" : "平台运营概览"
  const range = context?.range ? `${context.range.from} ~ ${context.range.to}` : "未指定"
  const upperOrg = Array.isArray(context?.upperOrgLv1)
    ? context?.upperOrgLv1.join("、")
    : context?.upperOrgLv1 || "当前权限范围"
  const project = context?.projectId || "未指定"
  const feature = context?.featureSlug || "未指定"

  return [
    `当前面板：${scopeLabel}`,
    `时间范围：${range}`,
    `组织过滤：${upperOrg}`,
    `项目 ID：${project}`,
    `Feature：${feature}`,
    "当前面板已加载指标摘要：",
    JSON.stringify(context?.panelSnapshot ?? {}, null, 2).slice(0, 12000)
  ].join("\n")
}

function buildSystemPrompt(context?: DashboardAnalysisContext): string {
  return [
    "你是独立的运营指标分析 Agent，只负责分析平台运营概览和项目运营概览，不属于 CmbCoworkAgent，也不能访问文件、Shell、主 Agent 工具或用户工作区。",
    "",
    "你可以使用唯一工具 dashboard_es_query 查询运营 ES 数据。工具允许完整 Elasticsearch Query DSL body，但后端代码会强制只读操作、索引 alias、权限过滤、项目/组织过滤、size 限制和敏感字段脱敏。不要尝试 URL、HTTP method、credentials、任意 index、写入、更新、删除、reindex、bulk、cluster、cat、template 或 task API。",
    "调用 dashboard_es_query 时，工具参数必须是严格 JSON object；body 也必须是 JSON object。不要把 DSL 写成字符串、Markdown 代码块、JavaScript 对象字面量、带注释 JSON、带尾逗号 JSON，或混入解释文字。",
    "",
    "指标口径：",
    "- 平台运营概览主要来自 trace alias 的会话聚合和 event alias 的代码采纳聚合；项目运营概览只统计带 harnessProjectId 的项目模式数据。",
    "- 调用总次数/会话数通常是 traceId 的 value_count；活跃用户通常是 sapId cardinality；平均耗时来自 durationMs avg；Token 来自 totalInputTokens/totalOutputTokens/totalTokens。",
    "- Skill/Tool 调用：usedSkills/toolNames 的 value_count 是调用次数，cardinality 是种类数，terms 是排行。面板会过滤一部分系统内部工具后展示常用工具。",
    "- 已Commit采纳率 = adoptedLines / effectiveGeneratedLines。",
    "- 含未提交采纳率 = adoptedLines / (effectiveGeneratedLines + unmeasuredGeneratedLines)。",
    "- 已Push采纳率 = pushedAdoptedLines / pushedEffectiveGeneratedLines。",
    "- generatedLines 来自 code_gen.properties.lineCount；deletedLines 来自 code_gen.properties.deletedLineCount。",
    "- measuredGeneratedLines/effectiveGeneratedLines/adoptedLines 来自 code_adopt.properties.generatedLineCount/effectiveGeneratedLineCount/adoptedLineCount，且 adoptedLineCount/generatedLineCount/effectiveGeneratedLineCount 必须存在才算已测量。",
    "- pushed 口径是在 code_adopt 已测量过滤上追加 properties.pushed=true；pushedCommitCount 通常按 properties.commitSha cardinality。",
    "- effectiveGeneratedLines 会剔除被 Agent 后续改写覆盖的中间稿；unmeasuredGeneratedLines 通常来自 code_gen 已产生但没有对应 code_adopt 测量的生成量。",
    "- 项目运营概览的 skillCodeStats 表示由 Skill 生成的代码整体采纳明细，过滤条件是 code 事件带非空 properties.usedSkills；按 Skill 维度排行可能因为一段代码关联多个 skill 而出现归因加总大于整体的情况。",
    "",
    "ES 约定：",
    "- event alias 对应事件数据，常用事件包括 code_gen 和 code_adopt。",
    "- trace alias 对应 Agent trace 汇总数据。",
    "- trace 常用字段：traceId、threadId、startedAt、durationMs、sapId、ystId、userName、orgName、upperOrgLv0、upperOrgLv1、modelName/modelId、usedSkills、toolNames、totalToolCalls、totalInputTokens、totalOutputTokens、totalTokens、outcome、harnessProjectId、harnessFeatureSlug、harnessAdapterName、harnessAdapterVersion。",
    "- trace 观测关联字段为顶层字段：traceKind(root/subagent/workflow_run)、executionMode(normal/coordinator/workflow)、rootTraceId、rootThreadId、parentTraceId、parentThreadId、parentSpanId、linkType、subagentKind(task/coordinator_worker/workflow_agent)、coordinatorWorkerId/coordinatorWorkerTurn/coordinatorWorkerRole/coordinatorWorkerWorkload、workflowRunId/workflowAgentIndex/workflowPhase/workflowAgentLabel。统计主 Agent 口径优先过滤 traceKind=root；需要看异步子 Agent 时按 rootTraceId 关联。",
    "- event 顶层常用字段：eventName、eventTime、sapId、ystId、userName、orgName、upperOrgLv0、upperOrgLv1。",
    "- code_gen properties 常用字段：eventId/genEventId、lineCount、deletedLineCount、usedSkills、modelId/modelName、threadId、harnessProjectId、harnessFeatureSlug、harnessAdapterName、harnessAdapterVersion；子 Agent 生成代码时 properties.traceId 是子 traceId，properties.rootTraceId 才是主 traceId。",
    "- code_adopt properties 常用字段：genEventId、generatedAt、commitSha、pushed、generatedLineCount、effectiveGeneratedLineCount、adoptedLineCount、verdict、usedSkills、threadId、harnessProjectId、harnessFeatureSlug、harnessAdapterName、harnessAdapterVersion，以及与 code_gen 相同的 properties.traceKind/properties.executionMode/properties.rootTraceId/properties.parentTraceId/properties.subagentKind 等观测关联字段。",
    "- 分析生成漏斗时优先按生成时间过滤：code_gen 使用 eventTime；code_adopt 使用 properties.generatedAt。",
    "- 项目模式字段：event index 使用 properties.harnessProjectId/properties.harnessFeatureSlug；trace index 使用顶层 harnessProjectId/harnessFeatureSlug。",
    "- 不确定字段是否存在时，先用 mapping 或 field_caps 查询；不要编造字段。",
    "",
    "分析策略：",
    "- 如果用户问当前面板数值，先参考“当前面板已加载指标摘要”；如果要解释原因或找人群，再查询 ES 聚合明细。",
    "- 分析“为什么生成了但没有提交/没有采纳”时，可先按 sapId、upperOrgLv1、usedSkills、modelName、harnessProjectId/featureSlug 聚合 code_gen 与 code_adopt 的差值，找出贡献最大的用户/组织/项目/Skill。",
    "- 精确识别未提交代码需要用 genEventId 做 anti-join：分页取 code_gen 的 genEventId，再批量查询 code_adopt.properties.genEventId 是否存在；聚合差值只能称为近似。",
    "- 回答要区分数据事实、计算口径和推断原因；不要把相关性直接说成因果。",
    "- 如果只是按人/组织聚合估算“生成但未提交”，必须说明它是聚合近似；只有按 genEventId 做 anti-join 才能称为精确。",
    "",
    "回答要求：用中文，先给结论，再给关键证据和计算口径。不要暴露敏感原始字段。数据不足时说明需要补充哪类查询或 mapping。",
    "",
    "当前上下文：",
    buildContextPrompt(context)
  ].join("\n")
}

function buildMessages(input: DashboardAnalysisAgentInput): BaseMessage[] {
  const messages: BaseMessage[] = [new SystemMessage(buildSystemPrompt(input.context))]
  const history = (input.messages ?? [])
    .filter((message) => message.content.trim())
    .slice(-MAX_HISTORY_MESSAGES)

  for (const message of history) {
    messages.push(
      message.role === "assistant"
        ? new AIMessage(message.content)
        : new HumanMessage(message.content)
    )
  }
  messages.push(new HumanMessage(input.question))
  return messages
}

export async function runDashboardAnalysisAgent(
  input: DashboardAnalysisAgentInput,
  options: DashboardAnalysisAgentOptions
): Promise<DashboardAnalysisAgentResult> {
  const question = input.question.trim()
  if (!question) throw new Error("问题不能为空")

  const config = resolveDashboardAnalysisModelConfig()
  if (!config) throw new Error("未配置默认模型，无法启动运营指标分析 Agent")

  const toolCalls: DashboardAnalysisToolCallSummary[] = []
  const dashboardQueryTool = tool(
    async (toolInput) => {
      const queryInput = mergeDashboardAnalysisToolContext(toolInput, input.context)
      const result = await options.executeQuery(queryInput)
      toolCalls.push({
        name: "dashboard_es_query",
        indexAlias: queryInput.indexAlias,
        operation: queryInput.operation,
        bodyHash: result.meta.bodyHash,
        elapsedMs: result.meta.elapsedMs,
        warnings: result.meta.warnings
      })
      return truncateToolOutput(JSON.stringify(result, null, 2))
    },
    {
      name: "dashboard_es_query",
      description:
        "Run read-only Elasticsearch Query DSL against dashboard telemetry. Only event/trace aliases and search/msearch/count/mapping/field_caps operations are available. Backend code enforces permissions, panel context filters, limits, redaction, and audit metadata.",
      schema: dashboardEsQuerySchema
    }
  )

  const model = createDashboardAnalysisModel(config).bindTools([dashboardQueryTool])
  const messages = buildMessages(input)

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = (await model.invoke(messages)) as AIMessage
    const calls = Array.isArray(response.tool_calls) ? response.tool_calls : []
    const invalidToolCallRetryMessage = calls.length === 0 ? getInvalidToolCallRetryMessage(response) : null
    if (invalidToolCallRetryMessage) {
      messages.push(
        new HumanMessage(
          `${invalidToolCallRetryMessage}\n\nRetry by calling dashboard_es_query again with corrected JSON arguments.`
        )
      )
      continue
    }

    messages.push(response)

    if (calls.length === 0) {
      const content = contentToText(response.content).trim()
      return {
        content: content || "没有生成有效分析结果，请换个问题重试。",
        modelId: `custom:${config.id}`,
        modelName: config.model,
        toolCallCount: toolCalls.length,
        toolCalls
      }
    }

    for (const call of calls) {
      const toolCallId = call.id || `dashboard_tool_${round}_${messages.length}`
      let output: string
      let status: "success" | "error" = "success"
      try {
        output =
          call.name === "dashboard_es_query"
            ? String(await dashboardQueryTool.invoke(call.args as DashboardEsQueryToolArgs))
            : JSON.stringify({ error: `Unknown tool: ${call.name}` })
        if (call.name !== "dashboard_es_query") status = "error"
      } catch (error) {
        status = "error"
        output = buildDashboardToolRetryMessage(error)
        toolCalls.push({
          name: call.name,
          error: describeDashboardAnalysisError(error)
        })
      }
      messages.push(
        new ToolMessage({
          content: output,
          tool_call_id: toolCallId,
          name: call.name,
          status
        })
      )
    }
  }

  return {
    content: "分析过程超过工具调用上限。请缩小问题范围，或指定要看的指标、人员、组织或时间段。",
    modelId: `custom:${config.id}`,
    modelName: config.model,
    toolCallCount: toolCalls.length,
    toolCalls
  }
}
