import type { BotSchedule } from "../../../shared/bots/contracts"

export function botSchedulePresentation(schedule: BotSchedule, now = Date.now()) {
  if (schedule.enabled && schedule.nextRunAt)
    return { label: `下次：${new Date(schedule.nextRunAt).toLocaleString()}`, reschedule: false }
  const once = schedule.frequency === "once" && !schedule.enabled
  if (once && schedule.lastTriggeredAt)
    return { label: "已触发 · 结果见最近工作", reschedule: true }
  if (once && Date.parse(schedule.runAt ?? "") <= now)
    return { label: "执行时间已过", reschedule: true }
  return { label: "已暂停", reschedule: false }
}
