import { describe, expect, it } from "vitest"
import type { BotSchedule } from "../../../shared/bots/contracts"
import { botSchedulePresentation, botScheduleReceipt } from "./bot-schedule-view"

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

describe("Bot schedule host receipts", () => {
  const call = { id: "call", name: "bot_schedule", args: { action: "save" } }
  const content = JSON.stringify(schedule)

  it("uses the returned identity and name, including restored text blocks", () => {
    const expected = { action: "save", id: "routine", name: "Review", created: true }
    expect(botScheduleReceipt(call, { content })).toEqual(expected)
    expect(botScheduleReceipt(call, { content: [{ type: "text", text: content }] })).toEqual(
      expected
    )
    expect(
      botScheduleReceipt(
        { ...call, args: { action: "save", id: "routine", name: "Model claim" } },
        { content }
      )
    ).toEqual({ ...expected, created: false })
    expect(
      botScheduleReceipt({ ...call, args: { action: "save", id: "different" } }, { content })
    ).toBeNull()
  })

  it("recognizes empty and valid lists, never arbitrary arrays or partial schedules", () => {
    const list = { ...call, args: { action: "list" } }
    for (const value of [[], [schedule]])
      expect(botScheduleReceipt(list, { content: JSON.stringify(value) })).toEqual({
        action: "list"
      })
    for (const value of [[{ id: "routine" }], [schedule, { error: "failed" }], [null]])
      expect(botScheduleReceipt(list, { content: JSON.stringify(value) })).toBeNull()
  })

  it("requires the exact deletion receipt and a real requested ID", () => {
    const remove = { ...call, args: { action: "remove", id: "routine" } }
    expect(botScheduleReceipt(remove, { content: "例行任务已删除，排队中的触发已取消。" })).toEqual(
      { action: "remove", id: "routine" }
    )
    expect(botScheduleReceipt(remove, { content: "此 Bot 中不存在该例行任务" })).toBeNull()
    expect(
      botScheduleReceipt(
        { ...call, args: { action: "remove" } },
        { content: "例行任务已删除，排队中的触发已取消。" }
      )
    ).toBeNull()
  })

  it("keeps errors, cancelled, malformed and unsupported receipts in the tool view", () => {
    expect(botScheduleReceipt(call, { content, is_error: true })).toBeNull()
    expect(botScheduleReceipt({ ...call, name: "other" }, { content })).toBeNull()
    expect(botScheduleReceipt({ ...call, args: { action: "unknown" } }, { content })).toBeNull()
    for (const value of [
      "创建或修改例行任务需要用户直接交办",
      "cancelled",
      "{}",
      JSON.stringify({ ...schedule, ok: false }),
      JSON.stringify({ ...schedule, version: 0 }),
      JSON.stringify({ ...schedule, botId: "../other" }),
      JSON.stringify({ ...schedule, name: "" }),
      JSON.stringify({ ...schedule, timezone: "" }),
      JSON.stringify({ ...schedule, nextRunAt: "invalid" })
    ])
      expect(botScheduleReceipt(call, { content: value })).toBeNull()
  })
})
