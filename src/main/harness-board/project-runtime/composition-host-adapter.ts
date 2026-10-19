import type {
  HostProjectOperation,
  HostProjectState
} from "../../../shared/project-runtime/host-types"
import type { CompositionCompletionProof } from "../../../shared/project-runtime/composition"
import type {
  CompositionEngineResult,
  CompositionExecutionContext
} from "./composition-coordinator"
import { HostProjectService } from "./host-service"
import { readRuntimeScopedFile, runtimeDigest } from "./safe-files"

export interface CompositionHostSource {
  runtimeMode?: "host" | "legacy"
  installedPluginId: string
  /** Retained HostPackageSnapshots digest, verified against the selected catalog digest by host. */
  hostPackageDigest: string
  goal: string
  entry?: string
}
export interface CompositionHostAdapterDependencies {
  resolveSource(context: CompositionExecutionContext): Promise<CompositionHostSource>
  authorize(context: CompositionExecutionContext): Promise<void>
  authorizeCancellation?(context: CompositionExecutionContext): Promise<void>
  /** Bind delivery/window ownership before the original HostProjectService starts its real thread. */
  beforeStart(context: CompositionExecutionContext, operation: HostProjectOperation): void
  /** Native-only digest fence for explicit inputs copied into the consumer workspace. */
  assertInputsCurrent?(context: CompositionExecutionContext): void
}
export const compositionHostProjectId = (runId: string, unitId: string): string =>
  `composition:${runId}:${unitId}`

/** Internal engine contexts belong to one visible parent, with isolated original state roots. */
export class CompositionHostAdapter {
  private readonly active = new Map<string, Promise<CompositionEngineResult>>()
  constructor(
    private readonly host: HostProjectService,
    private readonly deps: CompositionHostAdapterDependencies
  ) {}

