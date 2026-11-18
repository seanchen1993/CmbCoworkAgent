import {
  PROJECT_METRIC_TEAM,
  type ProjectMetricFilters,
  type ProjectMetricProjectItem,
  type ProjectMetricSamples
} from "./project-metrics"
import { projectDateMillis, projectRangeBounds } from "./project-metric-calendar"

export const PROJECT_METRIC_SAMPLE_KEYS = [
  "productivity",
  "throughput",
  "approvalDevelopment",
  "approvalCreation",
  "bug",
  "kenanIssue",
  "functionPoint",
  "defectDensity",
  "testLead",
  "uatLead",
  "delivery",
  "token",
  "codeLines",
  "tokensPerLine"
] as const satisfies ReadonlyArray<keyof ProjectMetricSamples>
export type ProjectMetricSampleKey = (typeof PROJECT_METRIC_SAMPLE_KEYS)[number]
export type ProjectMetricSampleReasons = Record<ProjectMetricSampleKey, string | null>

export function projectInPeriod(
  date: string | null,
  range: ProjectMetricFilters["range"]
): boolean {
  const value = projectDateMillis(date)
  const bounds = projectRangeBounds(range)
  return (
    value !== null &&
    value >= projectDateMillis(bounds.gte)! &&
    value < projectDateMillis(bounds.lt)!
  )
}

/** 候选只使用组织、保留范围及业务日期；顶部特性占比不受高级筛选影响。 */
export function projectCandidateReason(
  item: ProjectMetricProjectItem,
  filters: ProjectMetricFilters,
  online = false
): string | null {
  if (item.teamName !== PROJECT_METRIC_TEAM) return "项目不属于统计团队"
  if (filters.upperOrgLv1?.length && !filters.upperOrgLv1.includes(item.roomName))
    return "项目不属于所选室"
  const created = projectDateMillis(item.createDate)
  if (created === null || created < projectDateMillis("2026-06-01 00:00:00")!)
    return "项目不在已保存的立项范围内"
  const date = online
    ? item.firstOnlineDate
    : filters.dateBasis === "created"
      ? item.createDate
      : item.firstStStartDate || item.firstUatStartDate
  if (!date) return online ? "缺少首次上线日期" : "缺少项目筛选日期"
  if (!projectInPeriod(date, filters.range))
    return online ? "首次上线日期不在统计周期内" : "项目筛选日期不在统计周期内"
  return null
}

export function advancedProjectReason(
  item: ProjectMetricProjectItem,
  filters: ProjectMetricFilters
): string | null {
  if (filters.phaseStatuses?.length && !filters.phaseStatuses.includes(item.phaseStatus))
    return "项目阶段不符合筛选"
  if (
    filters.functionPointMin != null &&
    (item.notAdjustFuns === null || item.notAdjustFuns < filters.functionPointMin)
  )
    return "功能点低于下限或缺失"
  if (
    filters.functionPointMax != null &&
    (item.notAdjustFuns === null || item.notAdjustFuns > filters.functionPointMax)
  )
    return "功能点高于上限或缺失"
  if (item.developmentMode === "non_devclaw") return null
  if (filters.adapterName && !item.plugins.includes(filters.adapterName)) return "插件不符合筛选"
  const tokens =
    item.totalInputTokens !== null && item.totalOutputTokens !== null
      ? item.totalInputTokens + item.totalOutputTokens
      : null
  if (
    filters.tokenConsumptionMin != null &&
    (tokens === null || tokens < filters.tokenConsumptionMin)
  )
    return "累计Token低于下限或不可用"
  if (
    filters.tokenConsumptionMax != null &&
    (tokens === null || tokens > filters.tokenConsumptionMax)
  )
    return "累计Token高于上限或不可用"
  return null
}

function durationReason(
  value: number | null,
  start: string | null,
  end: string | null,
  startLabel: string,
  endLabel: string
): string | null {
  if (value !== null) return null
  if (!start) return `${startLabel}缺失`
  if (!end) return `${endLabel}缺失`
  const first = projectDateMillis(start),
    last = projectDateMillis(end)
  if (first === null) return `${startLabel}无效`
  if (last === null) return `${endLabel}无效`
  if (last < first) return `${endLabel}早于${startLabel}`
  return "起止日期超出工作日历覆盖范围"
}

export function projectMetricSampleReasons(
  item: ProjectMetricProjectItem,
  filters: ProjectMetricFilters
): ProjectMetricSampleReasons {
  const normal = projectCandidateReason(item, filters) || advancedProjectReason(item, filters)
  const online = projectCandidateReason(item, filters, true) || advancedProjectReason(item, filters)
  const missing = (ok: boolean, message: string): string | null => (ok ? null : message)
  const smart = item.developmentMode === "devclaw" ? null : "常规项目无CMBDevClaw遥测关联"
  const combine = (...reasons: Array<string | null>): string | null =>
    reasons.filter(Boolean).join("；") || null
  return {
    productivity: combine(
      normal,
      missing(item.notAdjustFuns !== null, "功能点缺失"),
      missing(item.devWorkHours !== null, "开发报工缺失")
    ),
    throughput: combine(
      online,
      missing(item.devWorkHours !== null, "开发报工缺失"),
      missing(item.featureCodes.length > 0, "未关联特性")
    ),
    approvalDevelopment: combine(
      normal,
      durationReason(
        item.approvalDevelopmentDays,
        item.approvedDate,
        item.firstStStartDate || item.firstUatStartDate,
        "最早特性审批日期",
        "开发完成日期"
      )
    ),
    approvalCreation: combine(
      normal,
      durationReason(
        item.approvalCreationDays,
        item.approvedDate,
        item.createDate,
        "最早特性审批日期",
        "立项日期"
      )
    ),
    bug: combine(normal, missing(item.bugNum !== null, "缺陷数缺失")),
    kenanIssue: normal,
    functionPoint: combine(normal, missing(item.notAdjustFuns !== null, "功能点缺失")),
    defectDensity: combine(
      normal,
      missing(item.bugNum !== null, "缺陷数缺失"),
      missing(item.notAdjustFuns !== null && item.notAdjustFuns > 0, "功能点缺失或不大于零")
    ),
    testLead: combine(
      normal,
      durationReason(
        item.testLeadDays,
        item.createDate,
        item.firstStStartDate,
        "立项日期",
        "首次ST发起日期"
      )
    ),
    uatLead: combine(
      normal,
      durationReason(
        item.uatLeadDays,
        item.createDate,
        item.firstUatStartDate,
        "立项日期",
        "首次UAT发起日期"
      )
    ),
    delivery: combine(
      normal,
      durationReason(
        item.deliveryDays,
        item.approvedDate,
        item.firstOnlineDate,
        "最早特性审批日期",
        "首次上线日期"
      )
    ),
    token: combine(
      normal,
      smart,
      missing(item.totalInputTokens !== null && item.totalOutputTokens !== null, "累计Token不可用")
    ),
    codeLines: combine(
      normal,
      smart,
      missing(item.pushedAdoptedLines !== null, "累计采纳行数不可用")
    ),
    tokensPerLine: combine(
      normal,
      smart,
      missing(item.totalInputTokens !== null && item.totalOutputTokens !== null, "累计Token不可用"),
      missing(
        item.pushedAdoptedLines !== null && item.pushedAdoptedLines > 0,
        "采纳行数不可用或不大于零"
      )
    )
  }
}
