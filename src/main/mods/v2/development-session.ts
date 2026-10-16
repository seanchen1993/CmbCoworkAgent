import { observeDevelopmentTurnSettlement } from "./development-turn-settlement"
import { randomUUID } from "node:crypto"
import type { ThreadIncarnation } from "../../services/thread-incarnation"
import { pluginCatalogGate } from "../../plugins/catalog-gate"
import { claimConfigurationReload } from "./configuration-reload-lease"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type {
  DevelopmentWaitingReason,
  DevelopmentValidation,
  DevelopmentRuntimeDiagnostics
} from "../../../shared/mods/development"
import { FUNCTION_SDK_METHODS } from "./sdk-capabilities"
import {
  FUNCTION_COMPATIBILITY_EVENT_NAMES,
  getFunctionEventSupport
} from "../../../shared/mods/v2/compatibility-catalog"

const publicPreparationCodes = new Set([
  "MODS_COMMAND_CONFLICT",
  "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED",
  "MODS_DEVELOPMENT_BUSY",
  "MODS_DEVELOPMENT_SOURCE_CHANGED",
  "MODS_DEVELOPMENT_REVOKED",
  "MODS_DEVELOPMENT_CAPABILITY_DENIED",
  "MODS_SCOPE_CHANGED",
  "MODS_RUNTIME_LOST",
  "MODS_RETURN_UNDEFINED",
  "MODS_SESSION_START_RESULT",
  "MODS_COMMAND_RESERVED"
])
function preparationErrorCode(error: unknown): string | undefined {
  const code =
    error instanceof ModFunctionError ? error.code : error instanceof Error ? error.message : undefined
  return code && publicPreparationCodes.has(code) ? code : undefined
}

/** These are actual host-enforced capabilities, not claims inferred from source scanning. */
export const DEVELOPMENT_EVENT_CAPABILITIES = Object.freeze([
  "event:ui.render",
  "event:tool.call",
  "event:command.run",
  "event:session.start",
  "event:turn.complete"
])
export const DEVELOPMENT_CAPABILITIES = Object.freeze([
  "ui.open",
  "ui.close",
  "ui.panes",
  "ui.resolve",
  "ui.invalidate",
  "ui.log",
  "ui.status",
  "ui.toast",
  "store.get",
  "store.set",
  "store.keys",
  "store.delete",
  "session.usage",
  "session.version",
  "clock.time",
  "clock.now",
  "command.register",
  "command.list",
  ...DEVELOPMENT_EVENT_CAPABILITIES
])
/** Real trial consent adds SDK admission, while every existing method/target guard still applies. */
export const DEVELOPMENT_REAL_CAPABILITIES: readonly string[] = Object.freeze([
  ...new Set([
    ...DEVELOPMENT_CAPABILITIES,
    ...FUNCTION_SDK_METHODS,
    ...FUNCTION_COMPATIBILITY_EVENT_NAMES
      .filter((name) => getFunctionEventSupport(name)?.availability === "bounded")
      .map((name) => `event:${name}`)
  ])
])
export function developmentCapabilities(validation?: DevelopmentValidation): readonly string[] {
  return validation === "authorized-real"
    ? DEVELOPMENT_REAL_CAPABILITIES
    : DEVELOPMENT_CAPABILITIES
}
export interface DevelopmentScope {
  workspace: string
  threadId: string
  incarnation: ThreadIncarnation
}
export interface DevelopmentRevision {
  componentId: string
  draftId: string
  revision: number
  bundleDigest: string
  compiledDigest: string
  sourcePath: string
  turnId: string
  capabilities: readonly string[]
  validation?: DevelopmentValidation
  purpose?: string
}
export type DevelopmentPhase =
  | "needs-approval"
  | "queued"
  | "preflight"
  | "retiring"
  | "active"
  | "stopped"
  | "failed"
  | "unknown"
export interface DevelopmentStatus extends Omit<
  DevelopmentRevision,
  "sourcePath" | "capabilities"
