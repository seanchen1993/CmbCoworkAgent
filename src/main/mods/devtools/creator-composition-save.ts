import { randomUUID } from "node:crypto"
import type { ClawProfile } from "../../../shared/mods/claw"
import type {
  DevelopmentReuseStatus,
  DevelopmentCompositionSaveStatus,
  DevelopmentTrialStatus
} from "../../../shared/mods/development"
import type { DevelopmentScope } from "../v2/development-session"
import type { CreatorCompositionHistory } from "./creator-composition-history"

export type CompositionSaveDependency = Pick<
  DevelopmentTrialStatus,
  "draftId" | "revision" | "bundleDigest"
> & {
  activeTrialCompiledDigest: string
}
export interface CompositionSaveIntent {
  id: string
  scope: DevelopmentScope
  identity: string
  name: string
  revision: number
  phase: "needs-reuse" | "needs-approval" | "saved" | "failed" | "unknown" | "cancelled"
  expected: ClawProfile | null
  dependencies: CompositionSaveDependency[]
  completed: string[]
  planId?: string
  /** Exact formal candidate returned by the original reuse preparation, not the trial wrapper. */
  nativeReuseCompiledDigest?: string
  error?: string
}
export interface CompositionReuseFacts {
  status: DevelopmentReuseStatus
  before: ClawProfile | null
  profile: ClawProfile
}
export interface CompositionSavePorts {
  trials(scope: DevelopmentScope): DevelopmentTrialStatus[]
  prepareReuse(
    threadId: string,
    dependency: CompositionSaveDependency,
    input: {
      turnId?: string
      signal: AbortSignal
      assertTurn(): void
    }
  ): Promise<DevelopmentReuseStatus>
  reuseFacts(scope: DevelopmentScope): CompositionReuseFacts | undefined
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const digest = /^[a-f0-9]{64}$/

/** Saved intent only. Installation, grants and recovery remain owned by the original reuse service. */
export class CreatorCompositionSave {
  private readonly live = new Set<string>()
  private readonly running = new Map<string, Promise<void>>()
  constructor(
    private readonly history: CreatorCompositionHistory,
    private readonly ports: CompositionSavePorts
  ) {}

