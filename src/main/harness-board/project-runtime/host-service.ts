import { captureSettledProjectSkill } from "../project-action-scope"
import { readPackageExtensionContract } from "../../plugins/extension-contract"
import { measureHostRuntimeSync, withHostRuntimeTiming } from "../../services/host-runtime-timing"
import type { HostUserInputRecord, HostContextResumeProof } from "../../services/host-user-input-store"
import type { StageRecoveryCommandPolicy } from "./stage-recovery-policy"
import { readStageRecoveryPolicy } from "./stage-recovery-policy"
import { prepareStageRecoveryReadOnlyRoots } from "../../hooks/stage-recovery-command"
import type {
  HostActionResult,
  HostExecutionTicket,
  HostProjectOperation,
  HostProjectState,
  HostContextProviderApproval,
  HostContextProviderRequest,
  HostResultReview,
  HostResultApprovalInput,
  HostContinuationResult
} from "../../../shared/project-runtime/host-types"
import type { HostCheckDiagnostic, HostExecutionTerminal } from "../../../shared/project-runtime/host-types"
import { HostProjectCoordinator } from "./host-coordinator"
import { previousHostCheckOperation } from "./host-check-diagnostics"
import { readHostResultFeedback } from "./host-result-feedback"
import { HostPackageSnapshots, capturePackageMetadataGuard } from "./package-snapshots"
import {
  derivationContentIdentity,
  snapshotDerivationSource
} from "../../plugins/derivation-source"
import type { PluginStartUseIdentity } from "../../../shared/plugin-start-use"
import { assertStageBranchSourceCompatible } from "./stage-branch-compatibility"
import { readHostPackageSkill } from "./package-skill-content"
import { HostProjectStore } from "./host-store"
import {
  hostGoal,
  hostRecord,
  hostStateError,
  hostText,
  hostInteger,
  hostResultReview,
  assertHostResultReview,
  parseHostStageInstructions
} from "./host-state-protocol"
import {
  assertHostReceiptsCurrent,
  fingerprintHostStageInput,
  validateHostStage
} from "./host-validators"
import { readRuntimeScopedFile, runtimeDigest, runtimeDirectory } from "./safe-files"
import { effectiveHostResultApproval } from "../../../shared/project-runtime/import-approval-policy"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import { assertHostPackageSupported } from "./package-preflight"
import { withSnapshotRetention } from "./snapshot-retention"
import { readHostActionCheckEvidence, readHistoricalHostCheckDiagnostics } from "./action-check-evidence"
import { inspectHostPlanMigration } from "./plan-migration"
import type { HostPlanMigrationReview } from "../../../shared/project-runtime/host-types"
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
  | "prepare"
  | "approve"
  | "start"
  | "validate"
  | "advance"
  | "reconcile"
  | "cancel"

export interface HostSkillExecutionContext {
  /** Checks-only validation of explicitly imported artifacts; no model/Skill is invoked. */
  importedValidationOnly?: boolean
  importedResultApprovalRequired?: boolean
  /** Immutable original bytes, presented only as untrusted inputs to a real reexecuted Skill. */
  importedMaterialPath?: string
  /** Original continuous dispatch budget, persisted with a safe input wait; never a new grant. */
  continuationIntent?: { remainingSteps: number; deadlineAt: number }
  /** Main-issued saved answer; the original graph must prove its exact interrupt before consumption. */
  recoveryInput?: HostUserInputRecord
  assertInputResumeResourcesCurrent?: () => void
  /** Main-only file-scoped debug policy; never restored from a renderer request or old approval. */
  stageDebug?: {
    workspace: string
    baselineId: string
    allowPromptHooks?: boolean
    commandHooks?: StageRecoveryCommandPolicy
  }
  /** Main-only directory visibility for an engine unit owned by a project composition. */
  internalCompositionUnit?: boolean
  knowledgeReference?: string
  /** Original prior failure observations, only for the same retained stage/version. Not credentials. */
  previousCheckDiagnostics?: HostCheckDiagnostic[]
  /** Bound native human revision request; task data, never a permission or validation receipt. */
  previousResultFeedback?: Readonly<{ operationId: string; feedback: string }>
  /** Explicit user text frozen on this operation, not inherited from another attempt. */
  stageInstructions?: string
  /** Main-only guard for explicit composition inputs; never derived from goal/model text. */
  assertInputsCurrent?: () => void
  /** Routine authority checks never replace the full guard at external execution boundaries. */
  assertAuthorityCurrent?: () => void
  /** Main-only physical-result inspection. Never authorizes a model, tool, or source read. */
  assertSettlementCurrent?: () => void
  /** Original coordinator cancellation; never grants a replacement run or changes old unknowns. */
  requestCancellation?: () => void
  project: HostProjectState
  operation: HostProjectOperation
  ticket: HostExecutionTicket
  snapshotRoot: string
  skillPath: string
  goal: string
  signal: AbortSignal
  bindThread: (threadId: string) => void
  recordTerminal: (terminal: HostExecutionTerminal) => void
  /** Main-only dependency preflight after thread identity exists and before the original model run. */
  prepareThread?: (threadId: string) => Promise<void | {
    requiredContextText?: string
    contextResumeProof?: HostContextResumeProof
  }>
}

