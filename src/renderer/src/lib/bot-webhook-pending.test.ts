import { afterEach, expect, it, vi } from "vitest"
import {
  acknowledgePendingWebhook,
  discardPendingWebhook,
  readPendingWebhook,
  rememberPendingWebhook
} from "./bot-webhook-pending"
afterEach(() => vi.unstubAllGlobals())
it("preserves mutation identity without any key and fences restores, foreign routines and later submissions", () => {
  const items = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key)
  })
  const input = {
    botId: "bot",
    routineId: "routine",
    nonce: "rotate",
    revision: 2,
    operation: "rotate" as const
  }
  rememberPendingWebhook(input, "epoch")
  expect(readPendingWebhook(input, "epoch")).toEqual(input)
  expect(readPendingWebhook(input, "restored")).toBeNull()
  expect(readPendingWebhook({ ...input, routineId: "other" }, "epoch")).toBeNull()
  const newer = { ...input, nonce: "later", revision: 3 }
  expect(() => rememberPendingWebhook(newer, "epoch")).toThrow()
  const key = [...items.keys()][0]
  items.set(key, JSON.stringify({ dataEpoch: "epoch", input: newer }))
  expect(acknowledgePendingWebhook(input, "epoch")).toBe(false)
  expect(readPendingWebhook(input, "epoch")).toEqual(newer)
  items.set(
    key,
    JSON.stringify({ dataEpoch: "epoch", input: { ...newer, key: "secret-not-allowed" } })
  )
  expect(readPendingWebhook(input, "epoch")).toBeNull()
  expect(() => rememberPendingWebhook(newer, "epoch")).toThrow()
  const damaged = items.get(key)!
  expect(discardPendingWebhook(input, "epoch", "changed")).toBe(false)
  expect(discardPendingWebhook(input, "epoch", damaged)).toBe(true)
  rememberPendingWebhook(newer, "epoch")
  expect(acknowledgePendingWebhook(newer, "epoch")).toBe(true)
  expect(items.size).toBe(0)
})
it("refuses a mutation when its recovery identity cannot be retained", () => {
  vi.stubGlobal("localStorage", {
    setItem: () => {
      throw new Error("quota")
    }
  })
  expect(() =>
    rememberPendingWebhook(
      { botId: "bot", routineId: "routine", nonce: "rotate", revision: 0, operation: "rotate" },
      "epoch"
    )
  ).toThrow("尚未提交")
})
