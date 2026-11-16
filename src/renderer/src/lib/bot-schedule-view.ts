import type { BotSchedule } from "../../../shared/bots/contracts"
import type { BotWorkScheduleMonitorInput } from "../../../shared/bots/schedule-observation"
import { botIdentifier, parseExistingVersion, parseSchedule } from "../../../shared/bots/validation"
import type { ToolCall, ToolResult } from "@/types"

type ScheduleReceipt =
  | { action: "list" }
  | { action: "save"; id: string; name: string; created: boolean }
  | { action: "remove"; id: string }

/** Presentation only: a requested mutation is not evidence that it succeeded. */
export function botScheduleReceipt(
  tool: ToolCall,
  result: Pick<ToolResult, "content" | "is_error">
): ScheduleReceipt | null {
  if (tool.name !== "bot_schedule" || result.is_error) return null
  try {
    let value = result.content
    if (
      Array.isArray(value) &&
      value.length &&
      value.every((part) => part?.type === "text" && typeof part.text === "string")
    )
      value = value.map((part) => part.text).join("")
    if (tool.args.action === "remove") {
      if (
        value !== "例行任务已删除，尚未开始的排队触发已取消。已开始的执行按原约定结算。" &&
        value !== "例行任务已删除，排队中的触发已取消。"
      )
        return null
      return { action: "remove", id: botIdentifier(tool.args.id) }
    }
    if (typeof value === "string") value = JSON.parse(value)
    const schedule = (input: unknown) => {
      // Reuse the same shape validation as schedule creation and editing.
      const config = parseSchedule(input)
      const identity = parseExistingVersion(input)!
      const item = input as Record<string, unknown>
      botIdentifier(item.botId)
      if (
        item.ok === false ||
        typeof item.timezone !== "string" ||
        !item.timezone.trim() ||
        !(
          item.nextRunAt === null ||
          (typeof item.nextRunAt === "string" && Number.isFinite(Date.parse(item.nextRunAt)))
        )
      )
        throw new Error("Invalid schedule receipt")
      return { ...identity, name: config.name }
    }
    if (tool.args.action === "list") {
      if (!Array.isArray(value) || value.length > 200) return null
      value.forEach(schedule)
      return { action: "list" }
    }
    if (tool.args.action !== "save") return null
    const saved = schedule(value)
    if (tool.args.id !== undefined && tool.args.id !== saved.id) return null
    return { action: "save", id: saved.id, name: saved.name, created: tool.args.id === undefined }
  } catch {
    // Plain error text can arrive without is_error from compatibility wrappers.
    // Keep it, malformed receipts and unsupported actions in the normal tool UI.
    return null
  }
}

export function botSchedulePresentation(schedule: BotSchedule, now = Date.now()) {
  if (schedule.pendingOccurrenceId) return { label: "已入队，等待执行", reschedule: false }
  if (schedule.enabled && schedule.nextRunAt) {
    const expiresAt = schedule.workMonitor?.expiresAt ?? schedule.fixedReminder?.expiresAt
    if (expiresAt && Date.parse(schedule.nextRunAt) >= Date.parse(expiresAt))
      return { label: `将在 ${new Date(expiresAt).toLocaleString()} 结束`, reschedule: false }
    return { label: `下次：${new Date(schedule.nextRunAt).toLocaleString()}`, reschedule: false }
  }
  if (schedule.workUnavailable) {
    const expired = schedule.frequency === "once" && Date.parse(schedule.runAt ?? "") <= now
    return { label: "原任务不可用，例行已暂停", reschedule: expired }
  }
  if (schedule.workMonitor?.ended) {
    const labels = { condition: "已确认工作标记为完成", expired: "已过期，未继续观察", unavailable: "原任务不可用，观察已暂停" }
    return { label: labels[schedule.workMonitor.ended], reschedule: false }
  }
  if (schedule.fixedReminder?.ended === "expired")
    return { label: "已错过，提醒已过期", reschedule: false }
  if (schedule.fixedReminder && schedule.lastTriggeredAt)
    return { label: "提醒已触发", reschedule: true }
  const once = schedule.frequency === "once" && !schedule.enabled
  if (once && schedule.lastTriggeredAt)
    return { label: schedule.desktopWork ? "已触发" : "已触发 · 结果见最近工作", reschedule: true }
  if (once && Date.parse(schedule.runAt ?? "") <= now)
    return { label: "执行时间已过", reschedule: true }
  return { label: "已暂停", reschedule: false }
}

export function botWorkMonitorLabel(schedule: BotSchedule): string | undefined {
  const mode = schedule.workMonitor?.mode
  return mode && botWorkMonitorModeLabel(mode)
}

export function botWorkMonitorModeLabel(mode: BotWorkScheduleMonitorInput["mode"]): string {
  return {
    report: "每次报告任务进展", change: "任务进展有变化时通知",
    new_result: "执行产生新结果时通知", until_work_completed: "用户标记工作完成时通知一次"
  }[mode]
}
