import { readFileSync } from "node:fs"
import { expect, it, vi } from "vitest"
import type { BotMockFeedEntry } from "../../../shared/bots/mock-channel"
import { refreshBotImHistory } from "./bot-im-history"

const row = (n: number, state: BotMockFeedEntry["state"] = "accepted"): BotMockFeedEntry => ({
  id: `message-${n}`, kind: "bot", text: `Reply ${n}`, senderId: "Bot",
  replyToMessageId: null, state, createdAt: n
})
type Page = { items: BotMockFeedEntry[]; before: string | null }

// Execute the actual consumer callback, with only transport and React setters substituted.
// This covers wiring and invalidation without mounting Electron or duplicating the merge.
function consumer(read: (before?: string) => Promise<Page>) {
  const source = readFileSync(new URL("../components/bots/BotImChannelDialog.tsx", import.meta.url), "utf8")
  const prefix = "const refresh = useCallback(async () => {"
  const start = source.indexOf(prefix)
  const end = source.indexOf("  }, [api, bot.id])", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const initial = { id: "binding", items: [row(50), row(10, "pending")], before: "unloaded" }
  const window = { current: initial }
  const selection = { current: "binding" }
  const setEntries = vi.fn()
  const setError = vi.fn()
  const noop = () => {}
  const env = {
    api: { status: async () => ({ available: true, connected: true, scope: "scope" }),
      list: async () => ({ items: [], before: null }),
      history: (_bot: string, _binding: string, before?: string) => read(before) },
    bot: { id: "bot" }, historyWindow: window, selection,
    live: { current: true }, loading: { current: false }, connectionScope: { current: "scope" },
    loadedBindingPages: { current: true }, removedBindings: { current: new Set() },
    setRefreshing: noop, setStatus: noop, setBindings: noop, setCursor: noop, setSelected: noop,
    setEntries, setHistoryCursor: noop, setHistoryNotice: noop, setError, merge: noop,
    botErrorMessage: String, refreshBotImHistory
  }
  const refresh: () => Promise<void> = new Function(...Object.keys(env),
    `return async () => {${source.slice(start + prefix.length, end)}\n}`)(...Object.values(env))
  return { refresh, window, selection, setEntries, setError }
}

it("refreshes the dialog's loaded older delivery state and preserves its cursor", async () => {
  const read = vi.fn(async (before?: string) => before
    ? { items: [row(10)], before: "deeper" }
    : { items: [row(51), row(50)], before: "older" })
  const view = consumer(read)
  await view.refresh()
  expect(view.setError).toHaveBeenLastCalledWith(null)
  expect(view.window.current.items.find(item => item.id === "message-10")?.state).toBe("accepted")
  expect(view.window.current.before).toBe("unloaded")
  expect(read).toHaveBeenCalledTimes(2)
})

it("does not overwrite a page loaded while a refresh is awaiting older history", async () => {
  let resolve!: (page: Page) => void
  const read = vi.fn(async (before?: string) => before
    ? new Promise<Page>(done => { resolve = done })
    : { items: [row(50)], before: "older" })
  const view = consumer(read)
  const refresh = view.refresh()
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  // The existing More handler appends by replacing items on the same window object.
  view.window.current.items = [...view.window.current.items, row(5)]
  view.window.current.before = "further"
  resolve({ items: [row(10)], before: "unloaded" })
  await refresh
  expect(view.window.current.items.some(item => item.id === "message-5")).toBe(true)
  expect(view.window.current.before).toBe("further")
  expect(view.setEntries).not.toHaveBeenCalled()
})

it("discards a response after the selected binding changes", async () => {
  let resolve!: (page: Page) => void
  const read = vi.fn(() => new Promise<Page>(done => { resolve = done }))
  const view = consumer(read)
  const refresh = view.refresh()
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  view.selection.current = "other-binding"
  resolve({ items: [row(50)], before: null })
  await refresh
  expect(view.setEntries).not.toHaveBeenCalled()
})
