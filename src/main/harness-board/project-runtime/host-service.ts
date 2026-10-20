import { readPackageExtensionContract } from "../../plugins/extension-contract"
import type {
  HostActionResult,
  HostExecutionTicket,
  HostProjectOperation,
  HostProjectState
} from "../../../shared/project-runtime/host-types"
import { HostProjectCoordinator } from "./host-coordinator"
import { HostPackageSnapshots } from "./package-snapshots"
import { assertStageBranchSourceCompatible } from "./stage-branch-compatibility"
import { HostProjectStore } from "./host-store"
import { hostGoal, hostRecord, hostStateError, hostText } from "./host-state-protocol"
import {
  assertHostReceiptsCurrent,
  fingerprintHostStageInput,
  validateHostStage
} from "./host-validators"
import { readRuntimeScopedFile, runtimeDigest, runtimeDirectory } from "./safe-files"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import { assertHostPackageSupported } from "./package-preflight"
import { withSnapshotRetention } from "./snapshot-retention"
import { readHostActionCheckEvidence } from "./action-check-evidence"
import {
  prepareProjectRuntimeInputIdentity,
  projectRuntimeInputIdentity,
  captureProjectRuntimeInputAuthorityIdentity
} from "../project-action-runtime"

export interface HostInstalledPackage {
  installedPluginId: string
  root: string
  packageId: string
  packageVersion: string
  enabled: boolean
}

export interface HostStageBranchInput {
  baselineId: string
  sourceProjectId: string
  expectedSourceVersion: number
  stageId: string
  projectId: string
  name: string
  workspace: string
  installedPluginId: string
  goal: string
}

export interface HostStageBranchAdmissionContext {
  input: Readonly<HostStageBranchInput>
  source: HostProjectState
  candidate: HostProjectState
  sourceSnapshotRoot: string
  candidateSnapshotRoot: string
}

export type HostProjectCommandKind =
  | "prepare" | "approve" | "start" | "validate" | "advance" | "reconcile" | "cancel"

export interface HostSkillExecutionContext {
  /** Main-only file-scoped debug policy; never restored from a renderer request or old approval. */
  stageDebug?: { workspace: string; baselineId: string }
  /** Main-only directory visibility for an engine unit owned by a project composition. */
  internalCompositionUnit?: boolean
  knowledgeReference?: string
  /** Main-only guard for explicit composition inputs; never derived from goal/model text. */
  assertInputsCurrent?: () => void
  /** Routine authority checks never replace the full guard at external execution boundaries. */
  assertAuthorityCurrent?: () => void
  /** Main-only physical-result inspection. Never authorizes a model, tool, or source read. */
  assertSettlementCurrent?: () => void
  project: HostProjectState
  operation: HostProjectOperation
  ticket: HostExecutionTicket
  snapshotRoot: string
  skillPath: string
  goal: string
  signal: AbortSignal
  bindThread: (threadId: string) => void
  recordTerminal: (terminal: {
    outcome: "success" | "error" | "unknown" | "cancelled"
    code: string
  }) => void
  /** Main-only dependency preflight after thread identity exists and before the original model run. */
  prepareThread?: (threadId: string) => Promise<void | { requiredContextText?: string }>
}

export interface HostProjectServiceDependencies {
  /** Main-only policy shared by every native producer, including calls outside desktop IPC. */
  assertCommand?: (project: HostProjectState, kind: HostProjectCommandKind) => void
  resolveInstalledPlugin: (installedPluginId: string) => Promise<HostInstalledPackage | undefined>
  authorize: (project: HostProjectState, operation: HostProjectOperation) => Promise<void>
  /** Main-only read/check authority. Used only by reconcile; never admits execution or approval. */
  authorizeInspection?: (
    project: HostProjectState, operation: HostProjectOperation
  ) => Promise<void | { assertCurrent(): void }>
  /** Use the original lifecycle, with ALL Skill/Hook/script/resource reads bound to snapshotRoot. */
  executeSkill: (context: HostSkillExecutionContext) => Promise<HostActionResult["outcome"]>
  /** Main-only snapshot preparation, after start and before the original executor. */
  beforeExecuteStage?: (context: HostSkillExecutionContext & { inputIdentity: string }) => Promise<void>
  /** Native baseline authority. Its function guard cannot be provided through renderer data. */
  authorizeStageBranch?: (
    context: HostStageBranchAdmissionContext
  ) => Promise<{ assertCurrent(): void }>
  /** Optional result inspection only. Absence means unknown operations require manual recovery. */
  prepareInputIdentity?: (project: HostProjectState, root: string) => Promise<void>
  inputIdentity?: (project: HostProjectState, root: string) => string
  captureInputAuthorityIdentity?: (project: HostProjectState, root: string) => () => string
  inspectOperation?: (
    context: Omit<HostSkillExecutionContext, "signal">
  ) => Promise<HostActionResult["outcome"]>
}

