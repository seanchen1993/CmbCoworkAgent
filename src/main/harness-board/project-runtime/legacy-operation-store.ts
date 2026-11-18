import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { lstatSync } from "node:fs"
import type {
  LegacyProjectOperation,
  LegacyProjectRecoveryInput,
  LegacyProjectRuntimeBinding
} from "../../../shared/project-runtime/legacy-operations"
import { hostDigest, hostInteger, hostRecord, hostStateError, hostText } from "./host-state-protocol"
import type { ProjectWorkspaceModeGuard } from "./workspace-mode-guard"
import type { HostLegacyImportReview } from "../../../shared/project-runtime/host-types"
import { parseHostLegacyImportReceipt } from "./legacy-import-protocol"
import type { LegacyOptInIndex } from "./legacy-opt-in-index"
import { runtimeDigest } from "./safe-files"

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) hostStateError("LEGACY_LEDGER_INVALID")
  return Number(value)
}
function binding(value: unknown): LegacyProjectRuntimeBinding {
  const raw = hostRecord(value, [
    "schemaVersion",
    "projectId",
    "workspace",
    "installedPluginId",
    "packageId",
    "packageVersion",
    "packageDigest",
    "enabledAt",
    "mods"
  ])
  if (raw.schemaVersion !== 1) hostStateError("LEGACY_LEDGER_VERSION")
  const mods = raw.mods === null ? null : hostRecord(raw.mods, ["modId", "digest", "grantEpoch"])
  return {
    schemaVersion: 1,
    projectId: hostText(raw.projectId),
    workspace: hostText(raw.workspace),
    installedPluginId: hostText(raw.installedPluginId),
    packageId: hostText(raw.packageId),
    packageVersion: hostText(raw.packageVersion),
    packageDigest: hostDigest(raw.packageDigest),
    mods: mods
      ? {
          modId: hostText(mods.modId),
          digest: hostDigest(mods.digest),
          grantEpoch: timestamp(mods.grantEpoch)
        }
      : null,
    enabledAt: timestamp(raw.enabledAt)
  }
}
/** Same strict source schema used by the original ledger and immutable import provenance. */
export const parseLegacyProjectRuntimeBinding = binding
function operation(value: unknown): LegacyProjectOperation {
  const optional = ["executionWorkspace", "executionWorkspaceIdentity", "owner", "reconciliation"].filter(
    (key) => Boolean(value && typeof value === "object" && Object.hasOwn(value, key))
  )
  const raw = hostRecord(value, [
    "schemaVersion",
    "operationId",
    "projectId",
    "featureId",
    "workspace",
    "installedPluginId",
    "packageDigest",
    "threadId",
    "threadIncarnation",
    "requestId",
    "inputDigest",
    "status",
    "startedAt",
    "settledAt",
    "terminalCode",
    "businessStateValidity",
    ...optional
  ])
  const reconciliation = raw.reconciliation === undefined
    ? undefined
    : hostRecord(raw.reconciliation, ["reviewedRevision", "reviewedAt", "actor"])
  const owner = raw.owner === undefined ? undefined : hostRecord(raw.owner, ["processId", "incarnation"])
  if (
    raw.schemaVersion !== 1 ||
    raw.businessStateValidity !== "unknown" ||
    !["started", "succeeded", "failed", "cancelled", "unknown", "reconciled"].includes(String(raw.status)) ||
    (raw.status === "reconciled") !== Boolean(reconciliation) ||
    (reconciliation && reconciliation.actor !== "desktop-user")
  )
    hostStateError("LEGACY_LEDGER_INVALID")
  return {
    schemaVersion: 1,
    operationId: hostText(raw.operationId),
    projectId: hostText(raw.projectId),
    featureId: hostText(raw.featureId),
    workspace: hostText(raw.workspace),
    ...(raw.executionWorkspace === undefined ? {} : {
      executionWorkspace: hostText(raw.executionWorkspace, 4096)
    }),
    ...(raw.executionWorkspaceIdentity === undefined ? {} : {
      executionWorkspaceIdentity: hostText(raw.executionWorkspaceIdentity, 4608)
    }),
    ...(owner ? { owner: { processId: hostInteger(owner.processId, 1),
      incarnation: hostText(owner.incarnation, 64) } } : {}),
    installedPluginId: hostText(raw.installedPluginId),
    packageDigest: hostDigest(raw.packageDigest),
    threadId: hostText(raw.threadId),
    threadIncarnation: hostText(raw.threadIncarnation),
    requestId: hostText(raw.requestId),
    inputDigest: hostDigest(raw.inputDigest),
    status: raw.status as LegacyProjectOperation["status"],
    startedAt: timestamp(raw.startedAt),
    settledAt: raw.settledAt === null ? null : timestamp(raw.settledAt),
    terminalCode: raw.terminalCode === null ? null : hostText(raw.terminalCode),
    ...(reconciliation ? { reconciliation: {
      reviewedRevision: hostDigest(reconciliation.reviewedRevision),
      reviewedAt: timestamp(reconciliation.reviewedAt),
      actor: "desktop-user"
    } } : {}),
    businessStateValidity: "unknown"
  }
}

