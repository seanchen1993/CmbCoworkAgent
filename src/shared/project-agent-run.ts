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
  | { type: "text"; stepId: string; text: string; reset?: boolean }
export type ProjectAgentRunListener = (event: ProjectAgentRunEvent) => void
