import type { ClawActionDescriptor, ClawActionIdentity } from "../../shared/mods/claw-actions"
import type { FlowManager } from "../mods/flows/manager"
import type { ProjectActionBinding } from "../../shared/project-runtime/action-bindings"
import type { HostProjectState } from "../../shared/project-runtime/host-types"
import type { FlowRun } from "../../shared/mods/flows/types"

import type { FlowActionExecutionFacts } from "../mods/flows/action-execution-facts"

export type ProjectRuntimeInputScope = Pick<
  HostProjectState,
  "workspace" | "installedPluginId" | "packageId" | "pluginDigest" | "manifest"
> & Partial<Pick<HostProjectState, "stageIndex">>

interface ProjectActionRuntime {
  /** Original manager instance capture; no lookup of a replacement owner during cleanup. */
  captureOperationRetirement?(workspace: string, threadId: string): {
    resident: boolean
    assertCurrent(): void
    retire(): Promise<void>
  }
  verifyReadOnlyCheckProvider?(workspace: string, threadId: string,
    provider: ClawActionIdentity, signal: AbortSignal): Promise<() => void>
  readExecutionResources?(project: ProjectRuntimeInputScope, snapshotRoot: string):
    import("../plugins/runtime-source-scope").RuntimeExecutionResources | undefined
  verifyReadOnlyContextProvider?(workspace: string, threadId: string,
    provider: ClawActionIdentity, signal: AbortSignal): Promise<() => void>
  /** Pure ledger read: unlike FlowManager.runs this must not reconcile or write history. */
  readRuns?(workspace: string, threadId: string): FlowRun[]
  /** Main-only original result custody; public Flow result rewrites are not business evidence. */
  readActionResult?(
    workspace: string,
    threadId: string,
    runId: string,
    executionId: string
  ): FlowActionExecutionFacts | undefined
  prepareInputIdentity?(project: ProjectRuntimeInputScope, snapshotRoot: string): Promise<void>
  inputIdentity?(project: ProjectRuntimeInputScope, snapshotRoot: string): string
  /** Preloaded schema/source names + original config/rules revisions; no package/knowledge reads. */
  captureInputAuthorityIdentity?(project: ProjectRuntimeInputScope, snapshotRoot: string): () => string
  publishRequiredContext?(workspace: string, text: string, signal: AbortSignal): Promise<string>
  readDeclaredContext?(project: ProjectRuntimeInputScope, snapshotRoot: string, stageId: string): string
  readContextMaterials?(project: ProjectRuntimeInputScope, snapshotRoot: string): {
    roots: Array<{ id: string; path: string; source?: "package" | "knowledge" }>
    configuration: import("../../shared/mods/types").ModObject
  }
  flows: Pick<FlowManager, "startSaved" | "waitForSettlement" | "run" | "cancel"> &
    Partial<Pick<FlowManager, "assertWorkspaceResourcesSettled">>
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
    ...(value.captureOperationRetirement ? {
      captureOperationRetirement: (workspace: string, threadId: string) =>
        value.captureOperationRetirement!(workspaceKey(workspace), threadId)
    } : {}),
    ...(value.verifyReadOnlyCheckProvider ? {
      verifyReadOnlyCheckProvider: (workspace: string, threadId: string,
        provider: ClawActionIdentity, signal: AbortSignal) =>
        value.verifyReadOnlyCheckProvider!(workspaceKey(workspace), threadId, provider, signal)
    } : {}),
    ...(value.readExecutionResources ? {
      readExecutionResources: (project: ProjectRuntimeInputScope, root: string) =>
        value.readExecutionResources!({ ...project, workspace: workspaceKey(project.workspace) }, root)
    } : {}),
    ...(value.verifyReadOnlyContextProvider ? {
      verifyReadOnlyContextProvider: (workspace: string, threadId: string,
        provider: ClawActionIdentity, signal: AbortSignal) =>
        value.verifyReadOnlyContextProvider!(workspaceKey(workspace), threadId, provider, signal)
    } : {}),
    ...(value.readContextMaterials ? {
      readContextMaterials: (project: ProjectRuntimeInputScope, root: string) =>
        value.readContextMaterials!({ ...project, workspace: workspaceKey(project.workspace) }, root)
    } : {}),
    ...(value.readDeclaredContext ? {
      readDeclaredContext: (project: ProjectRuntimeInputScope, root: string, stageId: string) =>
        value.readDeclaredContext!({ ...project, workspace: workspaceKey(project.workspace) }, root, stageId)
    } : {}),
    ...(value.readRuns
      ? {
          readRuns: (workspace: string, threadId: string) =>
            value.readRuns!(workspaceKey(workspace), threadId)
        }
      : {}),
    ...(value.readActionResult
      ? {
          readActionResult: (workspace: string, ...args: [string, string, string]) =>
            value.readActionResult!(workspaceKey(workspace), ...args)
        }
      : {}),
    ...(value.prepareInputIdentity
      ? {
          prepareInputIdentity: (project: ProjectRuntimeInputScope, root: string) =>
            value.prepareInputIdentity!(
              { ...project, workspace: workspaceKey(project.workspace) },
              root
            )
        }
      : {}),
    ...(value.inputIdentity
      ? {
          inputIdentity: (project: ProjectRuntimeInputScope, root: string) =>
            value.inputIdentity!({ ...project, workspace: workspaceKey(project.workspace) }, root)
        }
      : {}),
    ...(value.captureInputAuthorityIdentity ? {
      captureInputAuthorityIdentity: (project: ProjectRuntimeInputScope, root: string) =>
        value.captureInputAuthorityIdentity!({ ...project, workspace: workspaceKey(project.workspace) }, root)
    } : {}),
    ...(value.publishRequiredContext
      ? {
          publishRequiredContext: (workspace: string, text: string, signal: AbortSignal) =>
            value.publishRequiredContext!(workspaceKey(workspace), text, signal)
        }
      : {}),
    catalog: (workspace, threadId) => value.catalog(workspaceKey(workspace), threadId),
    prepareSelection: (workspace, threadId, bindings) =>
      value.prepareSelection(workspaceKey(workspace), threadId, bindings),
    flows: {
      ...(value.flows.assertWorkspaceResourcesSettled ? {
        assertWorkspaceResourcesSettled: (workspace: string) =>
          value.flows.assertWorkspaceResourcesSettled!(workspaceKey(workspace))
      } : {}),
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

/** Absent only in adapters that do not own a Function runtime. */
export function projectOperationRetirementCapture() {
  return runtime?.captureOperationRetirement
}

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

/** Host operation preparation can precede a conversation/token; these remain original main-only readers. */
export async function prepareProjectRuntimeInputIdentity(
  project: ProjectRuntimeInputScope,
  root: string
) {
  await runtime?.prepareInputIdentity?.(project, root)
}
export function projectRuntimeInputIdentity(
  project: ProjectRuntimeInputScope,
  root: string
): string | undefined {
  return runtime?.inputIdentity?.(project, root)
}
export function captureProjectRuntimeInputAuthorityIdentity(project: ProjectRuntimeInputScope, root: string) {
  return runtime?.captureInputAuthorityIdentity?.(project, root)
}
