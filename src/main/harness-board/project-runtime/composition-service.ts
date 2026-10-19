import { canonicalStageCheckJson } from "../../../shared/project-runtime/stage-check-receipt"
import { registerProjectCheckpointProvider } from "./project-checkpoint"
import { compositionDigest, compositionText } from "../../../shared/project-runtime/composition"
import { assertCurrentRuntimePluginSourceContent } from "../../plugins/runtime-source-scope"
import { registerStageCheckReceiptSink } from "../../hooks/stage-check-receipts"
import { CompositionStageCheckStore } from "./composition-stage-check-store"
import {
  captureSourceHandoffBaseline,
  readSourceHandoffContract
} from "./composition-source-handoff"
import { AsyncLocalStorage } from "node:async_hooks"
import { CompositionInternalProjects } from "./composition-internal-projects"
import {
  CompositionLegacyAdapter,
  type CompositionLegacyDependencies
} from "./composition-legacy-adapter"
import type { ProjectCompositionDefinition } from "../../../shared/project-runtime/composition"
import { parseProjectComposition } from "../../../shared/project-runtime/composition"
import type { HostProjectService } from "./host-service"
import {
  CompositionHostAdapter,
  type CompositionHostAdapterDependencies
} from "./composition-host-adapter"
import {
  ProjectCompositionCoordinator,
  type CompositionExecutionContext
} from "./composition-coordinator"
import { ProjectCompositionStore, type CompositionRun } from "./composition-store"
import { dirname, join } from "node:path"
import { CompositionWorkspaces } from "./composition-workspaces"

export interface ProjectCompositionServiceDependencies extends CompositionHostAdapterDependencies {
  /** Real parent identity, selected capabilities, frozen package versions and permission checks. */
  authorizeDefinition(definition: ProjectCompositionDefinition): Promise<void>
  /** Parent access only: cancellation must survive source disablement or an upgrade. */
  authorizeParent(definition: ProjectCompositionDefinition): Promise<void>
  /** Must inspect original host/legacy/ordinary project operations synchronously under shared mutex. */
  assertWorkspaceIdle(workspace: string, parentProjectId: string): void
  legacy?: CompositionLegacyDependencies
  inputPath?(context: CompositionExecutionContext, inputId: string): string
  /** Original native configuration/grants, captured and rechecked immediately before claim. */
  configurationReady?(run: CompositionRun): Promise<() => void>
}

