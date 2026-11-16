import type { ProjectReportResume } from "./project-analysis-report"

export const PROJECT_AGENT_RUN_CHANNEL = "dashboard:projectAgentRun:"

export interface ProjectAgentStep {
  id: string
  kind: "data" | "review" | "model" | "tool" | "render" | "save"
  title: string
  status: "running" | "completed" | "failed" | "cancelled"
  startedAt: number
  elapsedMs?: number
  detail?: string
  input?: string
  output?: string
}
export type ProjectAgentRunEvent =
  | { type: "step"; step: ProjectAgentStep }
  | { type: "report-checkpoint"; resume: ProjectReportResume }
  | {
      type: "text"
      stepId: string
      text: string
      reset?: boolean
      /** False for review/report output, which belongs in run details, not the analysis answer. */
      answer?: boolean
    }
export type ProjectAgentRunListener = (event: ProjectAgentRunEvent) => void
