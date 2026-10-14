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
  workspace: string
  installedPluginId: string
  packageDigest: string
  threadId: string
  threadIncarnation: string
  requestId: string
  inputDigest: string
  status: "started" | "succeeded" | "failed" | "cancelled" | "unknown"
  startedAt: number
  settledAt: number | null
  terminalCode: string | null
  /** A successful original run is not evidence that a business stage advanced or validated. */
  businessStateValidity: "unknown"
}

export interface LegacyProjectRuntimeView {
  binding: LegacyProjectRuntimeBinding | null
  operations: LegacyProjectOperation[]
}
export interface LegacyProjectRuntimeApi {
  view(projectId: string): Promise<LegacyProjectRuntimeView>
  enable(projectId: string): Promise<LegacyProjectRuntimeView>
  disable(projectId: string): Promise<LegacyProjectRuntimeView>
}
