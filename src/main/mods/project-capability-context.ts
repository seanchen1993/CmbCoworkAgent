import { getThreadCore } from "../db"
import {
  getHarnessCapabilityWorkspaces,
  getHarnessCapabilityFeatureWorkspace
} from "../harness-board/service"
import { resolveCapabilityContext } from "./capability-context"
import { readBuiltinProjectFacts } from "./builtins/project-facts"
import { readNativeChildModsContext } from "../agent/native-child-mods-context"
import { isSameWorkspacePath } from "../../shared/workspace-path"

/** Shared by project IPC and the original run admission path; no renderer mode hint is trusted. */
export function captureProjectCapabilityContext(threadId: string, workspace: string) {
  const context = captureNativeCapabilityContext(threadId, workspace)
  if (context.usage !== "project" || !context.projectId) throw Error("COMPOSITION_PROJECT_REQUIRED")
  return { ...context, projectId: context.projectId }
}

export function captureNativeCapabilityContext(threadId: string, workspace: string) {
  const child = readNativeChildModsContext(threadId)
  if (child && !isSameWorkspacePath(child.workspace, workspace)) throw Error("COMPOSITION_CONTEXT_CHANGED")
  const read = () => {
    child?.assertCurrent()
    return resolveCapabilityContext(workspace, child?.parentThreadId ?? threadId, {
      thread: getThreadCore,
      projectWorkspaces: getHarnessCapabilityWorkspaces,
      featureWorkspace: getHarnessCapabilityFeatureWorkspace,
      hostProject: (id, root, binding) => {
        const facts = readBuiltinProjectFacts(id, root)
        return (
          facts.facts.state === "observed" &&
          facts.review?.projectId === (binding as { projectId?: string }).projectId
        )
      }
    })
  }
  const context = read()
  return {
    ...context,
    assertCurrent: () => {
      if (read().identity !== context.identity) throw Error("COMPOSITION_CONTEXT_CHANGED")
    }
  }
}
