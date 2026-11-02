import type { PluginStartUseIdentity } from "./plugin-start-use"

export interface HarnessProjectUseReviewInput {
  adapterId: string
  adapterType: "plugin"
  workspacePath: string
  projectDir: string
  /** Required for new projects; existing owners may ask the host to resolve their current source. */
  expectedNativeTemplate?: PluginStartUseIdentity
  existingProjectId?: string
}

export interface HarnessProjectUseSource {
  pluginId: string
  name: string
  digest: string
  capabilities: string[]
  actionIds: string[]
  configurationOnly: boolean
}

/** A read-only review. Only the original create submission records the user's consent. */
export interface HarnessProjectUseReview {
  reviewId: string
  reviewDigest: string
  projectId: string
  workspace: string
  plugin: PluginStartUseIdentity
  packageDigest: string
  sources: HarnessProjectUseSource[]
  scopeNotice: string
  requiresApplicationEnable: boolean
  /** Existing owners only. Consent remains valid even when application or directory execution is off. */
  authorizationCurrent?: boolean
  expiresAt: number
}

export interface HarnessProjectUseApproval {
  reviewId: string
  reviewDigest: string
}
