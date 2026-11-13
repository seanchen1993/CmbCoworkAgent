import { randomUUID } from "node:crypto"
import type { StructuredToolInterface } from "@langchain/core/tools"
import { tool } from "langchain"
import { z } from "zod"
import type { ProjectAnalysisEvidence } from "../../../shared/project-analysis-agent"
import type {
  RunAnalysisData,
  RunAnalysisFeature,
  RunAnalysisSessionRequest,
  RunAnalysisSessions,
  RunAnalysisStages
} from "../../../shared/project-run-analysis"
import {
  DEFAULT_RUN_ANALYSIS_FILTERS,
  filterRunAnalysis,
  groupRunAnalysis,
  runAnalysisFilterErrors,
  sumRunAnalysisCode
} from "../../../shared/project-run-analysis-metrics"
import { PROJECT_ANALYSIS_BASIS, PROJECT_LIST_BASIS, type ProjectPageData } from "./page-data"
import {
  analysisPageRow,
  diagnoseProjects,
  diagnosticThresholdsSchema
} from "./project-diagnostics"

const id = z.string().trim().min(1).max(512)
const pageArgs = {
  offset: z.number().int().min(0).max(100000).optional(),
  limit: z.number().int().min(1).max(20).optional()
}
const scopeArgs = {
  projectIds: z.array(id).min(1).max(100).optional(),
  featureSlug: id.nullable().optional()
}
const sort = z.enum(["idle", "span", "duration", "adoption", "vibe", "noSkill", "tools", "models"])
const conditions = z
  .array(
    z
      .object({
        metric: z.enum([
          "idleDays",
          "spanDays",
          "adoptionRate",
          "codeLines",
          "vibeShare",
          "noSkill",
          "tools",
          "models"
        ]),
        operator: z.enum(["gt", "gte", "lt", "lte", "eq", "between", "missing", "present"]),
        value: z.number().finite().nonnegative().optional(),
        upper: z.number().finite().nonnegative().optional()
      })
      .strict()
  )
  .max(8)

/** Ratios use summed numerators/denominators. Commit counts cannot be deduplicated across features. */
function summedCode(rows: RunAnalysisFeature[]) {
  const code = sumRunAnalysisCode(rows)
  return code ? { ...code, pushedCommitCount: null } : null
}
export function analysisOverview(rows: RunAnalysisFeature[]) {
  const sum = (
    key:
      | "conversationCount"
      | "noSkillConversationCount"
      | "toolCalls"
      | "modelCalls"
      | "totalDurationMs"
  ) =>
    rows.some((row) => row[key] !== null) ? rows.reduce((n, row) => n + (row[key] ?? 0), 0) : null
  const harness = rows.reduce((n, row) => n + row.harnessAdoptedLines, 0)
  const vibe = rows.reduce((n, row) => n + row.vibeAdoptedLines, 0)
  return {
    projectCount: new Set(rows.map((row) => row.projectId)).size,
    featureCount: rows.filter((row) => row.featureSlug !== null).length,
    unboundRows: rows.filter((row) => row.featureSlug === null).length,
    conversations: sum("conversationCount"),
    noSkillConversations: sum("noSkillConversationCount"),
    toolCalls: sum("toolCalls"),
    modelCalls: sum("modelCalls"),
    totalDurationMs: sum("totalDurationMs"),
    harnessAdoptedLines: harness,
    vibeAdoptedLines: vibe,
    vibeAdoptedShare: harness + vibe > 0 ? vibe / (harness + vibe) : null,
    code: summedCode(rows),
    codeCoverage: {
      reported: rows.filter((row) => row.codeStats !== null).length,
      total: rows.length
    },
    toolCoverage: {
      reported: rows.reduce((n, row) => n + row.toolReportedTraceCount, 0),
      total: rows.reduce((n, row) => n + row.traceCount, 0)
    },
    modelCoverage: {
      reported: rows.reduce((n, row) => n + row.modelReportedTraceCount, 0),
      total: rows.reduce((n, row) => n + row.traceCount, 0)
    }
  }
}

