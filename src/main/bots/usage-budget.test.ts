import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { startBotModelUsage, settleBotModelUsage } from "./model-usage"
import { BOT_USAGE_WINDOW_MS } from "../../shared/bot-usage-budget"
import type { ModelResponseDiagnostic } from "../agent/model-response-diagnostics"

const stores: BotStore[] = [],
  directories: string[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
const model = {
  id: "test",
  model: "test",
  apiKey: "never-store",
  baseUrl: "https://unused.invalid"
}
function fixture() {
  let now = 1_800_000_000_000
  const root = mkdtempSync(join(tmpdir(), "cmb-usage-budget-"))
  directories.push(root)
  const path = join(root, "bots.sqlite")
  let store = new BotStore(path, () => now)
  stores.push(store)
  const a = store.createBot({ nonce: "a", name: "A" }).bot,
    b = store.createBot({ nonce: "b", name: "B" }).bot
  return {
    get store() {
      return store
    },
    a,
    b,
    advance: (ms: number) => {
      now += ms
    },
    reopen: () => {
      store.close()
      stores.splice(stores.indexOf(store), 1)
      store = new BotStore(path, () => now)
      stores.push(store)
    },
    change(botId: string | null, outputLimit: number | null, nonce: string) {
      const current = store.usageBudgets.view({ botId })
      return store.usageBudgets.change({
        botId,
        outputLimit,
        nonce,
        revision: current.revision,
        dataEpoch: current.dataEpoch
      })
    },
    start(botId: string, reserved: number) {
      return store.transaction(() =>
        startBotModelUsage(store, { botId, model, reserved, purpose: "memory-synthesis" })
      )
    }
  }
}

it("shares user allowance across Bots and memory, retains unknown reservations and applies the stricter scope", () => {
  const f = fixture()
  expect(f.store.usageBudgets.capacity(f.a.id, 100)).toBe(100)
  f.change(null, 100, "user")
  f.change(f.a.id, 60, "a-limit")
  const first = f.start(f.a.id, 60)
  expect(() => f.start(f.a.id, 1)).toThrow("额度已用尽")
  expect(f.store.usageBudgets.capacity(f.b.id, 100)).toBe(40)
  f.start(f.b.id, 40)
  expect(() => f.start(f.b.id, 1)).toThrow("额度已用尽")
  expect(f.store.usageBudgets.view({ botId: null })).toMatchObject({
    outputLimit: 100,
    available: 0,
    usage: { requests: 2, reservedOutputTokens: 100, unknownRequests: 2 }
  })
  settleBotModelUsage(f.store, first, {
    doneEvents: 1,
    errorEvents: 0,
    uninspectedEvents: 0,
    outputTokens: 10,
    inputTokens: 20
  } as ModelResponseDiagnostic)
  expect(f.store.usageBudgets.capacity(f.a.id, 100)).toBe(50)
  expect(f.store.usageBudgets.view({ botId: f.b.id }).usage.requests).toBe(1)
  expect(f.store.usageBudgets.view({ botId: null }).available).toBe(50)
  f.change(null, 5, "lower")
  expect(f.store.usageBudgets.view({ botId: null }).available).toBe(0)
  expect(() => f.start(f.a.id, 1)).toThrow("额度已用尽")
})

it("persists limits and uncertain usage across restart, releasing rolling capacity only after the window", () => {
  const f = fixture()
  f.change(null, 50, "limit")
  f.start(f.a.id, 50)
  f.reopen()
  expect(f.store.usageBudgets.view({ botId: null })).toMatchObject({ revision: 1, available: 0 })
  f.advance(-60_000)
  expect(() => f.start(f.a.id, 1)).toThrow("额度已用尽")
  f.advance(60_000 + BOT_USAGE_WINDOW_MS)
  expect(() => f.start(f.a.id, 1)).toThrow("额度已用尽")
  f.advance(1)
  expect(f.store.usageBudgets.capacity(f.a.id, 100)).toBe(50)
  f.start(f.b.id, 50)
  expect(f.store.usageBudgets.view({ botId: null }).usage.requests).toBe(1)
  f.change(null, null, "unlimited")
  expect(f.store.usageBudgets.capacity(f.b.id, 100)).toBe(100)
  expect(f.store.usageBudgets.view({ botId: null }).available).toBeNull()
})

it("binds settings to scope, revision, restore epoch and the original receipt", () => {
  const f = fixture(),
    current = f.store.usageBudgets.view({ botId: f.a.id })
  const input = {
    botId: f.a.id,
    outputLimit: 50,
    revision: 0,
    nonce: "save",
    dataEpoch: current.dataEpoch
  }
  const saved = f.store.usageBudgets.change(input)
  f.change(f.a.id, 20, "later")
  expect(f.store.usageBudgets.change(input)).toEqual(saved)
  expect(f.store.usageBudgets.view({ botId: f.a.id }).outputLimit).toBe(20)
  expect(() => f.store.usageBudgets.change({ ...input, botId: f.b.id })).toThrow()
  expect(() => f.store.usageBudgets.change({ ...input, nonce: "stale" })).toThrow("设置已变化")
  expect(() => f.store.usageBudgets.change({ ...input, dataEpoch: "old-backup" })).toThrow(
    "数据已恢复"
  )
  for (const outputLimit of [-1, 1.5, NaN, Infinity, 1_000_000_001])
    expect(() => f.store.usageBudgets.change({ ...input, outputLimit })).toThrow("设置无效")
  expect(() => f.store.usageBudgets.change({ ...input, actor: "model" })).toThrow("设置无效")
  expect(() => f.store.usageBudgets.view({ botId: f.a.id, otherUser: "user" })).toThrow("范围无效")
  f.change(null, 0, "pause")
  expect(() => f.start(f.b.id, 1)).toThrow("额度已用尽")
})