> {
  capabilities: string[]
  phase: DevelopmentPhase
  activeRevision?: number
  activeDigest?: string
  waitingReason?: DevelopmentWaitingReason
  error?: string
  addedCapabilities?: string[]
  diagnostics?: DevelopmentRuntimeDiagnostics
}
export interface DevelopmentActivation {
  readonly id: string
  readonly scope: Readonly<DevelopmentScope>
  readonly revision: Readonly<DevelopmentRevision>
  assertCurrent(): void
  assertCapability(method: string): void
  assertCapabilities(methods: readonly string[]): void
}
export interface DevelopmentCandidate {
  /** No candidate registration or evaluation may perform externally visible effects. */
  dispose(): Promise<void>
}
export interface DevelopmentDriver {
  assertScope(scope: DevelopmentScope): void
  assertReadableScope?(scope: DevelopmentScope): void
  isBusy?(scope: DevelopmentScope): boolean
  run?(scope: DevelopmentScope, work: () => Promise<void>): Promise<void>
  prepare(activation: DevelopmentActivation): Promise<DevelopmentCandidate>
  /** Must freeze new admission and actually drain the old generation before resolving. */
  retire(scope: DevelopmentScope, beforeEffects: () => void, waitForIdle?: boolean): Promise<void>
  /** Synchronous compare-and-swap. The candidate cannot enter before this returns. */
  activate(activation: DevelopmentActivation, candidate: DevelopmentCandidate): void
  changed(scope: DevelopmentScope, status: DevelopmentStatus): void
  diagnostics?(scope: DevelopmentScope, activationId: string): DevelopmentRuntimeDiagnostics | undefined
}
export interface DevelopmentRetention {
  releasable: boolean
  /** null retains every prepared version until actual cleanup is confirmed. */
  revisions: readonly number[] | null
  reason?: "active" | "pending" | "draining" | "unknown"
}
interface Entry {
  scope: DevelopmentScope
  pending: DevelopmentRevision
  approved: Set<string>
  epoch: number
  phase: DevelopmentPhase
  guard(): void
  active?: DevelopmentActivation
  applying?: Promise<void>
  closing?: Promise<void>
  idleRequested?: boolean
  error?: string
}
function key(scope: DevelopmentScope): string {
  return JSON.stringify([
    scope.workspace,
    scope.threadId,
    scope.incarnation.token,
    scope.incarnation.token === null ? scope.incarnation.legacyCreatedAt : null
  ])
}
function reject(code: string): never {
  throw new Error(code)
}
function copyScope(scope: DevelopmentScope): DevelopmentScope {
  if (
    !scope.workspace ||
    !scope.threadId ||
    !scope.incarnation ||
    !Number.isFinite(scope.incarnation.legacyCreatedAt) ||
    (scope.incarnation.token !== null && typeof scope.incarnation.token !== "string")
  )
    reject("MODS_DEVELOPMENT_SCOPE_INVALID")
  return Object.freeze({
    workspace: scope.workspace,
    threadId: scope.threadId,
    incarnation: Object.freeze({ ...scope.incarnation })
  })
}
function copyRevision(input: DevelopmentRevision): DevelopmentRevision {
  const allowed = developmentCapabilities(input.validation)
  if (
    !input.componentId ||
    !input.draftId ||
    !input.sourcePath ||
    !input.turnId ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    !/^[a-f0-9]{64}$/.test(input.bundleDigest) ||
    !/^[a-f0-9]{64}$/.test(input.compiledDigest) ||
    !Array.isArray(input.capabilities) ||
    (input.validation !== undefined &&
      !["session-local", "authorized-real"].includes(input.validation)) ||
    (input.purpose !== undefined &&
      (typeof input.purpose !== "string" || input.purpose.length > 400 || input.purpose.includes("\0"))) ||
    input.capabilities.length > allowed.length ||
    input.capabilities.some((value) => !allowed.includes(value))
  )
    reject("MODS_DEVELOPMENT_CAPABILITY_UNSUPPORTED")
  return Object.freeze({ ...input, capabilities: Object.freeze([...new Set(input.capabilities)]) })
}

/** Session-local authorization. No record here is a formal plugin grant or restart authority. */
export class FunctionDevelopmentSessions {
  private readonly entries = new Map<string, Entry>()
  private readonly settled = new Map<string, Set<string>>()
  private readonly interrupted = new Map<string, Set<string>>()
  private closed = false
  private readonly stopSettlement: () => void
  constructor(private readonly driver: DevelopmentDriver) {
    this.stopSettlement = observeDevelopmentTurnSettlement((event) => {
      for (const entry of this.entries.values()) {
        const expected = entry.scope.incarnation
        if (
          entry.scope.threadId !== event.threadId ||
          expected.token !== event.incarnation.token ||
          (expected.token === null &&
            expected.legacyCreatedAt !== event.incarnation.legacyCreatedAt)
        )
          continue
        this.noteSettled(entry.scope, event.turnId, event.outcome)
      }
    })
  }

