import type { BotEvent } from "../../shared/bot-types"
import type { BotRunHistoryEvent } from "../../shared/bot-run-history"

export const BOT_RUN_EVENT_KINDS = [
  "shell.queued",
  "shell.started",
  "shell.stop_requested",
  "shell.settled",
  "run.draining",
  "run.instruction_queued",
  "run.instruction_accepted",
  "run.instruction_boundary",
  "run.instruction_deferred",
  "run.queued",
  "run.started",
  "run.activity",
  "run.handoff",
  "run.waiting_peer",
  "run.peer_returned",
  "run.peer_updated",
  "run.peer_dispatch_wait",
  "run.computer_wait",
  "run.cancel_requested",
  "run.recovery_required",
  "run.settled",
  "run.reviewed",
  "run.plugin_turn",
  "interaction.requested",
  "interaction.answered",
  "effect.started",
  "effect.settled"
] as const
const states: Record<string, string> = {
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
  needs_review: "待核对",
  unknown: "结果待核对",
  cancelling: "正在停止",
  queued: "等待执行"
}
const labels: Record<(typeof BOT_RUN_EVENT_KINDS)[number], string> = {
  "shell.queued": "后台命令已接收",
  "shell.started": "后台命令开始运行",
  "shell.stop_requested": "收到命令停止请求",
  "shell.settled": "后台命令已返回",
  "run.draining": "收到新要求，等待当前操作回执",
  "run.instruction_queued": "收到补充要求",
  "run.instruction_accepted": "补充要求已进入任务",
  "run.instruction_boundary": "暂停尚未开始的操作，处理补充要求",
  "run.instruction_deferred": "补充要求转入下一项任务",
  "run.queued": "收到任务",
  "run.started": "开始执行",
  "run.activity": "执行进展",
  "run.handoff": "已委派协作任务",
  "run.waiting_peer": "等待协作结果",
  "run.peer_returned": "收到协作结果",
  "run.peer_updated": "回信已进入原任务",
  "run.peer_dispatch_wait": "协作消息等待原任务收口",
  "run.computer_wait": "等待归还浏览器",
  "run.cancel_requested": "收到停止请求",
  "run.recovery_required": "执行中断，等待人工核对",
  "run.settled": "任务结束",
  "run.reviewed": "人工核对完成",
  "run.plugin_turn": "插件处理结束",
  "interaction.requested": "等待用户处理",
  "interaction.answered": "已收到用户回复",
  "effect.started": "已批准，开始操作",
  "effect.settled": "操作已返回"
}

/** Explicit projection: checkpoints, raw provider data and approval answers are not event summaries. */
export function presentBotRunEvent(event: BotEvent): BotRunHistoryEvent {
  const data =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {}
  let label = labels[event.kind as keyof typeof labels] ?? "执行记录"
  let detail: string | null = null
  if (event.kind === "run.activity" && typeof data.description === "string")
    label = data.description.slice(0, 300)
  if (event.kind === "run.computer_wait" && data.waiting === false) label = "控制权已归还，继续任务"
  if (["run.settled", "effect.settled"].includes(event.kind) && typeof data.status === "string")
    label = `${event.kind === "run.settled" ? "任务" : "操作"}：${states[data.status] ?? "状态已更新"}`
  if (event.kind === "interaction.requested" && data.kind === "approval") label = "等待操作审批"
  if (event.kind === "interaction.requested" && data.kind === "question") label = "等待补充信息"
  if (event.kind === "interaction.answered") {
    if (data.kind === "approval" && data.decision === "approve")
      label =
        data.source === "auto-review"
          ? "独立审核已批准"
          : data.source === "rule"
            ? "按已保存规则批准"
            : "已批准操作"
    else if (data.kind === "approval" && data.decision === "reject")
      label = data.source === "rule" ? "按已保存规则拒绝" : "已拒绝操作"
    else if (data.kind === "question") label = "已补充信息"
  }
  if (event.kind === "run.reviewed") {
    label = data.decision === "resume" ? "人工核对后继续" : "人工核对后结束"
    if (typeof data.note === "string") detail = data.note.slice(0, 2000)
  }
  if (event.kind === "run.plugin_turn" && data.failed === true) label = "插件结束回调未完成"
  return {
    cursor: event.cursor,
    createdAt: event.createdAt,
    label,
    detail,
    ...(event.kind.startsWith("effect.") ? { effectId: event.entityId } : {}),
    ...(event.kind.startsWith("interaction.") ? { interactionId: event.entityId } : {})
  }
}
