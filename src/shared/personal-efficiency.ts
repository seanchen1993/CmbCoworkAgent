import type { ProjectMetricFilters, ProjectMetricProjectItem } from "./project-metrics"

export type PersonalEfficiencyFilters = Pick<
  ProjectMetricFilters,
  "range" | "upperOrgLv1" | "dateBasis"
>

export interface PersonalEfficiencyValues {
  adoptionRate: number | null
  featureCount: number | null
  functionPoints: number | null
  bugCount: number | null
  defectDensity: number | null
  issueCount: number | null
  approvalDevelopmentDays: number | null
  aiPushRate: number | null
  idePushRate: number | null
  cliPushRate: number | null
  devclawPushRate: number | null
  idePushedLines: number | null
  cliPushedLines: number | null
  devclawPushedLines: number | null
  aiPushedLines: number | null
  totalPushedLines: number | null
}

export type PersonalEfficiencyMetric = keyof PersonalEfficiencyValues
export type PersonalEfficiencyWeights = Record<PersonalEfficiencyMetric, number>

export function emptyPersonalEfficiencyValues(): PersonalEfficiencyValues {
  return {
    adoptionRate: null,
    featureCount: null,
    functionPoints: null,
    bugCount: null,
    defectDensity: null,
    issueCount: null,
    approvalDevelopmentDays: null,
    aiPushRate: null,
    idePushRate: null,
    cliPushRate: null,
    devclawPushRate: null,
    idePushedLines: null,
    cliPushedLines: null,
    devclawPushedLines: null,
    aiPushedLines: null,
    totalPushedLines: null
  }
}

export const PERSONAL_EFFICIENCY_METRICS: Array<{
  key: PersonalEfficiencyMetric
  label: string
  unit: string
  monthly?: boolean
}> = [
  { key: "adoptionRate", label: "AI代码入库率", unit: "%" },
  { key: "featureCount", label: "周期内特性数", unit: "个" },
  { key: "functionPoints", label: "功能点", unit: "功能点" },
  { key: "bugCount", label: "缺陷数", unit: "个" },
  { key: "defectDensity", label: "平均缺陷密度", unit: "个/百功能点" },
  { key: "issueCount", label: "非功能问题数", unit: "个" },
  { key: "approvalDevelopmentDays", label: "特性审批完成到开发完成耗时", unit: "工作日" },
  { key: "aiPushRate", label: "累计 AI 入库代码占比（硅碳比）", unit: "%", monthly: true },
  { key: "idePushedLines", label: "devagent-ide 入库行数", unit: "行", monthly: true },
  { key: "idePushRate", label: "devagent-ide 入库占比", unit: "%", monthly: true },
  { key: "cliPushedLines", label: "devagent-cli 入库行数", unit: "行", monthly: true },
  { key: "cliPushRate", label: "devagent-cli 入库占比", unit: "%", monthly: true },
  { key: "devclawPushedLines", label: "DevClaw 入库行数", unit: "行", monthly: true },
  { key: "devclawPushRate", label: "DevClaw 入库占比", unit: "%", monthly: true },
  { key: "aiPushedLines", label: "累计 AI 入库行数", unit: "行", monthly: true },
  { key: "totalPushedLines", label: "总 Push 行数", unit: "行", monthly: true }
]

export function defaultPersonalEfficiencyWeights(): PersonalEfficiencyWeights {
  return Object.fromEntries(
    PERSONAL_EFFICIENCY_METRICS.map(({ key }) => [key, key === "adoptionRate" ? 100 : 0])
  ) as PersonalEfficiencyWeights
}

/** 百分比使用页面的百分数原值；不按人员范围归一化，不除以权重总和。 */
export function personalEfficiencyScore(
  values: PersonalEfficiencyValues,
  weights: PersonalEfficiencyWeights
): number | null {
  let score = 0
  let enabled = false
  for (const { key } of PERSONAL_EFFICIENCY_METRICS) {
    const weight = weights[key]
    if (!Number.isFinite(weight) || weight < -100 || weight > 100) return null
    if (weight === 0) continue
    enabled = true
    const value = values[key]
    if (value === null || !Number.isFinite(value)) return null
    score += value * weight
  }
  return enabled && Number.isFinite(score) ? score : null
}

export interface PersonalEfficiencyCodeItem {
  harnessProjectId: string
  prjCode: string
  roomName: string
  pushedAdoptedLines: number
  pushedEffectiveGeneratedLines: number
}

export interface PersonalEfficiencyCodeRow extends PersonalEfficiencyCodeItem {
  sapId: string
  userName: string
}

export interface PersonalEfficiencyPerson {
  sapId: string
  userName: string
  rooms: string[]
  values: PersonalEfficiencyValues
  projectCount: number
  durationProjectCount: number
  densityBugCount: number
  densityFunctionPoints: number
  pushedAdoptedLines: number | null
  pushedEffectiveGeneratedLines: number | null
  projects: ProjectMetricProjectItem[]
  code: PersonalEfficiencyCodeItem[]
}

export interface PersonalEfficiencyData {
  people: PersonalEfficiencyPerson[]
  month: string | null
  warnings: string[]
}
