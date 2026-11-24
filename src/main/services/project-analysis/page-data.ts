import type {
  RunAnalysisData,
  RunAnalysisSessions,
  RunAnalysisStages
} from "../../../shared/project-run-analysis"
import type { AnalysisDataset } from "./full-data-review"
import { analysisPageRow } from "./project-diagnostics"

export interface ProjectPageData {
  projectList: Array<Record<string, unknown>>
  projectFeatures: Array<Record<string, unknown>>
  analysis: RunAnalysisData
  listAsOf: string
  /** Stage drilldowns fetched during creation; revisions reuse these results. */
  stages: Record<string, RunAnalysisStages>
  /** Exact session pages already read; revisions may only reuse these frozen pages. */
  sessions?: Record<string, RunAnalysisSessions>
}
export async function loadCompleteProjectList(
  query: (options: { status: "active" | "archived"; page: number; pageSize: number }) => Promise<{
    projects: object[]
    page: number
    pageSize: number
    truncated: boolean
    total: number
  }>,
  signal: AbortSignal
): Promise<object[]> {
  const projects: object[] = [],
    seen = new Set<string>()
  for (const status of ["active", "archived"] as const) {
    let count = 0,
      finished = false
    for (let page = 1; page <= 100; page++) {
      signal.throwIfAborted()
      const result = await query({ status, page, pageSize: 100 })
      signal.throwIfAborted()
      if (result.truncated || result.page !== page || result.pageSize <= 0)
        throw new Error("项目列表未完整返回，不能生成全量报告")
      for (const project of result.projects) {
        const id = (project as Record<string, unknown>).projectId
        if (typeof id !== "string" || seen.has(id))
          throw new Error("项目列表分页发生重复或状态变化，请重试获取完整快照")
        seen.add(id)
        projects.push(project)
        count++
      }
      if (result.projects.length < result.pageSize) {
        if (count < result.total) throw new Error("项目列表缺少部分记录，请重试")
        finished = true
        break
      }
    }
    if (!finished) throw new Error("项目列表超出分页范围，未生成抽样报告；请缩小范围")
  }
  return projects
}
const projectFields = [
  "projectId",
  "name",
  "description",
  "systemName",
  "adapterName",
  "adapterVersion",
  "creatorSapId",
  "creatorYstId",
  "creatorUserName",
  "creatorOrgName",
  "creatorUpperOrgLv0",
  "creatorUpperOrgLv1",
  "lifecycleStatus",
  "lifecycleCreatedAt",
  "lifecycleUpdatedAt",
  "compatible",
  "compatibilityStatus",
  "systemConstraintEverLoadedSuccessfully",
  "managedRunEverStarted",
  "managedRunCount",
  "runCost",
  "userInputRequestCountComplete",
  "featureCount",
  "conversationCount",
  "suspectedTechnicalDetailConversationCount",
  "devStageConversationCount",
  "devAssociatedFeatureCount",
  "hasError",
  "topSkills",
  "codeStats",
  "systemConstraintReads",
  "hookExecutions",
  "stageBuckets",
  "lastExecutedAt",
  "elapsedMs"
]
/** Whitelist the same visible fields as the project list; do not expose local workspace paths. */
export function projectListPageData(
  projects: object[],
  analysis: RunAnalysisData
): ProjectPageData {
  return {
    projectList: projects.map((project) =>
      Object.fromEntries(
        projectFields
          .filter((key) => Object.hasOwn(project, key))
          .map((key) => [key, (project as Record<string, unknown>)[key]])
      )
    ),
    projectFeatures: projects.flatMap((project) => {
      const row = project as Record<string, unknown>
      return Array.isArray(row.features)
        ? row.features.map((feature) => ({
            projectId: row.projectId,
            projectName: row.name,
            ...feature
          }))
        : []
    }),
    analysis,
    listAsOf: new Date().toISOString(),
    stages: {}
  }
}
export const PROJECT_LIST_BASIS =
  "项目列表页面字段：授权范围内的当前项目快照及项目级累计指标；不受报告周期截断，不能当作本周/月增量，也不等于筛选特性小计。elapsedMs为项目创建至最近主Agent执行结束的日历历时（毫秒），包含空闲时间，不是执行耗时或阶段停留天数。特性明细单独列出。"
export const PROJECT_ANALYSIS_BASIS =
  "项目分析页面字段：当前授权和筛选范围内的特性及累计运行指标；日期仅圈定名单，不把累计指标变成周/月增量。缺失不是0；子代理项目去重数不能按特性相加。"
export function pageDatasets(data: ProjectPageData): AnalysisDataset[] {
  return [
    { name: "项目列表", basis: PROJECT_LIST_BASIS, rows: data.projectList },
    { name: "项目列表特性", basis: PROJECT_LIST_BASIS, rows: data.projectFeatures },
    {
      name: "项目分析",
      basis: PROJECT_ANALYSIS_BASIS,
      rows: data.analysis.rows.map((row) => analysisPageRow(row, data.analysis.dataAsOf))
    }
  ]
}