/** Main-process service. IPC must derive/authorize project scope before invoking these methods. */
export class HostProjectService {
  private readonly coordinator: HostProjectCoordinator
  private readonly operationInputs = new Map<string, () => void>()
  constructor(
    private readonly store: HostProjectStore,
    private readonly snapshots: HostPackageSnapshots,
    private readonly deps: HostProjectServiceDependencies
  ) {
    this.coordinator = new HostProjectCoordinator(store, {
      authorize: async (project, operation) => {
        this.assertCommand(project, "start")
        const snapshot = this.snapshot(project)
        assertHostPackageSupported(snapshot.root, project.manifest)
        await this.prepareRuntimeInputs(project.projectId)
        await deps.authorize(project, operation)
        this.assertCommand(this.project(project.projectId), "start")
        this.operationInputs.get(operation.operationId)?.()
      },
      fingerprint: async (project) => this.fingerprint(project),
      execute: async (project, ticket, signal) => {
        const operation = this.operation(ticket.operationId)
        const externalGuard = this.operationInputs.get(operation.operationId)
        const execution = this.executionContext(project, operation, ticket)
        const authorityIdentity = this.deps.captureInputAuthorityIdentity?.(project, execution.snapshotRoot) ??
          captureProjectRuntimeInputAuthorityIdentity(project, execution.snapshotRoot) ?? (() => undefined)
        const admittedAuthority = authorityIdentity()
        const metadata = (state: HostProjectState) => JSON.stringify({
          version: state.version, stageIndex: state.stageIndex, pluginDigest: state.pluginDigest,
          packageId: state.packageId, packageVersion: state.packageVersion, workspace: state.workspace,
          installedPluginId: state.installedPluginId, goal: state.goal, manifest: state.manifest
        })
        const admittedMetadata = metadata(project)
        let active = true
        const assertOperationCurrent = (settling: boolean) => {
          if (!active) hostStateError("OPERATION_SCOPE_CHANGED")
          const current = this.store.get(project.projectId)
          const owned = this.store.getOperation(ticket.operationId)
          const live = owned?.status === "started" && owned.cancelRequestedAt === null
          const cancelling = settling && signal.aborted && owned?.status === "cancel_requested" &&
            owned.cancelRequestedAt !== null
          if (!current || metadata(current) !== admittedMetadata || (!live && !cancelling) ||
            owned?.inputFingerprint !== ticket.inputFingerprint)
            hostStateError("OPERATION_SCOPE_CHANGED")
          if (authorityIdentity() !== admittedAuthority) hostStateError("INPUT_CHANGED")
        }
        const assertAuthorityCurrent = () => assertOperationCurrent(false)
        const assertInputBytesCurrent = () => {
          externalGuard?.()
          if (this.fingerprint(project) !== ticket.inputFingerprint) hostStateError("INPUT_CHANGED")
        }
        const assertInputsCurrent = () => {
          assertAuthorityCurrent()
          assertInputBytesCurrent()
        }
        const assertSettlementCurrent = () => {
          assertOperationCurrent(true)
          assertInputBytesCurrent()
        }
        assertInputsCurrent()
        try {
          const context: HostSkillExecutionContext = {
            ...execution,
            signal,
            assertInputsCurrent,
            assertAuthorityCurrent,
            assertSettlementCurrent
          }
          if (deps.beforeExecuteStage) {
            await deps.beforeExecuteStage({
              ...context,
              inputIdentity: this.debugInputIdentity(project, execution.snapshotRoot)
            })
            assertInputsCurrent()
          }
          const outcome = await deps.executeSkill(context)
          if (outcome === "cancelled") assertSettlementCurrent()
          else assertInputsCurrent()
          return outcome
        } finally {
          active = false
        }
      },
      validate: async (project, ticket, signal) => this.validateTicket(project, ticket, signal)
    })
  }

