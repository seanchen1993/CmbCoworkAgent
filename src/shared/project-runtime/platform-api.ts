import type { HostProjectOperation, HostProjectState } from "./host-types"

export interface LocalProjectTemplate {
  installedPluginId: string
  name: string
  version: string
  stages: string[]
  unavailableReason?: string
}
export type LocalProjectSummary = Pick<
  HostProjectState,
  "projectId" | "name" | "workspace" | "status" | "stageIndex" | "updatedAt" | "packageVersion"
>
export interface LocalProjectView {
  project: HostProjectState
  operations: HostProjectOperation[]
  preview?: { state: "active" | "expired"; revision?: number }
}
export type LocalProjectCommand =
  | { kind: "prepare"; expectedVersion: number; idempotencyKey: string }
  | {
      kind: "approve"
      operationId: string
      expectedVersion: number
      inputFingerprint: string
      decision: "approved" | "rejected"
    }
  | { kind: "start" | "validate" | "advance" | "cancel" | "reconcile"; operationId: string }

export interface LocalProjectApi {
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
  }): Promise<LocalProjectView>
  command(projectId: string, command: LocalProjectCommand): Promise<LocalProjectView>
}