export interface HostProjectServiceDependencies {
  /** Must reject pending/unknown child operations and external resources before checkpoint resume. */
  assertInputResumeSafe?: (project: HostProjectState, operation: HostProjectOperation) => Promise<void | { assertCurrent(): void }>
  /** Original resource managers must prove no outstanding child runs or external resource leases. */
  authorizePlanMigration?: (project: HostProjectState) => Promise<{ assertCurrent(): void }>
  /** Native local physical receipts only, before ordinary unknown-result inspection. */
  reconcileRecoveryHooks?: (project: HostProjectState) => Promise<void>
  /** Main-only policy shared by every native producer, including calls outside desktop IPC. */
  assertCommand?: (project: HostProjectState, kind: HostProjectCommandKind) => void
  resolveInstalledPlugin: (installedPluginId: string) => Promise<HostInstalledPackage | undefined>
  authorize: (project: HostProjectState, operation: HostProjectOperation) => Promise<void>
  /** Main-only read/check authority. Used only by reconcile; never admits execution or approval. */
  authorizeInspection?: (
    project: HostProjectState,
    operation: HostProjectOperation
  ) => Promise<void | { assertCurrent(): void }>
  /** Use the original lifecycle, with ALL Skill/Hook/script/resource reads bound to snapshotRoot. */
  executeSkill: (context: HostSkillExecutionContext) => Promise<HostActionResult["outcome"]>
  /** Main-only snapshot preparation, after start and before the original executor. */
  beforeExecuteStage?: (
    context: HostSkillExecutionContext & { inputIdentity: string }
  ) => Promise<void>
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
  private readonly continuations = new Set<string>()
  private readonly recoveryInputs = new Map<string, HostUserInputRecord>()
  private readonly importedValidations = new Set<string>()
  private readonly recoveryResourceGuards = new Map<string, () => void>()
  private readonly continuationIntents = new Map<string, { remainingSteps: number; deadlineAt: number }>()
  private readonly continuationJobs = new Map<string, Promise<HostContinuationResult>>()
  constructor(
    private readonly store: HostProjectStore,
    private readonly snapshots: HostPackageSnapshots,
    private readonly deps: HostProjectServiceDependencies
  ) {
    this.coordinator = new HostProjectCoordinator(store, {
      authorize: async (project, operation) => {
        this.assertCommand(project, "start")
        this.assertResultFeedbackCurrent(operation)
        const snapshot = this.snapshot(project)
        assertHostPackageSupported(snapshot.root, project.manifest)
        await this.prepareRuntimeInputs(project.projectId)
        await deps.authorize(project, operation)
        this.assertCommand(this.project(project.projectId), "start")
        this.operationInputs.get(operation.operationId)?.()
        this.assertResultFeedbackCurrent(operation)
      },
      fingerprint: async (project) => this.fingerprint(project),
      assertCurrent: (project, operation) => {
        this.assertCommand(this.project(project.projectId), "start")
        this.assertResultFeedbackCurrent(operation)
        this.operationInputs.get(operation.operationId)?.()
        if (this.fingerprint(project) !== operation.inputFingerprint) hostStateError("INPUT_CHANGED")
      },
      execute: async (project, ticket, signal) => {
        const operation = this.operation(ticket.operationId)
        const externalGuard = this.operationInputs.get(operation.operationId)
        const execution = this.executionContext(project, operation, ticket)
        const feedbackBinding = JSON.stringify(operation.resultFeedbackSource)
        const stageInstructions = operation.stageInstructions
        const authorityIdentity =
          this.deps.captureInputAuthorityIdentity?.(project, execution.snapshotRoot) ??
          captureProjectRuntimeInputAuthorityIdentity(project, execution.snapshotRoot) ??
          (() => undefined)
        const admittedAuthority = authorityIdentity()
        const metadata = (state: HostProjectState) =>
          JSON.stringify({
            version: state.version,
            stageIndex: state.stageIndex,
            pluginDigest: state.pluginDigest,
            packageId: state.packageId,
            packageVersion: state.packageVersion,
            workspace: state.workspace,
            installedPluginId: state.installedPluginId,
            goal: state.goal,
            manifest: state.manifest
          })
        const admittedMetadata = metadata(project)
        let active = true
        const assertOperationCurrent = (settling: boolean) => {
          if (!active) hostStateError("OPERATION_SCOPE_CHANGED")
          const current = this.store.get(project.projectId)
          const owned = this.store.getOperation(ticket.operationId)
          const live = owned?.status === "started" && owned.cancelRequestedAt === null
          const cancelling =
            settling &&
            signal.aborted &&
            owned?.status === "cancel_requested" &&
            owned.cancelRequestedAt !== null
          if (
            !current ||
            metadata(current) !== admittedMetadata ||
            (!live && !cancelling) ||
            owned?.inputFingerprint !== ticket.inputFingerprint
          )
            hostStateError("OPERATION_SCOPE_CHANGED")
          if (authorityIdentity() !== admittedAuthority) hostStateError("INPUT_CHANGED")
          externalGuard?.()
          if (owned?.stageInstructions !== stageInstructions)
            hostStateError("STAGE_INSTRUCTIONS_CHANGED")
          if (JSON.stringify(owned?.resultFeedbackSource) !== feedbackBinding)
            hostStateError("RESULT_FEEDBACK_CHANGED")
          if (operation.resultFeedbackSource)
            readHostResultFeedback(operation, this.store.getOperation(operation.resultFeedbackSource.operationId))
        }
        const assertAuthorityCurrent = () => assertOperationCurrent(false)
        const assertInputBytesCurrent = () => {
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
            ...(this.importedValidations.has(operation.operationId) ? { importedValidationOnly: true } : {}),
            importedResultApprovalRequired: effectiveHostResultApproval(
              project.manifest.stages[project.stageIndex], this.store.importedSource(project.projectId)),
            importedMaterialPath: this.store.importedSource(project.projectId)?.review.adaptation?.materialPath,
            ...(this.recoveryInputs.has(operation.operationId)
              ? { recoveryInput: this.recoveryInputs.get(operation.operationId)! } : {}),
            assertInputResumeResourcesCurrent: this.recoveryResourceGuards.get(operation.operationId),
            continuationIntent: this.continuationIntents.get(operation.operationId) ??
              this.recoveryInputs.get(operation.operationId)?.continuation?.continueIntent,
            signal,
            assertInputsCurrent,
            assertAuthorityCurrent,
            assertSettlementCurrent,
            requestCancellation: () => {
              assertOperationCurrent(signal.aborted)
              this.cancel(operation.operationId)
            }
          }
          if (deps.beforeExecuteStage && !context.recoveryInput && !context.importedValidationOnly) {
            await deps.beforeExecuteStage({
              ...context,
              inputIdentity: this.debugInputIdentity(project, execution.snapshotRoot)
            })
            assertInputsCurrent()
          }
          const outcome = await withHostRuntimeTiming(() => deps.executeSkill(context))
          // Recheck the native policy after physical work, before producing an operation
          // result. Recovery Hook uncertainty must not be laundered by an executor label.
          this.assertCommand(project, "validate")
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
    return this.store.listOperations(projectId, limit).map(operation => this.withCheckDiagnostics(operation))
  }

  /** Raw authority facts only; diagnostic enrichment is reserved for explicit observations. */
  bindingOperation(projectId: string, operationId: string): HostProjectOperation | undefined {
    return this.store.getRecentBindingOperation(projectId, operationId)
  }

  private withCheckDiagnostics(operation: HostProjectOperation): HostProjectOperation {
    if (operation.execution?.terminal?.checkDiagnostics?.length || operation.status !== "failed" ||
      operation.execution?.terminal?.outcome !== "error" ||
      !["project_checks_failed", "import_validation_check_failed"].includes(operation.execution.terminal.code))
      return operation
    try {
      const project = this.store.get(operation.projectId)
      if (!project || operation.pluginDigest !== project.pluginDigest ||
        operation.expectedVersion !== project.version ||
        operation.stageId !== project.manifest.stages[project.stageIndex]?.id) return operation
      const diagnostics = readHistoricalHostCheckDiagnostics(project, operation, this.snapshot(project).root)
      if (!diagnostics.length || !operation.execution?.terminal) return operation
      return { ...operation, execution: { ...operation.execution,
        terminal: { ...operation.execution.terminal, checkDiagnostics: diagnostics } } }
    } catch {
      // Missing or changed original inputs never become invented diagnostic evidence.
      return operation
    }
  }

  /** Native configuration preparation uses the very same retained bytes as localCreate. */
  async retainConfigurationSource(installedPluginId: string, expectedDigest: string) {
    const installed = await this.deps.resolveInstalledPlugin(hostText(installedPluginId))
    if (!installed?.enabled || installed.installedPluginId !== installedPluginId)
      hostStateError("PLUGIN_UNAVAILABLE")
    const snapshot = this.snapshots.capture(installed.root)
    if (
      snapshot.digest !== expectedDigest ||
      snapshot.manifest.plugin.id !== installed.packageId ||
      snapshot.manifest.plugin.version !== installed.packageVersion
    )
      hostStateError("PACKAGE_IDENTITY_MISMATCH")
    assertHostPackageSupported(snapshot.root, snapshot.manifest)
    const current = await this.deps.resolveInstalledPlugin(installedPluginId)
    if (
      !current?.enabled ||
      current.installedPluginId !== installedPluginId ||
      current.root !== installed.root ||
      current.packageId !== installed.packageId ||
      current.packageVersion !== installed.packageVersion
    )
      hostStateError("PACKAGE_IDENTITY_MISMATCH")
    return this.snapshots.read(expectedDigest)
  }
  readConfigurationSource(expectedDigest: string) {
    return this.snapshots.read(expectedDigest)
  }

  private async preparePlanMigration(projectId: string, expectedVersion: number) {
    const project = this.store.assertPlanMigrationBoundary(projectId, expectedVersion)
    this.assertCommand(project, "prepare")
    if (!this.deps.authorizePlanMigration) hostStateError("PLAN_MIGRATION_RESOURCE_CHECK_REQUIRED")
    const authority = await this.deps.authorizePlanMigration(project)
    const installed = await this.deps.resolveInstalledPlugin(project.installedPluginId)
    if (!installed?.enabled || installed.packageId !== project.packageId ||
      installed.installedPluginId !== project.installedPluginId)
      hostStateError("PLAN_MIGRATION_TARGET_INVALID")
    const source = this.snapshot(project)
    const target = this.snapshots.capture(installed.root)
    if (target.digest === source.digest) hostStateError("PLAN_MIGRATION_UNCHANGED")
    if (target.manifest.plugin.id !== installed.packageId ||
      target.manifest.plugin.version !== installed.packageVersion)
      hostStateError("PACKAGE_IDENTITY_MISMATCH")
    const installedGuard = capturePackageMetadataGuard(installed.root)
    assertHostPackageSupported(target.root, target.manifest)
    const plan = inspectHostPlanMigration(project, target.manifest, source.root, target.root)
    const candidate: HostProjectState = { ...project, manifest: target.manifest,
      pluginDigest: target.digest, packageVersion: target.manifest.plugin.version,
      version: project.version + 1 }
    await this.prepareRuntimeInputs(projectId)
    await (this.deps.prepareInputIdentity?.(candidate, target.root) ??
      prepareProjectRuntimeInputIdentity(candidate, target.root))
    const assertCurrent = () => {
      authority.assertCurrent()
      installedGuard()
      this.assertCommand(project, "prepare")
      const current = this.store.assertPlanMigrationBoundary(projectId, expectedVersion)
      if (JSON.stringify(current) !== JSON.stringify(project)) hostStateError("VERSION_CONFLICT")
      for (const stageId of plan.preservedStageIds) {
        const previous = this.store.lastStageTransition(projectId, stageId)
        this.assertStageEvidenceCurrent(previous.project, previous.operation,
          project.manifest.stages.find(stage => stage.id === stageId)!.checkIds)
        if (previous.operation.resultApproval) {
          const historical = { ...previous.project, version: previous.operation.expectedVersion,
            stageIndex: previous.project.manifest.stages.findIndex(stage => stage.id === stageId) }
          assertHostResultReview(this.captureResultReview(historical, previous.operation),
            previous.operation.resultApproval)
        }
      }
    }
    assertCurrent()
    const review: HostPlanMigrationReview = { projectId, expectedVersion,
      sourceDigest: project.pluginDigest, targetDigest: candidate.pluginDigest,
      targetVersion: candidate.packageVersion, inputFingerprint: this.fingerprint(project),
      candidateInputFingerprint: this.fingerprint(candidate), ...plan }
    return { candidate, review, assertCurrent: () => {
      assertCurrent()
      if (this.fingerprint(project) !== review.inputFingerprint ||
        this.fingerprint(candidate) !== review.candidateInputFingerprint)
        hostStateError("INPUT_CHANGED")
    } }
  }

  async reviewPlanMigration(projectId: string, expectedVersion: number): Promise<HostPlanMigrationReview> {
    return (await this.preparePlanMigration(projectId, expectedVersion)).review
  }

  async migratePlan(review: HostPlanMigrationReview, assertAuthority?: () => void): Promise<HostProjectState> {
    assertAuthority?.()
    const prepared = await this.preparePlanMigration(review.projectId, review.expectedVersion)
    assertAuthority?.()
    if (JSON.stringify(prepared.review) !== JSON.stringify(review))
      hostStateError("PLAN_MIGRATION_REVIEW_CHANGED")
    return this.store.commitPlanMigration(prepared.candidate, review.expectedVersion,
      prepared.review, () => { assertAuthority?.(); prepared.assertCurrent() })
  }

  /** Rebuild only immutable source/schema caches after restart; never replaces an operation fingerprint. */
  async prepareRuntimeInputs(projectId: string): Promise<void> {
    const project = this.project(projectId)
    const root = this.snapshot(project).root
    if (
      process.platform === "win32" &&
      readStageRecoveryPolicy(root)?.hookExecution === "windows-sandbox"
    )
      await prepareStageRecoveryReadOnlyRoots([root], () => {
        if (
          JSON.stringify(this.project(projectId)) !== JSON.stringify(project) ||
          this.snapshot(project).root !== root
        )
          hostStateError("INPUT_CHANGED")
      })
    await (this.deps.prepareInputIdentity?.(project, root) ??
      prepareProjectRuntimeInputIdentity(project, root))
  }

  private fingerprint(project: HostProjectState) {
    const root = measureHostRuntimeSync("snapshot", () => this.snapshot(project).root)
    const fingerprint = fingerprintHostStageInput(
      project,
      project.goal,
      this.runtimeInputIdentity(project, root)
    )
    const receipt = this.store.importedSource(project.projectId)
    if (receipt?.review.protocol !== "devclaw.host-legacy-import/v2") return fingerprint
    const material = receipt.review.adaptation?.materialPath
    if (material) {
      const expected = receipt.review.files.find(file => file.targetPath === material)
      const current = readRuntimeScopedFile(project.workspace, material, 16 * 1024 * 1024)
      if (!expected || !current.bytes || runtimeDigest(current.bytes) !== expected.digest)
        hostStateError("IMPORT_SOURCE_MATERIAL_CHANGED")
    }
    return runtimeDigest(JSON.stringify({ fingerprint, importReviewDigest: receipt.review.reviewDigest }))
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
    hostRecord(input, [
      "baselineId",
      "sourceProjectId",
      "expectedSourceVersion",
      "stageId",
      "projectId",
      "name",
      "workspace",
      "installedPluginId",
      "goal"
    ])
    input = structuredClone(input)
    hostText(input.baselineId)
    hostText(input.stageId)
    hostText(input.projectId)
    hostText(input.name)
    hostGoal(input.goal)
    const source = this.project(hostText(input.sourceProjectId))
    this.store.assertImportPrefixComplete(source.projectId, input.stageId)
    if (source.version !== input.expectedSourceVersion || source.projectId === input.projectId)
      hostStateError("BRANCH_SOURCE_CHANGED")
    if (input.goal !== source.goal) hostStateError("BRANCH_GOAL_CHANGED")
    const stageIndex = source.manifest.stages.findIndex((stage) => stage.id === input.stageId)
    if (stageIndex < 0) hostStateError("BRANCH_STAGE_MISSING")
    if (stageIndex > source.stageIndex) hostStateError("BRANCH_STAGE_NOT_REACHED")
    const assertSourceSettled = () => {
      this.store.assertImportPrefixComplete(source.projectId, input.stageId)
      const operations = this.store.listOperations(source.projectId, 200)
      if (
        operations.length >= 200 ||
        operations.some(
          (operation) =>
            ["prepared", "started", "cancel_requested", "succeeded", "unknown"].includes(
              operation.status
            ) ||
            (operation.startedAt !== null &&
              (!operation.execution?.terminal ||
                operation.execution.terminal.outcome === "unknown" ||
                operation.execution.terminal.settledAt < operation.startedAt))
        )
      )
        hostStateError("BRANCH_SOURCE_UNSETTLED")
      // Imported prefix data is not execution evidence. A branch without its own verified prefix
      // must refer back to the original source baseline instead of laundering imported inputs.
      for (const stage of source.manifest.stages.slice(0, stageIndex)) {
        const operation = operations.find(
          (value) =>
            value.stageId === stage.id &&
            value.status === "transitioned" &&
            value.pluginDigest === source.pluginDigest &&
            value.expectedVersion < source.version
        )
        if (
          !operation ||
          stage.checkIds.some(
            (id) =>
              !operation.receipts.some(
                (receipt) => receipt.checkId === id && receipt.result === "passed"
              )
          )
        )
          hostStateError("BRANCH_PREFIX_UNVERIFIED")
      }
    }
    assertSourceSettled()
    const sourceState = JSON.stringify(source)
    const workspace = runtimeDirectory(input.workspace)
    const originalWorkspace = normalizeWorkspacePathKey(source.workspace)
    const targetWorkspace = normalizeWorkspacePathKey(workspace)
    if (
      originalWorkspace === targetWorkspace ||
      originalWorkspace.startsWith(`${targetWorkspace}/`) ||
      targetWorkspace.startsWith(`${originalWorkspace}/`)
    )
      hostStateError("BRANCH_WORKSPACE_INVALID")
    return withSnapshotRetention([this.snapshots.root], async () => {
      const sourceSnapshot = this.snapshot(source)
      const installed = await this.deps.resolveInstalledPlugin(hostText(input.installedPluginId))
      if (!installed?.enabled || installed.installedPluginId !== input.installedPluginId)
        hostStateError("PLUGIN_UNAVAILABLE")
      const snapshot = this.snapshots.capture(installed.root)
      if (
        snapshot.manifest.plugin.id !== installed.packageId ||
        snapshot.manifest.plugin.version !== installed.packageVersion
      )
        hostStateError("PACKAGE_IDENTITY_MISMATCH")
      assertHostPackageSupported(snapshot.root, snapshot.manifest)
      // This first native adapter permits implementation edits only in unshared target/downstream
      // Skill files. A changed contract, context provider, Hook or shared helper needs an earlier
      // baseline/provider; merely importing old upstream outputs cannot prove compatibility.
      assertStageBranchSourceCompatible(
        sourceSnapshot.root,
        snapshot.root,
        source.manifest,
        snapshot.manifest,
        input.stageId
      )
      const candidate: HostProjectState = {
        projectId: input.projectId,
        name: input.name,
        workspace,
        installedPluginId: installed.installedPluginId,
        goal: input.goal,
        packageId: installed.packageId,
        packageVersion: installed.packageVersion,
        pluginDigest: snapshot.digest,
        manifest: snapshot.manifest,
        schemaVersion: 1,
        stateOwner: "host",
        version: 1,
        stageIndex,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      const admission = await authorize({
        input: structuredClone(input),
        source: structuredClone(source),
        candidate: structuredClone(candidate),
        sourceSnapshotRoot: sourceSnapshot.root,
        candidateSnapshotRoot: snapshot.root
      })
      if (!admission || typeof admission.assertCurrent !== "function")
        hostStateError("BRANCH_ADMISSION_INVALID")
      await (this.deps.prepareInputIdentity?.(candidate, snapshot.root) ??
        prepareProjectRuntimeInputIdentity(candidate, snapshot.root))
      const current = await this.deps.resolveInstalledPlugin(input.installedPluginId)
      if (
        !current?.enabled ||
        current.installedPluginId !== installed.installedPluginId ||
        current.root !== installed.root ||
        current.packageId !== installed.packageId ||
        current.packageVersion !== installed.packageVersion
      )
        hostStateError("PACKAGE_IDENTITY_MISMATCH")
      // No await follows these native source/snapshot checks and the final admission fence.
      if (JSON.stringify(this.project(source.projectId)) !== sourceState)
        hostStateError("BRANCH_SOURCE_CHANGED")
      assertSourceSettled()
      this.snapshots.read(source.pluginDigest)
      this.snapshots.read(snapshot.digest)
      admission.assertCurrent()
      return this.store.createBranch(
        {
          projectId: candidate.projectId,
          name: candidate.name,
          goal: candidate.goal,
          workspace: candidate.workspace,
          installedPluginId: candidate.installedPluginId,
          packageId: candidate.packageId,
          packageVersion: candidate.packageVersion,
          pluginDigest: candidate.pluginDigest,
          manifest: candidate.manifest
        },
        input.stageId,
        { projectId: source.projectId, expectedVersion: source.version }
      )
    })
  }

  async localCreate(
    input: {
      projectId: string
      name: string
      workspace: string
      installedPluginId: string
      goal: string
      expectedPlugin?: PluginStartUseIdentity
    },
    assertCreatorCurrent: () => void = () => {},
    importReceipt?: import("../../../shared/project-runtime/host-types").HostLegacyImportReceipt
  ): Promise<HostProjectState> {
    return withSnapshotRetention([this.snapshots.root], async () => {
      assertCreatorCurrent()
      hostRecord(input, [
        "projectId",
        "name",
        "workspace",
        "installedPluginId",
        "goal",
        ...(Object.hasOwn(input, "expectedPlugin") ? ["expectedPlugin"] : [])
      ])
      input = structuredClone(input)
      const { expectedPlugin, ...projectInput } = input
      if (expectedPlugin) {
        hostRecord(expectedPlugin, ["pluginId", "name", "version", "digest"])
        if (
          hostText(expectedPlugin.pluginId) !== input.installedPluginId ||
          typeof expectedPlugin.digest !== "string" ||
          !/^[a-f0-9]{64}$/.test(expectedPlugin.digest)
        )
          hostStateError("PACKAGE_IDENTITY_MISMATCH")
        hostText(expectedPlugin.name)
        hostText(expectedPlugin.version)
      } else if (Object.hasOwn(input, "expectedPlugin")) hostStateError("SCHEMA_INVALID")
      hostText(input.projectId)
      hostText(input.name)
      hostGoal(input.goal)
      const workspace = runtimeDirectory(input.workspace)
      const installed = await this.deps.resolveInstalledPlugin(hostText(input.installedPluginId))
      assertCreatorCurrent()
      if (
        !installed ||
        !installed.enabled ||
        installed.installedPluginId !== input.installedPluginId
      )
        hostStateError("PLUGIN_UNAVAILABLE")
      const assertSourceCurrent = expectedPlugin || importReceipt
        ? capturePackageMetadataGuard(installed.root)
        : () => {}
      const snapshot = this.snapshots.capture(installed.root)
      if (
        snapshot.manifest.plugin.id !== installed.packageId ||
        snapshot.manifest.plugin.version !== installed.packageVersion
      )
        hostStateError("PACKAGE_IDENTITY_MISMATCH")
      const assertRetainedCurrent = expectedPlugin || importReceipt
        ? capturePackageMetadataGuard(snapshot.root)
        : () => {}
      if (
        expectedPlugin &&
        (expectedPlugin.name !== installed.packageId ||
          expectedPlugin.version !== installed.packageVersion ||
          derivationContentIdentity((await snapshotDerivationSource(snapshot.root)).files) !==
            expectedPlugin.digest)
      )
        hostStateError("PACKAGE_IDENTITY_MISMATCH")
      assertCreatorCurrent()
      assertSourceCurrent()
      assertRetainedCurrent()
      assertHostPackageSupported(snapshot.root, snapshot.manifest)
      // Recheck the host catalog after capture: update/disable cannot race project binding silently.
      const current = await this.deps.resolveInstalledPlugin(input.installedPluginId)
      assertCreatorCurrent()
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
        ...projectInput,
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
      if (expectedPlugin || importReceipt) {
        const final = await this.deps.resolveInstalledPlugin(input.installedPluginId)
        assertCreatorCurrent()
        if (
          !final?.enabled ||
          final.installedPluginId !== installed.installedPluginId ||
          final.root !== installed.root ||
          final.packageId !== installed.packageId ||
          final.packageVersion !== installed.packageVersion
        )
          hostStateError("PACKAGE_IDENTITY_MISMATCH")
        assertSourceCurrent()
        assertRetainedCurrent()
      }
      assertCreatorCurrent()
      return importReceipt ? this.store.createImported(creation, importReceipt) : this.store.create(creation)
    })
  }

  async reviewImportTarget(installedPluginId: string) {
    const installed = await this.deps.resolveInstalledPlugin(hostText(installedPluginId))
    if (!installed?.enabled || installed.installedPluginId !== installedPluginId) hostStateError("PLUGIN_UNAVAILABLE")
    const snapshot = this.snapshots.capture(installed.root)
    assertHostPackageSupported(snapshot.root, snapshot.manifest)
    if (snapshot.manifest.plugin.id !== installed.packageId || snapshot.manifest.plugin.version !== installed.packageVersion)
      hostStateError("PACKAGE_IDENTITY_MISMATCH")
    const assertCurrent = capturePackageMetadataGuard(installed.root)
    return { snapshot, assertCurrent }
  }

  importedSource(projectId: string) { return this.store.importedSource(projectId) }

  private assertImportedMappedFilesCurrent(project: HostProjectState, operation: HostProjectOperation): void {
    const receipt = this.store.importedSource(project.projectId)
    if (!receipt?.review.prefixStageIds.includes(operation.stageId) ||
      receipt.review.adaptation?.reexecuteStageIds.includes(operation.stageId)) return
    for (const file of receipt.review.files) {
      if (!project.manifest.stages[project.stageIndex].artifactIds.includes(file.artifactId) &&
        file.targetPath !== receipt.review.adaptation?.materialPath) continue
      const current = readRuntimeScopedFile(project.workspace, file.targetPath, 16 * 1024 * 1024)
      if (!current.bytes || runtimeDigest(current.bytes) !== file.digest)
        hostStateError("IMPORT_ARTIFACT_CHANGED")
    }
  }

  async validateImported(operationId: string, assertAuthority?: () => void): Promise<HostProjectOperation> {
    const operation = this.operation(operationId)
    const project = this.project(operation.projectId)
    const receipt = this.store.importedSource(project.projectId)
    if (!receipt?.review.prefixStageIds.includes(operation.stageId)) hostStateError("IMPORT_STAGE_MISSING")
    if (receipt.review.adaptation?.reexecuteStageIds.includes(operation.stageId))
      hostStateError("IMPORT_STAGE_REEXECUTION_REQUIRED")
    if (this.importedValidations.has(operationId)) hostStateError("OPERATION_BUSY")
    const assertFilesCurrent = () => {
      assertAuthority?.()
      this.assertImportedMappedFilesCurrent(project, operation)
    }
    assertFilesCurrent()
    this.importedValidations.add(operationId)
    try { return await this.start(operationId, { assertInputsCurrent: assertFilesCurrent }) }
    finally { this.importedValidations.delete(operationId) }
  }

  prepare(input: {
    projectId: string
    expectedVersion: number
    idempotencyKey: string
    stageInstructions?: string
  }): HostProjectOperation {
    hostRecord(input, ["projectId", "expectedVersion", "idempotencyKey",
      ...(Object.hasOwn(input, "stageInstructions") ? ["stageInstructions"] : [])])
    const stageInstructions = parseHostStageInstructions(input.stageInstructions)
    const project = this.project(input.projectId)
    this.assertCommand(project, "prepare")
    const previous = this.store.findOperation(input.projectId, input.idempotencyKey)
    if (previous) {
      if (previous.expectedVersion !== input.expectedVersion ||
        previous.stageInstructions !== stageInstructions) hostStateError("IDEMPOTENCY_CONFLICT")
      return previous
    }
    this.snapshot(project)
    const stage = project.manifest.stages[project.stageIndex]
    if (!stage) hostStateError("PROJECT_COMPLETED")
    return this.store.prepare({
      ...input,
      ...(stageInstructions ? { stageInstructions } : {}),
      stageId: stage.id,
      inputFingerprint: this.fingerprint(project),
      ...this.contextProviderRequest(project)
    })
  }

  approve(
    operationId: string,
    input: {
      expectedVersion: number
      inputFingerprint: string
      decision: "approved" | "rejected"
      actorId: string
      contextProviderApproval?: HostContextProviderApproval
    }
  ): HostProjectOperation {
    const operation = this.operation(operationId)
    const project = this.project(operation.projectId)
    this.assertCommand(project, "approve")
    this.assertContextProviderRequest(project, operation)
    if (this.fingerprint(project) !== operation.inputFingerprint) hostStateError("INPUT_CHANGED")
    return this.store.decideApproval(operationId, input)
  }

  start(
    operationId: string,
    options?: { assertInputsCurrent: () => void }
  ): Promise<HostProjectOperation> {
    const operation = this.operation(operationId)
    const imported = this.store.importedSource(operation.projectId)
    if (imported?.review.prefixStageIds.includes(operation.stageId) &&
      !imported.review.adaptation?.reexecuteStageIds.includes(operation.stageId) &&
      !this.importedValidations.has(operationId))
      hostStateError("IMPORTED_STAGE_REVALIDATION_REQUIRED")
    this.assertCommand(this.project(operation.projectId), "start")
    this.assertContextProviderRequest(this.project(operation.projectId), operation)
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

  async resumeInput(operationId: string, requestId: string, options: {
    beforeStart?: (operation: HostProjectOperation) => void | Promise<void>
    assertAuthority?: () => void
  } = {}): Promise<HostProjectOperation> {
    options.assertAuthority?.()
    // A fast answer can arrive before the original interrupt stream has physically settled.
    await this.coordinator.waitForSettlement(operationId)
    options.assertAuthority?.()
    const operation = this.operation(operationId)
    const project = this.project(operation.projectId)
    await this.continuationJobs.get(project.projectId)
    options.assertAuthority?.()
    this.assertCommand(project, "start")
    const { getHostInputContinuation } = await import("../../services/user-input")
    options.assertAuthority?.()
    const record = getHostInputContinuation(requestId)
    if (!record?.continuation?.priorToolsSettled || record.continuation.claimed || record.status !== "answered" ||
      record.binding.operationId !== operationId || record.binding.projectId !== project.projectId ||
      record.binding.stageId !== operation.stageId ||
      record.binding.installedPluginId !== project.installedPluginId ||
      record.binding.expectedVersion !== project.version ||
      record.binding.pluginDigest !== project.pluginDigest ||
      record.binding.inputFingerprint !== operation.inputFingerprint ||
      record.request.threadId !== operation.execution?.threadId)
      hostStateError("INPUT_RESUME_MISMATCH")
    if (this.recoveryInputs.has(operationId) || this.operationInputs.has(operationId))
      hostStateError("OPERATION_BUSY")
    if (!this.deps.assertInputResumeSafe) hostStateError("INPUT_RESUME_RESOURCE_INSPECTION_REQUIRED")
    this.recoveryInputs.set(operationId, record)
    const authorityGuard = options.assertAuthority
    if (authorityGuard) this.operationInputs.set(operationId, authorityGuard)
    try {
      const resources = await this.deps.assertInputResumeSafe(project, operation)
      options.assertAuthority?.()
      if (resources) this.recoveryResourceGuards.set(operationId, () => resources.assertCurrent())
      // Context scripts and stage actions have separate side-effect lifecycles; do not replay them.
      const stage = project.manifest.stages[project.stageIndex]
      const extension = readPackageExtensionContract(this.snapshots.read(project.pluginDigest).root)
      if (operation.contextProvider || stage.actionIds.length ||
        (extension?.context?.provider?.actionId && !record.continuation.contextResumeProof))
        hostStateError("INPUT_RESUME_ACTIONS_UNSUPPORTED")
      const result = await this.coordinator.executeInterrupted(operationId)
      options.assertAuthority?.()
      const intent = record.continuation.continueIntent
      if (result.status === "succeeded" && intent && Date.now() < intent.deadlineAt) {
        await this.runContinuation(project.projectId, {
          maxSteps: intent.remainingSteps,
          maxDurationMs: Math.min(3_600_000, Math.max(1, intent.deadlineAt - Date.now())),
          assertAuthority: options.assertAuthority,
          beforeStart: options.beforeStart
        }, intent.deadlineAt)
      }
      return this.operation(operationId)
    } finally {
      if (authorityGuard && this.operationInputs.get(operationId) === authorityGuard)
        this.operationInputs.delete(operationId)
      this.recoveryInputs.delete(operationId)
      this.recoveryResourceGuards.delete(operationId)
    }
  }

  /** Explicit validation-only operation; it checks existing artifacts without launching a Skill. */
  async validate(operationId: string, assertAuthority?: () => void): Promise<HostProjectOperation> {
    assertAuthority?.()
    const operation = this.operation(operationId)
    const project = this.project(operation.projectId)
    this.assertCommand(project, "validate")
    const assertNotImportedPrefix = () => {
      if (this.store.importedSource(operation.projectId)?.review.prefixStageIds.includes(operation.stageId))
        hostStateError("IMPORTED_STAGE_REVALIDATION_REQUIRED")
    }
    assertNotImportedPrefix()
    const stage = project.manifest.stages[project.stageIndex]
    if (!stage) hostStateError("PROJECT_COMPLETED")
    if (
      (stage.actionIds.length || operation.contextProvider) &&
      operation.execution?.terminal?.outcome !== "success"
    )
      hostStateError("ACTION_EXECUTION_REQUIRED")
    this.snapshot(project)
    await this.deps.authorize(structuredClone(project), structuredClone(operation))
    assertAuthority?.()
    this.assertCommand(this.project(project.projectId), "validate")
    assertNotImportedPrefix()
    const ticket = this.store.start(operationId, this.fingerprint(project))
    try {
      const receipts = this.validateTicket(project, ticket)
      return this.store.recordResult(ticket, { outcome: "succeeded", receipts })
    } catch {
      // Only host read validators ran here; an I/O failure cannot hide an external write.
      return this.store.recordResult(ticket, { outcome: "failed", receipts: [] })
    }
  }

  /** Read-only provenance for the current stage or an accepted original upstream stage. */
  captureWorkflowEvidenceStage(projectId: string, currentOperationId: string, stageId: string) {
    const currentProject = this.project(projectId)
    const currentOperation = this.operation(currentOperationId)
    const history = this.store.listOperations(projectId, 100)
    const stageIndex = currentProject.manifest.stages.findIndex(stage => stage.id === stageId)
    const currentStage = currentProject.manifest.stages[currentProject.stageIndex]
    if (history.length >= 100 || stageIndex < 0 || stageIndex > currentProject.stageIndex ||
      currentOperation.projectId !== projectId || currentOperation.stageId !== currentStage?.id ||
      currentOperation.expectedVersion !== currentProject.version ||
      !["started", "succeeded"].includes(currentOperation.status))
      hostStateError("WORKFLOW_EVIDENCE_SCOPE_INVALID")
    const upstream = stageIndex < currentProject.stageIndex
    const selected = upstream ? this.store.lastStageTransition(projectId, stageId)
      : { project: currentProject, operation: currentOperation }
    const operation = selected.operation
    if (upstream && history.filter(item => item.stageId === stageId &&
      item.status === "transitioned").length !== 1) hostStateError("WORKFLOW_EVIDENCE_AMBIGUOUS")
    const threadId = operation.execution?.threadId
    if (!threadId) hostStateError("WORKFLOW_EVIDENCE_UNSETTLED")
    const terminal = operation.execution?.terminal
    const liveSkill = !upstream && !terminal && operation.status === "started"
      ? captureSettledProjectSkill({
          projectId, operationId: operation.operationId, stageId, threadId,
          pluginDigest: operation.pluginDigest, inputFingerprint: operation.inputFingerprint
        })
      : undefined
    const assertSkillSettled = () => {
      if (liveSkill) liveSkill.assertCurrent()
      else if (terminal?.outcome !== "success" || !Number.isFinite(terminal.settledAt))
        hostStateError("WORKFLOW_EVIDENCE_UNSETTLED")
    }
    assertSkillSettled()
    // Main-only cache identity; neither the nonce nor this identity is returned to the Guest.
    const settlementIdentity = liveSkill ? `live:${liveSkill.nonce}` : "durable"
    const stageContract = (project: HostProjectState) => {
      const stage = project.manifest.stages.find(item => item.id === stageId)
      return JSON.stringify({ stage,
        checks: project.manifest.checks.filter(item => stage?.checkIds.includes(item.id)),
        artifacts: project.manifest.artifacts.filter(item => stage?.artifactIds.includes(item.id)),
        actions: project.manifest.actions.filter(item => stage?.actionIds.includes(item.id) ||
          project.manifest.checks.some(check => stage?.checkIds.includes(check.id) && check.actionId === item.id))
      })
    }
    if (stageContract(selected.project) !== stageContract(currentProject))
      hostStateError("WORKFLOW_EVIDENCE_CONTRACT_CHANGED")
    const identity = JSON.stringify([currentProject, currentOperation, selected])
    const assertCurrent = () => {
      assertSkillSettled()
      const latest = this.project(projectId)
      const owner = this.operation(currentOperationId)
      const previous = upstream ? this.store.lastStageTransition(projectId, stageId)
        : { project: latest, operation: owner }
      if (JSON.stringify([latest, owner, previous]) !== identity)
        hostStateError("WORKFLOW_EVIDENCE_CHANGED")
      this.assertCommand(latest, "validate")
    }
    const assertEvidenceCurrent = () => {
      assertCurrent()
      liveSkill?.assertContentCurrent()
      if (upstream) {
        const stage = selected.project.manifest.stages[stageIndex]
        this.assertStageEvidenceCurrent(selected.project, operation, stage.checkIds)
        const historical = { ...selected.project, version: operation.expectedVersion, stageIndex }
        if (effectiveHostResultApproval(stage, this.store.importedSource(projectId))) {
          if (operation.resultApproval?.decision !== "approved")
            hostStateError("RESULT_APPROVAL_REQUIRED")
          assertHostResultReview(this.captureResultReview(historical, operation), operation.resultApproval)
        }
      } else if (this.fingerprint(this.project(projectId)) !== operation.inputFingerprint)
        hostStateError("INPUT_CHANGED")
      assertCurrent()
    }
    assertCurrent()
    return { project: selected.project, operation, assertCurrent, assertSkillSettled,
      assertEvidenceCurrent, settlementIdentity }
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
    assertHostReceiptsCurrent(state, operation, evidence, this.runtimeInputIdentity(historical, root))
  }

  resultReview(operationId: string): HostResultReview {
    const operation = this.operation(operationId)
    const project = this.project(operation.projectId)
    this.assertCommand(project, "approve")
    if (operation.status !== "succeeded") hostStateError("VALIDATION_REQUIRED")
    if (this.fingerprint(project) !== operation.inputFingerprint) hostStateError("INPUT_CHANGED")
    this.assertStageEvidenceCurrent(
      project,
      operation,
      project.manifest.stages[project.stageIndex].checkIds
    )
    return this.captureResultReview(project, operation)
  }

  decideResultApproval(operationId: string, input: HostResultApprovalInput): HostProjectOperation {
    const current = this.resultReview(operationId)
    assertHostResultReview(current, input)
    return this.store.decideResultApproval(operationId, input)
  }

  private captureResultReview(
    project: HostProjectState,
    operation: HostProjectOperation
  ): HostResultReview {
    let totalBytes = 0
    const artifacts = project.manifest.stages[project.stageIndex].artifactIds.map((id) => {
      const artifact = project.manifest.artifacts.find((item) => item.id === id)!
      const file = readRuntimeScopedFile(project.workspace, artifact.path)
      totalBytes += file.bytes?.length ?? 0
      if (totalBytes > 16 * 1024 * 1024) hostStateError("VALIDATION_LIMIT")
      if (artifact.required && !file.present) hostStateError("REQUIRED_INPUT_MISSING")
      return [id, file.path, file.fingerprint]
    })
    return hostResultReview(project, operation, runtimeDigest(JSON.stringify(artifacts)), this.store.importedSource(project.projectId))
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
    return this.store.transition(
      operationId,
      fingerprint,
      effectiveHostResultApproval(project.manifest.stages[project.stageIndex], this.store.importedSource(project.projectId))
        ? this.captureResultReview(project, operation)
        : undefined
    )
  }

  /** Bounded dispatch; every stage goes through the same authorization and commit services. */
  async continue(
    projectId: string,
    options: {
      maxSteps?: number
      maxDurationMs?: number
      assertAuthority?: () => void
      beforeStart?: (operation: HostProjectOperation) => void | Promise<void>
    } = {}
  ): Promise<HostContinuationResult> {
    return this.runContinuation(projectId, options)
  }

  private runContinuation(projectId: string, options: {
    maxSteps?: number
    maxDurationMs?: number
    assertAuthority?: () => void
    beforeStart?: (operation: HostProjectOperation) => void | Promise<void>
  }, originalDeadlineAt?: number): Promise<HostContinuationResult> {
    const running = this.continueWithin(projectId, options, originalDeadlineAt).finally(() => {
      if (this.continuationJobs.get(projectId) === running) this.continuationJobs.delete(projectId)
    })
    if (!this.continuationJobs.has(projectId)) this.continuationJobs.set(projectId, running)
    return running
  }

  private async continueWithin(projectId: string, options: {
    maxSteps?: number
    maxDurationMs?: number
    assertAuthority?: () => void
    beforeStart?: (operation: HostProjectOperation) => void | Promise<void>
  }, originalDeadlineAt?: number): Promise<HostContinuationResult> {
    const maxSteps = hostInteger(options.maxSteps ?? 16, 1)
    const maxDurationMs = hostInteger(options.maxDurationMs ?? 300_000, 1)
    if (maxSteps > 64 || maxDurationMs > 3_600_000) hostStateError("LIMIT_INVALID")
    const operations: HostProjectOperation[] = []
    const finish = (
      reason: HostContinuationResult["reason"],
      error?: string
    ): HostContinuationResult => ({
      project: this.project(projectId),
      operations,
      reason,
      ...(error ? { error } : {})
    })
    if (this.continuations.has(projectId)) return finish("busy")
    this.continuations.add(projectId)
    const deadlineAt = originalDeadlineAt ?? Date.now() + maxDurationMs
    const deadline = performance.now() + Math.max(0, Math.min(maxDurationMs, deadlineAt - Date.now()))
    try {
      for (let step = 0; step < maxSteps; step++) {
        options.assertAuthority?.()
        const project = this.project(projectId)
        if (project.status === "completed") return finish("completed")
        if (performance.now() >= deadline) return finish("budget")
        await this.prepareRuntimeInputs(projectId)
        options.assertAuthority?.()
        this.assertCommand(this.project(projectId), "prepare")
        let operation = this.operations(projectId, 1).find(
          (item) =>
            item.expectedVersion === project.version &&
            item.stageId === project.manifest.stages[project.stageIndex].id
        )
        operation ??= this.prepare({
          projectId,
          expectedVersion: project.version,
          idempotencyKey: `continue:${project.version}`
        })
        if (operation.status === "prepared") {
          const stage = project.manifest.stages[project.stageIndex]
          if (
            (stage.approval === "human" || operation.contextProvider) &&
            operation.approval?.decision !== "approved"
          ) {
            operations.push(operation)
            return finish("approval_required")
          }
          if (performance.now() >= deadline) return finish("budget")
          await options.beforeStart?.(operation)
          options.assertAuthority?.()
          if (performance.now() >= deadline) return finish("budget")
          this.continuationIntents.set(operation.operationId, { remainingSteps: maxSteps - step, deadlineAt })
          try {
            operation = await this.start(operation.operationId, options.assertAuthority
              ? { assertInputsCurrent: options.assertAuthority } : undefined)
          }
          finally { this.continuationIntents.delete(operation.operationId) }
          options.assertAuthority?.()
        }
        operations.push(operation)
        if (operation.status === "unknown") return finish("unknown")
        if (operation.status === "failed") return finish("failed")
        if (operation.status === "cancelled" || operation.status === "cancel_requested")
          return finish("cancelled")
        if (operation.status !== "succeeded") return finish("busy")
        if (effectiveHostResultApproval(project.manifest.stages[project.stageIndex], this.store.importedSource(project.projectId))) {
          if (operation.resultApproval?.decision === "rejected") return finish("result_rejected")
          if (!operation.resultApproval) return finish("result_approval_required")
        }
        options.assertAuthority?.()
        this.transition(operation.operationId)
        operations[operations.length - 1] = this.operation(operation.operationId)
      }
      return finish(this.project(projectId).status === "completed" ? "completed" : "budget")
    } catch (error) {
      return finish(
        "blocked",
        error instanceof Error ? error.message : "PROJECT_HOST_CONTINUE_BLOCKED"
      )
    } finally {
      this.continuations.delete(projectId)
    }
  }

  cancel(operationId: string): HostProjectOperation {
    const operation = this.operation(operationId)
    this.assertCommand(this.project(operation.projectId), "cancel")
    return this.coordinator.cancel(operationId)
  }
  recoverInterrupted(): string[] {
    return this.store.recoverInterrupted()
  }

  async reconcile(operationId: string, assertAuthority?: () => void): Promise<HostProjectOperation> {
    assertAuthority?.()
    const operation = this.operation(operationId)
    await this.deps.reconcileRecoveryHooks?.(this.project(operation.projectId))
    assertAuthority?.()
    this.assertCommand(this.project(operation.projectId), "reconcile")
    const inspect = this.deps.inspectOperation
    if (!inspect) hostStateError("RECONCILE_UNSUPPORTED")
    return this.store.reconcile(operationId, async (operation, project) => {
      const inspection = this.deps.authorizeInspection
        ? await this.deps.authorizeInspection(structuredClone(project), structuredClone(operation))
        : await this.deps.authorize(structuredClone(project), structuredClone(operation))
      assertAuthority?.()
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
      assertAuthority?.()
      if (inspection) inspection.assertCurrent()
      if (outcome !== "succeeded") return { outcome, receipts: [] }
      this.assertImportedMappedFilesCurrent(project, operation)
      if (this.fingerprint(project) !== operation.inputFingerprint)
        return { outcome: "unknown", receipts: [] }
      return { outcome: "succeeded", receipts: this.validateTicket(project, ticket) }
    }, assertAuthority)
  }

  private project(id: string): HostProjectState {
    return this.store.get(id) ?? hostStateError("PROJECT_MISSING")
  }
  private contextProviderRequest(project: HostProjectState): {
    contextProvider?: HostContextProviderRequest
  } {
    const root = this.snapshot(project).root
    const provider = readPackageExtensionContract(root)?.context?.provider
    if (!provider?.entry) return {}
    const policy = readStageRecoveryPolicy(root)
    if (
      process.platform !== "win32" ||
      policy?.hookExecution !== "windows-sandbox" ||
      !policy.contextProvider
    )
      hostStateError("CONTEXT_PROVIDER_RECOVERY_REQUIRED")
    return {
      contextProvider: {
        protocol: "devclaw.context-text/v1",
        policyDigest: runtimeDigest(JSON.stringify([project.pluginDigest, provider.entry, policy])),
        notice:
          "此阶段将执行保留的上下文脚本，使用受限令牌和独立可变目录。脚本可能访问网络；外部效果不能自动撤回。请单独批准本次阶段的精确脚本与策略。"
      }
    }
  }
  private assertContextProviderRequest(project: HostProjectState, operation: HostProjectOperation) {
    if (
      JSON.stringify(this.contextProviderRequest(project).contextProvider) !==
      JSON.stringify(operation.contextProvider)
    )
      hostStateError("CONTEXT_PROVIDER_POLICY_CHANGED")
  }
  private assertCommand(project: HostProjectState, kind: HostProjectCommandKind): void {
    this.deps.assertCommand?.(structuredClone(project), kind)
  }
  private operation(id: string): HostProjectOperation {
    return this.store.getOperation(id) ?? hostStateError("OPERATION_MISSING")
  }
  private assertResultFeedbackCurrent(operation: HostProjectOperation): void {
    const current = this.operation(operation.operationId)
    if (current.stageInstructions !== operation.stageInstructions)
      hostStateError("STAGE_INSTRUCTIONS_CHANGED")
    if (JSON.stringify(current.resultFeedbackSource) !== JSON.stringify(operation.resultFeedbackSource))
      hostStateError("RESULT_FEEDBACK_CHANGED")
    if (operation.resultFeedbackSource)
      readHostResultFeedback(operation, this.store.getOperation(operation.resultFeedbackSource.operationId))
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
    if (!skillPath) hostStateError("SKILL_MISSING")
    readHostPackageSkill(snapshot.root, skillPath)
    const previous = previousHostCheckOperation(operation, this.store.listOperations(project.projectId, 200))
    return {
      project: structuredClone(project),
      operation: structuredClone(operation),
      ticket,
      snapshotRoot: snapshot.root,
      skillPath,
      goal: project.goal,
      stageInstructions: operation.stageInstructions,
      previousResultFeedback: operation.resultFeedbackSource
        ? readHostResultFeedback(operation, this.store.getOperation(operation.resultFeedbackSource.operationId))
        : undefined,
      previousCheckDiagnostics: previous
        ? this.withCheckDiagnostics(previous).execution?.terminal?.checkDiagnostics : undefined,
      bindThread: (threadId: string) => this.store.bindExecutionThread(ticket, threadId),
      recordTerminal: (terminal: HostExecutionTerminal) => this.store.recordExecutionTerminal(ticket, terminal)
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
