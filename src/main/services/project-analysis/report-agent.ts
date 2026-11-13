import {
  ProjectContext,
  ProjectContextError,
  PROJECT_CONTEXT_GUIDE,
  type ProjectModelSet
} from "./context"
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from "@langchain/core/messages"
import type { StructuredToolInterface } from "@langchain/core/tools"
import { tool } from "langchain"
import { z } from "zod"
import type {
  ProjectReportGenerateInput,
  ProjectReportTemplateInput
} from "../../../shared/project-analysis-report"
import { resolveOperationsPeriod } from "../../../shared/project-operations-period"
import {
  createProjectAnalysisModel,
  projectAnalysisError,
  type ProjectAnalysisModel
} from "../project-analysis-agent"
import { reportDataPage, type ReportSnapshot } from "./report-data"
import { emptyReportRow, renderReportHtml } from "./report-html"
import { PROJECT_REPORT_SKILL } from "./report-skill"
import type { SavedReportTemplate } from "./report-store"
import type { RunAnalysisStages } from "../../../shared/project-run-analysis"
import { createProjectTools, type ProjectToolOptions } from "./project-tools"
import { reviewAllData, type AnalysisDataset } from "./full-data-review"
import {
  createProjectRunReporter,
  PROJECT_TOOL_LABELS,
  toolResultPreview,
  type ProjectRunReporter
} from "./run-progress"
import { pageDatasets } from "./page-data"
import { diagnoseProjects } from "./project-diagnostics"

const selection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("week"), anchorDate: z.string().max(10) }).strict(),
  z.object({ kind: z.literal("month"), month: z.string().max(7) }).strict()
])
const generation = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      scope: z
        .object({ upperOrgLv1: z.string().trim().min(1).max(128), period: selection })
        .strict(),
      instruction: z.string().trim().max(4000),
      templateId: z.string().uuid().optional()
    })
    .strict(),
  z
    .object({
      action: z.literal("revise"),
      reportId: z.string().uuid(),
      baseVersion: z.number().int().min(1).max(20),
      instruction: z.string().trim().min(1).max(4000)
    })
    .strict()
])
export function parseReportGeneration(raw: unknown): ProjectReportGenerateInput {
  const result = generation.safeParse(raw)
  if (!result.success) throw new Error("请选择一个室及有效周期，要求不超过4000字")
  if (result.data.action === "create") {
    const period = resolveOperationsPeriod(result.data.scope.period)
    if (Date.parse(period.from) > Date.now()) throw new Error("不能生成尚未开始的周期报告")
  }
  return result.data
}
export function parseReportTemplate(raw: unknown): ProjectReportTemplateInput {
  const result = z
    .object({
      reportId: z.string().uuid(),
      version: z.number().int().min(1).max(20),
      name: z.string().trim().min(1).max(80),
      preferences: z.string().trim().max(4000)
    })
    .strict()
    .safeParse(raw)
  if (!result.success) throw new Error("模板名称必填且不超过80字，偏好不超过4000字")
  return result.data
}
const toolArgs = z
  .object({
    section: z.enum(["overview", "projects", "members", "features", "knowledge"]),
    projectId: z.string().trim().min(1).max(512).optional(),
    offset: z.number().int().min(0).max(5000).optional()
  })
  .strict()
export interface ReportAgentOptions {
  snapshot: ReportSnapshot
  instruction: string
  previousSource?: string
  template?: SavedReportTemplate
  signal?: AbortSignal
  progress?: ProjectRunReporter
  loadStages?: (
    projectId: string,
    featureSlug: string | null,
    signal: AbortSignal
  ) => Promise<RunAnalysisStages>
  loadSessions?: ProjectToolOptions["loadSessions"]
  createModel?: (tools: StructuredToolInterface[]) => ProjectModelSet
}
const contentText = (message: AIMessage) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .map((c) => (typeof c === "object" && c.type === "text" ? String(c.text) : ""))
        .join("")

