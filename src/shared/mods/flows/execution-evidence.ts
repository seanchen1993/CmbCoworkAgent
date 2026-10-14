/** Read-only historical projection. Nothing here grants execution or proves present file state. */
export interface FlowExecutionEvidenceView {
  schemaVersion: 1
  runId: string
  sourceDigest: string
  currentArtifacts: "not-rechecked"
  partial: boolean
  omittedAttempts: number
  lineage: {
    state: "none" | "linked" | "incomplete" | "invalid"
    rootRunId?: string
    parentRunId?: string
    consumedBy?: string
    resumeCount?: number
  }
  attempts: FlowAttemptEvidenceView[]
}

export interface FlowAttemptEvidenceView {
  executionId: string
  stepId: string
  status: "running" | "passed" | "failed" | "skipped" | "waiting" | "unknown"
  source:
    | "agent"
    | "native-check"
    | "approval"
    | "host"
    | "plugin-action"
    | "skill"
    | "mcp-tool"
    | "unknown"
  historicalValidity: "settled" | "invalidated" | "unsettled" | "unknown"
  startedAt?: number
  finishedAt?: number
  reusedFrom?: { runId: string; executionId: string; state: "linked" | "missing" | "invalid" }
  receipt: {
    state: "absent" | "recorded" | "invalid"
    coverage?: "prompt-and-prior-receipts" | "prompt-prior-and-virtual-root"
    originRunId?: string
    modelCalls?: number
  }
  checks: FlowLinkedCheckEvidence[]
  omittedChecks: number
}

export interface FlowLinkedCheckEvidence {
  id: string
  state: "found" | "missing" | "invalid" | "limited" | "unlinked"
  kind: "native-project-test" | "native-virtual-test" | "completion-gate" | "plugin-opinion" | "unknown"
  status?: "pass" | "block" | "revise" | "cancelled" | "error" | "interrupted" | "stale"
  check?: "unit-test" | "e2e"
  at?: number
}