  get(projectId: string): HostProjectState | undefined {
    return this.store.get(projectId)
  }
  list(limit = 50, afterProjectId = ""): HostProjectState[] {
    return this.store.listProjects(limit, afterProjectId)
  }
  operations(projectId: string, limit = 50): HostProjectOperation[] {
    return this.store.listOperations(projectId, limit)
  }

  /** Native configuration preparation uses the very same retained bytes as localCreate. */
  async retainConfigurationSource(installedPluginId: string, expectedDigest: string) {
    const installed = await this.deps.resolveInstalledPlugin(hostText(installedPluginId))
    if (!installed?.enabled || installed.installedPluginId !== installedPluginId)
      hostStateError("PLUGIN_UNAVAILABLE")
    const snapshot = this.snapshots.capture(installed.root)
    if (snapshot.digest !== expectedDigest || snapshot.manifest.plugin.id !== installed.packageId ||
        snapshot.manifest.plugin.version !== installed.packageVersion)
      hostStateError("PACKAGE_IDENTITY_MISMATCH")
    assertHostPackageSupported(snapshot.root, snapshot.manifest)
    const current = await this.deps.resolveInstalledPlugin(installedPluginId)
    if (!current?.enabled || current.installedPluginId !== installedPluginId ||
        current.root !== installed.root || current.packageId !== installed.packageId ||
        current.packageVersion !== installed.packageVersion)
      hostStateError("PACKAGE_IDENTITY_MISMATCH")
    return this.snapshots.read(expectedDigest)
  }
  readConfigurationSource(expectedDigest: string) {
    return this.snapshots.read(expectedDigest)
  }

  /** Rebuild only immutable source/schema caches after restart; never replaces an operation fingerprint. */
  async prepareRuntimeInputs(projectId: string): Promise<void> {
    const project = this.project(projectId)
    const root = this.snapshot(project).root
    await (this.deps.prepareInputIdentity?.(project, root) ??
      prepareProjectRuntimeInputIdentity(project, root))
  }

  private fingerprint(project: HostProjectState) {
    const root = this.snapshot(project).root
    return fingerprintHostStageInput(
      project,
      project.goal,
      this.runtimeInputIdentity(project, root)
    )
  }

  private runtimeInputIdentity(project: HostProjectState, root: string) {
    const identity =
      this.deps.inputIdentity?.(project, root) ?? projectRuntimeInputIdentity(project, root)
    if (identity === undefined && readPackageExtensionContract(root)?.context)
      hostStateError("INPUT_IDENTITY_UNAVAILABLE")
    return identity
  }

  /** Exact current runtime-input identity, not a portable equivalence key or an approval. */
  async readDebugInputIdentity(projectId: string): Promise<string> {
    await this.prepareRuntimeInputs(projectId)
    const project = this.project(projectId)
    return this.debugInputIdentity(project, this.snapshot(project).root)
  }

  private debugInputIdentity(project: HostProjectState, root: string): string {
    return this.runtimeInputIdentity(project, root) ?? runtimeDigest("host-runtime-inputs-none/v1")
  }

