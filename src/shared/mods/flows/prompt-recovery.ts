/** Serializable evidence only. Matching these types never grants execution or reuse authority. */
export interface FlowPromptDependencies {
  schemaVersion: 1
  coverage: "prompt-and-prior-receipts"
  profile: "prompt-only-v1"
  runtimeProtocol: "flow-text-runtime-v1"
  definitionDigest: string
  taskGoalDigest: string
  stepId: string
  modelRef: string
  /** Host-produced digest of configuration; raw credentials must never be serialized. */
  modelConfigurationDigest: string
  mandatoryPolicyDigest: string
  systemPromptDigest: string
  rolePromptDigest: string
  stableInput: { version: 1; digest: string }
  context: { version: 1; digest: string }
  priorProjection: "prompt-only-prior-v1"
  resultTool: {
    protocol: "host-workflow-structured-output-v1"
    name: "structured_output"
    schemaDigest: string
    implementationDigest: string
  }
}

/** Historical execution identity; excluded from the stable dependency comparison. */
export interface FlowPromptExecutionBinding {
  workspace: string
  parentThreadId: string
  parentThreadIncarnation: string
  runId: string
  executionId: string
  childThreadId: string
  childThreadIncarnation: string
  leaseGeneration: string
}

/**
 * Returned only by the actual runtime's private reader after stopping new calls and draining
 * in-flight work. NativeFlowHost must finish owned child cleanup before publishing the capture.
 * This records logical model calls, including schema-nudge calls. It does NOT certify all HTTP
 * fetch attempts or provider-internal retries; those are outside this ledger's observed boundary.
 */
export interface FlowPromptRuntimeSettledCapture {
  schemaVersion: 1
  binding: FlowPromptExecutionBinding
  dependencies: FlowPromptDependencies
  actualCapabilitiesDigest: string
  modelRequestLedgerDigest: string
  invocationLedgerDigest: string
  structuredOutputDigest: string
  /** Count at the logical model-call boundary, not network request count or token usage. */
  modelCalls: number
  providerUsageEvidenceIds: readonly string[]
}

/**
 * Host-only FlowAttempt field persisted atomically with the settled result in the same run put.
 * The existing running attempt is the start marker: no separate evidence table or start union.
 * Renderer/model input cannot supply this proof. Main process must validate durable evidence.
 */
export interface FlowPromptRecoveryEvidence extends FlowPromptRuntimeSettledCapture {
  evidenceKind: "flow-resumable-text-execution"
  state: "settled"
  startedAt: number
  finishedAt: number
  passed: boolean
  output: { version: 1; digest: string }
  /** Manager hashes the final attempt excluding recoveryEvidence, invalidated and reusedFrom. */
  receiptDigest: { version: 1; digest: string }
  /** Provenance only: do not fold these execution identities into stable input/context hashes. */
  priorReceipts: readonly {
    sourceRunId: string
    executionId: string
    receiptDigest: string
    projectedTextDigest: string
  }[]
}
