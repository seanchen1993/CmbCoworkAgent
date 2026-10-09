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
  tokenUsageReportedCalls: number
  cacheUsageReportedCalls: number
}

export interface EfficiencyDevComputeResult {
  computeScope: "dev" | "all"
  /** Dev uses call-start attribution; all preserves the original full-flow windows. */
  compute: EfficiencyDevComputeData
  /** Historical turn-start attribution is kept separate from precise usage. */
  legacyCompute: EfficiencyDevComputeData
  computeByPlugin: {
    adapterName: string | null
    versions: string[]
    compute: EfficiencyDevComputeData
    legacyCompute: EfficiencyDevComputeData
  }[]
  pluginOptions: { adapterName: string; versions: string[] }[]
  computeCoverage: {
    scopeTraces: number
    preciseDevTraces: number
    legacyDevTraces: number
    unattributedTraces: number
  }
}
