import type { AuthoringScope } from "./authoring"

export type AuthoringInstallErrorCode =
  | "BUSY"
  | "STALE"
  | "INVALID"
  | "LIMIT"
  | "CANCELLED"
  | "FAILED"
export type AuthoringInstallResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AuthoringInstallErrorCode }
export interface AuthoringInstallationSummary {
  installationId: string
  name: string
  currentVersionId?: string
  versions: {
    versionId: string
    sourceDigest: string
    compiledDigest: string
    createdAt: number
    revision: number
  }[]
  pending?: { operationId: string; state: string; reason?: string }
}
export interface AuthoringInstallReview {
  strictCompatible: boolean
  typesValid: boolean
  modelProtocol: string
  sdkMethods: string[]
  configurationKeys: string[]
  components: { id: string; dependsOn: string[] }[]
  changedFiles: { path: string; change: "added" | "changed" | "removed" }[]
}
export interface AuthoringPreparedInstallation {
  review?: AuthoringInstallReview
  handle: string
  installationId: string
  versionId: string
  name: string
  sourceDigest: string
  compiledDigest: string
  catalogDigest: string
  currentVersionId?: string
  restoredFromVersionId?: string
  configuration: "unchanged" | "restore"
}
export interface AuthoringInstallationOutcome {
  operationId: string
  installationId: string
  versionId: string
  state: "settled" | "partial" | "unknown"
}
/** Current verified installation facts; never an installation or approval capability. */
export interface AuthoringInstalledReceipt {
  installationId: string
  versionId: string
  name: string
  sourceDigest: string
  compiledDigest: string
}
export type AuthoringInstallPrepareRequest = AuthoringScope & {
  requestId: string
  draftId: string
  revision: number
  sourceDigest: string
}
export type AuthoringInstallRollbackRequest = AuthoringScope & {
  requestId: string
  installationId: string
  versionId: string
  restoreConfiguration: boolean
}
export interface AuthoringInstallApi {
  inspectRetention(
    input: AuthoringScope
  ): Promise<AuthoringInstallResult<AuthoringRetentionInspection>>
  retireVersions(
    input: AuthoringScope & {
      expectedFingerprint: string
      versionIds: string[]
      acknowledgeLostRollback: true
    }
  ): Promise<AuthoringInstallResult<AuthoringRetentionInspection>>
  resolveInstalled(
    input: AuthoringScope & { draftId: string; revision: number; sourceDigest: string }
  ): Promise<AuthoringInstallResult<AuthoringInstalledReceipt | null>>
  inspectPreparation(
    input: AuthoringScope
  ): Promise<AuthoringInstallResult<AuthoringPreparationInspection>>
  recoverPreparation(
    input: AuthoringScope & { expectedFingerprint: string }
  ): Promise<AuthoringInstallResult<AuthoringPreparationRecovery>>
  inspectUncertain(
    input: AuthoringScope & { operationId: string }
  ): Promise<AuthoringInstallResult<AuthoringInstallationInspection>>
  reconcile(
    input: AuthoringScope & { operationId: string; expectedInspectionDigest: string }
  ): Promise<AuthoringInstallResult<{ operationId: string; state: "reconciled" }>>
  list(
    threadId: string
  ): Promise<
    AuthoringInstallResult<{ workspace: string; installations: AuthoringInstallationSummary[] }>
  >
  prepare(
    input: AuthoringInstallPrepareRequest
  ): Promise<AuthoringInstallResult<AuthoringPreparedInstallation>>
  rollbackPrepare(
    input: AuthoringInstallRollbackRequest
  ): Promise<AuthoringInstallResult<AuthoringPreparedInstallation>>
  apply(
    input: AuthoringScope & { handle: string; expectedCatalogDigest: string }
  ): Promise<AuthoringInstallResult<AuthoringInstallationOutcome>>
  cancel(input: AuthoringScope & { requestId: string }): Promise<AuthoringInstallResult<void>>
}

export interface AuthoringRetentionInspection {
  fingerprint: string
  usedVersions: number
  limit: number
  usedBytes?: number
  byteLimit?: number
  protectedArtifacts?: number
  versions: {
    versionId: string
    installationId: string
    workspace: string
    name: string
    revision: number
    createdAt: number
    canRetire: boolean
    /** Must all be explicitly selected in the same retirement batch; includes this version. */
    requiredVersionIds?: string[]
    reason:
      | "current"
      | "rollback"
      | "uncertain"
      | "candidate"
      | "busy"
      | "eligible"
      | "cleanup-failed"
  }[]
  pendingVersionIds: string[]
  retiredVersions: number
}

/** A current host observation, not proof the interrupted operation succeeded. */
export interface AuthoringInstallationInspection {
  operationId: string
  installationId: string
  originalState: string
  catalog: "before" | "after" | "different"
  configuration: "unchanged" | "restored" | "different"
  observedVersionId?: string
  inspectionDigest: string
  canAccept: boolean
}

export interface AuthoringPreparationInspection {
  state: "none" | "live" | "stale" | "unknown"
  versionId?: string
  fingerprint?: string
  canRecover: boolean
}
export interface AuthoringPreparationRecovery {
  state: "recovered"
  versionId: string
  preserved: "published" | "quarantine"
}
