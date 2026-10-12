import { afterEach, expect, it, vi } from "vitest"
import {
  formatRoutineSchedule,
  routineScheduleDraft,
  saveRoutineSchedule
} from "./bot-routine-draft"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { BotRoutineCard } from "@/components/bots/BotRoutineCard"
import {
  acknowledgePendingRoutine,
  isDefinitiveRoutineSaveError,
  readPendingRoutine,
  rememberPendingRoutine
} from "./bot-routine-pending"
import type { BotRoutine } from "../../../shared/bot-types"

afterEach(() => vi.unstubAllGlobals())

it("keeps unknown and transport failures recoverable but recognizes explicit save rejection", () => {
  expect(isDefinitiveRoutineSaveError({ code: "revision_conflict" })).toBe(true)
  expect(isDefinitiveRoutineSaveError({ code: "skill_changed" })).toBe(true)
  for (const error of [
    new Error("Connection lost"),
    { code: "timeout" },
    { code: "future_error" },
    null
  ])
    expect(isDefinitiveRoutineSaveError(error)).toBe(false)
})

it("preserves arbitrary cron, interval anchors and one-off milliseconds on content-only edits", () => {
  const schedules: BotRoutine["schedule"][] = [
    { kind: "cron", expression: "*/17 3,9,23 2-25/3 1,4,7 *" },
    { kind: "cron", expression: "05 09 * * 7" },
    { kind: "cron", expression: "15 9 31 * *" },
    { kind: "cron", expression: "15 * * * *" },
    { kind: "interval", anchor: 1_700_000_001_237, everyMs: 61_001 },
    { kind: "once", at: 1_700_000_001_237 },
    { kind: "event", topic: "project.changed" },
    {
      kind: "event",
      topic: "object.updated",
      eventPolicy: { mode: "latest-state", sourceEpoch: "orders-v1" }
    }
  ]
  for (const schedule of schedules)
    expect(saveRoutineSchedule(routineScheduleDraft(schedule), schedule)).toEqual(schedule)
  expect(routineScheduleDraft(schedules[0]).kind).toBe("cron")
  expect(routineScheduleDraft(schedules[2]).kind).toBe("monthly")
  expect(routineScheduleDraft(schedules[3]).kind).toBe("hourly")
})

it("requires explicit source epoch for latest state and keeps every-event saves backward compatible", () => {
  const draft = routineScheduleDraft({ kind: "event", topic: "object.updated" })
  expect(saveRoutineSchedule(draft)).toEqual({ kind: "event", topic: "object.updated" })
  expect(() => saveRoutineSchedule({ ...draft, eventMode: "latest-state" })).toThrow("来源批次")
  const selected = { ...draft, eventMode: "latest-state" as const, sourceEpoch: "orders-v2" }
  const schedule = saveRoutineSchedule(selected)
  expect(schedule).toEqual({
    kind: "event",
    topic: "object.updated",
    eventPolicy: { mode: "latest-state", sourceEpoch: "orders-v2" }
  })
  expect(formatRoutineSchedule(schedule, "UTC")).toContain("最新状态")
  expect(
    saveRoutineSchedule({ ...routineScheduleDraft(schedule), eventMode: "every-event" })
  ).toEqual({ kind: "event", topic: "object.updated" })
})

it("changes calendar presets using Grok serialization without shifting equal elapsed intervals", () => {
  const previous = { kind: "interval" as const, anchor: 1_700_000_000_000, everyMs: 86_400_000 }
  const draft = routineScheduleDraft(previous)
  expect(
    saveRoutineSchedule({ ...draft, amount: "1", unit: "days" }, previous, 2_000_000_000_000)
  ).toEqual(previous)
  expect(
    saveRoutineSchedule({ ...draft, amount: "2", unit: "hours" }, previous, 2_000_000_000_000)
  ).toEqual({ kind: "interval", anchor: 2_000_007_200_000, everyMs: 7_200_000 })
  expect(saveRoutineSchedule({ ...draft, kind: "monthly", monthDay: "31", time: "16:25" })).toEqual(
    { kind: "cron", expression: "25 16 31 * *" }
  )
  expect(saveRoutineSchedule({ ...draft, kind: "weekly", day: "0", time: "16:25" })).toEqual({
    kind: "cron",
    expression: "25 16 * * 0"
  })
  expect(() => saveRoutineSchedule({ ...draft, amount: "0" })).toThrow("执行间隔")
  expect(() => saveRoutineSchedule({ ...draft, kind: "once", at: "2026-02-31T09:00:00" })).toThrow(
    "有效"
  )
  expect(() => saveRoutineSchedule({ ...draft, kind: "daily", time: "25:00" })).toThrow("小时")
})

