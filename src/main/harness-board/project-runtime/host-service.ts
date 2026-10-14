import type {
  HostActionResult,
  HostExecutionTicket,
  HostProjectOperation,
  HostProjectState
} from "../../../shared/project-runtime/host-types"
import { HostProjectCoordinator } from "./host-coordinator"
import { HostPackageSnapshots } from "./package-snapshots"
import { HostProjectStore } from "./host-store"
import { hostGoal, hostRecord, hostStateError, hostText } from "./host-state-protocol"
import {
  assertHostReceiptsCurrent,
  fingerprintHostStageInput,
  validateHostStage
} from "./host-validators"
import { readRuntimeScopedFile, runtimeDirectory } from "./safe-files"
import { assertHostPackageSupported } from "./package-preflight"

export interface HostInstalledPackage {
  installedPluginId: string
  root: string
  packageId: string
  packageVersion: string
  enabled: boolean
}

export interface HostSkillExecutionContext {
  knowledgeReference?: string
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
  prepareThread?: (threadId: string) => Promise<void>
}

export interface HostProjectServiceDependencies {
  resolveInstalledPlugin: (installedPluginId: string) => Promise<HostInstalledPackage | undefined>
  authorize: (project: HostProjectState, operation: HostProjectOperation) => Promise<void>
  /** Use the original lifecycle, with ALL Skill/Hook/script/resource reads bound to snapshotRoot. */
  executeSkill: (context: HostSkillExecutionContext) => Promise<HostActionResult["outcome"]>
  /** Optional result inspection only. Absence means unknown operations require manual recovery. */
  inspectOperation?: (
    context: Omit<HostSkillExecutionContext, "signal">
  ) => Promise<HostActionResult["outcome"]>
}

/** Main-process service. IPC must derive/authorize project scope before invoking these methods. */
export class HostProjectService {
  private readonly coordinator: HostProjectCoordinator
  constructor(
    private readonly store: HostProjectStore,
    private readonly snapshots: HostPackageSnapshots,
    private readonly deps: HostProjectServiceDependencies
  ) {
    this.coordinator = new HostProjectCoordinator(store, {
      authorize: async (project, operation) => {
        const snapshot = this.snapshot(project)
        assertHostPackageSupported(snapshot.root, project.manifest)
        await deps.authorize(project, operation)
      },
      fingerprint: async (project) => fingerprintHostStageInput(project, project.goal),
      execute: async (project, ticket, signal) => {
        const operation = this.operation(ticket.operationId)
        return deps.executeSkill({ ...this.executionContext(project, operation, ticket), signal })
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

  async localCreate(input: {
    projectId: string
    name: string
    workspace: string
    installedPluginId: string
    goal: string
  }): Promise<HostProjectState> {
    hostRecord(input, ["projectId", "name", "workspace", "installedPluginId", "goal"])
    input = structuredClone(input)
    hostText(input.projectId)
    hostText(input.name)
    hostGoal(input.goal)
    const workspace = runtimeDirectory(input.workspace)
    const installed = await this.deps.resolveInstalledPlugin(hostText(input.installedPluginId))
    if (!installed || !installed.enabled || installed.installedPluginId !== input.installedPluginId)
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
    return this.store.create({
      ...input,
      workspace,
      packageId: installed.packageId,
      packageVersion: installed.packageVersion,
      pluginDigest: snapshot.digest,
      manifest: snapshot.manifest
    })
  }

  prepare(input: {
    projectId: string
    expectedVersion: number
    idempotencyKey: string
  }): HostProjectOperation {
    hostRecord(input, ["projectId", "expectedVersion", "idempotencyKey"])
    const previous = this.store.findOperation(input.projectId, input.idempotencyKey)
    if (previous) {
      if (previous.expectedVersion !== input.expectedVersion) hostStateError("IDEMPOTENCY_CONFLICT")
      return previous
    }
    const project = this.project(input.projectId)
    this.snapshot(project)
    const stage = project.manifest.stages[project.stageIndex]
    if (!stage) hostStateError("PROJECT_COMPLETED")
    return this.store.prepare({
      ...input,
      stageId: stage.id,
      inputFingerprint: fingerprintHostStageInput(project, project.goal)
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
    if (fingerprintHostStageInput(project, project.goal) !== operation.inputFingerprint)
      hostStateError("INPUT_CHANGED")
    return this.store.decideApproval(operationId, input)
  }

  start(operationId: string): Promise<HostProjectOperation> {
    return this.coordinator.executePrepared(operationId)
  }

  /** Explicit validation-only operation; it checks existing artifacts without launching a Skill. */
  async validate(operationId: string): Promise<HostProjectOperation> {
    const operation = this.operation(operationId)
    const project = this.project(operation.projectId)
    const stage = project.manifest.stages[project.stageIndex]
    if (!stage) hostStateError("PROJECT_COMPLETED")
    if (stage.actionIds.length && operation.execution?.terminal?.outcome !== "success")
      hostStateError("ACTION_EXECUTION_REQUIRED")
    this.snapshot(project)
    await this.deps.authorize(structuredClone(project), structuredClone(operation))
    const ticket = this.store.start(operationId, fingerprintHostStageInput(project, project.goal))
    try {
      const receipts = this.validateTicket(project, ticket)
      return this.store.recordResult(ticket, { outcome: "succeeded", receipts })
    } catch {
      // Only host read validators ran here; an I/O failure cannot hide an external write.
      return this.store.recordResult(ticket, { outcome: "failed", receipts: [] })
    }
  }

  transition(operationId: string): HostProjectState {
    const operation = this.operation(operationId)
    if (operation.status === "transitioned")
      return this.store.transition(operationId, operation.inputFingerprint)
    const project = this.project(operation.projectId)
    this.snapshot(project)
    const fingerprint = fingerprintHostStageInput(project, project.goal)
    assertHostReceiptsCurrent(project, operation)
    // No await follows revalidation. External processes are not locked: receipts prove this check time only.
    return this.store.transition(operationId, fingerprint)
  }

  cancel(operationId: string): HostProjectOperation {
    return this.coordinator.cancel(operationId)
  }
  recoverInterrupted(): string[] {
    return this.store.recoverInterrupted()
  }

  async reconcile(operationId: string): Promise<HostProjectOperation> {
    const inspect = this.deps.inspectOperation
    if (!inspect) hostStateError("RECONCILE_UNSUPPORTED")
    return this.store.reconcile(operationId, async (operation, project) => {
      await this.deps.authorize(structuredClone(project), structuredClone(operation))
      const ticket: HostExecutionTicket = Object.freeze({
        operationId,
        projectId: project.projectId,
        stageId: operation.stageId,
        expectedVersion: operation.expectedVersion,
        inputFingerprint: operation.inputFingerprint,
        pluginDigest: operation.pluginDigest
      })
      const outcome = await inspect(this.executionContext(project, operation, ticket))
      if (outcome !== "succeeded") return { outcome, receipts: [] }
      if (fingerprintHostStageInput(project, project.goal) !== operation.inputFingerprint)
        return { outcome: "unknown", receipts: [] }
      return { outcome: "succeeded", receipts: this.validateTicket(project, ticket) }
    })
  }

  private project(id: string): HostProjectState {
    return this.store.get(id) ?? hostStateError("PROJECT_MISSING")
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
    if (fingerprintHostStageInput(project, project.goal) !== ticket.inputFingerprint)
      hostStateError("INPUT_CHANGED")
    return validateHostStage(project, ticket, signal)
  }
}
