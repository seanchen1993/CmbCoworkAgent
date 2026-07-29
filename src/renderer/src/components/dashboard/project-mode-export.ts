import type {
  DashboardProjectModeExportData,
  DashboardProjectModeProject,
  DashboardProjectModeTopUser
} from "./use-dashboard"

export type ProjectModeExportCell = string | number

export const PROJECT_MODE_USER_EXPORT_HEADER = [
  "排名",
  "SAP ID",
  "YST ID",
  "用户名",
  "部门",
  "项目对话数"
]

export const PROJECT_MODE_PROJECT_EXPORT_HEADER = [
  "序号",
  "项目 ID",
  "项目名称",
  "系统名称",
  "插件",
  "插件版本",
  "是否加载项目约束",
  "项目状态",
  "特性数",
  "对话数",
  "原始生成行数",
  "提交口径·提交采纳率",
  "提交口径·提交采纳明细",
  "提交口径·入库采纳率",
  "提交口径·入库采纳明细",
  "总量口径·提交采纳率",
  "总量口径·提交采纳明细",
  "总量口径·入库采纳率",
  "总量口径·入库采纳明细",
  "DEV阶段会话数",
  "DEV关联特性数",
  "Harness总量提交采纳率",
  "VibeCoding总量提交采纳率",
  "创建人",
  "创建人 SAP ID",
  "创建人 YST ID",
  "部门",
  "创建时间"
]

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return `${(value * 100).toFixed(2)}%`
}

function formatAdoptionDetail(
  numerator: number | undefined,
  denominator: number | undefined
): string {
  if (numerator === undefined || denominator === undefined) return "—"
  return `${numerator}/${denominator}`
}

function lifecycleLabel(status?: string): string {
  switch (status) {
    case "active":
      return "进行中"
    case "paused":
      return "已暂停"
    case "archived":
      return "已归档"
    case "completed":
      return "已完成"
    default:
      return status || "—"
  }
}

function formatDateTime(value?: string): string {
  if (!value) return "—"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN")
}

function creatorDepartment(project: DashboardProjectModeProject): string {
  if (project.creatorUpperOrgLv1 && project.creatorUpperOrgLv0) {
    return `${project.creatorUpperOrgLv1}/${project.creatorUpperOrgLv0}`
  }
  return project.creatorUpperOrgLv1 || project.creatorOrgName || "—"
}

function creatorName(project: DashboardProjectModeProject): string {
  return project.creatorUserName || project.creatorSapId || project.creatorYstId || "—"
}

function projectSortTime(project: DashboardProjectModeProject): number {
  const time = project.lifecycleCreatedAt ? Date.parse(project.lifecycleCreatedAt) : NaN
  return Number.isNaN(time) ? 0 : time
}

export function buildProjectModeUserExportRows(
  users: DashboardProjectModeTopUser[]
): ProjectModeExportCell[][] {
  return [...users]
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.userName.localeCompare(b.userName, "zh-CN", { numeric: true }) ||
        a.sapId.localeCompare(b.sapId)
    )
    .map((user, index) => [
      index + 1,
      user.sapId,
      user.ystId || "",
      user.userName,
      user.orgName || "—",
      user.count
    ])
}

export function buildProjectModeProjectExportSummaryRows(
  data: Pick<
    DashboardProjectModeExportData,
    | "projects"
    | "projectTotal"
    | "activeProjectTotal"
    | "archivedProjectTotal"
    | "projectLimit"
    | "projectsTruncated"
  >
): ProjectModeExportCell[][] {
  const displayedArchivedProjectCount = data.projects.filter(
    (project) => project.lifecycleStatus === "archived"
  ).length
  const displayedActiveProjectCount = data.projects.length - displayedArchivedProjectCount
  const rows: ProjectModeExportCell[][] = [
    ["统计口径", "合计", "进行中", "已归档"],
    ["匹配项目总量", data.projectTotal, data.activeProjectTotal, data.archivedProjectTotal],
    [
      "实际展示数量",
      data.projects.length,
      displayedActiveProjectCount,
      displayedArchivedProjectCount
    ]
  ]
  if (data.projectsTruncated) {
    rows.push([
      "导出提示",
      `项目总量超过 ${data.projectLimit.toLocaleString("zh-CN")} 条，本工作表仅展示前 ${data.projects.length.toLocaleString("zh-CN")} 条。`
    ])
  }
  return rows
}

export function buildProjectModeProjectExportRows(
  projects: DashboardProjectModeProject[]
): ProjectModeExportCell[][] {
  return [...projects]
    .sort((a, b) => {
      const archivedOrder =
        Number(a.lifecycleStatus === "archived") - Number(b.lifecycleStatus === "archived")
      return (
        archivedOrder ||
        projectSortTime(b) - projectSortTime(a) ||
        a.name.localeCompare(b.name, "zh-CN", { numeric: true }) ||
        a.projectId.localeCompare(b.projectId)
      )
    })
    .map((project, index) => {
      const code = project.codeStats
      return [
        index + 1,
        project.projectId,
        project.name,
        project.systemName || "",
        project.adapterName || "",
        project.adapterVersion || "",
        project.systemConstraintEverLoadedSuccessfully ? "是" : "否",
        lifecycleLabel(project.lifecycleStatus),
        project.featureCount,
        project.conversationCount,
        code?.generatedLines ?? 0,
        formatPercent(code?.measuredAdoptionRate),
        formatAdoptionDetail(code?.adoptedLines, code?.effectiveGeneratedLines),
        formatPercent(code?.pushedAdoptionRate),
        formatAdoptionDetail(code?.pushedAdoptedLines, code?.pushedEffectiveGeneratedLines),
        formatPercent(code?.inclusiveAdoptionRate),
        formatAdoptionDetail(code?.adoptedLines, code?.inclusiveEffectiveGeneratedLines),
        formatPercent(code?.inclusivePushedAdoptionRate),
        formatAdoptionDetail(code?.pushedAdoptedLines, code?.inclusiveEffectiveGeneratedLines),
        project.devStageConversationCount,
        project.devAssociatedFeatureCount,
        formatPercent(project.stageBuckets.pluginConstrained.codeStats?.inclusiveAdoptionRate),
        formatPercent(project.stageBuckets.vibecoding.codeStats?.inclusiveAdoptionRate),
        creatorName(project),
        project.creatorSapId || "",
        project.creatorYstId || "",
        creatorDepartment(project),
        formatDateTime(project.lifecycleCreatedAt)
      ]
    })
}
