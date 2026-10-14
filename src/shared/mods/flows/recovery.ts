/** A diagnostic snapshot, never an execution permit or a reusable approval. */
export interface FlowRecoveryPlan {
  schemaVersion: 1
  runId: string
  sourceDigest: string
  status: "active" | "complete" | "blocked" | "eligible"
  reasons: FlowRecoveryReason[]
  steps: FlowRecoveryStep[]
  nextStepId?: string
  consumedExecutions: number
  remainingExecutions: number
  /** Final checks and approvals are always acquired again by a future resume command. */
  requiresFreshFinalization: true
}

export interface FlowRecoveryReason {
  code: string
  message: string
  stepId?: string
}

export interface FlowRecoveryStep {
  stepId: string
  name: string
  disposition: "reusable" | "pending" | "recheck" | "unknown" | "blocked" | "disabled"
  executionId?: string
  reason: string
}
