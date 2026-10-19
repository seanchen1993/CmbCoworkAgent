import type { AppDecisionResult } from "../../../shared/app-notifications"
import type { ProjectCheckpointInput, ProjectCheckpointResult } from "./project-checkpoint"
import type { StageCheckInvocation } from "../../hooks/stage-check-receipts"
import type { StageCheckContract } from "../../../shared/project-runtime/stage-check-receipt"
import type {
  HarnessHumanGateSnapshot,
  HarnessProjectMetadata
} from "../../../shared/harness-board-types"
import type { PluginMetadata } from "../../types"
import type {
  CompositionCompletionProof,
  ProjectCompositionDefinition
} from "../../../shared/project-runtime/composition"
import type {
  CompositionEngineResult,
  CompositionExecutionContext
} from "./composition-coordinator"
import {
  CompositionInternalProjects,
  type CompositionInternalProject
} from "./composition-internal-projects"
import {
  proveLegacyCompositionCompletion,
  observeLegacyCompositionCompletion
} from "./composition-legacy-proof"
import {
  AUTOBIZ_CONTEXT_OUTPUT,
  isAutobizContextOutput
} from "../../../shared/project-runtime/autobiz-handoff"
import {
  assertAutobizHandoffDeclaration,
  encodeAutobizHandoff,
  materializeAutobizHandoff
} from "./composition-autobiz-handoff"
import { runtimeDigest } from "./safe-files"
import {
  collectSourceHandoffEvidence,
  readSourceHandoffContract,
  type SourceHandoffBaseline
} from "./composition-source-handoff"

export interface CompositionLegacySource {
  plugin: PluginMetadata
  packageDigest: string
  goal: string
  parent: HarnessProjectMetadata
}
export interface LegacyDecisionBinding {
  notificationId: string
  message: string
  projectId: string
  featureId: string
  engineRunId: string
  threadId: string
}
export interface LegacyDecisionInput {
  notificationId: string
  action: "continue" | "new_thread" | "stop"
  message?: string
}
export interface CompositionLegacyDependencies {
  sourceBaseline?(record: CompositionInternalProject): SourceHandoffBaseline | undefined
  pendingDecision?(record: CompositionInternalProject): LegacyDecisionBinding | undefined
  decideDecision?(
    record: CompositionInternalProject,
    context: CompositionExecutionContext,
    input: LegacyDecisionInput
  ): Promise<AppDecisionResult>

  resolveSource(context: CompositionExecutionContext): Promise<CompositionLegacySource>
  assertCurrent?(context: CompositionExecutionContext): void
  /** Fresh main-owned run definition; authority only, never content admission. */
  assertAuthorityCurrent?(
    context: CompositionExecutionContext,
    definition: ProjectCompositionDefinition
  ): void
  authorize(context: CompositionExecutionContext): Promise<void>
  authorizeCancellation(context: CompositionExecutionContext): Promise<void>
  assertStageCheckHook?(
    record: CompositionInternalProject,
    hook: StageCheckInvocation["hook"]
  ): void
  transition?(
    record: CompositionInternalProject,
    input: ProjectCheckpointInput & {
      validateReceipts(
        receipts: import("../../../shared/project-runtime/stage-check-receipt").StageCheckReceipt[]
      ): Promise<void>
    }
  ): Promise<ProjectCheckpointResult>
  checkContracts?(record: CompositionInternalProject): Promise<StageCheckContract[]>
  stageCheckIdentity?(
    record: CompositionInternalProject,
    threadId: string
  ): { engineRunId: string } | undefined
  initialize(record: CompositionInternalProject): Promise<void>
  createFeature(record: CompositionInternalProject): Promise<void>
  start(record: CompositionInternalProject, context: CompositionExecutionContext): Promise<string>
  executionThreadIds?(record: CompositionInternalProject): string[]
  readStatus?(record: CompositionInternalProject): { status: string; runId: string }
  observe(
    record: CompositionInternalProject
  ): Promise<Parameters<typeof proveLegacyCompositionCompletion>[1]>
  waitingReason?(record: CompositionInternalProject): string | undefined
  pendingGate(record: CompositionInternalProject): HarnessHumanGateSnapshot | undefined
  decideGate(
    record: CompositionInternalProject,
    gateId: string,
    decision: "approve" | "reject"
  ): Promise<boolean>
  /** Returns true only after the original agent, hooks and cleanup have all stopped. */
  cancel(record: CompositionInternalProject): Promise<boolean>
  wait?(): Promise<void>
}
export const compositionLegacyProjectId = (runId: string, unitId: string) =>
  `composition-legacy:${runId}:${unitId}`

