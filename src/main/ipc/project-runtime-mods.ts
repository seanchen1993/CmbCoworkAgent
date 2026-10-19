import { registerNativeProjectSourceHandlers } from "./native-project-source"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { HostProjectState } from "../../shared/project-runtime/host-types"
import type { HostProjectService } from "../harness-board/project-runtime/host-service"
import { projectRuntimeFunctionSource } from "../harness-board/project-runtime-function-source"
import { getPlugins } from "../storage"
import {
  isProjectPreviewId,
  projectPreviewRegistry
} from "../mods/devtools/project-preview-registry"

/** Native-only package consent. Project/source identity is always resolved by the host. */
export function registerProjectRuntimeModsHandlers(
  ipc: IpcMain,
  trusted: (event: IpcMainInvokeEvent) => unknown,
  platform: () => HostProjectService,
  retainedRoot: (project: HostProjectState) => string,
  internal: (projectId: string) => boolean
) {
  function scope(event: IpcMainInvokeEvent, projectId: string) {
    trusted(event)
    if (
      typeof projectId !== "string" ||
      !projectId ||
      projectId.length > 256 ||
      internal(projectId)
    )
      throw Error("PROJECT_INVALID_INPUT")
    const project = platform().get(projectId)
    if (!project || project.status !== "active") throw Error("PROJECT_NOT_ACTIVE")
    const original = JSON.stringify(project)
    const root = retainedRoot(project)
    const authorityGuard = () => {
      trusted(event)
      if (JSON.stringify(platform().get(projectId)) !== original)
        throw Error("PROJECT_INPUT_CHANGED")
      if (isProjectPreviewId(project.installedPluginId))
        projectPreviewRegistry.assertProject(project)
      else if (
        !getPlugins().some((plugin) => plugin.id === project.installedPluginId && plugin.enabled)
      )
        throw Error("PROJECT_PLUGIN_UNAVAILABLE")
      if (
        platform()
          .operations(projectId, 100)
          .some((operation) =>
            ["started", "cancel_requested", "unknown"].includes(operation.status)
          )
      )
        throw Error("PROJECT_OPERATION_UNSETTLED")
    }
    const guard = () => {
      authorityGuard()
      if (retainedRoot(project) !== root) throw Error("PROJECT_INPUT_CHANGED")
      authorityGuard()
    }
    // retainedRoot already admitted the complete package; identity reads never reuse content proof.
    authorityGuard()
    return { project, root, guard, authorityGuard, ...projectRuntimeFunctionSource(project, root) }
  }
  registerNativeProjectSourceHandlers(ipc, "project-runtime", scope)
}