  /** Creates a new native project at a proven stage boundary. No result or approval is inherited. */
  async createBranchAtStage(input: HostStageBranchInput): Promise<HostProjectState> {
    const authorize = this.deps.authorizeStageBranch
    if (!authorize) hostStateError("BRANCH_UNSUPPORTED")
    hostRecord(input, ["baselineId", "sourceProjectId", "expectedSourceVersion", "stageId",
      "projectId", "name", "workspace", "installedPluginId", "goal"])
    input = structuredClone(input)
    hostText(input.baselineId)
    hostText(input.stageId)
    hostText(input.projectId)
    hostText(input.name)
    hostGoal(input.goal)
    const source = this.project(hostText(input.sourceProjectId))
    if (source.version !== input.expectedSourceVersion || source.projectId === input.projectId)
      hostStateError("BRANCH_SOURCE_CHANGED")
    if (input.goal !== source.goal) hostStateError("BRANCH_GOAL_CHANGED")
    const stageIndex = source.manifest.stages.findIndex((stage) => stage.id === input.stageId)
    if (stageIndex < 0) hostStateError("BRANCH_STAGE_MISSING")
    if (stageIndex > source.stageIndex) hostStateError("BRANCH_STAGE_NOT_REACHED")
    const assertSourceSettled = () => {
      const operations = this.store.listOperations(source.projectId, 200)
      if (operations.length >= 200 || operations.some((operation) =>
        ["prepared", "started", "cancel_requested", "succeeded", "unknown"].includes(operation.status) ||
        (operation.startedAt !== null && (!operation.execution?.terminal ||
          operation.execution.terminal.outcome === "unknown" ||
          operation.execution.terminal.settledAt < operation.startedAt))))
        hostStateError("BRANCH_SOURCE_UNSETTLED")
      // Imported prefix data is not execution evidence. A branch without its own verified prefix
      // must refer back to the original source baseline instead of laundering imported inputs.
      for (const stage of source.manifest.stages.slice(0, stageIndex)) {
        const operation = operations.find((value) => value.stageId === stage.id &&
          value.status === "transitioned" && value.pluginDigest === source.pluginDigest &&
          value.expectedVersion < source.version)
        if (!operation || stage.checkIds.some((id) => !operation.receipts.some((receipt) =>
          receipt.checkId === id && receipt.result === "passed")))
          hostStateError("BRANCH_PREFIX_UNVERIFIED")
      }
    }
    assertSourceSettled()
    const sourceState = JSON.stringify(source)
    const workspace = runtimeDirectory(input.workspace)
    const originalWorkspace = normalizeWorkspacePathKey(source.workspace)
    const targetWorkspace = normalizeWorkspacePathKey(workspace)
    if (originalWorkspace === targetWorkspace ||
      originalWorkspace.startsWith(`${targetWorkspace}/`) ||
      targetWorkspace.startsWith(`${originalWorkspace}/`)) hostStateError("BRANCH_WORKSPACE_INVALID")
    return withSnapshotRetention([this.snapshots.root], async () => {
      const sourceSnapshot = this.snapshot(source)
      const installed = await this.deps.resolveInstalledPlugin(hostText(input.installedPluginId))
      if (!installed?.enabled || installed.installedPluginId !== input.installedPluginId)
        hostStateError("PLUGIN_UNAVAILABLE")
      const snapshot = this.snapshots.capture(installed.root)
      if (snapshot.manifest.plugin.id !== installed.packageId ||
        snapshot.manifest.plugin.version !== installed.packageVersion)
        hostStateError("PACKAGE_IDENTITY_MISMATCH")
      assertHostPackageSupported(snapshot.root, snapshot.manifest)
      // This first native adapter permits implementation edits only in unshared target/downstream
      // Skill files. A changed contract, context provider, Hook or shared helper needs an earlier
      // baseline/provider; merely importing old upstream outputs cannot prove compatibility.
      assertStageBranchSourceCompatible(sourceSnapshot.root, snapshot.root,
        source.manifest, snapshot.manifest, input.stageId)
      const candidate: HostProjectState = {
        projectId: input.projectId, name: input.name, workspace,
        installedPluginId: installed.installedPluginId, goal: input.goal,
        packageId: installed.packageId, packageVersion: installed.packageVersion,
        pluginDigest: snapshot.digest, manifest: snapshot.manifest,
        schemaVersion: 1, stateOwner: "host", version: 1, stageIndex, status: "active",
        createdAt: Date.now(), updatedAt: Date.now()
      }
      const admission = await authorize({ input: structuredClone(input),
        source: structuredClone(source), candidate: structuredClone(candidate),
        sourceSnapshotRoot: sourceSnapshot.root, candidateSnapshotRoot: snapshot.root })
      if (!admission || typeof admission.assertCurrent !== "function")
        hostStateError("BRANCH_ADMISSION_INVALID")
      await (this.deps.prepareInputIdentity?.(candidate, snapshot.root) ??
        prepareProjectRuntimeInputIdentity(candidate, snapshot.root))
      const current = await this.deps.resolveInstalledPlugin(input.installedPluginId)
      if (!current?.enabled || current.installedPluginId !== installed.installedPluginId ||
        current.root !== installed.root || current.packageId !== installed.packageId ||
        current.packageVersion !== installed.packageVersion)
        hostStateError("PACKAGE_IDENTITY_MISMATCH")
      // No await follows these native source/snapshot checks and the final admission fence.
      if (JSON.stringify(this.project(source.projectId)) !== sourceState)
        hostStateError("BRANCH_SOURCE_CHANGED")
      assertSourceSettled()
      this.snapshots.read(source.pluginDigest)
      this.snapshots.read(snapshot.digest)
      admission.assertCurrent()
      return this.store.createBranch({
        projectId: candidate.projectId, name: candidate.name, goal: candidate.goal,
        workspace: candidate.workspace, installedPluginId: candidate.installedPluginId,
        packageId: candidate.packageId, packageVersion: candidate.packageVersion,
        pluginDigest: candidate.pluginDigest, manifest: candidate.manifest
      }, input.stageId)
    })
  }