  execute(
    context: CompositionExecutionContext,
    signal: AbortSignal
  ): Promise<CompositionEngineResult> {
    const id = compositionHostProjectId(context.runId, context.unit.id)
    if (this.active.has(id)) throw Error("COMPOSITION_ENGINE_BUSY")
    const task = this.run(structuredClone(context), signal).finally(() => this.active.delete(id))
    this.active.set(id, task)
    return task
  }
  resume(
    context: CompositionExecutionContext,
    signal: AbortSignal
  ): Promise<CompositionEngineResult> {
    if (context.engineRunId !== compositionHostProjectId(context.runId, context.unit.id))
      throw Error("COMPOSITION_ENGINE_ID_CHANGED")
    return this.execute(context, signal)
  }
  async reconcile(
    context: CompositionExecutionContext,
    signal?: AbortSignal
  ): Promise<CompositionEngineResult> {
    await this.deps.authorize(structuredClone(context))
    signal?.throwIfAborted()
    const id = compositionHostProjectId(context.runId, context.unit.id)
    const project = this.host.get(id)
    if (project?.status === "completed")
      return { status: "completed", proof: this.proof(context, project) }
    const latest = this.host
      .operations(id, 200)
      .find((operation) => operation.stageId === project?.manifest.stages[project.stageIndex]?.id)
    if (latest?.status === "failed" || latest?.status === "cancelled")
      return { status: latest.status, engineRunId: id }
    return {
      status: "unknown",
      engineRunId: id,
      reason: "原阶段尚无可核实终态；请处理原任务后再次核对或取消"
    }
  }
  executionThreadIds(context: CompositionExecutionContext): string[] {
    const id = compositionHostProjectId(context.runId, context.unit.id)
    const project = this.host.get(id)
    if (
      !project ||
      project.workspace !== context.executionWorkspace ||
      project.pluginDigest !== context.unit.source.packageDigest
    )
      return []
    const stageId = project.manifest.stages[project.stageIndex]?.id
    return this.host
      .operations(id, 200)
      .filter(
        (operation) =>
          operation.stageId === stageId && ["started", "unknown"].includes(operation.status)
      )
      .flatMap((operation) => (operation.execution?.threadId ? [operation.execution.threadId] : []))
  }
  waitingOperation(context: CompositionExecutionContext): HostProjectOperation | undefined {
    return this.host
      .operations(compositionHostProjectId(context.runId, context.unit.id), 200)
      .find((operation) => operation.status === "prepared")
  }
  async approve(
    context: CompositionExecutionContext,
    operationId: string,
    input: Parameters<HostProjectService["approve"]>[1]
  ): Promise<HostProjectOperation> {
    await this.deps.authorize(structuredClone(context))
    const operation = this.waitingOperation(context)
    if (!operation || operation.operationId !== operationId)
      throw Error("COMPOSITION_APPROVAL_CHANGED")
    // Actor identity is supplied by the trusted host boundary, never inferred from model output.
    await this.host.prepareRuntimeInputs(operation.projectId)
    return this.host.approve(operationId, input)
  }
  async cancel(context: CompositionExecutionContext): Promise<CompositionEngineResult> {
    await (this.deps.authorizeCancellation ?? this.deps.authorize)(structuredClone(context))
    const id = compositionHostProjectId(context.runId, context.unit.id)
    const project = this.host.get(id)
    if (!project) return { status: "cancelled", engineRunId: id }
    const operation = this.host
      .operations(id, 200)
      .find((operation) =>
        ["prepared", "started", "cancel_requested", "succeeded", "unknown"].includes(
          operation.status
        )
      )
    if (operation) {
      const cancelled = this.host.cancel(operation.operationId)
      if (cancelled.status === "cancelled") return { status: "cancelled", engineRunId: id }
      const active = this.active.get(id)
      if (active) {
        await active.catch(() => undefined)
        const settled = this.host
          .operations(id, 200)
          .find((item) => item.operationId === operation.operationId)
        if (
          settled &&
          ["cancelled", "failed", "succeeded", "transitioned"].includes(settled.status)
        )
          return { status: "cancelled", engineRunId: id }
      }
      return { status: "unknown", engineRunId: id, reason: "原引擎取消尚未获得可信终态。" }
    }
    if (project.status === "completed") return { status: "cancelled", engineRunId: id }
    return { status: "cancelled", engineRunId: id }
  }
  async verifyCompletion(
    context: CompositionExecutionContext,
    proof: CompositionCompletionProof
  ): Promise<boolean> {
    await this.deps.authorize(structuredClone(context))
    const project = this.host.get(compositionHostProjectId(context.runId, context.unit.id))
    if (!project) return false
    try {
      return JSON.stringify(this.proof(context, project)) === JSON.stringify(proof)
    } catch {
      return false
    }
  }
  private async run(
    context: CompositionExecutionContext,
    signal: AbortSignal
  ): Promise<CompositionEngineResult> {
    if (context.unit.kind !== "flow") throw Error("COMPOSITION_HOST_FLOW_REQUIRED")
    await this.deps.authorize(structuredClone(context))
    const source = await this.deps.resolveSource(structuredClone(context))
    if (source.entry !== undefined && source.entry !== "devclaw.project-runtime.json")
      throw Error("COMPOSITION_HOST_ENTRY_UNSUPPORTED")
    const goal = context.inputs.length
      ? `${source.goal}\n\n经宿主核验的组合输入：\n${JSON.stringify(context.inputs)}`
      : source.goal
    await this.deps.authorize(structuredClone(context))
    if (source.installedPluginId !== context.unit.source.pluginId)
      throw Error("COMPOSITION_SOURCE_CHANGED")
    const id = compositionHostProjectId(context.runId, context.unit.id)
    if (signal.aborted) return { status: "cancelled", engineRunId: id }
    let project =
      this.host.get(id) ??
      (await this.host.localCreate({
        projectId: id,
        name: context.unit.id,
        workspace: context.executionWorkspace ?? context.workspace,
        installedPluginId: source.installedPluginId,
        goal
      }))
    await this.deps.authorize(structuredClone(context))
    if (
      project.workspace !== (context.executionWorkspace ?? context.workspace) ||
      project.installedPluginId !== source.installedPluginId ||
      project.pluginDigest !== source.hostPackageDigest ||
      project.goal !== goal
    )
      throw Error("COMPOSITION_SOURCE_CHANGED")
    let activeOperation: string | undefined
    const cancel = () => {
      if (activeOperation) this.host.cancel(activeOperation)
    }
    signal.addEventListener("abort", cancel)
    try {
      while (project.status !== "completed") {
        if (signal.aborted) return { status: "cancelled", engineRunId: id }
        await this.deps.authorize(structuredClone(context))
        const stage = project.manifest.stages[project.stageIndex]
        if (!stage) throw Error("COMPOSITION_HOST_STAGE_INVALID")
        await this.host.prepareRuntimeInputs(id)
        let operation = this.host.prepare({
          projectId: id,
          expectedVersion: project.version,
          idempotencyKey: `composition-stage:${project.stageIndex}`
        })
        activeOperation = operation.operationId
        if (stage.approval === "human" && operation.approval?.decision !== "approved") {
          if (operation.approval?.decision === "rejected")
            return { status: "failed", engineRunId: id, reason: "原阶段审批已拒绝。" }
          return { status: "waiting-approval", engineRunId: id }
        }
        if (operation.status === "prepared") {
          await this.deps.authorize(structuredClone(context))
          if (signal.aborted) {
            cancel()
            return { status: "cancelled", engineRunId: id }
          }
          this.deps.beforeStart(structuredClone(context), structuredClone(operation))
          operation = await this.host.start(operation.operationId, {
            assertInputsCurrent: () => this.deps.assertInputsCurrent?.(context)
          })
        }
        await this.deps.authorize(structuredClone(context))
        if (signal.aborted) {
          cancel()
          return {
            status: ["started", "cancel_requested", "unknown"].includes(operation.status)
              ? "unknown"
              : "cancelled",
            engineRunId: id
          }
        }
        if (operation.status !== "succeeded" && operation.status !== "transitioned")
          return {
            status:
              operation.status === "failed"
                ? "failed"
                : operation.status === "cancelled"
                  ? "cancelled"
                  : "unknown",
            engineRunId: id,
            reason: `原阶段状态：${operation.status}`
          }
        project = this.host.transition(operation.operationId)
        activeOperation = undefined
      }
      return { status: "completed", proof: this.proof(context, project) }
    } finally {
      signal.removeEventListener("abort", cancel)
    }
  }
  private proof(
    context: CompositionExecutionContext,
    project: HostProjectState
  ): CompositionCompletionProof {
    const id = compositionHostProjectId(context.runId, context.unit.id)
    if (
      project.projectId !== id ||
      project.status !== "completed" ||
      project.stageIndex !== project.manifest.stages.length ||
      project.workspace !== (context.executionWorkspace ?? context.workspace)
    )
      throw Error("COMPOSITION_FLOW_NOT_COMPLETED")
    const operations = this.host.operations(id, 200)
    const evidence = project.manifest.stages.map((stage, index) => {
      const operation = operations.find(
        (item) => item.stageId === stage.id && item.status === "transitioned"
      )
      if (
        !operation ||
        operation.execution?.terminal?.outcome !== "success" ||
        (stage.approval === "human" && operation.approval?.decision !== "approved")
      )
        throw Error("COMPOSITION_FLOW_CHECKS_REQUIRED")
      // Later stages may legitimately revise earlier outputs. Require original passed receipts,
      // and freshness of the most recent checks that own each output's final bytes.
      for (const checkId of stage.checkIds)
        if (
          !operation.receipts.some(
            (receipt) => receipt.checkId === checkId && receipt.result === "passed"
          )
        )
          throw Error("COMPOSITION_FLOW_CHECKS_REQUIRED")
      const currentChecks = stage.checkIds.filter((checkId) => {
        const check = project.manifest.checks.find((check) => check.id === checkId)!
        return !project.manifest.stages
          .slice(index + 1)
          .some((later) =>
            later.checkIds.some(
              (id) =>
                project.manifest.checks.find((candidate) => candidate.id === id)?.artifactId ===
                check.artifactId
            )
          )
      })
      this.host.assertStageEvidenceCurrent(project, operation, currentChecks)
      return {
        operationId: operation.operationId,
        stageId: stage.id,
        receipts: operation.receipts,
        approval: operation.approval
      }
    })
    const artifacts = context.unit.outputs.map((output) => {
      if (
        !project.manifest.artifacts.some(
          (artifact) => artifact.id === output.id && artifact.path === output.path
        )
      )
        throw Error("COMPOSITION_OUTPUT_NOT_DECLARED")
      const observed = readRuntimeScopedFile(project.workspace, output.path)
      if (!observed.bytes) throw Error("COMPOSITION_OUTPUT_MISSING")
      return { ...output, digest: runtimeDigest(observed.bytes) }
    })
    return {
      kind: "flow-completed",
      engineRunId: id,
      evidenceDigest: runtimeDigest(
        JSON.stringify({ id, pluginDigest: project.pluginDigest, evidence, artifacts })
      ),
      artifacts
    }
  }
}
