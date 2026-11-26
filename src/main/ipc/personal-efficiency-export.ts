import {
  PERSONAL_EFFICIENCY_METRICS,
  defaultPersonalEfficiencyWeights,
  type PersonalEfficiencyData,
  type PersonalEfficiencyFilters
} from "../../shared/personal-efficiency"
import { rankPersonalEfficiency } from "../../shared/personal-efficiency-ranking"
import type { PersonalEfficiencyExportOptions } from "../../shared/personal-efficiency-export"
import { formatProjectDate, projectRangeBounds } from "../../shared/project-metric-calendar"
import type { DashboardExcelSheet } from "./dashboard-excel-workbook"

export function validatePersonalEfficiencyExportOptions(
  options: PersonalEfficiencyExportOptions
): void {
  if (options.keyword !== undefined && typeof options.keyword !== "string")
    throw new Error("人员搜索条件无效")
  if (options.sapId !== undefined && (typeof options.sapId !== "string" || !options.sapId.trim()))
    throw new Error("人员编号无效")
  if (
    options.sortBy !== undefined &&
    options.sortBy !== "score" &&
    !PERSONAL_EFFICIENCY_METRICS.some(({ key }) => key === options.sortBy)
  )
    throw new Error("个人排序字段无效")
  if (
    options.sortOrder !== undefined &&
    options.sortOrder !== "asc" &&
    options.sortOrder !== "desc"
  )
    throw new Error("个人排序方向无效")
  const weights = options.weights
  if (
    weights !== undefined &&
    (!weights ||
      PERSONAL_EFFICIENCY_METRICS.some(
        ({ key }) => !Number.isFinite(weights[key]) || weights[key] < -100 || weights[key] > 100
      ))
  )
    throw new Error("每项权重须为 -100 到 100 之间的数字")
}

export function personalEfficiencyExportSheets(
  data: PersonalEfficiencyData,
  filters: PersonalEfficiencyFilters,
  options: PersonalEfficiencyExportOptions = {},
  exportedAt = formatProjectDate(Date.now())
): DashboardExcelSheet[] {
  validatePersonalEfficiencyExportOptions(options)
  const weights = options.weights ?? defaultPersonalEfficiencyWeights()
  const sortBy = options.sortBy ?? "score"
  const sortOrder = options.sortOrder ?? "desc"
  const metrics = PERSONAL_EFFICIENCY_METRICS.filter((metric) => !metric.monthly || data.month)
  const sorted = rankPersonalEfficiency(
    data.people,
    weights,
    sortBy,
    sortOrder,
    Boolean(data.month)
  )
  const keyword = options.keyword?.trim().toLowerCase() ?? ""
  const selected = sorted.filter(({ person }) =>
    options.sapId
      ? person.sapId === options.sapId.trim()
      : `${person.userName} ${person.sapId}`.toLowerCase().includes(keyword)
  )
  if (!selected.length) throw new Error("当前范围内没有可导出的个人数据")
  const range = projectRangeBounds(filters.range)
  const summaryRows: DashboardExcelSheet["summaryRows"] = [
    ["统计开始", range.gte],
    ["统计结束（不含）", range.lt],
    ["室筛选", filters.upperOrgLv1?.join("、") || "全部（权限范围内）"],
    ["项目日期口径", filters.dateBasis === "created" ? "立项日期" : "开发完成日期"],
    ["导出时间", exportedAt],
    ...data.warnings.map((warning) => ["数据提示", warning])
  ]
  const projects: DashboardExcelSheet = {
    name: "负责项目明细",
    autoFilter: true,
    summaryRows,
    header: [
      "姓名",
      "员工号",
      "项目编号",
      "项目名称",
      "所属室",
      "关联特性",
      "功能点",
      "缺陷数",
      "缺陷密度",
      "非功能问题数",
      "特性最早审批",
      "开发完成",
      "特性审批完成到开发完成耗时"
    ],
    rows: selected.flatMap(({ person }) =>
      person.projects.map((project) => [
        person.userName,
        person.sapId,
        project.prjCode,
        project.prjName,
        project.roomName,
        project.features
          .map((feature) => [feature.featureCode, feature.featureName].filter(Boolean).join(" "))
          .join("\n"),
        project.notAdjustFuns ?? "",
        project.bugNum ?? "",
        project.defectDensityPer100Fp ?? "",
        project.kenanIssueCount ?? "",
        project.approvedDate ?? "",
        project.firstStStartDate || project.firstUatStartDate || "",
        project.approvalDevelopmentDays ?? ""
      ])
    )
  }
  const code: DashboardExcelSheet = {
    name: "本人代码明细",
    autoFilter: true,
    summaryRows,
    header: [
      "姓名",
      "员工号",
      "精益项目编号",
      "Harness 项目 ID",
      "代码所属室",
      "已 Push 采纳行数",
      "对应有效生成行数",
      "AI 代码入库率（%）"
    ],
    rows: selected.flatMap(({ person }) =>
      person.code.map((item) => [
        person.userName,
        person.sapId,
        item.prjCode,
        item.harnessProjectId,
        item.roomName,
        item.pushedAdoptedLines,
        item.pushedEffectiveGeneratedLines,
        item.pushedEffectiveGeneratedLines > 0
          ? (item.pushedAdoptedLines * 100) / item.pushedEffectiveGeneratedLines
          : ""
      ])
    )
  }
  if (options.sapId) return [projects, code]
  const indicators: DashboardExcelSheet = {
    name: "个人指标",
    autoFilter: true,
    summaryRows: [
      ...summaryRows,
      ["排名权重", ...metrics.map((metric) => metric.label)],
      ["权重值", ...metrics.map(({ key }) => weights[key])]
    ],
    header: [
      "排名",
      "姓名",
      "员工号",
      "综合得分",
      ...metrics.map(({ label, unit }) => (unit === "%" ? `${label}（%）` : label))
    ],
    rows: selected.map((row) => [
      row.rank ?? "",
      row.person.userName,
      row.person.sapId,
      row.score ?? "",
      ...metrics.map(({ key }) => row.person.values[key] ?? "")
    ])
  }
  return [indicators, projects, code]
}
