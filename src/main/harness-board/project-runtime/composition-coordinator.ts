import {
  compositionText,
  parseCompositionCompletion,
  parseProjectComposition,
  type ProjectCompositionDefinition,
  type ProjectCompositionSource,
  type ProjectCompositionUnit,
  type CompositionArtifact,
  type CompositionCompletionProof
} from "../../../shared/project-runtime/composition"
import { ProjectCompositionStore, type CompositionRun } from "./composition-store"
import type { CompositionUnitContextSelection } from "../../../shared/project-runtime/composition-api"

export interface CompositionHandoff {
  /** Resolved only by the host capability declaration, never by a handoff payload. */
  destinationPath?: string
  inputId: string
  fromUnitId: string
  source: ProjectCompositionSource
  artifact: CompositionArtifact
}
export interface CompositionExecutionContext {
  contextSelection?: CompositionUnitContextSelection
  runId: string
  parentProjectId: string
  workspace: string
  executionWorkspace?: string
  unit: ProjectCompositionUnit
  attemptId: string
  /** Stable across explicit approval resumes; original engines must preserve idempotency. */
  idempotencyKey: string
  engineRunId?: string
  inputs: CompositionHandoff[]
}
export type CompositionEngineResult =
  | { status: "completed"; proof: CompositionCompletionProof }
  | { status: "waiting-approval"; engineRunId: string; reason?: string }
  | { status: "failed" | "cancelled" | "unknown"; reason?: string; engineRunId?: string }

/** Host lifecycle phase, never accepted from a composition payload. */
export type CompositionInputVerificationPhase = "before-prepare" | "prepared"

/** Main-only providers. Completion and artifact verification must inspect the real engine/files. */
export interface CompositionCoordinatorDependencies {
  authorize(definition: ProjectCompositionDefinition, unit?: ProjectCompositionUnit): Promise<void>
  authorizeCancellation?(definition: ProjectCompositionDefinition): Promise<void>
  verifyInputs(
    context: CompositionExecutionContext,
    phase?: CompositionInputVerificationPhase
  ): Promise<boolean>
  verifyCompletion(
    context: CompositionExecutionContext,
    proof: CompositionCompletionProof
  ): Promise<boolean>
  execute(
    context: CompositionExecutionContext,
    signal: AbortSignal
  ): Promise<CompositionEngineResult>
  resume(
    context: CompositionExecutionContext,
    signal: AbortSignal
  ): Promise<CompositionEngineResult>
  reconcile?(
    context: CompositionExecutionContext,
    signal: AbortSignal
  ): Promise<CompositionEngineResult>
  cancel(context: CompositionExecutionContext): Promise<CompositionEngineResult>
}

/** Generic serial orchestration foundation; not connected to IPC or production engine adapters. */
export class ProjectCompositionCoordinator {
  private readonly controllers = new Map<string, AbortController>()
  private readonly drains = new Map<string, Promise<CompositionRun>>()
  constructor(
    private readonly store: ProjectCompositionStore,
    private readonly deps: CompositionCoordinatorDependencies
  ) {}

