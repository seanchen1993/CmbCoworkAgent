import type { ProjectRuntimeManifest } from "./types"

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

export interface HostActionResult {
  outcome: "succeeded" | "failed" | "unknown" | "cancelled"
  receipts: HostValidationReceipt[]
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
    terminal: null | {
      outcome: "success" | "error" | "unknown" | "cancelled"
      code: string
      settledAt: number
    }
  }
  approval: null | {
    decision: "approved" | "rejected"
    actorId: string
    decidedAt: number
    operationId: string
    expectedVersion: number
    inputFingerprint: string
  }
  receipts: HostValidationReceipt[]
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
