import { analyzeFileFlowRecovery } from "./file-recovery-analysis"
import { isDeepStrictEqual } from "node:util"
import type { FlowRecoveryPlan, FlowRecoveryReason } from "../../../shared/mods/flows/recovery"
import type { FlowExecutionPlan, FlowRun } from "../../../shared/mods/flows/types"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import { flowDigest } from "./store"
import { analyzePromptFlowRecovery } from "./prompt-recovery-analysis"

/** Supplied only by a read-only host observer, never by IPC callers. Missing facts fail closed. */
export interface FlowRecoveryObservation {
  authority: "current" | "unavailable" | "unverified"
  definitionDigest?: string
  executionPlan?: FlowExecutionPlan
  artifactFingerprint?: string
  reasons?: FlowRecoveryReason[]
  /** Host-verified current receipt identities; never accepted from renderer/model input. */
  promptReceipts?: { verifiedExecutionIds: string[] }
  fileReceipts?: { verifiedExecutionIds: string[] }
}

const unsettled = new Set(["running", "waiting", "unknown"])
const statuses = new Set([
  "queued",
  "running",
  "waiting",
  "complete",
  "failed",
  "cancelled",
  "interrupted"
])

/** Pure, bounded history interpretation. Does not repair records, prepare a host, or run tools. */
export function analyzeFlowRecovery(
  run: FlowRun,
  observation: FlowRecoveryObservation,
  active: boolean,
  history?: readonly FlowRun[]
): FlowRecoveryPlan {
  if (run?.flow?.definition?.schemaVersion === 2 &&
      run.flow.definition.execution?.profile === "workspace-files-v1")
    return analyzeFileFlowRecovery(run, history, observation, active)
  if (
    run?.flow?.definition?.schemaVersion === 2 &&
    run.flow.definition.execution?.profile === "prompt-only-v1"
  )
    return analyzePromptFlowRecovery(run, history, observation, active)
  const reasons: FlowRecoveryReason[] = []
  const block = (code: string, message: string, stepId?: string) => {
    reasons.push({ code, message, ...(stepId ? { stepId } : {}) })
  }
  const report: FlowRecoveryPlan = {
    schemaVersion: 1,
    runId: run.id,
    sourceDigest: "",
    status: "blocked",
    reasons,
    steps: [],
    consumedExecutions: 0,
    remainingExecutions: 0,
    requiresFreshFinalization: true
  }
  let definition: FlowRun["flow"]["definition"]
  try {
    report.sourceDigest = flowDigest(run)
    definition = parseFlowDefinition(run.flow.definition)
    if (flowDigest(definition) !== run.flow.digest) throw Error("digest")
    if (!Number.isSafeInteger(run.flow.revision) || run.flow.revision < 1) throw Error("revision")
    if (!Array.isArray(run.attempts) || run.attempts.length > 512) throw Error("attempts")
    if (run.attempts.some((row) => !row || typeof row !== "object")) throw Error("attempt")
    if (!statuses.has(run.status) || !Number.isSafeInteger(run.epoch) || run.epoch < 0)
      throw Error("status")
    if (!Number.isFinite(run.startedAt) || run.startedAt < 0) throw Error("time")
  } catch {
    block("invalid-history", "历史结构或流程快照不完整，不能据此恢复。")
    return report
  }
  report.consumedExecutions = run.attempts.filter((row) => row.status !== "skipped").length
  report.remainingExecutions = Math.max(0, definition.maxExecutions - report.consumedExecutions)
  if (active) {
    report.status = "active"
    block("active-run", "流程仍在运行，请查看当前进度。")
    return report
  }
  if (run.status === "complete") {
    report.status = "complete"
    block("already-complete", "本次流程已经结束，无需续跑；历史通过不代表当前产物仍有效。")
    return report
  }
  if (run.status === "cancelled") block("cancelled", "用户或执行权限已停止本次流程，不允许续跑。")
  if (!report.remainingExecutions) block("budget-exhausted", "本次流程的执行次数已用完。")
  if (
    run.epoch !== 0 ||
    definition.steps.some((step) => step.when || step.onSuccess || step.onFailure)
  )
    block("complex-route", "流程包含条件、跳转或修复回路，当前历史不能证明唯一的续跑位置。")
  if (observation.authority !== "current")
    block("authority-unverified", "当前执行授权未确认，不能复用历史结果。")
  if (observation.definitionDigest !== run.flow.digest)
    block("definition-changed", "当前流程版本已变化或无法确认。")
  if (!run.executionPlan || !observation.executionPlan)
    block("plan-unverified", "缺少历史或当前执行配置，无法核对模型、组件和工具来源。")
  else if (!isDeepStrictEqual(run.executionPlan, observation.executionPlan))
    block("plan-changed", "模型、组件、Skill 或工具配置已改变，不能复用历史结果。")
  if (!observation.artifactFingerprint) block("artifacts-unverified", "当前产物指纹尚未确认。")
  for (const reason of observation.reasons?.slice(0, 64) ?? []) reasons.push({ ...reason })

  const ids = new Set<string>()
  const stepIds = new Set(definition.steps.map((step) => step.id))
  const attempts = new Map<string, FlowRun["attempts"]>()
  let previousIndex = -1
  for (const attempt of run.attempts) {
    if (
      !attempt ||
      typeof attempt.executionId !== "string" ||
      !attempt.executionId ||
      ids.has(attempt.executionId) ||
      !Number.isFinite(attempt.startedAt) ||
      attempt.startedAt < run.startedAt ||
      attempt.epoch !== 0 ||
      attempt.attempt !== 1 ||
      !["running", "passed", "failed", "skipped", "waiting", "unknown"].includes(attempt.status)
    ) {
      block("invalid-attempt", "步骤执行记录不完整或重复，不能推断续跑位置。")
      continue
    }
    ids.add(attempt.executionId)
    if (!stepIds.has(attempt.stepId)) {
      // The old finalizer can commit business state. No settled or unsettled final call is replayed.
      block(
        "finalization-entered",
        "已进入最终验收或提交阶段，请先核对实际检查与业务状态。",
        attempt.stepId
      )
      continue
    }
    const index = definition.steps.findIndex((step) => step.id === attempt.stepId)
    if (index <= previousIndex)
      block("ambiguous-order", "历史执行顺序不能证明连续前缀。", attempt.stepId)
    previousIndex = index
    attempts.set(attempt.stepId, [...(attempts.get(attempt.stepId) ?? []), attempt])
  }

  let boundary = false
  for (const step of definition.steps) {
    const rows = attempts.get(step.id) ?? []
    const attempt = rows[0]
    const item: FlowRecoveryPlan["steps"][number] = {
      stepId: step.id,
      name: step.name,
      disposition: "pending",
      reason: "尚未执行。",
      ...(attempt ? { executionId: attempt.executionId } : {})
    }
    report.steps.push(item)
    if (rows.length > 1) block("duplicate-step", "步骤有多次执行，不能自动选取结果。", step.id)
    if (!step.enabled) {
      item.disposition = "disabled"
      item.reason = "此步骤未启用。"
      if (attempt && attempt.status !== "skipped")
        block("disabled-executed", "未启用步骤存在执行记录。", step.id)
      continue
    }
    if (!attempt) {
      boundary = true
      report.nextStepId ??= step.id
      continue
    }
    // Project checks execute real scripts; an interrupted check may have external effects too.
    const settledCheck =
      step.kind === "check" &&
      ["passed", "failed"].includes(attempt.status) &&
      attempt.result?.source === "native-check" &&
      attempt.result.passed === (attempt.status === "passed") &&
      Number.isFinite(attempt.finishedAt) &&
      attempt.finishedAt! >= attempt.startedAt
    const safeRecheck = step.kind === "approval" || settledCheck
    if (safeRecheck) {
      boundary = true
      report.nextStepId ??= step.id
      item.disposition = "recheck"
      item.reason =
        step.kind === "approval" ? "旧审批不复用，需要重新确认。" : "原生检查需要重新执行。"
      continue
    }
    if (unsettled.has(attempt.status) || step.kind === "autobiz-stage") {
      boundary = true
      item.disposition = "unknown"
      item.reason = "操作可能已经生效，必须先核对，不自动重放。"
      block("unknown-effect", item.reason, step.id)
      continue
    }
    const expectedSource = step.kind === "agent" ? "agent" : step.kind
    const valid =
      attempt.status === "passed" &&
      attempt.result?.passed === true &&
      attempt.result.source === expectedSource &&
      !attempt.invalidated &&
      typeof attempt.inputFingerprint === "string" &&
      !!attempt.inputFingerprint &&
      typeof attempt.outputFingerprint === "string" &&
      !!attempt.outputFingerprint &&
      Number.isFinite(attempt.finishedAt) &&
      attempt.finishedAt! >= attempt.startedAt &&
      attempt.outputFingerprint === observation.artifactFingerprint
    if (!valid || boundary) {
      boundary = true
      item.disposition = "blocked"
      item.reason = valid
        ? "执行位于待重跑步骤之后，不能作为连续前缀复用。"
        : "结果、产物指纹或结算证据已失效。"
      block("nonreusable-effect", item.reason, step.id)
      continue
    }
    item.disposition = "reusable"
    item.reason = "结算记录和当前产物一致，可作为恢复候选；启动时仍需再次核验。"
  }
  if (!reasons.length) report.status = "eligible"
  else
    for (const step of report.steps)
      if (step.disposition === "reusable") {
        step.disposition = "blocked"
        step.reason = "运行级证据未通过核对，暂不可复用。"
      }
  return report
}
