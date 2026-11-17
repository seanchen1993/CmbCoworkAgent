import type { BotWorkSummary } from "../../../shared/bots/work"

export function botWorkStatus(work: BotWorkSummary): string {
  if (work.state === "completed") return "已完成"
  if (work.execution && work.execution.phase !== "unavailable") {
    if (work.execution.phase === "idle") return "已回复"
    return work.execution.label
  }
  if (work.executionState === "waiting_user") return "等待你处理"
  if (work.executionState === "running") return "正在处理"
  if (work.pendingPeers) return "协作中"
  if (work.backgroundBusy) return "后台处理中"
  if (work.executionState === "queued") return "等待执行"
  if (work.executionState === "completed") return "已回复"
  if (work.executionState === "failed") return "执行失败"
  if (work.executionState === "cancelled") return "已停止"
  if (work.executionState === "outcome_unknown" || work.executionState === "interrupted")
    return "需要核对结果"
  return "待处理"
}
