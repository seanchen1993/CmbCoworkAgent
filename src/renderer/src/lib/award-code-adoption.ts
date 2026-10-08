import type { DashboardCodeStats } from "../components/dashboard/use-dashboard"

/** 四个 AI 代码入库率口径及其分子分母，统一用于三个奖项和导出。 */
export const AWARD_ADOPTION_FIELDS: Array<{
  key: string
  group: string
  metric: string
  field: keyof DashboardCodeStats
  numerator: keyof DashboardCodeStats
  denominator: keyof DashboardCodeStats
}> = [
  {
    key: "measured",
    group: "提交口径",
    metric: "提交",
    field: "measuredAdoptionRate",
    numerator: "adoptedLines",
    denominator: "effectiveGeneratedLines"
  },
  {
    key: "pushed",
    group: "提交口径",
    metric: "入库",
    field: "pushedAdoptionRate",
    numerator: "pushedAdoptedLines",
    denominator: "pushedEffectiveGeneratedLines"
  },
  {
    key: "inclusive",
    group: "总量口径",
    metric: "提交",
    field: "inclusiveAdoptionRate",
    numerator: "adoptedLines",
    denominator: "inclusiveEffectiveGeneratedLines"
  },
  {
    key: "inclusivePushed",
    group: "总量口径",
    metric: "入库",
    field: "inclusivePushedAdoptionRate",
    numerator: "pushedAdoptedLines",
    denominator: "inclusiveEffectiveGeneratedLines"
  }
]

const lineNumberFormat = new Intl.NumberFormat("zh-CN")

function formatNumber(value: number): string {
  return lineNumberFormat.format(Math.round(value))
}

export function formatAwardAdoptionPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  return `${(value * 100).toFixed(1)}%`
}

export function formatAwardAdoptionLines(
  codeStats: DashboardCodeStats | null,
  metric: (typeof AWARD_ADOPTION_FIELDS)[number]
): string | null {
  if (!codeStats) return null
  const formatLines = (field: keyof DashboardCodeStats): string => {
    const value = codeStats[field]
    return typeof value === "number" && Number.isFinite(value) ? formatNumber(value) : "—"
  }
  return `${formatLines(metric.numerator)} / ${formatLines(metric.denominator)} 行`
}

export function formatAwardAdoptionExportValues(codeStats: DashboardCodeStats | null): string[] {
  return AWARD_ADOPTION_FIELDS.map((metric) => {
    const percent = formatAwardAdoptionPercent(codeStats?.[metric.field])
    const lines = formatAwardAdoptionLines(codeStats, metric)
    return lines ? `${percent}（${lines}）` : percent
  })
}
