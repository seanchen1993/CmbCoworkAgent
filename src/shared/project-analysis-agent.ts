import type { RunAnalysisOptions, RunAnalysisRange } from "./project-run-analysis"
import type { RunAnalysisFilters } from "./project-run-analysis-metrics"

export interface ProjectAnalysisTarget {
  projectId: string
  /** Omitted means matching features in a project; null means unbound executions. */
  featureSlug?: string | null
}
export interface ProjectAnalysisMessage {
  role: "user" | "assistant"
  content: string
}
export interface ProjectAnalysisAgentInput {
  question: string
  messages?: ProjectAnalysisMessage[]
  range: RunAnalysisRange
  options: RunAnalysisOptions
  filters: RunAnalysisFilters
  target?: ProjectAnalysisTarget
}
export interface ProjectAnalysisEvidence {
  id: string
  label: string
  summary: string
  target?: ProjectAnalysisTarget
}
export interface ProjectAnalysisAgentResult {
  content: string
  modelName: string
  dataAsOf: string
  projectCount: number
  featureCount: number
  evidence: ProjectAnalysisEvidence[]
  toolCalls: Array<{ name: string; success: boolean }>
  exampleData: boolean
}
export interface ProjectAnalysisAgentResponse {
  success: boolean
  data?: ProjectAnalysisAgentResult
  error?: string
  cancelled?: boolean
}
