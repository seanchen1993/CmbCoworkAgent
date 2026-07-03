export const GOAL_WAITING_FOR_USER_INPUT_REASON_PREFIX = "needs_user_input:"

const INTERNAL_PAUSED_REASON_LABELS: Record<string, string> = {
  "user-paused": "已手动暂停。",
  "user-cancelled": "你已取消当前运行。",
  "user message preempted active goal": "你发送了新消息，active goal 已暂停。需要继续时发送 /goal resume。",
  "runtime restored active goal": "应用重启后已暂停。继续请发送 /goal resume。",
  WORKSPACE_REQUIRED: "需要先选择工作区。",
  "UserPromptSubmit hook stopped the turn.": "UserPromptSubmit Hook 已阻止本轮执行。",
  "UserPromptSubmit hook stopped goal continuation.": "UserPromptSubmit Hook 已阻止 Goal 续跑。",
  "Stop hook blocked completion.": "Stop Hook 已阻止本轮完成。",
  "Stop hook halted the turn.": "Stop Hook 已停止本轮执行。",
  "Agent run was aborted.": "Agent 运行已中止。",
  "Goal paused because the last turn produced no assistant response or tool evidence.":
    "上一轮没有产生可见回复或工具证据，Goal 已暂停。",
  "Goal evaluator model is not configured.": "Goal 评估器模型未配置。"
}

export function displayGoalPausedReason(reason: string | null | undefined): string {
  const value = (reason || "").trim()
  if (value.startsWith(GOAL_WAITING_FOR_USER_INPUT_REASON_PREFIX)) {
    return value.slice(GOAL_WAITING_FOR_USER_INPUT_REASON_PREFIX.length).trim()
  }
  const invalidJsonMatch = value.match(/^Evaluator returned invalid JSON (\d+) turns in a row\.$/)
  if (invalidJsonMatch) {
    return `评估器连续 ${invalidJsonMatch[1]} 轮输出格式无效。`
  }
  const budgetMatch = value.match(/^Turn budget exhausted \((\d+)\/(\d+)\)\.$/)
  if (budgetMatch) {
    return `轮次预算已用尽（${budgetMatch[1]}/${budgetMatch[2]}）。`
  }
  if (value === "Turn budget exhausted.") return "轮次预算已用尽。"
  if (value.startsWith("Agent run failed:")) {
    return `Agent 运行失败：${value.slice("Agent run failed:".length).trim()}`
  }
  return INTERNAL_PAUSED_REASON_LABELS[value] ?? value
}