/** Reduce page size for wide rows, never silently truncate individual records. */
function paginate<T>(rows: T[], offset = 0, limit = 12) {
  const page: T[] = []
  let chars = 0
  for (const row of rows.slice(offset, offset + limit)) {
    const size = JSON.stringify(row).length
    if (page.length && chars + size > 18000) break
    page.push(row)
    chars += size
  }
  return {
    total: rows.length,
    offset,
    returned: page.length,
    nextOffset: offset + page.length < rows.length ? offset + page.length : null,
    rows: page
  }
}

export interface ProjectToolOptions {
  analysis?: RunAnalysisData
  /** May include archived list-only projects; absence from analysis must not be treated as zero. */
  projectIds: string[]
  getPages(): Promise<ProjectPageData>
  stages: Record<string, RunAnalysisStages>
  sessions: Record<string, RunAnalysisSessions>
  loadStages?: (
    request: RunAnalysisSessionRequest,
    signal: AbortSignal
  ) => Promise<RunAnalysisStages>
  loadSessions?: (
    request: RunAnalysisSessionRequest,
    signal: AbortSignal
  ) => Promise<RunAnalysisSessions>
  signal: AbortSignal
  record?: (label: string, summary: string, target?: ProjectAnalysisEvidence["target"]) => string
}

