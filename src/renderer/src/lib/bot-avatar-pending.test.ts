import { afterEach, expect, it, vi } from "vitest"
import {
  acknowledgePendingAvatar,
  discardPendingAvatar,
  readPendingAvatar,
  rememberPendingAvatar
} from "./bot-avatar-pending"
afterEach(() => vi.unstubAllGlobals())
it("preserves mutation identity including the selected image and fences restores, foreign Bots and later submissions", () => {
  const items = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key)
  })
  const input = {
    botId: "bot",
    nonce: "rotate",
    revision: 2,
    pngBase64: "AAAA"
  }
  rememberPendingAvatar(input, "epoch")
  expect(readPendingAvatar(input.botId, "epoch")).toEqual(input)
  expect(readPendingAvatar(input.botId, "restored")).toBeNull()
  expect(readPendingAvatar("other", "epoch")).toBeNull()
  const newer = { ...input, nonce: "later", revision: 3 }
  expect(() => rememberPendingAvatar(newer, "epoch")).toThrow()
  const key = [...items.keys()][0]
  items.set(key, JSON.stringify({ dataEpoch: "epoch", input: newer }))
  expect(acknowledgePendingAvatar(input, "epoch")).toBe(false)
  expect(readPendingAvatar(input.botId, "epoch")).toEqual(newer)
  items.set(
    key,
    JSON.stringify({ dataEpoch: "epoch", input: { ...newer, key: "secret-not-allowed" } })
  )
  expect(readPendingAvatar(input.botId, "epoch")).toBeNull()
  expect(() => rememberPendingAvatar(newer, "epoch")).toThrow()
  const damaged = items.get(key)!
  expect(discardPendingAvatar(input.botId, "epoch", "changed")).toBe(false)
  expect(discardPendingAvatar(input.botId, "epoch", damaged)).toBe(true)
  rememberPendingAvatar(newer, "epoch")
  expect(acknowledgePendingAvatar(newer, "epoch")).toBe(true)
  expect(items.size).toBe(0)
})
it("refuses a mutation when its recovery identity cannot be retained", () => {
  vi.stubGlobal("localStorage", {
    setItem: () => {
      throw new Error("quota")
    }
  })
  expect(() =>
    rememberPendingAvatar(
      { botId: "bot", nonce: "rotate", revision: 1, pngBase64: "AAAA" },
      "epoch"
    )
  ).toThrow("尚未提交")
})
