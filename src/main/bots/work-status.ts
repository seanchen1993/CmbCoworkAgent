import type { BotWorkSummary } from "../../shared/bots/work"
import type { BotWorkExecutionStatus, BotWorkRuntimeState } from "../../shared/bots/work-status"

const LABELS: Record<BotWorkExecutionStatus["phase"], string> = {
  not_started: "尚未开始", queued: "等待执行", running: "正在执行",
  waiting_user_input: "等待用户回答", waiting_approval: "等待审批",
  waiting_browser: "等待浏览器接管", waiting_interaction: "等待用户操作",
  background: "后台工作进行中", waiting_dependencies: "等待协作结果",
  idle: "本轮已结束，当前未运行", failed: "执行失败", cancelled: "已停止",
  interrupted: "执行已中断", outcome_unknown: "执行结果未确认", unavailable: "无法确认当前运行状态"
}

export function projectBotWorkStatus(
  work: BotWorkSummary,
  runtime: BotWorkRuntimeState | undefined,
  hostActive: boolean,
  browserInstruction?: string,
  observedAt = Date.now()
): BotWorkExecutionStatus {
  const runActive = hostActive ? true : runtime?.available ? runtime.runActive : null
  const waitingFor: BotWorkExecutionStatus["waitingFor"] = []
  if (runtime?.available && runtime.userInput.count) waitingFor.push({ kind: "user_input", ...runtime.userInput })
  if (runtime?.available && runtime.approval) waitingFor.push({ kind: "approval" })
  if (browserInstruction !== undefined) waitingFor.push({ kind: "browser", instruction: browserInstruction.slice(0, 600) })
  if (!waitingFor.length && runActive && work.executionState === "waiting_user") waitingFor.push({ kind: "interaction" })
  const background = {
    commands: Boolean(runtime?.available && runtime.commands),
    workflow: Boolean(runtime?.available && runtime.workflow),
    workers: Boolean(runtime?.available && runtime.workers),
    pendingResults: work.backgroundBusy || Boolean(runtime?.available && runtime.pendingResults)
  }
  let phase: BotWorkExecutionStatus["phase"]
  const waiting = waitingFor[0]?.kind
  const last = work.lastExecution?.state ?? work.executionState
  if (waiting) phase = waiting === "user_input" ? "waiting_user_input" : `waiting_${waiting}`
  else if (runActive) phase = "running"
  else if (Object.values(background).some(Boolean)) phase = "background"
  else if (work.pendingPeers > 0) phase = "waiting_dependencies"
  else if (work.executionState === "queued") phase = "queued"
  else if (!runtime?.available || (!runtime.threadExists && last !== null)) phase = "unavailable"
  else if (last === "running" || last === "waiting_user") phase = "interrupted"
  else if (last === "failed" || last === "cancelled" || last === "interrupted" || last === "outcome_unknown") phase = last
  else phase = last === null ? "not_started" : "idle"
  return {
    observedAt, businessState: work.state, phase, label: LABELS[phase], runActive,
    waitingFor, pendingPeers: work.pendingPeers, background, lastExecution: work.lastExecution ?? null
  }
}
