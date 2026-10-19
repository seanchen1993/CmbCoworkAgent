import { createHash, randomUUID } from "node:crypto"
import {
  clawSourceIssues,
  parseClawProfile,
  type ClawCapability,
  type ClawProfile,
  type ClawSourceEntry,
  type ClawSourceSelection
} from "../../../shared/mods/claw"
import type { SavedFlow } from "../../../shared/mods/flows/types"
import { flowDigest } from "../flows/store"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"
import type { DevelopmentCompositionStatus } from "../../../shared/mods/development"
import {
  parseClawComponentSelection,
  resolveClawComponents
} from "../../../shared/mods/claw-components"
import { isCapabilityUsageAllowed } from "../../../shared/mods/capability-usage"
import type { CapabilityContext } from "../capability-context"
import { ClawStore } from "../claw-store"
import type { DevelopmentContext } from "./development-service"
import type { DevelopmentScope } from "../v2/development-session"
import { observeDevelopmentTurnSettlement } from "../v2/development-turn-settlement"
import { claimConfigurationReload } from "../v2/configuration-reload-lease"
import { pluginCatalogGate } from "../../plugins/catalog-gate"
import { validateClawActionConfig } from "../v2/action-config"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { patchCompositionConfig } from "./composition-config-patch"
import {
  CreatorCompositionHistory,
  type CompositionHistoryToken
} from "./creator-composition-history"
import { CreatorCompositionSave, type CompositionSavePorts } from "./creator-composition-save"

export interface CompositionSelectionCatalog {
  models: Array<{ id: string; name: string }>
  skills: ClawSourceEntry[]
  mcp: ClawSourceEntry[]
  flows: SavedFlow[]
}

interface Snapshot {
  revision: number
  bindingRevision: number
  identity: string
  usage: CapabilityContext
  active: ClawProfile | null
  available: FunctionPluginStatus[]
  catalogToken: string
  resources?: CompositionSelectionCatalog
}
interface Entry {
  context: DevelopmentContext
  snapshot: Snapshot
  profile: ClawProfile | null
  turnId: string
  settled: boolean
  receipt: DevelopmentCompositionStatus
  committedBinding?: { identity: string; revision: number }
  applying?: Promise<void>
  idleWhileApplying?: boolean
  releasingLease?: boolean
  undo?: boolean
  savedName?: string
}
export interface CreatorCompositionInput {
  catalogToken: string
  name?: string
  /** Omitted/false merges with the current chat; true explicitly replaces its Mod selection. */
  replace?: boolean
  capabilities: ClawCapability[]
  removePluginIds?: string[]
  removeConfigPaths?: Array<{ pluginId: string; componentId: string; path: string }>
  models?: ClawProfile["models"] | null
  skills?: ClawSourceSelection | null
  mcp?: ClawSourceSelection | null
  builtins?: ClawProfile["builtins"]
  flow?: { id: string; revision: number; digest: string } | null
}

