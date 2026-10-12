import { afterEach, expect, it, vi } from "vitest"
import {
  acknowledgePendingTrial,
  readPendingTrial,
  rememberPendingTrial
} from "./bot-skill-trial-pending"

afterEach(() => vi.unstubAllGlobals())
it("recovers exact inputs and versions without clearing another submission or replaying restored data", () => {
  const items = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key)
  })
  const input = {
    nonce: "original",
    botId: "bot",
    skillId: "library:skill",
    version: 3,
    inputs: "record 42",
    criteria: "matches 42"
  }
  rememberPendingTrial(input, "epoch")
  expect(readPendingTrial("bot", "library:skill", "epoch")).toEqual(input)
  expect(readPendingTrial("other", "library:skill", "epoch")).toBeNull()
  expect(readPendingTrial("bot", "library:skill", "restored")).toBeNull()
  const newer = { ...input, nonce: "later", version: 4 }
  expect(() => rememberPendingTrial(newer, "epoch")).toThrow("尚未确认")
  items.set(
    "bot-skill-trial-pending:bot:library:skill",
    JSON.stringify({ dataEpoch: "epoch", input: newer })
  )
  acknowledgePendingTrial(input, "epoch")
  expect(readPendingTrial("bot", "library:skill", "epoch")).toEqual(newer)
  acknowledgePendingTrial(newer, "epoch")
  expect(items.size).toBe(0)
  items.set(
    "bot-skill-trial-pending:bot:library:skill",
    JSON.stringify({ dataEpoch: "epoch", input: { ...input, botId: "other" } })
  )
  expect(readPendingTrial("bot", "library:skill", "epoch")).toBeNull()
  items.set("bot-skill-trial-pending:bot:library:skill", "{".repeat(120_001))
  expect(readPendingTrial("bot", "library:skill", "epoch")).toBeNull()
})
it("refuses to dispatch a new trial when its retry identity cannot be retained", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota")
    }
  })
  expect(() =>
    rememberPendingTrial(
      {
        nonce: "trial",
        botId: "bot",
        skillId: "skill",
        version: 1,
        inputs: "42",
        criteria: "matches"
      },
      "epoch"
    )
  ).toThrow("尚未提交")
})