  stage(scopeInput: DevelopmentScope, input: DevelopmentRevision, assertCurrent: () => void) {
    const scope = copyScope(scopeInput),
      revision = copyRevision(input)
    assertCurrent()
    this.driver.assertScope(scope)
    if (this.closed) reject("MODS_DEVELOPMENT_CLOSED")
    for (const [storedKey, candidate] of this.entries) {
      if (this.retention(candidate.scope)?.releasable) {
        this.entries.delete(storedKey)
        this.settled.delete(storedKey)
        this.interrupted.delete(storedKey)
      }
    }
    const identity = key(scope),
      old = this.entries.get(identity)
    if (old && old.pending.componentId !== revision.componentId)
      reject("MODS_DEVELOPMENT_COMPONENT_CAPACITY")
    if (old?.applying || old?.closing) reject("MODS_DEVELOPMENT_APPLYING")
    if (old?.phase === "unknown") reject("MODS_DEVELOPMENT_RETIRE_UNCONFIRMED")
    // Re-requesting the unchanged draft from a new creation turn can recover an
    // interrupted request. Approval still applies only to these exact bytes and
    // activation still waits for the new turn's successful physical settlement.
    const resumesInterrupted = old?.phase === "queued" &&
      this.interrupted.get(identity)?.has(old.pending.turnId) &&
      revision.turnId !== old.pending.turnId &&
      revision.revision === old.pending.revision &&
      revision.draftId === old.pending.draftId &&
      revision.bundleDigest === old.pending.bundleDigest &&
      revision.compiledDigest === old.pending.compiledDigest &&
      revision.sourcePath === old.pending.sourcePath &&
      revision.capabilities.length === old.pending.capabilities.length &&
      revision.validation === old.pending.validation &&
      revision.capabilities.every(value => old.pending.capabilities.includes(value))
    if (old && revision.revision <= old.pending.revision && !resumesInterrupted)
      reject("MODS_DEVELOPMENT_REVISION_CONFLICT")
    if (!old && this.entries.size >= 32) reject("MODS_DEVELOPMENT_CAPACITY")
    const entry: Entry = old ?? {
      scope,
      pending: revision,
      approved: new Set(),
      epoch: 0,
      phase: "needs-approval",
      guard: assertCurrent
    }
    entry.pending = revision
    entry.guard = assertCurrent
    entry.error = undefined
    entry.phase =
      revision.capabilities.every((value) => entry.approved.has(value)) && entry.epoch > 0
        ? "queued"
        : "needs-approval"
    this.entries.set(identity, entry)
    this.publish(entry)
    this.schedule(entry)
    return this.status(scope)!
  }

  approve(
    scope: DevelopmentScope,
    componentId: string,
    digest: string,
    capabilities: readonly string[],
    assertTrustedUser: () => void
  ) {
    assertTrustedUser()
    const entry = this.require(scope, componentId)
    if (entry.phase === "unknown") reject("MODS_DEVELOPMENT_RETIRE_UNCONFIRMED")
    if (
      entry.applying || entry.closing ||
      entry.pending.compiledDigest !== digest ||
      capabilities.some((value) => !developmentCapabilities(entry.pending.validation).includes(value)) ||
      capabilities.some((value) => !entry.pending.capabilities.includes(value)) ||
      entry.pending.capabilities.some((value) => !capabilities.includes(value))
    )
      reject("MODS_DEVELOPMENT_APPROVAL_CHANGED")
    assertTrustedUser()
    if (entry.phase === "active" && entry.active?.revision === entry.pending) {
      entry.active.assertCurrent()
      return this.status(scope)!
    }
    entry.approved = new Set([...entry.approved, ...capabilities])
    if (!entry.epoch) entry.epoch++
    entry.phase = "queued"
    this.publish(entry)
    this.schedule(entry)
    return this.status(scope)!
  }

