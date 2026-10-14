import { registerEvaluationSnapshotStart } from "./snapshot-lease"
import type { SavedFlow } from "../../../shared/mods/flows/types"
import type { EvaluationStartInput, EvaluationView } from "../../../shared/mods/evaluation-api"
import type {
  HarnessEvaluationBinding,
  HarnessEvaluationRun
} from "../../../shared/mods/evaluation"
import type { FlowManager } from "../flows/manager"
import type { FlowStore } from "../flows/store"
import type { ModControlStore } from "../control-store"
import { flowDigest } from "../flows/store"
import { parseFlowTaskGoal } from "../../../shared/mods/flows/schema"
import { compareHarnessEvaluations } from "./comparison"
import { EvaluationCreateNotPersisted, EvaluationStore, type EvaluationRecord } from "./store"
import { collectEvaluationObservation } from "./observations"

export interface EvaluationScope {
  workspace: string
  threadId: string
  signal: AbortSignal
  assertCurrent(): void
}
interface FlowRunner extends Pick<FlowManager, "startSaved" | "cancel"> {
  /** Must await actual active.done, including owned cleanup and final persistence. */
  waitForSettlement(workspace: string, threadId: string, runId: string): Promise<void>
}
interface Dependencies {
  flows: FlowRunner
  history: Pick<FlowStore, "get" | "run">
  evidence: Pick<ModControlStore, "completionEvidenceByIds">
  store: EvaluationStore
  /** Host construction only. Renderer requests cannot select or upgrade this provenance. */
  provider: "real" | "controlled"
}
interface Active {
  row: EvaluationRecord
  controller: AbortController
  done: Promise<void>
  sources?: { baseline: SavedFlow; candidate: SavedFlow }
}
const running = new Set(["queued", "running", "waiting"])
const frozenCopy = <T>(value: T): T => structuredClone(value)
/** Proof from the host runner that no durable run creation was attempted. */
export class EvaluationNotStarted extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : "EVALUATION_INVALID", { cause: error })
    this.name = error instanceof Error ? error.name : "Error"
  }
}
export class EvaluationRunner {
  private readonly active = new Map<string, Active>()
  private readonly reportReferences = new Set<(workspace: string, threadId: string, id: string, baselineDigest: string, candidateDigest: string) => boolean>()
  constructor(private readonly deps: Dependencies) {}
  /** Host-only retention providers; renderer/model input cannot supply or bypass them. */
  protectReports(referenced: (workspace: string, threadId: string, id: string, baselineDigest: string, candidateDigest: string) => boolean): void {
    this.reportReferences.add(referenced)
  }
  private discardable(row: EvaluationRecord): boolean {
    if (this.active.get(row.workspace)?.row.id === row.id || row.pending ||
      !["complete", "cancelled"].includes(row.state)) return false
    try {
      return ![...this.reportReferences].some(check => check(row.workspace, row.threadId, row.id, row.baseline.digest, row.candidate.digest))
    } catch { return false }
  }
  discard(scope: EvaluationScope, id: string, expectedDigest: string): void {
    scope.signal.throwIfAborted()
    scope.assertCurrent()
    const row = this.deps.store.list(scope.workspace, scope.threadId).find(value => value.id === id)
    if (!row || flowDigest(row) !== expectedDigest) throw Error("EVALUATION_STALE")
    if (!this.discardable(row)) throw Error("EVALUATION_BUSY")
    scope.assertCurrent()
    this.deps.store.discard(scope.workspace, scope.threadId, id, expectedDigest)
  }
  private view(row: EvaluationRecord): EvaluationView {
    const records = { baseline: row.results.baseline, candidate: row.results.candidate }
    const binding: HarnessEvaluationBinding = {
      schemaVersion: 1,
      experimentId: row.id,
      taskSetDigest: flowDigest(row.tasks),
      runnerDigest: flowDigest("native-flow-fixed-tasks-v1"),
      environmentDigest: flowDigest("unobserved"),
      modelFingerprint: flowDigest("unobserved"),
      baselineDigest: row.baseline.digest,
      candidateDigest: row.candidate.digest,
      changeKind: "flow",
      provider: row.provider,
      caseIds: row.tasks.map((task) => task.id)
    }
    const reasons = new Set(row.reasons)
    const sides = Object.fromEntries(
      (["baseline", "candidate"] as const).map((variant) => {
        const observations = records[variant]
        const full = observations.length === row.tasks.length
        const ordered = row.tasks.map((task) =>
          observations.find((value) => value.fact.caseId === task.id)
        )
        const environments = ordered.map((value) => value?.environmentDigest)
        const models = ordered.map((value) => value?.modelFingerprint)
        if (!full || environments.some((value) => !value))
          reasons.add("environment-not-completely-observed")
        if (!full || models.some((value) => !value)) reasons.add("model-not-completely-observed")
        for (const value of observations) for (const reason of value.reasons) reasons.add(reason)
        const run: HarnessEvaluationRun = {
          variant,
          sourceDigest: row[variant].digest,
          binding: {
            ...binding,
            environmentDigest: flowDigest(environments),
            modelFingerprint: flowDigest(models)
          },
          cases: observations.map((value) => value.fact)
        }
        return [variant, run]
      })
    ) as Record<"baseline" | "candidate", HarnessEvaluationRun>
    const comparison = compareHarnessEvaluations(sides.baseline, sides.candidate)
    if (
      reasons.has("environment-not-completely-observed") ||
      reasons.has("model-not-completely-observed")
    ) {
      comparison.comparable = false
      comparison.reasons = [...new Set([...comparison.reasons, "observation-incomplete"])]
      comparison.confirmedPassRateDelta = null
      comparison.recommendation = "incomparable"
      comparison.regressions = []
      comparison.improvements = []
    }
    const owned = this.active.get(row.workspace)?.row.id === row.id
    return {
      id: row.id,
      workspace: row.workspace,
      threadId: row.threadId,
      createdAt: row.createdAt,
      state: row.state === "running" && !owned ? "interrupted" : row.state,
      provider: row.provider,
      tasks: frozenCopy(row.tasks),
      budget: { ...row.budget },
      baseline: {
        name: row.baseline.definition.name,
        digest: row.baseline.digest,
        cases: sides.baseline.cases
      },
      candidate: {
        name: row.candidate.definition.name,
        digest: row.candidate.digest,
        cases: sides.candidate.cases
      },
      ...(this.discardable(row) ? { discardDigest: flowDigest(row) } : {}),
      ...(owned && row.pending?.runId ? { activeRunId: row.pending.runId } : {}),
      comparison,
      reasons: [...reasons]
    }
  }
  list(scope: EvaluationScope): EvaluationView[] {
    scope.assertCurrent()
    const rows = this.deps.store.list(scope.workspace, scope.threadId).map((row) => this.view(row))
    scope.assertCurrent()
    return rows
  }
  /** Cleanup completion, not just a published state, permits discarding an experiment link. */
  isSettled(scope: EvaluationScope, id: string): boolean {
    scope.assertCurrent()
    if (this.active.get(scope.workspace)?.row.id === id) return false
    const row = this.deps.store.list(scope.workspace, scope.threadId).find(row => row.id === id)
    return !!row && !row.pending && (row.state === "complete" || row.state === "cancelled")
  }
  /** Lets the IPC owner retain its cancellation/fencing lifecycle through actual cleanup. */
  async wait(workspace: string, threadId: string, id: string): Promise<void> {
    const active = this.active.get(workspace)
    if (active?.row.id === id && active.row.threadId === threadId) await active.done
  }
  private select(
    workspace: string,
    input: EvaluationStartInput["baseline"],
    snapshot?: SavedFlow
  ): SavedFlow {
    const saved = snapshot ?? this.deps.history.get(workspace, input.id)
    if (
      !saved ||
      saved.definition.id !== input.id ||
      saved.revision !== input.revision ||
      saved.digest !== input.digest ||
      flowDigest(saved.definition) !== saved.digest
    )
      throw Error("EVALUATION_STALE")
    const definition = saved.definition
    if (
      definition.schemaVersion !== 2 ||
      !["prompt-only-v1", "workspace-files-v1"].includes(definition.execution.profile ?? "") ||
      definition.steps.some(
        (step) => step.enabled && !["agent", "check", "approval"].includes(step.kind)
      ) ||
      !definition.steps.some((step) => step.enabled && step.kind === "agent") ||
      !definition.steps.some(
        (step) => step.enabled && step.kind === "check" && ["unit-test", "e2e"].includes(step.check)
      ) ||
      definition.steps.some(
        (step) =>
          step.enabled && step.kind === "check" && !["unit-test", "e2e"].includes(step.check)
      )
    )
      throw Error("EVALUATION_INVALID")
    return frozenCopy(saved)
  }
  async start(input: EvaluationStartInput, inputScope: EvaluationScope): Promise<EvaluationView> {
    return this.startInternal(input, inputScope)
  }
  /** Host-only immutable experiment snapshots; not an IPC operation or permission grant. */
  async startSnapshots(
    input: EvaluationStartInput,
    scope: EvaluationScope,
    pair: { baseline: SavedFlow; candidate: SavedFlow },
    sources: { baseline: SavedFlow; candidate: SavedFlow }
  ): Promise<EvaluationView> {
    return this.startInternal(input, scope, frozenCopy(pair), frozenCopy(sources))
  }
  private async startInternal(
    input: EvaluationStartInput,
    inputScope: EvaluationScope,
    pair?: { baseline: SavedFlow; candidate: SavedFlow },
    sources?: { baseline: SavedFlow; candidate: SavedFlow }
  ): Promise<EvaluationView> {
    let creationAttempted = false
    try {
      // Validate IPC shape before this host API; detach everything before an authority callback.
      const request = frozenCopy(input)
      const { workspace, threadId, signal, assertCurrent } = inputScope
      const scope = { workspace, threadId, signal, assertCurrent }
      signal.throwIfAborted()
      assertCurrent()
      if (request.threadId !== threadId || request.expectedWorkspace !== workspace)
        throw Error("EVALUATION_STALE")
      if (this.active.has(workspace) || this.active.size >= 2) throw Error("EVALUATION_BUSY")
      if (
        !Array.isArray(request.tasks) ||
        request.tasks.length < 1 ||
        request.tasks.length > 5 ||
        new Set(request.tasks.map((task) => task.id)).size !== request.tasks.length ||
        request.tasks.some(
          (task) =>
            !/^[A-Za-z0-9_-]{1,60}$/.test(task.id) || parseFlowTaskGoal(task.goal).length > 4000
        ) ||
        !Number.isSafeInteger(request.budget.timeoutMs) ||
        request.budget.timeoutMs < 1000 ||
        request.budget.timeoutMs > 3_600_000 ||
        !Number.isSafeInteger(request.budget.maxExecutions) ||
        request.budget.maxExecutions < 1 ||
        request.budget.maxExecutions > 200
      )
        throw Error("EVALUATION_INVALID")
      request.tasks = request.tasks.map((task) => ({ ...task, goal: parseFlowTaskGoal(task.goal) }))
      const baseline = this.select(workspace, request.baseline, pair?.baseline),
        candidate = this.select(workspace, request.candidate, pair?.candidate)
      const checks = (saved: SavedFlow) =>
        saved.definition.steps
          .filter((step) => step.enabled && step.kind === "check")
          .map((step) => (step.kind === "check" ? step.check : ""))
          .sort()
      if (
        flowDigest(checks(baseline)) !== flowDigest(checks(candidate)) ||
        baseline.definition.schemaVersion !== 2 ||
        candidate.definition.schemaVersion !== 2 ||
        baseline.definition.execution.profile !== candidate.definition.execution.profile ||
        request.tasks.length *
          (baseline.definition.maxExecutions + candidate.definition.maxExecutions) >
          request.budget.maxExecutions
      )
        throw Error("EVALUATION_INVALID")
      if (sources) {
        this.select(workspace, {
          id: sources.baseline.definition.id,
          revision: sources.baseline.revision,
          digest: sources.baseline.digest
        })
        this.select(workspace, {
          id: sources.candidate.definition.id,
          revision: sources.candidate.revision,
          digest: sources.candidate.digest
        })
      }
      signal.throwIfAborted()
      assertCurrent()
      creationAttempted = true
      const row = this.deps.store.create({
        workspace,
        threadId,
        baseline,
        candidate,
        tasks: request.tasks,
        budget: request.budget,
        provider: this.deps.provider
      })
      const active: Active = {
        row,
        controller: new AbortController(),
        done: Promise.resolve(),
        sources
      }
      this.active.set(workspace, active)
      active.done = Promise.resolve().then(() => this.execute(active, scope))
      return this.view(row)
    } catch (error) {
      if (!creationAttempted || error instanceof EvaluationCreateNotPersisted)
        throw new EvaluationNotStarted(error)
      throw error
    }
  }
  async cancel(scope: EvaluationScope, id: string): Promise<void> {
    scope.assertCurrent()
    const active = this.active.get(scope.workspace)
    if (!active || active.row.id !== id || active.row.threadId !== scope.threadId)
      throw Error("EVALUATION_STALE")
    active.controller.abort()
    await active.done
  }
  private async execute(active: Active, scope: EvaluationScope) {
    const { controller } = active
    const abort = () => controller.abort()
    scope.signal.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(abort, active.row.budget.timeoutMs)
    const guard = () => {
      scope.signal.throwIfAborted()
      controller.signal.throwIfAborted()
      scope.assertCurrent()
      if (active.sources)
        for (const source of Object.values(active.sources)) {
          const current = this.deps.history.get(scope.workspace, source.definition.id)
          if (
            !current ||
            current.revision !== source.revision ||
            current.digest !== source.digest ||
            flowDigest(current.definition) !== source.digest
          )
            throw Error("EVALUATION_STALE")
        }
      controller.signal.throwIfAborted()
      scope.signal.throwIfAborted()
    }
    const watchdog = setInterval(() => {
      try {
        guard()
      } catch {
        controller.abort()
      }
    }, 100)
    const save = () => {
      active.row = this.deps.store.put(
        { ...active.row, revision: active.row.revision + 1 },
        active.row.revision
      )
    }
    let releaseSnapshot: (() => void) | undefined
    let runId: string | undefined
    let cancelInFlight: Promise<void> | undefined
    const cancelRun = () => {
      if (!runId) return
      cancelInFlight ??= this.deps.flows
        .cancel(scope.workspace, scope.threadId, runId)
        .catch(() => undefined)
    }
    controller.signal.addEventListener("abort", cancelRun)
    try {
      for (const task of active.row.tasks)
        for (const variant of ["baseline", "candidate"] as const) {
          guard()
          active.row.pending = { variant, caseId: task.id }
          save()
          if (active.sources)
            releaseSnapshot = registerEvaluationSnapshotStart(
              active.row[variant],
              {
                workspace: scope.workspace,
                threadId: scope.threadId,
                pairDigest: flowDigest([active.row.baseline, active.row.candidate])
              },
              guard
            )
          const run = await this.deps.flows.startSaved(
            scope.workspace,
            scope.threadId,
            active.row[variant],
            { workspace: scope.workspace, goal: task.goal }
          )
          runId = run.id
          if (controller.signal.aborted || scope.signal.aborted) {
            controller.abort()
            cancelRun()
          }
          active.row.pending.runId = run.id
          save()
          await this.deps.flows.waitForSettlement(scope.workspace, scope.threadId, run.id)
          if (cancelInFlight) await cancelInFlight
          releaseSnapshot?.()
          releaseSnapshot = undefined
          const settled = this.deps.history.run(scope.workspace, scope.threadId, run.id)
          runId = undefined
          cancelInFlight = undefined
          if (
            !settled ||
            running.has(settled.status) ||
            settled.flow.digest !== active.row[variant].digest ||
            settled.taskGoal !== task.goal
          )
            throw Error("EVALUATION_SETTLEMENT_UNKNOWN")
          active.row.results[variant].push(
            collectEvaluationObservation(settled, task.id, this.deps.evidence)
          )
          delete active.row.pending
          save()
          if (settled.status === "cancelled") controller.abort()
          if (settled.status === "interrupted") throw Error("EVALUATION_SETTLEMENT_UNKNOWN")
          guard()
        }
      active.row.state = "complete"
    } catch {
      active.row.state =
        controller.signal.aborted || scope.signal.aborted ? "cancelled" : "interrupted"
      active.row.reasons.push("execution-or-publication-not-confirmed")
    } finally {
      // Never abandon a started owned Flow because scope/IPC publication failed.
      controller.abort()
      cancelRun()
      if (cancelInFlight) await cancelInFlight
      if (runId)
        await this.deps.flows
          .waitForSettlement(scope.workspace, scope.threadId, runId)
          .catch(() => undefined)
      releaseSnapshot?.()
      clearTimeout(timer)
      clearInterval(watchdog)
      scope.signal.removeEventListener("abort", abort)
      controller.signal.removeEventListener("abort", cancelRun)
      try {
        save()
      } catch {
        /* The durable start marker remains unknown; no automatic retry. */
      }
      if (this.active.get(scope.workspace) === active) this.active.delete(scope.workspace)
    }
  }
}