/** Shared read-only contract for analysis and reporting; no model-controlled room, query DSL or file access. */
export function createProjectTools(options: ProjectToolOptions): StructuredToolInterface[] {
  const allowed = new Set(options.projectIds)
  const checkProjects = (ids?: string[]) => {
    if (ids?.some((projectId) => !allowed.has(projectId)))
      throw new Error("项目不在当前筛选与权限范围内")
  }
  const requireAnalysis = () => {
    options.signal.throwIfAborted()
    if (!options.analysis) throw new Error("历史报告没有项目分析快照，请新建报告")
    return options.analysis
  }
  const select = (ids?: string[], featureSlug?: string | null) => {
    const data = requireAnalysis()
    checkProjects(ids)
    if (featureSlug !== undefined && ids?.length !== 1)
      throw new Error("查询特性时请同时指定唯一项目ID")
    const rows = data.rows.filter(
      (row) =>
        (!ids || ids.includes(row.projectId)) &&
        (featureSlug === undefined || row.featureSlug === featureSlug)
    )
    if (featureSlug !== undefined && !rows.length) throw new Error("该特性不在当前筛选与权限范围内")
    return { data, rows }
  }
  const evidence = (label: string, summary: string, target?: ProjectAnalysisEvidence["target"]) =>
    options.record ? { evidenceId: options.record(label, summary, target) } : {}
  const context = (data: RunAnalysisData, ids?: string[]) => ({
    basis: PROJECT_ANALYSIS_BASIS,
    dataAsOf: data.dataAsOf,
    membership: data.membership,
    range: data.range,
    projectsWithoutAnalysis: (ids ?? []).filter(
      (projectId) => !data.rows.some((row) => row.projectId === projectId)
    ),
    scopeNote:
      "仅聚合当前范围内匹配的特性；项目列表是项目全量累计。未进入项目分析名单的项目没有分析数据，不代表零活动。代码率按分子分母合算；跨特性去重commit数未提供。"
  })
  const list = tool(
    async (args) => {
      options.signal.throwIfAborted()
      checkProjects(args.projectIds)
      const pages = await options.getPages()
      options.signal.throwIfAborted()
      const keyword = args.keyword?.toLocaleLowerCase()
      const rows = (args.view === "features" ? pages.projectFeatures : pages.projectList).filter(
        (row) =>
          allowed.has(String(row.projectId)) &&
          (!args.projectIds || args.projectIds.includes(String(row.projectId))) &&
          (!keyword ||
            [
              row.projectId,
              row.name,
              row.projectName,
              row.slug,
              row.title,
              row.description,
              row.systemName,
              row.creatorUserName
            ].some(
              (value) => typeof value === "string" && value.toLocaleLowerCase().includes(keyword)
            ))
      )
      return JSON.stringify({
        basis: PROJECT_LIST_BASIS,
        dataAsOf: pages.listAsOf,
        projectsWithoutSnapshot: (args.projectIds ?? []).filter(
          (projectId) => !pages.projectList.some((row) => row.projectId === projectId)
        ),
        ...paginate(rows, args.offset, args.limit),
        ...evidence(
          "项目列表查询",
          `匹配 ${rows.length} 条${args.view === "features" ? "特性" : "项目"}记录；项目级累计口径`
        )
      })
    },
    {
      name: "project_list",
      description:
        "项目列表页面的背景及累计数据。用keyword定位项目ID，再按projectIds查一个或多个项目。view可选projects(默认)或features；包含创建人、插件、状态、开销、知识读取及代码等页面字段。按nextOffset翻页。",
      schema: z
        .object({
          view: z.enum(["projects", "features"]).optional(),
          projectIds: scopeArgs.projectIds,
          keyword: z.string().max(512).optional(),
          ...pageArgs
        })
        .strict()
    }
  )
  const analysis = tool(
    async (args) => {
      const { data, rows: scoped } = select(args.projectIds, args.featureSlug)
      const numeric = Object.fromEntries(
        (args.conditions ?? []).map(({ metric, operator, value, upper }) => [
          metric,
          { operator, value: value ?? null, upper }
        ])
      )
      if (Object.keys(numeric).length !== (args.conditions?.length ?? 0))
        throw new Error("同一指标请只设置一个条件；上下限请使用between")
      if (
        args.conditions?.some(
          (c) => c.operator !== "missing" && c.operator !== "present" && c.value === undefined
        )
      )
        throw new Error("数值比较需要value；比例请用0到1")
      const filters = {
        ...DEFAULT_RUN_ANALYSIS_FILTERS,
        keyword: args.keyword ?? "",
        stage: args.stage ?? "",
        status: args.status ?? "",
        numeric
      }
      const errors = runAnalysisFilterErrors(filters)
      if (errors.length) throw new Error(errors.join("；"))
      if (args.view === "projects" && (args.stage || args.status))
        throw new Error("项目没有单一阶段或特性状态，请用features视图筛选阶段/状态")
      // Project conditions must operate on complete in-scope project aggregates, not on a
      // low/high feature subset that would change the project's denominator.
      const groups =
        args.view === "projects"
          ? groupRunAnalysis(
              { ...data, rows: scoped },
              scoped.map((row) => ({ row, reasons: [] })),
              args.sort ?? "idle",
              args.descending ?? true
            )
          : undefined
      const filtered = filterRunAnalysis(
        { ...data, rows: groups ? groups.map((group) => group.row) : scoped },
        filters,
        args.sort ?? "idle",
        args.descending ?? true
      )
      const matchedProjects = new Set(filtered.map(({ row }) => row.projectId))
      const selectedGroups = groups?.filter((group) => matchedProjects.has(group.row.projectId))
      const matches = selectedGroups ? selectedGroups.flatMap((group) => group.features) : filtered
      const rows = matches.map((match) => match.row)
      const scope = {
        ...context(data, args.projectIds),
        conditionLevel: groups ? "项目在当前范围内的聚合指标" : "特性指标",
        availableRows: scoped.length,
        matchedRows: rows.length
      }
      if (args.view === "overview")
        return JSON.stringify({
          ...scope,
          ...analysisOverview(rows),
          ...evidence("指定范围汇总", `${rows.length} 条分析记录，比例按分子分母合算`)
        })
      const results = selectedGroups
        ? selectedGroups.map(({ row, totalFeatures, features }) => ({
            projectId: row.projectId,
            projectName: row.projectName,
            creator: row.creator,
            room: row.room,
            systemName: row.systemName,
            lifecycleStatus: row.lifecycleStatus,
            snapshotAt: row.snapshotAt,
            adapterName: row.adapterName,
            adapterVersion: row.adapterVersion,
            snapshotFeatureCount: row.snapshotFeatureCount,
            featureCount: totalFeatures,
            matchedRows: features.length,
            firstExecutedAt: row.firstExecutedAt,
            lastExecutedAt: row.lastExecutedAt,
            executionSpanDays: analysisPageRow(row, data.dataAsOf).executionSpanDays,
            idleDays: analysisPageRow(row, data.dataAsOf).idleDays,
            subagentTurns: row.subagentTurns,
            subagentKinds: row.subagentKinds,
            // This is the full project's distinct count, not a sum over selected features.
            wholeProjectSubagentCount: row.projectSubagentCount,
            summary: analysisOverview(features.map((feature) => feature.row))
          }))
        : rows.map((row) => analysisPageRow(row, data.dataAsOf))
      const page = paginate<(typeof results)[number]>(results, args.offset, args.limit)
      return JSON.stringify({
        ...scope,
        ...page,
        rows: page.rows.map((row) => ({
          ...row,
          ...("summary" in row
            ? evidence(
                `${row.projectName} · 项目汇总`,
                `${row.summary.conversations} 轮主对话；匹配特性累计小计`,
                { projectId: row.projectId }
              )
            : evidence(
                `${row.projectName} · ${row.featureTitle}`,
                `${row.conversationCount} 轮主对话；累计口径`,
                { projectId: row.projectId, featureSlug: row.featureSlug }
              ))
        }))
      })
    },
    {
      name: "project_analysis",
      description:
        "项目分析页查询。view=overview返回范围合计，projects先按项目汇总再应用conditions供筛选/对比，features(默认)返回特性字段。overview/features的conditions按特性筛选；不要用低采纳特性小计冒充整个项目。projectIds可指定一个或多个项目；featureSlug需唯一项目ID，null为未关联特性。conditions支持大小于/区间/缺失，比例用0到1。stage/status仅用于特性视图，精确匹配，__missing__为未记录。均为当前范围累计。",
      schema: z
        .object({
          view: z.enum(["overview", "projects", "features"]).optional(),
          ...scopeArgs,
          keyword: z.string().max(512).optional(),
          stage: z.string().max(512).optional(),
          status: z.string().max(512).optional(),
          conditions: conditions.optional(),
          sort: sort.optional(),
          descending: z.boolean().optional(),
          ...pageArgs
        })
        .strict()
    }
  )
  const diagnostics = tool(
    async (args) => {
      const { data, rows } = select(args.projectIds, args.featureSlug)
      const { projects, ...result } = diagnoseProjects(
        rows,
        data.dataAsOf,
        args.thresholds,
        args.rules
      )
      const candidates = projects.flatMap(({ features, ...project }) =>
        features.map((feature) => ({ ...project, ...feature }))
      )
      const page = paginate(candidates, args.offset, args.limit)
      return JSON.stringify({
        ...context(data, args.projectIds),
        ...result,
        paginationUnit: "命中条件的特性（含未关联特性记录）",
        ...page,
        rows: page.rows.map((row) => ({
          ...row,
          ...evidence(
            `${row.projectName} · 异常候选`,
            `${row.featureTitle}：${row.signals.map((s) => s.label).join("、")}；需业务核实`,
            { projectId: row.projectId, featureSlug: row.featureSlug }
          )
        }))
      })
    },
    {
      name: "diagnose_projects",
      description:
        "扫描所选范围全部特性找待关注项目，返回实际指标、阈值、覆盖缺失。支持projectIds/featureSlug下钻、rules指定关注项、thresholds调阈值。规则：idle未执行、span跨度、adoption低采纳、vibe占比、noSkill对话、calls工具调用。分页只控制返回，扫描不抽样；候选并非业务异常定论。",
      schema: z
        .object({
          ...scopeArgs,
          rules: z
            .array(z.enum(["idle", "span", "adoption", "vibe", "noSkill", "calls"]))
            .min(1)
            .max(6)
            .optional(),
          thresholds: diagnosticThresholdsSchema.optional(),
          ...pageArgs
        })
        .strict()
    }
  )
  const identity = { projectId: id, featureSlug: id.nullable() }
  const stages = tool(
    async ({ projectId, featureSlug, offset, limit }) => {
      const { rows } = select([projectId], featureSlug)
      const key = JSON.stringify([projectId, featureSlug])
      if (!options.stages[key]) {
        if (!options.loadStages)
          throw new Error("原报告未查询该阶段明细，请新建报告；修改时不刷新冻结数据")
        const result = await options.loadStages({ projectId, featureSlug }, options.signal)
        options.signal.throwIfAborted()
        options.stages[key] = result
      }
      const result = options.stages[key]
      return JSON.stringify({
        basis: "累计阶段诊断：开始阶段轮次与实际阶段耗时分别统计；不是阶段停留天数",
        dataAsOf: result.dataAsOf,
        ...paginate(
          [...result.rows].sort((a, b) => b.conversationCount - a.conversationCount),
          offset,
          limit
        ),
        ...evidence(
          `${rows[0].featureTitle}阶段诊断`,
          `${result.rows.length} 个阶段，可分页查看全部`,
          { projectId, featureSlug }
        )
      })
    },
    {
      name: "feature_stages",
      description:
        "下钻指定特性（featureSlug=null为未关联）的全部阶段诊断，可用nextOffset继续；包括各阶段对话、工具/模型调用和耗时。不能推算阶段停留天数。",
      schema: z.object({ ...identity, ...pageArgs }).strict()
    }
  )

  // Cursors are issued locally and tied to the exact scoped query. ES search_after is never model input.
  const cursors = new Map<string, { query: string; after: unknown[] | null; offset: number }>()
  const sessions = tool(
    async ({ projectId, featureSlug, metric = "main", nodeName, cursor }) => {
      const { rows } = select([projectId], featureSlug)
      const query = JSON.stringify([
        projectId,
        featureSlug,
        metric,
        nodeName === undefined ? {} : nodeName
      ])
      const position = cursor ? cursors.get(cursor) : { query, after: null, offset: 0 }
      if (!position || position.query !== query)
        throw new Error("会话游标无效或不属于此查询，请使用原查询返回的nextCursor")
      const key = JSON.stringify([query, position.after])
      if (!options.sessions[key]) {
        if (!options.loadSessions)
          throw new Error("原报告未查询该批对话明细，请新建报告；修改时不刷新冻结数据")
        const result = await options.loadSessions(
          {
            projectId,
            featureSlug,
            metric,
            ...(nodeName === undefined ? {} : { nodeName }),
            ...(position.after ? { after: position.after } : {})
          },
          options.signal
        )
        options.signal.throwIfAborted()
        if (
          result.after &&
          (!result.rows.length || JSON.stringify(result.after) === JSON.stringify(position.after))
        )
          throw new Error("对话分页游标未前进，请重新查询")
        options.sessions[key] = result
      }
      const result = options.sessions[key]
      const page = paginate(result.rows, position.offset, 20)
      const next =
        page.nextOffset !== null
          ? { query, after: position.after, offset: page.nextOffset }
          : result.after
            ? { query, after: result.after, offset: 0 }
            : null
      const nextCursor = next ? randomUUID() : null
      if (nextCursor && next) cursors.set(nextCursor, next)
      return JSON.stringify({
        basis:
          "项目分析对话元数据（非对话正文）。当前页不是全部记录；沿nextCursor翻页，不能从单页推断全量或用户意图。",
        projectId,
        featureSlug,
        metric,
        nodeName,
        total: result.total,
        returned: page.rows.length,
        nextCursor,
        rows: page.rows,
        ...evidence(
          `${rows[0].featureTitle}对话明细`,
          `共匹配 ${result.total} 条，本页 ${page.rows.length} 条`,
          { projectId, featureSlug }
        )
      })
    },
    {
      name: "feature_sessions",
      description:
        "查看特性对话元数据：时间、耗时、阶段、使用的Skill。metric可选main(默认)/noSkill/subagent/all，nodeName可选阶段（null为未归属）。返回nextCursor后原参数加cursor继续，勿把一页当全量。没有对话正文、代码diff。",
      schema: z
        .object({
          ...identity,
          metric: z.enum(["main", "noSkill", "subagent", "all"]).optional(),
          nodeName: id.nullable().optional(),
          cursor: id.optional()
        })
        .strict()
    }
  )
  return [list, analysis, diagnostics, stages, sessions]
}
