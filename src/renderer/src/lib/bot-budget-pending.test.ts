import { afterEach, expect, it, vi } from "vitest"
import {
  readPendingBotBudget,
  rememberPendingBotBudget,
  acknowledgePendingBotBudget
} from "./bot-budget-pending"

afterEach(() => vi.unstubAllGlobals())
it("preserves an unknown budget receipt across reopening without reviving a restored database or clearing a newer request", () => {
  const values = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  })
  const input = {
    botId: "03165af2-0d60-4bb4-a960-6fe665cc8e93",
    nonce: "one",
    dataEpoch: "initial",
    revision: 0,
    outputLimit: 100
  }
  rememberPendingBotBudget(input)
  expect(readPendingBotBudget(input.botId, "initial")).toEqual(input)
  expect(readPendingBotBudget("other-bot", "initial")).toBeNull()
  expect(readPendingBotBudget(input.botId, "restored")).toBeNull()
  const next = { ...input, nonce: "two", revision: 1 }
  expect(() => rememberPendingBotBudget(next)).toThrow("有一次保存尚未确认")
  acknowledgePendingBotBudget(input)
  rememberPendingBotBudget(next)
  acknowledgePendingBotBudget(input)
  expect(readPendingBotBudget(input.botId, "initial")).toEqual(next)
  const key = [...values.keys()][0]
  for (const invalid of [
    { ...next, botId: "../outside" },
    { ...next, revision: -1 },
    { ...next, outputLimit: -1 },
    "x".repeat(2049)
  ]) {
    values.set(key, JSON.stringify(invalid))
    expect(readPendingBotBudget(input.botId, "initial")).toBeNull()
  }
  expect(() => rememberPendingBotBudget(next)).toThrow()
  values.delete(key)
  rememberPendingBotBudget(next)
  acknowledgePendingBotBudget(next)
  expect(values.size).toBe(0)
})
it("prevents dispatch if its budget identity cannot be retained", () => {
  vi.stubGlobal("localStorage", {
    getItem() {
      return null
    },
    setItem() {
      throw new Error("full")
    }
  })
  expect(() =>
    rememberPendingBotBudget({
      botId: "03165af2-0d60-4bb4-a960-6fe665cc8e93",
      nonce: "one",
      dataEpoch: "initial",
      revision: 0,
      outputLimit: 100
    })
  ).toThrow("额度尚未修改")
})
