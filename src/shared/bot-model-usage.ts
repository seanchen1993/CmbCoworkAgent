export type BotModelUsagePurpose = "task" | "memory-synthesis" | "memory-verification"

/** Provider-reported token counters, not prices or local tokenizer estimates. */
export interface BotModelUsageSummary {
  requests: number
  unknownRequests: number
  inputTokens: number
  outputTokens: number
  reservedOutputTokens: number
  otherModelRequests: number
  inputReportedRequests: number
  models: {
    modelRef: string
    model: string
    purpose: BotModelUsagePurpose
    requests: number
    unknownRequests: number
    inputReportedRequests: number
    inputTokens: number
    outputTokens: number
  }[]
}