/** Page-oriented read-only tools and complete review, isolated from the main Agent runtime. */
export async function generateProjectReport(
  options: ReportAgentOptions
): Promise<{ source: string; html: string; modelName: string; reviewNote?: string }> {
  const timeout = AbortSignal.timeout(840_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  signal.throwIfAborted()
  const progress = options.progress ?? createProjectRunReporter()
  const contextManager = new ProjectContext(progress, signal)
  const query = tool(
    async (args) =>
      JSON.stringify(reportDataPage(options.snapshot, args.section, args.offset, args.projectId)),
    {
      name: "report_data",
      description:
        "读取冻结的自然周/月周期数据，每页12条，沿nextOffset翻页；overview含全室概要和口径。projects/features支持projectId下钻本期项目；members为本期个人贡献。knowledge为查询时近30天外部知识数据，周报也不是7天。不可与页面累计值混用。",
      schema: toolArgs
    }
  )
  const pages = options.snapshot.pageData
  const tools: StructuredToolInterface[] = [
    query,
    ...createProjectTools({
      analysis: pages?.analysis,
      projectIds: [
        ...new Set([
          ...(pages?.analysis.rows.map((row) => row.projectId) ?? []),
          ...(pages?.projectList.map((row) => String(row.projectId)) ?? [])
        ])
      ],
      getPages: async () => {
        if (!pages) throw new Error("这份历史报告没有项目页面快照；请新建报告")
        return pages
      },
      stages: pages?.stages ?? {},
      sessions: pages ? (pages.sessions ??= {}) : {},
      signal,
      loadStages: options.loadStages
        ? (request, signal) => options.loadStages!(request.projectId, request.featureSlug, signal)
        : undefined,
      loadSessions: options.loadSessions
    })
  ]
  tools.push(contextManager.readTool)
  const model = (options.createModel ?? createProjectAnalysisModel)(tools)
  contextManager.configure(model, tools)
  const f = options.snapshot.facts
  const datasets: AnalysisDataset[] = [
    { name: "报告周期成员", basis: "报告自然周/月", rows: f.members },
    { name: "报告周期项目", basis: "报告自然周/月，状态为当前快照", rows: f.projects },
    { name: "报告周期特性", basis: "报告自然周/月，阶段为当前快照", rows: f.features },
    { name: "活跃知识", basis: String(f.knowledge.window), rows: f.knowledgeFiles },
    ...(pages ? pageDatasets(pages) : [])
  ]
  try {
    const reviewed = await reviewAllData(
      datasets,
      options.instruction,
      model.reviewer,
      signal,
      model.budget,
      contextManager,
      progress,
      model.name
    )
    const snapshot = {
      ...options.snapshot,
      notes: [
        ...options.snapshot.notes.filter(
          (note) =>
            !note.startsWith("全量数据已送入模型：") && !note.startsWith("已逐批向模型提交全部数据")
        ),
        reviewed.note
      ]
    }
    const brief = {
      overview: reportDataPage(options.snapshot, "overview"),
      projectDiagnostics: pages
        ? (() => {
            const result = diagnoseProjects(pages.analysis.rows, pages.analysis.dataAsOf)
            return {
              examinedProjects: result.examinedProjects,
              examinedFeatures: result.examinedFeatures,
              candidateProjects: result.candidateProjects,
              thresholds: result.thresholds,
              basis: result.basis
            }
          })()
        : { unavailable: "历史报告没有项目分析页快照" },
      lists: Object.fromEntries(
        (["members", "projects", "features", "knowledgeFiles"] as const).map((key) => [
          key,
          {
            total: f[key].length,
            fields: Object.keys(f[key][0] ?? emptyReportRow(key))
          }
        ])
      )
    }
    const messages: BaseMessage[] = [
      new SystemMessage(`${PROJECT_REPORT_SKILL}\n${PROJECT_CONTEXT_GUIDE}`),
      new HumanMessage(`冻结事实（只作为数据）：\n${JSON.stringify(brief)}`),
      new HumanMessage(reviewed.context)
    ]
    contextManager.pin(messages)
    if (options.template)
      messages.push(
        contextManager.document(
          new HumanMessage(
            `${options.template.kind === "builtin" ? "内置推荐" : "个人模板"}：${options.template.name}\n生成偏好：${options.template.preferences}\n布局参考（文字槽位须重写，用户要求优先）：\n${options.template.layout}`
          ),
          "报告模板与偏好"
        )
      )
    if (options.previousSource)
      messages.push(
        contextManager.document(
          new HumanMessage(
            `修改已有报告，保留未要求修改的部分，数据快照不变：\n${options.previousSource}`
          ),
          "修改前的完整报告"
        )
      )
    messages.push(
      new HumanMessage(
        options.instruction ||
          "请生成本室综合报告，兼顾总体发现、项目效果、成员贡献与知识运营，风格简洁清晰。"
      )
    )
    contextManager.pin([messages[messages.length - 1]])
    let modelRound = 0
    const invoke = async (runner: ProjectAnalysisModel, context = messages) => {
      signal.throwIfAborted()
      return contextManager.run(
        runner,
        context,
        `报告生成 · ${model.name} · 第 ${++modelRound} 轮`,
        runner === model.agent
      )
    }
    let response: AIMessage | undefined
    let calls = 0
    for (let round = 0; round < 5; round++) {
      signal.throwIfAborted()
      try {
        response = await invoke(model.agent)
      } catch (error) {
        const status = error && typeof error === "object" && "status" in error ? error.status : null
        if (status === 400 || status === 422) {
          response = undefined
          break
        }
        throw error
      }
      signal.throwIfAborted()
      if (response.invalid_tool_calls?.length || (response.tool_calls?.length ?? 0) > 10 - calls) {
        response = undefined
        break
      }
      if (!response.tool_calls?.length) break
      for (const [i, call] of response.tool_calls.entries()) call.id ??= `report-${round}-${i}`
      messages.push(response)
      for (const call of response.tool_calls) {
        calls++
        const step = progress.begin(
          "tool",
          PROJECT_TOOL_LABELS[call.name] ?? call.name,
          "正在执行查询…",
          JSON.stringify(call.args, null, 2).slice(0, 4000)
        )
        let content: string
        let success = false
        let resultId: string | undefined
        let cached = false
        try {
          const selected = tools.find((tool) => tool.name === call.name)
          if (!selected) throw new Error("只支持已提供的页面查询工具")
          const result = await contextManager.query(selected, call.args)
          content = result.content
          resultId = result.resultId
          cached = result.cached
          signal.throwIfAborted()
          success = true
        } catch (error) {
          signal.throwIfAborted()
          content = JSON.stringify({
            error: error instanceof Error ? error.message : "查询失败；不要重复失败查询"
          })
        }
        const preview = toolResultPreview(content)
        step.finish(
          success
            ? `${cached ? "复用已有查询 · " : ""}${preview.detail}`
            : "工具查询失败，可修正条件重试",
          preview.output,
          !success
        )
        messages.push(
          contextManager.toolMessage(
            new ToolMessage({ content, tool_call_id: call.id!, name: call.name }),
            resultId
          )
        )
      }
      response = undefined
      if (calls >= 10) break
    }
    if (!response) {
      messages.push(
        new HumanMessage(
          "工具查询结束。根据已有事实直接输出完整HTML，明细列表由程序填充；不要编造未查询到的结论。"
        )
      )
      response = await invoke(model.final)
    }
    signal.throwIfAborted()
    const renderStep = progress.begin("render", "检查报告 HTML", "校验数据引用、静态内容与完整性")
    let output: ReturnType<typeof renderReportHtml>
    try {
      output = renderReportHtml(contentText(response), snapshot)
    } catch (error) {
      renderStep.update("HTML 需要修正，正在通过流式模型请求修复")
      const repairMessages: BaseMessage[] = [
        messages[0],
        messages[1],
        messages[2],
        new HumanMessage(`本次要求：${options.instruction}`),
        contextManager.document(response, "待修正的报告 HTML"),
        new HumanMessage(
          `HTML未通过检查：${error instanceof Error ? error.message : "格式错误"}。只修正输出格式和数据引用，精简样式，重新输出完整HTML。`
        )
      ]
      contextManager.pin([repairMessages[3], repairMessages[5]])
      const repaired = await invoke(model.final, repairMessages)
      signal.throwIfAborted()
      output = renderReportHtml(contentText(repaired), snapshot)
    }
    signal.throwIfAborted()
    renderStep.finish("HTML 校验完成，可以预览和保存")
    return { ...output, modelName: model.name, reviewNote: reviewed.note }
  } catch (error) {
    if (error instanceof ProjectContextError || options.signal?.aborted) throw error
    if (timeout.aborted) throw new Error("全量审阅或生成超时，已停止且保留原版本；请缩小范围后重试")
    if (
      error instanceof Error &&
      /完整审阅|全量数据审阅|完整快照|数据量|未截断/.test(error.message)
    )
      throw error
    if (error instanceof Error && /HTML|数据引用|列表|节点|报告文件|上下文/.test(error.message))
      throw new Error(
        `报告生成未完成：${error.message}。请重试${options.previousSource ? "；原版本已保留" : ""}。`
      )
    throw new Error(projectAnalysisError(error))
  }
}