it("retains the exact pending save and fences it from another Bot, restored database and later request", () => {
  const items = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key)
  })
  const input = {
    nonce: "save",
    expectedDataEpoch: "epoch",
    botId: "bot",
    name: "巡检",
    prompt: "检查项目",
    timezone: "UTC",
    enabled: true,
    skills: [{ botId: "bot", id: "skill", version: 7 }],
    schedule: { kind: "interval" as const, everyMs: 60_000, anchor: 1_700_000_000_000 }
  }
  rememberPendingRoutine(input, "epoch")
  expect(readPendingRoutine("bot", undefined, "epoch")).toEqual(input)
  expect(readPendingRoutine("bot", undefined, "restored")).toBeNull()
  expect(readPendingRoutine("other", undefined, "epoch")).toBeNull()
  const newer = { ...input, nonce: "newer" }
  expect(() => rememberPendingRoutine(newer, "epoch")).toThrow("尚未确认")
  // Another accepted editor generation may occupy the key; the old ACK must not remove it.
  items.set("bot-routine-pending:bot:new", JSON.stringify({ dataEpoch: "epoch", input: newer }))
  expect(acknowledgePendingRoutine(input, "epoch")).toBe(false)
  expect(readPendingRoutine("bot", undefined, "epoch")).toEqual(newer)
  acknowledgePendingRoutine(newer, "epoch")
  expect(items.size).toBe(0)
  items.set(
    "bot-routine-pending:bot:new",
    JSON.stringify({ dataEpoch: "epoch", input: { ...input, botId: "other" } })
  )
  expect(readPendingRoutine("bot", undefined, "epoch")).toBeNull()
  items.set("bot-routine-pending:bot:new", "{".repeat(400_001))
  expect(readPendingRoutine("bot", undefined, "epoch")).toBeNull()
})

it("does not submit without a recoverable request when browser storage is full", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem() {
      throw new Error("QuotaExceededError")
    }
  })
  const input = {
    nonce: "save",
    expectedDataEpoch: "epoch",
    botId: "bot",
    name: "巡检",
    prompt: "检查项目",
    timezone: "UTC",
    enabled: true,
    schedule: { kind: "interval" as const, everyMs: 60_000, anchor: 1_700_000_000_000 }
  }
  expect(() => rememberPendingRoutine(input, "epoch")).toThrow("尚未提交")
})

it("describes lossless calendar presets and retains unsupported cron spelling", () => {
  const plans = [
    ["15 * * * *", "每小时第 15 分钟"],
    ["5 9 * * *", "每天 09:05"],
    ["5 9 * * 1-5", "每星期一至星期五 09:05"],
    ["0 12 * * 0", "每星期日 12:00"],
    ["25 16 31 * *", "每月 31 日 16:25"]
  ]
  for (const [expression, expected] of plans)
    expect(formatRoutineSchedule({ kind: "cron", expression }, "Asia/Shanghai")).toBe(expected)
  for (const expression of ["*/17 3,9,23 2-25/3 1,4,7 *", "05 09 * * 7"])
    expect(formatRoutineSchedule({ kind: "cron", expression }, "UTC")).toBe(
      `自定义 cron：${expression}`
    )
  const expression = "* ".repeat(80)
  expect(formatRoutineSchedule({ kind: "cron", expression }, "UTC")).toBe(
    `自定义 cron：${expression.slice(0, 120)}…`
  )
})

it("formats one-off timestamps in the saved timezone with exact milliseconds", () => {
  const schedule = { kind: "once" as const, at: Date.UTC(2026, 9, 11, 12, 0, 1, 237) }
  expect(formatRoutineSchedule(schedule, "UTC")).toContain("12:00:01")
  expect(formatRoutineSchedule(schedule, "UTC")).toContain("237")
  expect(formatRoutineSchedule(schedule, "Asia/Shanghai")).toContain("20:00:01")
  expect(formatRoutineSchedule(schedule, "UTC")).toContain("2026")
  expect(schedule.at).toBe(Date.UTC(2026, 9, 11, 12, 0, 1, 237))
})

