import type { BotTaskState } from "./contracts"

/** Business completion and execution liveness are independent. This is a read-only snapshot. */
export interface BotWorkExecutionStatus {
  observedAt: number
  businessState: "active" | "completed"
  phase: "not_started" | "queued" | "running" | "waiting_user_input" | "waiting_approval"
    | "waiting_browser" | "waiting_interaction" | "background" | "waiting_dependencies"
    | "idle" | "failed" | "cancelled" | "interrupted" | "outcome_unknown" | "unavailable"
  label: string
  /** An active runtime may be suspended on a human interaction; null means unavailable. */
  runActive: boolean | null
  waitingFor: Array<
    | { kind: "user_input"; count: number; questions: string[] }
    | { kind: "approval" }
    | { kind: "browser"; instruction: string }
    | { kind: "interaction" }
  >
  pendingPeers: number
  background: { commands: boolean; workflow: boolean; workers: boolean; pendingResults: boolean }
  lastExecution: { taskId: string; state: BotTaskState; updatedAt: number; error: string | null } | null
}

/** Cheap runtime-registry reads, never transcripts, screenshots or model-generated progress. */
export interface BotWorkRuntimeState {
  available: boolean
  threadExists: boolean
  runActive: boolean
  userInput: { count: number; questions: string[] }
  approval: boolean
  commands: boolean
  workflow: boolean
  workers: boolean
  pendingResults: boolean
}
