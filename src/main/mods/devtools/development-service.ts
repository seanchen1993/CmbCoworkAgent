import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import type { AuthoringDocument, AuthoringFile } from "../../../shared/mods/authoring"
import type { DevelopmentMode, DevelopmentStatus } from "../../../shared/mods/development"
import type { DevelopmentScope, DevelopmentRevision } from "../v2/development-session"
import { DEVELOPMENT_CAPABILITIES, DEVELOPMENT_EVENT_CAPABILITIES } from "../v2/development-session"
import type { AuthoringDraft } from "./authoring-store"
import { AuthoringDraftStore } from "./authoring-store"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import { readPureFunctionSource } from "./authoring-install-source"
import { AuthoringVersionRepository } from "./authoring-version-repository"
import { analyzeDevelopmentSource } from "./development-analysis"
import { AuthoringCompileError } from "./authoring-compile-diagnostics"
import { DevelopmentCandidateError } from "./development-candidate-diagnostics"
import { CreatorRequestBudgets, creatorModelSummary, type CreatorModelObservation } from "./creator-request-budget"
import { issueCreatorModelAccounting } from "./creator-model-accounting"
import type { CreatorReuseService, CreatorReuseApproval } from "./creator-reuse"
import type { AuthoringAtomicSettings } from "./authoring-config-snapshot"
import type { CreatorPlanningService } from "./creator-planning"