export function legacyRecoveryRevision(record: LegacyProjectOperation): string {
  return runtimeDigest(JSON.stringify(record))
}

export function readLegacyRecoveryInput(value: unknown): LegacyProjectRecoveryInput {
  const raw = hostRecord(value, ["projectId", "operationId", "expectedRevision", "checkedOriginalResult"])
  if (raw.checkedOriginalResult !== true) hostStateError("LEGACY_RECOVERY_REVIEW_REQUIRED")
  return {
    projectId: hostText(raw.projectId),
    operationId: hostText(raw.operationId),
    expectedRevision: hostDigest(raw.expectedRevision),
    checkedOriginalResult: true
  }
}

export const legacyOperationOwner = { processId: process.pid, incarnation: randomUUID() }

export class LegacyBindingGenerationError extends Error {
  constructor() {
    super("PROJECT_LEGACY_RUNTIME_UNAVAILABLE: 无法核对已保留的插件绑定，请恢复原运行记录。")
  }
}

function operationOwnerAlive(owner: LegacyProjectOperation["owner"]): boolean {
  if (!owner) return false
  try {
    process.kill(owner.processId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/** Cross-instance admission and durable result accounting, never a writer of plugin business state. */
export class LegacyOperationStore {
  private db: DatabaseSync
  private tickets = new WeakMap<object, string>()
  constructor(
    path: string,
    private readonly now = () => Date.now(),
    private readonly workspaceModeGuard?: ProjectWorkspaceModeGuard,
    private readonly compositionGuard?: <T>(workspace: string, work: () => T) => T,
    private readonly optInIndex?: LegacyOptInIndex
  ) {
    const existing = lstatSync(path, { throwIfNoEntry: false })
    if (existing && !existing.isFile()) hostStateError("LEGACY_LEDGER_INVALID")
    this.db = new DatabaseSync(path)
    try {
      // Only a genuinely new ledger can create empty ownership tables.
      if (existing && this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
        AND name IN ('legacy_bindings','legacy_operations')`).all().length !== 2)
        hostStateError("LEGACY_LEDGER_INVALID")
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS legacy_bindings (project_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, plugin_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS legacy_binding_scope ON legacy_bindings(workspace,plugin_id);
        CREATE TABLE IF NOT EXISTS legacy_opt_in_generations (project_id TEXT PRIMARY KEY, generation TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS legacy_opt_in_disabled (project_id TEXT PRIMARY KEY, generation TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS legacy_import_freezes (project_id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS legacy_operations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_id TEXT NOT NULL, workspace TEXT NOT NULL, plugin_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(project_id,request_id));
        CREATE UNIQUE INDEX IF NOT EXISTS legacy_active_scope ON legacy_operations(workspace,plugin_id) WHERE status IN ('started','unknown');`)
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  close(): void {
    this.db.close()
  }
  private transaction<T>(work: () => T, workspace?: string, executionWorkspace = workspace): T {
    if (workspace && executionWorkspace) {
      const commit = () => this.workspaceModeGuard
        ? this.workspaceModeGuard.run("legacy", workspace, () => this.transaction(work), executionWorkspace)
        : this.transaction(work)
      const guard = this.compositionGuard
      if (!guard) return commit()
      return guard(workspace, () => executionWorkspace === workspace ? commit() : guard(executionWorkspace, commit))
    }
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = work()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
  private writeOptInIndex(activating?: { projectId: string; generation: string }): void {
    if (!this.optInIndex) return
    const previous = this.optInIndex.read()
    if (!previous && this.optInIndex.exists()) throw Error("PROJECT_LEGACY_OPT_IN_INDEX_UNAVAILABLE")
    const bound = new Set(this.db.prepare("SELECT project_id FROM legacy_bindings").all()
      .map((row) => hostText(row.project_id)))
    const disabled = this.db.prepare("SELECT project_id,generation FROM legacy_opt_in_disabled").all()
    if (!previous && (disabled.length ||
      this.db.prepare("SELECT 1 FROM legacy_opt_in_generations WHERE project_id<>? LIMIT 1")
        .get(activating?.projectId ?? "")))
      throw Error("PROJECT_LEGACY_OPT_IN_INDEX_UNAVAILABLE")
    const projects = new Map(previous)
    if (activating) {
      if (projects.has(activating.projectId)) throw new LegacyBindingGenerationError()
      projects.set(activating.projectId, activating.generation)
    }
    // Only a healthy pre-index ledger can establish an initial generation for old bindings.
    if (!previous) {
      const record = this.db.prepare("INSERT INTO legacy_opt_in_generations VALUES (?, ?)")
      for (const project of bound) {
        if (project === activating?.projectId) continue
        const generation = randomUUID()
        record.run(project, generation)
        projects.set(project, generation)
      }
    }
    for (const row of disabled) {
      const project = hostText(row.project_id)
      if (!bound.has(project) && projects.get(project) === hostText(row.generation, 64))
        projects.delete(project)
    }
    this.optInIndex.write(projects)
  }
  refreshOptInIndex(): void {
    if (this.optInIndex) this.transaction(() => this.writeOptInIndex())
  }
  protectsProject(projectId: string): boolean {
    if (!this.optInIndex) return false
    // A missing binding is insufficient when another instance could have already published opt-in.
    return this.optInIndex.read()?.has(projectId) !== false
  }
  getBinding(projectId: string): LegacyProjectRuntimeBinding | undefined {
    const row = this.db
      .prepare(`SELECT b.data,g.generation FROM legacy_bindings b
        LEFT JOIN legacy_opt_in_generations g ON g.project_id=b.project_id WHERE b.project_id=?`)
      .get(projectId)
    if (!row) return undefined
    if (this.optInIndex && (typeof row.generation !== "string" ||
      this.optInIndex.read()?.get(projectId) !== row.generation))
      throw new LegacyBindingGenerationError()
    return binding(JSON.parse(String(row.data)))
  }
  listBindings(): LegacyProjectRuntimeBinding[] {
    const rows = this.db.prepare("SELECT data FROM legacy_bindings ORDER BY project_id LIMIT 201").all()
    if (rows.length > 200) hostStateError("LEGACY_IMPORT_SOURCE_LIMIT")
    return rows.map(row => binding(JSON.parse(String(row.data))))
  }
  importFreeze(projectId: string): { source: LegacyProjectRuntimeBinding; reviewDigest: string; frozenAt: number; review?: HostLegacyImportReview } | undefined {
    const row = this.db.prepare("SELECT data FROM legacy_import_freezes WHERE project_id=?").get(projectId)
    if (!row) return undefined
    const value = JSON.parse(String(row.data))
    const raw = hostRecord(value, ["source", "reviewDigest", "frozenAt", ...(Object.hasOwn(value, "review") ? ["review"] : [])])
    const source = binding(raw.source)
    if (source.projectId !== projectId) hostStateError("LEGACY_IMPORT_FREEZE_INVALID")
    const review = raw.review === undefined ? undefined : parseHostLegacyImportReceipt({
      review: raw.review, confirmedAt: raw.frozenAt, actor: "desktop-user", historicalSuccess: "untrusted-source-only"
    }).review
    if (review && (review.reviewDigest !== raw.reviewDigest || JSON.stringify(review.source) !== JSON.stringify(source)))
      hostStateError("LEGACY_IMPORT_FREEZE_INVALID")
    return { source, reviewDigest: hostDigest(raw.reviewDigest), frozenAt: timestamp(raw.frozenAt), ...(review ? { review } : {}) }
  }
  assertNotFrozen(projectId: string): void {
    if (this.importFreeze(projectId)) hostStateError("LEGACY_PROJECT_FROZEN_FOR_IMPORT")
  }
  freezeForImport(projectId: string, reviewDigest: string, assertCurrent: () => void, review?: HostLegacyImportReview) {
    return this.transaction(() => {
      const previous = this.importFreeze(projectId)
      if (previous) {
        if (previous.reviewDigest !== reviewDigest) hostStateError("LEGACY_IMPORT_REVIEW_CHANGED")
        assertCurrent()
        return previous
      }
      const source = this.getBinding(projectId) ?? hostStateError("LEGACY_BINDING_MISSING")
      if (this.db.prepare("SELECT id FROM legacy_operations WHERE project_id=? AND status IN ('started','unknown')").get(projectId))
        hostStateError("LEGACY_OPERATION_ACTIVE")
      assertCurrent()
      if (review) {
        parseHostLegacyImportReceipt({ review, confirmedAt: this.now(), actor: "desktop-user", historicalSuccess: "untrusted-source-only" })
        if (review.reviewDigest !== reviewDigest || JSON.stringify(review.source) !== JSON.stringify(source))
          hostStateError("LEGACY_IMPORT_FREEZE_INVALID")
      }
      const frozen = { source, reviewDigest: hostDigest(reviewDigest), frozenAt: this.now(), ...(review ? { review: structuredClone(review) } : {}) }
      this.db.prepare("INSERT INTO legacy_import_freezes VALUES (?,?)").run(projectId, JSON.stringify(frozen))
      return frozen
    })
  }
  enable(
    input: Omit<LegacyProjectRuntimeBinding, "schemaVersion" | "enabledAt">
  ): LegacyProjectRuntimeBinding {
    const next = binding({ ...input, schemaVersion: 1, enabledAt: this.now() })
    return this.transaction(() => {
      this.assertNotFrozen(next.projectId)
      const previous = this.getBinding(next.projectId)
      if (previous) {
        if (
          JSON.stringify({ ...previous, enabledAt: 0 }) !==
          JSON.stringify({ ...next, enabledAt: 0 })
        )
          hostStateError("LEGACY_BINDING_ALREADY_FIXED")
        return previous
      }
      if (this.optInIndex?.read()?.has(next.projectId))
        throw Error("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
      this.db
        .prepare("INSERT INTO legacy_bindings VALUES (?,?,?,?)")
        .run(next.projectId, next.workspace, next.installedPluginId, JSON.stringify(next))
      // Publish the positive marker before committing opt-in. A failed commit can only overprotect.
      if (this.optInIndex) {
        const generation = randomUUID()
        this.db.prepare("INSERT INTO legacy_opt_in_generations VALUES (?, ?)").run(next.projectId, generation)
        this.writeOptInIndex({ projectId: next.projectId, generation })
      }
      return next
    }, next.workspace)
  }
  get(id: string): LegacyProjectOperation | undefined {
    const row = this.db.prepare("SELECT data FROM legacy_operations WHERE id=?").get(id)
    return row ? operation(JSON.parse(String(row.data))) : undefined
  }
  /** Removes only opt-in routing. History and unknown ownership are never discarded. */
  disable(projectId: string): void {
    this.transaction(() => {
      this.assertNotFrozen(projectId)
      if (
        this.db
          .prepare(
            "SELECT id FROM legacy_operations WHERE project_id=? AND status IN ('started','unknown')"
          )
          .get(projectId)
      )
        hostStateError("LEGACY_OPERATION_ACTIVE")
      if (!this.getBinding(projectId)) return
      if (this.optInIndex) {
        const generation = hostText(this.db.prepare("SELECT generation FROM legacy_opt_in_generations WHERE project_id=?")
          .get(projectId)?.generation, 64)
        this.db.prepare("INSERT OR REPLACE INTO legacy_opt_in_disabled VALUES (?,?)")
          .run(projectId, generation)
      }
      this.db.prepare("DELETE FROM legacy_bindings WHERE project_id=?").run(projectId)
      this.db.prepare("DELETE FROM legacy_opt_in_generations WHERE project_id=?").run(projectId)
    })
    // Re-read under the ledger write lock to retain any concurrent newly enabled binding.
    try { this.refreshOptInIndex() }
    catch (error) { console.warn("[LegacyProjectRuntime] Could not refresh the opt-in index:", error) }
  }
  list(projectId: string, limit = 50): LegacyProjectOperation[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      hostStateError("LEGACY_LEDGER_LIMIT")
    return this.db
      .prepare("SELECT data FROM legacy_operations WHERE project_id=? ORDER BY rowid DESC LIMIT ?")
      .all(projectId, limit)
      .map((row) => operation(JSON.parse(String(row.data))))
  }
  admit(
    input: Pick<
      LegacyProjectOperation,
      | "projectId"
      | "featureId"
      | "workspace"
      | "executionWorkspace"
      | "executionWorkspaceIdentity"
      | "owner"
      | "installedPluginId"
      | "packageDigest"
      | "threadId"
      | "threadIncarnation"
      | "requestId"
      | "inputDigest"
    >
  ): { operation: LegacyProjectOperation; ticket: object } {
    const next = operation({
      ...input,
      schemaVersion: 1,
      operationId: randomUUID(),
      status: "started",
      startedAt: this.now(),
      settledAt: null,
      terminalCode: null,
      businessStateValidity: "unknown"
    })
    const executionWorkspace = next.executionWorkspace ?? next.workspace
    const result = this.transaction(() => {
      this.assertNotFrozen(next.projectId)
      const owner = this.getBinding(next.projectId)
      if (
        !owner ||
        owner.workspace !== next.workspace ||
        owner.installedPluginId !== next.installedPluginId ||
        owner.packageDigest !== next.packageDigest
      )
        hostStateError("LEGACY_BINDING_CHANGED")
      if (
        this.db
          .prepare("SELECT id FROM legacy_operations WHERE project_id=? AND request_id=?")
          .get(next.projectId, next.requestId)
      )
        hostStateError("LEGACY_OPERATION_ALREADY_RECORDED")
      if (
        this.db
          .prepare(
            `SELECT id FROM legacy_operations WHERE status IN ('started','unknown')
             AND (project_id=? OR (plugin_id=? AND
               (workspace IN (?,?) OR json_extract(data,'$.executionWorkspace') IN (?,?))))`
          )
          .get(next.projectId, next.installedPluginId, next.workspace, executionWorkspace,
            next.workspace, executionWorkspace)
      )
        hostStateError("LEGACY_OPERATION_ACTIVE")
      this.db
        .prepare("INSERT INTO legacy_operations VALUES (?,?,?,?,?,?,?)")
        .run(
          next.operationId,
          next.projectId,
          next.requestId,
          next.workspace,
          next.installedPluginId,
          next.status,
          JSON.stringify(next)
        )
      return next
    }, next.workspace, executionWorkspace)
    const ticket = Object.freeze({})
    this.tickets.set(ticket, result.operationId)
    return { operation: result, ticket }
  }
  settle(
    ticket: object,
    status: Exclude<LegacyProjectOperation["status"], "started" | "reconciled">,
    code: string
  ): LegacyProjectOperation {
    const id = this.tickets.get(ticket) ?? hostStateError("LEGACY_TICKET_INVALID")
    return this.transaction(() => {
      const current = this.get(id) ?? hostStateError("LEGACY_OPERATION_MISSING")
      if (current.status !== "started") hostStateError("LEGACY_OPERATION_SETTLED")
      const next = operation({ ...current, status, terminalCode: code, settledAt: this.now() })
      this.db
        .prepare("UPDATE legacy_operations SET status=?,data=? WHERE id=?")
        .run(status, JSON.stringify(next), id)
      return next
    })
  }
  reconcile(input: LegacyProjectRecoveryInput, assertCurrent: () => void): LegacyProjectOperation {
    return this.transaction(() => {
      const current = this.get(input.operationId)
      if (!current || current.projectId !== input.projectId || input.checkedOriginalResult !== true)
        hostStateError("LEGACY_RECOVERY_REVIEW_CHANGED")
      if (current.reconciliation?.reviewedRevision === input.expectedRevision) return current
      if (current.status !== "unknown" || legacyRecoveryRevision(current) !== input.expectedRevision)
        hostStateError("LEGACY_RECOVERY_REVIEW_CHANGED")
      if (
        current.owner &&
        (current.owner.processId !== legacyOperationOwner.processId ||
          current.owner.incarnation !== legacyOperationOwner.incarnation) &&
        operationOwnerAlive(current.owner)
      ) hostStateError("LEGACY_OPERATION_ACTIVE")
      this.assertNotFrozen(input.projectId)
      const owner = this.getBinding(input.projectId)
      if (!owner || owner.workspace !== current.workspace || owner.packageDigest !== current.packageDigest ||
        owner.installedPluginId !== current.installedPluginId)
        hostStateError("LEGACY_BINDING_CHANGED")
      assertCurrent()
      const next = operation({
        ...current,
        status: "reconciled",
        reconciliation: { actor: "desktop-user", reviewedAt: this.now(), reviewedRevision: input.expectedRevision }
      })
      const updated = this.db
        .prepare("UPDATE legacy_operations SET status=?,data=? WHERE id=? AND status='unknown'")
        .run(next.status, JSON.stringify(next), next.operationId)
      if (updated.changes !== 1) hostStateError("LEGACY_RECOVERY_REVIEW_CHANGED")
      return next
    })
  }
  /** Startup only. No run is resumed and no unknown side effect relinquishes its scope. */
  recoverInterrupted(): string[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare("SELECT data FROM legacy_operations WHERE status='started'")
        .all()
      return rows.flatMap((row) => {
        const original = operation(JSON.parse(String(row.data)))
        if (operationOwnerAlive(original.owner)) return []
        const next = operation({ ...original, status: "unknown" })
        this.db
          .prepare("UPDATE legacy_operations SET status='unknown',data=? WHERE id=?")
          .run(JSON.stringify(next), next.operationId)
        return [next.operationId]
      })
    })
  }
}
