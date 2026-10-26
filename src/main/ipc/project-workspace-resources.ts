import { workflowRunManager } from "../agent/workflow/run-manager"
import { getProjectActionRuntime } from "../harness-board/project-action-runtime"
import { LocalSandbox } from "../agent/local-sandbox"
import { listLocalThreadRunLeases } from "../agent/thread-run-lease"
import { getThreadCore } from "../db"
import { workspacePathsOverlap } from "../../shared/workspace-path"

/** Reuse original execution owners; a quiet UI alone cannot establish a stable workspace. */
export async function authorizeProjectWorkspaceResources(
  workspaces: readonly string[],
  assertAuthority: () => void = () => undefined
) {
  const flowsRuntime = getProjectActionRuntime().flows
  if (!flowsRuntime.assertWorkspaceResourcesSettled) throw Error("PROJECT_FLOW_RUNTIME_UNAVAILABLE")
  const workflows = await Promise.all(
    workspaces.map((workspace) => workflowRunManager.assertWorkspaceResourcesSettled(workspace))
  )
  const flows = workspaces.map((workspace) =>
    flowsRuntime.assertWorkspaceResourcesSettled!(workspace)
  )
  const assertCurrent = () => {
    assertAuthority()
    workflows.forEach((guard) => guard.assertCurrent())
    flows.forEach((guard) => guard.assertCurrent())
    if (workspaces.some((workspace) => LocalSandbox.hasActiveBackgroundTasksInWorkspace(workspace)))
      throw Error("PROJECT_BACKGROUND_TASKS_ACTIVE")
    for (const lease of listLocalThreadRunLeases()) {
      const raw = getThreadCore(lease.threadId)?.metadata
      const metadata = typeof raw === "string" ? JSON.parse(raw) : raw
      if (
        typeof metadata?.workspacePath === "string" &&
        workspaces.some((workspace) => workspacePathsOverlap(workspace, metadata.workspacePath))
      )
        throw Error("PROJECT_WORKSPACE_BUSY")
    }
  }
  assertCurrent()
  return { assertCurrent }
}