export interface DevelopmentRuntime {
  preflightDevelopment?(
    scope: DevelopmentScope,
    revision: DevelopmentRevision,
    guard: () => void
  ): Promise<void>
  referencesSourceDirectory?(path: string): boolean
  developmentRetention(
    scope: DevelopmentScope
  ): import("../v2/development-session").DevelopmentRetention
  stageDevelopment(
    scope: DevelopmentScope,
    revision: DevelopmentRevision,
    guard: () => void
  ): unknown | Promise<unknown>
  developmentStatus(scope: DevelopmentScope): DevelopmentStatus["trials"]
  approveDevelopment(
    scope: DevelopmentScope,
    id: string,
    digest: string,
    capabilities: readonly string[],
    guard: () => void
  ): unknown | Promise<unknown>
  stopDevelopment(
    scope: DevelopmentScope,
    id: string,
    guard: () => void
  ): unknown | Promise<unknown>
}
export interface DevelopmentContext {
  scope: DevelopmentScope
  assertCurrent(): void
}
interface EnabledSession {
  scope: DevelopmentScope
  guard(): void
}
interface PreviousTrial {
  id: string
  name: string
  revision: number
  compiledDigest: string
  previous: { files: AuthoringFile[] } | null
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
function identity(scope: DevelopmentScope): string {
  return digest(JSON.stringify([scope.workspace, scope.threadId, scope.incarnation]))
}
function draftDocument(workspace: string, draft: AuthoringDraft): AuthoringDocument {
  const version = draft.versions.at(-1)!
  return {
    workspace,
    id: draft.id,
    name: draft.name,
    currentRevision: draft.currentRevision,
    updatedAt: version.createdAt,
    revision: version.revision,
    source: version.source,
    versions: draft.versions.map((item) => ({
      revision: item.revision,
      createdAt: item.createdAt,
      digest: item.source.digest,
      ...(item.restoredFrom ? { restoredFrom: item.restoredFrom } : {})
    }))
  }
}

/** A request envelope from static native review, never an approval or an execution grant. */
export function developmentTrialEnvelope(review: {
  sdkMethods: readonly string[]
  registrationEvents?: readonly string[]
  registrationEventsVerified?: boolean
}) {
  if (!review.registrationEventsVerified) throw Error("DEVELOPMENT_EVENT_AUTHORITY_UNVERIFIED")
  const requested = [
    ...new Set([
      ...review.sdkMethods,
      ...(review.registrationEvents ?? []).map((event) => `event:${event}`)
    ])
  ]
  const real = requested.some((method) => !DEVELOPMENT_CAPABILITIES.includes(method))
  return {
    validation: real ? ("authorized-real" as const) : ("session-local" as const),
    capabilities: real ? requested : [...new Set([...requested, ...DEVELOPMENT_EVENT_CAPABILITIES])]
  }
}

/** Model tools manage drafts only. Trusted renderer controls own enable, consent and promotion. */
export class ModDevelopmentService {
  private planning?: CreatorPlanningService
  configurePlanning(service: CreatorPlanningService): void { this.planning = service }
  planningCatalog(threadId: string, workspace: string) {
    if (!this.planning) throw Error("CREATOR_PLANNING_UNAVAILABLE")
    return this.planning.catalog(threadId, workspace)
  }
  selectPlanning(threadId: string, workspace: string, expectedRevision: number,
    selected: import("../../../shared/mods/creator-planning").CreatorPlanningReference | null) {
    if (!this.planning) throw Error("CREATOR_PLANNING_UNAVAILABLE")
    return this.planning.select(threadId, workspace, expectedRevision, selected)
  }
  async planningPrompt(threadId: string, workspace: string, signal: AbortSignal) {
    if (!this.isCreatorMode(threadId, workspace)) return null
    const canonicalWorkspace = this.deps.normalizeWorkspace?.(workspace) ?? workspace
    return this.planning?.prompt(threadId, canonicalWorkspace, signal) ?? null
  }
  private readonly requests: CreatorRequestBudgets
  private reuse?: CreatorReuseService
  private undoStop?: (
    scope: DevelopmentScope,
    id: string,
    turnId: string | undefined,
    guard: () => void
  ) => Promise<unknown>
  private undoStatus?: (threadId: string) => DevelopmentStatus["undo"]
  private readonly previousTrials = new Map<string, PreviousTrial>()
  configureReuse(service: CreatorReuseService): void {
    this.reuse = service
  }
  configureTrialUndoStop(stop: NonNullable<ModDevelopmentService["undoStop"]>): void {
    this.undoStop = stop
  }
  configureTrialUndoStatus(read: NonNullable<ModDevelopmentService["undoStatus"]>): void {
    this.undoStatus = read
  }
  /** Reading a prepared native plan remains available in ordinary mode. */
  reuseContext(threadId: string): DevelopmentContext {
    return this.current(threadId, false)
  }
  private compositionStatus?: (threadId: string) => DevelopmentStatus["composition"]
  private compositionSaveStatus?: (threadId: string) => DevelopmentStatus["save"]
  configureCompositionSaveStatus(read: (threadId: string) => DevelopmentStatus["save"]): void {
    this.compositionSaveStatus = read
  }
  private configurationStatus?: (threadId: string) => DevelopmentStatus["configuration"]
  private projectTrialStatus?: (threadId: string) => DevelopmentStatus["projectTrial"]
  private businessStatus?: (threadId: string) => DevelopmentStatus["business"]
  configureBusinessStatus(read: NonNullable<ModDevelopmentService["businessStatus"]>): void {
    this.businessStatus = read
  }
  configureProjectTrialStatus(read: NonNullable<ModDevelopmentService["projectTrialStatus"]>): void {
    this.projectTrialStatus = read
  }
  configureConfigurationStatus(read: NonNullable<ModDevelopmentService["configurationStatus"]>): void {
    this.configurationStatus = read
  }
  configureCompositionStatus(read: (threadId: string) => DevelopmentStatus["composition"]): void {
    this.compositionStatus = read
  }
  /** Main-process project tooling shares the same enabled creator session and incarnation guard. */
  projectAuthoringContext(threadId: string): DevelopmentContext {
    const context = this.current(threadId)
    const key = identity(context.scope)
    const enabled = this.enabled.get(key)
    const creator = this.creators.get(key)
    if (!creator) throw Error("DEVELOPMENT_CREATOR_MODE_REQUIRED")
    return {
      scope: context.scope,
      assertCurrent: () => {
        context.assertCurrent()
        if (this.enabled.get(key) !== enabled || this.creators.get(key) !== creator)
          throw Error("DEVELOPMENT_SCOPE_CHANGED")
      }
    }
  }
  private readonly enabled = new Map<string, EnabledSession>()
  private readonly creators = new Map<string, object>()
  private readonly busy = new Set<string>()
  private readonly prepared = new Map<
    string,
    {
      digest: string
      scope: DevelopmentScope
      revision: number
      repository: AuthoringVersionRepository
      prepared: Awaited<ReturnType<AuthoringVersionRepository["prepare"]>>
    }
  >()

  constructor(
    private readonly deps: {
      drafts: AuthoringDraftStore
      runtime: DevelopmentRuntime
      versionsRoot: string
      workerEntry: string
      context(threadId: string): DevelopmentContext
      changed(threadId: string): void
      normalizeWorkspace?(workspace: string): string
      canRun?(scope: DevelopmentScope): boolean
      analyze?: typeof analyzeDevelopmentSource
      /** Source observations only; never persists trial approval or executable authority. */
      historySettings?: AuthoringAtomicSettings
      /** Original host goal identity only. Models cannot choose or reset the accounting group. */
      requestGroup?(threadId: string): string | undefined
      /** Trusted host policy only; an unsupported hard currency promise blocks before HTTP. */
      modelBudget?: { modelAttemptLimit?: number; hardMoneyLimit?: CreatorModelObservation["hardMoneyLimit"] }
    }
  ) {
    this.requests = new CreatorRequestBudgets(deps.historySettings)
  }

