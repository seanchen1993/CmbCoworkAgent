import type { ProjectRuntimeManifest } from "./types"
import type { LegacyProjectRuntimeBinding } from "./legacy-operations"

export interface HostLegacyImportInput {
  sourceProjectId: string
  target: { projectId: string; name: string; workspace: string; installedPluginId: string; goal: string }
  /** Exact prefix to revalidate; these are not imported success decisions. */
  prefixStageIds: string[]
  artifacts: Array<{ artifactId: string; sourcePath: string }>
}
export interface HostLegacyImportReview extends HostLegacyImportInput {
  protocol: "devclaw.host-legacy-import/v1" | "devclaw.host-legacy-import/v2"
  source: LegacyProjectRuntimeBinding
  historyDigest: string
  targetDigest: string
  files: Array<{ artifactId: string; sourcePath: string; targetPath: string; digest: string; bytes: number }>
  reviewDigest: string
  /** Main-produced provenance; confirm reconstructs this from the retained descriptor and source. */
  adaptation?: {
    adapterId: string
    parameters: Record<string, string>
    descriptorDigest: string
    checkpoint: { sourcePath: string; pointer: string[]; value: string; digest: string }
    sourceFiles: Array<{ sourcePath: string; digest: string; bytes: number }>
    reexecuteStageIds: string[]
    materialPath: string
  }
}
export interface HostLegacyAdapterInput {
  sourceProjectId: string
  target: HostLegacyImportInput["target"]
  adapterId: string
  parameters: Record<string, string>
}
export interface HostLegacyAdapterDescription {
  id: string
  title: string
  parameters: Array<{ id: string; label: string }>
}
export interface HostLegacyImportReceipt {
  review: HostLegacyImportReview
  confirmedAt: number
  actor: "desktop-user"
  historicalSuccess: "untrusted-source-only"
}

export interface HostProjectCreateInput {
  projectId: string
  name: string
  goal: string
  workspace: string
  installedPluginId: string
  /** Author-declared identity, distinct from the installation UUID above. */
  packageId: string
  packageVersion: string
  /** Complete retained package snapshot digest, never merely the manifest file digest. */
  pluginDigest: string
  manifest: ProjectRuntimeManifest
}

export interface HostProjectState extends HostProjectCreateInput {
  schemaVersion: 1
  stateOwner: "host"
  version: number
  stageIndex: number
  status: "active" | "completed"
  createdAt: number
  updatedAt: number
}

export interface HostPlanMigrationReview {
  projectId: string
  expectedVersion: number
  sourceDigest: string
  targetDigest: string
  targetVersion: string
  inputFingerprint: string
  candidateInputFingerprint: string
  preservedStageIds: string[]
  remainingStageIds: string[]
  contractDigest: string
}

export type HostOperationStatus =
  | "prepared"
  | "started"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown"
  | "transitioned"

export interface HostActionPrepareInput {
  projectId: string
  expectedVersion: number
  stageId: string
  idempotencyKey: string
  inputFingerprint: string
  contextProvider?: HostContextProviderRequest
  /** Explicit user task data frozen for this operation; never permission or validation evidence. */
  stageInstructions?: string
}

export interface HostContextProviderRequest {
  protocol: "devclaw.context-text/v1"
  policyDigest: string
  notice: string
}
export interface HostContextProviderApproval {
  policyDigest: string
  allowNetworkSideEffects: true
}

export interface HostValidationReceipt {
  schemaVersion: 1
  operationId: string
  projectId: string
  stageId: string
  pluginDigest: string
  inputFingerprint: string
  checkId: string
  artifactFingerprint: string
  result: "passed" | "failed" | "blocked" | "unknown"
  /** The host validator's version, not model prose or an untrusted plugin assertion. */
  validatorVersion: string
  checkedAt: number
}

/** Bounded original failed-check observations, never validation or approval credentials. */
export interface HostCheckDiagnostic {
  checkId: string
  actionId: string
  runId: string
  executionId: string
  provider: { pluginId: string; plugin: string; digest: string; actionId: string }
  inputFingerprint: string
  resultDigest: string
  summary: string
  errors: Array<{ code: string; message: string }>
  warnings: Array<{ code: string; message: string }>
  truncated: boolean
}

export interface HostExecutionTerminal {
  outcome: "success" | "error" | "unknown" | "cancelled"
  code: string
  checkDiagnostics?: HostCheckDiagnostic[]
}

export interface HostActionResult {
  outcome: "succeeded" | "failed" | "unknown" | "cancelled"
  receipts: HostValidationReceipt[]
}

/** Exact output and check set presented for a separate, post-execution business decision. */
export interface HostResultReview {
  operationId: string
  expectedVersion: number
  inputFingerprint: string
  pluginDigest: string
  artifactFingerprint: string
  receiptFingerprint: string
  policyDigest: string
}

export interface HostResultApprovalInput extends HostResultReview {
  decision: "approved" | "rejected"
  actorId: string
  /** Optional native human revision request; never approval or execution authority. */
  feedback?: string
}

export interface HostContinuationResult {
  project: HostProjectState
  operations: HostProjectOperation[]
  reason:
    | "completed"
    | "approval_required"
    | "result_approval_required"
    | "result_rejected"
    | "failed"
    | "unknown"
    | "cancelled"
    | "busy"
    | "budget"
    | "blocked"
  error?: string
}

export interface HostProjectOperation extends HostActionPrepareInput {
  schemaVersion: 1
  operationId: string
  pluginDigest: string
  status: HostOperationStatus
  createdAt: number
  updatedAt: number
  cancelRequestedAt: number | null
  startedAt: number | null
  execution: null | {
    threadId: string
    terminal: null | (HostExecutionTerminal & {
      settledAt: number
    })
  }
  approval: null | {
    decision: "approved" | "rejected"
    actorId: string
    decidedAt: number
    operationId: string
    expectedVersion: number
    inputFingerprint: string
    contextProviderApproval?: HostContextProviderApproval
  }
  receipts: HostValidationReceipt[]
  /** Missing only on historical records; readers normalize it to null. */
  resultApproval?: null | (HostResultApprovalInput & { decidedAt: number })
  /** Host-issued immutable reference selected when an explicit retry is prepared. */
  resultFeedbackSource?: { operationId: string; approvalDigest: string }
}

/** Passed only between trusted main-process coordinator and host execution callbacks. */
export interface HostExecutionTicket {
  operationId: string
  projectId: string
  stageId: string
  expectedVersion: number
  inputFingerprint: string
  pluginDigest: string
}
/** Machine-readable limits of the native checkpoint adapter; these grant no execution authority. */
export const HOST_INPUT_RESUME_CAPABILITIES = {
  protocol: "host-user-input-interrupt/v1",
  boundary: "single-native-request-user-input",
  settledNativeTools: ["read_file", "write_file", "edit_file", "ls", "glob", "grep", "request_user_input"],
  excludedHookTypes: ["command", "http"],
  requires: ["same-operation", "same-thread-incarnation", "current-source-and-inputs",
    "unclaimed-durable-answer", "original-checkpoint", "no-unknown-resources", "unstarted-post-skill-phases"],
  mixedToolBatches: "reconciliation-required",
  unknownToolsOrBackgroundEffects: "reconciliation-required",
  stageActionsOrScriptContext: "reconciliation-required",
  readOnlyContext: "native-materials-only-proof-and-original-flow-facts",
  continuationBudget: "original-remaining-steps-and-absolute-deadline",
  automaticReplay: false,
  automaticApproval: false
} as const