  noteSettled(
    scope: DevelopmentScope,
    turnId: string,
    outcome: "completed" | "failed" | "cancelled"
  ) {
    this.driver.assertScope(scope)
    const identity = key(scope)
    if (outcome !== "completed") {
      if (this.settled.get(identity)?.has(turnId)) return
      const interrupted = this.interrupted.get(identity) ?? new Set<string>()
      interrupted.add(turnId)
      if (interrupted.size > 64) interrupted.delete(interrupted.values().next().value!)
      this.interrupted.set(identity, interrupted)
      const entry = this.entries.get(identity)
      if (entry?.pending.turnId === turnId && entry.phase === "queued") this.publish(entry)
      return
    }
    this.interrupted.get(identity)?.delete(turnId)
    const turns = this.settled.get(identity) ?? new Set<string>()
    turns.add(turnId)
    if (turns.size > 64) turns.delete(turns.values().next().value!)
    this.settled.set(identity, turns)
    const entry = this.entries.get(identity)
    if (entry) {
      this.schedule(entry)
      if (entry.phase === "queued") this.publish(entry)
    }
  }

  idle(threadId: string) {
    for (const entry of this.entries.values()) {
      if (entry.scope.threadId !== threadId) continue
      if (entry.applying) entry.idleRequested = true
      else this.schedule(entry)
    }
  }

  assertAdmission(workspace: string, threadId: string) {
    for (const entry of this.entries.values()) {
      if (entry.closing) {
        try { this.driver.assertScope(entry.scope) } catch { continue }
      }
      if (
        entry.scope.workspace === workspace &&
        entry.scope.threadId === threadId &&
        entry.phase === "retiring"
      )
        reject("MODS_DEVELOPMENT_APPLYING")
    }
  }

  activeFor(workspace: string, threadId: string): DevelopmentActivation | undefined {
    for (const entry of this.entries.values()) {
      if (
        entry.scope.workspace !== workspace ||
        entry.scope.threadId !== threadId ||
        ["stopped", "unknown", "retiring"].includes(entry.phase) ||
        !entry.active
      )
        continue
      entry.active.assertCurrent()
      return entry.active
    }
    return undefined
  }

  /** Host cache accounting only; this does not restore authority or retire a runtime. */
  retention(scope: DevelopmentScope): DevelopmentRetention | undefined {
    const entry = this.entries.get(key(scope))
    if (!entry) return undefined
    if (entry.applying || entry.closing) return { releasable: false, revisions: null, reason: "draining" }
    if (entry.phase === "unknown") return { releasable: false, revisions: null, reason: "unknown" }
    if (entry.phase === "stopped" && !entry.active) return { releasable: true, revisions: [] }
    return {
      releasable: false,
      revisions: [...new Set([entry.pending.revision, ...(entry.active ? [entry.active.revision.revision] : [])])],
      reason: entry.active ? "active" : "pending"
    }
  }

  status(scope: DevelopmentScope): DevelopmentStatus | undefined {
    if (this.driver.assertReadableScope) this.driver.assertReadableScope(scope)
    else this.driver.assertScope(scope)
    const entry = this.entries.get(key(scope))
    if (!entry) return undefined
    return this.snapshot(entry)
  }

  private snapshot(entry: Entry): DevelopmentStatus {
    const { sourcePath: _sourcePath, ...revision } = entry.pending
    const diagnostics = entry.active && this.driver.diagnostics
      ? this.observedDiagnostics(entry) : undefined
    void _sourcePath
    return {
      ...revision,
      capabilities: [...revision.capabilities],
      phase: entry.phase,
      addedCapabilities: revision.capabilities.filter((value) => !entry.approved.has(value)),
      ...(diagnostics ? { diagnostics } : {}),
      ...(entry.phase === "queued" ? { waitingReason: this.waitingReason(entry) } : {}),
      ...(entry.active
        ? {
            activeRevision: entry.active.revision.revision,
            activeDigest: entry.active.revision.compiledDigest
          }
        : {}),
      ...(entry.error ? { error: entry.error } : {})
    }
  }

