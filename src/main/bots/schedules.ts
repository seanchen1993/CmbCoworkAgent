import type { BotRoutine } from "../../shared/bot-types"
import { BotDomainError } from "../../shared/bot-types"
import { computeNextRunAt, normalizeSchedule, parseCron } from "./upstream/grok-automation-schedule"
import * as v from "./validation"
import { botEventPolicy } from "../../shared/bot-event-state"

export function validateBotSchedule(input: unknown, timezone: string): BotRoutine["schedule"] {
  const schedule = v.record(input)
  v.text(timezone, "时区", 100)
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format()
  } catch {
    throw new BotDomainError("invalid_input", "无效时区")
  }
  if (schedule.kind === "once")
    return { kind: "once", at: v.integer(schedule.at, "运行时间", 1, 8_640_000_000_000_000) }
  if (schedule.kind === "interval")
    return {
      kind: "interval",
      anchor: v.integer(schedule.anchor, "首次时间", 1),
      everyMs: v.integer(schedule.everyMs, "间隔", 60_000, 366 * 86_400_000)
    }
  if (schedule.kind === "event") {
    const policy =
      schedule.eventPolicy === undefined
        ? undefined
        : botEventPolicy.safeParse(schedule.eventPolicy)
    if (policy && !policy.success)
      throw new BotDomainError("invalid_input", "事件处理模式或来源批次无效")
    return {
      kind: "event",
      topic: v.identifier(schedule.topic),
      ...(policy?.success ? { eventPolicy: policy.data } : {})
    }
  }
  if (schedule.kind === "cron") {
    const expression = normalizeSchedule(v.text(schedule.expression, "日历计划", 200))
    const field = /^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?(?:,(?:\*|\d+(?:-\d+)?)(?:\/\d+)?)*$/
    if (
      expression.split(" ").length !== 5 ||
      !expression.split(" ").every((value) => field.test(value)) ||
      !parseCron(expression)
    )
      throw new BotDomainError("invalid_input", "日历计划必须是有效的五段 cron 表达式")
    return { kind: "cron", expression }
  }
  throw new BotDomainError("invalid_input", "不支持此计划类型")
}

export function nextBotOccurrence(
  schedule: BotRoutine["schedule"],
  after: number,
  timezone: string
): number | null {
  if (schedule.kind === "event") return null
  if (schedule.kind === "once") return schedule.at > after ? schedule.at : null
  if (schedule.kind === "interval")
    return schedule.anchor > after
      ? schedule.anchor
      : schedule.anchor +
          (Math.floor((after - schedule.anchor) / schedule.everyMs) + 1) * schedule.everyMs
  return computeNextRunAt(schedule.expression, after, timezone)
}
