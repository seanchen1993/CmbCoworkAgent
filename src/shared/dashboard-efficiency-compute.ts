/** Project-bound workflow plugin; an empty version combines all its versions. */
export interface EfficiencyPluginFilter {
  scope?: "dev" | "all"
  adapterName?: string | null
  adapterVersion?: string | null
}

export interface EfficiencyDevComputeData {
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  cacheReadTokens: number
  tokenTotalsConsistent: boolean
  generatedLines: number
  pushedAdoptedLines: number
  tokensPerGeneratedLine: number | null
  tokensPerAdoptedLine: number | null
  traceCount: number
  codeProducingTraceCount: number
  codeProducingTraceRatio: number | null
  modelCalls: number
  /** Historical document totals do not imply missing per-call reports. */
  tokenUsageIncomplete?: boolean
  tokenUsageReportedCalls: number
  cacheUsageReportedCalls: number
}

export type EfficiencyStage = "biz" | "dev" | "ops" | "unattributed"

export interface EfficiencyStageDistribution {
  stage: EfficiencyStage
  totalTokens: number
  generatedLines: number
  pushedAdoptedLines: number
}

export interface EfficiencyDevComputeResult {
  computeScope: "dev" | "all"
  /** Both scopes use the original full-flow windows; Dev selects the Dev partition. */
  compute: EfficiencyDevComputeData
  /** Internal coverage detail; historical Dev usage is also included in compute. */
  legacyCompute: EfficiencyDevComputeData
  computeByPlugin: {
    adapterName: string | null
    versions: string[]
    compute: EfficiencyDevComputeData
    legacyCompute: EfficiencyDevComputeData
  }[]
  /** Stage amounts partition the full-flow totals, including missing/unknown attribution. */
  stageDistribution?: EfficiencyStageDistribution[]
  pluginOptions: { adapterName: string; versions: string[] }[]
  computeCoverage: {
    scopeTraces: number
    preciseDevTraces: number
    legacyDevTraces: number
    unattributedTraces: number
  }
}
