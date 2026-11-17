import type { BotWorkSummary } from "../../../../shared/bots/work"
import { splitBotInlineReasoning } from "../bot-inline-reasoning"

interface BotWorkStatusPresentation {
  label: string
  tone: "active" | "attention" | "complete" | "error" | "idle"
  icon: "running" | "queued" | "waiting" | "complete" | "alert" | "stopped" | "ready" | "idle"
  summary?: string
}

export function resolveBotWorkStatus(work: BotWorkSummary): BotWorkStatusPresentation {
  const { executionState, resultReviewState } = work

  if (work.deletionPending) return { label: "删除待完成", tone: "error", icon: "alert" }
  if (work.state === "completed") return { label: "已完成", tone: "complete", icon: "complete" }
  // An explicit user turn can still execute while automatic dispatch is stopped.
  if (executionState === "waiting_user") return { label: "等待你处理", tone: "attention", icon: "waiting" }
  if (executionState === "running") return { label: "正在处理", tone: "active", icon: "running" }
  if (executionState === "queued") return { label: "等待执行", tone: "idle", icon: "queued" }
  const uncertainOutcome = executionState === "outcome_unknown" || executionState === "interrupted"
  // A resumed review can verify saved results without rewriting the execution's history.
  const hasReviewUpdate = resultReviewState === "waiting" || resultReviewState === "checking" ||
    work.resultNeedsUser || work.resultConclusion?.unavailableDependency ||
    (!work.userControl && !!work.resultConclusion && work.resultConclusion.kind !== "reported")
  if (uncertainOutcome && (work.dispatchStopped || !hasReviewUpdate))
    return { label: "需要核对结果", tone: "error", icon: "alert" }
  if (work.dispatchStopped) {
    const label = work.backgroundBusy || work.pendingPeers > 0 ? "正在停止" : "已停止"
    return { label, tone: "idle", icon: "stopped" }
  }
  if (work.pendingPeers > 0) return { label: "协作中", tone: "active", icon: "idle" }
  if (work.resultNeedsUser)
    return { label: "成果需确认", tone: "attention", icon: "alert" }
  // Old/bounded receipts can retain a leading, even truncated, reasoning block.
  // Use the same visible body as Bot chat without rewriting the saved result.
  const summary = work.resultConclusion ? splitBotInlineReasoning(work.resultConclusion.summary).body : undefined
  if (work.resultConclusion?.unavailableDependency)
    return { label: "成果待核对", tone: "attention", icon: "alert", summary }
  const blockedSummary = !work.userControl && work.resultConclusion?.kind === "blocked"
    ? { summary } : {}
  const deliveredWithServices = !work.userControl && work.resultConclusion?.kind === "ready" &&
    work.resultConclusion.backgroundServicesOnly === true
  if (work.backgroundBusy && !work.readyServiceState && !deliveredWithServices)
    return { label: "后台处理中", tone: "active", icon: "idle", ...blockedSummary }
  if (resultReviewState === "checking") return { label: "正在整理结果", tone: "active", icon: "running" }
  if (resultReviewState === "waiting") return { label: "等待回传", tone: "idle", icon: "queued" }
  if (resultReviewState === "interrupted") return { label: "回传已中断", tone: "error", icon: "alert" }
  if (work.userControl && work.userControl.heldInputs > 0)
    return { label: "等待归还", tone: "idle", icon: "queued" }
  if (work.resultConclusion && !work.userControl && (executionState === "completed" || uncertainOutcome ||
      (executionState === "failed" && work.resultConclusion.kind === "ready"))) {
    const { kind } = work.resultConclusion
    if (kind === "reported") return { label: "结果已回传", tone: "idle", icon: "idle", summary }
    return kind === "ready"
      ? { label: "成果已就绪", tone: "complete", icon: "ready", summary }
      : { label: "成果待核对", tone: "attention", icon: "alert", summary }
  }
  if (work.readyServiceState === "result_ready")
    return { label: "成果已就绪", tone: "complete", icon: "ready" }
  // A turn can complete silently or produce no visible reply.
  if (executionState === "completed") return { label: "本轮已结束", tone: "idle", icon: "idle" }
  if (executionState === "failed") return { label: "执行失败", tone: "error", icon: "alert", ...blockedSummary }
  if (executionState === "cancelled") return { label: "已停止", tone: "idle", icon: "stopped" }
  return { label: "空闲", tone: "idle", icon: "idle" }
}