  private observedDiagnostics(entry: Entry): DevelopmentRuntimeDiagnostics | undefined {
    try {
      const observed = this.driver.diagnostics?.(entry.scope, entry.active!.id)
      if (!observed) return undefined
      const keys = ["providers", "subscriptions", "inFlight", "unknownRequests", "completedRequests",
        "failedRequests", "cancelledRequests", "backgroundResources", "pages", "generation"] as const
      return Object.fromEntries(keys.flatMap((name) => {
        const value = observed[name]
        return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
          ? [[name, value]] : []
      }))
    } catch {
      // Lost scope or cleanup uncertainty cannot be published as successful zero-resource proof.
      return undefined
    }
  }

  private waitingReason(entry: Entry): DevelopmentWaitingReason {
    const identity = key(entry.scope)
    if (!this.settled.get(identity)?.has(entry.pending.turnId)) {
      return this.interrupted.get(identity)?.has(entry.pending.turnId)
        ? "turn-interrupted"
        : "turn-finishing"
    }
    return this.driver.isBusy?.(entry.scope) ? "conversation-busy" : "waiting-for-idle"
  }

  async stop(scope: DevelopmentScope, componentId: string, assertTrustedUser: () => void) {
    assertTrustedUser()
    const entry = this.require(scope, componentId)
    if (entry.closing) return entry.closing
    const wasUnknown = entry.phase === "unknown"
    entry.epoch++
    entry.phase = "retiring"
    entry.approved.clear()
    const applying = entry.applying
    entry.closing = Promise.resolve().then(async () => {
      await applying
      const cleanupUnknown = wasUnknown || entry.phase === "unknown"
      entry.phase = "retiring"
      try {
        if (entry.active) await this.driver.retire(scope, () => {}, true)
        entry.active = undefined
        entry.phase = cleanupUnknown ? "unknown" : "stopped"
        if (!cleanupUnknown) entry.error = undefined
      } catch {
        entry.phase = "unknown"
        entry.error = "MODS_DEVELOPMENT_RETIRE_UNCONFIRMED"
      }
    }).finally(() => {
      entry.closing = undefined
      try { this.driver.changed(entry.scope, this.snapshot(entry)) }
      catch { /* The original scope may have been deleted while its owned cleanup drained. */ }
    })
    this.publish(entry)
    return entry.closing
  }

