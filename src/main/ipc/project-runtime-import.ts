import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { LocalProjectView } from "../../shared/project-runtime/platform-api"
import type {
  HostLegacyAdapterInput,
  HostLegacyImportInput,
  HostLegacyImportReview
} from "../../shared/project-runtime/host-types"
import type { HostProjectService } from "../harness-board/project-runtime/host-service"
import type { LegacyProjectRuntimeService } from "../harness-board/project-runtime/legacy-runtime-service"
import {
  HostLegacyImportService,
  reviewImportStageEligibility
} from "../harness-board/project-runtime/legacy-import-service"
import { authorizeProjectWorkspaceResources } from "./project-workspace-resources"

/** Native review and confirmation only; the same original stores retain all migration facts. */
export function registerProjectImportHandlers(
  ipc: IpcMain,
  deps: {
    trusted(event: IpcMainInvokeEvent): unknown
    legacy: LegacyProjectRuntimeService | undefined
    host(): HostProjectService
    view(projectId: string): LocalProjectView
  }
) {
  const service = (event: IpcMainInvokeEvent) => {
    deps.trusted(event)
    if (!deps.legacy) throw Error("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
    return new HostLegacyImportService(deps.legacy, deps.host(), {
      authorize: (...workspaces) =>
        authorizeProjectWorkspaceResources(workspaces, () => {
          deps.trusted(event)
        })
    })
  }
  ipc.handle("project-runtime:import-sources", (event) => {
    deps.trusted(event)
    if (!deps.legacy) throw Error("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
    return deps.legacy.listImportSources()
  })
  ipc.handle("project-runtime:import-target", async (event, installedPluginId: string) => {
    deps.trusted(event)
    const target = await deps.host().reviewImportTarget(installedPluginId)
    const adapters = await service(event).listAdapters(installedPluginId)
    deps.trusted(event)
    target.assertCurrent()
    const manifest = target.snapshot.manifest
    const eligibility = reviewImportStageEligibility(target.snapshot)
    return {
      adapters,
      stages: manifest.stages.map((stage) => ({
        id: stage.id,
        title: stage.title,
        eligible: eligibility.find((item) => item.stageId === stage.id)?.eligible === true,
        reason: eligibility.find((item) => item.stageId === stage.id)?.reason,
        artifacts: stage.artifactIds.map((id) => {
          const artifact = manifest.artifacts.find((item) => item.id === id)!
          return { id, path: artifact.path }
        })
      }))
    }
  })
  ipc.handle("project-runtime:import-review", async (event, input: HostLegacyImportInput) => {
    const review = await service(event).review(input)
    deps.trusted(event)
    return review
  })
  ipc.handle("project-runtime:import-review-adapter", async (event, input: HostLegacyAdapterInput) => {
    const review = await service(event).reviewAdapter(input)
    deps.trusted(event)
    return review
  })
  ipc.handle("project-runtime:import-resume-review", async (event, sourceProjectId: string) => {
    const review = await service(event).resumeReview(sourceProjectId)
    deps.trusted(event)
    return review
  })
  ipc.handle("project-runtime:import-confirm", async (event, review: HostLegacyImportReview) => {
    const project = await service(event).confirm(review)
    deps.trusted(event)
    return deps.view(project.projectId)
  })
}
