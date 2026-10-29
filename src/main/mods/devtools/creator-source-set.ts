import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { ProjectSourceSetStatus } from "../../../shared/mods/development"
import type { DevelopmentScope } from "../v2/development-session"
import type { DevelopmentContext } from "./development-service"
import type { BusinessDraftSettings } from "./creator-business-draft"
import { businessCreatorScopeKey } from "./creator-business-draft"
import type { ProjectAuthoringSessions } from "./project-authoring-session"
import type { CreatorProjectDeliveries } from "./creator-project-delivery"
import type { DerivationServiceDependencies } from "../../plugins/derivation-service"
import {
  derivationContentIdentity,
  snapshotDerivationSource,
  writeDerivationFiles
} from "../../plugins/derivation-source"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"
import { getProjectActionCatalog } from "../../harness-board/project-action-runtime"
import { readProjectSourceSet } from "./project-source-set"

interface Intent {
  scope: DevelopmentScope
  status: ProjectSourceSetStatus
  projectId: string
  revision: number
  sourceDigest: string
  goal: string
  name: string
  version: string
}

/** A bounded delivery intent. Original installers, grants and project services own effects. */
export class CreatorSourceSets {
  private readonly busy = new Set<string>()
  private readonly live = new Set<string>()
  constructor(
    private readonly deps: {
      root: string
      settings: BusinessDraftSettings
      context(threadId: string): DevelopmentContext
      occupied(threadId: string): boolean
      sessions: ProjectAuthoringSessions
      deliveries: CreatorProjectDeliveries
      plugins: DerivationServiceDependencies["plugins"]
      install: DerivationServiceDependencies["install"]
      observeInstallation: NonNullable<DerivationServiceDependencies["observeInstallation"]>
      validatePackage(directory: string): Promise<void>
      functions(workspace: string): Promise<FunctionPluginStatus[]>
      assertAuthorized(
        workspace: string,
        bindings: Array<{ pluginId: string; name: string; digest: string }>
      ): void
      actions?: typeof getProjectActionCatalog
      invalidate(): void
      changed(threadId: string): void
    }
  ) {}
  private key(scope: DevelopmentScope) {
    return "creator-source-set-v1:" + businessCreatorScopeKey(scope)
  }
  private read(scope: DevelopmentScope): Intent | undefined {
    const raw = this.deps.settings.getSetting(this.key(scope), "")
    if (!raw) return
    if (Buffer.byteLength(raw) > 32000) throw Error("SOURCE_SET_RECORD_INVALID")
    const value = JSON.parse(raw) as Intent
    if (
      JSON.stringify(value.scope) !== JSON.stringify(scope) ||
      !/^[a-f0-9-]{36}$/.test(value.status?.id) ||
      value.status.dependencies.length > 8 ||
      value.status.dependencies.some(
        (dep) => !/^[a-f0-9-]{36}$/.test(dep.id) || !/^[a-f0-9]{64}$/.test(dep.digest)
      )
    )
      throw Error("SOURCE_SET_RECORD_INVALID")
    return value
  }
  private persist(value: Intent, before: string | undefined, guard: () => void) {
    guard()
    if (
      !this.deps.settings.compareAndSetSetting(this.key(value.scope), before, JSON.stringify(value))
    )
      throw Error("SOURCE_SET_CHANGED")
    this.deps.changed(value.scope.threadId)
  }
  status(threadId: string): ProjectSourceSetStatus | undefined {
    const value = this.read(this.deps.context(threadId).scope)
    if (!value) return
    const status = structuredClone(value.status)
    if (!this.live.has(status.id) && !["ready", "cancelled"].includes(status.phase))
      status.phase = "needs-review"
    if (status.phase === "ready") {
      const delivery = this.deps.deliveries.status(threadId)
      if (!delivery || delivery.phase === "unknown" || (!delivery.pluginId && !delivery.canInstall))
        status.phase = "needs-review"
    }
    for (const dep of status.dependencies) if (dep.phase === "installing") dep.phase = "unknown"
    return status
  }
  private async run<T>(
    threadId: string,
    workspace: string,
    work: (context: DevelopmentContext) => Promise<T>
  ) {
    const context = this.deps.context(threadId)
    context.assertCurrent()
    if (context.scope.workspace !== workspace) throw Error("SOURCE_SET_SCOPE_CHANGED")
    // Reserved for admission only: no work, persistence or installation has started.
    if (this.busy.has(threadId) || this.deps.occupied(threadId)) throw Error("SOURCE_SET_BUSY")
    this.busy.add(threadId)
    try {
      return await work(context)
    } catch (error) {
      // A nested service must never make a possibly effected operation look safe to retry.
      if (error instanceof Error && error.message === "SOURCE_SET_BUSY")
        throw Error("SOURCE_SET_OPERATION_UNCONFIRMED")
      throw error
    } finally {
      this.busy.delete(threadId)
    }
  }
  private async verify(value: Intent, guard: () => void) {
    guard()
    const current = this.read(value.scope)
    if (current?.status.id !== value.status.id) throw Error("SOURCE_SET_CHANGED")
    if (value.status.phase === "cancelled") throw Error("SOURCE_SET_CANCELLED")
    const draft = this.deps.sessions.read(value.scope, value.projectId)
    if (draft.revision !== value.revision || draft.source.digest !== value.sourceDigest)
      throw Error("SOURCE_SET_PROJECT_CHANGED")
    for (const dep of value.status.dependencies) {
      const snapshot = await snapshotDerivationSource(join(this.deps.root, value.status.id, dep.id))
      guard()
      if (derivationContentIdentity(snapshot.files) !== dep.digest)
        throw Error("SOURCE_SET_DEPENDENCY_CHANGED")
    }
  }
  async import(threadId: string, workspace: string, root: string) {
    return this.run(threadId, workspace, async (context) => {
      const old = this.read(context.scope)
      if (old && !["ready", "cancelled"].includes(old.status.phase))
        throw Error("SOURCE_SET_PENDING")
      const source = await readProjectSourceSet(root, context.assertCurrent)
      const id = randomUUID()
      const dependencies: ProjectSourceSetStatus["dependencies"] = []
      let totalBytes = 0
      for (const item of source.dependencies) {
        totalBytes += item.snapshot.totalBytes
        if (totalBytes > 32 * 1024 * 1024) throw Error("SOURCE_SET_TOTAL_LIMIT")
        const depId = randomUUID(),
          directory = join(this.deps.root, id, depId)
        await mkdir(directory, { recursive: true })
        await writeDerivationFiles(directory, item.snapshot.files)
        await this.deps.validatePackage(directory)
        context.assertCurrent()
        dependencies.push({
          id: depId,
          name: item.name,
          version: item.version,
          digest: item.digest,
          phase: "prepared"
        })
      }
      const projectId = "source-set-" + id.slice(0, 8)
      const draft = await this.deps.sessions.save(
        context.scope,
        {
          id: projectId,
          revision: 0,
          name: source.declaration.title,
          files: source.project.bundle.files
        },
        context.assertCurrent
      )
      const value: Intent = {
        scope: context.scope,
        projectId,
        revision: draft.revision,
        sourceDigest: draft.source.digest,
        goal: source.declaration.goal,
        // The original delivery service always creates a distinct plugin from its author source.
        name: source.composition.plugin.id.slice(0, 38) + "-" + id.slice(0, 8),
        version: source.composition.plugin.version,
        status: { id, title: source.declaration.title, phase: "dependencies", dependencies }
      }
      this.persist(value, old ? JSON.stringify(old) : undefined, context.assertCurrent)
      this.live.add(id)
    })
  }
  async cancel(threadId: string, workspace: string, id: string) {
    return this.run(threadId, workspace, async (context) => {
      const value = this.read(context.scope)
      if (!value || value.status.id !== id) throw Error("SOURCE_SET_CHANGED")
      if (value.status.dependencies.some((dep) => ["unknown", "installing"].includes(dep.phase)))
        throw Error("SOURCE_SET_OUTCOME_UNCONFIRMED")
      const before = JSON.stringify(value)
      value.status.phase = "cancelled"
      this.live.delete(id)
      this.persist(value, before, context.assertCurrent)
    })
  }
  async install(threadId: string, workspace: string, id: string, dependencyId: string) {
    return this.run(threadId, workspace, async (context) => {
      const value = this.read(context.scope)
      if (!value || value.status.id !== id) throw Error("SOURCE_SET_CHANGED")
      await this.verify(value, context.assertCurrent)
      const dep = value.status.dependencies.find((dep) => dep.id === dependencyId)
      if (!dep || dep.phase !== "prepared") throw Error("SOURCE_SET_INSTALL_REVIEW_REQUIRED")
      const sameName = this.deps.plugins().filter((plugin) => plugin.name === dep.name)
      if (sameName.length > 1) throw Error("SOURCE_SET_INSTALLED_CONFLICT")
      let before = JSON.stringify(value)
      dep.pluginId = sameName[0]?.id ?? randomUUID()
      if (sameName.length) {
        const observed = await this.deps.observeInstallation(
          { pluginId: dep.pluginId, name: dep.name, version: dep.version, digest: dep.digest },
          context.assertCurrent
        )
        context.assertCurrent()
        if (observed.outcome !== "installed") throw Error("SOURCE_SET_INSTALLED_CONFLICT")
        dep.phase = "installed"
        this.persist(value, before, context.assertCurrent)
        return
      }
      dep.phase = "installing"
      this.persist(value, before, context.assertCurrent)
      before = JSON.stringify(value)
      try {
        const result = await this.deps.install(
          join(this.deps.root, id, dep.id),
          dep.name,
          dep.pluginId,
          context.assertCurrent,
          async (directory) => {
            const snapshot = await snapshotDerivationSource(directory)
            context.assertCurrent()
            if (derivationContentIdentity(snapshot.files) !== dep.digest)
              throw Error("SOURCE_SET_DEPENDENCY_CHANGED")
          }
        )
        context.assertCurrent()
        if (!result.success) throw Error("SOURCE_SET_INSTALL_UNCONFIRMED")
        dep.phase = "installed"
        this.persist(value, before, context.assertCurrent)
        this.deps.invalidate()
      } catch (error) {
        dep.phase = "unknown"
        this.persist(value, before, context.assertCurrent)
        throw error
      }
    })
  }
  async reconcile(threadId: string, workspace: string, id: string, dependencyId: string) {
    return this.run(threadId, workspace, async (context) => {
      const value = this.read(context.scope)
      if (!value || value.status.id !== id) throw Error("SOURCE_SET_CHANGED")
      const dep = value.status.dependencies.find((dep) => dep.id === dependencyId)
      if (!dep?.pluginId || !["unknown", "installing"].includes(dep.phase))
        throw Error("SOURCE_SET_NOT_UNKNOWN")
      const before = JSON.stringify(value)
      const observed = await this.deps.observeInstallation(
        { pluginId: dep.pluginId, name: dep.name, version: dep.version, digest: dep.digest },
        context.assertCurrent
      )
      context.assertCurrent()
      if (observed.outcome === "installed") dep.phase = "installed"
      else if (observed.outcome === "not-executed") {
        dep.phase = "prepared"
        delete dep.pluginId
      } else dep.phase = "unknown"
      this.persist(value, before, context.assertCurrent)
    })
  }
  async advance(threadId: string, workspace: string, id: string) {
    return this.run(threadId, workspace, async (context) => {
      const value = this.read(context.scope)
      if (!value || value.status.id !== id) throw Error("SOURCE_SET_CHANGED")
      await this.verify(value, context.assertCurrent)
      const authority = async () => {
        for (const dep of value.status.dependencies) {
          if (dep.phase !== "installed" || !dep.pluginId)
            throw Error("SOURCE_SET_DEPENDENCIES_PENDING")
          const observed = await this.deps.observeInstallation(
            { pluginId: dep.pluginId, name: dep.name, version: dep.version, digest: dep.digest },
            context.assertCurrent
          )
          context.assertCurrent()
          if (observed.outcome !== "installed") throw Error("SOURCE_SET_AUTHORIZATION_REQUIRED")
        }
        const statuses = await this.deps.functions(workspace)
        context.assertCurrent()
        // No await after reading the original current grants.
        const bindings = value.status.dependencies.map((dep) => {
          const status = statuses.find(
            (row) => row.pluginId === dep.pluginId && row.name === dep.name
          )
          if (status?.state !== "ready" || !status.digest)
            throw Error("SOURCE_SET_AUTHORIZATION_REQUIRED")
          return { pluginId: dep.pluginId!, name: dep.name, digest: status.digest }
        })
        this.deps.assertAuthorized(workspace, bindings)
        return JSON.stringify(bindings)
      }
      const expected = await authority()
      const guard = () => {
        context.assertCurrent()
        this.deps.assertAuthorized(workspace, JSON.parse(expected))
      }
      this.live.add(id)
      let before = JSON.stringify(value)
      // Compiler and its existing doctor/test remain the only project compilation path.
      if (value.status.phase !== "ready") {
        const compiled = await this.deps.sessions.compile(
          context.scope,
          value.projectId,
          value.revision,
          guard
        )
        guard()
        value.revision = compiled.revision
        value.sourceDigest = compiled.source.digest
        this.persist(value, before, guard)
        before = JSON.stringify(value)
      }
      if ((await authority()) !== expected) throw Error("SOURCE_SET_AUTHORIZATION_CHANGED")
      const actions = await (this.deps.actions ?? getProjectActionCatalog)(workspace, threadId)
      const trial = await this.deps.sessions.requestTrial(
        context.scope,
        value.projectId,
        value.revision,
        value.goal,
        guard,
        actions
      )
      guard()
      if ((await authority()) !== expected) throw Error("SOURCE_SET_AUTHORIZATION_CHANGED")
      await this.deps.deliveries.prepare(threadId, workspace, {
        requestId: trial.request.id,
        digest: trial.request.digest,
        name: value.name,
        version: value.version
      })
      context.assertCurrent()
      if ((await authority()) !== expected) throw Error("SOURCE_SET_AUTHORIZATION_CHANGED")
      value.status.phase = "ready"
      this.persist(value, before, guard)
    })
  }
}
