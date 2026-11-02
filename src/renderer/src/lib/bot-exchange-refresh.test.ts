import { afterEach, expect, it, vi } from "vitest"
import type { BotClient, BotExchange } from "../../../shared/bots/contracts"

const hooks = vi.hoisted(() => ({
  states: [] as any[], index: 0, effect: undefined as (() => (() => void) | void) | undefined
}))
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = hooks.index++
    hooks.states[index] = initial
    return [initial, (next: any) => {
      hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next
    }]
  },
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => (() => void) | void) => { hooks.effect = effect }
}))
import { useBotExchange } from "../components/bots/use-bot-exchange"

afterEach(() => vi.unstubAllGlobals())

it.each([
  { selectedOld: true, failed: false },
  { selectedOld: false, failed: false },
  { selectedOld: false, failed: true }
])("refreshes loaded old results without inserting unloaded history: %o", async ({ selectedOld, failed }) => {
  hooks.states = []
  hooks.index = 0
  vi.stubGlobal("document", { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  const author = { id: "a", name: "A", color: "#123456", shape: "drop" as const }
  let anchor: BotExchange = {
    taskId: "old", sender: author, recipient: { ...author, id: "b" }, createdAt: 1,
    message: "Long collaboration", state: failed ? "failed" : "completed",
    reply: failed ? { message: "EARLY_FAILURE", createdAt: 2, delivered: true } : null
  }
  const latest = Array.from({ length: 30 }, (_, i) => ({ ...anchor, taskId: `new-${i}`, createdAt: i + 2 }))
  let changed = () => {}
  const exchange = vi.fn()
  const history = vi.fn(async (_bot: string, _task: string, _group?: string, cursor?: string) => ({
    anchor: selectedOld ? anchor : latest[0], items: cursor ? [anchor] : latest, ...(cursor ? {} : { before: "older" })
  }))
  const client = {
    exchangeHistory: history, exchange,
    subscribe: (callback: () => void) => { changed = callback; return () => {} }
  } as unknown as BotClient
  const hook = useBotExchange(client, "a", selectedOld ? "old" : "new-0")
  const cleanup = hooks.effect!()
  try {
    await vi.waitFor(() => expect(hooks.states[2]).toBe(false))
    expect(hooks.states[0].messages.some((m: { id: string }) => m.id === "old:0")).toBe(false)
    hook.loadOlder()
    await vi.waitFor(() => expect(hooks.states[0].messages.some((m: { id: string }) => m.id === "old:0")).toBe(true))
    anchor = { ...anchor, reply: { message: "LATE_FINAL", createdAt: 40, delivered: true } }
    changed()
    await vi.waitFor(() => expect(hooks.states[0].messages.find((m: { id: string }) => m.id === "old:1")?.message).toBe("LATE_FINAL"))
    expect(hooks.states[0].messages.filter((m: { id: string }) => m.id === "old:0")).toHaveLength(1)
    expect(history).toHaveBeenCalledTimes(selectedOld ? 3 : 4)
    expect(exchange).not.toHaveBeenCalled()
  } finally { cleanup?.() }
})
