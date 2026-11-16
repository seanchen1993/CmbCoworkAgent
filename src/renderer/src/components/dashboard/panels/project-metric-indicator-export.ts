import {
  PROJECT_METRIC_TEAM,
  type ProjectMetricFilters,
  type ProjectMetricIndicatorExportData,
  type ProjectMetricOverviewData,
  type ProjectMetricSummaryData
} from "../../../../../shared/project-metrics"
import {
  PROJECT_METRIC_INDICATORS,
  PROJECT_AI_RATE_TIP,
  PROJECT_FEATURE_COVERAGE_TIP,
  PROJECT_MONTHLY_TIP
} from "../../../../../shared/project-metric-indicators"

import { formatProjectDate, projectDateMillis } from "../../../../../shared/project-metric-calendar"

const HEADER = ["指标", "智能化项目", "常规项目", "总体", "单位", "时间口径", "口径说明"]
const SOURCE_NAMES = {
  "devagent-ide": "devagent-ide",
  "devagent-cloud": "devagent-cloud",
  "devagent-cli": "devagent-cli",
  devclaw: "CMBDevClaw",
  cumulative: "累计 AI 入库代码"
}
const numeric = (value: number | null | undefined): number | string =>
  value == null || !Number.isFinite(value) ? "—" : value
function indicatorRows(
  summary: ProjectMetricSummaryData,
  overview: ProjectMetricOverviewData,
  filters: ProjectMetricFilters
): (number | string)[][] {
  const dateLabel =
    filters.dateBasis === "created" ? "项目立项时间" : "开发完成（ST发起优先，无ST取UAT发起）"
  const smart = summary.groups.find((g) => g.developmentMode === "devclaw")
  const regular = summary.groups.find((g) => g.developmentMode === "non_devclaw")
  const rows: (number | string)[][] = [
    [
      "应用研发智能化特性占比",
      "—",
      "—",
      numeric(overview.features?.rate == null ? null : overview.features.rate * 100),
      "%",
      dateLabel,
      `${PROJECT_FEATURE_COVERAGE_TIP} 智能化特性 ${overview.features?.intelligent ?? "—"}，总特性 ${overview.features?.total ?? "—"}。`
    ],
    [
      "AI代码入库率",
      "—",
      "—",
      numeric(
        overview.code?.pushedAdoptionRate == null ? null : overview.code.pushedAdoptionRate * 100
      ),
      "%",
      "代码生成时间",
      `${PROJECT_AI_RATE_TIP} 已Push采纳 ${numeric(overview.code?.pushedAdoptedLines)} 行，对应有效生成 ${numeric(overview.code?.pushedEffectiveGeneratedLines)} 行。`
    ]
  ]
  for (const metric of PROJECT_METRIC_INDICATORS) {
    const details =
      metric.key === "functionPointsPerPersonMonth"
        ? `智能化功能点 ${numeric(smart?.productivityFunctionPoints)}、报工 ${numeric(smart?.productivityWorkHours)} 小时；常规功能点 ${numeric(regular?.productivityFunctionPoints)}、报工 ${numeric(regular?.productivityWorkHours)} 小时。`
        : metric.key === "featuresPerPersonMonth"
          ? `智能化特性 ${numeric(smart?.throughputFeatureCount)}、报工 ${numeric(smart?.throughputWorkHours)} 小时；常规特性 ${numeric(regular?.throughputFeatureCount)}、报工 ${numeric(regular?.throughputWorkHours)} 小时。`
          : ""
    const unavailable = [smart, regular]
      .map((group) => {
        if (group?.[metric.key] != null) return ""
        const label = group?.developmentMode === "devclaw" ? "智能化" : "常规"
        if (label === "常规" && ["token", "codeLines", "tokensPerLine"].includes(metric.sample))
          return "常规项目无DevClaw遥测关联。"
        return `${label}：${group?.samples[metric.sample] ? "分母为零" : "无有效样本"}。`
      })
      .join("")
    rows.push([
      metric.label,
      numeric(smart?.[metric.key]),
      numeric(regular?.[metric.key]),
      "—",
      metric.unit,
      metric.online ? "项目首次上线时间" : dateLabel,
      `${metric.formula} ${details}${unavailable} 有效样本：智能化 ${smart?.samples[metric.sample] ?? 0}、常规 ${regular?.samples[metric.sample] ?? 0}。${metric.unit === "工作日" ? "按国家工作日日历，覆盖2026、2027年，日期缺失、倒置或日历未覆盖时不参与均值。" : ""}`
    ])
  }
  const categories = new Set(
    summary.groups.flatMap((g) => g.kenanIssueCategories.map((c) => c.category))
  )
  for (const category of categories)
    rows.push([
      `平均非功能问题数－${category}`,
      smart?.projectCount
        ? (smart.kenanIssueCategories.find((c) => c.category === category)?.count ?? 0) /
          smart.projectCount
        : "—",
      regular?.projectCount
        ? (regular.kenanIssueCategories.find((c) => c.category === category)?.count ?? 0) /
          regular.projectCount
        : "—",
      "—",
      "个",
      dateLabel,
      "该类别累计问题数 ÷ 本组全部样本项目数，包含零问题项目。"
    ])
  if (overview.monthly)
    for (const source of [
      { source: "cumulative" as const, ...overview.monthly.cumulative },
      ...overview.monthly.sources
    ])
      rows.push([
        `AI 代码入库占比－${SOURCE_NAMES[source.source]}`,
        "—",
        "—",
        numeric(source.rate === null ? null : source.rate * 100),
        "%",
        `自然月 ${overview.monthly.month}`,
        `${PROJECT_MONTHLY_TIP} 来源 ${numeric(source.pushedLines)} 行；组织总量 ${numeric(overview.monthly.totalPushedLines)} 行。${source.missing ? "数据未完整填报或查询不可用。" : overview.monthly.totalPushedLines === 0 ? "分母为零，比例不可用。" : ""}`
      ])
  return rows
}
export function projectMetricIndicatorSheets(
  data: ProjectMetricIndicatorExportData,
  filters: ProjectMetricFilters
): Array<{
  name: string
  header: string[]
  rows: (string | number)[][]
  summaryRows: (string | number)[][]
}> {
  const summaryRows: (string | number)[][] = [
    ["团队", PROJECT_METRIC_TEAM],
    ["统计开始", formatProjectDate(projectDateMillis(filters.range.from)!)],
    ["统计结束", formatProjectDate(projectDateMillis(filters.range.to)!)],
    [
      "项目日期口径",
      filters.dateBasis === "created" ? "立项时间" : "开发完成（ST发起优先，无ST取UAT发起）"
    ],
    ["项目阶段", filters.phaseStatuses?.join("、") || "全部"],
    ["功能点区间", `${filters.functionPointMin ?? "不限"}～${filters.functionPointMax ?? "不限"}`],
    ["智能化项目插件", filters.adapterName || "全部"],
    [
      "智能化项目累计Token区间",
      `${filters.tokenConsumptionMin ?? "不限"}～${filters.tokenConsumptionMax ?? "不限"}`
    ],
    ["项目数据保留起点", "2026-06-01 00:00:00"],
    ["导出时间（GMT+8）", data.exportedAt]
  ]
  return [
    {
      name: "团队指标",
      header: HEADER,
      rows: indicatorRows(data.team.summary, data.team.overview, filters),
      summaryRows
    },
    {
      name: "各室指标",
      header: ["室名称", ...HEADER],
      rows: data.rooms.flatMap((room) =>
        indicatorRows(room.summary, room.overview, filters).map((row) => [room.roomName, ...row])
      ),
      summaryRows
    }
  ]
}
