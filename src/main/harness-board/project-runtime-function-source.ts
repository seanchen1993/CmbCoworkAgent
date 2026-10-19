import type { HostProjectState } from "../../shared/project-runtime/host-types"
import type { FunctionModsManager } from "../mods/v2/manager"

let current:
  | {
      manager: FunctionModsManager
      workspaceKey: (workspace: string) => string
      workspaceControl?: ProjectRuntimeWorkspaceControl
    }
  | undefined

export interface ProjectRuntimeWorkspaceControl {
  settingsStamp(workspace: string): string
  globallyEnabled(): boolean
  enabled(workspace: string): boolean
  enable(workspace: string): void
}

/** Reuses the application's one original manager and durable grant store. Main process only. */
export function setProjectRuntimeFunctions(
  manager: FunctionModsManager,
  workspaceKey: (workspace: string) => string,
  workspaceControl?: ProjectRuntimeWorkspaceControl
) {
  current = { manager, workspaceKey, workspaceControl }
}

export function projectRuntimeFunctionSource(project: Pick<HostProjectState,
  "workspace" | "projectId" | "pluginDigest" | "installedPluginId" | "packageId">, root: string) {
  if (!current) throw Error("PROJECT_MODS_RUNTIME_UNAVAILABLE")
  return {
    manager: current.manager,
    workspaceControl: current.workspaceControl,
    input: {
      workspace: current.workspaceKey(project.workspace),
      scope: { projectId: project.projectId, packageDigest: project.pluginDigest },
      plugin: { id: project.installedPluginId, name: project.packageId, path: root, enabled: true }
    }
  }
}

/** Missing consent must block a real stage, never silently omit its package's Mods. */
export async function assertProjectRuntimeSourceApproved(project: HostProjectState, root: string) {
  const { manager, input } = projectRuntimeFunctionSource(project, root)
  const review = await manager.runtimeSourceReview(input)
  if (review && review.state !== "ready") throw Error("PROJECT_MODS_APPROVAL_REQUIRED")
}
