export type ProjectMetricDevelopmentMode = "devclaw" | "non_devclaw"

export interface ProjectMetricFilters {
  range: { from: string; to: string }
  dateBasis?: "developmentCompleted" | "created"
  upperOrgLv1?: string[]
  groupNames?: string[]
  phaseStatuses?: string[]
  functionPointMin?: number | null
  functionPointMax?: number | null
  tokenConsumptionMin?: number | null
  tokenConsumptionMax?: number | null
  adapterName?: string | null
}

export interface ProjectMetricListOptions {
  exportAll?: boolean
  developmentMode?: "all" | ProjectMetricDevelopmentMode
  /** 项目明细按指定指标的有效样本过滤，先筛选再分页。 */
  metricSample?: keyof ProjectMetricSamples
  keyword?: string
  departmentKeyword?: string
  page?: number
  pageSize?: 20 | 50 | 100
  sortBy?:
    | "deliveryDays"
    | "bugNum"
    | "kenanIssueCount"
    | "notAdjustFuns"
    | "pushedAdoptedLines"
    | "tokensPerAdoptedLine"
  sortOrder?: "asc" | "desc"
}

export interface ProjectMetricSamples {
  productivity: number
  throughput: number
  approvalDevelopment: number
  approvalCreation: number
  bug: number
  kenanIssue: number
  functionPoint: number
  defectDensity: number
  testLead: number
  uatLead: number
  delivery: number
  token: number
  codeLines: number
  tokensPerLine: number
}

export interface ProjectMetricIssueCategoryCount {
  category: string
  count: number
}

export type ProjectMetricValueKey =
  | "functionPointsPerPersonMonth"
  | "featuresPerPersonMonth"
  | "avgApprovalDevelopmentDays"
  | "avgApprovalCreationDays"
  | "avgBugCount"
  | "avgKenanIssueCount"
  | "avgFuncPointCount"
  | "defectDensityPer100Fp"
  | "avgTestLeadDays"
  | "avgUatLeadDays"
  | "avgDeliveryDays"
  | "avgInputTokens"
  | "avgOutputTokens"
  | "avgPushedAdoptedLines"
  | "inputTokensPerAdoptedLine"
  | "outputTokensPerAdoptedLine"

export interface ProjectMetricCalculation {
  numerator: number
  denominator: number
  multiplier: number
}

export interface ProjectMetricSummaryGroup {
  developmentMode: ProjectMetricDevelopmentMode
  projectCount: number
  calculations: Record<ProjectMetricValueKey, ProjectMetricCalculation>
  functionPointsPerPersonMonth: number | null
  featuresPerPersonMonth: number | null
  avgApprovalDevelopmentDays: number | null
  avgApprovalCreationDays: number | null
  productivityFunctionPoints: number
  productivityWorkHours: number
  throughputFeatureCount: number
  throughputWorkHours: number
  avgBugCount: number | null
  avgKenanIssueCount: number | null
  kenanIssueCategories: ProjectMetricIssueCategoryCount[]
  avgFuncPointCount: number | null
  defectDensityPer100Fp: number | null
  avgTestLeadDays: number | null
  avgUatLeadDays: number | null
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
  warnings: string[]
}

export type ProjectMetricTrendFilters = Omit<ProjectMetricFilters, "range">

export interface ProjectMetricTrendData {
  months: Array<{ month: string; groups: ProjectMetricSummaryGroup[] }>
  truncated: boolean
  warnings: string[]
}

export interface ProjectMetricProjectItem {
  pm?: string | null
  prjCode: string
  prjName: string
  teamName: string
  devWorkHours: number | null
  featureCodes: string[]
  features: Array<{ featureCode: string; featureName: string | null }>
  syncBatchNo: string | null
  syncedAt: string | null
  approvalDevelopmentDays: number | null
  approvalCreationDays: number | null
  developmentMode: ProjectMetricDevelopmentMode
  plugins: string[]
  phaseStatus: string
  roomName: string
  groupName: string
  bugNum: number | null
  kenanIssueCount: number | null
  kenanIssueCategories: ProjectMetricIssueCategoryCount[]
  notAdjustFuns: number | null
  defectDensityPer100Fp: number | null
  pushedAdoptedLines: number | null
  createDate: string | null
  firstStStartDate: string | null
  firstStEndDate: string | null
  firstUatStartDate: string | null
  firstOnlineDate: string | null
  approvedDate: string | null
  testLeadDays: number | null
  uatLeadDays: number | null
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
  warnings: string[]
}

export const PROJECT_METRIC_TEAM = "零售客户经营开发团队"
export const PROJECT_HOURS_PER_PERSON_MONTH = 152.25

export interface ProjectMetricFeatureCoverage {
  total: number
  intelligent: number
  rate: number | null
}

export interface ProjectMetricCodeOverview {
  pushedAdoptedLines: number
  pushedEffectiveGeneratedLines: number
  pushedAdoptionRate: number | null
}

export interface ProjectMetricMonthlyCode {
  month: string
  totalPushedLines: number | null
  updatedAt: string | null
  cumulative: {
    pushedLines: number | null
    rate: number | null
    missing: boolean
  }
  sources: Array<{
    source: "devagent-ide" | "devagent-cloud" | "devagent-cli" | "devclaw"
    pushedLines: number | null
    rate: number | null
    missing: boolean
  }>
}

export interface ProjectMetricOverviewData {
  features: ProjectMetricFeatureCoverage | null
  code: ProjectMetricCodeOverview | null
  monthly: ProjectMetricMonthlyCode | null
  featureError: string | null
  codeError: string | null
  monthlyError: string | null
}

export interface ProjectMetricIndicatorExportData {
  team: { summary: ProjectMetricSummaryData; overview: ProjectMetricOverviewData }
  rooms: Array<{
    roomName: string
    summary: ProjectMetricSummaryData
    overview: ProjectMetricOverviewData
  }>
  exportedAt: string
  evidence: ProjectMetricExportEvidence
}

export interface ProjectMetricPeriodCode {
  harnessProjectId: string
  roomName: string
  pushedAdoptedLines: number
  pushedEffectiveGeneratedLines: number
}

export interface ProjectMetricProjectEvidence {
  project: ProjectMetricProjectItem
  factAvailable: boolean
  eligibleBindingCount: number
}

export interface ProjectMetricFeatureEvidence {
  classificationComplete: boolean
  featureCode: string
  featureName: string | null
  approvedDate: string | null
  syncedAt: string | null
  syncBatchNo: string | null
  projectCodes: string[]
}

export interface ProjectMetricCodeEvidence {
  roomName: string
  prjCode: string
  prjName: string | null
  projectRoomName: string | null
  pushedAdoptedLines: number
  pushedEffectiveGeneratedLines: number
}

export interface ProjectMetricMonthlyEvidence {
  orgLevel: "team" | "room"
  teamName: string
  roomName: string | null
  month: string
  totalPushedLines: number | null
  devagentIdePushedLines: number | null
  devagentCloudPushedLines: number | null
  devagentCliPushedLines: number | null
  updatedAt: string | null
  updatedBy: string | null
}

export interface ProjectMetricExportEvidence {
  projects: ProjectMetricProjectEvidence[]
  features: ProjectMetricFeatureEvidence[]
  code: ProjectMetricCodeEvidence[]
  monthly: ProjectMetricMonthlyEvidence[]
}
