import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ProjectWorkspaceModeGuard } from "./workspace-mode-guard"
import { parseHostLegacyImportReceipt } from "./legacy-import-protocol"
import { effectiveHostResultApproval } from "../../../shared/project-runtime/import-approval-policy"
import type {
  HostActionPrepareInput,
  HostActionResult,
  HostExecutionTicket,
  HostProjectCreateInput,
  HostProjectOperation,
  HostProjectState,
  HostContextProviderApproval,
  HostResultApprovalInput,
  HostResultReview
} from "../../../shared/project-runtime/host-types"
import type { HostExecutionTerminal } from "../../../shared/project-runtime/host-types"
import { parseHostCheckDiagnostics } from "./host-check-diagnostics"
import { captureHostResultFeedbackSource } from "./host-result-feedback"
import type { HostLegacyImportReceipt } from "../../../shared/project-runtime/host-types"
import {
  hostDigest,
  hostInteger,
  hostRecord,
  hostStateError,
  hostText,
  parseHostOperation,
  parseHostProjectState,
  parseHostReceipt,
  parseHostContextProvider,
  parseHostContextProviderApproval,
  hostResultReview,
  assertHostResultReview,
  parseHostResultFeedback,
  parseHostStageInstructions
} from "./host-state-protocol"

const ACTIVE_STATUSES = ["prepared", "started", "cancel_requested", "succeeded", "unknown"]

/** Local host projects only. Never use this database as an alternate legacy plugin state store. */
export class HostProjectStore {
  private readonly db: DatabaseSync
  private readonly tickets = new WeakMap<HostExecutionTicket, string>()

