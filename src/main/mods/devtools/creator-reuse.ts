import { createHash, randomUUID } from "node:crypto"
import type { AuthoringDocument } from "../../../shared/mods/authoring"
import type { DevelopmentReuseStatus, DevelopmentDependencyImpact } from "../../../shared/mods/development"
import type {
  AuthoringInstalledReceipt,
  AuthoringPreparedInstallation,
  AuthoringInstallationOutcome
} from "../../../shared/mods/authoring-install"
import { parseClawProfile, type ClawProfile } from "../../../shared/mods/claw"
import {
  parseClawComponentExports,
  resolveClawComponents
} from "../../../shared/mods/claw-components"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"
import { isCapabilityUsageAllowed } from "../../../shared/mods/capability-usage"
import type { DevelopmentScope } from "../v2/development-session"
import { observeDevelopmentTurnSettlement } from "../v2/development-turn-settlement"
import type { ClawStore } from "../claw-store"
import type { AuthoringAtomicSettings } from "./authoring-config-snapshot"
import type { AuthoringInstallService } from "./authoring-install-service"
import type { AuthoringDraftStore } from "./authoring-store"
import type { DevelopmentContext } from "./development-service"

export interface CreatorReuseApproval {
  planId: string
  sourceDigest: string
  compiledDigest: string
  targetProfileDigest: string
}
interface Target {
  identity: string
  revision: number
  bindingRevision: number
  before: ClawProfile | null
  profile: ClawProfile
  savedBefore?: ClawProfile | null
}
interface Plan {
  schemaVersion: 1
  scope: DevelopmentScope
  status: DevelopmentReuseStatus
  formalDraftId: string
  formalRevision: number
  turnId?: string
  settled: boolean
  target?: Target
  installed?: AuthoringInstalledReceipt
  step: "review" | "stopping-trial" | "installing" | "authorizing" | "selection" | "complete"
}
interface Entry {
  plan: Plan
  context: DevelopmentContext
  prepared?: AuthoringPreparedInstallation
  approved: boolean
  applying?: Promise<void>
  idleRequested?: boolean
}
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const key = (scope: DevelopmentScope) => `mods-creator-reuse-v1:${sha(scope)}`
const phases = ["preparing", "needs-approval", "applying", "active", "failed", "unknown"]

function validDependencyImpact(value: unknown): value is DevelopmentDependencyImpact {
  if (!value || typeof value !== "object") return false
  const row = value as DevelopmentDependencyImpact
  return row.complete === false && typeof row.moreSources === "boolean" &&
    Number.isSafeInteger(row.inspectedSources) && row.inspectedSources >= 0 && row.inspectedSources <= 16 &&
    Number.isSafeInteger(row.uninspectedSources) && row.uninspectedSources >= 0 && row.uninspectedSources <= 16 &&
    Array.isArray(row.knownDependants) && row.knownDependants.length <= 16 && row.knownDependants.every(item =>
      !!item && typeof item.id === "string" && item.id.length <= 256 &&
      typeof item.name === "string" && item.name.length <= 100 &&
      ["installed", "candidate"].includes(item.kind) && Array.isArray(item.actionIds) &&
      item.actionIds.length <= 256 && item.actionIds.every(id => typeof id === "string" && id.length <= 100))
}