/** Production service; the owner window and trusted scope are supplied by the application IPC layer. */
export class ProjectCompositionService {
  readonly store: ProjectCompositionStore
  readonly adapter: CompositionHostAdapter
  readonly legacy?: CompositionLegacyAdapter
  private stopInternal?: () => void
  private stopStageChecks?: () => void
  private stopCheckpoint?: () => void
  private stageChecks?: CompositionStageCheckStore
  private readonly cancelling = new AsyncLocalStorage<boolean>()
  private readonly workspaces: CompositionWorkspaces
  private readonly coordinator: ProjectCompositionCoordinator
  constructor(
    databasePath: string,
    host: HostProjectService,
    private readonly deps: ProjectCompositionServiceDependencies
  ) {
    this.store = new ProjectCompositionStore(databasePath, undefined, deps.assertWorkspaceIdle)
    this.workspaces = new CompositionWorkspaces(
      join(dirname(databasePath), "composition-workspaces"),
      this.store,
      deps.inputPath
    )
    this.adapter = new CompositionHostAdapter(host, {
      ...deps,
      assertInputsCurrent: (context) => this.workspaces.assertInputsCurrent(context),
      authorizeCancellation: (context) =>
        deps.authorizeParent(this.store.get(context.runId)!.definition)
    })
    if (deps.legacy) {
      const projects = new CompositionInternalProjects(
        join(dirname(databasePath), "internal-projects.sqlite"),
        (record, kind) => {
          const run = this.store.get(record.compositionRunId)
          const unit = run?.definition.units.find((unit) => unit.id === record.unitId)
          if (
            !run ||
            !unit ||
            run.definition.parentProjectId !== record.parentProjectId ||
            unit.source.pluginId !== record.plugin.id ||
            unit.source.packageDigest !== record.packageDigest ||
            (kind !== "authority" && this.store.unitWorkspace(run.id, unit.id) !== record.workspace) ||
            JSON.stringify(run.unitContexts?.[unit.id]) !== JSON.stringify(record.contextSelection)
          )
            throw Error("COMPOSITION_INTERNAL_SCOPE_CHANGED")
          const state = run.units.find((unit) => unit.id === record.unitId)
          if (
            !state?.attemptId ||
            (kind === "authority" && !["running", "waiting-approval"].includes(state.status)) ||
            !["running", "waiting-approval", "cancel-requested"].includes(run.status)
          )
            throw Error("COMPOSITION_INTERNAL_SCOPE_CHANGED")
          if (!this.cancelling.getStore()) {
            const context: CompositionExecutionContext = {
              runId: run.id,
              parentProjectId: run.definition.parentProjectId,
              workspace: run.definition.workspace,
              executionWorkspace: record.workspace,
              unit,
              attemptId: state.attemptId,
              idempotencyKey: JSON.stringify([run.id, unit.id]),
              engineRunId: record.engineRunId,
              inputs: []
            }
            if (kind === "authority" && deps.legacy?.assertAuthorityCurrent)
              deps.legacy.assertAuthorityCurrent(context, run.definition)
            else deps.legacy?.assertCurrent?.(context)
          }
          if (kind === "authority") return this.store.assertWorkspaceAuthority(
            record.workspace, { runId: run.id, unitId: unit.id }
          )
          else return this.store.guardWorkspaceMutation(record.workspace, () => undefined)
        }
      )
      if (deps.legacy.checkContracts) {
        const checks = (this.stageChecks = new CompositionStageCheckStore(
          join(dirname(databasePath), "stage-checks.sqlite")
        ))
        this.stopStageChecks = registerStageCheckReceiptSink(
          async ({ binding, hookId, hook, receipts, signal }) => {
            const record = projects.get(binding.projectId)
            if (
              !record ||
              !projects.context(record.projectId) ||
              record.workspace !== binding.workspace ||
              record.packageDigest !== binding.packageDigest ||
              record.plugin.id !== binding.plugin.id
            )
              throw Error("STAGE_CHECK_SCOPE_CHANGED")
            if (!deps.legacy!.assertStageCheckHook) throw Error("STAGE_CHECK_HOOK_UNVERIFIED")
            deps.legacy!.assertStageCheckHook(record, hook)
            const identity = deps.legacy!.stageCheckIdentity?.(record, binding.threadId)
            if (!identity) throw Error("STAGE_CHECK_ENGINE_ID_REQUIRED")
            await checks.append(
              record.workspace,
              {
                runId: record.compositionRunId,
                unitId: record.unitId,
                engineRunId: identity.engineRunId,
                packageDigest: record.packageDigest,
                threadId: binding.threadId,
                incarnationKey: binding.incarnationKey,
                hookId
              },
              receipts,
              {
                signal,
                assertCurrent: () => {
                  assertCurrentRuntimePluginSourceContent()
                  projects.context(record.projectId)
                  if (
                    deps.legacy!.stageCheckIdentity?.(record, binding.threadId)?.engineRunId !==
                    identity.engineRunId
                  )
                    throw Error("STAGE_CHECK_ENGINE_CHANGED")
                }
              }
            )
          }
        )
      }
      if (this.stageChecks && deps.legacy.transition) {
        const checks = this.stageChecks
        this.stopCheckpoint = registerProjectCheckpointProvider({
          available: (binding) => {
            const record = projects.get(binding.projectId)
            return Boolean(
              record &&
              projects.context(record.projectId) &&
              checks.contracts(record.compositionRunId, record.unitId)
            )
          },
          execute: async (binding, input) => {
            compositionText(input.checkpoint)
            compositionDigest(input.expectedStateDigest)
            if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.checkpoint))
              throw Error("PROJECT_CHECKPOINT_INVALID")
            const record = projects.get(binding.projectId)
            if (
              !record ||
              !projects.context(record.projectId) ||
              record.workspace !== binding.workspace ||
              record.packageDigest !== binding.packageDigest ||
              record.plugin.id !== binding.plugin.id
            )
              throw Error("STAGE_CHECK_SCOPE_CHANGED")
            const engine = deps.legacy!.stageCheckIdentity?.(record, binding.threadId)
            if (!engine) throw Error("STAGE_CHECK_ENGINE_ID_REQUIRED")
            const intent = checks.beginTransition(
              record.compositionRunId,
              record.unitId,
              input.checkpoint,
              input.expectedStateDigest
            )
            if (intent.prior) return intent.prior
            let validatedReceipts: string | undefined
            try {
              const result = await deps.legacy!.transition!(record, {
                ...input,
                validateReceipts: async (receipts) => {
                  input.signal?.throwIfAborted()
                  assertCurrentRuntimePluginSourceContent()
                  if (!projects.context(record.projectId)) throw Error("STAGE_CHECK_SCOPE_CHANGED")
                  if (receipts.length)
                    await checks.validateReceipts(
                      record.workspace,
                      record.compositionRunId,
                      record.unitId,
                      receipts,
                      input.signal
                    )
                  input.signal?.throwIfAborted()
                  assertCurrentRuntimePluginSourceContent()
                  projects.context(record.projectId)
                  if (
                    deps.legacy!.stageCheckIdentity?.(record, binding.threadId)?.engineRunId !==
                    engine.engineRunId
                  )
                    throw Error("STAGE_CHECK_ENGINE_CHANGED")
                  validatedReceipts = canonicalStageCheckJson(receipts)
                }
              })
              input.signal?.throwIfAborted()
              assertCurrentRuntimePluginSourceContent()
              if (result.status === "committed") {
                compositionDigest(result.stateDigest)
                if (
                  validatedReceipts === undefined ||
                  canonicalStageCheckJson(result.receipts) !== validatedReceipts
                )
                  throw Error("STAGE_CHECK_ACK_MISMATCH")
                if (result.receipts.length)
                  await checks.append(
                    record.workspace,
                    {
                      runId: record.compositionRunId,
                      unitId: record.unitId,
                      engineRunId: engine.engineRunId,
                      packageDigest: record.packageDigest,
                      threadId: binding.threadId,
                      incarnationKey: binding.incarnationKey,
                      hookId: "host:project_checkpoint"
                    },
                    result.receipts,
                    {
                      signal: input.signal,
                      assertCurrent: () => {
                        assertCurrentRuntimePluginSourceContent()
                        projects.context(record.projectId)
                        if (
                          deps.legacy!.stageCheckIdentity?.(record, binding.threadId)
                            ?.engineRunId !== engine.engineRunId
                        )
                          throw Error("STAGE_CHECK_ENGINE_CHANGED")
                      }
                    }
                  )
              } else if (result.receipts.length) throw Error("STAGE_CHECK_UNCOMMITTED_RECEIPT")
              checks.settleTransition(intent.id, result)
              return result
            } catch (error) {
              checks.settleTransition(intent.id, {
                status: "unknown",
                receipts: [],
                message:
                  "Original checkpoint outcome requires reconciliation; no replay is permitted"
              })
              throw error
            }
          }
        })
      }
      this.legacy = new CompositionLegacyAdapter(projects, {
        ...deps.legacy,
        createFeature: async (record) => {
          await deps.legacy!.createFeature(record)
          if (deps.legacy!.checkContracts)
            this.stageChecks!.freezeContracts(
              record.compositionRunId,
              record.unitId,
              await deps.legacy!.checkContracts(record)
            )
          const sourceContract = await readSourceHandoffContract(record.plugin.path)
          if (sourceContract) {
            if (!this.stageChecks) throw Error("SOURCE_HANDOFF_BASELINE_STORE_REQUIRED")
            this.stageChecks.freezeSourceBaseline(
              record.compositionRunId,
              record.unitId,
              await captureSourceHandoffBaseline(
                record.workspace,
                record.packageDigest,
                sourceContract
              )
            )
          }
        },
        sourceBaseline: (record) =>
          this.stageChecks?.sourceBaseline(record.compositionRunId, record.unitId),
        observe: async (record) => {
          const observed = await deps.legacy!.observe(record)
          const contracts = this.stageChecks?.contracts(record.compositionRunId, record.unitId)
          return contracts
            ? {
                ...observed,
                stageChecks: {
                  contracts,
                  receipts: this.stageChecks!.read(record.compositionRunId, record.unitId)
                }
              }
            : observed
        }
      })
      this.stopInternal = projects.register()
    }
    this.coordinator = new ProjectCompositionCoordinator(this.store, {
      authorize: (definition) => deps.authorizeDefinition(definition),
      authorizeCancellation: (definition) => deps.authorizeParent(definition),
      verifyInputs: async (context, phase) => {
        await deps.authorize(context)
        return this.workspaces.verifyInputs(context, phase)
      },
      verifyCompletion: (context, proof) =>
        this.store.withWorkspaceOwner(context.runId, () =>
          (this.legacy?.has(context) ? this.legacy : this.adapter).verifyCompletion(
            this.workspaces.locate(context),
            proof
          )
        ),
      execute: (context, signal) =>
        this.store.withWorkspaceOwner(context.runId, () =>
          this.executeUnit(this.workspaces.prepare(context), signal)
        ),
      resume: (context, signal) =>
        this.store.withWorkspaceOwner(context.runId, () =>
          (this.legacy?.has(context) ? this.legacy : this.adapter).resume(
            this.workspaces.locate(context),
            signal
          )
        ),
      reconcile: (context, signal) =>
        this.store.withWorkspaceOwner(context.runId, () =>
          (this.legacy?.has(context) ? this.legacy : this.adapter).reconcile(
            this.workspaces.locate(context),
            signal
          )
        ),
      cancel: (context) =>
        this.cancelling.run(true, () =>
          this.store.withWorkspaceOwner(context.runId, () =>
            (this.legacy?.has(context) ? this.legacy : this.adapter).cancel({
              ...context,
              executionWorkspace: this.store.unitWorkspace(context.runId, context.unit.id)
            })
          )
        )
    })
  }
  private async executeUnit(context: CompositionExecutionContext, signal: AbortSignal) {
    const source = await this.deps.resolveSource(context)
    if (source.runtimeMode === "legacy") {
      if (!this.legacy) throw Error("COMPOSITION_LEGACY_ADAPTER_UNAVAILABLE")
      return this.legacy.execute(context, signal)
    }
    return this.adapter.execute(context, signal)
  }
  start(definition: unknown, requestId: string): Promise<CompositionRun> {
    const parsed = parseProjectComposition(definition)
    // Independent skills use project capability admission; this service drives complete host flows.
    if (parsed.units.some((unit) => unit.kind !== "flow")) throw Error("COMPOSITION_FLOW_REQUIRED")
    return this.coordinator.start(parsed, requestId)
  }
  startBackground(definition: unknown, requestId: string): Promise<CompositionRun> {
    const parsed = parseProjectComposition(definition)
    if (parsed.units.some((unit) => unit.kind !== "flow")) throw Error("COMPOSITION_FLOW_REQUIRED")
    return this.coordinator.startBackground(parsed, requestId)
  }
  async prepare(definition: unknown, requestId: string): Promise<CompositionRun> {
    const parsed = parseProjectComposition(definition)
    if (parsed.units.some(unit => unit.kind !== "flow")) throw Error("COMPOSITION_FLOW_REQUIRED")
    const run = await this.coordinator.prepare(parsed, requestId)
    if (run.configurationPending)
      for (const unit of run.definition.units) this.workspaces.allocate(run.id, unit.id)
    return run
  }
  async startPrepared(runId: string, expectedVersion: number): Promise<CompositionRun> {
    const run = this.store.get(runId)
    if (!run || run.version !== expectedVersion) throw Error("COMPOSITION_VERSION_CONFLICT")
    const assertReady = await this.deps.configurationReady?.(run)
    return this.coordinator.startPrepared(runId, expectedVersion, assertReady)
  }
  resumeBackground(runId: string, expectedVersion: number): Promise<CompositionRun> {
    return this.coordinator.resumeBackground(runId, expectedVersion)
  }
  waitForSettlement(runId: string): Promise<CompositionRun> {
    return this.coordinator.waitForSettlement(runId)
  }
  get(runId: string): CompositionRun | undefined {
    return this.store.get(runId)
  }
  list(parentProjectId: string, limit = 50): CompositionRun[] {
    return this.store.list(parentProjectId, limit)
  }
  resume(runId: string, expectedVersion: number): Promise<CompositionRun> {
    return this.coordinator.resume(runId, expectedVersion)
  }
  cancel(runId: string): Promise<CompositionRun> {
    return this.coordinator.cancel(runId)
  }
  guardWorkspaceMutation<T>(workspace: string, work: () => T): T {
    return this.store.guardWorkspaceMutation(workspace, work)
  }
  parentForHostUnit(projectId: string): string | undefined {
    return this.store.parentForHostUnit(projectId)
  }
  recoverInterrupted(): CompositionRun[] {
    return this.store.recoverInterruptedRuns()
  }
  close(): void {
    this.stopCheckpoint?.()
    this.stopStageChecks?.()
    this.stageChecks?.close()
    this.stopInternal?.()
    this.legacy?.projects.close()
    this.store.close()
  }
  private context(runId: string, unitId: string): CompositionExecutionContext {
    const run = this.store.get(runId)
    const state = run?.units.find((unit) => unit.id === unitId)
    const unit = run?.definition.units.find((unit) => unit.id === unitId)
    if (!run || !state || !unit || state.status !== "waiting-approval" || !state.attemptId)
      throw Error("COMPOSITION_APPROVAL_CHANGED")
    return {
      runId,
      parentProjectId: run.definition.parentProjectId,
      workspace: run.definition.workspace,
      executionWorkspace: this.store.unitWorkspace(runId, unitId),
      unit,
      attemptId: state.attemptId,
      idempotencyKey: JSON.stringify([runId, unitId]),
      engineRunId: state.engineRunId,
      inputs: []
    }
  }
  executionThreadIds(runId: string, unitId: string): string[] {
    const run = this.store.get(runId)
    const state = run?.units.find((unit) => unit.id === unitId)
    const unit = run?.definition.units.find((unit) => unit.id === unitId)
    if (
      !run ||
      !state?.attemptId ||
      !unit ||
      !["running", "waiting-approval"].includes(run.status) ||
      !["running", "waiting-approval"].includes(state.status)
    )
      return []
    const context: CompositionExecutionContext = {
      runId,
      parentProjectId: run.definition.parentProjectId,
      workspace: run.definition.workspace,
      executionWorkspace: this.store.unitWorkspace(runId, unitId),
      unit,
      attemptId: state.attemptId,
      idempotencyKey: JSON.stringify([runId, unitId]),
      engineRunId: state.engineRunId,
      inputs: []
    }
    return this.store.withWorkspaceOwner(runId, () => [
      ...new Set(
        (this.legacy?.has(context) ? this.legacy : this.adapter).executionThreadIds(context)
      )
    ])
  }
  isLegacyUnit(runId: string, unitId: string): boolean {
    return Boolean(this.legacy?.projects.get(`composition-legacy:${runId}:${unitId}`))
  }
  waitingLegacyDecision(runId: string, unitId: string) {
    return this.store.withWorkspaceOwner(runId, () =>
      this.legacy?.waitingDecision(this.context(runId, unitId))
    )
  }
  async decideLegacy(
    runId: string,
    unitId: string,
    expectedVersion: number,
    input: import("./composition-legacy-adapter").LegacyDecisionInput
  ) {
    const context = this.context(runId, unitId)
    if (!this.legacy) throw Error("COMPOSITION_LEGACY_ADAPTER_UNAVAILABLE")
    if (
      !["continue", "new_thread", "stop"].includes(input.action) ||
      (input.message !== undefined &&
        (typeof input.message !== "string" || input.message.length > 10000))
    )
      throw Error("COMPOSITION_DECISION_INVALID")
    await this.deps.authorizeDefinition(this.store.get(runId)!.definition)
    return this.store.withWorkspaceOwner(runId, async () => {
      if (this.legacy!.waitingDecision(context)?.notificationId !== input.notificationId)
        throw Error("COMPOSITION_DECISION_CHANGED")
      this.store.consumeApproval(runId, unitId, expectedVersion)
      return this.legacy!.decide(context, input)
    })
  }
  waitingLegacyApproval(runId: string, unitId: string) {
    return this.store.withWorkspaceOwner(runId, () =>
      this.legacy?.waitingApproval(this.context(runId, unitId))
    )
  }
  async approveLegacy(
    runId: string,
    unitId: string,
    gateId: string,
    expectedRunVersion: number,
    decision: "approve" | "reject"
  ) {
    const context = this.context(runId, unitId)
    if (!this.legacy) throw Error("COMPOSITION_LEGACY_ADAPTER_UNAVAILABLE")
    await this.deps.authorizeDefinition(this.store.get(runId)!.definition)
    return this.store.withWorkspaceOwner(runId, async () => {
      if (this.legacy!.waitingApproval(context)?.gateId !== gateId)
        throw Error("COMPOSITION_APPROVAL_CHANGED")
      this.store.consumeApproval(runId, unitId, expectedRunVersion)
      await this.legacy!.approve(context, gateId, decision)
      return this.store.get(runId)!
    })
  }
  waitingOperation(runId: string, unitId: string) {
    return this.adapter.waitingOperation(this.context(runId, unitId))
  }
  async approve(
    runId: string,
    unitId: string,
    operationId: string,
    input: Parameters<HostProjectService["approve"]>[1]
  ) {
    const context = this.context(runId, unitId)
    await this.deps.authorizeDefinition(this.store.get(runId)!.definition)
    return this.store.withWorkspaceOwner(runId, () =>
      this.adapter.approve(context, operationId, input)
    )
  }
}
