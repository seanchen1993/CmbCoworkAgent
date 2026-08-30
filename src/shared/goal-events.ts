import { isGoalClearAlias, splitGoalTransportPayload } from "./goal-slash"

export const GOAL_USER_MESSAGE_EVENT_PREFIX = "__cmb_goal_user_message__:"
export const GOAL_UI_EVENT_LIMIT = 200
export const RUNTIME_RESTORED_GOAL_PAUSE_NOTICE =
  "Goal 已暂停：应用重启后已暂停。继续请发送 /goal resume。"

export const STALE_CHECKPOINT_BOUNDARY_NOTICE_PREFIXES = [
  "Goal 已暂停：恢复处理失败：",
  "Goal 已暂停：中断处理失败："
] as const

export const STALE_CHECKPOINT_BOUNDARY_NOTICE_MESSAGES = [
  RUNTIME_RESTORED_GOAL_PAUSE_NOTICE,
  "Goal 已暂停：已手动暂停。",
  "Goal 已暂停：你已取消当前运行。",
  "你发送了新消息，active goal 已暂停。需要继续时发送 /goal resume。",
  "Goal 已暂停：恢复处理已结束。需要继续 goal 时发送 /goal resume。",
  "Goal 已暂停：中断处理已结束。需要继续 goal 时发送 /goal resume。",
  "Goal 已暂停：中断请求已拒绝。需要继续 goal 时发送 /goal resume。",
  "Goal 已暂停：恢复处理被 Stop hook 阻止。需要继续时发送 /goal resume。",
  "Goal 已暂停：中断恢复被 Stop hook 阻止。需要继续时发送 /goal resume。",
  "Goal 已暂停：恢复处理被 Stop hook 停止。需要继续时发送 /goal resume。",
  "Goal 已暂停：中断处理被 Stop hook 停止。需要继续时发送 /goal resume。",
  "Goal 已清除。当前运行已终止。"
] as const

export function isGoalUserEventMessage(message: string): boolean {
  return message.trim().startsWith(GOAL_USER_MESSAGE_EVENT_PREFIX)
}

export function formatGoalUserEventMessage(message: string): string {
  const trimmed = message.trim()
  return trimmed.startsWith(GOAL_USER_MESSAGE_EVENT_PREFIX)
    ? trimmed.slice(GOAL_USER_MESSAGE_EVENT_PREFIX.length).trim()
    : trimmed
}

/**
 * Goal control events are persisted outside `thread_messages`, but some of
 * them restore a visible user bubble. Keep presence guards and the renderer on
 * the same definition so a restored `/goal` request cannot be mistaken for an
 * empty conversation.
 */
export function isVisibleGoalUserEventMessage(message: unknown): boolean {
  if (typeof message !== "string" || !isGoalUserEventMessage(message)) return false
  const { commandText } = splitGoalTransportPayload(formatGoalUserEventMessage(message))
  const trimmed = commandText.trim()
  if (!/^\/goal(?:\s|$)/i.test(trimmed)) return false

  const argument = trimmed.slice("/goal".length).trim().toLowerCase()
  return (
    argument !== "" &&
    argument !== "status" &&
    argument !== "pause" &&
    !isGoalClearAlias(argument)
  )
}

export function isStaleCheckpointBoundaryNoticeMessage(message: string): boolean {
  const trimmed = message.trim()
  return (
    STALE_CHECKPOINT_BOUNDARY_NOTICE_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) ||
    STALE_CHECKPOINT_BOUNDARY_NOTICE_MESSAGES.includes(
      trimmed as (typeof STALE_CHECKPOINT_BOUNDARY_NOTICE_MESSAGES)[number]
    )
  )
}
