import { createHash, randomUUID } from "node:crypto"
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
import type { AuthoringAtomicSettings } from "./authoring-config-snapshot"
import { normalizeProjectResourcePaths } from "./project-resource-paths"

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
interface RetainedPreview {
  schemaVersion: 1
  id: string
  projectId: string
  scope: DevelopmentScope
  snapshot: ProjectDevelopmentSnapshot
  packageId: string
  packageVersion: string
  pluginDigest?: string
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const receiptKey = (scope: DevelopmentScope, draftId: string) =>
  `project-authoring-preview-v1:${createHash("sha256")
    .update(JSON.stringify([scope.threadId, scope.workspace, scope.incarnation, draftId]))
    .digest("hex")}`
const absent = "\0project-preview-absent"

/** Live authority is process-local. Durable receipts permit a new native review, never replay. */
export class ProjectPreviewRegistry {
  private entries = new Map<string, Registration>()
  private persistence?: AuthoringAtomicSettings

  configurePersistence(settings: AuthoringAtomicSettings): void {
    if (this.entries.size) throw Error("PROJECT_PREVIEW_PERSISTENCE_BUSY")
    this.persistence = settings
  }

  retained(scope: DevelopmentScope, draftId: string): RetainedPreview | undefined {
    const raw = this.persistence?.getSetting(receiptKey(scope, draftId), "")
    if (!raw) return undefined
    if (Buffer.byteLength(raw) > 32768) throw Error("PROJECT_PREVIEW_RECEIPT_INVALID")
    const value = JSON.parse(raw) as RetainedPreview
    if (
      value?.schemaVersion !== 1 ||
      !same(value.scope, scope) ||
      typeof value.id !== "string" ||
      !/^dev-project-preview:[a-f0-9-]{36}$/.test(value.id) ||
      typeof value.projectId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.projectId) ||
      !value.snapshot ||
      value.snapshot.draftId !== draftId ||
      typeof value.snapshot.devId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.snapshot.devId) ||
      !Number.isSafeInteger(value.snapshot.revision) ||
      value.snapshot.revision < 1 ||
      !/^[a-f0-9]{64}$/.test(value.snapshot.digest) ||
      typeof value.snapshot.packagePath !== "string" ||
      !value.snapshot.packagePath ||
      typeof value.snapshot.workspace !== "string" ||
      !value.snapshot.workspace ||
      typeof value.packageId !== "string" ||
      !value.packageId ||
      value.packageId.length > 200 ||
      typeof value.packageVersion !== "string" ||
      !value.packageVersion ||
      value.packageVersion.length > 100 ||
      (value.pluginDigest !== undefined && !/^[a-f0-9]{64}$/.test(value.pluginDigest))
    )
      throw Error("PROJECT_PREVIEW_RECEIPT_INVALID")
    normalizeProjectResourcePaths(value.snapshot.resourcePaths ?? [])
    return structuredClone(value)
  }

  private persist(value: RetainedPreview, guard: () => void): void {
    if (!this.persistence) return
    guard()
    const key = receiptKey(value.scope, value.snapshot.draftId)
    const before = this.persistence.getSetting(key, absent)
    const previous = this.retained(value.scope, value.snapshot.draftId)
    if (previous && (previous.id !== value.id || previous.projectId !== value.projectId))
      throw Error("PROJECT_PREVIEW_RECOVERY_REQUIRED")
    if (
      !this.persistence.compareAndSetSetting(
        key,
        before === absent ? undefined : before,
        JSON.stringify(value)
      )
    )
      throw Error("PROJECT_PREVIEW_RECEIPT_CHANGED")
  }

  private clear(scope: DevelopmentScope, draftId: string, id: string): void {
    if (!this.persistence) return
    const key = receiptKey(scope, draftId)
    const before = this.persistence.getSetting(key, absent)
    const previous = this.retained(scope, draftId)
    if (!previous) return
    if (
      previous.id !== id ||
      !this.persistence.compareAndSetSetting(key, before === absent ? undefined : before, "")
    )
      throw Error("PROJECT_PREVIEW_RECEIPT_CHANGED")
  }

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
    const source = await readProjectSource(input.snapshot.packagePath, input.snapshot.resourcePaths)
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
    this.persist(
      {
        schemaVersion: 1,
        id,
        projectId: input.projectId,
        scope: input.scope,
        snapshot: input.snapshot,
        packageId: manifest.plugin.id,
        packageVersion: manifest.plugin.version
      },
      input.guard
    )
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
    const retained = await readProjectSource(retainedRoot, entry.snapshot.resourcePaths)
    entry.guard()
    if (retained.bundle.digest !== entry.snapshot.digest) throw Error("PROJECT_SOURCE_CHANGED")
    this.persist(
      {
        schemaVersion: 1,
        id: entry.plugin.id,
        projectId: entry.projectId,
        scope: entry.scope,
        snapshot: entry.snapshot,
        packageId: entry.plugin.name,
        packageVersion: entry.plugin.version,
        pluginDigest: project.pluginDigest
      },
      entry.guard
    )
    entry.project = structuredClone(project)
  }

  /** Native confirmation rebinds the same retained project after checking its current source.
   * No Skill runs here. Old prepared approvals are cancelled through the original state owner;
   * uncertain effects keep their original unknown state and require result reconciliation.
   */
  async recover(input: {
    scope: DevelopmentScope
    draftId: string
    project: HostProjectState
    snapshot: ProjectDevelopmentSnapshot
    retainedRoot: string
    actions: readonly ClawActionDescriptor[]
    operations: readonly HostProjectOperation[]
    guard(): void
    assertProjectCurrent?(): void
    release(): void
    cancelPrepared(operationId: string): HostProjectOperation
  }): Promise<void> {
    input.guard()
    input.assertProjectCurrent?.()
    const saved = this.retained(input.scope, input.draftId)
    const project = input.project
    if (
      !saved ||
      this.entries.has(saved.id) ||
      this.entries.size >= 64 ||
      saved.projectId !== project.projectId ||
      saved.id !== project.installedPluginId ||
      saved.packageId !== project.packageId ||
      saved.packageVersion !== project.packageVersion ||
      (saved.pluginDigest && saved.pluginDigest !== project.pluginDigest) ||
      input.snapshot.revision !== saved.snapshot.revision ||
      input.snapshot.digest !== saved.snapshot.digest ||
      input.snapshot.draftId !== saved.snapshot.draftId ||
      !same(
        normalizeProjectResourcePaths(input.snapshot.resourcePaths ?? []),
        normalizeProjectResourcePaths(saved.snapshot.resourcePaths ?? [])
      ) ||
      !isSameWorkspacePath(saved.snapshot.workspace, project.workspace) ||
      !isSameWorkspacePath(input.snapshot.workspace, project.workspace)
    )
      throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
    const source = await readProjectSource(input.retainedRoot, saved.snapshot.resourcePaths)
    input.guard()
    input.assertProjectCurrent?.()
    const { report, manifest } = inspectProjectSource(source.bundle, [], input.actions)
    if (
      source.bundle.digest !== saved.snapshot.digest ||
      !report.valid ||
      !manifest ||
      !same(manifest, project.manifest)
    )
      throw Error("PROJECT_SOURCE_CHANGED")
    if (!same(this.retained(input.scope, input.draftId), saved))
      throw Error("PROJECT_PREVIEW_RECEIPT_CHANGED")
    for (const operation of input.operations) {
      if (
        operation.projectId !== project.projectId ||
        operation.pluginDigest !== project.pluginDigest
      )
        throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
      if (operation.status === "prepared") {
        input.guard()
        if (input.cancelPrepared(operation.operationId).status !== "cancelled")
          throw Error("PROJECT_PREVIEW_UNSETTLED")
      }
    }
    input.guard()
    input.assertProjectCurrent?.()
    const snapshot = { ...saved.snapshot, packagePath: source.root }
    this.persist({ ...saved, snapshot, pluginDigest: project.pluginDigest }, input.guard)
    const now = new Date().toISOString()
    this.entries.set(saved.id, {
      projectId: project.projectId,
      scope: structuredClone(input.scope),
      snapshot,
      project: structuredClone(project),
      guard: input.guard,
      release: input.release,
      plugin: {
        id: saved.id,
        name: saved.packageId,
        version: saved.packageVersion,
        description: "用户重新确认的隔离项目试用",
        author: "Project preview",
        path: source.root,
        enabled: true,
        skillCount: 1,
        mcpServerCount: 0,
        createdAt: now,
        updatedAt: now
      }
    })
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

  /** Native snapshot ownership lookup; never infer creator authority from a model field. */
  scopeForProject(project: HostProjectState): DevelopmentScope | undefined {
    const entry = this.entries.get(project.installedPluginId)
    if (!entry?.project || entry.projectId !== project.projectId) return undefined
    this.assertProject(project)
    return structuredClone(entry.scope)
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
    cancel?: (operationId: string) => HostProjectOperation,
    options: { preserveSucceeded?: boolean } = {}
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
      if (operation.status === "succeeded" && options.preserveSucceeded) continue
      if (operation.status === "prepared" || operation.status === "succeeded") {
        if (!cancel || cancel(operation.operationId).status !== "cancelled")
          throw Error("PROJECT_PREVIEW_UNSETTLED")
      }
    }
    this.clear(entry.scope, entry.snapshot.draftId, entry.plugin.id)
    this.entries.delete(project.installedPluginId)
    entry.release()
  }

  abandon(id: string) {
    const entry = this.entries.get(id)
    if (!entry || entry.project) throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
    this.clear(entry.scope, entry.snapshot.draftId, id)
    this.entries.delete(id)
    entry.release()
  }

  /** A created host project remains durable even when binding its live authority failed. */
  detach(id: string) {
    const entry = this.entries.get(id)
    if (!entry || entry.project) throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
    this.entries.delete(id)
    entry.release()
  }

  complete(project: HostProjectState, operations: HostProjectOperation[]) {
    const entry = this.entries.get(project.installedPluginId)
    if (project.status === "completed" && entry) this.finish(project, entry.scope, operations)
  }

  /** Explicitly end a durable, inactive preview without admitting any code or deleting artifacts. */
  finishRetained(
    scope: DevelopmentScope,
    draftId: string,
    project: HostProjectState | undefined,
    operations: HostProjectOperation[],
    cancel: (id: string) => HostProjectOperation,
    options: { preserveSucceeded?: boolean } = {}
  ) {
    const saved = this.retained(scope, draftId)
    if (!saved || this.entries.has(saved.id)) throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
    if (project) {
      if (
        project.projectId !== saved.projectId ||
        project.installedPluginId !== saved.id ||
        project.packageId !== saved.packageId ||
        project.packageVersion !== saved.packageVersion ||
        (saved.pluginDigest && project.pluginDigest !== saved.pluginDigest) ||
        !isSameWorkspacePath(saved.snapshot.workspace, project.workspace)
      )
        throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
      if (
        operations.some((operation) =>
          ["started", "cancel_requested", "unknown"].includes(operation.status)
        )
      )
        throw Error("PROJECT_PREVIEW_UNSETTLED")
      for (const operation of operations) {
        if (
          operation.projectId !== project.projectId ||
          operation.pluginDigest !== project.pluginDigest
        )
          throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
        if (operation.status === "succeeded" && options.preserveSucceeded) continue
        if (
          ["prepared", "succeeded"].includes(operation.status) &&
          cancel(operation.operationId).status !== "cancelled"
        )
          throw Error("PROJECT_PREVIEW_UNSETTLED")
      }
    } else if (operations.length) throw Error("PROJECT_PREVIEW_SCOPE_CHANGED")
    this.clear(scope, draftId, saved.id)
  }
}
export const projectPreviewRegistry = new ProjectPreviewRegistry()