  /** Exact host entry retirement; callers supply cleanup for the captured physical instance. */
  retireExternal(activation: DevelopmentActivation, drain: () => Promise<void>): void {
    const identity = key(activation.scope)
    const entry = this.entries.get(identity)
    const drained = Promise.resolve().then(drain)
    if (!entry || entry.active !== activation || entry.closing) {
      void drained.catch(() => { /* An obsolete entry cannot change a replacement receipt. */ })
      return
    }
    const wasUnknown = entry.phase === "unknown"
    const epoch = ++entry.epoch
    entry.approved.clear()
    entry.phase = "retiring"
    const applying = entry.applying
    // Start cleanup alongside candidate settlement: a candidate may itself await this old guest.
    entry.closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([drained, applying])
      if (this.entries.get(identity) !== entry || entry.epoch !== epoch) return
      if (wasUnknown || results.some(result => result.status === "rejected") || entry.phase === "unknown") {
        entry.phase = "unknown"
        entry.error = "MODS_DEVELOPMENT_RETIRE_UNCONFIRMED"
      } else {
        entry.active = undefined
        entry.phase = "stopped"
        entry.error = undefined
      }
    }).catch(() => {
      if (this.entries.get(identity) === entry && entry.epoch === epoch) {
        entry.phase = "unknown"
        entry.error = "MODS_DEVELOPMENT_RETIRE_UNCONFIRMED"
      }
    }).finally(() => {
      entry.closing = undefined
      // The thread may already be deleted; private accounting still records the actual outcome.
      try { this.driver.changed(entry.scope, this.snapshot(entry)) }
      catch { /* Durable host observation never grants a deleted scope new authority. */ }
    })
    try { this.driver.changed(entry.scope, this.snapshot(entry)) }
    catch { /* A removed scope still keeps private cleanup ownership. */ }
  }

  close() {
    this.closed = true
    this.stopSettlement()
    for (const entry of this.entries.values()) {
      entry.epoch++
      entry.approved.clear()
    }
    this.settled.clear()
    this.interrupted.clear()
  }

  private require(scope: DevelopmentScope, componentId: string) {
    this.driver.assertScope(scope)
    const entry = this.entries.get(key(scope))
    if (!entry || entry.pending.componentId !== componentId || this.closed)
      reject("MODS_DEVELOPMENT_SCOPE_CHANGED")
    return entry
  }
  private publish(entry: Entry) {
    const status = this.status(entry.scope)
    if (status) this.driver.changed(entry.scope, status)
  }
  private schedule(entry: Entry) {
    if (
      this.closed ||
      entry.applying || entry.closing ||
      entry.phase !== "queued" ||
      !this.settled.get(key(entry.scope))?.has(entry.pending.turnId)
    )
      return
    if (this.driver.isBusy?.(entry.scope)) return
    const lease = claimConfigurationReload(entry.scope.threadId)
    if (!lease) return
    let releaseCatalog: () => void
    try {
      releaseCatalog = pluginCatalogGate.retain()
    } catch (error) {
      lease.release()
      throw error
    }
    const epoch = entry.epoch,
      revision = entry.pending
    const sourceGuard = entry.guard
    let retired = false, retirementAttempted = false,
      candidate: DevelopmentCandidate | undefined
    const assertCurrent = () => {
      this.driver.assertScope(entry.scope)
      if (
        this.closed ||
        entry.epoch !== epoch ||
        (entry.active !== activation && entry.pending !== revision) ||
        this.entries.get(key(entry.scope)) !== entry ||
        revision.capabilities.some((value) => !entry.approved.has(value))
      )
        reject("MODS_DEVELOPMENT_REVOKED")
      sourceGuard()
    }
    const assertCapabilities = (methods: readonly string[]): void => {
      // One synchronous authorization decision, with fresh source and scope checks each time.
      assertCurrent()
      if (methods.some((method) => !revision.capabilities.includes(method)))
        reject("MODS_DEVELOPMENT_CAPABILITY_DENIED")
    }
    const activation: DevelopmentActivation = Object.freeze({
      id: randomUUID(),
      scope: entry.scope,
      revision,
      assertCurrent,
      assertCapability: (method: string) => assertCapabilities([method]),
      assertCapabilities
    })
    // Defer so applying is visible before any user-controlled guard or async preparation.
    const apply = async () => {
      try {
        lease.assertLive()
        assertCurrent()
        entry.error = undefined
        entry.phase = "preflight"
        this.publish(entry)
        candidate = await this.driver.prepare(activation)
        lease.assertLive()
        assertCurrent()
        retirementAttempted = true
        await this.driver.retire(entry.scope, () => {
          lease.assertLive()
          assertCurrent()
          entry.phase = "retiring"
          this.publish(entry)
          retired = true
          lease.assertLive()
          assertCurrent()
        })
        lease.assertLive()
        assertCurrent()
        retired = true
        this.driver.activate(activation, candidate)
        candidate = undefined
        entry.active = activation
        // A successfully narrowed version revokes removed permissions for later upgrades.
        // Keep the old envelope until adoption so a rejected candidate cannot break the old version.
        entry.approved = new Set(revision.capabilities)
        entry.phase = "active"
      } catch (error) {
        if (retired) entry.active = undefined
        const code = preparationErrorCode(error)
        entry.phase = retired ? "unknown" : entry.epoch !== epoch ? (entry.closing ? "retiring" : "stopped")
          : retirementAttempted && code === "MODS_DEVELOPMENT_BUSY" ? "queued" : "failed"
        entry.error = retired
          ? "MODS_DEVELOPMENT_RETIRE_UNCONFIRMED"
          : (code ?? "MODS_DEVELOPMENT_PREPARE_FAILED")
      } finally {
        if (candidate) {
          try {
            await candidate.dispose()
          } catch {
            entry.phase = "unknown"
            entry.error = "MODS_DEVELOPMENT_CLEANUP_UNCONFIRMED"
          }
        }
        entry.applying = undefined
        releaseCatalog()
        lease.release()
        try {
          this.publish(entry)
        } catch {
          /* Deleted scope cannot receive a late notification. */
        }
        if (entry.idleRequested) {
          entry.idleRequested = false
          if (entry.phase === "queued") queueMicrotask(() => {
            try { this.schedule(entry) } catch { /* Fresh scope validation remains authoritative. */ }
          })
        }
      }
    }
    entry.applying = Promise.resolve().then(() => this.driver.run
      ? this.driver.run(entry.scope, apply) : apply())
  }
}
