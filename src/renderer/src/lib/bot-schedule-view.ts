import type { BotSchedule } from "../../../shared/bots/contracts"
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
    if (tool.args.action === "remove")
      return value === "例行任务已删除，排队中的触发已取消。"
        ? { action: "remove", id: botIdentifier(tool.args.id) }
        : null
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
  if (schedule.enabled && schedule.nextRunAt)
    return { label: `下次：${new Date(schedule.nextRunAt).toLocaleString()}`, reschedule: false }
  const once = schedule.frequency === "once" && !schedule.enabled
  if (once && schedule.lastTriggeredAt)
    return { label: "已触发 · 结果见最近工作", reschedule: true }
  if (once && Date.parse(schedule.runAt ?? "") <= now)
    return { label: "执行时间已过", reschedule: true }
  return { label: "已暂停", reschedule: false }
}
