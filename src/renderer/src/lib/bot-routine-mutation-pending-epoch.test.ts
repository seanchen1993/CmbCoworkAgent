import { afterEach, expect, it, vi } from "vitest"
import {
  rememberPendingRoutine,
  readPendingRoutine,
  inspectPendingRoutine,
  acknowledgePendingRoutine,
  isDefinitiveRoutineSaveError
} from "./bot-routine-pending"
import {
  rememberPendingRoutineRun,
  readPendingRoutineRun,
  inspectPendingRoutineRun,
  acknowledgePendingRoutineRun
} from "./bot-routine-run-pending"
import {
  rememberPendingTrial,
  readPendingTrial,
  inspectPendingTrial,
  acknowledgePendingTrial
} from "./bot-skill-trial-pending"
const save = {
  botId: "owner",
  id: "routine",
  revision: 1,
  nonce: "save",
  name: "Checked",
  prompt: "Evidence",
  enabled: false,
  timezone: "UTC",
  schedule: { kind: "event" as const, topic: "build.failed" }
}
const run = { botId: "owner", id: "routine", revision: 1, nonce: "run" }
const trial = {
  botId: "owner",
  skillId: "skill",
  version: 1,
  nonce: "trial",
  inputs: "Sample",
  criteria: "Evidence"
}
const cases = [
  {
    kind: "save",
    input: save,
    key: "bot-routine-pending:owner:routine",
    remember: (input: unknown, epoch: string) =>
      rememberPendingRoutine(input as typeof save, epoch),
    read: (epoch: string) => readPendingRoutine("owner", "routine", epoch),
    inspect: (epoch: string) => inspectPendingRoutine("owner", "routine", epoch),
    ack: (input: unknown, epoch: string) => acknowledgePendingRoutine(input as typeof save, epoch)
  },
  {
    kind: "run",
    input: run,
    key: "bot-routine-run-pending:owner:routine",
    remember: (input: unknown, epoch: string) =>
      rememberPendingRoutineRun(input as typeof run, epoch),
    read: (epoch: string) => readPendingRoutineRun("owner", "routine", epoch),
    inspect: (epoch: string) => inspectPendingRoutineRun("owner", "routine", epoch),
    ack: (input: unknown, epoch: string) => acknowledgePendingRoutineRun(input as typeof run, epoch)
  },
  {
    kind: "trial",
    input: trial,
    key: "bot-skill-trial-pending:owner:skill",
    remember: (input: unknown, epoch: string) => rememberPendingTrial(input as typeof trial, epoch),
    read: (epoch: string) => readPendingTrial("owner", "skill", epoch),
    inspect: (epoch: string) => inspectPendingTrial("owner", "skill", epoch),
    ack: (input: unknown, epoch: string) => acknowledgePendingTrial(input as typeof trial, epoch)
  }
]
function fixture() {
  const values = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  })
  return values
}
afterEach(() => vi.unstubAllGlobals())
for (const item of cases) {
  it(`${item.kind}: keeps legacy pending exact bytes and binds only newly supplied scope`, () => {
    const values = fixture(),
      legacy = JSON.stringify({ dataEpoch: "current", input: item.input })
    values.set(item.key, legacy)
    expect(item.read("current")).toEqual(item.input)
    expect(values.get(item.key)).toBe(legacy)
    expect(item.read("restored")).toBeNull()
    expect(item.ack(item.input, "current")).toBe(true)
    const scoped = { ...item.input, expectedDataEpoch: "current" }
    item.remember(scoped, "current")
    expect(item.read("current")).toEqual(scoped)
    expect(item.ack(item.input, "current")).toBe(false)
    expect(item.ack(scoped, "current")).toBe(true)
  })
  it(`${item.kind}: refuses outer/inner epoch mismatch and malformed scope without altering retained raw`, () => {
    const values = fixture()
    expect(() => item.remember({ ...item.input, expectedDataEpoch: "other" }, "current")).toThrow()
    expect(values.size).toBe(0)
    const corrupted = JSON.stringify({
      dataEpoch: "current",
      input: { ...item.input, expectedDataEpoch: "other" }
    })
    values.set(item.key, corrupted)
    expect(item.inspect("current").kind).toBe("corrupt")
    expect(item.ack(item.input, "current")).toBe(false)
    expect(values.get(item.key)).toBe(corrupted)
    values.clear()
    for (const expectedDataEpoch of ["", "a".repeat(161), "bad\0epoch"]) {
      expect(() => item.remember({ ...item.input, expectedDataEpoch }, "current")).toThrow()
      expect(values.size).toBe(0)
    }
  })
}
it("a restored Host rejection does not prove the original workspace operation failed", () => {
  expect(isDefinitiveRoutineSaveError({ code: "data_epoch" })).toBe(false)
})
