import { afterEach, expect, it, vi } from "vitest"
import type { BotSaveRoutineInput } from "../../../shared/bot-routines"
import type { BotRoutine } from "../../../shared/bot-types"
import { inspectPendingRoutine } from "./bot-routine-pending"
import { toggleBotRoutine } from "./bot-routine-toggle"

afterEach(() => vi.unstubAllGlobals())

function fixture() {
  const records = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => records.set(key, value),
    removeItem: (key: string) => records.delete(key)
  })
  const routine: BotRoutine = {
    id: "routine",
    botId: "bot",
    name: "项目检查",
    prompt: "核对证据",
    enabled: true,
    schedule: { kind: "interval", anchor: 1700000001237, everyMs: 61001 },
    timezone: "Asia/Shanghai",
    revision: 7,
    nextAt: 1700000001237,
    createdAt: 1700000000000
  }
  const recover = vi.fn()
  const input = {
    botId: "bot",
    routine,
    dataEpoch: "epoch",
    editorSupport: true,
    mutationSupport: true,
    isLive: () => true,
    isCurrentEpoch: () => true,
    recover,
    save: vi.fn<(request: BotSaveRoutineInput) => Promise<unknown>>(async () => undefined)
  }
  return {
    input,
    records,
    recover,
    pending: () => inspectPendingRoutine("bot", "routine", "epoch")
  }
}

it("preserves the reviewed CAS/schedule and persists the exact nonce before dispatch, then acknowledges only that save", async () => {
  const f = fixture()
  f.input.save = vi.fn(async (request) => {
    expect(f.pending()).toMatchObject({ kind: "valid", input: request })
  })
  expect(await toggleBotRoutine(f.input)).toBe(true)
  const request = f.input.save.mock.calls[0][0]
  expect(request).toMatchObject({
    expectedDataEpoch: "epoch",
    botId: "bot",
    id: "routine",
    revision: 7,
    enabled: false,
    schedule: f.input.routine.schedule,
    timezone: "Asia/Shanghai"
  })
  expect(request.nonce).toBeTruthy()
  expect(request).not.toHaveProperty("skills")
  expect(f.pending().kind).toBe("empty")
})

it("keeps a lost acknowledgement exact and routes a later inverse click to recovery without another save", async () => {
  const f = fixture()
  f.input.save.mockRejectedValue(new Error("ACK lost after commit"))
  await expect(toggleBotRoutine(f.input)).rejects.toThrow("ACK lost")
  const original = f.pending()
  expect(original.kind).toBe("valid")
  expect(
    await toggleBotRoutine({
      ...f.input,
      routine: { ...f.input.routine, revision: 8, enabled: false }
    })
  ).toBe(false)
  expect(f.input.save).toHaveBeenCalledTimes(1)
  expect(f.pending()).toEqual(original)
  expect(f.recover).toHaveBeenCalledTimes(2)
})

it("does not dispatch when the exact pending request cannot be stored", async () => {
  const f = fixture()
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem() {
      throw new Error("full")
    }
  })
  await expect(toggleBotRoutine(f.input)).rejects.toThrow("尚未提交")
  expect(f.input.save).not.toHaveBeenCalled()
})

it("clears an exact pending request only for a definitive Host rejection", async () => {
  const f = fixture()
  f.input.save.mockRejectedValue({
    code: "revision_conflict",
    message: "changed"
  })
  await expect(toggleBotRoutine(f.input)).rejects.toMatchObject({
    code: "revision_conflict"
  })
  expect(f.pending().kind).toBe("empty")
  expect(f.recover).not.toHaveBeenCalled()
})

it("does not acknowledge a replaced workspace or treat data_epoch as proof of original failure", async () => {
  const f = fixture()
  f.input.isCurrentEpoch = () => false
  f.input.save.mockRejectedValue({ code: "data_epoch", message: "restored" })
  await expect(toggleBotRoutine(f.input)).rejects.toMatchObject({
    code: "data_epoch"
  })
  expect(f.pending().kind).toBe("valid")
  expect(f.recover).not.toHaveBeenCalled()
})

