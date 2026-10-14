import type { ClawActionDescriptor } from "../../shared/mods/claw-actions"
import type { FlowManager } from "../mods/flows/manager"
import type { ProjectActionBinding } from "../../shared/project-runtime/action-bindings"
import type { FlowRun } from "../../shared/mods/flows/types"

interface ProjectActionRuntime {
  /** Pure ledger read: unlike FlowManager.runs this must not reconcile or write history. */
  readRuns?(workspace: string, threadId: string): FlowRun[]
  flows: Pick<FlowManager, "startSaved" | "waitForSettlement" | "run" | "cancel">
  catalog(workspace: string, threadId: string): Promise<ClawActionDescriptor[]>
  prepareSelection(
    workspace: string,
    threadId: string,
    bindings: readonly ProjectActionBinding[]
  ): Promise<void>
}
/** Convert filesystem paths only at the boundary to the existing Mods control-plane key. */
export function normalizeProjectActionRuntime(
  value: ProjectActionRuntime,
  workspaceKey: (workspace: string) => string
): ProjectActionRuntime {
  return {
    ...(value.readRuns
      ? {
          readRuns: (workspace: string, threadId: string) =>
            value.readRuns!(workspaceKey(workspace), threadId)
        }
      : {}),
    catalog: (workspace, threadId) => value.catalog(workspaceKey(workspace), threadId),
    prepareSelection: (workspace, threadId, bindings) =>
      value.prepareSelection(workspaceKey(workspace), threadId, bindings),
    flows: {
      startSaved: (workspace, threadId, saved, task, assertOwnerCurrent) =>
        value.flows.startSaved(
          workspaceKey(workspace),
          threadId,
          saved,
          task ? { ...task, workspace: workspaceKey(task.workspace) } : undefined,
          assertOwnerCurrent
        ),
      waitForSettlement: (workspace, ...args) =>
        value.flows.waitForSettlement(workspaceKey(workspace), ...args),
      run: (workspace, ...args) => value.flows.run(workspaceKey(workspace), ...args),
      cancel: (workspace, ...args) => value.flows.cancel(workspaceKey(workspace), ...args)
    }
  }
}
let runtime: ProjectActionRuntime | undefined

/** Registers the application's existing manager; never creates a second execution system. */
export function setProjectActionRuntime(value: ProjectActionRuntime): void {
  runtime = value
}
export function getProjectActionRuntime(): ProjectActionRuntime {
  if (!runtime) throw Error("PROJECT_ACTION_RUNTIME_UNAVAILABLE")
  return runtime
}
export function getProjectActionCatalog(workspace: string, threadId: string) {
  return getProjectActionRuntime().catalog(workspace, threadId)
}
