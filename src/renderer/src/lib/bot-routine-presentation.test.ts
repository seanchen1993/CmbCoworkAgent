import { expect, it } from "vitest"
import type { BotRoutine } from "../../../shared/bot-types"
import {
  endedOnceSchedule,
  needsFutureOnceSchedule,
  routineStatusLabel,
  routineToggleLabel
} from "./bot-routine-presentation"

const once: BotRoutine = {
  id: "once",
  botId: "bot",
  name: "One task",
  prompt: "Deliver the task",
  schedule: { kind: "once", at: 1_700_000_000_000 },
  enabled: false,
  desiredEnabled: true,
  activationRequired: false,
  effectiveState: "paused",
  nextAt: null,
  timezone: "UTC",
  revision: 2,
  createdAt: 1_699_999_999_000
}

it("distinguishes an exhausted one-shot cursor from a human pause without claiming the task succeeded", () => {
  expect(endedOnceSchedule(once)).toBe(true)
  expect(routineStatusLabel(once, true)).toBe("计划已结束")
  expect(routineStatusLabel(once, true)).not.toBe("已完成")
  expect(routineToggleLabel(once, true)).toBe("重新安排")
  const paused = { ...once, desiredEnabled: false }
  expect(endedOnceSchedule(paused)).toBe(false)
  expect(routineStatusLabel(paused, true)).toBe("已暂停")
  expect(
    needsFutureOnceSchedule(paused, once.schedule.kind === "once" ? once.schedule.at : 0)
  ).toBe(true)
  // An older Host has no independent intent evidence.
  expect(routineStatusLabel({ ...once, desiredEnabled: undefined })).toBe("已暂停")
})

it("keeps restored, cloned and revoked definitions gated even when their time has passed", () => {
  const restored = { ...once, activationRequired: true, effectiveState: "needs_setup" as const }
  expect(endedOnceSchedule(restored)).toBe(false)
  expect(routineStatusLabel(restored, true)).toBe("已验证，待确认启用")
  const revoked = { ...restored, skillIssue: "版本已变化" }
  expect(routineStatusLabel(revoked, true)).toBe("需要设置")
  expect(routineToggleLabel(revoked, true)).toBe("核对设置")
  expect(routineStatusLabel(revoked, false)).toBe("需要核对技能")
})

it("does not reschedule an enabled or future one-shot and retains interval/event labels", () => {
  expect(needsFutureOnceSchedule(once, 1_699_999_999_999)).toBe(false)
  const active = { ...once, enabled: true, nextAt: 1_700_000_000_000 }
  expect(needsFutureOnceSchedule(active, 1_800_000_000_000)).toBe(false)
  expect(routineStatusLabel(active)).toBe("按计划运行")
  expect(routineToggleLabel(active)).toBe("暂停")
  const event = { ...once, enabled: true, schedule: { kind: "event" as const, topic: "ready" } }
  expect(routineStatusLabel(event)).toBe("等待事件触发")
  expect(endedOnceSchedule(event)).toBe(false)
  expect(needsFutureOnceSchedule(event, 1_800_000_000_000)).toBe(false)
})
