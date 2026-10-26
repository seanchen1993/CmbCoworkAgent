import type { HostProjectOperation, HostProjectState } from "./host-types"

export interface LocalProjectTemplate {
  installedPluginId: string
  name: string
  version: string
  stages: string[]
  unavailableReason?: string
  /** Identity shown at template selection; never an execution approval. */
  expectedTemplate?: import("../plugin-start-use").PluginStartUseIdentity
}
export type LocalProjectSummary = Pick<
  HostProjectState,
  "projectId" | "name" | "workspace" | "status" | "stageIndex" | "updatedAt" | "packageVersion"
>
export interface LocalProjectView {
  importedSource?: { sourceProjectId: string; prefixStageIds: string[]; reexecuteStageIds?: string[] }
  resultApprovalRequired?: boolean
  project: HostProjectState
  operations: HostProjectOperation[]
  preview?: { state: "active" | "expired"; revision?: number }
  resultReview?: import("./host-types").HostResultReview
  resultReviewError?: string
  continuation?: { reason: string; error?: string }
  migrationReview?: import("./host-types").HostPlanMigrationReview
  inputWait?: { operationId: string; requestId: string; threadId: string; status: "waiting" | "answered";
    resumable: boolean }
}
export type LocalProjectCommand =
  | { kind: "prepare"; expectedVersion: number; idempotencyKey: string; stageInstructions?: string }
  | { kind: "continue"; expectedVersion: number }
  | { kind: "review-plan"; expectedVersion: number }
  | { kind: "migrate-plan"; review: import("./host-types").HostPlanMigrationReview }
  | { kind: "resume-input"; operationId: string; requestId: string }
  | {
      kind: "approve-result"
      operationId: string
      review: import("./host-types").HostResultReview
      decision: "approved" | "rejected"
      feedback?: string
    }
  | {
      kind: "approve"
      operationId: string
      expectedVersion: number
      inputFingerprint: string
      decision: "approved" | "rejected"
      contextProviderApproval?: import("./host-types").HostContextProviderApproval
    }
  | { kind: "start" | "validate" | "validate-imported" | "advance" | "cancel" | "reconcile"; operationId: string }

export interface LocalProjectImportApi {
  sources(): Promise<Array<{ projectId: string; packageId: string; workspace: string; frozen: boolean }>>
  target(installedPluginId: string): Promise<{ adapters?: import("./host-types").HostLegacyAdapterDescription[]; stages: Array<{
    id: string; title: string; eligible: boolean; reason?: string; artifacts: Array<{ id: string; path: string }>
  }> }>
  review(input: import("./host-types").HostLegacyImportInput): Promise<import("./host-types").HostLegacyImportReview>
  reviewAdapter(input: import("./host-types").HostLegacyAdapterInput): Promise<import("./host-types").HostLegacyImportReview>
  resumeReview(sourceProjectId: string): Promise<import("./host-types").HostLegacyImportReview>
  confirm(review: import("./host-types").HostLegacyImportReview): Promise<LocalProjectView>
}

export interface LocalProjectApi {
  legacyImport: LocalProjectImportApi
  mods: import("./function-source").ProjectFunctionSourceApi
  library: import("./project-library").ProjectLibraryApi
  preview: import("./development-preview").ProjectPreviewApi
  actionResults(
    projectId: string,
    operationId: string
  ): Promise<import("./action-results").ProjectActionResults>
  templates(): Promise<LocalProjectTemplate[]>
  list(afterProjectId?: string): Promise<LocalProjectSummary[]>
  get(projectId: string): Promise<LocalProjectView>
  versions(projectId: string): Promise<import("./version-report").ProjectVersionReport>
  create(input: {
    name: string
    workspace: string
    installedPluginId: string
    goal: string
    expectedTemplate?: import("../plugin-start-use").PluginStartUseIdentity
    expectedPlugin?: import("../plugin-start-use").PluginStartUseIdentity
    startUseScope?: import("../plugin-derivation").PluginDerivationScope
  }): Promise<LocalProjectView>
  command(projectId: string, command: LocalProjectCommand): Promise<LocalProjectView>
}
