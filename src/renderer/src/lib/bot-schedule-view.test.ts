import { describe, expect, it } from "vitest"
import type { BotSchedule } from "../../../shared/bots/contracts"
import { botSchedulePresentation } from "./bot-schedule-view"

const schedule: BotSchedule = {
  id: "routine",
  botId: "bot",
  version: 1,
  name: "Review",
  message: "Review",
  frequency: "once",
  enabled: false,
  nextRunAt: null,
  timezone: "UTC",
  runAt: "2030-01-01T00:00:00Z"
}
describe("Bot schedule presentation", () => {
  it("distinguishes a queued trigger from paused work without claiming completion", () => {
    expect(botSchedulePresentation({ ...schedule, lastTriggeredAt: schedule.runAt })).toEqual({
      label: "已触发 · 结果见最近工作",
      reschedule: true
    })
    expect(botSchedulePresentation(schedule, Date.parse("2029-01-01"))).toEqual({
      label: "已暂停",
      reschedule: false
    })
  })
  it("requires a new date for expired legacy schedules without inventing an execution receipt", () => {
    expect(botSchedulePresentation(schedule, Date.parse("2031-01-01"))).toEqual({
      label: "执行时间已过",
      reschedule: true
    })
    expect(
      botSchedulePresentation({ ...schedule, frequency: "daily", lastTriggeredAt: schedule.runAt })
        .reschedule
    ).toBe(false)
  })
})