  claimAuthoringBudget(threadId: string, runId: string, kind: "operation" | "candidate") {
    const context = this.projectAuthoringContext(threadId)
    context.assertCurrent()
    return this.requests.claim(identity(context.scope), runId, kind, this.deps.requestGroup?.(threadId))
  }

  captureModelAccounting(threadId: string, workspace: string, runId: string, expectedGoalId?: string) {
    if (!this.isCreatorMode(threadId, workspace)) return undefined
    const context = this.projectAuthoringContext(threadId)
    const groupId = expectedGoalId ? `goal:${expectedGoalId}` : this.deps.requestGroup?.(threadId)
    if (expectedGoalId && this.deps.requestGroup?.(threadId) !== groupId)
      throw Error("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
    const key = identity(context.scope)
    const bound = this.requests.bindModel(key, runId, groupId, this.deps.modelBudget)
    const assertOwner = () => this.assertScope(context.scope)
    return issueCreatorModelAccounting({
      assertCurrent: assertOwner,
      claim: traceId => {
        assertOwner()
        const attempt = this.requests.claimModel(key, bound.runId, traceId)
        return { settle: usage => {
          // Accounting is not execution authority. A late receipt cannot target a rebuilt thread.
          this.assertScope(context.scope)
          this.requests.settleModel(key, bound.runId, attempt, usage)
        } }
      },
      recordTrace: usage => {
        this.assertScope(context.scope)
        this.requests.recordModelTrace(key, bound.runId, usage)
      }
    }, undefined, undefined, { workspace, threadId })
  }

  captureGoalModelAccounting(threadId: string, goalId: string) {
    let context: DevelopmentContext
    try { context = this.current(threadId, false) }
    catch (error) {
      if ([...this.enabled.values()].some(session => session.scope.threadId === threadId)) throw error
      return undefined
    }
    if (!this.creators.has(identity(context.scope))) return undefined
    return this.captureModelAccounting(threadId, context.scope.workspace, `goal-judge:${goalId}`, goalId)
  }

  trialAccountingReference(scope: DevelopmentScope, nativeRunId: string | undefined) {
    this.assertScope(scope)
    return nativeRunId ? this.requests.modelReference(identity(scope), nativeRunId) : undefined
  }

  captureOwnedTrialAccounting(scope: DevelopmentScope, boundRunId: string,
    target: { workspace: string; threadId: string }) {
    this.assertScope(scope)
    if (this.requests.modelReference(identity(scope), boundRunId) !== boundRunId)
      throw Error("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
    return issueCreatorModelAccounting({
      assertCurrent: () => this.assertScope(scope),
      claim: traceId => {
        this.assertScope(scope)
        const attemptId = this.requests.claimModel(identity(scope), boundRunId, traceId)
        return { settle: usage => {
          this.assertScope(scope)
          this.requests.settleModel(identity(scope), boundRunId, attemptId, usage)
        } }
      },
      recordTrace: usage => {
        this.assertScope(scope)
        this.requests.recordModelTrace(identity(scope), boundRunId, usage)
      }
    }, undefined, undefined, target)
  }

  private key(scope: DevelopmentScope): string {
    return `development:${identity(scope)}`
  }
  private previousTrial(scope: DevelopmentScope): PreviousTrial | undefined {
    const scopedKey = identity(scope)
    const cached = this.previousTrials.get(scopedKey)
    if (cached) {
      this.cachePreviousTrial(scopedKey, cached)
      return cached
    }
    if (!this.deps.historySettings) return undefined
    const raw = this.deps.historySettings.getSetting(`development-undo-source:${scopedKey}`, "")
    if (!raw) return undefined
    if (Buffer.byteLength(raw) > 1024 * 1024) throw Error("DEVELOPMENT_UNDO_RECORD_INVALID")
    const row = JSON.parse(raw) as PreviousTrial
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(row.id) ||
      typeof row.name !== "string" ||
      row.name.length > 100 ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      !/^[a-f0-9]{64}$/.test(row.compiledDigest)
    )
      throw Error("DEVELOPMENT_UNDO_RECORD_INVALID")
    if (row.previous !== null) {
      if (!row.previous || !Array.isArray(row.previous.files))
        throw Error("DEVELOPMENT_UNDO_RECORD_INVALID")
      row.previous = {
        files: readPureFunctionSource(createAuthoringSourceBundle(row.previous.files)).files
      }
    }
    this.cachePreviousTrial(scopedKey, row)
    return row
  }
  private cachePreviousTrial(scopedKey: string, row: PreviousTrial): void {
    this.previousTrials.delete(scopedKey)
    this.previousTrials.set(scopedKey, row)
    if (this.previousTrials.size > 32)
      this.previousTrials.delete(this.previousTrials.keys().next().value!)
  }
  private rememberPreviousTrial(scope: DevelopmentScope, row: PreviousTrial): void {
    const scopedKey = identity(scope)
    if (this.deps.historySettings) {
      const storageKey = `development-undo-source:${scopedKey}`
      const absent = "\0development-undo-absent"
      const before = this.deps.historySettings.getSetting(storageKey, absent)
      this.assertScope(scope)
      if (
        !this.deps.historySettings.compareAndSetSetting(
          storageKey,
          before === absent ? undefined : before,
          JSON.stringify(row)
        )
      )
        throw Error("DEVELOPMENT_UNDO_RECORD_CHANGED")
    }
    this.cachePreviousTrial(scopedKey, row)
  }
  private current(threadId: string, requireEnabled = true): DevelopmentContext {
    const current = this.deps.context(threadId)
    current.assertCurrent()
    if (requireEnabled && !this.enabled.has(identity(current.scope)))
      throw Error("DEVELOPMENT_DISABLED")
    if (requireEnabled && this.deps.canRun && !this.deps.canRun(current.scope))
      throw Error("DEVELOPMENT_MODS_DISABLED")
    return current
  }
  isEnabled(threadId: string, workspace: string): boolean {
    try {
      const current = this.current(threadId)
      return current.scope.workspace === (this.deps.normalizeWorkspace?.(workspace) ?? workspace)
    } catch {
      return false
    }
  }
  isCreatorMode(threadId: string, workspace: string): boolean {
    try {
      const current = this.current(threadId)
      return (
        current.scope.workspace === (this.deps.normalizeWorkspace?.(workspace) ?? workspace) &&
        this.creators.has(identity(current.scope))
      )
    } catch {
      return false
    }
  }
  captureCreatorMode(threadId: string, workspace: string): () => void {
    const current = this.current(threadId)
    const key = identity(current.scope)
    const creator = this.creators.get(key)
    if (!creator || !this.isCreatorMode(threadId, workspace))
      throw Error("DEVELOPMENT_CREATOR_MODE_REQUIRED")
    return () => {
      current.assertCurrent()
      if (this.creators.get(key) !== creator || !this.isCreatorMode(threadId, workspace))
        throw Error("DEVELOPMENT_SCOPE_CHANGED")
    }
  }
  assertScope(scope: DevelopmentScope): void {
    const current = this.current(scope.threadId, false)
    if (identity(current.scope) !== identity(scope)) throw Error("DEVELOPMENT_SCOPE_CHANGED")
  }
  status(threadId: string): DevelopmentStatus {
    const { scope } = this.current(threadId, false)
    let request: DevelopmentStatus["request"]
    try {
      const latest = this.requests.latest(identity(scope))
      if (latest) {
        const { runId, startedAt, operations, candidates, groupId } = latest
        request = { runId, startedAt, operations, candidates, ...(groupId ? { groupId } : {}), model: creatorModelSummary(latest.model) }
      }
    }
    catch { request = { error: "DEVELOPMENT_BUDGET_UNCONFIRMED" } }
    const composition = this.compositionStatus?.(threadId)
    const save = this.compositionSaveStatus?.(threadId)
    const configuration = this.configurationStatus?.(threadId)
    const projectTrial = this.projectTrialStatus?.(threadId)
    const business = this.businessStatus?.(threadId)
    const reuse = this.reuse?.status(scope)
    const undo = this.undoStatus?.(threadId)
    return {
      workspace: scope.workspace,
      threadId,
      enabled: this.enabled.has(identity(scope)),
      mode: this.creators.has(identity(scope)) ? "creator" : "normal",
      ...(this.planning ? { planning: this.planning.observed(this.current(threadId, false)) } : {}),
      ...(request ? { request } : {}),
      ...(composition ? { composition } : {}),
      ...(save ? { save } : {}),
      ...(configuration ? { configuration } : {}),
      ...(projectTrial ? { projectTrial } : {}),
      ...(business ? { business } : {}),
      ...(reuse ? { reuse } : {}),
      ...(undo ? { undo } : {}),
      drafts: this.deps.drafts.list(this.key(scope)).map((draft) => ({
        id: draft.id,
        name: draft.name,
        revision: draft.currentRevision,
        digest: draft.versions.at(-1)!.source.digest
      })),
      trials: this.deps.runtime.developmentStatus(scope).map((trial) => {
        const previous = this.previousTrial(scope)
        const canUndo =
          trial.phase === "active" &&
          previous?.id === trial.componentId &&
          previous.revision === trial.activeRevision &&
          previous.compiledDigest === trial.activeDigest &&
          !["queued", "applying"].includes(undo?.phase ?? "")
        return { ...trial, capabilities: [...trial.capabilities], canUndo }
      })
    }
  }
  private pruneUnreferenced(): void {
    for (const [key, entry] of this.enabled) {
      let stale = false
      try {
        entry.guard()
        this.assertScope(entry.scope)
      } catch {
        stale = true
      }
      if (stale && this.deps.runtime.developmentRetention(entry.scope).releasable) {
        this.enabled.delete(key)
        this.creators.delete(key)
      }
    }
    for (const [key, entry] of this.prepared) {
      const retention = this.deps.runtime.developmentRetention(entry.scope)
      if (retention.revisions !== null && !retention.revisions.includes(entry.revision))
        this.prepared.delete(key)
    }
  }
  async setEnabled(threadId: string, expectedWorkspace: string, enabled: boolean) {
    const { scope, assertCurrent } = this.current(threadId, false)
    if (scope.workspace !== expectedWorkspace) throw Error("DEVELOPMENT_SCOPE_CHANGED")
    if (enabled) {
      this.pruneUnreferenced()
      if (this.deps.canRun && !this.deps.canRun(scope)) throw Error("DEVELOPMENT_MODS_DISABLED")
      if (!this.enabled.has(identity(scope)) && this.enabled.size >= 16)
        throw Error("DEVELOPMENT_SESSION_LIMIT")
      this.enabled.set(identity(scope), { scope, guard: assertCurrent })
      this.creators.set(identity(scope), {})
    } else {
      for (const trial of this.deps.runtime.developmentStatus(scope))
        await this.deps.runtime.stopDevelopment(scope, trial.componentId, assertCurrent)
      assertCurrent()
      this.enabled.delete(identity(scope))
      this.creators.delete(identity(scope))
    }
    this.deps.changed(threadId)
    return this.status(threadId)
  }
  async setMode(threadId: string, expectedWorkspace: string, mode: DevelopmentMode) {
    const { scope } = this.current(threadId, false)
    if (scope.workspace !== expectedWorkspace) throw Error("DEVELOPMENT_SCOPE_CHANGED")
    if (mode !== "normal" && mode !== "creator") throw Error("DEVELOPMENT_INPUT")
    if (mode === "creator") {
      if (!this.enabled.has(identity(scope)))
        return this.setEnabled(threadId, expectedWorkspace, true)
      if (this.deps.canRun && !this.deps.canRun(scope)) throw Error("DEVELOPMENT_MODS_DISABLED")
      if (!this.creators.has(identity(scope))) this.creators.set(identity(scope), {})
    } else {
      // A mode switch controls authoring admission, never the authority of an approved live Mod.
      this.creators.delete(identity(scope))
    }
    this.deps.changed(threadId)
    return this.status(threadId)
  }
  read(threadId: string, id: string): AuthoringDocument {
    const { scope } = this.current(threadId)
    const draft = this.deps.drafts.list(this.key(scope)).find((item) => item.id === id)
    if (!draft) throw Error("AUTHORING_VERSION_MISSING")
    return draftDocument(scope.workspace, draft)
  }
  save(
    threadId: string,
    input: {
      id: string
      name: string
      expectedRevision: number
      files: AuthoringFile[]
    }
  ): AuthoringDocument {
    const { scope, assertCurrent } = this.current(threadId)
    const source = readPureFunctionSource(createAuthoringSourceBundle(input.files))
    const existing = this.deps.drafts.list(this.key(scope)).find((row) => row.id === input.id)
    if ((existing?.currentRevision ?? 0) !== input.expectedRevision)
      throw Error("AUTHORING_VERSION_CHANGED")
    const retention = this.deps.runtime.developmentRetention(scope)
    if (
      existing &&
      retention.revisions !== null &&
      !["unknown", "draining"].includes(retention.reason ?? "")
    ) {
      const signature = JSON.stringify(retention)
      this.deps.drafts.compact({
        workspace: this.key(scope),
        id: input.id,
        retainRevisions: [...retention.revisions],
        assertCurrent: () => {
          assertCurrent()
          this.assertScope(scope)
          if (signature !== JSON.stringify(this.deps.runtime.developmentRetention(scope)))
            throw Error("DEVELOPMENT_RETENTION_CHANGED")
        }
      })
    }
    const draft = this.deps.drafts.save({
      ...input,
      workspace: this.key(scope),
      source,
      assertCurrent
    })
    this.deps.changed(threadId)
    return draftDocument(scope.workspace, draft)
  }
  private async operation<T>(threadId: string, run: () => Promise<T>): Promise<T> {
    if (this.busy.has(threadId) || this.busy.size >= 2) throw Error("DEVELOPMENT_BUSY")
    this.busy.add(threadId)
    try {
      return await run()
    } finally {
      this.busy.delete(threadId)
    }
  }
  async check(threadId: string, id: string, revision: number, signal: AbortSignal) {
    return this.operation(threadId, async () => {
      const captured = this.current(threadId)
      const draft = this.read(threadId, id)
      if (draft.revision !== revision) throw Error("AUTHORING_VERSION_CHANGED")
      return (this.deps.analyze ?? analyzeDevelopmentSource)(draft.source, signal, () => {
        captured.assertCurrent()
        this.assertScope(captured.scope)
        if (this.read(threadId, id).revision !== revision) throw Error("AUTHORING_VERSION_CHANGED")
      })
    })
  }
  private collectPrepared(
    scope: DevelopmentScope,
    repository: AuthoringVersionRepository,
    assertCurrent: () => void
  ): void {
    const retention = this.deps.runtime.developmentRetention(scope)
    if (
      retention.revisions === null ||
      ["unknown", "draining"].includes(retention.reason ?? "") ||
      !this.deps.runtime.referencesSourceDirectory
    )
      return
    assertCurrent()
    const signature = JSON.stringify(retention)
    const records = repository.listRecords()
    const latest = new Set<string>()
    const counts = new Map<string, number>()
    for (const record of [...records].sort(
      (a, b) => b.revision - a.revision || b.createdAt - a.createdAt
    )) {
      const count = counts.get(record.draftId) ?? 0
      if (count < 2) latest.add(record.versionId)
      counts.set(record.draftId, count + 1)
    }
    repository.collectUnreferenced(scope.workspace, (record) => {
      assertCurrent()
      if (signature !== JSON.stringify(this.deps.runtime.developmentRetention(scope)))
        throw Error("DEVELOPMENT_RETENTION_CHANGED")
      const retained =
        record.workspace !== scope.workspace ||
        latest.has(record.versionId) ||
        retention.revisions!.includes(record.revision) ||
        this.deps.runtime.referencesSourceDirectory!(
          join(this.deps.versionsRoot, identity(scope), record.versionId, "source")
        )
      assertCurrent()
      if (signature !== JSON.stringify(this.deps.runtime.developmentRetention(scope)))
        throw Error("DEVELOPMENT_RETENTION_CHANGED")
      return retained
    })
    const remaining = new Set(repository.listRecords().map((record) => record.versionId))
    for (const [key, entry] of this.prepared)
      if (
        identity(entry.scope) === identity(scope) &&
        !remaining.has(entry.prepared.record.versionId)
      )
        this.prepared.delete(key)
  }

  async requestTrial(
    threadId: string,
    id: string,
    revision: number,
    turnId: string,
    signal: AbortSignal,
    assertTurn: () => void
  ) {
    return this.operation(threadId, async () => {
      const captured = this.current(threadId)
      const draft = this.read(threadId, id)
      if (draft.revision !== revision) throw Error("AUTHORING_VERSION_CHANGED")
      const scopedKey = identity(captured.scope)
      const cacheKey = JSON.stringify([scopedKey, id, revision])
      const guard = () => {
        captured.assertCurrent()
        this.assertScope(captured.scope)
        this.current(threadId)
      }
      const stagingGuard = () => {
        guard()
        signal.throwIfAborted()
        assertTurn()
        if (this.read(threadId, id).revision !== revision) throw Error("AUTHORING_VERSION_CHANGED")
      }
      stagingGuard()
      this.pruneUnreferenced()
      let entry = this.prepared.get(cacheKey)
      if (!entry) {
        if (this.prepared.size >= 128) throw Error("DEVELOPMENT_PREPARATION_LIMIT")
        const repository = new AuthoringVersionRepository(
          join(this.deps.versionsRoot, scopedKey),
          this.deps.workerEntry
        )
        this.collectPrepared(captured.scope, repository, stagingGuard)
        const prepared = await repository.prepare({
          installationId: randomUUID(),
          workspace: captured.scope.workspace,
          draftId: id,
          revision,
          source: draft.source,
          signal,
          assertCurrent: stagingGuard
        })
        entry = {
          repository,
          prepared,
          digest: draft.source.digest,
          scope: captured.scope,
          revision
        }
        this.prepared.set(cacheKey, entry)
      }
      stagingGuard()
      const preparedEntry = entry
      const sourceGuard = () => {
        guard()
        preparedEntry.repository.assertPrepared(preparedEntry.prepared.token)
      }
      sourceGuard()
      const record = entry.prepared.record
      const envelope = developmentTrialEnvelope(entry.prepared.review)
      const metadata = JSON.parse(
        record.source.files.find((file) => file.path === "plugin.json")!.text
      )
      const active = this.deps.runtime
        .developmentStatus(captured.scope)
        .find((item) => item.draftId === id && item.activeRevision !== undefined)
      const previous =
        active &&
        this.deps.drafts
          .list(this.key(captured.scope))
          .find((item) => item.id === id)
          ?.versions.find((item) => item.revision === active.activeRevision)
      const candidate: DevelopmentRevision = {
        componentId: id,
        draftId: id,
        revision,
        turnId,
        bundleDigest: record.sourceDigest,
        compiledDigest: record.compiledDigest,
        sourcePath: entry.repository.preparedSourceDirectory(entry.prepared.token),
        ...envelope,
        purpose: String(metadata.description || draft.name).slice(0, 400)
      }
      if (this.deps.runtime.preflightDevelopment) {
        try {
          await this.deps.runtime.preflightDevelopment(captured.scope, candidate, () => {
            stagingGuard()
            sourceGuard()
          })
          stagingGuard()
        } catch (error) {
          stagingGuard()
          throw new DevelopmentCandidateError(
            error,
            { id, revision, digest: record.sourceDigest },
            draft.source.files
          )
        }
      }
      await this.deps.runtime.stageDevelopment(captured.scope, candidate, sourceGuard)
      if (!active || active.activeRevision !== revision) {
        const prior = this.previousTrial(captured.scope)
        // Re-requesting a pending candidate must not discard its predecessor.
        if (!prior || prior.revision !== revision || prior.compiledDigest !== record.compiledDigest)
          this.rememberPreviousTrial(captured.scope, {
            id,
            name: draft.name,
            revision,
            compiledDigest: record.compiledDigest,
            previous: previous ? { files: structuredClone(previous.source.files) } : null
          })
      }
      this.deps.changed(threadId)
      return this.status(threadId)
    })
  }
  /** Successful submissions compile once: preparation already checks SDK and TypeScript. */
  async submit(
    threadId: string,
    input: {
      id: string
      name: string
      expectedRevision: number
      files: AuthoringFile[]
    },
    turnId: string,
    signal: AbortSignal,
    assertTurn: () => void
  ) {
    assertTurn()
    const document = this.save(threadId, input)
    try {
      const status = await this.requestTrial(
        threadId,
        document.id,
        document.revision,
        turnId,
        signal,
        assertTurn
      )
      return {
        document,
        check: { digest: document.source.digest, valid: true, runtimeVerified: false },
        status
      }
    } catch (error) {
      assertTurn()
      if (error instanceof AuthoringCompileError)
        return {
          document,
          check: {
            digest: document.source.digest,
            valid: false,
            runtimeVerified: false,
            diagnostics: error.diagnostics
          },
          status: this.status(threadId)
        }
      if (!(error instanceof Error) || error.message !== "AUTHORING_VERSION_CHECK_FAILED")
        throw error
      // Only failed preparations need the diagnostic-only pass; the old active version stays.
      return {
        document,
        check: await this.check(threadId, document.id, document.revision, signal),
        status: this.status(threadId)
      }
    }
  }
  resumeTrial(
    threadId: string,
    id: string,
    revision: number,
    turnId: string,
    signal: AbortSignal,
    assertTurn: () => void
  ) {
    return this.requestTrial(threadId, id, revision, turnId, signal, assertTurn)
  }
  async undoTrial(
    threadId: string,
    turnId?: string,
    signal = new AbortController().signal,
    assertTurn: () => void = () => {}
  ) {
    assertTurn()
    const context = this.current(threadId)
    const previous = this.previousTrial(context.scope)
    const trial = this.deps.runtime
      .developmentStatus(context.scope)
      .find((item) => item.componentId === previous?.id)
    if (
      !previous ||
      trial?.phase !== "active" ||
      trial.activeRevision !== previous.revision ||
      trial.activeDigest !== previous.compiledDigest
    )
      throw Error("DEVELOPMENT_UNDO_UNAVAILABLE")
    if (!previous.previous) {
      if (!this.undoStop) throw Error("DEVELOPMENT_UNDO_STOP_UNAVAILABLE")
      await this.undoStop(context.scope, previous.id, turnId, () => {
        context.assertCurrent()
        this.assertScope(context.scope)
      })
      return { action: "stop-queued", status: this.status(threadId) }
    }
    if (!turnId) throw Error("DEVELOPMENT_UNDO_TURN_REQUIRED")
    const current = this.read(threadId, previous.id)
    const result = await this.submit(
      threadId,
      {
        id: previous.id,
        name: previous.name,
        expectedRevision: current.revision,
        files: previous.previous.files
      },
      turnId,
      signal,
      assertTurn
    )
    return { action: "restore-queued", ...result }
  }
  async requestReuse(
    threadId: string,
    id: string,
    revision: number,
    turnId?: string,
    signal = new AbortController().signal,
    assertTurn: () => void = () => {}
  ) {
    if (!this.reuse) throw Error("DEVELOPMENT_REUSE_UNAVAILABLE")
    assertTurn()
    const context = this.current(threadId)
    const document = this.read(threadId, id)
    if (document.revision !== revision) throw Error("AUTHORING_VERSION_CHANGED")
    await this.reuse.reconcile(context)
    assertTurn()
    await this.reuse.request(context, document, { turnId, signal, assertTurn })
    return this.status(threadId)
  }
  async approveReuse(threadId: string, expectedWorkspace: string, input: CreatorReuseApproval) {
    if (!this.reuse) throw Error("DEVELOPMENT_REUSE_UNAVAILABLE")
    const context = this.current(threadId, false)
    if (context.scope.workspace !== expectedWorkspace) throw Error("DEVELOPMENT_SCOPE_CHANGED")
    await this.reuse.approve(context, input)
    return this.status(threadId)
  }
  async refreshReuse(threadId: string): Promise<DevelopmentStatus> {
    const context = this.current(threadId, false)
    // Resolving formal installation facts recompiles immutable source. Ordinary status
    // updates need only current authorization/runtime observations; explicit unknown
    // recovery is deduplicated by the reuse service.
    if (this.reuse?.status(context.scope)?.phase === "unknown") await this.reuse.reconcile(context)
    return this.status(threadId)
  }
  async approve(
    threadId: string,
    expectedWorkspace: string,
    id: string,
    revision: number,
    compiledDigest: string,
    sourceDigest?: string
  ) {
    const { scope, assertCurrent } = this.current(threadId)
    if (scope.workspace !== expectedWorkspace) throw Error("DEVELOPMENT_SCOPE_CHANGED")
    const trial = this.deps.runtime.developmentStatus(scope).find((item) => item.componentId === id)
    if (!trial || trial.revision !== revision || trial.compiledDigest !== compiledDigest)
      throw Error("DEVELOPMENT_APPROVAL_STALE")
    if (trial.validation === "authorized-real" && trial.bundleDigest !== sourceDigest)
      throw Error("DEVELOPMENT_APPROVAL_SOURCE_REQUIRED")
    await this.deps.runtime.approveDevelopment(
      scope,
      id,
      compiledDigest,
      trial.capabilities,
      assertCurrent
    )
    this.deps.changed(threadId)
    return this.status(threadId)
  }
  async stop(threadId: string, expectedWorkspace: string, id: string) {
    const { scope, assertCurrent } = this.current(threadId)
    if (scope.workspace !== expectedWorkspace) throw Error("DEVELOPMENT_SCOPE_CHANGED")
    await this.deps.runtime.stopDevelopment(scope, id, assertCurrent)
    this.deps.changed(threadId)
    return this.status(threadId)
  }
  promote(threadId: string, expectedWorkspace: string, id: string, revision: number) {
    const { scope, assertCurrent } = this.current(threadId)
    if (scope.workspace !== expectedWorkspace) throw Error("DEVELOPMENT_SCOPE_CHANGED")
    const draft = this.read(threadId, id)
    if (draft.revision !== revision) throw Error("AUTHORING_VERSION_CHANGED")
    const savedId = `creator-${digest(JSON.stringify([identity(scope), id, revision])).slice(0, 48)}`
    const existing = this.deps.drafts.list(scope.workspace).find((item) => item.id === savedId)
    if (existing) {
      if (existing.versions.at(-1)!.source.digest !== draft.source.digest)
        throw Error("DEVELOPMENT_PROMOTION_CHANGED")
      return draftDocument(scope.workspace, existing)
    }
    const saved = this.deps.drafts.save({
      workspace: scope.workspace,
      id: savedId,
      name: draft.name,
      expectedRevision: 0,
      source: draft.source,
      assertCurrent
    })
    return draftDocument(scope.workspace, saved)
  }
}

let development: ModDevelopmentService | undefined
export function setModDevelopmentService(service: ModDevelopmentService | undefined): void {
  development = service
}
export function getModDevelopmentService(): ModDevelopmentService | undefined {
  return development
}
