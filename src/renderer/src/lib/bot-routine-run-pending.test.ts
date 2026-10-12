import { afterEach, expect, it, vi } from "vitest"
import {
  acknowledgePendingRoutineRun,
  readPendingRoutineRun,
  rememberPendingRoutineRun
} from "./bot-routine-run-pending"

afterEach(() => vi.unstubAllGlobals())
it("retains the exact run version, isolated by Bot and restored database, without deleting a newer request", () => {
  const values = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  })
  const input = { botId: "bot", id: "routine", nonce: "first", revision: 2 }
  rememberPendingRoutineRun(input, "database")
  expect(readPendingRoutineRun("bot", "routine", "database")).toEqual(input)
  expect(readPendingRoutineRun("other", "routine", "database")).toBeNull()
  expect(readPendingRoutineRun("bot", "other", "database")).toBeNull()
  expect(readPendingRoutineRun("bot", "routine", "restored")).toBeNull()
  const next = { ...input, nonce: "second", revision: 3 }
  expect(() => rememberPendingRoutineRun(next, "database")).toThrow("尚未确认")
  values.set(
    "bot-routine-run-pending:bot:routine",
    JSON.stringify({ dataEpoch: "database", input: next })
  )
  acknowledgePendingRoutineRun(input, "database")
  expect(readPendingRoutineRun("bot", "routine", "database")).toEqual(next)
  const key = [...values.keys()][0]
  for (const invalid of [
    { ...next, botId: "other" },
    { ...next, id: "other" },
    { ...next, revision: 0 },
    { ...next, nonce: "bad/path" },
    { ...next, injected: "ignored?" }
  ]) {
    values.set(key, JSON.stringify({ input: invalid, dataEpoch: "database" }))
    expect(readPendingRoutineRun("bot", "routine", "database")).toBeNull()
  }
  values.delete(key)
  rememberPendingRoutineRun(next, "database")
  acknowledgePendingRoutineRun(next, "database")
  expect(values.size).toBe(0)
})
it("rejects a run when its recovery identity cannot be saved", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("full")
    }
  })
  expect(() =>
    rememberPendingRoutineRun(
      { botId: "bot", id: "routine", nonce: "run", revision: 1 },
      "database"
    )
  ).toThrow("尚未提交")
})
