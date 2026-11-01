import { expect, it, vi } from "vitest"
import type { BotMockFeedEntry } from "../../../shared/bots/mock-channel"
import { refreshBotImHistory } from "./bot-im-history"

const entry = (n: number, state: BotMockFeedEntry["state"] = "accepted"): BotMockFeedEntry => ({
  id: `message-${n}`, kind: "bot", text: `Reply ${n}`, senderId: "Bot",
  replyToMessageId: null, state, createdAt: n
})

it.each([
  ["pending", "accepted"], ["sending", "blocked"], ["running", "completed"],
  ["waiting_user", "cancelled"], ["queued", "failed"]
] as const)("refreshes loaded %s history to %s without expanding the window", async (from, to) => {
  const old = { items: [entry(50), entry(10, from)], before: "unloaded" }
  const read = vi.fn(async (before?: string) => before
    ? { items: [entry(10, to), entry(9)], before: "further" }
    : { items: [entry(51), entry(50)], before: "older" })
  const result = await refreshBotImHistory(old, read, () => true)
  expect(result?.items.find(item => item.id === "message-10")?.state).toBe(to)
  expect(result?.items.map(item => item.id)).toEqual(["message-50", "message-10", "message-51"])
  expect(result?.before).toBe("unloaded")
  expect(read).toHaveBeenCalledTimes(2)
})

it("reads only the newest page for terminal history and initially unloaded pending rows", async () => {
  const read = vi.fn(async () => ({ items: [entry(50)], before: "older" }))
  await refreshBotImHistory({ items: [entry(50), entry(10)], before: null }, read, () => true)
  expect(read).toHaveBeenCalledTimes(1)
  read.mockClear()
  await refreshBotImHistory({ items: [], before: null }, read, () => true)
  expect(read).toHaveBeenCalledTimes(1)
})

it("refreshes a completed user dispatch when stopping its remaining collaboration", async () => {
  const user = { ...entry(10, "completed"), kind: "user" as const }
  const read = vi.fn(async (before?: string) => before
    ? { items: [{ ...user, state: "cancelled" as const }], before: null }
    : { items: [entry(50)], before: "older" })
  const result = await refreshBotImHistory({ items: [entry(50), user], before: null }, read, () => true)
  expect(result?.items.find(item => item.id === user.id)?.state).toBe("cancelled")
  expect(read).toHaveBeenCalledTimes(2)
})

it("refreshes through shifted page boundaries, stopping once pending rows are covered", async () => {
  const read = vi.fn(async (before?: string) => before === "middle"
    ? { items: [entry(30), entry(20)], before: "old" }
    : before === "old" ? { items: [entry(10)], before: "unloaded" }
      : { items: [entry(51), entry(50)], before: "middle" })
  const result = await refreshBotImHistory({ items: [entry(50), entry(10, "pending")], before: null }, read, () => true)
  expect(result?.items.find(item => item.id === "message-10")?.state).toBe("accepted")
  expect(result?.items.some(item => item.id === "message-20")).toBe(false)
  expect(read).toHaveBeenCalledTimes(3)
})

it("does not scan past the loaded time window if a pending row disappeared", async () => {
  const read = vi.fn(async (before?: string) => before
    ? { items: [entry(9)], before: "deeper" }
    : { items: [entry(50)], before: "older" })
  await refreshBotImHistory({ items: [entry(50), entry(10, "pending")], before: null }, read, () => true)
  expect(read).toHaveBeenCalledTimes(2)
})

it("resets a nonoverlapping window without fetching its old pending rows", async () => {
  const read = vi.fn(async () => ({ items: [entry(100)], before: "new-cursor" }))
  const result = await refreshBotImHistory({ items: [entry(10, "pending")], before: null }, read, () => true)
  expect(result).toEqual({ items: [entry(100)], before: "new-cursor", overlap: false })
  expect(read).toHaveBeenCalledTimes(1)
})

it("discards an older-page response after switching conversations or unmounting", async () => {
  let current = true
  const read = vi.fn(async (before?: string) => {
    if (before) current = false
    return before ? { items: [entry(10)], before: null } : { items: [entry(50)], before: "older" }
  })
  expect(await refreshBotImHistory({ items: [entry(50), entry(10, "pending")], before: null }, read, () => current)).toBeUndefined()
})

it("rejects a stuck pagination cursor instead of polling forever", async () => {
  const read = vi.fn(async () => ({ items: [entry(50)], before: "older" }))
  await expect(refreshBotImHistory({ items: [entry(50), entry(10, "pending")], before: null }, read, () => true)).rejects.toThrow("分页没有前进")
  expect(read).toHaveBeenCalledTimes(2)
})