  async start(value: unknown, requestId: string): Promise<CompositionRun> {
    const definition = parseProjectComposition(value)
    await this.deps.authorize(structuredClone(definition))
    const created = this.store.create(definition, requestId)
    // An existing request is observed, never resumed or executed implicitly.
    return created.created ? this.drive(created.run) : created.run
  }
  async startBackground(value: unknown, requestId: string): Promise<CompositionRun> {
    const definition = parseProjectComposition(value)
    await this.deps.authorize(structuredClone(definition))
    const created = this.store.create(definition, requestId)
    if (created.created) this.background(created.run.id, () => this.drive(created.run))
    return created.run
  }
  async prepare(value: unknown, requestId: string): Promise<CompositionRun> {
    const definition = parseProjectComposition(value)
    await this.deps.authorize(structuredClone(definition))
    return this.store.create(definition, requestId, true).run
  }
  async startPrepared(runId: string, expectedVersion: number, assertReady?: () => void): Promise<CompositionRun> {
    const run = this.require(runId)
    await this.deps.authorize(structuredClone(run.definition))
    assertReady?.()
    const confirmed = this.store.confirmConfiguration(runId, expectedVersion)
    this.background(runId, () => this.drive(confirmed))
    return confirmed
  }
  async resumeBackground(runId: string, expectedVersion: number): Promise<CompositionRun> {
    const run = this.require(runId)
    await this.deps.authorize(structuredClone(run.definition))
    const claimed = this.store.claim(runId, expectedVersion, true)
    this.background(runId, async () => {
      const result = await this.executeAttempt(
        claimed,
        run.status === "unknown" ? "reconcile" : "resume"
      )
      return result.status === "running" ? this.drive(result) : result
    })
    return claimed
  }
  waitForSettlement(runId: string): Promise<CompositionRun> {
    return this.drains.get(runId) ?? Promise.resolve(this.require(runId))
  }
  private background(runId: string, work: () => Promise<CompositionRun>): void {
    const task = Promise.resolve()
      .then(work)
      .catch(() => this.store.markUnknown(runId))
      .finally(() => {
        if (this.drains.get(runId) === task) this.drains.delete(runId)
      })
    this.drains.set(runId, task)
  }
  async resume(runId: string, expectedVersion: number): Promise<CompositionRun> {
    const run = this.require(runId)
    await this.deps.authorize(structuredClone(run.definition))
    const claimed = this.store.claim(runId, expectedVersion, true)
    const settled = await this.executeAttempt(
      claimed,
      run.status === "unknown" ? "reconcile" : "resume"
    )
    return settled.status === "running" ? this.drive(settled) : settled
  }
  async cancel(runId: string): Promise<CompositionRun> {
    let run = this.require(runId)
    await (this.deps.authorizeCancellation ?? this.deps.authorize)(structuredClone(run.definition))
    if (run.status === "waiting-approval" || run.status === "unknown")
      run = this.store.claim(run.id, run.version, true)
    run = this.store.cancel(run.id)
    this.controllers.get(run.id)?.abort()
    if (run.status !== "cancel-requested") return run
    // Cancellation remains an original-engine operation; request acceptance is not settlement.
    return this.executeAttempt(run, "cancel")
  }
  private require(id: string): CompositionRun {
    const run = this.store.get(id)
    if (!run) throw Error("COMPOSITION_RUN_MISSING")
    return run
  }
  private async drive(input: CompositionRun): Promise<CompositionRun> {
    let run = input
    while (run.status === "running") {
      try {
        run = this.store.claim(run.id, run.version)
      } catch {
        return this.require(run.id)
      }
      run = await this.executeAttempt(run, "execute")
    }
    return run
  }
  private context(run: CompositionRun): CompositionExecutionContext {
    const state = run.units.find((unit) => unit.status === "running")
    if (!state?.attemptId) throw Error("COMPOSITION_ATTEMPT_MISSING")
    const unit = run.definition.units.find((unit) => unit.id === state.id)!
    const inputs = unit.inputs.map((input) => {
      const producer = run.units.find((state) => state.id === input.fromUnitId)
      const source = run.definition.units.find((unit) => unit.id === input.fromUnitId)!.source
      const artifact = producer?.proof?.artifacts.find(
        (artifact) => artifact.id === input.artifactId
      )
      if (producer?.status !== "succeeded" || !artifact)
        throw Error("COMPOSITION_HANDOFF_UNVERIFIED")
      return { inputId: input.inputId, fromUnitId: input.fromUnitId, source, artifact }
    })
    return structuredClone({
      runId: run.id,
      parentProjectId: run.definition.parentProjectId,
      workspace: run.definition.workspace,
      unit,
      attemptId: state.attemptId,
      idempotencyKey: JSON.stringify([run.id, unit.id]),
      engineRunId: state.engineRunId,
      ...(run.unitContexts?.[unit.id] ? { contextSelection: run.unitContexts[unit.id] } : {}),
      inputs
    })
  }
  private async executeAttempt(
    run: CompositionRun,
    action: "execute" | "resume" | "reconcile" | "cancel"
  ): Promise<CompositionRun> {
    const context = this.context(run)
    const controller = new AbortController()
    if (action !== "cancel") this.controllers.set(run.id, controller)
    // Resume/cancel already refer to an admitted engine run, even if current authorization fails.
    let invoked = action !== "execute"
    const authorize = () =>
      action === "cancel" && this.deps.authorizeCancellation
        ? this.deps.authorizeCancellation(structuredClone(run.definition))
        : this.deps.authorize(structuredClone(run.definition), structuredClone(context.unit))
    const assertCurrent = () => {
      const current = this.require(run.id)
      const state = current.units.find((unit) => unit.id === context.unit.id)
      if (
        state?.attemptId !== context.attemptId ||
        state.status !== "running" ||
        (action !== "cancel" && current.status !== "running")
      )
        throw Error("COMPOSITION_ATTEMPT_CHANGED")
    }
    try {
      await authorize()
      assertCurrent()
      if (
        action !== "cancel" &&
        !(await this.deps.verifyInputs(
          structuredClone(context),
          action === "execute" ? "before-prepare" : "prepared"
        ))
      )
        throw Error("COMPOSITION_INPUTS_CHANGED")
      await authorize()
      assertCurrent()
      invoked = true
      const result =
        action === "cancel"
          ? await this.deps.cancel(structuredClone(context))
          : action === "reconcile"
            ? this.deps.reconcile
              ? await this.deps.reconcile(structuredClone(context), controller.signal)
              : {
                  status: "unknown" as const,
                  engineRunId: context.engineRunId,
                  reason: "原引擎不支持只读核对；请处理原任务后取消核对"
                }
            : await this.deps[action](structuredClone(context), controller.signal)
      await authorize()
      if (result.status === "completed") {
        const proof = parseCompositionCompletion(result.proof, context.unit)
        if (context.engineRunId && proof.engineRunId !== context.engineRunId)
          throw Error("COMPOSITION_ENGINE_ID_CHANGED")
        if (!(await this.deps.verifyCompletion(structuredClone(context), structuredClone(proof))))
          throw Error("COMPOSITION_COMPLETE_UNVERIFIED")
        await authorize()
        return this.store.settle(run.id, context.attemptId, { status: "succeeded", proof })
      }
      if (result.status === "waiting-approval")
        return this.store.settle(run.id, context.attemptId, {
          status: result.status,
          engineRunId: compositionText(result.engineRunId),
          reason: result.reason
        })
      if (!["failed", "cancelled", "unknown"].includes(result.status))
        throw Error("COMPOSITION_ENGINE_RESULT_INVALID")
      return this.store.settle(run.id, context.attemptId, result)
    } catch (error) {
      const latest = this.require(run.id)
      const current = latest.units.find((unit) => unit.id === context.unit.id)
      if (
        current?.status !== "running" ||
        current.attemptId !== context.attemptId ||
        !["running", "cancel-requested"].includes(latest.status)
      )
        return latest
      return this.store.settle(run.id, context.attemptId, {
        status: invoked ? "unknown" : "failed",
        reason: error instanceof Error ? error.message : "COMPOSITION_EXECUTION_FAILED"
      })
    } finally {
      if (this.controllers.get(run.id) === controller) this.controllers.delete(run.id)
    }
  }
}
