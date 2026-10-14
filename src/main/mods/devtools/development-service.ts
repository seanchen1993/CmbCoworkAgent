import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import type { AuthoringDocument, AuthoringFile } from "../../../shared/mods/authoring"
import type { DevelopmentStatus } from "../../../shared/mods/development"
import type { DevelopmentScope, DevelopmentRevision } from "../v2/development-session"
import { DEVELOPMENT_EVENT_CAPABILITIES } from "../v2/development-session"
import type { AuthoringDraft } from "./authoring-store"
import { AuthoringDraftStore } from "./authoring-store"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import { readPureFunctionSource } from "./authoring-install-source"
import { AuthoringVersionRepository } from "./authoring-version-repository"
import { analyzeDevelopmentSource } from "./development-analysis"

export interface DevelopmentRuntime {
  referencesSourceDirectory?(path: string): boolean
  developmentRetention(scope: DevelopmentScope): import("../v2/development-session").DevelopmentRetention
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

/** Model tools manage drafts only. Trusted renderer controls own enable, consent and promotion. */
export class ModDevelopmentService {
  /** Main-process project tooling shares the same enabled creator session and incarnation guard. */
  projectAuthoringContext(threadId: string): DevelopmentContext {
    const context = this.current(threadId)
    const key = identity(context.scope)
    const enabled = this.enabled.get(key)
    return {
      scope: context.scope,
      assertCurrent: () => {
        context.assertCurrent()
        if (this.enabled.get(key) !== enabled) throw Error("DEVELOPMENT_SCOPE_CHANGED")
      }
    }
  }
  private readonly enabled = new Map<string, EnabledSession>()
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
    }
  ) {}

  private key(scope: DevelopmentScope): string {
    return `development:${identity(scope)}`
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
  assertScope(scope: DevelopmentScope): void {
    const current = this.current(scope.threadId, false)
    if (identity(current.scope) !== identity(scope)) throw Error("DEVELOPMENT_SCOPE_CHANGED")
  }
  status(threadId: string): DevelopmentStatus {
    const { scope } = this.current(threadId, false)
    return {
      workspace: scope.workspace,
      threadId,
      enabled: this.enabled.has(identity(scope)),
      drafts: this.deps.drafts.list(this.key(scope)).map((draft) => ({
        id: draft.id,
        name: draft.name,
        revision: draft.currentRevision,
        digest: draft.versions.at(-1)!.source.digest
      })),
      trials: this.deps.runtime
        .developmentStatus(scope)
        .map((trial) => ({ ...trial, capabilities: [...trial.capabilities] }))
    }
  }
  private pruneUnreferenced(): void {
    for (const [key, entry] of this.enabled) {
      let stale = false
      try { entry.guard(); this.assertScope(entry.scope) } catch { stale = true }
      if (stale && this.deps.runtime.developmentRetention(entry.scope).releasable)
        this.enabled.delete(key)
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
    } else {
      for (const trial of this.deps.runtime.developmentStatus(scope))
        await this.deps.runtime.stopDevelopment(scope, trial.componentId, assertCurrent)
      assertCurrent()
      this.enabled.delete(identity(scope))
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
    const existing = this.deps.drafts.list(this.key(scope)).find(row => row.id === input.id)
    if ((existing?.currentRevision ?? 0) !== input.expectedRevision)
      throw Error("AUTHORING_VERSION_CHANGED")
    const retention = this.deps.runtime.developmentRetention(scope)
    if (existing && retention.revisions !== null && !["unknown", "draining"].includes(retention.reason ?? "")) {
      const signature = JSON.stringify(retention)
      this.deps.drafts.compact({
        workspace: this.key(scope), id: input.id, retainRevisions: [...retention.revisions],
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
  private collectPrepared(scope: DevelopmentScope, repository: AuthoringVersionRepository,
    assertCurrent: () => void): void {
    const retention = this.deps.runtime.developmentRetention(scope)
    if (retention.revisions === null || ["unknown", "draining"].includes(retention.reason ?? "") ||
      !this.deps.runtime.referencesSourceDirectory) return
    assertCurrent()
    const signature = JSON.stringify(retention)
    const records = repository.listRecords()
    const latest = new Set<string>()
    const counts = new Map<string, number>()
    for (const record of [...records].sort((a, b) => b.revision - a.revision || b.createdAt - a.createdAt)) {
      const count = counts.get(record.draftId) ?? 0
      if (count < 2) latest.add(record.versionId)
      counts.set(record.draftId, count + 1)
    }
    repository.collectUnreferenced(scope.workspace, record => {
      assertCurrent()
      if (signature !== JSON.stringify(this.deps.runtime.developmentRetention(scope)))
        throw Error("DEVELOPMENT_RETENTION_CHANGED")
      const retained = record.workspace !== scope.workspace || latest.has(record.versionId) ||
        retention.revisions!.includes(record.revision) ||
        this.deps.runtime.referencesSourceDirectory!(
          join(this.deps.versionsRoot, identity(scope), record.versionId, "source"))
      assertCurrent()
      if (signature !== JSON.stringify(this.deps.runtime.developmentRetention(scope)))
        throw Error("DEVELOPMENT_RETENTION_CHANGED")
      return retained
    })
    const remaining = new Set(repository.listRecords().map(record => record.versionId))
    for (const [key, entry] of this.prepared)
      if (identity(entry.scope) === identity(scope) && !remaining.has(entry.prepared.record.versionId))
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
        entry = { repository, prepared, digest: draft.source.digest, scope: captured.scope, revision }
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
      await this.deps.runtime.stageDevelopment(
        captured.scope,
        {
          componentId: id,
          draftId: id,
          revision,
          turnId,
          bundleDigest: record.sourceDigest,
          compiledDigest: record.compiledDigest,
          sourcePath: entry.repository.preparedSourceDirectory(entry.prepared.token),
          capabilities: [...entry.prepared.review.sdkMethods, ...DEVELOPMENT_EVENT_CAPABILITIES]
        },
        sourceGuard
      )
      this.deps.changed(threadId)
      return this.status(threadId)
    })
  }
  async approve(
    threadId: string,
    expectedWorkspace: string,
    id: string,
    revision: number,
    compiledDigest: string
  ) {
    const { scope, assertCurrent } = this.current(threadId)
    if (scope.workspace !== expectedWorkspace) throw Error("DEVELOPMENT_SCOPE_CHANGED")
    const trial = this.deps.runtime.developmentStatus(scope).find((item) => item.componentId === id)
    if (!trial || trial.revision !== revision || trial.compiledDigest !== compiledDigest)
      throw Error("DEVELOPMENT_APPROVAL_STALE")
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