it("keeps interval precision and shows the actual event topic without changing saved plans", () => {
  for (const [everyMs, expected] of [
    [172_800_000, "每 2 天"],
    [7_200_000, "每 2 小时"],
    [120_000, "每 2 分钟"],
    [61_000, "每 61 秒"],
    [61_001, "每 61.001 秒"]
  ] as const) {
    const schedule = { kind: "interval" as const, everyMs, anchor: 1_700_000_001_237 }
    expect(formatRoutineSchedule(schedule, "UTC")).toBe(expected)
    expect(schedule).toEqual({ kind: "interval", everyMs, anchor: 1_700_000_001_237 })
  }
  expect(formatRoutineSchedule({ kind: "event", topic: "project.changed" }, "UTC")).toBe(
    "事件触发：project.changed"
  )
})

function routineCardMarkup(overrides: Partial<BotRoutine>, readinessSupport = false): string {
  const routine: BotRoutine = {
    id: "schedule-view",
    botId: "schedule-view-bot",
    name: "每周巡检",
    prompt: "核对保存的项目计划",
    schedule: { kind: "cron", expression: "0 12 * * 0" },
    timezone: "Asia/Shanghai",
    enabled: false,
    nextAt: null,
    revision: 1,
    createdAt: 1_700_000_000_000,
    ...overrides
  }
  return renderToStaticMarkup(
    createElement(BotRoutineCard, {
      routine,
      busy: false,
      dataEpoch: "schedule-view-epoch",
      readinessSupport,
      toggle: () => {
        throw new Error("Rendering must not toggle a routine")
      }
    })
  )
}

it("renders the paused and setup-blocked saved plan with timezone and preserves state labels", () => {
  const rpc = vi.fn(() => {
    throw new Error("Rendering must not call RPC")
  })
  vi.stubGlobal("window", { api: { bots: new Proxy({}, { get: () => rpc }) } })
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("Rendering must not write storage")
    },
    removeItem: () => {
      throw new Error("Rendering must not remove storage")
    }
  })
  const paused = routineCardMarkup({})
  expect(paused).toContain("已暂停")
  expect(paused).toContain("每星期日 12:00")
  expect(paused).toContain("Asia/Shanghai")
  expect(paused).not.toContain("定时计划")
  const blocked = routineCardMarkup(
    { enabled: true, effectiveState: "needs_setup", skillIssue: "技能版本需要核对" },
    true
  )
  expect(blocked).toContain("需要设置")
  expect(blocked).toContain("每星期日 12:00")
  expect(blocked).toContain("Asia/Shanghai")
  expect(rpc).not.toHaveBeenCalled()
})

it("does not label enabled calendar, interval or expired one-off plans as waiting for an event", () => {
  const schedules: BotRoutine["schedule"][] = [
    { kind: "cron", expression: "0 12 * * 0" },
    { kind: "interval", everyMs: 61_001, anchor: 1_700_000_001_237 },
    { kind: "once", at: 1_700_000_001_237 }
  ]
  for (const schedule of schedules) {
    const markup = routineCardMarkup({ enabled: true, nextAt: null, schedule })
    expect(markup).toContain("已启用")
    expect(markup).not.toContain("等待事件触发")
    expect(markup).toContain("Asia/Shanghai")
    expect(markup).not.toContain("定时计划")
  }
  const event = routineCardMarkup({
    enabled: true,
    nextAt: null,
    schedule: { kind: "event", topic: "project.changed" }
  })
  expect(event).toContain("等待事件触发")
  expect(event).toContain("事件触发：project.changed")
})

it("retains the existing enabled next-run presentation", () => {
  const nextAt = Date.UTC(2026, 9, 11, 4)
  const markup = routineCardMarkup({ enabled: true, nextAt })
  expect(markup).toContain("按计划运行")
  expect(markup).toContain(
    `下次：${new Date(nextAt).toLocaleString(undefined, { timeZone: "Asia/Shanghai" })}`
  )
  expect(markup).toContain("Asia/Shanghai")
  expect(markup).not.toContain("已暂停")
})
