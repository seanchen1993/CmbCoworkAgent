export interface BuiltinAdvisorView {
  enabled: boolean
  running: boolean
  result?: { text: string; at: number; inputTokens: number | null; outputTokens: number | null }
  nextAllowedAt: number
  dailyLimit: number
  outputTokenLimit: number
}