it("can acknowledge an actual receipt after a view retires without opening recovery in that view", async () => {
  const f = fixture()
  let live = true
  f.input.isLive = () => live
  f.input.save.mockImplementation(async () => {
    live = false
  })
  expect(await toggleBotRoutine(f.input)).toBe(true)
  expect(f.pending().kind).toBe("empty")
  expect(f.recover).not.toHaveBeenCalled()
})

it("preserves a known receipt with failed local cleanup and directs the exact original save to recovery", async () => {
  const f = fixture()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => f.records.get(key) ?? null,
    setItem: (key: string, value: string) => f.records.set(key, value),
    removeItem() {
      throw new Error("remove denied")
    }
  })
  await expect(toggleBotRoutine(f.input)).rejects.toThrow("本机记录尚未清除")
  expect(f.pending().kind).toBe("valid")
  expect(f.recover).toHaveBeenCalledTimes(1)
})

it("rejects a borrowed routine and retires inactive view authority before storing a request", async () => {
  const f = fixture()
  await expect(
    toggleBotRoutine({
      ...f.input,
      routine: { ...f.input.routine, botId: "other" }
    })
  ).rejects.toThrow("不属于此 Bot")
  expect(await toggleBotRoutine({ ...f.input, isLive: () => false })).toBe(false)
  expect(f.input.save).not.toHaveBeenCalled()
  expect(f.records.size).toBe(0)
})

it("opens the existing editor for a passed one-shot without saving, changing time or replaying work", async () => {
  const f = fixture()
  const routine: BotRoutine = {
    ...f.input.routine,
    enabled: false,
    schedule: { kind: "once", at: Date.now() - 1000 },
    nextAt: null
  }
  const reschedule = vi.fn()
  const before = JSON.stringify(routine)
  expect(await toggleBotRoutine({ ...f.input, routine, reschedule })).toBe(false)
  expect(reschedule).toHaveBeenCalledTimes(1)
  expect(f.input.save).not.toHaveBeenCalled()
  expect(f.recover).not.toHaveBeenCalled()
  expect(f.pending().kind).toBe("empty")
  expect(JSON.stringify(routine)).toBe(before)
  await expect(toggleBotRoutine({ ...f.input, routine })).rejects.toThrow("新的运行时间")
  expect(f.pending().kind).toBe("empty")
})

it("reconciles an uncertain old save before offering to reschedule an expired one-shot", async () => {
  const f = fixture()
  f.input.save.mockRejectedValue(new Error("lost"))
  await expect(toggleBotRoutine(f.input)).rejects.toThrow("lost")
  const pending = f.pending()
  const reschedule = vi.fn()
  expect(
    await toggleBotRoutine({
      ...f.input,
      routine: {
        ...f.input.routine,
        enabled: false,
        schedule: { kind: "once", at: Date.now() - 1000 }
      },
      reschedule
    })
  ).toBe(false)
  expect(f.pending()).toEqual(pending)
  expect(reschedule).not.toHaveBeenCalled()
  expect(f.input.save).toHaveBeenCalledTimes(1)
  expect(f.recover).toHaveBeenCalledTimes(2)
})

it("preserves a future paused one-shot's timestamp through the normal guarded resume", async () => {
  const f = fixture()
  const routine: BotRoutine = {
    ...f.input.routine,
    enabled: false,
    schedule: { kind: "once", at: Date.now() + 60_000 }
  }
  const reschedule = vi.fn()
  expect(await toggleBotRoutine({ ...f.input, routine, reschedule })).toBe(true)
  expect(reschedule).not.toHaveBeenCalled()
  expect(f.input.save.mock.calls[0][0]).toMatchObject({
    enabled: true,
    schedule: routine.schedule,
    revision: routine.revision
  })
})
