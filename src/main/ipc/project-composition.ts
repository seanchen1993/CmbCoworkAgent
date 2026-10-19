import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import { shell } from "electron"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { withSnapshotRetention } from "../harness-board/project-runtime/snapshot-retention"
import type {
  ProjectCompositionApi,
  ProjectCompositionScope,
  ProjectCapabilityPreview
} from "../../shared/project-runtime/composition-api"
import type { ProjectCompositionDefinition } from "../../shared/project-runtime/composition"
import { compositionText, parseProjectComposition } from "../../shared/project-runtime/composition"
import { isSameWorkspacePath } from "../../shared/workspace-path"
import { getOpenworkDir, getPlugins } from "../storage"
import { captureProjectCapabilityContext } from "../mods/project-capability-context"
import { runtimeDirectory, runtimeDigest } from "../harness-board/project-runtime/safe-files"
import { resolveCompositionWorkflows } from "../harness-board/project-runtime/composition-workflow"
import { ProjectCompositionService } from "../harness-board/project-runtime/composition-service"
import type { CompositionRun } from "../harness-board/project-runtime/composition-store"
import { ProjectCompositionPreviews } from "../harness-board/project-runtime/composition-preview"
import type { HostProjectService } from "../harness-board/project-runtime/host-service"
import type { HostProjectOperation } from "../../shared/project-runtime/host-types"
import {
  compositionSourceKey,
  readProjectCompositionCatalog,
  type CompositionCatalogSnapshot
} from "../plugins/project-composition-catalog"
import {
  getProjectCapabilitySelections,
  readProjectCapabilitySelection,
  parseProjectCapabilitySources
} from "../plugins/project-capability-selection"
import { ProjectCapabilityRuntimeService } from "../plugins/project-capability-runtime"
import { readCompositionArtifact } from "../harness-board/project-runtime/composition-artifact"
import { RetainedPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import type { CompositionExecutionContext } from "../harness-board/project-runtime/composition-coordinator"
import type { CompositionLegacyDependencies } from "../harness-board/project-runtime/composition-legacy-adapter"
import { CompositionToolApprovals } from "../harness-board/project-runtime/composition-tool-approvals"
import { capabilityCatalogWorkers } from "../plugins/capability-catalog-client"
import { registerNativeProjectSourceHandlers } from "./native-project-source"
import { projectRuntimeFunctionSource } from "../harness-board/project-runtime-function-source"
import type { ProjectCompositionUnitConfigurationScope } from "../../shared/project-runtime/composition-api"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { parseCompositionUnitContext } from "../../shared/project-runtime/composition-api"
import { readCompositionUnitContext, assertCompositionUnitContextSelection } from "../harness-board/project-runtime/composition-unit-context"

interface Dependencies {
  trusted(event: IpcMainInvokeEvent): BrowserWindow
  host(): HostProjectService
  assertWorkspaceIdle(workspace: string, parentProjectId: string): void
  bindOwner(operation: HostProjectOperation, owner: BrowserWindow): void
  legacy?(
    input: Pick<
      CompositionLegacyDependencies,
      "resolveSource" | "authorize" | "authorizeCancellation" | "assertAuthorityCurrent"
    > & {
      assertCurrent(context: CompositionExecutionContext): void
      owner(context: CompositionExecutionContext): BrowserWindow
    }
  ): CompositionLegacyDependencies
}

/** Project-only boundary. Renderer never supplies plugin paths, approvals or executable snapshots. */
export function registerProjectCompositionHandlers(ipc: IpcMain, deps: Dependencies) {
  const previews = new ProjectCompositionPreviews()
  const toolApprovals = new CompositionToolApprovals()
  type Capture = ReturnType<typeof capture>
  interface Authorization {
    capture: Capture
    snapshot: CompositionCatalogSnapshot
    owner: BrowserWindow
  }
  const authorizations = new Map<string, Authorization>()
  const cancellationAuthorizations = new Map<string, Capture>()
  const pendingCatalogs = new Map<string, Promise<CompositionCatalogSnapshot>>()
  const capabilityPreviews = new Map<
    string,
    {
      capture: Capture
      revision: string
      catalogRevision: string
      preview: ProjectCapabilityPreview
      expires: number
      appliedRevision?: string
    }
  >()
  let runtime: ProjectCompositionService | undefined
  let legacyPackages: RetainedPackageSnapshots | undefined
  const key = (definition: ProjectCompositionDefinition) => JSON.stringify(definition)

  function releaseAuthorization(definition: ProjectCompositionDefinition, auth: Authorization) {
    if (authorizations.get(key(definition)) === auth) authorizations.delete(key(definition))
  }

  async function authorizedBackground(
    definition: ProjectCompositionDefinition,
    auth: Authorization,
    start: () => Promise<CompositionRun>
  ) {
    try {
      const run = await withSnapshotRetention(
        [join(getOpenworkDir(), "project-compositions", "legacy-packages")],
        start
      )
      // Host pauses precede execution; legacy gates can suspend a still-live original agent.
      void composition()
        .waitForSettlement(run.id)
        .then((settled) => {
          if (
            settled.status === "waiting-approval" &&
            settled.units.some(
              (unit) =>
                unit.status === "waiting-approval" &&
                composition().isLegacyUnit(settled.id, unit.id)
            )
          )
            return
          releaseAuthorization(definition, auth)
        })
        .catch(() => {})
      return run
    } catch (error) {
      releaseAuthorization(definition, auth)
      throw error
    }
  }

  function capture(event: IpcMainInvokeEvent, input: ProjectCompositionScope) {
    const owner = deps.trusted(event)
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw Error("COMPOSITION_SCOPE_INVALID")
    const scope = {
      threadId: compositionText(input.threadId),
      projectId: compositionText(input.projectId),
      expectedWorkspace: runtimeDirectory(compositionText(input.expectedWorkspace))
    }
    const context = captureProjectCapabilityContext(scope.threadId, scope.expectedWorkspace)
    if (context.usage !== "project" || context.projectId !== scope.projectId)
      throw Error("COMPOSITION_PROJECT_REQUIRED")
    const identity = context.identity
    return {
      owner,
      scope,
      identity,
      projectName: "当前项目",
      assertCurrent: () => {
        deps.trusted(event)
        context.assertCurrent()
      }
    }
  }
  function authorize(definition: ProjectCompositionDefinition) {
    const authorization = authorizations.get(key(definition))
    if (!authorization) throw Error("COMPOSITION_AUTHORIZATION_REQUIRED")
    authorization.capture.assertCurrent()
    const installed = getPlugins()
    for (const unit of definition.units) {
      const selected = authorization.snapshot.sources.find(
        (source) => compositionSourceKey(source.entry.source) === compositionSourceKey(unit.source)
      )
      const plugin = installed.find((plugin) => plugin.id === unit.source.pluginId)
      if (
        !selected?.entry.available ||
        !plugin?.enabled ||
        plugin.name !== selected.plugin.name ||
        plugin.version !== selected.plugin.version ||
        plugin.path !== selected.plugin.path
      )
        throw Error("COMPOSITION_SOURCE_CHANGED")
    }
    return authorization
  }
  function authorizeRun(runId: string) {
    const run = composition().get(runId)
    if (!run) throw Error("COMPOSITION_RUN_MISSING")
    return authorize(run.definition)
  }
  function selectedSource(context: CompositionExecutionContext) {
    const auth = authorizeRun(context.runId)
    const source = auth.snapshot.sources.find(
      (source) =>
        compositionSourceKey(source.entry.source) === compositionSourceKey(context.unit.source)
    )
    if (!source) throw Error("COMPOSITION_SOURCE_CHANGED")
    return source
  }
  function sourceGoal(context: CompositionExecutionContext) {
    return [
      composition().get(context.runId)?.definition.goal,
      `执行项目组合中的“${selectedSource(context).entry.title}”，保留原有阶段检查和审批要求。`
    ]
      .filter(Boolean)
      .join("\n\n")
  }
  function composition(): ProjectCompositionService {
    if (!runtime) {
      runtime = new ProjectCompositionService(
        join(getOpenworkDir(), "project-compositions", "state.sqlite"),
        deps.host(),
        {
          legacy: deps.legacy?.({
            assertCurrent: (context) => {
              authorizeRun(context.runId)
            },
            assertAuthorityCurrent: (context, definition) => {
              const unit = definition.units.find(unit => unit.id === context.unit.id)
              if (definition.parentProjectId !== context.parentProjectId ||
                definition.workspace !== context.workspace || !unit ||
                compositionSourceKey(unit.source) !== compositionSourceKey(context.unit.source))
                throw Error("COMPOSITION_INTERNAL_SCOPE_CHANGED")
              authorize(definition)
            },
            owner: (context) => authorizeRun(context.runId).owner,
            authorize: async (context) => {
              authorizeRun(context.runId)
            },
            authorizeCancellation: async (context) => {
              const run = composition().get(context.runId)
              if (!run) throw Error("COMPOSITION_RUN_MISSING")
              const scope =
                cancellationAuthorizations.get(key(run.definition)) ??
                authorizations.get(key(run.definition))?.capture
              if (!scope) throw Error("COMPOSITION_AUTHORIZATION_REQUIRED")
              scope.assertCurrent()
            },
            resolveSource: async (context) => {
              const source = selectedSource(context)
              if (
                !("runtimeMode" in source.capability) ||
                source.capability.runtimeMode !== "legacy"
              )
                throw Error("COMPOSITION_LEGACY_SOURCE_CHANGED")
              legacyPackages ??= new RetainedPackageSnapshots(
                join(getOpenworkDir(), "project-compositions", "legacy-packages")
              )
              const snapshot = await legacyPackages.captureAsync(source.plugin.path)
              if (snapshot.digest !== context.unit.source.packageDigest)
                throw Error("COMPOSITION_SOURCE_CHANGED")
              const { readHarnessProjectContextsInWorker } =
                await import("../harness-board/catalog-client")
              const parents = await readHarnessProjectContextsInWorker(
                [context.parentProjectId],
                `composition-parent:${context.runId}:${context.unit.id}`
              )
              const parent = parents.projects[context.parentProjectId]?.project
              if (!parent) throw Error("COMPOSITION_PROJECT_REQUIRED")
              authorizeRun(context.runId)
              return {
                plugin: { ...source.plugin, path: snapshot.root },
                packageDigest: snapshot.digest,
                goal: sourceGoal(context),
                parent
              }
            }
          }),
          assertWorkspaceIdle: deps.assertWorkspaceIdle,
          authorizeParent: async (definition) => {
            const scope =
              cancellationAuthorizations.get(key(definition)) ??
              authorizations.get(key(definition))?.capture
            if (!scope) throw Error("COMPOSITION_AUTHORIZATION_REQUIRED")
            scope.assertCurrent()
          },
          authorizeDefinition: async (definition) => {
            authorize(definition)
          },
          authorize: async (context) => {
            authorizeRun(context.runId)
          },
          inputPath: (context, inputId) => {
            const auth = authorizeRun(context.runId)
            const source = auth.snapshot.sources.find(
              (source) =>
                compositionSourceKey(source.entry.source) ===
                compositionSourceKey(context.unit.source)
            )
            const input = source?.capability.inputs?.find((input) => input.id === inputId)
            if (!input) throw Error("COMPOSITION_INPUT_UNDECLARED")
            return input.path
          },
          configurationReady: async (run) => {
            const auth = authorize(run.definition)
            const assertions: Array<() => void> = []
            for (const unit of run.definition.units) {
              const context = unitConfigurationContext(auth.capture, run, unit.id)
              const source = await context.manager.runtimeSourceReview(context.input)
              context.guard()
              context.manager.assertRuntimeSourceReady(context.input)
              const identity = source && JSON.stringify(
                context.manager.readUserConfigIdentity(context.input.workspace, source.name))
              const settings = context.workspaceControl?.settingsStamp(context.input.workspace)
              const businessContext = await unitContextOptions(auth.capture, run, unit.id)
              assertCompositionUnitContextSelection(businessContext.view, run.unitContexts?.[unit.id])
              businessContext.assertCurrent()
              assertions.push(() => {
                context.guard()
                businessContext.assertCurrent()
                context.manager.assertRuntimeSourceReady(context.input)
                if ((source && JSON.stringify(context.manager.readUserConfigIdentity(
                  context.input.workspace, source.name)) !== identity) ||
                  context.workspaceControl?.settingsStamp(context.input.workspace) !== settings)
                  throw Error("COMPOSITION_CONFIGURATION_CHANGED")
              })
            }
            return () => assertions.forEach(assert => assert())
          },
          resolveSource: async (context) => {
            const source = selectedSource(context)
            return {
              installedPluginId: source.plugin.id,
              hostPackageDigest: context.unit.source.packageDigest,
              entry: source.capability.entry,
              runtimeMode:
                "runtimeMode" in source.capability && source.capability.runtimeMode === "legacy"
                  ? "legacy"
                  : "host",
              goal: sourceGoal(context)
            }
          },
          beforeStart: (context, operation) => {
            const auth = authorizeRun(context.runId)
            deps.bindOwner(operation, auth.owner)
          }
        }
      )
      runtime.recoverInterrupted()
    }
    return runtime
  }
  async function catalogSnapshot(scope: Capture): Promise<CompositionCatalogSnapshot> {
    scope.assertCurrent()
    const plugins = getPlugins().map((plugin) => ({ ...plugin }))
    const registry = JSON.stringify(plugins)
    const pendingKey = JSON.stringify([scope.owner.webContents?.id, registry])
    let pending = pendingCatalogs.get(pendingKey)
    if (!pending) {
      const abort = new AbortController()
      const closed = () => abort.abort(Error("COMPOSITION_CATALOG_BUSY"))
      scope.owner.once?.("closed", closed)
      pending = capabilityCatalogWorkers
        .read(
          (reader) => readProjectCompositionCatalog(plugins, abort.signal, reader),
          abort.signal
        )
        .finally(() => scope.owner.removeListener?.("closed", closed))
      pendingCatalogs.set(pendingKey, pending)
      void pending.finally(() => pendingCatalogs.delete(pendingKey)).catch(() => {})
    }
    const snapshot = structuredClone(await pending)
    if (snapshot.sources.some((source) => source.entry.available && source.capability.kind === "flow" && source.capability.runtimeMode === "legacy")) {
      try {
        const { readNativeNodeContext } = await import("../harness-board/service")
        const context = await readNativeNodeContext(scope.scope.projectId, scope.scope.expectedWorkspace)
        for (const source of snapshot.sources) {
          if (source.plugin.id !== context.project.harnessAdapter.id || source.capability.kind !== "flow" ||
            source.capability.runtimeMode !== "legacy" || !source.entry.available ||
            !context.config.templates.some((template) => template.templateType === "custom")) continue
          source.nodeContext = context
          source.entry.workflow = { config: context.config, nodes: context.nodes }
        }
      } catch {
        snapshot.diagnostics.push("当前项目未提供自选步骤，完整流程仍可使用。")
      }
      snapshot.revision = runtimeDigest(JSON.stringify(snapshot.sources))
    }
    scope.assertCurrent()
    if (registry !== JSON.stringify(getPlugins().map((plugin) => ({ ...plugin }))))
      throw Error("COMPOSITION_SOURCE_CHANGED")
    return snapshot
  }
  async function resolveWorkflows(scope: Capture, snapshot: CompositionCatalogSnapshot, value: unknown,
    reviewed?: Parameters<typeof resolveCompositionWorkflows>[2]["reviewed"]) {
    const definition = parseProjectComposition(value)
    if (!definition.units.some((unit) => unit.workflow)) return definition
    const { runNativeNodeClosure, verifyNativeNodeIdentity } = await import("../harness-board/service")
    return resolveCompositionWorkflows(definition, snapshot, {
      run: runNativeNodeClosure,
      verify: (context) => verifyNativeNodeIdentity(context, scope.scope.expectedWorkspace),
      assertCurrent: scope.assertCurrent,
      reviewed
    })
  }
  function ownedRun(scope: Capture, id: string) {
    const run = composition().get(compositionText(id))
    if (
      !run ||
      run.definition.parentProjectId !== scope.scope.projectId ||
      !isSameWorkspacePath(run.definition.workspace, scope.scope.expectedWorkspace)
    )
      throw Error("COMPOSITION_RUN_SCOPE_CHANGED")
    scope.assertCurrent()
    return run
  }
  async function adopt(
    event: IpcMainInvokeEvent,
    scope: Capture,
    definition: ProjectCompositionDefinition
  ) {
    const snapshot = await catalogSnapshot(scope)
    previews.remember(scope.scope, scope, snapshot)
    const resolved = await resolveWorkflows(scope, snapshot, definition)
    if (JSON.stringify(resolved) !== JSON.stringify(parseProjectComposition(definition)))
      throw Error("COMPOSITION_WORKFLOW_CHANGED")
    const preview = previews.preview(scope.scope, snapshot.revision, resolved)
    if (preview.issues.length) throw Error("COMPOSITION_SOURCE_CHANGED")
    const auth = { capture: scope, snapshot, owner: deps.trusted(event) }
    authorizations.set(key(definition), auth)
    return auth
  }
  async function configurationAuthorization(event: IpcMainInvokeEvent, scope: Capture, run: CompositionRun) {
    const current = authorizations.get(key(run.definition))
    if (current?.owner === scope.owner) {
      try { current.capture.assertCurrent(); return current }
      catch { /* A fresh native frame must re-admit the locked catalog; old frames fail capture. */ }
    }
    return adopt(event, scope, run.definition)
  }
  function unitConfigurationContext(scope: Capture, run: CompositionRun, unitId: string) {
    const unit = run.definition.units.find(item => item.id === compositionText(unitId))
    const workspace = composition().store.unitWorkspace(run.id, unitId)
    if (!run.configurationPending || run.status !== "running" || !unit || !workspace ||
        run.units.some(item => item.status !== "pending" || item.attemptId || item.engineRunId))
      throw Error("COMPOSITION_CONFIGURATION_CHANGED")
    const auth = authorize(run.definition)
    const source = auth.snapshot.sources.find(item =>
      compositionSourceKey(item.entry.source) === compositionSourceKey(unit.source))
    if (!source) throw Error("COMPOSITION_SOURCE_CHANGED")
    const legacy = "runtimeMode" in source.capability && source.capability.runtimeMode === "legacy"
    if (legacy) legacyPackages ??= new RetainedPackageSnapshots(
      join(getOpenworkDir(), "project-compositions", "legacy-packages"))
    const read = () => legacy
      ? legacyPackages!.read(unit.source.packageDigest)
      : deps.host().readConfigurationSource(unit.source.packageDigest)
    const retained = read()
    const projectId = `${legacy ? "composition-legacy" : "composition"}:${run.id}:${unit.id}`
    const identity = JSON.stringify(run)
    const authorityGuard = () => {
      scope.assertCurrent()
      if (JSON.stringify(ownedRun(scope, run.id)) !== identity ||
          composition().store.unitWorkspace(run.id, unit.id) !== workspace)
        throw Error("COMPOSITION_CONFIGURATION_CHANGED")
      const current = authorize(run.definition)
      if (current.owner !== scope.owner) throw Error("COMPOSITION_CONTEXT_CHANGED")
    }
    const guard = () => {
      authorityGuard()
      if (read().root !== retained.root) throw Error("COMPOSITION_SOURCE_CHANGED")
      authorityGuard()
    }
    authorityGuard()
    return {
      project: { projectId, version: run.version, pluginDigest: unit.source.packageDigest },
      guard, authorityGuard,
      ...projectRuntimeFunctionSource({ projectId, workspace,
        pluginDigest: unit.source.packageDigest, installedPluginId: unit.source.pluginId,
        packageId: source.plugin.name }, retained.root)
    }
  }
  async function prepareUnitSources(run: CompositionRun) {
    const auth = authorize(run.definition)
    for (const unit of run.definition.units) {
      const source = auth.snapshot.sources.find(item =>
        compositionSourceKey(item.entry.source) === compositionSourceKey(unit.source))
      if (!source) throw Error("COMPOSITION_SOURCE_CHANGED")
      if ("runtimeMode" in source.capability && source.capability.runtimeMode === "legacy") {
        legacyPackages ??= new RetainedPackageSnapshots(
          join(getOpenworkDir(), "project-compositions", "legacy-packages"))
        const snapshot = await legacyPackages.captureAsync(source.plugin.path)
        if (snapshot.digest !== unit.source.packageDigest) throw Error("COMPOSITION_SOURCE_CHANGED")
      } else await deps.host().retainConfigurationSource(unit.source.pluginId, unit.source.packageDigest)
      authorize(run.definition)
    }
  }
  async function unitContextOptions(scope: Capture, run: CompositionRun, unitId: string) {
    const context = unitConfigurationContext(scope, run, unitId)
    const unit = run.definition.units.find(item => item.id === unitId)!
    const source = authorize(run.definition).snapshot.sources.find(item =>
      compositionSourceKey(item.entry.source) === compositionSourceKey(unit.source))!
    if (!("runtimeMode" in source.capability) || source.capability.runtimeMode !== "legacy")
      return { view: { supported: false, required: false, candidates: [], selected: [] }, assertCurrent: context.guard }
    const result = await readCompositionUnitContext({
      plugin: { ...source.plugin, path: context.input.plugin.path },
      packageDigest: unit.source.packageDigest, workspace: composition().store.unitWorkspace(run.id, unit.id)!,
      configurationWorkspace: context.input.workspace, manager: context.manager,
      grantScope: context.input.scope, assertCurrent: context.guard,
      assertAuthorityCurrent: context.authorityGuard
    })
    return { ...result, view: { ...result.view, selected: run.unitContexts?.[unit.id]?.deployUnitIds ?? [] } }
  }
  async function contextConfigurationRequest(event: IpcMainInvokeEvent, input: ProjectCompositionUnitConfigurationScope, saving = false) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(key => !["scope", "runId", "unitId", "expectedVersion",
          ...(saving ? ["deployUnitIds", "contextFingerprint"] : [])].includes(key)) ||
        !Number.isSafeInteger(input.expectedVersion)) throw Error("COMPOSITION_SCOPE_INVALID")
    const scope = capture(event, input.scope)
    const run = ownedRun(scope, input.runId)
    if (run.version !== input.expectedVersion) throw Error("COMPOSITION_VERSION_CONFLICT")
    await configurationAuthorization(event, scope, run)
    return { scope, run, context: await unitContextOptions(scope, run, input.unitId) }
  }
  ipc.handle("project-composition:readUnitContext", async (event, input: Parameters<ProjectCompositionApi["readUnitContext"]>[0]) => {
    const result = await contextConfigurationRequest(event, input)
    result.context.assertCurrent()
    return result.context.view
  })
  ipc.handle("project-composition:saveUnitContext", async (event, input: Parameters<ProjectCompositionApi["saveUnitContext"]>[0]) => {
    const result = await contextConfigurationRequest(event, input, true)
    const selected = parseCompositionUnitContext({ deployUnitIds: input.deployUnitIds, contextFingerprint: input.contextFingerprint })
    assertCompositionUnitContextSelection(result.context.view, selected)
    result.context.assertCurrent()
    return composition().store.saveUnitContext(result.run.id, input.expectedVersion, input.unitId, selected)
  })
  registerNativeProjectSourceHandlers(ipc, "project-composition-unit", async (event, editorKey) => {
    if (typeof editorKey !== "string" || editorKey.length > 4096) throw Error("COMPOSITION_SCOPE_INVALID")
    const value = JSON.parse(editorKey) as ProjectCompositionUnitConfigurationScope
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => !["scope", "runId", "unitId", "expectedVersion"].includes(key)) ||
        !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1)
      throw Error("COMPOSITION_SCOPE_INVALID")
    const scope = capture(event, value.scope)
    const run = ownedRun(scope, value.runId)
    if (run.version !== value.expectedVersion) throw Error("COMPOSITION_VERSION_CONFLICT")
    await configurationAuthorization(event, scope, run)
    return unitConfigurationContext(scope, run, value.unitId)
  })
  function capabilityRuntime(scope: Capture, revision: string) {
    return new ProjectCapabilityRuntimeService(
      join(getOpenworkDir(), "project-compositions", "capability-packages"),
      {
        getPlugin: (id) => getPlugins().find((plugin) => plugin.id === id),
        assertCurrent: () => {
          scope.assertCurrent()
          if (
            readProjectCapabilitySelection(scope.scope.projectId, scope.scope.expectedWorkspace)
              .revision !== revision
          )
            throw Error("PROJECT_CAPABILITIES_CHANGED")
        }
      }
    )
  }
  function capabilityProfile(scope: Capture) {
    const profile = readProjectCapabilitySelection(
      scope.scope.projectId,
      scope.scope.expectedWorkspace
    )
    return { revision: profile.revision, contextKey: scope.identity, sources: profile.sources }
  }
  ipc.handle("project-composition:readCapabilities", (event, input: ProjectCompositionScope) =>
    capabilityProfile(capture(event, input))
  )
  ipc.handle(
    "project-composition:previewCapabilities",
    async (event, input: Parameters<ProjectCompositionApi["previewCapabilities"]>[0]) => {
      const scope = capture(event, input.scope)
      const catalog = previews.requireCatalog(scope.scope, input.catalogRevision)
      const requested = parseProjectCapabilitySources(input.sources)
      const profile = capabilityProfile(scope)
      const issues: string[] = []
      const sources: typeof requested = []
      const selected = new Set<string>()
      const visiting = new Set<string>()
      const add = (ref: (typeof requested)[number]) => {
        const key = compositionSourceKey(ref)
        if (selected.has(key)) return
        if (visiting.has(key)) {
          issues.push("能力依赖形成循环，请联系插件开发者。")
          return
        }
        visiting.add(key)
        const source = catalog.snapshot.sources.find(
          (item) => compositionSourceKey(item.entry.source) === key
        )
        if (!source || source.entry.kind !== "capability" || !source.entry.available) {
          issues.push(`${source?.entry.title ?? ref.capabilityId} 暂不能用于项目对话，请重新选择。`)
        } else {
          for (const dependency of source.capability.dependsOn) {
            const item = catalog.snapshot.sources.find(
              (item) =>
                item.plugin.id === ref.pluginId &&
                item.capability.id === dependency &&
                item.entry.source.packageDigest === ref.packageDigest
            )
            if (!item) issues.push(`${source.entry.title} 缺少所需能力 ${dependency}。`)
            else add(item.entry.source)
          }
          selected.add(key)
          sources.push(ref)
        }
        visiting.delete(key)
      }
      for (const source of requested) add(source)
      if (sources.length > 16) issues.push("最多可组合 16 项能力，请减少选择。")
      if (!issues.length && sources.length) {
        try {
          await capabilityRuntime(scope, profile.revision).validate(sources)
        } catch (error) {
          issues.push(error instanceof Error ? error.message : "能力检查失败，请重新检查来源插件。")
        }
      }
      scope.assertCurrent()
      if (profile.revision !== capabilityProfile(scope).revision)
        throw Error("PROJECT_CAPABILITIES_CHANGED")
      const preview: ProjectCapabilityPreview = {
        id: randomUUID(),
        contextKey: scope.identity,
        sources,
        addedSources: sources.filter(
          (source) =>
            !requested.some((ref) => compositionSourceKey(ref) === compositionSourceKey(source))
        ),
        issues
      }
      for (const [id, lease] of capabilityPreviews)
        if (lease.expires <= Date.now()) capabilityPreviews.delete(id)
      if (capabilityPreviews.size >= 32)
        capabilityPreviews.delete(capabilityPreviews.keys().next().value!)
      capabilityPreviews.set(preview.id, {
        capture: scope,
        revision: profile.revision,
        catalogRevision: input.catalogRevision,
        preview: structuredClone(preview),
        expires: Date.now() + 600_000
      })
      return preview
    }
  )
  ipc.handle(
    "project-composition:applyCapabilities",
    async (event, input: Parameters<ProjectCompositionApi["applyCapabilities"]>[0]) => {
      return withSnapshotRetention(
        [join(getOpenworkDir(), "project-compositions", "capability-packages")],
        async () => {
          const scope = capture(event, input.scope)
          const lease = capabilityPreviews.get(input.previewId)
          if (
            !lease ||
            lease.expires <= Date.now() ||
            lease.capture.identity !== scope.identity ||
            lease.capture.scope.threadId !== scope.scope.threadId
          )
            throw Error("COMPOSITION_PREVIEW_EXPIRED")
          lease.capture.assertCurrent()
          if (lease.preview.issues.length) throw Error("COMPOSITION_PREVIEW_INVALID")
          const current = capabilityProfile(scope)
          if (lease.appliedRevision && current.revision === lease.appliedRevision) return current
          if (lease.revision !== input.expectedRevision || current.revision !== lease.revision)
            throw Error("PROJECT_CAPABILITIES_CHANGED")
          if (lease.preview.sources.length)
            await capabilityRuntime(scope, lease.revision).admit(lease.preview.sources)
          scope.assertCurrent()
          const saved = composition().guardWorkspaceMutation(scope.scope.expectedWorkspace, () => {
            deps.assertWorkspaceIdle(scope.scope.expectedWorkspace, scope.scope.projectId)
            return getProjectCapabilitySelections().save(
              scope.scope.projectId,
              scope.scope.expectedWorkspace,
              lease.revision,
              lease.preview.sources
            )
          })
          lease.appliedRevision = saved.revision
          return { revision: saved.revision, contextKey: scope.identity, sources: saved.sources }
        }
      )
    }
  )
  ipc.handle("project-composition:catalog", async (event, input: ProjectCompositionScope) => {
    const scope = capture(event, input)
    return previews.remember(scope.scope, scope, await catalogSnapshot(scope))
  })
  ipc.handle(
    "project-composition:preview",
    async (event, input: Parameters<ProjectCompositionApi["preview"]>[0]) => {
      const scope = capture(event, input.scope)
      const catalog = previews.requireCatalog(scope.scope, input.catalogRevision)
      const optionalOmissions: Array<{ unitId: string; nodeId: string; path: string }> = []
      const entryInputFallbacks: Array<{ unitId: string; nodeId: string; path: string; guidance: string }> = []
      const definition = await resolveWorkflows(scope, catalog.snapshot, input.definition,
        (unitId, omissions, entryInputs) => {
          optionalOmissions.push(...omissions.map((item) => ({ unitId, ...item })))
          entryInputFallbacks.push(...entryInputs.map((item) => ({ unitId, ...item })))
        })
      return previews.preview(scope.scope, input.catalogRevision, definition, optionalOmissions, entryInputFallbacks)
    }
  )
  async function prepareRequest(event: IpcMainInvokeEvent, input: Parameters<ProjectCompositionApi["prepare"]>[0]) {
      const scope = capture(event, input.scope)
      const requestId = compositionText(input.requestId)
      const lease = previews.consume(scope.scope, input.previewId, requestId)
      if (lease.catalog.capture.identity !== scope.identity)
        throw Error("COMPOSITION_CONTEXT_CHANGED")
      // Re-read packages at confirmation; editing a source after preview never silently executes it.
      const snapshot = await catalogSnapshot(scope)
      if (snapshot.revision !== lease.catalog.snapshot.revision)
        throw Error("COMPOSITION_CATALOG_CHANGED")
      const auth = {
        capture: scope,
        snapshot,
        owner: deps.trusted(event)
      }
      authorizations.set(key(lease.preview.definition), auth)
      const run = await composition().prepare(lease.preview.definition, requestId)
      if (run.configurationPending) await prepareUnitSources(run)
      scope.assertCurrent()
      return run
  }
  ipc.handle("project-composition:prepare", prepareRequest)
  ipc.handle(
    "project-composition:startPrepared",
    async (event, input: Parameters<ProjectCompositionApi["startPrepared"]>[0]) => {
      const scope = capture(event, input.scope)
      const run = ownedRun(scope, input.runId)
      if (!run.configurationPending) return run
      if (run.version !== input.expectedVersion) throw Error("COMPOSITION_VERSION_CONFLICT")
      const auth = await configurationAuthorization(event, scope, run)
      await prepareUnitSources(run)
      return authorizedBackground(run.definition, auth, () =>
        composition().startPrepared(run.id, input.expectedVersion))
    }
  )
  ipc.handle("project-composition:start", async (event, input: Parameters<ProjectCompositionApi["start"]>[0]) => {
    const run = await prepareRequest(event, input)
    if (!run.configurationPending) return run
    const auth = authorize(run.definition)
    try {
      return await authorizedBackground(run.definition, auth, () => composition().startPrepared(run.id, run.version))
    } catch (error) {
      if ((error instanceof ModFunctionError && /^(MODS_USER_CONFIG_|MODS_SECRET_|PROJECT_MODS_APPROVAL_REQUIRED)/.test(error.code)) ||
          (error instanceof Error && error.message.startsWith("COMPOSITION_UNIT_CONTEXT_REQUIRED")))
        return ownedRun(capture(event, input.scope), run.id)
      throw error
    }
  })
  ipc.handle(
    "project-composition:read",
    (event, input: Parameters<ProjectCompositionApi["read"]>[0]) =>
      ownedRun(capture(event, input.scope), input.runId)
  )
  ipc.handle(
    "project-composition:readArtifact",
    (event, input: Parameters<ProjectCompositionApi["readArtifact"]>[0]) => {
      const scope = capture(event, input.scope)
      const run = ownedRun(scope, input.runId)
      return readCompositionArtifact(
        run,
        compositionText(input.unitId),
        compositionText(input.artifactId),
        (runId, unitId) => composition().store.unitWorkspace(runId, unitId)
      )
    }
  )
  ipc.handle(
    "project-composition:openWorkspace",
    async (event, input: Parameters<ProjectCompositionApi["openWorkspace"]>[0]) => {
      const scope = capture(event, input.scope)
      const run = ownedRun(scope, input.runId)
      const unitId = compositionText(input.unitId)
      if (
        !run.definition.units.some((unit) => unit.id === unitId) ||
        !run.units.some((unit) => unit.id === unitId)
      )
        throw Error("COMPOSITION_UNIT_UNKNOWN")
      // The store checks the original directory identity, including completed runs.
      const path = composition().store.unitWorkspace(run.id, unitId)
      if (!path) throw Error("COMPOSITION_EXECUTION_WORKSPACE_MISSING")
      scope.assertCurrent()
      const error = await shell.openPath(path)
      if (error) throw Error("COMPOSITION_WORKSPACE_OPEN_FAILED")
      return { path }
    }
  )
  ipc.handle(
    "project-composition:readToolApprovals",
    (event, input: Parameters<ProjectCompositionApi["readToolApprovals"]>[0]) => {
      const scope = capture(event, input.scope)
      const run = ownedRun(scope, input.runId)
      return toolApprovals.list(
        run.units.map((unit) => ({
          unitId: unit.id,
          threadIds: composition().executionThreadIds(run.id, unit.id)
        }))
      )
    }
  )
  ipc.handle(
    "project-composition:respondToolApproval",
    (event, input: Parameters<ProjectCompositionApi["respondToolApproval"]>[0]) => {
      const scope = capture(event, input.scope)
      const run = ownedRun(scope, input.runId)
      toolApprovals.respond({
        requestId: compositionText(input.requestId),
        threadIds: composition().executionThreadIds(run.id, compositionText(input.unitId)),
        decision: input.decision,
        webContentsId: event.sender.id
      })
    }
  )
  ipc.handle(
    "project-composition:readLegacyDecision",
    (event, input: Parameters<ProjectCompositionApi["readLegacyDecision"]>[0]) => {
      const scope = capture(event, input.scope)
      const run = ownedRun(scope, input.runId)
      const unit = run.units.find((unit) => unit.status === "waiting-approval")
      return unit ? (composition().waitingLegacyDecision(run.id, unit.id) ?? null) : null
    }
  )
  ipc.handle(
    "project-composition:decideLegacyDecision",
    async (event, input: Parameters<ProjectCompositionApi["decideLegacyDecision"]>[0]) => {
      const scope = capture(event, input.scope)
      const run = ownedRun(scope, input.runId)
      if (run.version !== input.expectedVersion) throw Error("COMPOSITION_VERSION_CHANGED")
      await adopt(event, scope, run.definition)
      return composition().decideLegacy(
        run.id,
        compositionText(input.unitId),
        input.expectedVersion,
        {
          notificationId: compositionText(input.notificationId),
          action: input.action,
          message: input.message
        }
      )
    }
  )
  ipc.handle(
    "project-composition:waitingApproval",
    (event, input: Parameters<ProjectCompositionApi["waitingApproval"]>[0]) => {
      const scope = capture(event, input.scope)
      const run = ownedRun(scope, input.runId)
      const unit = run.units.find((unit) => unit.status === "waiting-approval")
      if (!unit) return null
      const legacy = composition().waitingLegacyApproval(run.id, unit.id)
      if (legacy) return legacy
      if (composition().isLegacyUnit(run.id, unit.id)) return null
      const operation = composition().waitingOperation(run.id, unit.id)
      if (!operation) throw Error("COMPOSITION_APPROVAL_CHANGED")
      if (operation.approval) return null
      const project = deps.host().get(operation.projectId)
      const stage = project?.manifest.stages.find((stage) => stage.id === operation.stageId)
      if (!stage) throw Error("COMPOSITION_APPROVAL_CHANGED")
      return {
        unitId: unit.id,
        operationId: operation.operationId,
        operationVersion: operation.expectedVersion,
        inputFingerprint: operation.inputFingerprint,
        stageTitle: stage.title,
        checks: [...stage.checkIds],
        artifacts: [...stage.artifactIds]
      }
    }
  )
  ipc.handle(
    "project-composition:approve",
    async (event, input: Parameters<ProjectCompositionApi["approve"]>[0]) => {
      const scope = capture(event, input.scope)
      const run = ownedRun(scope, input.runId)
      if (!["approved", "rejected"].includes(input.decision))
        throw Error("COMPOSITION_APPROVAL_INVALID")
      const auth = await adopt(event, scope, run.definition)
      try {
        if (input.kind === "legacy-human-gate") {
          await composition().approveLegacy(
            run.id,
            input.unitId,
            input.gateId,
            input.expectedVersion,
            input.decision === "approved" ? "approve" : "reject"
          )
        } else {
          await composition().approve(run.id, input.unitId, input.operationId, {
            expectedVersion: input.expectedVersion,
            inputFingerprint: input.inputFingerprint,
            decision: input.decision,
            actorId: "desktop-user"
          })
        }
        return ownedRun(scope, run.id)
      } finally {
        if (input.kind !== "legacy-human-gate") releaseAuthorization(run.definition, auth)
      }
    }
  )
  ipc.handle(
    "project-composition:resume",
    async (event, input: Parameters<ProjectCompositionApi["resume"]>[0]) => {
      const scope = capture(event, input.scope)
      const run = ownedRun(scope, input.runId)
      if (run.version !== input.expectedVersion) throw Error("COMPOSITION_VERSION_CHANGED")
      const auth = await adopt(event, scope, run.definition)
      return authorizedBackground(run.definition, auth, () =>
        composition().resumeBackground(run.id, input.expectedVersion)
      )
    }
  )
  ipc.handle(
    "project-composition:cancel",
    async (event, input: Parameters<ProjectCompositionApi["cancel"]>[0]) => {
      const scope = capture(event, input.scope)
      const run = ownedRun(scope, input.runId)
      if (run.version !== input.expectedVersion) throw Error("COMPOSITION_VERSION_CHANGED")
      if (["succeeded", "cancelled", "failed"].includes(run.status)) return run
      const definitionKey = key(run.definition)
      cancellationAuthorizations.set(definitionKey, scope)
      try {
        const result = await composition().cancel(run.id)
        if (["succeeded", "cancelled", "failed"].includes(result.status))
          authorizations.delete(definitionKey)
        return result
      } finally {
        if (cancellationAuthorizations.get(definitionKey) === scope)
          cancellationAuthorizations.delete(definitionKey)
      }
    }
  )
  return composition
}
