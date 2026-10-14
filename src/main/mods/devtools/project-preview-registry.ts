import { randomUUID } from "node:crypto"
import type {
  HostProjectOperation,
  HostProjectState
} from "../../../shared/project-runtime/host-types"
import type { PluginMetadata } from "../../types"
import type { DevelopmentScope } from "../v2/development-session"
import type { ProjectDevelopmentSnapshot } from "./project-development-session"
import { readProjectSource } from "./project-source"
import { inspectProjectSource } from "./project-doctor"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import { isSameWorkspacePath } from "../../../shared/workspace-path"

export const isProjectPreviewId = (id: string) => id.startsWith("dev-project-preview:")
interface Registration {
  projectId: string
  scope: DevelopmentScope
  snapshot: ProjectDevelopmentSnapshot
  plugin: PluginMetadata
  project?: HostProjectState
  guard(): void
  release(): void
}
/** Process-local explicit preview authority, never visible to the global installed-plugin catalog. */
export class ProjectPreviewRegistry {
  private entries = new Map<string, Registration>()

  async register(input: {
    projectId: string
    scope: DevelopmentScope
    snapshot: ProjectDevelopmentSnapshot
    guard(): void
    release(): void
    actions: readonly ClawActionDescriptor[]
  }) {
    input.guard()
    if (this.entries.size >= 64) throw Error("PROJECT_PREVIEW_LIMIT")
    const source = await readProjectSource(input.snapshot.packagePath)
    input.guard()
    if (source.bundle.digest !== input.snapshot.digest) throw Error("PROJECT_SOURCE_CHANGED")
    const { report, manifest } = inspectProjectSource(source.bundle, [], input.actions)
    if (!report.valid || !manifest) throw Error("PROJECT_DEV_DOCTOR_FAILED")
    const id = `dev-project-preview:${randomUUID()}`
    const now = new Date().toISOString()
    const plugin: PluginMetadata = {
      id,
      name: manifest.plugin.id,
      version: manifest.plugin.version,
      description: "用户确认的隔离项目试用",
      author: "Project preview",
      path: input.snapshot.packagePath,
      enabled: true,
      skillCount: 1,
      mcpServerCount: 0,
      createdAt: now,
      updatedAt: now
    }
    this.entries.set(id, {
      ...input,
      scope: structuredClone(input.scope),
      snapshot: structuredClone(input.snapshot),
      plugin
    })
    return { ...plugin }
  }

  resolve(id: string): PluginMetadata | undefined {
    if (!isProjectPreviewId(id)) return undefined
    const entry = this.entries.get(id)
    if (!entry) throw Error("PROJECT_PREVIEW_EXPIRED")
    entry.guard()
    return { ...entry.plugin }
  }

  async bind(project: HostProjectState, retainedRoot: string): Promise<void> {
    const entry = this.entries.get(project.installedPluginId)
    if (
      !entry ||
      entry.project ||
      entry.projectId !== project.projectId ||
      !isSameWorkspacePath(entry.snapshot.workspace, project.workspace) ||
      project.packageId !== entry.plugin.name ||
      project.packageVersion !== entry.plugin.version
    )
      throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
    entry.guard()
    const retained = await readProjectSource(retainedRoot)
    entry.guard()
    if (retained.bundle.digest !== entry.snapshot.digest) throw Error("PROJECT_SOURCE_CHANGED")
    entry.project = structuredClone(project)
  }

  assertProject(project: HostProjectState): PluginMetadata {
    const plugin = this.resolve(project.installedPluginId)
    const entry = this.entries.get(project.installedPluginId)
    const bound = entry?.project
    if (
      !plugin ||
      !bound ||
      bound.projectId !== project.projectId ||
      bound.pluginDigest !== project.pluginDigest ||
      bound.packageId !== project.packageId ||
      bound.packageVersion !== project.packageVersion ||
      JSON.stringify(bound.manifest) !== JSON.stringify(project.manifest) ||
      !isSameWorkspacePath(bound.workspace, project.workspace)
    )
      throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
    return plugin
  }

  projectFor(scope: DevelopmentScope, draftId: string) {
    for (const entry of this.entries.values())
      if (
        JSON.stringify(entry.scope) === JSON.stringify(scope) &&
        entry.snapshot.draftId === draftId
      )
        return entry.project?.projectId
    return undefined
  }

  describe(project: HostProjectState) {
    if (!isProjectPreviewId(project.installedPluginId)) return undefined
    try {
      this.assertProject(project)
      return {
        state: "active" as const,
        revision: this.entries.get(project.installedPluginId)!.snapshot.revision
      }
    } catch {
      return { state: "expired" as const }
    }
  }

  finish(
    project: HostProjectState,
    scope: DevelopmentScope,
    operations: HostProjectOperation[],
    cancel?: (operationId: string) => HostProjectOperation
  ) {
    const entry = this.entries.get(project.installedPluginId)
    if (
      !entry ||
      entry.projectId !== project.projectId ||
      JSON.stringify(entry.scope) !== JSON.stringify(scope)
    )
      throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
    if (
      operations.some((operation) =>
        ["started", "cancel_requested", "unknown"].includes(operation.status)
      )
    )
      throw Error("PROJECT_PREVIEW_UNSETTLED")
    for (const operation of operations) {
      if (operation.status === "prepared" || operation.status === "succeeded") {
        if (!cancel || cancel(operation.operationId).status !== "cancelled")
          throw Error("PROJECT_PREVIEW_UNSETTLED")
      }
    }
    this.entries.delete(project.installedPluginId)
    entry.release()
  }

  abandon(id: string) {
    const entry = this.entries.get(id)
    if (!entry || entry.project) throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
    this.entries.delete(id)
    entry.release()
  }

  complete(project: HostProjectState, operations: HostProjectOperation[]) {
    const entry = this.entries.get(project.installedPluginId)
    if (project.status === "completed" && entry) this.finish(project, entry.scope, operations)
  }
}
export const projectPreviewRegistry = new ProjectPreviewRegistry()