  private dependencies(scope: DevelopmentScope) {
    const trials = this.ports
      .trials(scope)
      .filter(
        (trial) =>
          trial.phase !== "stopped" &&
          (trial.phase !== "failed" || trial.activeRevision !== undefined)
      )
    if (
      trials.some(
        (trial) =>
          trial.phase !== "active" ||
          (trial.activeRevision !== undefined && trial.activeRevision !== trial.revision) ||
          (trial.activeDigest !== undefined && trial.activeDigest !== trial.compiledDigest)
      )
    )
      throw Error("COMPOSITION_TRIAL_NOT_STABLE")
    return trials.map(({ draftId, revision, bundleDigest, compiledDigest }) => {
      if (!digest.test(bundleDigest) || !digest.test(compiledDigest))
        throw Error("COMPOSITION_TRIAL_NOT_STABLE")
      return { draftId, revision, bundleDigest, activeTrialCompiledDigest: compiledDigest }
    })
  }
  status(scope: DevelopmentScope): DevelopmentCompositionSaveStatus | undefined {
    const intent = this.history.saveIntent(scope)
    if (!intent) return undefined
    return {
      saved: intent.phase === "saved",
      name: intent.name,
      revision: intent.phase === "saved" ? intent.revision + 1 : intent.revision,
      phase:
        !this.live.has(intent.id) && ["needs-reuse", "needs-approval"].includes(intent.phase)
          ? "needs-review"
          : intent.phase,
      dependencies: intent.dependencies.map((item) => ({
        draftId: item.draftId,
        revision: item.revision,
        bundleDigest: item.bundleDigest,
        compiledDigest: item.activeTrialCompiledDigest
      })),
      ...(intent.error ? { error: intent.error } : {})
    }
  }
  cancel(scope: DevelopmentScope) {
    const intent = this.history.saveIntent(scope)
    if (!intent || ["saved", "cancelled"].includes(intent.phase)) return false
    this.live.delete(intent.id)
    this.history.putSaveIntent({ ...intent, phase: "cancelled" })
    return true
  }
  recordSaved(
    scope: DevelopmentScope,
    identity: string,
    name: string,
    revision: number,
    profile: ClawProfile
  ) {
    const previous = this.history.saveIntent(scope)
    if (previous) this.live.delete(previous.id)
    this.history.putSaveIntent({
      id: randomUUID(),
      scope,
      identity,
      name,
      revision,
      phase: "saved",
      expected: profile,
      dependencies: [],
      completed: []
    })
  }
  async start(input: {
    scope: DevelopmentScope
    identity: string
    name: string
    revision: number
    profile: ClawProfile | null
    turnId?: string
    signal: AbortSignal
    assertTurn(): void
  }) {
    const old = this.history.saveIntent(input.scope)
    const dependencies = this.dependencies(input.scope)
    if (
      old &&
      old.name === input.name &&
      old.revision === input.revision &&
      (["failed", "unknown"].includes(old.phase) ||
        (!this.live.has(old.id) &&
          ["needs-reuse", "needs-approval"].includes(old.phase) &&
          !dependencies.length))
    )
      throw Error("COMPOSITION_SAVE_NEEDS_REVIEW")
    if (old && this.live.has(old.id) && ["needs-reuse", "needs-approval"].includes(old.phase)) {
      if (
        old.name !== input.name ||
        old.revision !== input.revision ||
        !same(old.expected, input.profile) ||
        !same(
          old.dependencies.filter((item) => !old.completed.includes(item.draftId)),
          dependencies
        )
      )
        throw Error("COMPOSITION_SAVE_PENDING_CHANGED")
      return this.status(input.scope)
    }
    if (!dependencies.length) return undefined
    // Validate the name and expected revision before preparing an installation review.
    this.history.assertSaveAvailable(input.scope.workspace, input.name, input.revision)
    if (old) this.live.delete(old.id)
    if (this.live.size >= 64) throw Error("COMPOSITION_SAVE_CAPACITY")
    input.assertTurn()
    const intent: CompositionSaveIntent = {
      id: randomUUID(),
      scope: input.scope,
      identity: input.identity,
      name: input.name,
      revision: input.revision,
      expected: input.profile,
      dependencies,
      completed: [],
      phase: "needs-reuse"
    }
    this.history.putSaveIntent(intent)
    this.live.add(intent.id)
    await this.prepare(intent, input)
    return this.status(input.scope)
  }
  private async prepare(
    intent: CompositionSaveIntent,
    input: {
      turnId?: string
      signal: AbortSignal
      assertTurn(): void
    }
  ) {
    const dependency = intent.dependencies.find((item) => !intent.completed.includes(item.draftId))!
    try {
      const status = await this.ports.prepareReuse(intent.scope.threadId, dependency, input)
      input.assertTurn()
      if (!this.live.has(intent.id) || this.history.saveIntent(intent.scope)?.id !== intent.id)
        return
      if (
        status.draftId !== dependency.draftId ||
        status.revision !== dependency.revision ||
        status.sourceDigest !== dependency.bundleDigest ||
        !status.planId
      )
        throw Error("COMPOSITION_SAVE_REUSE_CHANGED")
      // Trial and formal preparation compile in different immutable source directories. The
      // compiler digest includes resolved source identity, so equal source bundles need not
      // yield equal product hashes. Bind each original authority's actual result separately.
      if (
        !same(
          this.dependencies(intent.scope),
          intent.dependencies.filter((item) => !intent.completed.includes(item.draftId))
        )
      )
        throw Error("COMPOSITION_SAVE_SOURCE_CHANGED")
      if (
        status.phase === "needs-approval" &&
        (!status.compiledDigest || !digest.test(status.compiledDigest))
      )
        throw Error("COMPOSITION_SAVE_REUSE_CHANGED")
      intent.planId = status.planId
      intent.nativeReuseCompiledDigest = status.compiledDigest
      intent.phase =
        status.phase === "needs-approval"
          ? "needs-approval"
          : status.phase === "unknown"
            ? "unknown"
            : "failed"
      intent.error = status.error
      this.history.putSaveIntent(intent)
      if (["failed", "unknown"].includes(intent.phase)) this.live.delete(intent.id)
    } catch (error) {
      if (!this.live.has(intent.id) || this.history.saveIntent(intent.scope)?.id !== intent.id)
        return
      intent.phase = "failed"
      intent.error =
        error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "COMPOSITION_SAVE_PREPARATION_FAILED"
      this.history.putSaveIntent(intent)
      this.live.delete(intent.id)
    }
  }
  /** Native notification observes exact completed facts; it never resumes an unknown transaction. */
  async reconcile(input: {
    scope: DevelopmentScope
    identity: string
    current(): ClawProfile | null
    validate(profile: ClawProfile): Promise<void>
    assertCurrent(): void
  }): Promise<void> {
    if (this.running.has(input.scope.threadId)) return
    const work = this.reconcileCurrent(input)
    this.running.set(input.scope.threadId, work)
    try {
      await work
    } finally {
      this.running.delete(input.scope.threadId)
    }
  }
  private async reconcileCurrent(input: Parameters<CreatorCompositionSave["reconcile"]>[0]) {
    const intent = this.history.saveIntent(input.scope)
    if (!intent || !this.live.has(intent.id) || intent.phase !== "needs-approval") return
    const guard = () => {
      input.assertCurrent()
      if (!this.live.has(intent.id) || this.history.saveIntent(input.scope)?.id !== intent.id)
        throw Error("COMPOSITION_SAVE_CANCELLED")
    }
    try {
      guard()
      if (intent.identity !== input.identity) throw Error("COMPOSITION_SAVE_TARGET_CHANGED")
      const facts = this.ports.reuseFacts(input.scope)
      if (!facts || facts.status.planId !== intent.planId)
        throw Error("COMPOSITION_SAVE_REUSE_CHANGED")
      if (["unknown", "failed"].includes(facts.status.phase)) {
        intent.phase = facts.status.phase as "unknown" | "failed"
        intent.error = facts.status.error
        this.history.putSaveIntent(intent)
        this.live.delete(intent.id)
        return
      }
      if (facts.status.phase !== "active") return
      const dependency = intent.dependencies.find(
        (item) => !intent.completed.includes(item.draftId)
      )!
      if (
        facts.status.draftId !== dependency.draftId ||
        facts.status.revision !== dependency.revision ||
        facts.status.sourceDigest !== dependency.bundleDigest ||
        !intent.nativeReuseCompiledDigest ||
        facts.status.compiledDigest !== intent.nativeReuseCompiledDigest ||
        !same(facts.before, intent.expected) ||
        !same(facts.profile, input.current())
      )
        throw Error("COMPOSITION_SAVE_TARGET_CHANGED")
      const installed = facts.profile.capabilities.find(
        (item) =>
          item.pluginId === facts.status.installationId &&
          item.digest === intent.nativeReuseCompiledDigest
      )
      if (!installed) throw Error("COMPOSITION_SAVE_REUSE_CHANGED")
      const remaining = intent.dependencies.filter(
        (item) => !intent.completed.includes(item.draftId) && item.draftId !== dependency.draftId
      )
      if (!same(remaining, this.dependencies(input.scope)))
        throw Error("COMPOSITION_SAVE_SOURCE_CHANGED")
      await input.validate(facts.profile)
      guard()
      if (!same(facts.profile, input.current())) throw Error("COMPOSITION_SAVE_TARGET_CHANGED")
      intent.expected = facts.profile
      intent.completed.push(dependency.draftId)
      if (remaining.length) {
        intent.phase = "needs-reuse"
        this.history.putSaveIntent(intent)
        await this.prepare(intent, { signal: new AbortController().signal, assertTurn: guard })
        return
      }
      this.history.save(input.scope.workspace, intent.name, intent.revision, facts.profile)
      intent.phase = "saved"
      this.history.putSaveIntent(intent)
      this.live.delete(intent.id)
    } catch (error) {
      // Explicit cancellation must not be overwritten by a late completion notification.
      if (!this.live.has(intent.id) || this.history.saveIntent(intent.scope)?.id !== intent.id)
        return
      intent.phase = "failed"
      intent.error =
        error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "COMPOSITION_SAVE_UNCONFIRMED"
      this.history.putSaveIntent(intent)
      this.live.delete(intent.id)
    }
  }
  close() {
    this.live.clear()
  }
}
