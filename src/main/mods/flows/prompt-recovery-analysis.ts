import type { FlowRun } from "../../../shared/mods/flows/types"
import type { FlowRecoveryPlan } from "../../../shared/mods/flows/recovery"
import type { FlowRecoveryObservation } from "./recovery"
import { flowDigest } from "./store"
import {
  planFlowRecoveryReservation,
  planRecoveryHistoryRetention,
  type RecoveryHistoryRun
} from "./recovery-history"

/** Diagnostic-only plan. No fingerprint substitution, authorization, preparation or writes. */
export function analyzePromptFlowRecovery(
  run: FlowRun,
  history: readonly FlowRun[] | undefined,
  observation: FlowRecoveryObservation,
  active: boolean,
  now = Date.now()
): FlowRecoveryPlan {
  const report: FlowRecoveryPlan = {
    schemaVersion: 1,
    runId: run.id,
    sourceDigest: "",
    status: "blocked",
    reasons: [],
    steps: [],
    consumedExecutions: 0,
    remainingExecutions: 0,
    requiresFreshFinalization: true
  }
  const block = (code: string, message: string) => {
    report.reasons.push({ code, message })
  }
  let rows: RecoveryHistoryRun[]
  try {
    report.sourceDigest = flowDigest(run)
    if (
      run.flow.definition.schemaVersion !== 2 ||
      run.flow.definition.execution.profile !== "prompt-only-v1"
    )
      throw Error("profile")
    if (!history || !Array.isArray(history) || history.length > 20) throw Error("history")
    const source = history.find((row) => row?.id === run.id)
    if (!source || flowDigest(source) !== report.sourceDigest) throw Error("source")
    rows = planRecoveryHistoryRetention(history as RecoveryHistoryRun[], [run.id])
    const current = rows.find((row) => row.id === run.id)!
    const actual = current.attempts.filter((attempt) => {
      if (attempt.reusedFrom) return false
      const disabledNoEffect =
        attempt.status === "skipped" &&
        current.flow.definition.steps.find((step) => step.id === attempt.stepId)?.enabled ===
          false &&
        attempt.result === undefined &&
        attempt.inputFingerprint === undefined &&
        attempt.outputFingerprint === undefined &&
        !attempt.invalidated &&
        Number.isSafeInteger(attempt.finishedAt) &&
        attempt.finishedAt! >= attempt.startedAt
      return !disabledNoEffect
    }).length
    report.consumedExecutions = (current.recovery?.inheritedExecutions ?? 0) + actual
    report.remainingExecutions = Math.max(
      0,
      current.flow.definition.maxExecutions - report.consumedExecutions
    )
  } catch {
    block("invalid-history", "历史或父链结构不完整，不能据此恢复。")
    return report
  }
  if (active) {
    report.status = "active"
    block("active-run", "流程正在执行或准备恢复，请查看当前进度。")
    return report
  }
  if (run.status === "complete") {
    report.status = "complete"
    block("already-complete", "本次流程已经结束，无需续跑。")
    return report
  }
  if (observation.authority !== "current")
    block("authority-unverified", "当前执行授权未确认，不能复用历史文本。")
  if (observation.definitionDigest !== run.flow.digest)
    block("definition-changed", "当前流程版本已变化或无法确认。")
  const prefix = run.attempts.filter(
    (attempt) =>
      run.flow.definition.steps.find((step) => step.id === attempt.stepId)?.kind === "agent" &&
      attempt.status === "passed"
  )
  const verified = observation.promptReceipts?.verifiedExecutionIds
  if (
    !prefix.length ||
    prefix.some((attempt) => !attempt.recoveryEvidence) ||
    !Array.isArray(verified) ||
    verified.length > 512 ||
    verified.some((id) => typeof id !== "string") ||
    new Set(verified).size !== verified.length ||
    prefix.some((attempt) => !verified.includes(attempt.executionId))
  )
    block("prompt-receipts-unverified", "缺少完整、当前有效的宿主文本执行证明。")
  for (const reason of observation.reasons?.slice(0, 64) ?? []) report.reasons.push({ ...reason })
  try {
    const ids = new Set(rows.map((row) => row.id))
    let suffix = 0
    let childRunId = `flow_${String(suffix).padStart(36, "0")}`
    while (ids.has(childRunId)) childRunId = `flow_${String(++suffix).padStart(36, "0")}`
    const planned = planFlowRecoveryReservation(
      rows,
      {
        schemaVersion: 1,
        sourceRunId: run.id,
        sourceDigest: report.sourceDigest,
        hostInactive: true,
        prefix
      },
      { childRunId, now }
    )
    report.consumedExecutions = planned.child.recovery!.inheritedExecutions
    report.remainingExecutions = Math.max(
      0,
      run.flow.definition.maxExecutions - report.consumedExecutions
    )
  } catch (error) {
    const code = error instanceof Error ? error.message : ""
    const reasons: Record<string, [string, string]> = {
      FLOW_RECOVERY_SOURCE_CONSUMED: [
        "source-consumed",
        "此来源已经用于恢复，请查看关联的新运行。"
      ],
      FLOW_RECOVERY_BUDGET_EXHAUSTED: [
        "budget-exhausted",
        "根流程的时间、执行次数或恢复次数预算已用完。"
      ],
      FLOW_RECOVERY_STATUS: ["stopped-run", "本次流程已停止，不允许续跑。"],
      FLOW_RECOVERY_UNKNOWN_EFFECT: ["unknown-effect", "存在未确认的调用结果，不能自动重放。"],
      FLOW_RECOVERY_HISTORY_LIMIT: ["history-limit", "保留完整恢复链所需的历史容量不足。"]
    }
    const [reason, message] = reasons[code] ?? [
      "history-not-reusable",
      "执行顺序、最终提交状态或父链证据不能证明安全续跑。"
    ]
    block(reason, message)
  }
  const eligible = report.reasons.length === 0
  report.status = eligible ? "eligible" : "blocked"
  for (const step of run.flow.definition.steps) {
    const attempt = run.attempts.find((row) => row.stepId === step.id)
    const item: FlowRecoveryPlan["steps"][number] = {
      stepId: step.id,
      name: step.name,
      disposition: "pending",
      reason: "尚未执行。",
      ...(attempt ? { executionId: attempt.executionId } : {})
    }
    if (!step.enabled) {
      item.disposition = "disabled"
      item.reason = "此步骤未启用。"
    } else if (attempt && prefix.includes(attempt)) {
      item.disposition = eligible ? "reusable" : "blocked"
      item.reason = eligible
        ? "宿主已核对文本执行证明；启动时仍需再次验证。"
        : "运行级验证未通过，暂不可复用。"
    } else if (
      attempt &&
      (step.kind === "approval" ||
        (step.kind === "check" &&
          ["passed", "failed"].includes(attempt.status) &&
          attempt.result?.source === "native-check"))
    ) {
      item.disposition = "recheck"
      item.reason = step.kind === "approval" ? "需要新的人工确认。" : "需要重新执行原生检查。"
    } else if (attempt) {
      item.disposition = "unknown"
      item.reason = "执行效果未确认，不能自动重放。"
    }
    if (eligible && step.enabled && item.disposition !== "reusable") report.nextStepId ??= step.id
    report.steps.push(item)
  }
  return report
}