/** A local convenience over the existing formal installer. Stored progress is never consent. */
export class CreatorReuseService {
  private readonly entries = new Map<string, Entry>()
  private readonly observed = new Map<string, { scope: DevelopmentScope; signature: string }>()
  private readonly reconciling = new Map<string, Promise<DevelopmentReuseStatus | undefined>>()
  private readonly stopSettlement: () => void
  private readonly stopIdle: () => void
  private closed = false
  constructor(
    private readonly deps: {
      settings: AuthoringAtomicSettings
      drafts: AuthoringDraftStore
      claws: ClawStore
      install: Pick<AuthoringInstallService, "resolveInstalled" | "list" | "discardPrepared"> & {
        prepare(
          ...input: Parameters<AuthoringInstallService["prepare"]>
        ): Promise<AuthoringPreparedInstallation>
        apply(
          ...input: Parameters<AuthoringInstallService["apply"]>
        ): Promise<AuthoringInstallationOutcome>
      }
      readContext(threadId: string): DevelopmentContext
      readDraft(threadId: string, id: string): AuthoringDocument
      identity(threadId: string): string
      available(workspace: string): Promise<FunctionPluginStatus[]>
      stopTrial(scope: DevelopmentScope, id: string, guard: () => void): Promise<unknown>
      approveInstalled(
        scope: DevelopmentScope,
        receipt: AuthoringInstalledReceipt,
        guard: () => void
      ): Promise<unknown>
      applySelection(
        workspace: string,
        threadId: string,
        profile: ClawProfile,
        commit: () => void,
        guard: () => void
      ): Promise<void>
      /** Positive native proof for this exact published selection, not merely saved settings. */
      runtimeReady(scope: DevelopmentScope, profile: ClawProfile): boolean
      assertAuthorized(scope: DevelopmentScope, profile: ClawProfile): void
      busy(threadId: string): boolean
      onIdle(listener: (threadId: string) => void): () => void
      changed(threadId: string): void
    }
  ) {
    this.stopSettlement = observeDevelopmentTurnSettlement((event) => {
      const entry = this.entries.get(event.threadId)
      if (
        !entry ||
        entry.plan.turnId !== event.turnId ||
        !same(entry.plan.scope.incarnation, event.incarnation)
      )
        return
      if (event.outcome !== "completed") {
        entry.approved = false
        this.update(entry, { phase: "failed", error: "CREATOR_REUSE_TURN_INTERRUPTED" })
        return
      }
      entry.plan.settled = true
      this.persist(entry)
      this.schedule(entry)
    })
    this.stopIdle = deps.onIdle((threadId) => {
      const entry = this.entries.get(threadId)
      if (entry?.applying) entry.idleRequested = true
      else if (entry) this.schedule(entry)
    })
  }
  private read(scope: DevelopmentScope): Plan | undefined {
    const raw = this.deps.settings.getSetting(key(scope), "")
    if (!raw) return undefined
    if (Buffer.byteLength(raw) > 1024 * 1024) throw Error("CREATOR_REUSE_RECORD_INVALID")
    const plan = JSON.parse(raw) as Plan
    if (
      plan.schemaVersion !== 1 ||
      !same(plan.scope, scope) ||
      !plan.status ||
      !phases.includes(plan.status.phase) ||
      typeof plan.status.planId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(plan.status.planId) ||
      !/^[a-f0-9]{64}$/.test(plan.status.sourceDigest) ||
      !Array.isArray(plan.status.capabilities) ||
      plan.status.capabilities.length > 512 ||
      plan.status.capabilities.some((value) => typeof value !== "string") ||
      (plan.status.dependencyImpact !== undefined && !validDependencyImpact(plan.status.dependencyImpact)) ||
      !Number.isSafeInteger(plan.status.revision) ||
      plan.status.revision < 1 ||
      typeof plan.formalDraftId !== "string" ||
      !Number.isSafeInteger(plan.formalRevision) ||
      !["review", "stopping-trial", "installing", "authorizing", "selection", "complete"].includes(
        plan.step
      )
    )
      throw Error("CREATOR_REUSE_RECORD_INVALID")
    if (plan.target) {
      plan.target.profile = parseClawProfile(plan.target.profile)
      if (plan.target.before) plan.target.before = parseClawProfile(plan.target.before)
      if (plan.target.savedBefore)
        plan.target.savedBefore = parseClawProfile(plan.target.savedBefore)
      if (sha(plan.target) !== plan.status.targetProfileDigest)
        throw Error("CREATOR_REUSE_RECORD_INVALID")
    }
    return plan
  }
  status(scope: DevelopmentScope): DevelopmentReuseStatus | undefined {
    const status = this.currentStatus(scope)
    if (status) {
      const previous = this.observed.get(scope.threadId)
      this.observed.delete(scope.threadId)
      this.observed.set(scope.threadId, {
        scope,
        signature: same(previous?.scope, scope) ? previous!.signature : sha(status)
      })
      if (this.observed.size > 64) this.observed.delete(this.observed.keys().next().value!)
    }
    return status
  }
  /** Main-only graph handoff. Public status/ToolMessage data cannot establish this fact. */
  hasPendingTurnReview(context: DevelopmentContext, turnId: string): boolean {
    try {
      context.assertCurrent()
      const entry = this.entries.get(context.scope.threadId)
      if (
        this.closed ||
        !entry ||
        !same(entry.plan.scope, context.scope) ||
        entry.plan.turnId !== turnId ||
        entry.plan.settled ||
        entry.applying ||
        entry.plan.step !== "review" ||
        entry.plan.installed ||
        !entry.prepared
      )
        return false
      const { plan, prepared } = entry
      if (
        plan.status.error ||
        !(
          (plan.status.phase === "needs-approval" && !entry.approved) ||
          (plan.status.phase === "applying" && entry.approved)
        ) ||
        plan.status.sourceDigest !== prepared.sourceDigest ||
        plan.status.compiledDigest !== prepared.compiledDigest ||
        !plan.target ||
        plan.status.targetProfileDigest !== sha(plan.target)
      )
        return false
      this.assertTarget(entry)
      context.assertCurrent()
      this.guard(entry)
      return (
        this.entries.get(context.scope.threadId) === entry &&
        same(this.read(context.scope), plan) &&
        !plan.settled
      )
    } catch {
      return false
    }
  }
  /** Exact original transaction facts for completing a separately requested named save. */
  compositionFacts(scope: DevelopmentScope) {
    const plan = this.read(scope)
    const status = this.status(scope)
    if (!plan?.target || !status) return undefined
    return { status, before: structuredClone(plan.target.before),
      profile: structuredClone(plan.target.profile) }
  }
  private currentStatus(scope: DevelopmentScope): DevelopmentReuseStatus | undefined {
    const plan = this.read(scope)
    if (!plan) return undefined
    const entry = this.entries.get(scope.threadId)
    // An unstarted review can be prepared again only through a new explicit request.
    if (
      plan.step === "review" &&
      !plan.installed &&
      plan.status.phase === "needs-approval" &&
      !(
        entry &&
        !this.closed &&
        same(entry.plan.scope, scope) &&
        entry.plan.status.planId === plan.status.planId &&
        entry.prepared &&
        entry.prepared.sourceDigest === plan.status.sourceDigest &&
        entry.prepared.compiledDigest === plan.status.compiledDigest
      )
    )
      return { ...plan.status, phase: "failed", error: "CREATOR_REUSE_PREPARE_REQUIRED" }
    // A restart keeps observations and exact identities, never the old approval callback.
    if (
      ["preparing", "applying"].includes(plan.status.phase) &&
      entry?.plan.status.planId !== plan.status.planId
    )
      return { ...plan.status, phase: "unknown", error: "CREATOR_REUSE_RESTART_UNCONFIRMED" }
    if (
      plan.status.phase === "active" &&
      plan.target &&
      (this.deps.identity(scope.threadId) !== plan.target.identity ||
        !same(
          this.deps.claws.selection(scope.workspace, plan.target.identity).profile,
          plan.target.profile
        ))
    )
      return { ...plan.status, phase: "failed", error: "CREATOR_REUSE_SELECTION_CHANGED" }
    if (plan.status.phase === "active" && plan.target) {
      try {
        this.deps.assertAuthorized(scope, plan.target.profile)
      } catch (error) {
        return { ...plan.status, phase: "failed", error: this.errorCode(error) }
      }
      if (!this.deps.runtimeReady(scope, plan.target.profile))
        return { ...plan.status, phase: "unknown", error: "CREATOR_REUSE_RUNTIME_UNCONFIRMED" }
    }
    return structuredClone(plan.status)
  }
  /** Refresh receipts after enable, installation, or grant changes without replaying writes. */
  reconcileAuthorizations(threadId?: string): void {
    if (this.closed) return
    for (const [id, previous] of this.observed) {
      if (threadId && threadId !== id) continue
      try {
        const context = this.deps.readContext(id)
        context.assertCurrent()
        if (!same(context.scope, previous.scope)) continue
        const signature = sha(this.currentStatus(context.scope))
        if (signature !== previous.signature) {
          this.observed.set(id, { scope: context.scope, signature })
          this.deps.changed(id)
        }
      } catch {
        // A removed or replaced conversation cannot receive an old receipt.
      }
    }
  }
  /** Read existing installation/grant/selection facts only. Never resumes interrupted writes. */
  async reconcile(context: DevelopmentContext): Promise<DevelopmentReuseStatus | undefined> {
    context.assertCurrent()
    const scopedKey = key(context.scope)
    const previous = this.reconciling.get(scopedKey)
    if (previous) {
      await previous
      context.assertCurrent()
      return this.status(context.scope)
    }
    if (this.reconciling.size >= 2) throw Error("CREATOR_REUSE_BUSY")
    const work = this.reconcileFacts(context)
    this.reconciling.set(scopedKey, work)
    try {
      return await work
    } finally {
      if (this.reconciling.get(scopedKey) === work) this.reconciling.delete(scopedKey)
    }
  }
  private async reconcileFacts(
    context: DevelopmentContext
  ): Promise<DevelopmentReuseStatus | undefined> {
    context.assertCurrent()
    const plan = this.read(context.scope)
    if (!plan || !plan.target || this.entries.get(context.scope.threadId)?.applying)
      return this.status(context.scope)
    const entry: Entry = { context, plan, approved: false }
    // An observation of a previously installed revision does not admit or authorize the
    // current draft. It must remain readable after authoring mode ends or that draft changes.
    const guard = () => {
      if (this.closed) throw Error("CREATOR_REUSE_CLOSED")
      context.assertCurrent()
      const current = this.deps.readContext(context.scope.threadId)
      current.assertCurrent()
      if (!same(current.scope, context.scope)) throw Error("CREATOR_REUSE_SCOPE_CHANGED")
      if (this.read(context.scope)?.status.planId !== plan.status.planId)
        throw Error("CREATOR_REUSE_PLAN_CHANGED")
      if (this.entries.get(context.scope.threadId)?.applying) throw Error("CREATOR_REUSE_BUSY")
    }
    guard()
    const installed = await this.deps.install.resolveInstalled(
      {
        draftId: plan.formalDraftId,
        revision: plan.formalRevision,
        sourceDigest: plan.status.sourceDigest
      },
      {
        workspace: context.scope.workspace,
        signal: new AbortController().signal,
        assertCurrent: guard
      }
    )
    guard()
    const available = await this.deps.available(context.scope.workspace)
    guard()
    const target = plan.target
    const capability = target.profile.capabilities.find(
      (item) => item.pluginId === installed?.installationId
    )
    if (
      installed &&
      capability?.name === installed.name &&
      capability.digest === installed.compiledDigest &&
      installed.sourceDigest === plan.status.sourceDigest &&
      installed.compiledDigest === plan.status.compiledDigest &&
      this.deps.identity(context.scope.threadId) === target.identity &&
      available.some(
        (item) =>
          item.state === "ready" &&
          item.pluginId === installed.installationId &&
          item.name === installed.name &&
          item.digest === installed.compiledDigest
      ) &&
      this.deps.runtimeReady(context.scope, target.profile) &&
      same(
        this.deps.claws.selection(context.scope.workspace, target.identity).profile,
        target.profile
      ) &&
      this.deps.claws
        .read(context.scope.workspace)
        .profiles.some((item) => same(item, target.profile))
    ) {
      if (
        plan.step === "complete" &&
        plan.status.phase === "active" &&
        same(plan.installed, installed) &&
        plan.status.installationId === installed.installationId &&
        plan.status.savedProfileId === target.profile.id &&
        plan.status.error === undefined
      )
        return this.status(context.scope)
      entry.plan.installed = installed
      entry.plan.step = "complete"
      const previous = this.entries.get(context.scope.threadId)
      if (previous?.prepared) await this.deps.install.discardPrepared(previous.prepared.handle)
      guard()
      this.entries.delete(context.scope.threadId)
      this.update(entry, {
        phase: "active",
        installationId: installed.installationId,
        savedProfileId: target.profile.id,
        error: undefined
      })
    }
    return this.status(context.scope)
  }
  private guard(entry: Entry): void {
    if (this.closed) throw Error("CREATOR_REUSE_CLOSED")
    entry.context.assertCurrent()
    const current = this.deps.readContext(entry.plan.scope.threadId)
    current.assertCurrent()
    if (!same(current.scope, entry.plan.scope)) throw Error("CREATOR_REUSE_SCOPE_CHANGED")
    const document = this.deps.readDraft(entry.plan.scope.threadId, entry.plan.status.draftId)
    if (
      document.revision !== entry.plan.status.revision ||
      document.source.digest !== entry.plan.status.sourceDigest
    )
      throw Error("CREATOR_REUSE_SOURCE_CHANGED")
  }
  private persist(entry: Entry): void {
    entry.context.assertCurrent()
    const storageKey = key(entry.plan.scope)
    const absent = "\0creator-reuse-absent"
    const before = this.deps.settings.getSetting(storageKey, absent)
    const stored = before === absent ? undefined : (JSON.parse(before) as Plan)
    if (
      stored &&
      stored.status.planId !== entry.plan.status.planId &&
      this.entries.get(entry.plan.scope.threadId) !== entry
    )
      throw Error("CREATOR_REUSE_PLAN_CHANGED")
    const encoded = JSON.stringify(entry.plan)
    if (
      Buffer.byteLength(encoded) > 1024 * 1024 ||
      !this.deps.settings.compareAndSetSetting(
        storageKey,
        before === absent ? undefined : before,
        encoded
      )
    )
      throw Error("CREATOR_REUSE_PLAN_CHANGED")
    this.deps.changed(entry.plan.scope.threadId)
  }
  private update(entry: Entry, status: Partial<DevelopmentReuseStatus>): void {
    entry.plan.status = { ...entry.plan.status, ...status }
    this.persist(entry)
  }
  private assertTarget(entry: Entry, applied = false): void {
    this.guard(entry)
    const { scope, target } = entry.plan
    if (!target || this.deps.identity(scope.threadId) !== target.identity)
      throw Error("CREATOR_REUSE_TARGET_CHANGED")
    const binding = this.deps.claws.selection(scope.workspace, target.identity)
    if (
      applied
        ? !same(binding.profile, target.profile)
        : binding.revision !== target.bindingRevision || !same(binding.profile, target.before)
    )
      throw Error("CREATOR_REUSE_TARGET_CHANGED")
    if (
      !applied &&
      !same(
        this.deps.claws
          .read(scope.workspace)
          .profiles.find((item) => item.id === target.profile.id) ?? null,
        target.savedBefore ?? null
      )
    )
      throw Error("CREATOR_REUSE_TARGET_CHANGED")
  }
  async request(
    context: DevelopmentContext,
    document: AuthoringDocument,
    input: {
      turnId?: string
      signal: AbortSignal
      assertTurn(): void
      dependencyImpact?: DevelopmentDependencyImpact
    }
  ): Promise<void> {
    context.assertCurrent()
    input.assertTurn()
    if (input.dependencyImpact !== undefined && !validDependencyImpact(input.dependencyImpact))
      throw Error("CREATOR_REUSE_RECORD_INVALID")
    const { scope } = context
    if (this.closed || this.entries.get(scope.threadId)?.applying) throw Error("CREATOR_REUSE_BUSY")
    if (!this.entries.has(scope.threadId) && this.entries.size >= 32) {
      const finished = [...this.entries].find(
        ([, item]) =>
          !item.applying && ["active", "failed", "unknown"].includes(item.plan.status.phase)
      )
      if (!finished) throw Error("CREATOR_REUSE_CAPACITY")
      const [id, item] = finished
      item.approved = false
      if (item.prepared) await this.deps.install.discardPrepared(item.prepared.handle)
      this.entries.delete(id)
      context.assertCurrent()
      input.assertTurn()
    }
    const previous = this.read(scope)
    if (
      previous?.status.phase === "active" &&
      previous.status.draftId === document.id &&
      previous.status.revision === document.revision &&
      previous.status.sourceDigest === document.source.digest &&
      this.status(scope)?.phase === "active"
    )
      return
    const old = this.entries.get(scope.threadId)
    if (old?.prepared) {
      await this.deps.install.discardPrepared(old.prepared.handle)
      old.prepared = undefined
      old.approved = false
      this.update(old, { phase: "failed", error: "CREATOR_REUSE_PLAN_REPLACED" })
    }
    input.assertTurn()
    const formalDraftId = `reuse-${sha([scope, document.id]).slice(0, 48)}`
    const formal = this.deps.drafts.list(scope.workspace).find((item) => item.id === formalDraftId)
    const saved =
      formal?.versions.at(-1)?.source.digest === document.source.digest
        ? formal
        : this.deps.drafts.save({
            workspace: scope.workspace,
            id: formalDraftId,
            name: document.name,
            expectedRevision: formal?.currentRevision ?? 0,
            source: document.source,
            assertCurrent: () => {
              context.assertCurrent()
              input.assertTurn()
            }
          })
    const entry: Entry = {
      context,
      approved: false,
      plan: {
        schemaVersion: 1,
        scope,
        formalDraftId,
        formalRevision: saved.currentRevision,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        settled: !input.turnId,
        step: "review",
        status: {
          planId: randomUUID(),
          phase: "preparing",
          name: document.name,
          draftId: document.id,
          revision: document.revision,
          sourceDigest: document.source.digest,
          ...(input.dependencyImpact ? { dependencyImpact: structuredClone(input.dependencyImpact) } : {}),
          capabilities: []
        }
      }
    }
    this.entries.set(scope.threadId, entry)
    this.persist(entry)
    const controller = new AbortController()
    const abort = () => controller.abort(input.signal.reason)
    input.signal.addEventListener("abort", abort, { once: true })
    let preparing = true
    const guard = () => {
      this.guard(entry)
      if (preparing) {
        input.signal.throwIfAborted()
        input.assertTurn()
      }
    }
    const binding = { workspace: scope.workspace, signal: controller.signal, assertCurrent: guard }
    try {
      guard()
      // Existing installer journal is the only installation journal and recovery authority.
      const installations = this.deps.install.list(binding)
      if (
        installations.installations.some(
          (item) =>
            item.name ===
              JSON.parse(document.source.files.find((file) => file.path === "plugin.json")!.text)
                .name && item.pending
        )
      )
        throw Error("CREATOR_REUSE_INSTALL_UNCONFIRMED")
      const prepared = await this.deps.install.prepare(
        {
          draftId: formalDraftId,
          revision: saved.currentRevision,
          sourceDigest: document.source.digest
        },
        binding
      )
      entry.prepared = prepared
      guard()
      const state = this.deps.claws.read(scope.workspace)
      const identity = this.deps.identity(scope.threadId)
      const selection = this.deps.claws.selection(scope.workspace, identity)
      const available = await this.deps.available(scope.workspace)
      guard()
      if (
        state.revision !== this.deps.claws.read(scope.workspace).revision ||
        selection.revision !== this.deps.claws.selection(scope.workspace, identity).revision
      )
        throw Error("CREATOR_REUSE_TARGET_CHANGED")
      const definition = JSON.parse(
        document.source.files.find((file) => file.path === "mods/manifest.json")!.text
      )
      const components = parseClawComponentExports(definition.claw)
      const ids = components.length
        ? resolveClawComponents(components, undefined, "chat").map((item) => item.id)
        : []
      if (components.length && !ids.length) throw Error("CREATOR_REUSE_USAGE_UNAVAILABLE")
      const base = selection.profile
      const preserved =
        base?.capabilities ??
        available
          .filter(
            (item) =>
              item.state === "ready" &&
              item.digest &&
              (!item.components?.length ||
                item.components.some((component) =>
                  isCapabilityUsageAllowed(component.usage, "chat")
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
                    ids: resolveClawComponents(item.components, undefined, "chat").map(
                      (component) => component.id
                    ),
                    config: {}
                  }
                }
              : {})
          }))
      const existing = preserved.find((item) => item.pluginId === prepared.installationId)
      const profile = parseClawProfile({
        ...base,
        id: `reuse_${sha([scope, document.id]).slice(0, 32)}`,
        name: `${document.name.slice(0, 70)} · 复用`,
        capabilities: [
          ...preserved.filter((item) => item.pluginId !== prepared.installationId),
          {
            pluginId: prepared.installationId,
            name: prepared.name,
            digest: prepared.compiledDigest,
            ...(components.length
              ? { components: existing?.components ?? { mode: "selected", ids, config: {} } }
              : {})
          }
        ]
      })
      entry.plan.target = {
        identity,
        revision: state.revision,
        bindingRevision: selection.revision,
        before: selection.profile,
        profile,
        savedBefore: state.profiles.find((item) => item.id === profile.id) ?? null
      }
      preparing = false
      const events =
        (prepared.review as typeof prepared.review & { registrationEvents?: string[] })
          ?.registrationEvents ?? []
      this.update(entry, {
        phase: "needs-approval",
        compiledDigest: prepared.compiledDigest,
        capabilities: [
          ...new Set([
            ...(prepared.review?.sdkMethods ?? []),
            ...events.map((event) => `event:${event}`)
          ])
        ].sort(),
        targetProfileDigest: sha(entry.plan.target),
        error: undefined
      })
    } catch (error) {
      if (entry.prepared)
        await this.deps.install.discardPrepared(entry.prepared.handle).catch(() => {})
      entry.prepared = undefined
      this.update(entry, { phase: "failed", error: this.errorCode(error) })
      throw error
    } finally {
      preparing = false
      input.signal.removeEventListener("abort", abort)
    }
  }
  async approve(context: DevelopmentContext, input: CreatorReuseApproval): Promise<void> {
    context.assertCurrent()
    const stored = this.read(context.scope)
    if (
      !stored ||
      stored.status.planId !== input.planId ||
      stored.status.sourceDigest !== input.sourceDigest ||
      stored.status.compiledDigest !== input.compiledDigest ||
      stored.status.targetProfileDigest !== input.targetProfileDigest
    )
      throw Error("CREATOR_REUSE_APPROVAL_CHANGED")
    if (stored.status.phase === "active") return
    const entry = this.entries.get(context.scope.threadId)
    // Lost preparation handles and interrupted install transactions require a new read-only plan.
    if (
      !entry ||
      entry.plan.status.planId !== input.planId ||
      !["needs-approval", "applying"].includes(entry.plan.status.phase)
    )
      throw Error("CREATOR_REUSE_PREPARE_REQUIRED")
    if (entry.applying) return
    if (!entry.prepared && !entry.plan.installed) throw Error("CREATOR_REUSE_PREPARE_REQUIRED")
    this.assertTarget(entry)
    entry.context = context
    entry.approved = true
    this.update(entry, { phase: "applying", error: undefined })
    this.schedule(entry)
  }
  private schedule(entry: Entry): void {
    if (
      this.closed ||
      !entry.approved ||
      !entry.plan.settled ||
      entry.applying ||
      entry.plan.status.phase !== "applying" ||
      this.deps.busy(entry.plan.scope.threadId)
    )
      return
    entry.applying = Promise.resolve()
      .then(() => this.apply(entry))
      .catch(() => {
        // A deleted/recreated scope cannot receive a late receipt. It still must not leave
        // a rejected background promise or revive any of this old plan's authority.
        entry.approved = false
      })
      .finally(() => {
        entry.applying = undefined
        if (entry.idleRequested) {
          entry.idleRequested = false
          queueMicrotask(() => {
            try {
              this.schedule(entry)
            } catch {
              entry.approved = false
            }
          })
        }
      })
  }
  private async apply(entry: Entry): Promise<void> {
    const { scope, target } = entry.plan
    const guard = () => {
      this.assertTarget(entry)
      if (!entry.approved) throw Error("CREATOR_REUSE_APPROVAL_CHANGED")
    }
    const admit = () => {
      guard()
      if (this.deps.busy(scope.threadId)) throw Error("CREATOR_REUSE_BUSY")
    }
    let effects = !!entry.plan.installed
    let committed = false
    try {
      admit()
      const prepared = entry.prepared
      if ((!prepared && !entry.plan.installed) || !target)
        throw Error("CREATOR_REUSE_PREPARE_REQUIRED")
      if (!entry.plan.installed) {
        entry.plan.step = "stopping-trial"
        this.persist(entry)
        effects = true
        await this.deps.stopTrial(scope, entry.plan.status.draftId, guard)
        admit()
        entry.plan.step = "installing"
        this.persist(entry)
      }
      const binding = {
        workspace: scope.workspace,
        signal: new AbortController().signal,
        assertCurrent: guard
      }
      let installed = await this.deps.install.resolveInstalled(
        {
          draftId: entry.plan.formalDraftId,
          revision: entry.plan.formalRevision,
          sourceDigest: entry.plan.status.sourceDigest
        },
        binding
      )
      const expected = entry.plan.installed ?? prepared!
      if (
        installed &&
        (installed.installationId !== expected.installationId ||
          installed.name !== expected.name ||
          installed.sourceDigest !== expected.sourceDigest ||
          installed.compiledDigest !== expected.compiledDigest)
      )
        throw Error("CREATOR_REUSE_INSTALL_CHANGED")
      if (!installed) {
        if (entry.plan.installed || !prepared) throw Error("CREATOR_REUSE_INSTALL_CHANGED")
        const outcome = await this.deps.install.apply(
          { handle: prepared.handle, expectedCatalogDigest: prepared.catalogDigest },
          binding
        )
        if (
          outcome.state !== "settled" ||
          outcome.installationId !== prepared.installationId ||
          outcome.versionId !== prepared.versionId
        )
          throw Error("CREATOR_REUSE_INSTALL_UNCONFIRMED")
        installed = {
          installationId: prepared.installationId,
          versionId: prepared.versionId,
          name: prepared.name,
          sourceDigest: prepared.sourceDigest,
          compiledDigest: prepared.compiledDigest
        }
      } else if (prepared) await this.deps.install.discardPrepared(prepared.handle)
      entry.prepared = undefined
      entry.plan.installed = installed
      entry.plan.step = "authorizing"
      this.persist(entry)
      admit()
      const authorized = (available: FunctionPluginStatus[]) =>
        available.some(
          (item) =>
            item.state === "ready" &&
            item.pluginId === installed.installationId &&
            item.name === installed.name &&
            item.digest === installed.compiledDigest
        )
      if (!authorized(await this.deps.available(scope.workspace))) {
        admit()
        await this.deps.approveInstalled(scope, installed, guard)
        admit()
        if (!authorized(await this.deps.available(scope.workspace)))
          throw Error("CREATOR_REUSE_AUTHORIZATION_UNCONFIRMED")
      }
      admit()
      this.deps.assertAuthorized(scope, target.profile)
      if (!entry.approved) throw Error("CREATOR_REUSE_AUTHORIZATION_UNCONFIRMED")
      entry.plan.step = "selection"
      this.persist(entry)
      const assertSelection = () => this.assertTarget(entry, committed)
      await this.deps.applySelection(
        scope.workspace,
        scope.threadId,
        target.profile,
        () => {
          this.assertTarget(entry)
          const current = this.deps.claws.read(scope.workspace)
          const saved = current.profiles.find((profile) => profile.id === target.profile.id)
          let revision = current.revision
          if (!same(saved, target.profile)) {
            this.deps.claws.write(
              scope.workspace,
              {
                ...current,
                profiles: [
                  ...current.profiles.filter((profile) => profile.id !== target.profile.id),
                  target.profile
                ]
              },
              revision
            )
            revision++
          }
          this.deps.claws.apply(scope.workspace, target.identity, target.profile, revision)
          committed = true
        },
        assertSelection
      )
      assertSelection()
      entry.plan.step = "complete"
      this.update(entry, {
        phase: "active",
        installationId: installed.installationId,
        savedProfileId: target.profile.id,
        error: undefined
      })
    } catch (error) {
      const code = this.errorCode(error)
      if (
        !committed &&
        ["PLUGIN_CATALOG_BUSY", "CREATOR_REUSE_BUSY", "MODS_CONFIG_RELOAD_BUSY"].includes(code)
      ) {
        // Admission/drain can defer any uncommitted step. Verified install/grant facts above
        // prevent repeated writes when an exact approved candidate resumes at physical idle.
        this.update(entry, { phase: "applying", error: undefined })
        return
      }
      entry.approved = false
      this.update(entry, { phase: effects ? "unknown" : "failed", error: code })
    }
  }
  private errorCode(error: unknown): string {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : error instanceof Error
          ? error.message
          : ""
    return /^[A-Z][A-Z0-9_]+$/.test(code) ? code : "CREATOR_REUSE_FAILED"
  }
  close(): void {
    this.closed = true
    this.stopSettlement()
    this.stopIdle()
    for (const entry of this.entries.values()) {
      entry.approved = false
      if (entry.prepared && !entry.applying)
        void this.deps.install.discardPrepared(entry.prepared.handle).catch(() => {})
    }
  }
}
