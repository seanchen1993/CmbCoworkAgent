import type { BotRoutine } from "../../../shared/bot-types"
import { botEventPolicy } from "../../../shared/bot-event-state"
import { serializeRoutineCalendar } from "../components/bots/upstream/grok-routine-schedule"

export type RoutineScheduleKind =
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "interval"
  | "once"
  | "cron"
  | "event"

export interface RoutineScheduleDraft {
  kind: RoutineScheduleKind
  time: string
  minute: string
  day: string
  monthDay: string
  amount: string
  unit: "minutes" | "hours" | "days"
  at: string
  expression: string
  topic: string
  eventMode: "every-event" | "latest-state"
  sourceEpoch: string
}

function localDateTime(at: number): string {
  const value = new Date(at)
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
}

/** Only recognize lossless presets; arbitrary saved expressions remain custom. */
export function routineScheduleDraft(schedule?: BotRoutine["schedule"]): RoutineScheduleDraft {
  const draft: RoutineScheduleDraft = {
    kind: "daily",
    time: "09:00",
    minute: "0",
    day: "1",
    monthDay: "1",
    amount: "24",
    unit: "hours",
    at: "",
    expression: "0 9 * * *",
    topic: "",
    eventMode: "every-event",
    sourceEpoch: ""
  }
  if (!schedule) return draft
  draft.kind = schedule.kind
  if (schedule.kind === "once") draft.at = localDateTime(schedule.at)
  if (schedule.kind === "event") {
    draft.topic = schedule.topic
    draft.eventMode = schedule.eventPolicy?.mode ?? "every-event"
    draft.sourceEpoch = schedule.eventPolicy?.sourceEpoch ?? ""
  }
  if (schedule.kind === "interval") {
    draft.unit = schedule.everyMs % 3_600_000 === 0 ? "hours" : "minutes"
    draft.amount = String(schedule.everyMs / (draft.unit === "hours" ? 3_600_000 : 60_000))
  }
  if (schedule.kind === "cron") {
    draft.expression = schedule.expression
    const [minute, hour, dom, month, dow] = schedule.expression.split(" ")
    if (/^\d+$/.test(minute) && month === "*") {
      draft.minute = minute
      if (hour === "*" && dom === "*" && dow === "*") draft.kind = "hourly"
      if (/^\d+$/.test(hour)) {
        draft.time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
        if (dom === "*") {
          if (dow === "*") draft.kind = "daily"
          else if (dow === "1-5") draft.kind = "weekdays"
          else if (/^[0-6]$/.test(dow)) {
            draft.kind = "weekly"
            draft.day = dow
          }
        } else if (/^\d+$/.test(dom) && dow === "*") {
          draft.kind = "monthly"
          draft.monthDay = dom
        }
      }
    }
  }
  return draft
}

const unitMs = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }
const integer = (value: string, min: number, max: number, label: string): number => {
  const number = Number(value)
  if (!value.trim() || !Number.isInteger(number) || number < min || number > max)
    throw new Error(`${label}应为 ${min}～${max} 的整数`)
  return number
}

export function saveRoutineSchedule(
  draft: RoutineScheduleDraft,
  previous?: BotRoutine["schedule"],
  now = Date.now()
): BotRoutine["schedule"] {
  // Keep exact milliseconds, interval anchor and custom cron spelling on unrelated edits.
  if (previous && JSON.stringify(draft) === JSON.stringify(routineScheduleDraft(previous)))
    return previous
  if (draft.kind === "event") {
    const policy =
      draft.eventMode === "latest-state"
        ? botEventPolicy.safeParse({ mode: draft.eventMode, sourceEpoch: draft.sourceEpoch.trim() })
        : undefined
    if (policy && !policy.success)
      throw new Error("请填写有效来源批次，仅使用字母、数字、下划线、点、冒号或连字符")
    return {
      kind: "event",
      topic: draft.topic.trim(),
      ...(policy?.success ? { eventPolicy: policy.data } : {})
    }
  }
  if (draft.kind === "cron") return { kind: "cron", expression: draft.expression.trim() }
  if (draft.kind === "once") {
    const at = new Date(draft.at).getTime()
    if (
      !Number.isFinite(at) ||
      localDateTime(at) !== (draft.at.length === 16 ? `${draft.at}:00` : draft.at)
    )
      throw new Error("请选择有效的运行时间；夏令时跳过的时刻不可用")
    return { kind: "once", at }
  }
  if (draft.kind === "interval") {
    const everyMs = Number(draft.amount) * unitMs[draft.unit]
    if (!Number.isSafeInteger(everyMs) || everyMs < 60_000 || everyMs > 366 * 86_400_000)
      throw new Error("执行间隔应在 1 分钟到 366 天之间")
    return {
      kind: "interval",
      everyMs,
      anchor:
        previous?.kind === "interval" && previous.everyMs === everyMs
          ? previous.anchor
          : now + everyMs
    }
  }
  if (draft.kind === "hourly")
    return {
      kind: "cron",
      expression: serializeRoutineCalendar({
        mode: "hourly",
        minute: integer(draft.minute, 0, 59, "分钟")
      })
    }
  const parts = /^(\d{2}):(\d{2})$/.exec(draft.time)
  if (!parts) throw new Error("请选择执行时间")
  const time = { hour: integer(parts[1], 0, 23, "小时"), minute: integer(parts[2], 0, 59, "分钟") }
  return {
    kind: "cron",
    expression: serializeRoutineCalendar(
      draft.kind === "weekly"
        ? { mode: "weekly", time, dayOfWeek: integer(draft.day, 0, 6, "星期") }
        : draft.kind === "monthly"
          ? { mode: "monthly", time, dayOfMonth: integer(draft.monthDay, 1, 31, "日期") }
          : { mode: draft.kind, time }
    )
  }
}

const scheduleTextLimit = 120
const boundedScheduleText = (value: string): string =>
  value.length > scheduleTextLimit ? `${value.slice(0, scheduleTextLimit)}…` : value

/** Describe the saved plan without calculating a next run or changing its spelling. */
export function formatRoutineSchedule(schedule: BotRoutine["schedule"], timezone: string): string {
  if (schedule.kind === "event")
    return `事件触发：${boundedScheduleText(schedule.topic)}${schedule.eventPolicy ? " · 最新状态" : ""}`
  if (schedule.kind === "once")
    return `仅一次：${new Date(schedule.at).toLocaleString(undefined, {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      ...(schedule.at % 1000 === 0 ? {} : { fractionalSecondDigits: 3 })
    })}`
  if (schedule.kind === "interval") {
    // Preserve exact elapsed milliseconds, including saved non-minute intervals.
    const units = [
      [86_400_000, "天"],
      [3_600_000, "小时"],
      [60_000, "分钟"],
      [1000, "秒"]
    ] as const
    const [unitMs, label] = units.find(([unitMs]) => schedule.everyMs % unitMs === 0) ?? units[3]
    return `每 ${schedule.everyMs / unitMs} ${label}`
  }
  const draft = routineScheduleDraft(schedule)
  switch (draft.kind) {
    case "hourly":
      return `每小时第 ${Number(draft.minute)} 分钟`
    case "daily":
      return `每天 ${draft.time}`
    case "weekdays":
      return `每星期一至星期五 ${draft.time}`
    case "weekly":
      return `每星期${"日一二三四五六"[Number(draft.day)]} ${draft.time}`
    case "monthly":
      return `每月 ${Number(draft.monthDay)} 日 ${draft.time}`
    default:
      return `自定义 cron：${boundedScheduleText(schedule.expression)}`
  }
}
