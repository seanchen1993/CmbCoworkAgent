/** Data budgets, not permissions. Only the Host can bind these bytes to a check operation. */
export const PROJECT_ARTIFACT_REFERENCE_FORMAT = "artifact-reference-v1"
export const PROJECT_ARTIFACT_REFERENCE_PROTOCOL = "devclaw.artifact-input/v1"
export const PROJECT_ARTIFACT_INLINE_BYTES = 28_000
export const PROJECT_ARTIFACT_REFERENCE_MAX_BYTES = 512 * 1024
export const PROJECT_ARTIFACT_REFERENCE_TOTAL_BYTES = 1024 * 1024
export const PROJECT_ARTIFACT_REFERENCE_INPUT_BYTES = 8 * 1024
export const PROJECT_ARTIFACT_REFERENCE_MAX_FILES = 8
export const PROJECT_REQUEST_PROVENANCE_SOURCE = "project-goal/v1"
export const PROJECT_REQUEST_PROVENANCE_PROTOCOL = "devclaw.project-goal/v1"
export const PROJECT_REQUEST_PROVENANCE_MAX_BYTES = 32 * 1024

/** Host goal identity only. Validators compare the original text in their actual artifact. */
export interface ProjectRequestProvenance {
  protocol: typeof PROJECT_REQUEST_PROVENANCE_PROTOCOL
  projectId: string
  bytes: number
  sha256: string
}

export interface ProjectArtifactReference {
  artifactId: string
  path: string
  bytes: number
  sha256: string
  maxBytes: number
}

export interface ProjectArtifactReferenceInput {
  protocol: typeof PROJECT_ARTIFACT_REFERENCE_PROTOCOL
  projectId: string
  stageId: string
  version: number
  pluginDigest: string
  workspaceIdentity: string
  current: ProjectArtifactReference
  sources: ProjectArtifactReference[]
  requestProvenance?: ProjectRequestProvenance
}
