import type { GoalEvent, GoalSnapshot, GoalUiState } from "@/types"
import { formatGoalEventMessage } from "./goal-transcript"

export type GoalPanelViewModel = {
  goal: GoalSnapshot
  latestEvents: GoalEvent[]
  canPause: boolean
  canResume: boolean
  progressPercent: number
  contextText: string
  progressItems: string[]
  evidenceItems: string[]
  blockerItems: string[]
  hasLedgerDetails: boolean
  verdictLabel: string
  evaluatorReason: string
  recentEventSummary: string
}

export function goalVerdictLabel(verdict: string | null): string {
  if (verdict === "complete") return "完成"
  if (verdict === "continue") return "继续"
  if (verdict === "blocked") return "等待处理"
  return "尚未评估"
}

export function goalVerdictTone(verdict: string | null): string {
  if (verdict === "complete") return "border-emerald-200 bg-emerald-50/70 text-emerald-950"
  if (verdict === "blocked") return "border-amber-200 bg-amber-50/75 text-amber-950"
  if (verdict === "continue") return "border-blue-200 bg-blue-50/70 text-blue-950"
  return "border-border bg-muted/25 text-foreground"
}

export function goalEmptyDetail(status: "active" | "paused" | "complete"): string {
  if (status === "active") return "等待下一轮评估。Agent 仍在收集证据，完成后会更新这里。"
  if (status === "paused") return "暂停原因尚未写入。可以查看事件历史，或继续后让 evaluator 重新判断。"
  return "没有记录最近判断。"
}

export function cleanGoalEventText(message: string): string {
  return formatGoalEventMessage(message).replace(/^Goal\s*/, "Goal ").trim()
}

export function buildGoalPanelViewModel(goalUi: GoalUiState): GoalPanelViewModel | null {
  const goal = goalUi.goal
  if (!goal) return null

  const latestEvents = goalUi.events
    .filter((event) => event.goal_id === goal.goalId)
    .slice(-6)
    .reverse()
  const goalContext = goal.context ?? {}
  const contextText = [
    goalContext.transportSummary,
    goalContext.explicitSkill ? `显式技能：${goalContext.explicitSkill.name}` : null
  ]
    .filter(Boolean)
    .join(" · ")
  const progressItems = goal.ledger.progress
  const evidenceItems = goal.ledger.evidence
  const blockerItems = goal.ledger.blockers
  const reason =
    goal.status === "paused"
      ? goal.pausedReason || goal.lastReason
      : goal.status === "complete"
        ? goal.lastReason
        : goal.lastReason

  return {
    goal,
    latestEvents,
    canPause: goal.status === "active",
    canResume: goal.status === "paused",
    progressPercent:
      goal.maxTurns > 0 ? Math.min(100, Math.round((goal.turnsUsed / goal.maxTurns) * 100)) : 0,
    contextText,
    progressItems,
    evidenceItems,
    blockerItems,
    hasLedgerDetails:
      progressItems.length > 0 || evidenceItems.length > 0 || blockerItems.length > 0,
    verdictLabel: goalVerdictLabel(goal.lastVerdict),
    evaluatorReason: reason || goalEmptyDetail(goal.status),
    recentEventSummary: latestEvents[0] ? cleanGoalEventText(latestEvents[0].message) : "暂无事件"
  }
}
