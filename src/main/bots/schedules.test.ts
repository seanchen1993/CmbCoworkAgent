import { expect, it } from "vitest"
import { nextBotOccurrence, validateBotSchedule } from "./schedules"
import { BotStore } from "./store"

it("uses the Grok calendar implementation for weekdays and timezone-dependent wall time", () => {
  const schedule = validateBotSchedule({ kind: "cron", expression: "0 9 * * 1-5" }, "Asia/Shanghai")
  expect(
    new Date(
      nextBotOccurrence(schedule, Date.parse("2026-10-02T02:00:00Z"), "Asia/Shanghai")!
    ).toISOString()
  ).toBe("2026-10-05T01:00:00.000Z")
  const daily = validateBotSchedule({ kind: "cron", expression: "0 9 * * *" }, "America/New_York")
  expect(
    new Date(
      nextBotOccurrence(daily, Date.parse("2026-03-07T15:00:00Z"), "America/New_York")!
    ).toISOString()
  ).toBe("2026-03-08T13:00:00.000Z")
  expect(() => validateBotSchedule({ kind: "cron", expression: "0 9 1-2-3 * *" }, "UTC")).toThrow()
  expect(() => validateBotSchedule({ kind: "cron", expression: "0 9 * * *" }, "bad/zone")).toThrow()
})

it("preserves the next occurrence when editing a running routine and deduplicates local events", () => {
  let now = Date.parse("2026-09-30T00:00:00Z")
  const store = new BotStore(":memory:", () => now)
  try {
    const { bot } = store.createBot({ nonce: "create", name: "定时助手" })
    const first = store.saveRoutine({
      botId: bot.id,
      name: "日检",
      prompt: "检查",
      schedule: { kind: "cron", expression: "0 9 * * *" },
      timezone: "Asia/Shanghai",
      enabled: true
    })
    now += 2 * 3600_000
    const edit = store.saveRoutine({ ...first, name: "每日检查" })
    expect(edit.nextAt).toBe(first.nextAt)
    expect(store.dispatchDueRoutines()).toHaveLength(1)
    now += 86_400_000
    expect(store.dispatchDueRoutines()).toEqual([]) // prior occurrence remains queued; no pile-up
    store.saveRoutine({
      botId: bot.id,
      name: "构建事件",
      prompt: "检查事件",
      schedule: { kind: "event", topic: "build.failed" },
      timezone: "UTC",
      enabled: true
    })
    const input = { nonce: "event-1", topic: "build.failed", payload: '{"build":42}' }
    const event = store.emitEvent(input)
    expect(event.runIds).toHaveLength(1)
    expect(store.emitEvent(input)).toEqual(event)
    expect(() => store.emitEvent({ ...input, payload: "changed" })).toThrow("同一请求标识")
  } finally {
    store.close()
  }
})
