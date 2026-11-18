/** Opt-in host execution accounting; the legacy plugin remains the sole business state owner. */
export interface LegacyProjectRuntimeBinding {
  schemaVersion: 1
  projectId: string
  workspace: string
  installedPluginId: string
  packageId: string
  packageVersion: string
  packageDigest: string
  mods: { modId: string; digest: string; grantEpoch: number } | null
  enabledAt: number
}

export interface LegacyProjectOperation {
  schemaVersion: 1
  operationId: string
  projectId: string
  featureId: string
  /** The retained project's own directory, shared across its feature runs. */
  workspace: string
  /** Absent in older records, whose execution directory was the project directory. */
  executionWorkspace?: string
  executionWorkspaceIdentity?: string
  owner?: { processId: number; incarnation: string }
  installedPluginId: string
  packageDigest: string
  threadId: string
  threadIncarnation: string
  requestId: string
  inputDigest: string
  status: "started" | "succeeded" | "failed" | "cancelled" | "unknown" | "reconciled"
  startedAt: number
  settledAt: number | null
  terminalCode: string | null
  reconciliation?: { reviewedRevision: string; reviewedAt: number; actor: "desktop-user" }
  /** A successful original run is not evidence that a business stage advanced or validated. */
  businessStateValidity: "unknown"
}

export interface LegacyProjectRuntimeView {
  binding: LegacyProjectRuntimeBinding | null
  operations: Array<LegacyProjectOperation & { recoveryRevision?: string }>
  writeUnavailable?: true
}
export interface LegacyProjectRecoveryInput {
  projectId: string
  operationId: string
  expectedRevision: string
  checkedOriginalResult: true
}
export interface LegacyProjectRuntimeApi {
  view(projectId: string): Promise<LegacyProjectRuntimeView>
  enable(projectId: string): Promise<LegacyProjectRuntimeView>
  disable(projectId: string): Promise<LegacyProjectRuntimeView>
  reconcile(input: LegacyProjectRecoveryInput): Promise<LegacyProjectRuntimeView>
}
