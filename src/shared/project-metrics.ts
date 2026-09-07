export type ProjectMetricDevelopmentMode = "devclaw" | "non_devclaw"

export interface ProjectMetricFilters {
  range: { from: string; to: string }
  upperOrgLv1?: string[]
  phaseStatuses?: string[]
  functionPointMin?: number | null
  functionPointMax?: number | null
  tokenConsumptionMin?: number | null
  tokenConsumptionMax?: number | null
  adapterName?: string | null
}

export interface ProjectMetricListOptions {
  developmentMode?: "all" | ProjectMetricDevelopmentMode
  keyword?: string
  departmentKeyword?: string
  page?: number
  pageSize?: 20 | 50 | 100
  sortBy?:
    | "deliveryDays"
    | "bugNum"
    | "notAdjustFuns"
    | "pushedAdoptedLines"
    | "tokensPerAdoptedLine"
  sortOrder?: "asc" | "desc"
}

export interface ProjectMetricSamples {
  bug: number
  functionPoint: number
  defectDensity: number
  testLead: number
  delivery: number
  token: number
  codeLines: number
  tokensPerLine: number
}

export interface ProjectMetricSummaryGroup {
  developmentMode: ProjectMetricDevelopmentMode
  projectCount: number
  avgBugCount: number | null
  avgFuncPointCount: number | null
  defectDensityPer100Fp: number | null
  avgTestLeadDays: number | null
  avgDeliveryDays: number | null
  avgInputTokens: number | null
  avgOutputTokens: number | null
  avgPushedAdoptedLines: number | null
  inputTokensPerAdoptedLine: number | null
  outputTokensPerAdoptedLine: number | null
  samples: ProjectMetricSamples
}

export interface ProjectMetricSummaryData {
  groups: ProjectMetricSummaryGroup[]
  pluginOptions: string[]
  truncated: boolean
}

export interface ProjectMetricProjectItem {
  prjCode: string
  prjName: string
  developmentMode: ProjectMetricDevelopmentMode
  plugins: string[]
  phaseStatus: string
  roomName: string
  groupName: string
  bugNum: number | null
  notAdjustFuns: number | null
  defectDensityPer100Fp: number | null
  pushedAdoptedLines: number | null
  createDate: string | null
  firstStStartDate: string | null
  firstOnlineDate: string | null
  approvedDate: string | null
  testLeadDays: number | null
  deliveryDays: number | null
  totalInputTokens: number | null
  totalOutputTokens: number | null
  inputTokensPerAdoptedLine: number | null
  outputTokensPerAdoptedLine: number | null
  tokensPerAdoptedLine: number | null
}

export interface ProjectMetricProjectsData {
  items: ProjectMetricProjectItem[]
  total: number
  page: number
  pageSize: number
  truncated: boolean
}