  constructor(
    path: string,
    private readonly now = () => Date.now(),
    private readonly workspaceModeGuard?: ProjectWorkspaceModeGuard,
    private readonly compositionGuard?: <T>(workspace: string, work: () => T) => T
  ) {
    if (!isAbsolute(path)) hostStateError("DATABASE_PATH_INVALID")
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path, { timeout: 1000 })
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS project_runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS host_projects (
            id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS host_operations (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES host_projects(id),
            idempotency_key TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
            owner_nonce TEXT, transition_result TEXT, UNIQUE(project_id, idempotency_key)
          );
          CREATE UNIQUE INDEX IF NOT EXISTS host_one_active_operation ON host_operations(project_id)
            WHERE status IN ('prepared','started','cancel_requested','succeeded','unknown');
          CREATE TABLE IF NOT EXISTS host_plan_migrations (
            project_id TEXT NOT NULL REFERENCES host_projects(id), version INTEGER NOT NULL,
            data TEXT NOT NULL, PRIMARY KEY(project_id,version)
          );
          CREATE TABLE IF NOT EXISTS host_legacy_imports (
            project_id TEXT PRIMARY KEY REFERENCES host_projects(id), data TEXT NOT NULL
          );
        `)
        const schema = this.db
          .prepare("SELECT value FROM project_runtime_meta WHERE key='schema'")
          .get()
        if (schema && schema.value !== "1") hostStateError("SCHEMA_VERSION_UNSUPPORTED")
        this.db
          .prepare("INSERT OR IGNORE INTO project_runtime_meta(key,value) VALUES ('schema','1')")
          .run()
      })
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  private transaction<T>(work: () => T, workspace?: string): T {
    if (workspace && this.compositionGuard)
      return this.compositionGuard(workspace, () =>
        this.workspaceModeGuard
          ? this.workspaceModeGuard.run("host", workspace, () => this.transaction(work))
          : this.transaction(work)
      )
    if (workspace && this.workspaceModeGuard)
      return this.workspaceModeGuard.run("host", workspace, () => this.transaction(work))
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

  get(projectId: string): HostProjectState | undefined {
    const row = this.db
      .prepare("SELECT id,version,data FROM host_projects WHERE id=?")
      .get(hostText(projectId))
    if (!row) return undefined
    const state = parseHostProjectState(JSON.parse(String(row.data)))
    if (state.projectId !== row.id || state.version !== row.version)
      hostStateError("STORAGE_MISMATCH")
    return state
  }

  listProjects(limit = 50, afterProjectId = ""): HostProjectState[] {
    hostInteger(limit, 1)
    if (limit > 200) hostStateError("LIMIT_INVALID")
    if (afterProjectId) hostText(afterProjectId)
    return this.db
      .prepare("SELECT id FROM host_projects WHERE id>? ORDER BY id LIMIT ?")
      .all(afterProjectId, limit)
      .map((row) => this.requireProject(String(row.id)))
  }

  getOperation(operationId: string): HostProjectOperation | undefined {
    const row = this.db
      .prepare("SELECT id,project_id,idempotency_key,status,data FROM host_operations WHERE id=?")
      .get(hostText(operationId))
    if (!row) return undefined
    return this.parseOperationRow(row)
  }

  private parseOperationRow(row: Record<string, unknown>): HostProjectOperation {
    const operation = parseHostOperation(JSON.parse(String(row.data)))
    if (
      operation.operationId !== row.id ||
      operation.projectId !== row.project_id ||
      operation.idempotencyKey !== row.idempotency_key ||
      operation.status !== row.status
    )
      hostStateError("STORAGE_MISMATCH")
    return operation
  }

  listOperations(projectId: string, limit = 50): HostProjectOperation[] {
    hostInteger(limit, 1)
    if (limit > 200) hostStateError("LIMIT_INVALID")
    return this.db
      .prepare("SELECT id FROM host_operations WHERE project_id=? ORDER BY rowid DESC LIMIT ?")
      .all(hostText(projectId), limit)
      .map((row) => this.requireOperation(String(row.id)))
  }

  /** Preserve the original twenty-row admission window and fail closed on any invalid row.
   * Read once without constructing UI facts, diagnostics or issuing one SQL read per operation.
   */
  getRecentBindingOperation(projectId: string, operationId: string): HostProjectOperation | undefined {
    const rows = this.db.prepare(
      "SELECT id,project_id,idempotency_key,status,data FROM host_operations " +
      "WHERE project_id=? ORDER BY rowid DESC LIMIT 20"
    ).all(hostText(projectId))
    const operations = rows.map(row => this.parseOperationRow(row))
    return operations.find(operation => operation.operationId === operationId)
  }

  findOperation(projectId: string, idempotencyKey: string): HostProjectOperation | undefined {
    const row = this.db
      .prepare("SELECT id FROM host_operations WHERE project_id=? AND idempotency_key=?")
      .get(hostText(projectId), hostText(idempotencyKey))
    return row ? this.requireOperation(String(row.id)) : undefined
  }

  create(input: HostProjectCreateInput): HostProjectState {
    return this.createAtStage(input)
  }

  /** Stable boundary only; never cancels a live/unknown operation in order to permit migration. */
  assertPlanMigrationBoundary(projectId: string, expectedVersion: number): HostProjectState {
    const project = this.requireProject(projectId)
    this.assertImportPrefixComplete(projectId)
    if (project.version !== expectedVersion || project.status !== "active") hostStateError("VERSION_CONFLICT")
    this.assertWorkspaceAvailable(project)
    return project
  }

  lastStageTransition(projectId: string, stageId: string) {
    const row = this.db.prepare(`SELECT id,transition_result FROM host_operations
      WHERE project_id=? AND status='transitioned' AND json_extract(data,'$.stageId')=?
      ORDER BY rowid DESC LIMIT 1`).get(hostText(projectId), hostText(stageId))
    if (!row || typeof row.transition_result !== "string") hostStateError("PLAN_MIGRATION_HISTORY_MISSING")
    return { operation: this.requireOperation(String(row.id)),
      project: parseHostProjectState(JSON.parse(row.transition_result)) }
  }

  commitPlanMigration(candidate: HostProjectState, expectedVersion: number,
    review: import("../../../shared/project-runtime/host-types").HostPlanMigrationReview,
    assertCurrent: () => void): HostProjectState {
    return this.transaction(() => {
      const current = this.assertPlanMigrationBoundary(candidate.projectId, expectedVersion)
      const next = parseHostProjectState({ ...current,
        packageVersion: candidate.packageVersion, pluginDigest: candidate.pluginDigest,
        manifest: candidate.manifest, version: current.version + 1, updatedAt: this.now() })
      if (review.projectId !== current.projectId || review.expectedVersion !== current.version ||
        review.sourceDigest !== current.pluginDigest || review.targetDigest !== next.pluginDigest ||
        review.targetVersion !== next.packageVersion || next.stageIndex >= next.manifest.stages.length)
        hostStateError("PLAN_MIGRATION_REVIEW_CHANGED")
      assertCurrent()
      this.assertImportPrefixComplete(current.projectId)
      this.db.prepare("INSERT INTO host_plan_migrations(project_id,version,data) VALUES (?,?,?)")
        .run(next.projectId, next.version, JSON.stringify({ review, previous: current, next, actor: "desktop-user" }))
      const result = this.db.prepare("UPDATE host_projects SET version=?,data=? WHERE id=? AND version=?")
        .run(next.version, JSON.stringify(next), next.projectId, expectedVersion)
      if (result.changes !== 1) hostStateError("VERSION_CONFLICT")
      return next
    }, candidate.workspace)
  }

  /** Main-only branch construction after service-owned baseline admission, never a stage advance. */
  createBranch(input: HostProjectCreateInput, stageId: string,
    source: { projectId: string; expectedVersion: number }): HostProjectState {
    hostText(stageId)
    return this.createAtStage(input, stageId, undefined, () => {
      const project = this.requireProject(hostText(source.projectId))
      if (project.version !== source.expectedVersion) hostStateError("BRANCH_SOURCE_CHANGED")
      this.assertImportPrefixComplete(project.projectId, stageId)
    })
  }
  /** Import review remains mandatory until every original prefix stage has crossed its new gates. */
  assertImportPrefixComplete(projectId: string, branchStageId?: string): void {
    const receipt = this.importedSource(projectId)
    if (receipt?.review.protocol !== "devclaw.host-legacy-import/v2") return
    const project = this.requireProject(projectId)
    if (project.stageIndex < receipt.review.prefixStageIds.length ||
      receipt.review.prefixStageIds.some((id, index) => project.manifest.stages[index]?.id !== id))
      hostStateError("IMPORT_REVALIDATION_PENDING")
    if (branchStageId && receipt.review.prefixStageIds.includes(branchStageId))
      hostStateError("IMPORT_PREFIX_BRANCH_UNSUPPORTED")
  }
  importedSource(projectId: string): HostLegacyImportReceipt | undefined {
    const row = this.db.prepare("SELECT data FROM host_legacy_imports WHERE project_id=?").get(projectId)
    if (!row) return undefined
    const receipt = parseHostLegacyImportReceipt(JSON.parse(String(row.data)))
    if (receipt.review.target.projectId !== projectId) hostStateError("IMPORT_RECEIPT_INVALID")
    return receipt
  }
  createImported(input: HostProjectCreateInput, receipt: HostLegacyImportReceipt): HostProjectState {
    receipt = parseHostLegacyImportReceipt(receipt)
    if (receipt.review.target.projectId !== input.projectId || receipt.review.targetDigest !== input.pluginDigest)
      hostStateError("IMPORT_TARGET_CHANGED")
    return this.createAtStage(input, undefined, receipt)
  }

  private createAtStage(input: HostProjectCreateInput, stageId?: string, receipt?: HostLegacyImportReceipt,
    assertSource?: () => void): HostProjectState {
    hostRecord(input, [
      "projectId",
      "name",
      "goal",
      "workspace",
      "installedPluginId",
      "packageId",
      "packageVersion",
      "pluginDigest",
      "manifest"
    ])
    if (!isAbsolute(input.workspace)) hostStateError("WORKSPACE_INVALID")
    const timestamp = this.now()
    let state = parseHostProjectState({
      ...input,
      workspace: resolve(input.workspace),
      schemaVersion: 1,
      stateOwner: "host",
      version: 1,
      stageIndex: 0,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp
    })
    if (stageId !== undefined) {
      const stageIndex = state.manifest.stages.findIndex((stage) => stage.id === stageId)
      if (stageIndex < 0) hostStateError("BRANCH_STAGE_MISSING")
      state = parseHostProjectState({ ...state, stageIndex })
    }
    return this.transaction(() => {
      assertSource?.()
      if (this.get(state.projectId)) hostStateError("PROJECT_EXISTS")
      this.db
        .prepare("INSERT INTO host_projects(id,version,data) VALUES (?,?,?)")
        .run(state.projectId, state.version, JSON.stringify(state))
      if (receipt) this.db.prepare("INSERT INTO host_legacy_imports VALUES (?,?)")
        .run(state.projectId, JSON.stringify(receipt))
      return state
    }, state.workspace)
  }

  /** Persist an explicitly requested operation. Unlike P1 prepareAction, this records intent. */
  prepare(input: HostActionPrepareInput): HostProjectOperation {
    hostRecord(input, [
      "projectId",
      "expectedVersion",
      "stageId",
      "idempotencyKey",
      "inputFingerprint",
      ...(Object.hasOwn(input, "contextProvider") ? ["contextProvider"] : []),
      ...(Object.hasOwn(input, "stageInstructions") ? ["stageInstructions"] : [])
    ])
    hostText(input.projectId)
    hostInteger(input.expectedVersion, 1)
    hostText(input.stageId)
    hostText(input.idempotencyKey)
    hostDigest(input.inputFingerprint)
    if (Object.hasOwn(input, "contextProvider")) parseHostContextProvider(input.contextProvider)
    const stageInstructions = parseHostStageInstructions(input.stageInstructions)
    input = { ...input }
    delete input.stageInstructions
    if (stageInstructions) input.stageInstructions = stageInstructions
    return this.transaction(() => {
      const previous = this.db
        .prepare("SELECT id FROM host_operations WHERE project_id=? AND idempotency_key=?")
        .get(input.projectId, input.idempotencyKey)
      if (previous) {
        const operation = this.requireOperation(String(previous.id))
        if (
          operation.expectedVersion !== input.expectedVersion ||
          operation.stageId !== input.stageId ||
          operation.inputFingerprint !== input.inputFingerprint ||
          operation.stageInstructions !== stageInstructions ||
          JSON.stringify(operation.contextProvider) !== JSON.stringify(input.contextProvider)
        )
          hostStateError("IDEMPOTENCY_CONFLICT")
        return operation
      }
      const state = this.requireProject(input.projectId)
      this.assertCurrent(state, input)
      const active = this.db
        .prepare(
          `SELECT id FROM host_operations WHERE project_id=?
        AND status IN ('prepared','started','cancel_requested','succeeded','unknown')`
        )
        .get(input.projectId)
      if (active) hostStateError("OPERATION_ACTIVE")
      this.assertWorkspaceAvailable(state)
      const timestamp = this.now()
      const operation: HostProjectOperation = {
        ...input,
        schemaVersion: 1,
        operationId: randomUUID(),
        pluginDigest: state.pluginDigest,
        status: "prepared",
        createdAt: timestamp,
        updatedAt: timestamp,
        cancelRequestedAt: null,
        startedAt: null,
        execution: null,
        approval: null,
        resultApproval: null,
        receipts: []
      }
      const feedbackSource = captureHostResultFeedbackSource(operation, this.listOperations(state.projectId, 200))
      if (feedbackSource) operation.resultFeedbackSource = feedbackSource
      this.db
        .prepare(
          "INSERT INTO host_operations(id,project_id,idempotency_key,status,data) VALUES (?,?,?,?,?)"
        )
        .run(
          operation.operationId,
          operation.projectId,
          operation.idempotencyKey,
          operation.status,
          JSON.stringify(operation)
        )
      return operation
    }, this.requireProject(input.projectId).workspace)
  }

  decideApproval(
    operationId: string,
    input: {
      expectedVersion: number
      inputFingerprint: string
      decision: "approved" | "rejected"
      actorId: string
      contextProviderApproval?: HostContextProviderApproval
    }
  ): HostProjectOperation {
    hostRecord(input, [
      "expectedVersion",
      "inputFingerprint",
      "decision",
      "actorId",
      ...(Object.hasOwn(input, "contextProviderApproval") ? ["contextProviderApproval"] : [])
    ])
    return this.transaction(() => {
      const operation = this.requireOperation(operationId)
      const state = this.requireProject(operation.projectId)
      this.assertCurrent(state, operation)
      const providerApproval =
        input.contextProviderApproval !== undefined
          ? parseHostContextProviderApproval(
              input.contextProviderApproval,
              operation.contextProvider?.policyDigest
            )
          : undefined
      if (operation.contextProvider && input.decision === "approved" && !providerApproval)
        hostStateError("CONTEXT_PROVIDER_APPROVAL_REQUIRED")
      if (
        operation.status !== "prepared" ||
        input.expectedVersion !== operation.expectedVersion ||
        input.inputFingerprint !== operation.inputFingerprint ||
        !["approved", "rejected"].includes(input.decision)
      )
        hostStateError("APPROVAL_MISMATCH")
      if (operation.approval) {
        if (
          operation.approval.decision !== input.decision ||
          operation.approval.actorId !== input.actorId ||
          JSON.stringify(operation.approval.contextProviderApproval) !==
            JSON.stringify(providerApproval)
        )
          hostStateError("APPROVAL_ALREADY_DECIDED")
        return operation
      }
      operation.approval = {
        decision: input.decision,
        actorId: hostText(input.actorId),
        decidedAt: this.now(),
        operationId,
        expectedVersion: operation.expectedVersion,
        inputFingerprint: operation.inputFingerprint,
        ...(providerApproval ? { contextProviderApproval: providerApproval } : {})
      }
      if (input.decision === "rejected") operation.status = "cancelled"
      return this.saveOperation(operation)
    })
  }

  /** Main-process only. Ticket object identity prevents forged receipt/result submissions. */
  start(operationId: string, currentInputFingerprint: string): HostExecutionTicket {
    return this.transaction(
      () => {
        const operation = this.requireOperation(operationId)
        const state = this.requireProject(operation.projectId)
        this.assertCurrent(state, operation)
        this.assertInput(operation, currentInputFingerprint)
        if (operation.status !== "prepared") hostStateError("OPERATION_NOT_PREPARED")
        this.assertWorkspaceAvailable(state, operationId)
        this.assertApproval(state, operation)
        operation.status = "started"
        operation.startedAt = this.now()
        this.saveOperation(operation)
        return this.issueTicket(operation)
      },
      this.requireProject(this.requireOperation(operationId).projectId).workspace
    )
  }

  recordResult(ticket: HostExecutionTicket, result: HostActionResult): HostProjectOperation {
    return this.transaction(() => {
      const operation = this.requireTicket(ticket)
      if (operation.status !== "started" && operation.status !== "cancel_requested")
        hostStateError("RESULT_ALREADY_RECORDED")
      const updated = this.applyResult(operation, result)
      this.tickets.delete(ticket)
      return updated
    })
  }

  /** Main-only checkpoint continuation; never retries an unknown action or creates another operation. */
  resumeInterrupted(operationId: string, currentInputFingerprint: string): HostExecutionTicket {
    return this.transaction(() => {
      const operation = this.requireOperation(operationId)
      const state = this.requireProject(operation.projectId)
      this.assertCurrent(state, operation)
      this.assertInput(operation, currentInputFingerprint)
      this.assertApproval(state, operation)
      if (operation.status !== "unknown" || operation.cancelRequestedAt !== null ||
        !operation.execution || operation.receipts.length ||
        (operation.execution.terminal && operation.execution.terminal.code !== "host_user_input_waiting"))
        hostStateError("INPUT_RESUME_UNSAFE")
      this.assertWorkspaceAvailable(state, operationId)
      operation.status = "started"
      operation.execution.terminal = null
      this.saveOperation(operation)
      return this.issueTicket(operation)
    }, this.requireProject(this.requireOperation(operationId).projectId).workspace)
  }

  bindExecutionThread(ticket: HostExecutionTicket, threadId: string): void {
    this.transaction(() => {
      const operation = this.requireTicket(ticket)
      if (operation.status !== "started" || operation.execution)
        hostStateError("EXECUTION_ALREADY_BOUND")
      operation.execution = { threadId: hostText(threadId), terminal: null }
      this.saveOperation(operation)
    })
  }

  recordExecutionTerminal(
    ticket: HostExecutionTicket,
    terminal: HostExecutionTerminal
  ): void {
    this.transaction(() => {
      const operation = this.requireTicket(ticket)
      if (
        !["started", "cancel_requested"].includes(operation.status) ||
        !operation.execution ||
        operation.execution.terminal
      )
        hostStateError("EXECUTION_TERMINAL_INVALID")
      const diagnostics = terminal.checkDiagnostics && parseHostCheckDiagnostics(terminal.checkDiagnostics)
      const project = this.requireProject(operation.projectId)
      if (diagnostics && (terminal.outcome !== "error" || diagnostics.some(item =>
        item.inputFingerprint !== operation.inputFingerprint ||
        !project.manifest.stages[project.stageIndex].checkIds.includes(item.checkId) ||
        !project.manifest.checks.some(check => check.id === item.checkId &&
          check.kind === "action" && check.actionId === item.actionId) ||
        !project.manifest.actions.some(action => action.id === item.actionId &&
          action.ref.pluginId === item.provider.pluginId && action.ref.plugin === item.provider.plugin &&
          action.ref.digest === item.provider.digest && action.ref.actionId === item.provider.actionId))))
        hostStateError("CHECK_DIAGNOSTICS_INVALID")
      operation.execution.terminal = { ...terminal,
        ...(diagnostics ? { checkDiagnostics: diagnostics } : {}), settledAt: this.now() }
      this.saveOperation(operation)
    })
  }

  decideResultApproval(operationId: string, input: HostResultApprovalInput): HostProjectOperation {
    hostRecord(input, [
      "operationId",
      "expectedVersion",
      "inputFingerprint",
      "pluginDigest",
      "artifactFingerprint",
      "receiptFingerprint",
      "policyDigest",
      "decision",
      "actorId",
      ...(Object.hasOwn(input, "feedback") ? ["feedback"] : [])
    ])
    const feedback = parseHostResultFeedback(input.feedback, input.decision)
    if (feedback && input.actorId !== "desktop-user") hostStateError("RESULT_FEEDBACK_INVALID")
    return this.transaction(() => {
      const operation = this.requireOperation(operationId)
      const state = this.requireProject(operation.projectId)
      this.assertCurrent(state, operation)
      if (operation.status !== "succeeded") hostStateError("VALIDATION_REQUIRED")
      if (!effectiveHostResultApproval(state.manifest.stages[state.stageIndex], this.importedSource(state.projectId)))
        hostStateError("RESULT_APPROVAL_NOT_REQUIRED")
      assertHostResultReview(hostResultReview(state, operation, input.artifactFingerprint, this.importedSource(state.projectId)), input)
      if (!["approved", "rejected"].includes(input.decision)) hostStateError("SCHEMA_INVALID")
      hostText(input.actorId)
      if (operation.resultApproval) {
        assertHostResultReview(operation.resultApproval, input)
        if (
          operation.resultApproval.decision !== input.decision ||
          operation.resultApproval.actorId !== input.actorId ||
          operation.resultApproval.feedback !== feedback
        )
          hostStateError("RESULT_APPROVAL_ALREADY_DECIDED")
        return operation
      }
      operation.resultApproval = { ...input, decidedAt: this.now() }
      delete operation.resultApproval.feedback
      if (feedback) operation.resultApproval.feedback = feedback
      // Rejection is a business decision about an existing result, not a failed execution.
      return this.saveOperation(operation)
    })
  }

  transition(
    operationId: string,
    currentInputFingerprint: string,
    currentResultReview?: HostResultReview
  ): HostProjectState {
    return this.transaction(() => {
      const operation = this.requireOperation(operationId)
      const state = this.requireProject(operation.projectId)
      this.assertInput(operation, currentInputFingerprint)
      if (operation.status === "transitioned") {
        const row = this.db
          .prepare("SELECT transition_result FROM host_operations WHERE id=?")
          .get(operationId)
        if (typeof row?.transition_result !== "string") hostStateError("STORAGE_MISMATCH")
        return parseHostProjectState(JSON.parse(row.transition_result))
      }
      this.assertCurrent(state, operation)
      this.assertApproval(state, operation)
      if (operation.status !== "succeeded") hostStateError("VALIDATION_REQUIRED")
      const stage = state.manifest.stages[state.stageIndex]
      if (effectiveHostResultApproval(stage, this.importedSource(state.projectId))) {
        if (operation.resultApproval?.decision !== "approved" || !currentResultReview)
          hostStateError("RESULT_APPROVAL_REQUIRED")
        assertHostResultReview(
          hostResultReview(state, operation, currentResultReview.artifactFingerprint, this.importedSource(state.projectId)),
          currentResultReview
        )
        assertHostResultReview(currentResultReview, operation.resultApproval)
      }
      if (
        stage.checkIds.some(
          (checkId) =>
            !operation.receipts.some(
              (receipt) => receipt.checkId === checkId && receipt.result === "passed"
            )
        )
      )
        hostStateError("VALIDATION_REQUIRED")
      const next = parseHostProjectState({
        ...state,
        version: state.version + 1,
        stageIndex: state.stageIndex + 1,
        status: state.stageIndex + 1 === state.manifest.stages.length ? "completed" : "active",
        updatedAt: this.now()
      })
      const result = this.db
        .prepare("UPDATE host_projects SET version=?,data=? WHERE id=? AND version=?")
        .run(next.version, JSON.stringify(next), state.projectId, state.version)
      if (result.changes !== 1) hostStateError("VERSION_CONFLICT")
      operation.status = "transitioned"
      this.saveOperation(operation)
      this.db
        .prepare("UPDATE host_operations SET transition_result=? WHERE id=?")
        .run(JSON.stringify(next), operationId)
      return next
    })
  }

  /** A host preflight failed before start; never alter an operation started by another caller. */
  failPrepared(operationId: string): HostProjectOperation {
    return this.transaction(() => {
      const operation = this.requireOperation(operationId)
      if (operation.status !== "prepared") return operation
      operation.status = "failed"
      return this.saveOperation(operation)
    })
  }

  cancel(operationId: string): HostProjectOperation {
    return this.transaction(() => {
      const operation = this.requireOperation(operationId)
      if (operation.status === "prepared" || operation.status === "succeeded")
        operation.status = "cancelled"
      else if (operation.status === "started") operation.status = "cancel_requested"
      // Unknown writes keep ownership until reconciliation proves their result.
      else if (operation.status !== "unknown") return operation
      operation.cancelRequestedAt ??= this.now()
      return this.saveOperation(operation)
    })
  }

  /** Invoke once at application startup, before admitting any new executor. Never replays work. */
  recoverInterrupted(): string[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT id FROM host_operations WHERE status IN ('started','cancel_requested','unknown')"
        )
        .all()
      return rows.map((row) => {
        const operation = this.requireOperation(String(row.id))
        operation.status = "unknown"
        this.saveOperation(operation)
        this.db
          .prepare("UPDATE host_operations SET owner_nonce=NULL WHERE id=?")
          .run(operation.operationId)
        return operation.operationId
      })
    })
  }

  /** Host-owned read/check callback; it must inspect outcomes, never rerun the original action. */
  async reconcile(
    operationId: string,
    inspect: (operation: HostProjectOperation, state: HostProjectState) => Promise<HostActionResult>,
    assertAuthority?: () => void
  ): Promise<HostProjectOperation> {
    assertAuthority?.()
    const nonce = randomUUID()
    const prepared = this.transaction(() => {
      const operation = this.requireOperation(operationId)
      if (operation.status !== "unknown") hostStateError("RECONCILE_NOT_UNKNOWN")
      const result = this.db
        .prepare("UPDATE host_operations SET owner_nonce=? WHERE id=? AND owner_nonce IS NULL")
        .run(nonce, operationId)
      if (result.changes !== 1) hostStateError("RECONCILE_ACTIVE")
      return { operation, state: this.requireProject(operation.projectId) }
    })
    try {
      const result = await inspect(
        structuredClone(prepared.operation),
        structuredClone(prepared.state)
      )
      return this.transaction(() => {
        assertAuthority?.()
        const row = this.db
          .prepare("SELECT owner_nonce FROM host_operations WHERE id=?")
          .get(operationId)
        const operation = this.requireOperation(operationId)
        if (row?.owner_nonce !== nonce || operation.status !== "unknown")
          hostStateError("RECONCILE_CONFLICT")
        return this.applyResult(operation, result)
      })
    } finally {
      this.db
        .prepare("UPDATE host_operations SET owner_nonce=NULL WHERE id=? AND owner_nonce=?")
        .run(operationId, nonce)
    }
  }

  private requireProject(id: string): HostProjectState {
    return this.get(id) ?? hostStateError("PROJECT_MISSING")
  }
  private requireOperation(id: string): HostProjectOperation {
    return this.getOperation(id) ?? hostStateError("OPERATION_MISSING")
  }
  private assertCurrent(state: HostProjectState, operation: HostActionPrepareInput): void {
    if (
      state.status !== "active" ||
      state.version !== operation.expectedVersion ||
      state.manifest.stages[state.stageIndex]?.id !== operation.stageId
    )
      hostStateError("VERSION_CONFLICT")
  }
  /** The surrounding BEGIN IMMEDIATE makes this check atomic across store instances. */
  private assertWorkspaceAvailable(state: HostProjectState, ownOperationId?: string): void {
    const key = (workspace: string) =>
      process.platform === "win32" ? resolve(workspace).toLowerCase() : resolve(workspace)
    const workspace = key(state.workspace)
    const active = this.db
      .prepare(
        `SELECT o.id,p.data FROM host_operations o
      JOIN host_projects p ON p.id=o.project_id
      WHERE o.status IN ('prepared','started','cancel_requested','succeeded','unknown')`
      )
      .all()
    for (const row of active) {
      if (row.id === ownOperationId) continue
      if (key(parseHostProjectState(JSON.parse(String(row.data))).workspace) === workspace)
        hostStateError("WORKSPACE_OPERATION_ACTIVE")
    }
  }
  private assertInput(operation: HostProjectOperation, fingerprint: string): void {
    if (operation.inputFingerprint !== hostDigest(fingerprint)) hostStateError("INPUT_CHANGED")
  }
  private assertApproval(state: HostProjectState, operation: HostProjectOperation): void {
    if (operation.contextProvider) {
      if (operation.approval?.decision !== "approved")
        hostStateError("CONTEXT_PROVIDER_APPROVAL_REQUIRED")
      parseHostContextProviderApproval(
        operation.approval.contextProviderApproval,
        operation.contextProvider.policyDigest
      )
    }
    if (
      state.manifest.stages[state.stageIndex].approval === "human" &&
      operation.approval?.decision !== "approved"
    )
      hostStateError("APPROVAL_REQUIRED")
  }
  private saveOperation(operation: HostProjectOperation): HostProjectOperation {
    const parsed = parseHostOperation({ ...operation, updatedAt: this.now() })
    this.db
      .prepare("UPDATE host_operations SET status=?,data=? WHERE id=?")
      .run(parsed.status, JSON.stringify(parsed), parsed.operationId)
    return parsed
  }
  private issueTicket(operation: HostProjectOperation): HostExecutionTicket {
    const ticket: HostExecutionTicket = Object.freeze({
      operationId: operation.operationId,
      projectId: operation.projectId,
      stageId: operation.stageId,
      expectedVersion: operation.expectedVersion,
      inputFingerprint: operation.inputFingerprint,
      pluginDigest: operation.pluginDigest
    })
    this.tickets.set(ticket, operation.operationId)
    return ticket
  }
  private requireTicket(ticket: HostExecutionTicket): HostProjectOperation {
    const id = this.tickets.get(ticket)
    if (!id) return hostStateError("TICKET_INVALID")
    return this.requireOperation(id)
  }
  private applyResult(
    operation: HostProjectOperation,
    result: HostActionResult
  ): HostProjectOperation {
    hostRecord(result, ["outcome", "receipts"])
    if (
      !["succeeded", "failed", "unknown", "cancelled"].includes(result.outcome) ||
      !Array.isArray(result.receipts) ||
      result.receipts.length > 64
    )
      hostStateError("RESULT_INVALID")
    const state = this.requireProject(operation.projectId)
    this.assertCurrent(state, operation)
    const stage = state.manifest.stages[state.stageIndex]
    const receipts = result.receipts.map(parseHostReceipt)
    if (
      new Set(receipts.map((receipt) => receipt.checkId)).size !== receipts.length ||
      receipts.some(
        (receipt) =>
          receipt.operationId !== operation.operationId ||
          receipt.projectId !== operation.projectId ||
          receipt.stageId !== operation.stageId ||
          receipt.pluginDigest !== operation.pluginDigest ||
          receipt.inputFingerprint !== operation.inputFingerprint ||
          !stage.checkIds.includes(receipt.checkId) ||
          receipt.checkedAt < operation.createdAt ||
          receipt.checkedAt > this.now()
      )
    )
      hostStateError("RECEIPT_MISMATCH")
    if (operation.cancelRequestedAt !== null && result.outcome !== "unknown") {
      operation.status = "cancelled"
      operation.receipts = []
    } else {
      operation.status =
        result.outcome === "succeeded" &&
        stage.checkIds.some(
          (checkId) =>
            !receipts.some((receipt) => receipt.checkId === checkId && receipt.result === "passed")
        )
          ? "failed"
          : result.outcome
      operation.receipts = receipts
    }
    return this.saveOperation(operation)
  }
}

export { ACTIVE_STATUSES as HOST_ACTIVE_OPERATION_STATUSES }