  async localCreate(input: {
    projectId: string
    name: string
    workspace: string
    installedPluginId: string
    goal: string
  }): Promise<HostProjectState> {
    return withSnapshotRetention([this.snapshots.root], async () => {
      hostRecord(input, ["projectId", "name", "workspace", "installedPluginId", "goal"])
      input = structuredClone(input)
      hostText(input.projectId)
      hostText(input.name)
      hostGoal(input.goal)
      const workspace = runtimeDirectory(input.workspace)
      const installed = await this.deps.resolveInstalledPlugin(hostText(input.installedPluginId))
      if (
        !installed ||
        !installed.enabled ||
        installed.installedPluginId !== input.installedPluginId
      )
        hostStateError("PLUGIN_UNAVAILABLE")
      const snapshot = this.snapshots.capture(installed.root)
      if (
        snapshot.manifest.plugin.id !== installed.packageId ||
        snapshot.manifest.plugin.version !== installed.packageVersion
      )
        hostStateError("PACKAGE_IDENTITY_MISMATCH")
      assertHostPackageSupported(snapshot.root, snapshot.manifest)
      for (const stage of snapshot.manifest.stages) {
        if (!readRuntimeScopedFile(snapshot.root, stage.skill!, 256 * 1024).present)
          hostStateError("SKILL_MISSING")
      }
      // Recheck the host catalog after capture: update/disable cannot race project binding silently.
      const current = await this.deps.resolveInstalledPlugin(input.installedPluginId)
      if (
        !current ||
        !current.enabled ||
        current.installedPluginId !== input.installedPluginId ||
        current.root !== installed.root ||
        current.packageId !== installed.packageId ||
        current.packageVersion !== installed.packageVersion
      )
        hostStateError("PACKAGE_IDENTITY_MISMATCH")
      const creation = {
        ...input,
        workspace,
        packageId: installed.packageId,
        packageVersion: installed.packageVersion,
        pluginDigest: snapshot.digest,
        manifest: snapshot.manifest
      }
      const preparation: HostProjectState = {
        ...creation,
        schemaVersion: 1,
        stateOwner: "host",
        version: 1,
        stageIndex: 0,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      await (this.deps.prepareInputIdentity?.(preparation, snapshot.root) ??
        prepareProjectRuntimeInputIdentity(preparation, snapshot.root))
      return this.store.create(creation)
    })
  }

  prepare(input: {
    projectId: string
    expectedVersion: number
    idempotencyKey: string
  }): HostProjectOperation {
    hostRecord(input, ["projectId", "expectedVersion", "idempotencyKey"])
    const project = this.project(input.projectId)
    this.assertCommand(project, "prepare")
    const previous = this.store.findOperation(input.projectId, input.idempotencyKey)
    if (previous) {
      if (previous.expectedVersion !== input.expectedVersion) hostStateError("IDEMPOTENCY_CONFLICT")
      return previous
    }
    this.snapshot(project)
    const stage = project.manifest.stages[project.stageIndex]
    if (!stage) hostStateError("PROJECT_COMPLETED")
    return this.store.prepare({
      ...input,
      stageId: stage.id,
      inputFingerprint: this.fingerprint(project)
    })
  }

  approve(
    operationId: string,
    input: {
      expectedVersion: number
      inputFingerprint: string
      decision: "approved" | "rejected"
      actorId: string
    }
  ): HostProjectOperation {
    const operation = this.operation(operationId)
    const project = this.project(operation.projectId)
    this.assertCommand(project, "approve")
    if (this.fingerprint(project) !== operation.inputFingerprint) hostStateError("INPUT_CHANGED")
    return this.store.decideApproval(operationId, input)
  }

  start(
    operationId: string,
    options?: { assertInputsCurrent: () => void }
  ): Promise<HostProjectOperation> {
    const operation = this.operation(operationId)
    this.assertCommand(this.project(operation.projectId), "start")
    if (!options) return this.coordinator.executePrepared(operationId)
    if (this.operationInputs.has(operationId)) hostStateError("OPERATION_BUSY")
    let active = true
    const guard = () => {
      if (!active) hostStateError("OPERATION_SCOPE_CHANGED")
      options.assertInputsCurrent()
    }
    this.operationInputs.set(operationId, guard)
    return this.coordinator.executePrepared(operationId).finally(() => {
      active = false
      if (this.operationInputs.get(operationId) === guard) this.operationInputs.delete(operationId)
    })
  }

  /** Explicit validation-only operation; it checks existing artifacts without launching a Skill. */
  async validate(operationId: string): Promise<HostProjectOperation> {
    const operation = this.operation(operationId)
    const project = this.project(operation.projectId)
    this.assertCommand(project, "validate")
    const stage = project.manifest.stages[project.stageIndex]
    if (!stage) hostStateError("PROJECT_COMPLETED")
    if (stage.actionIds.length && operation.execution?.terminal?.outcome !== "success")
      hostStateError("ACTION_EXECUTION_REQUIRED")
    this.snapshot(project)
    await this.deps.authorize(structuredClone(project), structuredClone(operation))
    this.assertCommand(this.project(project.projectId), "validate")
    const ticket = this.store.start(operationId, this.fingerprint(project))
    try {
      const receipts = this.validateTicket(project, ticket)
      return this.store.recordResult(ticket, { outcome: "succeeded", receipts })
    } catch {
      // Only host read validators ran here; an I/O failure cannot hide an external write.
      return this.store.recordResult(ticket, { outcome: "failed", receipts: [] })
    }
  }

  /** Main-only final-byte inspection for the existing composition proof, including action custody. */
  assertStageEvidenceCurrent(
    project: HostProjectState,
    operation: HostProjectOperation,
    checkIds: readonly string[]
  ): void {
    const root = this.snapshot(project).root
    const index = project.manifest.stages.findIndex((stage) => stage.id === operation.stageId)
    if (index < 0 || checkIds.some((id) => !project.manifest.stages[index].checkIds.includes(id)))
      hostStateError("EVIDENCE_STALE")
    const historical = { ...project, version: operation.expectedVersion, stageIndex: index }
    const ticket = {
      operationId: operation.operationId,
      projectId: operation.projectId,
      stageId: operation.stageId,
      expectedVersion: operation.expectedVersion,
      inputFingerprint: operation.inputFingerprint,
      pluginDigest: operation.pluginDigest
    }
    const evidence = readHostActionCheckEvidence(historical, ticket, operation, root, checkIds)
    const state = structuredClone(historical)
    state.manifest.stages[index].checkIds = [...checkIds]
    assertHostReceiptsCurrent(state, operation, evidence, this.runtimeInputIdentity(project, root))
  }

  transition(operationId: string): HostProjectState {
    const operation = this.operation(operationId)
    const project = this.project(operation.projectId)
    this.assertCommand(project, "advance")
    if (operation.status === "transitioned")
      return this.store.transition(operationId, operation.inputFingerprint)
    this.snapshot(project)
    const fingerprint = this.fingerprint(project)
    assertHostReceiptsCurrent(
      project,
      operation,
      readHostActionCheckEvidence(
        project,
        {
          operationId: operation.operationId,
          projectId: project.projectId,
          stageId: operation.stageId,
          expectedVersion: operation.expectedVersion,
          inputFingerprint: operation.inputFingerprint,
          pluginDigest: operation.pluginDigest
        },
        operation,
        this.snapshot(project).root
      ),
      this.runtimeInputIdentity(project, this.snapshot(project).root)
    )
    // No await follows revalidation. External processes are not locked: receipts prove this check time only.
    return this.store.transition(operationId, fingerprint)
  }

  cancel(operationId: string): HostProjectOperation {
    const operation = this.operation(operationId)
    this.assertCommand(this.project(operation.projectId), "cancel")
    return this.coordinator.cancel(operationId)
  }
  recoverInterrupted(): string[] {
    return this.store.recoverInterrupted()
  }

  async reconcile(operationId: string): Promise<HostProjectOperation> {
    const operation = this.operation(operationId)
    this.assertCommand(this.project(operation.projectId), "reconcile")
    const inspect = this.deps.inspectOperation
    if (!inspect) hostStateError("RECONCILE_UNSUPPORTED")
    return this.store.reconcile(operationId, async (operation, project) => {
      const inspection = this.deps.authorizeInspection
        ? await this.deps.authorizeInspection(structuredClone(project), structuredClone(operation))
        : await this.deps.authorize(structuredClone(project), structuredClone(operation))
      if (inspection) inspection.assertCurrent()
      this.assertCommand(this.project(project.projectId), "reconcile")
      const ticket: HostExecutionTicket = Object.freeze({
        operationId,
        projectId: project.projectId,
        stageId: operation.stageId,
        expectedVersion: operation.expectedVersion,
        inputFingerprint: operation.inputFingerprint,
        pluginDigest: operation.pluginDigest
      })
      const outcome = await inspect(this.executionContext(project, operation, ticket))
      if (inspection) inspection.assertCurrent()
      if (outcome !== "succeeded") return { outcome, receipts: [] }
      if (this.fingerprint(project) !== operation.inputFingerprint)
        return { outcome: "unknown", receipts: [] }
      return { outcome: "succeeded", receipts: this.validateTicket(project, ticket) }
    })
  }

  private project(id: string): HostProjectState {
    return this.store.get(id) ?? hostStateError("PROJECT_MISSING")
  }
  private assertCommand(project: HostProjectState, kind: HostProjectCommandKind): void {
    this.deps.assertCommand?.(structuredClone(project), kind)
  }
  private operation(id: string): HostProjectOperation {
    return this.store.getOperation(id) ?? hostStateError("OPERATION_MISSING")
  }
  private snapshot(project: HostProjectState) {
    const snapshot = this.snapshots.read(project.pluginDigest)
    if (
      snapshot.manifest.plugin.id !== project.packageId ||
      snapshot.manifest.plugin.version !== project.packageVersion ||
      JSON.stringify(snapshot.manifest) !== JSON.stringify(project.manifest)
    )
      hostStateError("PACKAGE_IDENTITY_MISMATCH")
    return snapshot
  }
  private executionContext(
    project: HostProjectState,
    operation: HostProjectOperation,
    ticket: HostExecutionTicket
  ) {
    const snapshot = this.snapshot(project)
    const skillPath = project.manifest.stages[project.stageIndex]?.skill
    if (!skillPath || !readRuntimeScopedFile(snapshot.root, skillPath, 256 * 1024).present)
      hostStateError("SKILL_MISSING")
    return {
      project: structuredClone(project),
      operation: structuredClone(operation),
      ticket,
      snapshotRoot: snapshot.root,
      skillPath,
      goal: project.goal,
      bindThread: (threadId: string) => this.store.bindExecutionThread(ticket, threadId),
      recordTerminal: (terminal: {
        outcome: "success" | "error" | "unknown" | "cancelled"
        code: string
      }) => this.store.recordExecutionTerminal(ticket, terminal)
    }
  }
  private validateTicket(
    project: HostProjectState,
    ticket: HostExecutionTicket,
    signal?: AbortSignal
  ) {
    this.snapshot(project)
    if (this.fingerprint(project) !== ticket.inputFingerprint) hostStateError("INPUT_CHANGED")
    return validateHostStage(
      project,
      ticket,
      signal,
      () => Date.now(),
      readHostActionCheckEvidence(
        project,
        ticket,
        this.operation(ticket.operationId),
        this.snapshot(project).root
      ),
      this.runtimeInputIdentity(project, this.snapshot(project).root)
    )
  }
}
