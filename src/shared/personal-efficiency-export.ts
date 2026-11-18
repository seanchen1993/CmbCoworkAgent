import type { PersonalEfficiencyMetric, PersonalEfficiencyWeights } from "./personal-efficiency"

export interface PersonalEfficiencyExportOptions {
  keyword?: string
  weights?: PersonalEfficiencyWeights
  sortBy?: PersonalEfficiencyMetric | "score"
  sortOrder?: "asc" | "desc"
  /** 指定人员时只导出该人的两类项目明细。 */
  sapId?: string
}
