import { afterEach, expect, it, vi } from "vitest"
import {
  acknowledgePendingPluginPane,
  readPendingPluginPane,
  rememberPendingPluginPane
} from "./bot-plugin-pane-pending"
import type { BotPluginPaneAction } from "../../../shared/bot-plugin-panes"

afterEach(() => vi.unstubAllGlobals())
const input: BotPluginPaneAction = {
  botId: "owner",
  conversationId: "conversation",
  threadRootId: "branch",
  sessionId: "d38cdabe-3d4d-4a0c-8eae-2df32f227f35",
  target: "pane",
  action: {
    pane: "board",
    generation: "e38cdabe-3d4d-4a0c-8eae-2df32f227f35",
    plugin: "plugin",
    handle: 1,
    kind: "press",
    intentId: "original-intent-001"
  }
}

it("recovers the exact gesture, fences scopes and restores, and never clears a newer gesture", () => {
  const items = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key)
  })
  rememberPendingPluginPane(input, "epoch")
  expect(readPendingPluginPane(input, "epoch")).toEqual(input)
  for (const scope of [
    { ...input, botId: "other" },
    { ...input, conversationId: "other" },
    { ...input, threadRootId: undefined }
  ])
    expect(readPendingPluginPane(scope, "epoch")).toBeNull()
  expect(readPendingPluginPane(input, "restored")).toBeNull()
  const next = { ...input, action: { ...input.action, intentId: "following-intent-002" } }
  expect(() => rememberPendingPluginPane(next, "epoch")).toThrow("尚未确认")
  items.set([...items.keys()][0], JSON.stringify({ dataEpoch: "epoch", input: next }))
  acknowledgePendingPluginPane(input, "epoch")
  expect(readPendingPluginPane(input, "epoch")).toEqual(next)
  const key = [...items.keys()][0]
  for (const value of [
    JSON.stringify({ dataEpoch: "epoch", input: { ...input, botId: "foreign" } }),
    JSON.stringify({ dataEpoch: "epoch", input: { ...input, approved: true } }),
    "{".repeat(220_001)
  ]) {
    items.set(key, value)
    expect(readPendingPluginPane(input, "epoch")).toBeNull()
  }
  items.delete(key)
  rememberPendingPluginPane(next, "epoch")
  acknowledgePendingPluginPane(next, "epoch")
  expect(items.size).toBe(0)
})

it("does not dispatch without a durable gesture identity", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw Error("quota")
    }
  })
  expect(() => rememberPendingPluginPane(input, "epoch")).toThrow("尚未提交")
})
