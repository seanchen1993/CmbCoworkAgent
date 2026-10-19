import { bindEvaluationSnapshotRun } from "../evaluation/snapshot-lease"
import { flowProgressReporter } from "./progress"
import { originalFlowActionResult, requiresNativeFlowActionFacts } from "./action-execution-facts"
import type {
  FlowFileReview,
  FlowFilePublicationOutcome,
  FlowFilePublicationRequest
} from "../../../shared/mods/flows/file-publication"
import type { FlowStepResult } from "../../../shared/mods/flows/types"
import { bindFlowFileReceipt, flowFileReceiptDigest } from "./file-recovery-receipt"
import type { FlowRecoveryCandidate } from "./recovery-history"
import { randomUUID } from "node:crypto"
import { runtimeErrorDiagnostic } from "../../utils/runtime-error-diagnostic"
import {
  claimLocalThreadRunLease,
  captureLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../../agent/thread-run-lease"
import type {
  FlowApproval,
  FlowAttempt,
  FlowRun,
  SavedFlow
} from "../../../shared/mods/flows/types"
import type { FlowExecution, FlowHost, FlowPersistence } from "./contracts"
import { flowDigest } from "./store"
import { parseFlowDefinition, parseFlowTaskGoal } from "../../../shared/mods/flows/schema"
import type { FlowChatTask } from "../../../shared/mods/flows/types"
import type { FlowRecoveryPlan } from "../../../shared/mods/flows/recovery"
import { analyzeFlowRecovery } from "./recovery"
import { planFlowRecoveryReservation, type RecoveryHistoryRun } from "./recovery-history"
import { bindFlowPromptReceipt, flowPromptReceiptDigest } from "./prompt-recovery-receipt"
import { createHash } from "node:crypto"
import { prepareFlowRuntimeAdmission } from "./runtime-admission"

interface ActiveFlow {
  run: FlowRun
  controller: AbortController
  leaseCurrent: () => boolean
  assertOwnerCurrent?: () => void
  execution?: FlowExecution
  approval?: { resolve(): void; reject(error: Error): void }
  approved: Map<string, FlowApproval>
  done: Promise<void>
  recoverySourceId?: string
  captureActionFacts?: boolean
}
const activeStatus = (run: FlowRun) => ["queued", "running", "waiting"].includes(run.status)
const clone = <T>(value: T): T => structuredClone(value)
const promptOnly = (run: FlowRun) =>
  run.flow?.definition?.schemaVersion === 2 &&
  run.flow.definition.execution?.profile === "prompt-only-v1"

const filesOnly = (run: FlowRun) =>
  run.flow?.definition?.schemaVersion === 2 &&
  run.flow.definition.execution?.profile === "workspace-files-v1"
const resumable = (run: FlowRun) => promptOnly(run) || filesOnly(run)

/** Business sequencing only. Models, tools, permissions and checkpoint commits remain native. */
export class FlowManager {
  private readonly active = new Map<string, ActiveFlow>()
  private readonly admissionSettlements = new Map<string, {
    workspace: string
    threadId: string
    done: Promise<void>
  }>()
  constructor(
    private readonly store: FlowPersistence,
    private readonly host: FlowHost
  ) {}

  async filePublication(
    workspace: string,
    threadId: string,
    runId: string,
    request: FlowFilePublicationRequest,
    expectedDigest?: string,
    signal: AbortSignal = AbortSignal.timeout(30000),
    assertCallerCurrent: () => void = () => {}
  ): Promise<FlowFileReview | FlowFilePublicationOutcome> {
    this.host.assertScope(workspace, threadId)
    assertCallerCurrent()
    if (!this.host.filePublication || this.active.has(threadId))
      throw Error("FLOW_FILE_PUBLICATION_BUSY")
    const run = this.store.run(workspace, threadId, runId)
    if (!run || run.status !== "complete" || !filesOnly(run))
      throw Error("FLOW_FILE_PUBLICATION_UNAVAILABLE")
    const digest = flowDigest(run)
    if (request.kind !== "review" && expectedDigest !== digest)
      throw Error("FLOW_FILE_REVIEW_CHANGED")
    const captured = structuredClone(request)
    const leaseId = `flow-publication:${randomUUID()}`
    if (!claimLocalThreadRunLease({ threadId, owner: "mods", runId: leaseId }).acquired)
      throw Error("FLOW_FILE_PUBLICATION_BUSY")
    const leaseCurrent = captureLocalThreadRunLease(threadId)!
    const guard = () => {
      signal.throwIfAborted()
      assertCallerCurrent()
      this.host.assertScope(workspace, threadId)
      if (!leaseCurrent() || flowDigest(this.store.run(workspace, threadId, runId)) !== digest)
        throw Error("FLOW_FILE_REVIEW_CHANGED")
      signal.throwIfAborted()
    }
    try {
      guard()
      const result = await this.host.filePublication(clone(run), captured, signal, guard)
      guard()
      return captured.kind === "review"
        ? { ...(result as Omit<FlowFileReview, "runDigest">), runDigest: digest }
        : (result as FlowFilePublicationOutcome)
    } finally {
      releaseLocalThreadRunLease(threadId, "mods", leaseId)
    }
  }

  list(workspace: string): SavedFlow[] {
    return this.store.list(workspace)
  }
  activeSummary(workspace: string, threadId: string): import("../../../shared/mods/flows/types").FlowActiveSummary | null {
    this.host.assertScope(workspace, threadId)
    const active = [...this.active.values()].find((item) => item.run.workspace === workspace)
    if (!active) return null
    this.host.assertScope(workspace, active.run.threadId)
    return {
      runId: active.run.id,
      threadId: active.run.threadId,
      flowName: active.run.flow.definition.name,
      status: activeStatus(active.run) ? active.run.status : "running"
    }
  }
  save(workspace: string, definition: unknown, expectedRevision: number): SavedFlow {
    return this.store.save(workspace, definition, expectedRevision)
  }
  runs(workspace: string, threadId: string): FlowRun[] {
    return this.store.runs(workspace, threadId).map((run) => {
      if (
        activeStatus(run) &&
        this.active.get(threadId)?.run.id !== run.id &&
        this.active.get(threadId)?.recoverySourceId !== run.id
      ) {
        run.status = "interrupted"
        run.summary = "运行已中断；历史不能证明未完成操作是否生效。请核对产物后重新运行。"
        run.finishedAt = Date.now()
        delete run.pendingApproval
        for (const attempt of run.attempts)
          if (["running", "waiting"].includes(attempt.status)) attempt.status = "unknown"
        this.store.put(run)
      }
      const live = this.active.get(threadId)
      const observed = live?.run.id === run.id ? live.run.attempts.findLast((row) => row.progress) : undefined
      if (observed?.progress)
        for (const attempt of run.attempts) {
          if (attempt.executionId === observed.executionId) attempt.progress = clone(observed.progress)
        }
      return run
    })
  }
  run(workspace: string, threadId: string, runId: string): FlowRun | null {
    const live = this.active.get(threadId)
    if (live?.run.id === runId && live.run.workspace === workspace && activeStatus(live.run)) {
      this.host.assertScope(workspace, threadId)
      return clone(live.run)
    }
    return this.runs(workspace, threadId).find((row) => row.id === runId) ?? null
  }

  async recovery(workspace: string, threadId: string, runId: string): Promise<FlowRecoveryPlan> {
    const assertScope = () => {
      if (this.host.assertRecoveryScope) this.host.assertRecoveryScope(workspace, threadId)
      else this.host.assertScope(workspace, threadId)
    }
    assertScope()
    // Reading recovery must not call runs(), which repairs interrupted history in place.
    const source = this.store.run(workspace, threadId, runId)
    if (!source) throw Error("FLOW_RUN_MISSING")
    const run = clone(source)
    if (run.workspace !== workspace || run.threadId !== threadId) throw Error("FLOW_SCOPE_CHANGED")
    const digest = flowDigest(run)
    const history = resumable(run) ? this.store.runs(workspace, threadId) : undefined
    const historyDigest = history ? flowDigest(history) : undefined
    const isActive = () =>
      this.active.get(threadId)?.run.id === runId ||
      this.active.get(threadId)?.recoverySourceId === runId
    if (isActive()) return analyzeFlowRecovery(run, { authority: "unverified" }, true, history)
    const observation = this.host.observeRecovery
      ? await this.host.observeRecovery(clone(run))
      : { authority: "unverified" as const }
    assertScope()
    const current = this.store.run(workspace, threadId, runId)
    if (
      !current ||
      flowDigest(current) !== digest ||
      isActive() ||
      (historyDigest !== undefined &&
        flowDigest(this.store.runs(workspace, threadId)) !== historyDigest)
    )
      throw Error("FLOW_RECOVERY_STALE")
    return analyzeFlowRecovery(run, observation, false, history)
  }

  async start(
    workspace: string,
    threadId: string,
    flowId: string,
    revision: number,
    task?: FlowChatTask,
    assertOwnerCurrent?: () => void
  ): Promise<FlowRun> {
    assertOwnerCurrent?.()
    this.host.assertScope(workspace, threadId)
    if (task !== undefined && (!task || task.workspace !== workspace))
      throw Error("流程所在项目已改变，请重新选择流程。")
    const flow = this.store.get(workspace, flowId)
    if (!flow || flow.revision !== revision) throw Error("FLOW_REVISION_CHANGED")
    return this.startSaved(workspace, threadId, flow, task, assertOwnerCurrent)
  }

  /** A host-selected Claw copy survives edits to its source template. */
  async startSaved(
    workspace: string,
    threadId: string,
    saved: SavedFlow,
    task?: FlowChatTask,
    assertOwnerCurrent?: () => void
  ): Promise<FlowRun> {
    return this.admittedStart(workspace, threadId, JSON.stringify({ saved, task }), false, () =>
      this.startSavedAdmitted(workspace, threadId, saved, task, assertOwnerCurrent)
    )
  }

  private async admittedStart(
    workspace: string,
    threadId: string,
    input: string,
    recovery: boolean,
    work: () => Promise<FlowRun>
  ): Promise<FlowRun> {
    const pendingAdmission = prepareFlowRuntimeAdmission({
      workspace,
      threadId,
      requestId: `flow-admission:${randomUUID()}`,
      input
    })
    // Preserve the ordinary entry's synchronous prefix when no project binding applies.
    if (!pendingAdmission) return work()
    const admission = await pendingAdmission
    if (!admission) return work()
    let run: FlowRun
    try {
      run = await admission.run(work)
    } catch (error) {
      await admission.settle(undefined, !recovery)
      throw error
    }
    const active = this.active.get(threadId)
    const settled = (active?.run.id === run.id ? active.done : Promise.resolve()).then(
      () => admission.settle(this.store.run(workspace, threadId, run.id) ?? undefined, false),
      async (error) => {
        await admission.settle(undefined, false)
        throw error
      }
    )
    const settlement = { workspace, threadId, done: settled }
    this.admissionSettlements.set(run.id, settlement)
    void settled.then(() => {
      if (this.admissionSettlements.get(run.id) === settlement)
        this.admissionSettlements.delete(run.id)
    }, () => { /* Preserve a failed native settlement as an explicit recovery barrier. */ })
    if (active?.run.id === run.id) active.done = settled
    else await settled
    return run
  }

  private async startSavedAdmitted(
    workspace: string,
    threadId: string,
    saved: SavedFlow,
    task?: FlowChatTask,
    assertOwnerCurrent?: () => void
  ): Promise<FlowRun> {
    assertOwnerCurrent?.()
    this.host.assertScope(workspace, threadId)
    if (task !== undefined && (!task || task.workspace !== workspace))
      throw Error("流程所在项目已改变，请重新选择流程。")
    const taskGoal = task === undefined ? undefined : parseFlowTaskGoal(task.goal)
    const definition = parseFlowDefinition(saved.definition)
    if (
      flowDigest(definition) !== saved.digest ||
      !Number.isSafeInteger(saved.revision) ||
      saved.revision < 1
    )
      throw Error("FLOW_SNAPSHOT_INVALID")
    const flow = { ...saved, definition }
    if (this.active.has(threadId)) throw Error("当前任务已有 DIY 流程运行")
    if ([...this.active.values()].some((value) => value.run.workspace === workspace))
      throw Error("同一项目已有 DIY 流程运行，请先等待或取消")
    const id = `flow_${randomUUID()}`
    const lease = claimLocalThreadRunLease({ threadId, owner: "mods", runId: id })
    if (!lease.acquired) throw Error("当前任务正在执行，请等待后再启动流程")
    const run: FlowRun = {
      id,
      threadId,
      workspace,
      flow: clone(flow),
      ...(taskGoal === undefined ? {} : { taskGoal }),
      status: "queued",
      startedAt: Date.now(),
      epoch: 0,
      attempts: [],
      failureCounts: {}
    }
    try {
      assertOwnerCurrent?.()
      bindEvaluationSnapshotRun(saved, run)
      this.store.put(run)
    } catch (error) {
      releaseLocalThreadRunLease(threadId, "mods", id)
      throw error
    }
    const active: ActiveFlow = {
      run,
      controller: new AbortController(),
      leaseCurrent: captureLocalThreadRunLease(threadId)!,
      approved: new Map(),
      assertOwnerCurrent,
      captureActionFacts: requiresNativeFlowActionFacts(saved),
      done: Promise.resolve()
    }
    this.active.set(threadId, active)
    active.done = Promise.resolve().then(() => this.execute(active))
    this.notify(threadId)
    return clone(run)
  }

  /** Host orchestration waits for disposal and final persistence, not a terminal label. */
  async waitForSettlement(workspace: string, threadId: string, runId: string): Promise<void> {
    const admission = this.admissionSettlements.get(runId)
    if (admission?.workspace === workspace && admission.threadId === threadId) {
      await admission.done
      return
    }
    const active = this.active.get(threadId)
    if (active?.run.id === runId && active.run.workspace === workspace) {
      await active.done
      return
    }
    const run = this.store.run(workspace, threadId, runId)
    if (!run || activeStatus(run)) throw Error("FLOW_SETTLEMENT_UNKNOWN")
  }

  async cancel(workspace: string, threadId: string, runId: string): Promise<void> {
    const pending = this.active.get(threadId)
    const active =
      pending?.run.workspace === workspace && pending.recoverySourceId === runId
        ? pending
        : this.requireActive(workspace, threadId, runId)
    active.controller.abort(Error("用户已取消流程"))
    active.approval?.reject(Error("用户已取消流程"))
    await active.done
  }

  /** Explicit command, never called by a recovery query. The expected digest is not authority. */
  async resume(
    workspace: string,
    threadId: string,
    sourceRunId: string,
    expectedSourceDigest: string
  ): Promise<FlowRun> {
    return this.admittedStart(
      workspace,
      threadId,
      JSON.stringify({ sourceRunId, expectedSourceDigest }),
      true,
      () => this.resumeAdmitted(workspace, threadId, sourceRunId, expectedSourceDigest)
    )
  }

  private async resumeAdmitted(
    workspace: string,
    threadId: string,
    sourceRunId: string,
    expectedSourceDigest: string
  ): Promise<FlowRun> {
    this.host.assertScope(workspace, threadId)
    if (!/^[a-f0-9]{64}$/.test(expectedSourceDigest)) throw Error("FLOW_RECOVERY_STALE")
    if (!this.store.reserveRecovery) throw Error("FLOW_RECOVERY_ATOMIC_STORE_REQUIRED")
    if (
      this.active.has(threadId) ||
      [...this.active.values()].some((item) => item.run.workspace === workspace)
    )
      throw Error("FLOW_RECOVERY_OWNER_ACTIVE")
    const history = this.store.runs(workspace, threadId) as RecoveryHistoryRun[]
    const source = history.find((item) => item.id === sourceRunId)
    if (!source || flowDigest(source) !== expectedSourceDigest) throw Error("FLOW_RECOVERY_STALE")
    if (!resumable(source)) throw Error("FLOW_PROMPT_PROFILE_REQUIRED")
    const prefix = source.attempts.filter(
      (attempt) =>
        source.flow.definition.steps.find((step) => step.id === attempt.stepId)?.kind === "agent" &&
        attempt.status === "passed"
    )
    if (
      !prefix.length ||
      prefix.some((attempt) =>
        filesOnly(source) ? !attempt.fileRecoveryEvidence : !attempt.recoveryEvidence
      )
    )
      throw Error("FLOW_PROMPT_RECEIPT_REQUIRED")
    const candidate: FlowRecoveryCandidate = {
      schemaVersion: 1 as const,
      sourceRunId,
      sourceDigest: expectedSourceDigest,
      hostInactive: true as const,
      prefix: clone(prefix)
    }
    const id = `flow_${randomUUID()}`,
      now = Date.now()
    // This is an in-memory plan only. It checks chain, effects, order and inherited budgets.
    const preview = planFlowRecoveryReservation(history, candidate, { childRunId: id, now }).child
    const lease = claimLocalThreadRunLease({ threadId, owner: "mods", runId: id })
    if (!lease.acquired) throw Error("FLOW_RECOVERY_OWNER_ACTIVE")
    let resolveDone!: () => void
    const active: ActiveFlow = {
      run: preview,
      controller: new AbortController(),
      leaseCurrent: captureLocalThreadRunLease(threadId)!,
      approved: new Map(),
      recoverySourceId: sourceRunId,
      done: new Promise<void>((resolve) => {
        resolveDone = resolve
      })
    }
    this.active.set(threadId, active)
    const deadline = setTimeout(
      () => active.controller.abort(Error("FLOW_RECOVERY_DEADLINE")),
      Math.max(0, preview.recovery!.rootDeadline - Date.now())
    )
    deadline.unref()
    let committed = false
    let detachPreparedSignal = () => {}
    try {
      this.assertLive(active)
      active.execution = await this.host.prepare(
        workspace,
        threadId,
        clone(preview),
        active.controller.signal
      )
      const hostSignal = active.execution.signal
      if (hostSignal) {
        const revoke = () =>
          active.controller.abort(hostSignal.reason ?? Error("FLOW_EXECUTION_EXPIRED"))
        hostSignal.addEventListener("abort", revoke, { once: true })
        detachPreparedSignal = () => hostSignal.removeEventListener("abort", revoke)
        if (hostSignal.aborted) revoke()
      }
      this.assertLive(active)
      const capability = filesOnly(source)
        ? active.execution.fileRecovery
        : active.execution.promptRecovery
      if (!capability) throw Error("FLOW_PROMPT_RUNTIME_REQUIRED")
      await capability.validateSource(clone(source), clone(history), active.controller.signal)
      this.assertLive(active)
      if (filesOnly(source))
        candidate.fileNamespace = clone(active.execution.fileRecovery!.namespace())
      const assertCurrent = () => {
        this.assertLive(active)
        // Child ancestry does not exist until CAS commits. Validate the real source here.
        for (const attempt of prefix) capability.assertReceiptCurrent(source, attempt)
        if (
          filesOnly(source) &&
          flowDigest(candidate.fileNamespace) !==
            flowDigest(active.execution!.fileRecovery!.namespace())
        )
          throw Error("FLOW_FILE_NAMESPACE_CHANGED")
        const current = this.store.run(workspace, threadId, sourceRunId)
        if (!current || flowDigest(current) !== expectedSourceDigest)
          throw Error("FLOW_RECOVERY_STALE")
      }
      assertCurrent()
      active.run = this.store.reserveRecovery(workspace, threadId, candidate, {
        childRunId: id,
        now,
        assertCurrent
      })
      committed = true
      delete active.recoverySourceId
      const result = clone(active.run)
      void Promise.resolve()
        .then(() => this.execute(active))
        .finally(resolveDone)
      this.notify(threadId)
      return result
    } finally {
      clearTimeout(deadline)
      detachPreparedSignal()
      if (!committed) {
        active.controller.abort(Error("FLOW_RECOVERY_NOT_RESERVED"))
        try {
          await active.execution?.dispose()
        } finally {
          try {
            active.execution?.finishTelemetry?.("interrupted")
          } catch {
            /* Optional telemetry. */
          }
          if (this.active.get(threadId) === active) this.active.delete(threadId)
          releaseLocalThreadRunLease(threadId, "mods", id)
          resolveDone()
        }
      }
    }
  }

  async decide(
    workspace: string,
    threadId: string,
    runId: string,
    nonce: string,
    approve: boolean
  ): Promise<FlowRun> {
    const active = this.requireActive(workspace, threadId, runId)
    try {
      this.assertLive(active)
    } catch (error) {
      return this.invalidateApproval(active, error)
    }
    const pending = active.run.pendingApproval
    if (!pending || pending.nonce !== nonce || !active.approval || typeof approve !== "boolean")
      throw Error("此确认已过期，请查看当前待确认步骤")
    if (!approve) {
      active.run.summary = "人工验收被拒绝，流程已停止"
      const error = Error(active.run.summary)
      active.controller.abort(error)
      active.approval.reject(error)
      await active.done
      return clone(active.run)
    }
    let fingerprint: string
    try {
      fingerprint = await active.execution!.fingerprint(active.controller.signal)
      this.assertLive(active)
    } catch (error) {
      return this.invalidateApproval(active, error)
    }
    if (active.run.pendingApproval !== pending || !active.approval) throw Error("此确认已被处理")
    const digest = this.approvalDigest(active.run, fingerprint)
    if (digest !== pending.inputDigest) {
      active.run.pendingApproval = {
        ...pending,
        nonce: randomUUID(),
        inputDigest: digest,
        fingerprint,
        summary: `成果已变化，请重新核对。\n${this.approvalSummary(active.run, pending.stepId)}`
      }
      this.persist(active)
      return clone(active.run)
    }
    const attempt = active.run.attempts.find((row) => row.executionId === pending.executionId)!
    attempt.status = "passed"
    attempt.finishedAt = Date.now()
    attempt.outputFingerprint = fingerprint
    attempt.result = { passed: true, summary: "已确认当前成果", source: "approval" }
    delete active.run.pendingApproval
    active.run.status = "running"
    // Persist the consumed nonce before the continuation can run. JS host turn is the CAS.
    try {
      this.persist(active)
    } catch (error) {
      active.controller.abort(error)
      active.approval.reject(error as Error)
      throw error
    }
    active.approved.set(pending.stepId, pending)
    const waiter = active.approval
    active.approval = undefined
    waiter.resolve()
    return clone(active.run)
  }

  private async invalidateApproval(active: ActiveFlow, error: unknown): Promise<never> {
    active.controller.abort(error)
    active.approval?.reject(error instanceof Error ? error : Error("FLOW_APPROVAL_INVALIDATED"))
    try {
      await active.done
    } catch {
      // Preserve the original source/scope error even if cleanup itself reports a failure.
    }
    throw error
  }

  private requireActive(workspace: string, threadId: string, id: string): ActiveFlow {
    const active = this.active.get(threadId)
    if (!active || active.run.workspace !== workspace || active.run.id !== id)
      throw Error("该流程已结束或中断，旧操作不可继续")
    return active
  }
  private assertLive(active: ActiveFlow): void {
    active.assertOwnerCurrent?.()
    active.controller.signal.throwIfAborted()
    if (this.active.get(active.run.threadId) !== active || !active.leaseCurrent())
      throw Error("FLOW_EXECUTION_EXPIRED")
    this.host.assertScope(active.run.workspace, active.run.threadId)
    const deadline = (active.run as RecoveryHistoryRun).recovery?.rootDeadline
    if (deadline !== undefined && Date.now() >= deadline) throw Error("FLOW_RECOVERY_DEADLINE")
    active.execution?.signal?.throwIfAborted()
    active.execution?.assertLive()
  }
  private validPromptReceipt(active: ActiveFlow, attempt: FlowAttempt): boolean {
    if (filesOnly(active.run) && attempt.result?.source === "agent") {
      if (!attempt.fileRecoveryEvidence || !active.execution?.fileRecovery)
        throw Error("FLOW_FILE_RECEIPT_REQUIRED")
      active.execution.fileRecovery.assertReceiptCurrent(active.run, attempt)
      return true
    }
    if (!promptOnly(active.run) || attempt.result?.source !== "agent") return false
    if (!attempt.recoveryEvidence || !active.execution?.promptRecovery)
      throw Error("FLOW_PROMPT_RECEIPT_REQUIRED")
    active.execution.promptRecovery.assertReceiptCurrent(active.run, attempt)
    return true
  }
  private persist(active: ActiveFlow): void {
    this.store.put(active.run)
    this.notify(active.run.threadId)
  }
  private notify(threadId: string): void {
    try {
      this.host.changed(threadId)
    } catch {
      /* Delivery is not an execution receipt. */
    }
  }
  private current(run: FlowRun, stepId: string): FlowAttempt | undefined {
    return run.attempts.findLast((attempt) => attempt.stepId === stepId && !attempt.invalidated)
  }
  private addAttempt(active: ActiveFlow, stepId: string, skipped?: string): FlowAttempt {
    const run = active.run
    // Only the current step retains this small display observation; settled results remain authoritative.
    for (const previous of run.attempts) delete previous.progress
    // Basic host flows add an internal finalization receipt after their declared steps.
    // It is not another provider invocation. Keep explicit native stages and the separately
    // budgeted recovery profiles unchanged; final checks and approvals still consume budget.
    const hostSummary = run.flow.definition.schemaVersion === 2 &&
      !run.flow.definition.execution.profile
    const summaryReceipt = hostSummary && stepId === "__final"
    if (
      run.attempts.length >= 512 ||
      (!skipped && !summaryReceipt &&
        ((run as RecoveryHistoryRun).recovery?.inheritedExecutions ?? 0) +
          run.attempts.filter(
            (row) => row.status !== "skipped" && !(row as { reusedFrom?: unknown }).reusedFrom &&
              !(hostSummary && row.stepId === "__final")
          ).length >=
          run.flow.definition.maxExecutions)
    )
      throw Error("已达到流程最大执行次数，停止继续调用")
    const attempt: FlowAttempt = {
      executionId: randomUUID(),
      stepId,
      attempt: run.attempts.filter((row) => row.stepId === stepId).length + 1,
      epoch: run.epoch,
      status: skipped ? "skipped" : "running",
      startedAt: Date.now(),
      ...(skipped ? { reason: skipped, finishedAt: Date.now() } : {})
    }
    run.attempts.push(attempt)
    run.currentStepId = stepId
    this.persist(active)
    return attempt
  }
  private approvalDigest(run: FlowRun, fingerprint: string): string {
    return flowDigest({
      definition: run.flow.digest,
      ...(run.taskGoal === undefined ? {} : { taskGoal: run.taskGoal }),
      fingerprint,
      results: run.attempts
        .filter((row) => !row.invalidated && row.result && row.result.source !== "approval")
        .map((row) => [row.executionId, row.result])
    })
  }
  private approvalSummary(run: FlowRun, stepId: string): string {
    const step = run.flow.definition.steps.find((row) => row.id === stepId)
    const title = step?.kind === "approval" ? step.prompt : "请确认当前成果"
    const results = run.attempts
      .filter((row) => !row.invalidated && row.result)
      .slice(-16)
      .map((row) => {
        const name =
          run.flow.definition.steps.find((step) => step.id === row.stepId)?.name ??
          (row.stepId === "__final_check" ? (row.reason ?? "最终检查") : "最终验收")
        return `${name}：${row.result!.passed ? "通过" : "未通过"} — ${row.result!.summary.slice(0, 400)}`
      })
    return `${title}\n${run.taskGoal ? `本次任务：${run.taskGoal}\n` : ""}${results.join("\n")}`.slice(
      0,
      8000
    )
  }
  private async confirm(active: ActiveFlow, stepId: string, attempt?: FlowAttempt): Promise<void> {
    this.assertLive(active)
    const fingerprint = await active.execution!.fingerprint(active.controller.signal)
    this.assertLive(active)
    const inputDigest = this.approvalDigest(active.run, fingerprint)
    const prior = active.approved.get(stepId)
    if (!attempt && prior?.inputDigest === inputDigest) return
    const current = attempt ?? this.addAttempt(active, stepId)
    current.status = "waiting"
    active.run.status = "waiting"
    active.run.pendingApproval = {
      nonce: randomUUID(),
      stepId,
      executionId: current.executionId,
      inputDigest,
      fingerprint,
      summary: this.approvalSummary(active.run, stepId),
      definitionDigest: active.run.flow.digest
    }
    const waiting = new Promise<void>((resolve, reject) => {
      active.approval = { resolve, reject }
    })
    // Attach rejection before persistence, which can fail synchronously.
    void waiting.catch(() => {})
    this.persist(active)
    await waiting
    this.assertLive(active)
  }

  private invalidateAfterRepair(active: ActiveFlow, target: number): void {
    const steps = active.run.flow.definition.steps
    active.run.epoch++
    for (const attempt of active.run.attempts) {
      if (steps.findIndex((step) => step.id === attempt.stepId) >= target) {
        attempt.invalidated = true
        active.approved.delete(attempt.stepId)
      }
    }
  }
  private skipRoute(active: ActiveFlow, from: number, to: number): void {
    const steps = active.run.flow.definition.steps
    for (let index = from + 1; index < to; index++)
      this.addAttempt(active, steps[index].id, `按 ${steps[from].name} 的配置路线跳过`)
  }

  private async execute(active: ActiveFlow): Promise<void> {
    const { run, controller } = active
    const deadline = setTimeout(
      () => controller.abort(Error("流程总时间已用完（包含等待确认）")),
      (run as RecoveryHistoryRun).recovery
        ? Math.max(0, (run as RecoveryHistoryRun).recovery!.rootDeadline - Date.now())
        : run.flow.definition.timeoutMs
    )
    const watchdog = setInterval(() => {
      try {
        this.assertLive(active)
      } catch (error) {
        if (!controller.signal.aborted)
          console.warn("[ModsFlow] Cancellation diagnostic", {
            stage: "watchdog",
            error: runtimeErrorDiagnostic(error)
          })
        controller.abort(error)
      }
    }, 250)
    deadline.unref()
    watchdog.unref()
    const abort = () =>
      active.approval?.reject(
        controller.signal.reason instanceof Error ? controller.signal.reason : Error("流程已取消")
      )
    controller.signal.addEventListener("abort", abort)
    let detachHostSignal = () => {}
    try {
      this.assertLive(active)
      active.execution ??= await this.host.prepare(
        run.workspace,
        run.threadId,
        clone(run),
        controller.signal
      )
      if (promptOnly(run) && !active.execution.promptRecovery)
        throw Error("FLOW_PROMPT_RUNTIME_REQUIRED")
      if (filesOnly(run)) {
        if (!active.execution.fileRecovery) throw Error("FLOW_FILE_RUNTIME_REQUIRED")
        run.fileNamespace = clone(active.execution.fileRecovery.namespace())
      }
      if (active.execution.plan) run.executionPlan = clone(active.execution.plan)
      const hostSignal = active.execution.signal
      if (hostSignal) {
        const revoke = () => {
          if (!controller.signal.aborted)
            console.warn("[ModsFlow] Cancellation diagnostic", {
              stage: "host-signal",
              error: runtimeErrorDiagnostic(hostSignal.reason)
            })
          controller.abort(hostSignal.reason ?? Error("流程执行权限已失效"))
        }
        hostSignal.addEventListener("abort", revoke, { once: true })
        detachHostSignal = () => hostSignal.removeEventListener("abort", revoke)
        if (hostSignal.aborted) revoke()
      }
      this.assertLive(active)
      run.status = "running"
      this.persist(active)
      const steps = run.flow.definition.steps
      const deferredApprovals = new Map<string, FlowAttempt>()
      let index = 0
      while (index < steps.length) {
        this.assertLive(active)
        const step = steps[index]
        const reused = (run as RecoveryHistoryRun).attempts.find(
          (attempt) => attempt.stepId === step.id && attempt.reusedFrom
        )
        if (reused) {
          if (
            step.kind !== "agent" ||
            reused.status !== "passed" ||
            reused.invalidated ||
            !this.validPromptReceipt(active, reused)
          )
            throw Error("FLOW_PROMPT_RECEIPT_REQUIRED")
          index++
          continue
        }
        // Copied prefixes omit disabled no-effect receipts. Do not append them out of order.
        if (
          !step.enabled &&
          (run as RecoveryHistoryRun).attempts.some(
            (attempt) =>
              attempt.reusedFrom && steps.findIndex((row) => row.id === attempt.stepId) > index
          )
        ) {
          index++
          continue
        }
        if (step.kind === "autobiz-stage" && step.enabled) break
        // External writers can change artifacts between steps, not only inside execute().
        const before = step.enabled
          ? await active.execution.fingerprint(controller.signal)
          : undefined
        this.assertLive(active)
        if (before)
          for (const old of run.attempts) {
            if (this.validPromptReceipt(active, old)) continue
            if (!old.outputFingerprint || old.outputFingerprint === before || old.invalidated)
              continue
            old.invalidated = true
            active.approved.delete(old.stepId)
          }
        let skip = step.enabled ? undefined : "用户未启用此步骤"
        if (!skip && step.when) {
          const source = this.current(run, step.when.stepId)
          if (!source || !["passed", "failed"].includes(source.status))
            skip = "条件来源没有当前有效业务结果"
          else if (source.status !== step.when.outcome) skip = "条件不满足"
        }
        const attempt = this.addAttempt(active, step.id, skip)
        if (skip) {
          index++
          continue
        }
        if (step.kind === "approval") {
          if (steps.slice(index + 1).every((row) => !row.enabled || row.kind === "autobiz-stage")) {
            attempt.reason = "等待最终原生检查后确认"
            deferredApprovals.set(step.id, attempt)
          } else await this.confirm(active, step.id, attempt)
        } else {
          attempt.inputFingerprint = before!
          this.assertLive(active)
          let result: FlowStepResult
          const progress = flowProgressReporter(
            () => {
              active.assertOwnerCurrent?.()
              return this.active.get(run.threadId) === active && !controller.signal.aborted &&
                run.currentStepId === attempt.stepId && attempt.status === "running"
            },
            (value) => { attempt.progress = value },
            () => this.notify(run.threadId)
          )
          try {
            result = await active.execution.execute(step, {
              run: clone(run),
              executionId: attempt.executionId,
              signal: controller.signal,
              onProgress: progress.report
            })
          } finally {
            progress.close()
            try {
              const observed = active.execution.executionTelemetry?.(attempt.executionId)
              if (
                observed &&
                [observed.childThreadId, observed.traceId, observed.rootTraceId].every(
                  (value) => typeof value === "string" && value.length > 0 && value.length <= 200
                )
              )
                attempt.telemetry = clone(observed)
            } catch {
              /* Optional host telemetry must not change execution outcome. */
            }
          }
          this.assertLive(active)
          if (!result || typeof result.passed !== "boolean" || typeof result.summary !== "string")
            throw Error("FLOW_RESULT_INVALID")
          attempt.outputFingerprint = await active.execution.fingerprint(controller.signal)
          this.assertLive(active)
          if (step.kind === "check" && attempt.inputFingerprint !== attempt.outputFingerprint)
            throw Error("检查期间产物变化，结果已失效，请重新运行")
          if (attempt.inputFingerprint !== attempt.outputFingerprint) {
            for (const old of run.attempts) {
              if (old !== attempt && this.validPromptReceipt(active, old)) continue
              if (
                old === attempt ||
                !old.outputFingerprint ||
                old.outputFingerprint === attempt.outputFingerprint
              )
                continue
              old.invalidated = true
              active.approved.delete(old.stepId)
            }
          }
          const originalAction = originalFlowActionResult(result)
          if (active.captureActionFacts && originalAction) this.store.recordActionResult?.(run, attempt, originalAction)
          attempt.result = {
            ...result,
            summary: result.summary.slice(0, 8000),
            evidenceIds: result.evidenceIds?.slice(0, 64)
          }
          attempt.status = result.passed ? "passed" : "failed"
          attempt.finishedAt = Date.now()
          if (promptOnly(run) && step.kind === "agent") {
            try {
              const capability = active.execution.promptRecovery!
              const capture = capability.settledCapture(attempt.executionId)
              if (!capture) throw Error("FLOW_PROMPT_RECEIPT_REQUIRED")
              const previousIds = steps
                .slice(0, index)
                .filter((row) => row.enabled && row.kind === "agent")
                .map((row) => row.id)
              const priorReceipts = run.attempts
                .filter((row) => previousIds.includes(row.stepId))
                .map((row) => {
                  this.validPromptReceipt(active, row)
                  return {
                    sourceRunId: row.recoveryEvidence!.binding.runId,
                    executionId: row.executionId,
                    receiptDigest: flowPromptReceiptDigest(row),
                    projectedTextDigest: createHash("sha256")
                      .update(JSON.stringify({ stepId: row.stepId, summary: row.result!.summary }))
                      .digest("hex")
                  }
                })
              attempt.recoveryEvidence = bindFlowPromptReceipt({
                run,
                attempt,
                capture,
                parentThreadIncarnation: capability.parentThreadIncarnation,
                priorReceipts
              })
            } catch (error) {
              attempt.status = "unknown"
              throw error
            }
          }
          if (filesOnly(run) && step.kind === "agent") {
            try {
              const capability = active.execution.fileRecovery!
              const capture = capability.settledCapture(attempt.executionId)
              if (!capture) throw Error("FLOW_FILE_RECEIPT_REQUIRED")
              const previousIds = steps
                .slice(0, index)
                .filter((row) => row.enabled && row.kind === "agent")
                .map((row) => row.id)
              const priorReceipts = run.attempts
                .filter((row) => previousIds.includes(row.stepId))
                .map((row) => {
                  this.validPromptReceipt(active, row)
                  return {
                    sourceRunId: row.fileRecoveryEvidence!.binding.runId,
                    executionId: row.executionId,
                    receiptDigest: flowFileReceiptDigest(row),
                    projectedTextDigest: createHash("sha256")
                      .update(JSON.stringify({ stepId: row.stepId, summary: row.result!.summary }))
                      .digest("hex")
                  }
                })
              attempt.fileRecoveryEvidence = bindFlowFileReceipt({
                run,
                attempt,
                capture,
                parentThreadIncarnation: capability.parentThreadIncarnation,
                priorReceipts
              })
            } catch (error) {
              attempt.status = "unknown"
              throw error
            }
          }
          this.persist(active)
        }
        if (attempt.status === "failed") {
          const route = step.onFailure
          if (!route)
            throw Error(`${step.name} 未通过：${attempt.result?.summary ?? "业务检查失败"}`)
          const count = (run.failureCounts[step.id] ?? 0) + 1
          run.failureCounts[step.id] = count
          if (count > route.maxRetries) throw Error(`${step.name} 已达到最大回退次数`)
          const target = steps.findIndex((row) => row.id === route.stepId)
          attempt.reason = `业务不通过，转向 ${route.stepId}（${count}/${route.maxRetries}）`
          if (target <= index) this.invalidateAfterRepair(active, target)
          else this.skipRoute(active, index, target)
          this.persist(active)
          index = target
        } else {
          const target = step.onSuccess
            ? steps.findIndex((row) => row.id === step.onSuccess)
            : index + 1
          this.skipRoute(active, index, target)
          index = target
        }
      }
      this.assertLive(active)
      for (const attempt of run.attempts) this.validPromptReceipt(active, attempt)
      const finalStep = steps.find((step) => step.enabled && step.kind === "autobiz-stage")
      const finalAttempt = this.addAttempt(active, finalStep?.id ?? "__final")
      let confirmationChecked = false
      const result = await active.execution.finalize(
        { run: clone(run), executionId: finalAttempt.executionId, signal: controller.signal },
        async () => {
          this.assertLive(active)
          const visited = new Set(
            run.attempts.filter((row) => row.status !== "skipped").map((row) => row.stepId)
          )
          for (const step of steps)
            if (step.enabled && step.kind === "approval" && visited.has(step.id)) {
              const deferred = deferredApprovals.get(step.id)
              deferredApprovals.delete(step.id)
              await this.confirm(active, step.id, deferred)
            }
          this.assertLive(active)
          confirmationChecked = true
        },
        (label, checked, fingerprint) => {
          this.assertLive(active)
          if (
            !checked ||
            typeof checked.passed !== "boolean" ||
            typeof checked.summary !== "string" ||
            typeof fingerprint !== "string" ||
            !fingerprint
          )
            throw Error("FLOW_FINAL_RESULT_INVALID")
          for (const old of run.attempts) {
            if (this.validPromptReceipt(active, old)) continue
            if (!old.outputFingerprint || old.outputFingerprint === fingerprint || old.invalidated)
              continue
            old.invalidated = true
            active.approved.delete(old.stepId)
          }
          const evidence = this.addAttempt(active, "__final_check")
          evidence.outputFingerprint = fingerprint
          evidence.reason = label.slice(0, 200)
          evidence.result = {
            ...checked,
            summary: checked.summary.slice(0, 8000),
            evidenceIds: checked.evidenceIds?.slice(0, 64)
          }
          evidence.status = checked.passed ? "passed" : "failed"
          evidence.finishedAt = Date.now()
          this.persist(active)
        }
      )
      this.assertLive(active)
      if (!result || typeof result.passed !== "boolean" || typeof result.summary !== "string")
        throw Error("FLOW_FINAL_RESULT_INVALID")
      if (result.passed && !confirmationChecked) throw Error("FLOW_CONFIRMATION_BARRIER_REQUIRED")
      finalAttempt.result = { ...result, summary: result.summary.slice(0, 8000) }
      finalAttempt.status = result.passed ? "passed" : "failed"
      finalAttempt.finishedAt = Date.now()
      for (const attempt of deferredApprovals.values())
        if (attempt.status === "running") {
          attempt.status = "skipped"
          attempt.reason = "最终检查未通过，无需确认"
          attempt.finishedAt = Date.now()
        }
      run.status = result.passed ? "complete" : "failed"
      run.summary = result.summary.slice(0, 8000)
    } catch (error) {
      // Child runtimes may normalize cancellation to "Workflow aborted". Preserve the
      // parent authority/deadline/user reason that actually stopped this Flow.
      const cause = controller.signal.aborted ? (controller.signal.reason ?? error) : error
      const message = cause instanceof Error ? cause.message : String(cause)
      for (const unknown of run.attempts.filter(
        (row) => row.status === "running" || row.status === "waiting"
      )) {
        unknown.status = "unknown"
        unknown.reason = message
        unknown.finishedAt = Date.now()
      }
      run.status = controller.signal.aborted ? "cancelled" : "failed"
      run.summary = message.slice(0, 4000)
    } finally {
      clearTimeout(deadline)
      clearInterval(watchdog)
      controller.signal.removeEventListener("abort", abort)
      detachHostSignal()
      active.approval?.reject(Error("流程已结束"))
      active.approval = undefined
      delete run.pendingApproval
      run.finishedAt = Date.now()
      // Revoke children before releasing the physical lease to another task.
      controller.abort()
      try {
        await active.execution?.dispose()
      } catch (error) {
        run.status = "interrupted"
        run.summary = `资源清理未确认：${error instanceof Error ? error.message : String(error)}`
      }
      try {
        this.persist(active)
      } catch {
        // Durable running row becomes interrupted on the next read, never PASS.
        run.status = "interrupted"
        run.summary = "运行结果无法持久化，请核对实际产物，不要重复提交状态"
        this.notify(run.threadId)
      }
      try {
        active.execution?.finishTelemetry?.(run.status)
      } catch {
        /* Optional telemetry. */
      }
      if (this.active.get(run.threadId) === active) this.active.delete(run.threadId)
      releaseLocalThreadRunLease(run.threadId, "mods", run.id)
      this.notify(run.threadId)
    }
  }
}