/** Native current-chat selection only. This service never installs, enables or grants a plugin. */
export class CreatorCompositionService {
  private readonly entries = new Map<string, Entry>()
  private readonly catalogs = new Map<
    string,
    { scope: string; snapshot: Snapshot; until: number }
  >()
  private readonly stopSettlement: () => void
  private readonly stopIdle: () => void
  private closed = false
  private readonly saves?: CreatorCompositionSave
  constructor(
    private readonly deps: {
      store: ClawStore
      history: CreatorCompositionHistory
      saveReuse?: CompositionSavePorts
      context(threadId: string): DevelopmentContext
      readContext?(threadId: string): DevelopmentContext
      assertScope(scope: DevelopmentScope): void
      assertAuthorized(scope: DevelopmentScope, profile: ClawProfile | null): void
      runtimeReady?(scope: DevelopmentScope, profile: ClawProfile | null): boolean
      identity(threadId: string): string
      usage(workspace: string, threadId: string): CapabilityContext
      available(workspace: string): Promise<FunctionPluginStatus[]>
      selectionCatalog?(workspace: string, threadId: string): Promise<CompositionSelectionCatalog>
      issues(workspace: string, profile: ClawProfile, available: FunctionPluginStatus[]): string[]
      busy(threadId: string): boolean
      onIdle(listener: (threadId: string) => void): () => void
      applySelection(
        workspace: string,
        threadId: string,
        profile: ClawProfile | null,
        commitSelection: () => void,
        assertCurrent: () => void
      ): Promise<void>
      changed(threadId: string): void
    }
  ) {
    if (deps.saveReuse) this.saves = new CreatorCompositionSave(deps.history, deps.saveReuse)
    this.stopSettlement = observeDevelopmentTurnSettlement((event) => {
      const entry = this.entries.get(event.threadId)
      if (
        !entry ||
        entry.receipt.phase !== "queued" ||
        entry.turnId !== event.turnId ||
        JSON.stringify(entry.context.scope.incarnation) !== JSON.stringify(event.incarnation)
      )
        return
      if (event.outcome !== "completed") {
        entry.receipt = { ...entry.receipt, phase: "failed", error: "COMPOSITION_TURN_INTERRUPTED" }
        this.deps.changed(event.threadId)
        return
      }
      entry.settled = true
      this.schedule(entry)
    })
    this.stopIdle = deps.onIdle((threadId) => {
      const entry = this.entries.get(threadId)
      if (!entry) return
      if (entry.applying) {
        if (entry.receipt.phase === "applying" && !entry.releasingLease)
          entry.idleWhileApplying = true
      } else this.schedule(entry)
    })
  }
  status(threadId: string): DevelopmentCompositionStatus | undefined {
    let entry = this.entries.get(threadId)
    if (!entry) {
      try {
        const context = (this.deps.readContext ?? this.deps.context)(threadId)
        const identity = this.deps.identity(threadId)
        const binding = this.deps.store.selection(context.scope.workspace, identity)
        const stored = this.deps.history.current(
          context.scope,
          identity,
          binding.revision,
          binding.profile
        )
        if (stored) {
          entry = {
            context,
            profile: stored.profile,
            turnId: "restored-selection",
            settled: true,
            snapshot: {
              identity,
              bindingRevision: binding.revision,
              revision: this.deps.store.read(context.scope.workspace).revision,
              active: binding.profile,
              available: [],
              catalogToken: "",
              usage: this.deps.usage(context.scope.workspace, threadId)
            },
            receipt: {
              phase: "active",
              name: stored.profile?.name ?? "继承已授权组合",
              pluginNames: stored.profile?.capabilities.map((item) => item.name) ?? [],
              ...(stored.savedName ? { savedName: stored.savedName } : {})
            },
            committedBinding: { identity, revision: binding.revision }
          }
          this.entries.set(threadId, entry)
        }
      } catch {
        /* History cannot restore a lost scope or any runtime/grant authority. */
      }
    }
    if (!entry) return undefined
    try {
      this.deps.assertScope(entry.context.scope)
    } catch {
      return undefined
    }
    if (entry.receipt.phase === "active") {
      try {
        const committed = entry.committedBinding
        const { workspace } = entry.context.scope
        if (!committed || committed.identity !== this.deps.identity(threadId))
          throw Error("COMPOSITION_SELECTION_CHANGED")
        const binding = this.deps.store.selection(workspace, committed.identity)
        if (
          binding.revision !== committed.revision ||
          JSON.stringify(binding.profile) !== JSON.stringify(entry.profile)
        )
          throw Error("COMPOSITION_SELECTION_CHANGED")
        this.deps.assertAuthorized(entry.context.scope, entry.profile)
      } catch (error) {
        const code =
          error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "COMPOSITION_AUTHORITY_CHANGED"
        this.failActiveReceipt(threadId, entry, code)
      }
    }
    const binding = this.deps.store.selection(
      entry.context.scope.workspace,
      this.deps.identity(threadId)
    )
    const history = this.deps.history.current(
      entry.context.scope,
      this.deps.identity(threadId),
      binding.revision,
      binding.profile
    )
    const runtimeUnconfirmed =
      entry.receipt.phase === "active" &&
      this.deps.runtimeReady?.(entry.context.scope, entry.profile) === false
    return {
      ...entry.receipt,
      ...(runtimeUnconfirmed
        ? { phase: "failed" as const, error: "COMPOSITION_RUNTIME_UNCONFIRMED" }
        : {}),
      pluginNames: [...entry.receipt.pluginNames],
      canCancel: entry.receipt.phase === "queued" && !entry.applying,
      canUndo: !entry.applying && entry.receipt.phase !== "queued" && !!history?.undo.length
    }
  }
  private failActiveReceipt(threadId: string, entry: Entry, code: string): void {
    if (this.entries.get(threadId) !== entry || entry.receipt.phase !== "active") return
    this.catalogs.delete(threadId)
    entry.receipt = { ...entry.receipt, phase: "failed", error: code }
    // The state changes before publication, so a UI re-read cannot schedule another event.
    queueMicrotask(() => {
      if (!this.closed) this.deps.changed(threadId)
    })
  }
  /** Native configuration/runtime changes refresh historical receipts without scheduling work. */
  reconcile(threadId?: string): void {
    if (threadId) {
      this.catalogs.delete(threadId)
      this.status(threadId)
    } else {
      this.catalogs.clear()
      for (const id of this.entries.keys()) this.status(id)
    }
  }
  /** Model status additionally re-inspects source bytes; the renderer's synchronous status
   * already checks current binding, enabled state, installation and committed grant rows. */
  async refreshStatus(threadId: string): Promise<DevelopmentCompositionStatus | undefined> {
    const entry = this.entries.get(threadId)
    const status = this.status(threadId)
    if (!entry || status?.phase !== "active") return status
    try {
      const [sources, resources] = await Promise.all([
        this.deps.available(entry.context.scope.workspace),
        this.deps.selectionCatalog?.(entry.context.scope.workspace, threadId)
      ])
      this.deps.assertScope(entry.context.scope)
      if (this.entries.get(threadId) !== entry) return this.status(threadId)
      if (
        (entry.profile?.capabilities ?? []).some(
          (capability) =>
            !sources.some(
              (source) =>
                source.state === "ready" &&
                source.pluginId === capability.pluginId &&
                source.name === capability.name &&
                source.digest === capability.digest
            )
        ) ||
        (entry.profile &&
          this.deps.issues(entry.context.scope.workspace, entry.profile, sources).length)
      )
        this.failActiveReceipt(threadId, entry, "COMPOSITION_SOURCE_CHANGED")
      else this.validateResources(entry.profile, resources, entry.profile)
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "COMPOSITION_STATUS_UNCONFIRMED"
      this.failActiveReceipt(threadId, entry, code)
    }
    return this.status(threadId)
  }
  private assertScope(context: DevelopmentContext): void {
    if (this.closed) throw Error("COMPOSITION_CLOSED")
    context.assertCurrent()
    const current = (this.deps.readContext ?? this.deps.context)(context.scope.threadId)
    current.assertCurrent()
    if (JSON.stringify(current.scope) !== JSON.stringify(context.scope))
      throw Error("COMPOSITION_SCOPE_CHANGED")
  }
  private async snapshot(context: DevelopmentContext): Promise<Snapshot> {
    this.assertScope(context)
    const { workspace, threadId } = context.scope
    const identity = this.deps.identity(threadId)
    const usage = this.deps.usage(workspace, threadId)
    const state = this.deps.store.read(workspace)
    const binding = this.deps.store.selection(workspace, identity)
    const [available, resources] = await Promise.all([
      this.deps.available(workspace),
      this.deps.selectionCatalog?.(workspace, threadId)
    ])
    this.assertScope(context)
    if (
      identity !== this.deps.identity(threadId) ||
      usage.identity !== this.deps.usage(workspace, threadId).identity ||
      state.revision !== this.deps.store.read(workspace).revision ||
      binding.revision !== this.deps.store.selection(workspace, identity).revision
    )
      throw Error("COMPOSITION_SOURCE_CHANGED")
    const data = {
      revision: state.revision,
      bindingRevision: binding.revision,
      identity,
      usage,
      active: binding.profile,
      available,
      ...(resources ? { resources } : {})
    }
    return {
      ...data,
      catalogToken: createHash("sha256").update(JSON.stringify(data)).digest("hex")
    }
  }
  private async directorySnapshot(context: DevelopmentContext, refresh = false): Promise<Snapshot> {
    this.assertScope(context)
    const { workspace, threadId } = context.scope
    const cached = this.catalogs.get(threadId)
    const identity = this.deps.identity(threadId)
    if (
      !refresh &&
      cached &&
      cached.until > Date.now() &&
      cached.scope === JSON.stringify(context.scope) &&
      cached.snapshot.identity === identity &&
      cached.snapshot.revision === this.deps.store.read(workspace).revision &&
      cached.snapshot.bindingRevision === this.deps.store.selection(workspace, identity).revision &&
      cached.snapshot.usage.identity === this.deps.usage(workspace, threadId).identity
    )
      return cached.snapshot
    const snapshot = await this.snapshot(context)
    if (!this.catalogs.has(threadId) && this.catalogs.size >= 32)
      this.catalogs.delete(this.catalogs.keys().next().value!)
    this.catalogs.set(threadId, {
      scope: JSON.stringify(context.scope),
      snapshot,
      until: Date.now() + 30_000
    })
    return snapshot
  }
  async catalog(threadId: string, cursor = 0, options: { query?: string; refresh?: boolean } = {}) {
    const current = this.deps.context(threadId)
    const snapshot = await this.directorySnapshot(current, options.refresh)
    const query = options.query?.trim().toLocaleLowerCase() ?? ""
    const available = snapshot.available.filter(
      (item) =>
        item.state === "ready" &&
        item.digest &&
        (!item.components?.length ||
          item.components.some((component) =>
            isCapabilityUsageAllowed(component.usage, snapshot.usage.usage)
          )) &&
        (!query ||
          [
            item.name,
            item.pluginId,
            ...(item.components ?? []).flatMap((component) => [
              component.name,
              component.description ?? ""
            ])
          ].some((text) => text.toLocaleLowerCase().includes(query)))
    )
    return {
      catalogToken: snapshot.catalogToken,
      current: snapshot.active
        ? {
            name: snapshot.active.name,
            capabilities: snapshot.active.capabilities.map((item) => ({
              pluginId: item.pluginId,
              name: item.name,
              digest: item.digest,
              ...(item.components
                ? {
                    components: {
                      mode: item.components.mode,
                      ids: item.components.ids
                    }
                  }
                : {})
            }))
          }
        : null,
      inheritsAllAuthorized: snapshot.active === null,
      total: available.length,
      ...(cursor + 12 < available.length ? { nextCursor: cursor + 12 } : {}),
      available: available.slice(cursor, cursor + 12).map((item) => ({
        pluginId: item.pluginId,
        name: item.name,
        digest: item.digest,
        components: (item.components ?? [])
          .filter((component) => isCapabilityUsageAllowed(component.usage, snapshot.usage.usage))
          .map((component) => ({
            id: component.id,
            name: component.name,
            ...(component.description ? { description: component.description } : {}),
            dependsOn: [...component.dependsOn],
            actionIds: [...component.actionIds],
            configurable: !!component.configSchema
          }))
      })),
      status: this.status(threadId),
      saved: this.deps.history.list(current.scope.workspace),
      ...(this.saves ? { save: this.saves.status(current.scope) } : {}),
      ...(snapshot.resources
        ? {
            selections: {
              models: snapshot.resources.models,
              skills: snapshot.resources.skills,
              mcp: snapshot.resources.mcp,
              flows: snapshot.resources.flows.map((flow) => ({
                id: flow.definition.id,
                name: flow.definition.name,
                revision: flow.revision,
                digest: flow.digest
              }))
            }
          }
        : {})
    }
  }
  async details(threadId: string, pluginId: string, catalogToken?: string) {
    const context = this.deps.context(threadId)
    const snapshot = await this.directorySnapshot(context)
    if (catalogToken && catalogToken !== snapshot.catalogToken) {
      this.catalogs.delete(threadId)
      throw Error("COMPOSITION_SOURCE_CHANGED")
    }
    const source = snapshot.available.find(
      (item) => item.pluginId === pluginId && item.state === "ready"
    )
    if (!source) throw Error("COMPOSITION_CAPABILITY_UNAUTHORIZED")
    return {
      catalogToken: snapshot.catalogToken,
      provider: {
        pluginId: source.pluginId,
        name: source.name,
        digest: source.digest,
        components: structuredClone(
          (source.components ?? []).filter((component) =>
            isCapabilityUsageAllowed(component.usage, snapshot.usage.usage)
          )
        )
      }
    }
  }
  async stage(
    threadId: string,
    turnId: string,
    input: CreatorCompositionInput,
    assertTurn: () => void
  ) {
    assertTurn()
    const current = this.deps.context(threadId)
    const snapshot = await this.snapshot(current)
    assertTurn()
    if (input.catalogToken !== snapshot.catalogToken) {
      this.catalogs.delete(threadId)
      throw Error("COMPOSITION_SOURCE_CHANGED")
    }
    if (this.entries.get(threadId)?.applying) throw Error("COMPOSITION_APPLYING")
    for (const [id, entry] of this.entries) {
      if (entry.applying) continue
      try {
        this.deps.assertScope(entry.context.scope)
      } catch {
        this.entries.delete(id)
      }
    }
    if (!this.entries.has(threadId) && this.entries.size >= 32) throw Error("COMPOSITION_CAPACITY")
    const oldPending = this.entries.get(threadId)
    const cumulative =
      oldPending?.receipt.phase === "queued" &&
      oldPending.turnId === turnId &&
      oldPending.snapshot.catalogToken === snapshot.catalogToken &&
      JSON.stringify(oldPending.context.scope) === JSON.stringify(current.scope)
        ? oldPending
        : undefined
    const base = cumulative ? cumulative.profile : snapshot.active
    const effectiveBaseline: ClawCapability[] =
      base?.capabilities ??
      snapshot.available
        .filter(
          (item) =>
            item.state === "ready" &&
            item.digest &&
            (!item.components?.length ||
              item.components.some((component) =>
                isCapabilityUsageAllowed(component.usage, snapshot.usage.usage)
              ))
        )
        .map((item) => ({
          pluginId: item.pluginId,
          name: item.name,
          digest: item.digest!,
          ...(item.components?.length
            ? {
                components: {
                  mode: "selected" as const,
                  ids: resolveClawComponents(item.components, undefined, snapshot.usage.usage).map(
                    (component) => component.id
                  ),
                  config: {}
                }
              }
            : {})
        }))
    const baseline = structuredClone(effectiveBaseline)
    const selected = new Map((input.replace ? [] : baseline).map((item) => [item.pluginId, item]))
    const previous = new Map(baseline.map((item) => [item.pluginId, item]))
    for (const id of input.removePluginIds ?? []) selected.delete(id)
    for (const capability of input.capabilities) {
      const stored = previous.get(capability.pluginId)
      const existing =
        stored?.name === capability.name && stored.digest === capability.digest ? stored : undefined
      const source = snapshot.available.find((item) => item.pluginId === capability.pluginId)
      const fallbackComponents =
        existing?.components ??
        (source?.components?.length
          ? {
              mode: "selected" as const,
              ids: resolveClawComponents(source.components, undefined, snapshot.usage.usage).map(
                (component) => component.id
              ),
              config: {}
            }
          : undefined)
      let components = fallbackComponents
      if (capability.components !== undefined) {
        const patch = parseClawComponentSelection(capability.components)
        // Validate the supplied selection before merging. Unknown or unselected config
        // keys are rejected, while only intentionally deselected old values are pruned.
        const retained = resolveClawComponents(
          source?.components ?? [],
          patch,
          snapshot.usage.usage
        )
        components = {
          ...patch,
          config: Object.fromEntries(
            retained.flatMap((component) => {
              const old = existing?.components?.config[component.id]
              const changes = patch.config[component.id]
              return old || changes
                ? [[component.id, patchCompositionConfig(old ?? {}, changes ?? {})]]
                : []
            })
          )
        }
      }
      selected.set(capability.pluginId, { ...capability, ...(components ? { components } : {}) })
    }
    for (const removal of input.removeConfigPaths ?? []) {
      const capability = selected.get(removal.pluginId)
      const source = snapshot.available.find((item) => item.pluginId === removal.pluginId)
      if (
        !capability?.components ||
        !resolveClawComponents(
          source?.components ?? [],
          capability.components,
          snapshot.usage.usage
        ).some((item) => item.id === removal.componentId)
      )
        throw Error("COMPOSITION_CONFIG_COMPONENT_UNSELECTED")
      const config = capability.components.config[removal.componentId]
      if (!config) throw Error("COMPOSITION_CONFIG_PATH_MISSING")
      capability.components = {
        ...capability.components,
        config: {
          ...capability.components.config,
          [removal.componentId]: patchCompositionConfig(config, {}, [removal.path])
        }
      }
    }
    const draft = {
      ...base,
      id: base?.id ?? `creator_${randomUUID().replace(/-/g, "")}`,
      name: input.name ?? base?.name ?? "当前对话组合",
      capabilities: [...selected.values()]
    }
    if (input.models === null) delete draft.models
    else if (input.models !== undefined) draft.models = {
      ...draft.models,
      ...input.models,
      roles: { ...draft.models?.roles, ...input.models.roles }
    }
    for (const key of ["skills", "mcp"] as const) {
      if (input[key] === null) delete draft[key]
      else if (input[key] !== undefined) Object.assign(draft, { [key]: input[key] })
    }
    if (input.builtins !== undefined) draft.builtins = input.builtins
    if (input.flow === null) delete draft.flow
    else if (input.flow) {
      const reference = input.flow
      const flow = snapshot.resources?.flows.find(
        (item) =>
          item.definition.id === reference.id &&
          item.revision === reference.revision &&
          item.digest === reference.digest
      )
      if (!flow) throw Error("COMPOSITION_FLOW_SOURCE_CHANGED")
      draft.flow = flow
    }
    const profile = parseClawProfile(draft)
    this.validate(current, profile, snapshot.available)
    this.validateResources(profile, snapshot.resources, snapshot.active)
    assertTurn()
    if (
      JSON.stringify(profile) === JSON.stringify(snapshot.active) &&
      this.deps.runtimeReady?.(current.scope, profile) === true
    ) {
      this.deps.assertAuthorized(current.scope, profile)
      const unchanged: Entry = {
        context: current,
        snapshot,
        profile,
        turnId,
        settled: true,
        committedBinding: { identity: snapshot.identity, revision: snapshot.bindingRevision },
        receipt: {
          phase: "active",
          name: profile.name,
          pluginNames: profile.capabilities.map((item) => item.name)
        }
      }
      this.entries.set(threadId, unchanged)
      this.deps.changed(threadId)
      return this.status(threadId)!
    }
    const entry: Entry = {
      context: current,
      snapshot,
      profile,
      turnId,
      settled: false,
      receipt: {
        phase: "queued",
        name: profile.name,
        pluginNames: profile.capabilities.map((item) => item.name)
      }
    }
    this.entries.set(threadId, entry)
    this.deps.changed(threadId)
    return this.status(threadId)
  }
  private validate(
    context: DevelopmentContext,
    profile: ClawProfile | null,
    available: FunctionPluginStatus[]
  ): void {
    this.assertScope(context)
    if (!profile) return
    for (const capability of profile.capabilities) {
      const source = available.find(
        (item) =>
          item.state === "ready" &&
          item.pluginId === capability.pluginId &&
          item.name === capability.name &&
          item.digest === capability.digest
      )
      if (!source) throw Error("COMPOSITION_CAPABILITY_UNAUTHORIZED")
      const components = resolveClawComponents(
        source.components ?? [],
        capability.components,
        this.deps.usage(context.scope.workspace, context.scope.threadId).usage
      )
      for (const component of components)
        validateClawActionConfig(
          capability.components?.config[component.id] ?? {},
          component.configSchema
        )
    }
    if (this.deps.issues(context.scope.workspace, profile, available).length)
      throw Error("COMPOSITION_SELECTION_INVALID")
    const definition = profile.flow?.definition
    if (
      definition?.schemaVersion === 1 &&
      !profile.capabilities.some((item) => item.name === definition.plugin)
    )
      throw Error("COMPOSITION_FLOW_DEPENDENCY_REQUIRED")
    for (const step of profile.flow?.definition.steps ?? []) {
      if (!step.enabled || step.kind !== "plugin-action") continue
      const capability = profile.capabilities.find(
        (item) =>
          item.pluginId === step.pluginId &&
          item.name === step.plugin &&
          item.digest === step.digest
      )
      if (!capability) throw Error("COMPOSITION_FLOW_DEPENDENCY_REQUIRED")
      const source = available.find((item) => item.pluginId === capability.pluginId)!
      if (
        source.components?.length &&
        !resolveClawComponents(
          source.components,
          capability.components,
          this.deps.usage(context.scope.workspace, context.scope.threadId).usage
        ).some((component) => component.actionIds.includes(step.actionId))
      )
        throw Error("COMPOSITION_FLOW_DEPENDENCY_REQUIRED")
    }
  }
  private validateResources(
    profile: ClawProfile | null,
    resources?: CompositionSelectionCatalog,
    before?: ClawProfile | null
  ): void {
    if (!profile) return
    if (!resources) {
      if (
        ["models", "skills", "mcp", "flow"].some(
          (key) =>
            JSON.stringify(profile[key as keyof ClawProfile]) !==
            JSON.stringify(before?.[key as keyof ClawProfile])
        )
      )
        throw Error("COMPOSITION_SELECTION_CATALOG_UNAVAILABLE")
      return
    }
    const refs = [
      profile.models?.default,
      ...Object.values(profile.models?.roles ?? {}),
      ...(profile.flow?.definition.steps.flatMap((step) =>
        step.enabled && (step.kind === "agent" || step.kind === "skill") ? [step.modelId] : []
      ) ?? [])
    ]
    if (refs.some((ref) => ref && !resources.models.some((model) => model.id === ref)))
      throw Error("COMPOSITION_MODEL_UNAVAILABLE")
    if (
      clawSourceIssues(profile.skills, resources.skills, "Skill").length ||
      clawSourceIssues(profile.mcp, resources.mcp, "MCP").length
    )
      throw Error("COMPOSITION_SOURCE_CHANGED")
    if (profile.flow && flowDigest(profile.flow.definition) !== profile.flow.digest)
      throw Error("COMPOSITION_FLOW_SOURCE_CHANGED")
    for (const step of profile.flow?.definition.steps ?? []) {
      if (!step.enabled) continue
      if (
        (step.kind === "agent" || step.kind === "skill") &&
        step.modelRole &&
        !step.modelId &&
        !profile.models?.roles[step.modelRole]
      )
        throw Error("COMPOSITION_MODEL_UNAVAILABLE")
      const reference =
        step.kind === "skill" ? step.skill : step.kind === "mcp-tool" ? step.provider : undefined
      if (!reference) continue
      const kind = step.kind === "skill" ? "skills" : "mcp"
      if (
        clawSourceIssues({ mode: "selected", items: [reference] }, resources[kind], kind).length ||
        (profile[kind]?.mode === "selected" &&
          !profile[kind]!.items.some(
            (item) =>
              item.id === reference.id &&
              item.name === reference.name &&
              item.digest === reference.digest
          ))
      )
        throw Error("COMPOSITION_FLOW_SOURCE_CHANGED")
    }
  }
  cancel(threadId: string, expectedWorkspace?: string): DevelopmentCompositionStatus {
    const context = (this.deps.readContext ?? this.deps.context)(threadId)
    this.assertScope(context)
    if (expectedWorkspace !== undefined && context.scope.workspace !== expectedWorkspace)
      throw Error("COMPOSITION_SCOPE_CHANGED")
    const entry = this.entries.get(threadId)
    if (this.saves?.cancel(context.scope)) {
      this.deps.changed(threadId)
      if (!entry || entry.applying || entry.receipt.phase !== "queued")
        return { phase: "cancelled", name: "保存组合", pluginNames: [] }
    }
    if (!entry || entry.applying || entry.receipt.phase !== "queued")
      throw Error("COMPOSITION_NOT_QUEUED")
    if (JSON.stringify(entry.context.scope) !== JSON.stringify(context.scope))
      throw Error("COMPOSITION_SCOPE_CHANGED")
    entry.receipt = { ...entry.receipt, phase: "cancelled" }
    this.deps.changed(threadId)
    return this.status(threadId)!
  }
  async undo(
    threadId: string,
    expectedWorkspace?: string,
    turn?: { turnId: string; assertTurn(): void }
  ): Promise<DevelopmentCompositionStatus> {
    turn?.assertTurn()
    const context = (turn ? this.deps.context : (this.deps.readContext ?? this.deps.context))(
      threadId
    )
    const snapshot = await this.snapshot(context)
    if (this.entries.get(threadId)?.receipt.phase === "queued")
      throw Error("COMPOSITION_CANCEL_QUEUE_FIRST")
    if (expectedWorkspace !== undefined && context.scope.workspace !== expectedWorkspace)
      throw Error("COMPOSITION_SCOPE_CHANGED")
    const record = this.deps.history.current(
      context.scope,
      snapshot.identity,
      snapshot.bindingRevision,
      snapshot.active
    )
    if (!record?.undo.length) throw Error("COMPOSITION_UNDO_STALE")
    const profile = record.undo.at(-1)!
    this.validate(context, profile, snapshot.available)
    this.validateResources(profile, snapshot.resources, snapshot.active)
    this.deps.assertAuthorized(context.scope, profile)
    turn?.assertTurn()
    return this.queueSelection(context, snapshot, profile, turn?.turnId ?? "trusted-undo", !turn, {
      undo: true,
      name: `撤销：${profile?.name ?? "继承已授权组合"}`
    })
  }
  async save(
    threadId: string,
    name: string,
    revision: number,
    catalogToken: string,
    assertTurn: () => void,
    turn?: { turnId: string; signal?: AbortSignal }
  ) {
    assertTurn()
    const context = this.deps.context(threadId),
      snapshot = await this.snapshot(context)
    if (catalogToken !== snapshot.catalogToken) throw Error("COMPOSITION_SOURCE_CHANGED")
    const pending = this.entries.get(threadId)
    if (pending?.receipt.phase === "applying") throw Error("COMPOSITION_APPLYING")
    if (this.saves) {
      if (pending?.receipt.phase === "queued" && this.deps.saveReuse?.trials(context.scope)
        .some(item => item.phase !== "stopped" && item.phase !== "failed"))
        throw Error("COMPOSITION_SAVE_WAIT_FOR_SELECTION")
      const result = await this.saves.start({
        scope: context.scope, identity: snapshot.identity, name, revision,
        profile: snapshot.active, turnId: turn?.turnId,
        signal: turn?.signal ?? new AbortController().signal, assertTurn
      })
      assertTurn()
      if (result) {
        this.deps.changed(threadId)
        return result
      }
    }
    const chosen =
      pending?.receipt.phase === "queued" &&
      JSON.stringify(pending.context.scope) === JSON.stringify(context.scope)
        ? pending.profile
        : snapshot.active
    const profile =
      chosen ??
      parseClawProfile({
        id: `saved_${randomUUID().replace(/-/g, "")}`,
        name,
        capabilities: snapshot.available
          .filter(
            (source) =>
              source.state === "ready" &&
              source.digest &&
              (!source.components?.length ||
                resolveClawComponents(source.components, undefined, snapshot.usage.usage).length)
          )
          .map((source) => ({
            pluginId: source.pluginId,
            name: source.name,
            digest: source.digest!,
            ...(source.components?.length
              ? {
                  components: {
                    mode: "selected",
                    ids: resolveClawComponents(
                      source.components,
                      undefined,
                      snapshot.usage.usage
                    ).map((component) => component.id),
                    config: {}
                  }
                }
              : {})
          }))
      })
    this.validate(context, profile, snapshot.available)
    this.validateResources(profile, snapshot.resources, snapshot.active)
    assertTurn()
    const saved = this.deps.history.save(context.scope.workspace, name, revision, profile)
    this.saves?.recordSaved(context.scope, snapshot.identity, name, revision, profile)
    this.deps.history.attachSavedName(
      context.scope,
      snapshot.identity,
      snapshot.bindingRevision,
      snapshot.active,
      name
    )
    if (pending) {
      pending.savedName = name
      pending.receipt = { ...pending.receipt, savedName: name }
    }
    this.deps.changed(threadId)
    return saved
  }
  async reconcileSavedReuse(threadId: string): Promise<void> {
    if (!this.saves || this.closed) return
    const context = (this.deps.readContext ?? this.deps.context)(threadId)
    const identity = this.deps.identity(threadId)
    await this.saves.reconcile({
      scope: context.scope, identity,
      current: () => this.deps.store.selection(context.scope.workspace, identity).profile,
      assertCurrent: () => this.assertScope(context),
      validate: async profile => {
        const snapshot = await this.snapshot(context)
        this.validate(context, profile, snapshot.available)
        this.validateResources(profile, snapshot.resources, snapshot.active)
        this.deps.assertAuthorized(context.scope, profile)
      }
    })
    this.deps.changed(threadId)
  }
  saveStatus(threadId: string) {
    if (!this.saves || this.closed) return undefined
    const context = (this.deps.readContext ?? this.deps.context)(threadId)
    this.assertScope(context)
    return this.saves.status(context.scope)
  }
  async applySaved(
    threadId: string,
    turnId: string,
    name: string,
    revision: number,
    assertTurn: () => void
  ): Promise<DevelopmentCompositionStatus> {
    assertTurn()
    const context = this.deps.context(threadId),
      snapshot = await this.snapshot(context)
    const profile = this.deps.history.load(context.scope.workspace, name, revision)
    this.validate(context, profile, snapshot.available)
    this.validateResources(profile, snapshot.resources, snapshot.active)
    this.deps.assertAuthorized(context.scope, profile)
    assertTurn()
    return this.queueSelection(context, snapshot, profile, turnId, false, { savedName: name })
  }
  private queueSelection(
    context: DevelopmentContext,
    snapshot: Snapshot,
    profile: ClawProfile | null,
    turnId: string,
    settled: boolean,
    options: { undo?: boolean; savedName?: string; name?: string } = {}
  ) {
    const old = this.entries.get(context.scope.threadId)
    if (old?.applying) throw Error("COMPOSITION_APPLYING")
    const entry: Entry = {
      context,
      snapshot,
      profile,
      turnId,
      settled,
      ...(options.undo ? { undo: true } : {}),
      ...(options.savedName ? { savedName: options.savedName } : {}),
      receipt: {
        phase: "queued",
        name: options.name ?? profile?.name ?? "继承已授权组合",
        pluginNames: profile?.capabilities.map((item) => item.name) ?? [],
        ...(options.savedName ? { savedName: options.savedName } : {})
      }
    }
    this.entries.set(context.scope.threadId, entry)
    this.deps.changed(context.scope.threadId)
    this.schedule(entry)
    return this.status(context.scope.threadId)!
  }
  private schedule(entry: Entry): void {
    const { threadId, workspace } = entry.context.scope
    if (
      this.closed ||
      entry.applying ||
      entry.receipt.phase !== "queued" ||
      !entry.settled ||
      this.deps.busy(threadId)
    )
      return
    const lease = claimConfigurationReload(threadId)
    if (!lease) return
    let releaseCatalog: () => void
    try {
      releaseCatalog = pluginCatalogGate.retain()
    } catch {
      lease.release()
      return
    }
    entry.applying = Promise.resolve().then(async () => {
      entry.receipt = { ...entry.receipt, phase: "applying" }
      this.deps.changed(threadId)
      let committed = false
      let historyToken: CompositionHistoryToken | undefined
      try {
        lease.assertLive()
        const latest = await this.snapshot(entry.context)
        lease.assertLive()
        if (latest.catalogToken !== entry.snapshot.catalogToken)
          throw Error("COMPOSITION_SOURCE_CHANGED")
        this.validate(entry.context, entry.profile, latest.available)
        this.validateResources(entry.profile, latest.resources, latest.active)
        this.assertScope(entry.context)
        const assertCurrent = () => {
          lease.assertLive()
          if (committed) this.deps.assertScope(entry.context.scope)
          else this.assertScope(entry.context)
          if (
            latest.identity !== this.deps.identity(threadId) ||
            latest.usage.identity !== this.deps.usage(workspace, threadId).identity
          )
            throw Error("COMPOSITION_SCOPE_CHANGED")
          const binding = this.deps.store.selection(workspace, latest.identity)
          if (
            committed
              ? binding.revision !== latest.revision + 1 ||
                JSON.stringify(binding.profile) !== JSON.stringify(entry.profile)
              : this.deps.store.read(workspace).revision !== latest.revision ||
                binding.revision !== latest.bindingRevision
          )
            throw Error("COMPOSITION_SOURCE_CHANGED")
        }
        // Host preflights a private candidate before this synchronous selection CAS, then
        // drains the old guest and activates the candidate without revoking trial authority.
        await this.deps.applySelection(
          workspace,
          threadId,
          entry.profile,
          () => {
            assertCurrent()
            historyToken = this.deps.history.prepare(
              entry.context.scope,
              latest.identity,
              latest.revision + 1,
              latest.active,
              entry.profile,
              entry.undo,
              entry.savedName,
              latest.bindingRevision
            )
            try {
              this.deps.store.apply(workspace, latest.identity, entry.profile, latest.revision)
            } catch (error) {
              this.deps.history.abandon(historyToken)
              historyToken = undefined
              throw error
            }
            committed = true
            entry.committedBinding = { identity: latest.identity, revision: latest.revision + 1 }
          },
          assertCurrent
        )
        assertCurrent()
        if (!historyToken) throw Error("COMPOSITION_HISTORY_UNCONFIRMED")
        this.deps.history.activate(historyToken)
        entry.receipt = { ...entry.receipt, phase: "active" }
      } catch (error) {
        const code =
          error instanceof ModFunctionError
            ? error.code
            : error instanceof Error
              ? error.message
              : ""
        entry.receipt =
          !committed && code === "MODS_CONFIG_RELOAD_BUSY"
            ? { ...entry.receipt, phase: "queued" }
            : {
                ...entry.receipt,
                phase: "failed",
                error: /^[A-Z][A-Z0-9_]+$/.test(code) ? code : "COMPOSITION_APPLY_FAILED"
              }
      } finally {
        // Lease release publishes idle in a microtask. Keep this attempt admitted until
        // its own release observers finish; a precommit BUSY must not spin on that event.
        entry.releasingLease = true
        releaseCatalog()
        lease.release()
        queueMicrotask(() => {
          entry.applying = undefined
          entry.releasingLease = false
          const idleWhileApplying = entry.idleWhileApplying
          entry.idleWhileApplying = false
          this.deps.changed(threadId)
          if (idleWhileApplying && this.entries.get(threadId) === entry) this.schedule(entry)
        })
      }
    })
  }
  close(): void {
    this.closed = true
    this.saves?.close()
    this.catalogs.clear()
    this.stopSettlement()
    this.stopIdle()
  }
}

let composition: CreatorCompositionService | undefined
export function setCreatorCompositionService(service: CreatorCompositionService | undefined): void {
  composition = service
}
export function getCreatorCompositionService(): CreatorCompositionService | undefined {
  return composition
}
