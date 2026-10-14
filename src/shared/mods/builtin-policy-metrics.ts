export interface BuiltinPolicyScope {
  threadId: string
  workspace: string
  incarnationKey: string
}
export interface BuiltinPolicyDecision {
  id: string
  at: number
  source: "tool-approval" | "tool-policy" | "hook" | "managed-policy" | "publication"
  scope: "host" | "global" | "workspace" | "plugin" | "skill"
  event: string
  decision: "allow" | "deny" | "ask" | "unknown"
  ruleId: string
  explanation: string
  nextStep: string
  policyDigest: string | null
}
export interface BuiltinPolicyDecisionView {
  state: "observed" | "unavailable"
  records: BuiltinPolicyDecision[]
  limited: boolean
  explanation: string
}
export type BuiltinLegacyMetrics =
  | { state: "unavailable" }
  | {
      state: "observed"
      projectId: string
      featureId: string
      scope: "retained-original-executions"
      managedRun?: {
        runId: string
        nodeId: string | null
        status: "running" | "completed" | "failed" | "cancelled"
        currentThreadId: string | null
        durationMs: number | null
        providerRetries: number
        source: "original-managed-run-snapshot"
      }
      executions: Array<{
        operationId: string
        threadId: string
        status: "started" | "succeeded" | "failed" | "cancelled" | "unknown"
        startedAt: number
        settledAt: number | null
        durationMs: number | null
        source: "original-runtime-ledger"
      }>
      counts: {
        started: number
        succeeded: number
        failed: number
        cancelled: number
        unknown: number
      }
      observedExecutionSpanMs: number | null
      totalSettledExecutionMs: number | null
      repeatedExecutions: number
      approvalWaitMs: null
      inputTokens: null
      outputTokens: null
      cost: null
      businessStateValidity: "unknown"
      limited: boolean
      explanation: string
    }
