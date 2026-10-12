import { afterEach, expect, it, vi } from "vitest"
import {
  readPendingMemoryRetry,
  rememberPendingMemoryRetry,
  acknowledgePendingMemoryRetry
} from "./bot-memory-pending"

afterEach(() => vi.unstubAllGlobals())
it("preserves an unknown retry receipt across reopening without reviving a restored database or clearing a newer request", () => {
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
    revision: 0
  }
  rememberPendingMemoryRetry(input)
  expect(readPendingMemoryRetry(input.botId, "initial")).toEqual(input)
  expect(readPendingMemoryRetry("other-bot", "initial")).toBeNull()
  expect(readPendingMemoryRetry(input.botId, "restored")).toBeNull()
  const next = { ...input, nonce: "two", revision: 1 }
  expect(() => rememberPendingMemoryRetry(next)).toThrow("尚未确认")
  acknowledgePendingMemoryRetry(input)
  rememberPendingMemoryRetry(next)
  expect(readPendingMemoryRetry(input.botId, "initial")).toEqual(next)
  const key = [...values.keys()][0]
  for (const invalid of [
    { ...next, botId: "../outside" },
    { ...next, revision: -1 },
    { ...next, evidenceIds: ["arbitrary"] },
    "x".repeat(2049)
  ]) {
    values.set(key, JSON.stringify(invalid))
    expect(readPendingMemoryRetry(input.botId, "initial")).toBeNull()
  }
  values.delete(key)
  rememberPendingMemoryRetry(next)
  acknowledgePendingMemoryRetry(next)
  expect(values.size).toBe(0)
})
it("prevents dispatch if its retry identity cannot be retained", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem() {
      throw new Error("full")
    }
  })
  expect(() =>
    rememberPendingMemoryRetry({
      botId: "03165af2-0d60-4bb4-a960-6fe665cc8e93",
      nonce: "one",
      dataEpoch: "initial",
      revision: 0
    })
  ).toThrow("尚未重新整理")
})
