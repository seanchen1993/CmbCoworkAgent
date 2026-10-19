/** Read-only projection of the original Host journal. It grants no execution or file access. */
export interface CreatorProjectTrialJourney {
  projectId: string
  creatorThreadId: string
  candidateDigest: string
  /** False keeps historical evidence visible but rejects its use for the current candidate. */
  candidateCurrent?: boolean
  workspace: string
  phase:
    | "not-started"
    | "ready"
    | "running"
    | "needs-approval"
    | "needs-transition"
    | "passed"
    | "failed"
    | "unknown"
  canDeliver: boolean
  operationsTruncated: boolean
  diagnostics: string[]
  stages: Array<{
    id: string
    title: string
    status:
      | "pending"
      | "ready"
      | "running"
      | "needs-approval"
      | "checks-passed"
      | "passed"
      | "failed"
      | "unknown"
    artifacts: Array<{ id: string; path: string; required: boolean | null }>
    checks: Array<{
      id: string
      artifactId: string
      result: "passed" | "failed" | "blocked" | "unknown"
      checkedAt?: number
      validatorVersion?: string
    }>
    sessions: Array<{
      threadId: string
      operationId: string
      status: string
      terminalOutcome?: "success" | "error" | "unknown" | "cancelled"
    }>
  }>
}