/** Original legacy entry points execute in owned unit directories with their complete original context. */
export class CompositionLegacyAdapter {
  private readonly live = new Set<string>()
  constructor(
    readonly projects: CompositionInternalProjects,
    private readonly deps: CompositionLegacyDependencies
  ) {}
  has(context: CompositionExecutionContext): boolean {
    return Boolean(this.record(context))
  }
  executionThreadIds(context: CompositionExecutionContext): string[] {
    const record = this.record(context)
    if (
      !record ||
      record.parentProjectId !== context.parentProjectId ||
      record.workspace !== context.executionWorkspace
    )
      return []
    return this.deps.executionThreadIds?.(record) ?? []
  }
  private record(context: CompositionExecutionContext) {
    return this.projects.get(compositionLegacyProjectId(context.runId, context.unit.id))
  }
  private async completion(
    context: CompositionExecutionContext,
    record: CompositionInternalProject,
    write: boolean
  ): Promise<CompositionCompletionProof> {
    const input = await this.deps.observe(record)
    if (!context.unit.outputs.some(isAutobizContextOutput))
      return proveLegacyCompositionCompletion(context, input)
    const artifactIds = assertAutobizHandoffDeclaration(record.plugin.path)
    const { proof, files } = await observeLegacyCompositionCompletion(context, input, true, artifactIds)
    const sourceContract = await readSourceHandoffContract(record.plugin.path)
    const sourceChanges = sourceContract
      ? await collectSourceHandoffEvidence(
          record.workspace,
          record.packageDigest,
          sourceContract,
          this.deps.sourceBaseline?.(record)
        )
      : undefined
    const bytes = encodeAutobizHandoff(context, input, proof, files, sourceChanges)
    await this.deps.authorize(context)
    this.deps.assertCurrent?.(context)
    const digest = materializeAutobizHandoff(record.workspace, bytes, write)
    return {
      ...proof,
      artifacts: [...proof.artifacts, { ...AUTOBIZ_CONTEXT_OUTPUT, digest }],
      evidenceDigest: runtimeDigest(JSON.stringify([proof.evidenceDigest, digest]))
    }
  }
  async execute(
    context: CompositionExecutionContext,
    signal: AbortSignal
  ): Promise<CompositionEngineResult> {
    await this.deps.authorize(context)
    signal.throwIfAborted()
    let record = this.record(context)
    if (!record) {
      const source = await this.deps.resolveSource(context)
      if (
        source.packageDigest !== context.unit.source.packageDigest ||
        source.plugin.id !== context.unit.source.pluginId ||
        !source.goal.trim()
      )
        throw Error("COMPOSITION_LEGACY_SOURCE_CHANGED")
      if (!context.executionWorkspace) throw Error("COMPOSITION_OWNED_WORKSPACE_REQUIRED")
      await this.projects.prepare(source.plugin, source.packageDigest, signal)
      record = this.projects.create(
        {
          parentProjectId: context.parentProjectId,
          compositionRunId: context.runId,
          unitId: context.unit.id,
          featureId: `composition-${context.unit.id}`,
          goal: source.goal,
          workspace: context.executionWorkspace,
          plugin: source.plugin,
          packageDigest: source.packageDigest,
          ...(context.contextSelection ? { contextSelection: context.contextSelection } : {}),
          ...(context.unit.workflow ? { workflow: context.unit.workflow } : {})
        },
        source.parent
      )
      // Persist intent before each side effect. Interrupted intent is never automatically replayed.
      record = this.projects.advance(record.projectId, "registered", "initializing")
      await this.deps.initialize(record)
      record = this.projects.advance(record.projectId, "initializing", "initialized")
      await this.deps.authorize(context)
      signal.throwIfAborted()
      record = this.projects.advance(record.projectId, "initialized", "creating-feature")
      await this.deps.createFeature(record)
      record = this.projects.advance(record.projectId, "creating-feature", "feature-created")
      await this.deps.authorize(context)
      signal.throwIfAborted()
      record = this.projects.advance(record.projectId, "feature-created", "starting")
      const engineRunId = await this.deps.start(record, context)
      record = this.projects.advance(record.projectId, "starting", "running", engineRunId)
      this.live.add(record.projectId)
    }
    // Explicit resumes re-admit the retained source; never repeat persisted side-effect intent.
    await this.projects.prepare(record.plugin, record.packageDigest, signal)
    await this.deps.authorize(context)
    if (record.phase !== "running" || !record.engineRunId)
      return { status: "unknown", reason: "原流程启动阶段中断，需核对原始状态，不能自动重放" }
    if (context.engineRunId && context.engineRunId !== record.engineRunId)
      throw Error("COMPOSITION_ENGINE_ID_CHANGED")
    while (!signal.aborted) {
      await this.deps.authorize(context)
      const status = this.deps.readStatus?.(record) ?? (await this.deps.observe(record)).managed
      if (status.runId !== record.engineRunId) throw Error("COMPOSITION_ENGINE_ID_CHANGED")
      if (status.status === "completed")
        return {
          status: "completed",
          proof: await this.completion(context, record, true)
        }
      if (status.status === "failed" || status.status === "cancelled")
        return { status: status.status, engineRunId: record.engineRunId }
      if (!this.live.has(record.projectId))
        return {
          status: "unknown",
          engineRunId: record.engineRunId,
          reason: "进程重启后原执行仍无终态证明；未自动重启任何阶段"
        }
      if (this.waitingApproval(context))
        return { status: "waiting-approval", engineRunId: record.engineRunId }
      const reason = this.deps.waitingReason?.(record)
      if (reason) return { status: "waiting-approval", engineRunId: record.engineRunId, reason }
      await (this.deps.wait?.() ?? new Promise((resolve) => setTimeout(resolve, 250)))
    }
    return this.cancel(context)
  }
  async reconcile(
    context: CompositionExecutionContext,
    signal: AbortSignal
  ): Promise<CompositionEngineResult> {
    await this.deps.authorize(context)
    const record = this.record(context)
    if (!record || record.phase !== "running" || !record.engineRunId)
      return { status: "unknown", reason: "原初始化或启动中断；未重放，请核实原任务是否退出后处理" }
    await this.projects.prepare(record.plugin, record.packageDigest, signal)
    signal.throwIfAborted()
    const status = this.deps.readStatus?.(record) ?? (await this.deps.observe(record)).managed
    if (status.runId !== record.engineRunId) throw Error("COMPOSITION_ENGINE_ID_CHANGED")
    if (status.status === "completed")
      return {
        status: "completed",
        proof: await this.completion(context, record, true)
      }
    if (status.status === "failed" || status.status === "cancelled")
      return { status: status.status, engineRunId: record.engineRunId }
    return {
      status: "unknown",
      engineRunId: record.engineRunId,
      reason: "原执行仍无终态证明；未重放，可处理原任务后再核对或取消"
    }
  }
  resume(context: CompositionExecutionContext, signal: AbortSignal) {
    if (!this.record(context)) throw Error("COMPOSITION_ENGINE_ID_CHANGED")
    return this.execute(context, signal)
  }
  waitingDecision(context: CompositionExecutionContext) {
    const record = this.record(context)
    if (!record || record.phase !== "running" || !record.engineRunId) return undefined
    const decision = this.deps.pendingDecision?.(record)
    if (!decision) return undefined
    if (
      decision.projectId !== record.projectId ||
      decision.featureId !== record.featureId ||
      decision.engineRunId !== record.engineRunId ||
      !this.executionThreadIds(context).includes(decision.threadId)
    )
      throw Error("COMPOSITION_DECISION_CHANGED")
    return {
      unitId: record.unitId,
      notificationId: decision.notificationId,
      message: decision.message,
      humanGatePending: !!this.waitingApproval(context)
    }
  }
  async decide(
    context: CompositionExecutionContext,
    input: LegacyDecisionInput
  ): Promise<AppDecisionResult> {
    await this.deps.authorize(context)
    const decision = this.waitingDecision(context)
    if (decision?.notificationId !== input.notificationId || !this.deps.decideDecision)
      throw Error("COMPOSITION_DECISION_CHANGED")
    if (decision.humanGatePending && input.action !== "stop")
      throw Error("COMPOSITION_HUMAN_GATE_PENDING")
    return this.deps.decideDecision(this.record(context)!, context, input)
  }
  waitingApproval(context: CompositionExecutionContext) {
    const record = this.record(context)
    if (!record || record.phase !== "running") return undefined
    const gate = this.deps.pendingGate(record)
    if (!gate) return undefined
    if (
      gate.projectId !== record.projectId ||
      gate.featureId !== record.featureId ||
      gate.sourceManagedRunId !== record.engineRunId
    )
      throw Error("COMPOSITION_APPROVAL_CHANGED")
    return {
      kind: "legacy-human-gate" as const,
      unitId: record.unitId,
      gateId: gate.gateId,
      projectId: record.projectId,
      featureId: record.featureId,
      message: gate.message,
      sourceThreadId: gate.sourceThreadId
    }
  }
  async approve(
    context: CompositionExecutionContext,
    gateId: string,
    decision: "approve" | "reject"
  ) {
    await this.deps.authorize(context)
    const gate = this.waitingApproval(context)
    if (!gate || gate.gateId !== gateId) throw Error("COMPOSITION_APPROVAL_CHANGED")
    if (!(await this.deps.decideGate(this.record(context)!, gateId, decision)))
      throw Error("COMPOSITION_APPROVAL_CHANGED")
  }
  async verifyCompletion(
    context: CompositionExecutionContext,
    proof: CompositionCompletionProof
  ): Promise<boolean> {
    const record = this.record(context)
    if (!record || record.engineRunId !== proof.engineRunId) return false
    await this.deps.authorize(context)
    const expected = await this.completion(context, record, false)
    return (
      expected.kind === proof.kind &&
      expected.engineRunId === proof.engineRunId &&
      expected.evidenceDigest === proof.evidenceDigest &&
      JSON.stringify(expected.artifacts) === JSON.stringify(proof.artifacts)
    )
  }
  async cancel(context: CompositionExecutionContext): Promise<CompositionEngineResult> {
    await this.deps.authorizeCancellation(context)
    const record = this.record(context)
    if (!record) return { status: "cancelled" }
    await this.projects.prepare(record.plugin, record.packageDigest)
    const stopped = await this.deps.cancel(record)
    return { status: stopped ? "cancelled" : "unknown", engineRunId: record.engineRunId }
  }
}
