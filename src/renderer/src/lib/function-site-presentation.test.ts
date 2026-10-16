import { afterEach, expect, it, vi } from "vitest"
import type { FunctionPaneSnapshot } from "../../../shared/mods/v2/ui"
import {
  FunctionSitePresentationCache,
  functionSitePresentationKey
} from "./function-site-presentation"

const drawing = (): FunctionPaneSnapshot => ({
  key: "engine:old-owner",
  id: "old-owner",
  plugin: "test",
  generation: "old-generation",
  title: "message",
  rows: 8,
  closeOnEscape: false,
  tree: {
    type: "Box",
    props: {},
    children: [
      { type: "engine", ref: 0 },
      { type: "Button", props: { label: "press" }, press: { plugin: "test", handle: 71 } },
      { type: "Link", props: { href: "https://example.com", label: "link" } }
    ]
  },
  nativeContent: {
    component: "AssistantMessage",
    entries: [{ ref: 0, props: { text: "protected", isFirstOfReply: true } }]
  }
})
const key = (id = "message", text = "raw", width = 800) =>
  functionSitePresentationKey(
    "thread",
    "AssistantMessage",
    id,
    JSON.stringify({ text, isFirstOfReply: true }),
    width
  )!

afterEach(() => vi.useRealTimers())

it("keeps a history row eligible for caching while another row streams", () => {
  const cache = new FunctionSitePresentationCache(() => true)
  const history = cache.capture("AssistantMessage", key("history"), "history-row")
  const stream = cache.capture("AssistantMessage", key("stream"), "stream-row")
  cache.invalidateKey(key("stream"), false, "stream-row")
  expect(stream()).toBe(false)
  expect(history()).toBe(true)
  cache.save(key("history"), "AssistantMessage", drawing(), 367, history)
  expect(cache.read(key("history"))?.presentation.height).toBe(367)
  const replacement = cache.capture("AssistantMessage", key("stream"), "stream-row")
  expect(replacement()).toBe(true)
  expect(stream()).toBe(false)
  cache.invalidate("AssistantMessage")
  expect(history()).toBe(false)
  expect(replacement()).toBe(false)
})

it("bounds row admission metadata and never revives evicted row tickets", () => {
  const cache = new FunctionSitePresentationCache(() => true)
  const first = cache.capture("AssistantMessage", key(), "row-0")
  for (let i = 1; i < 1200; i++)
    cache.capture("AssistantMessage", key(String(i), "x".repeat(3000)), `row-${i}`)
  expect(first()).toBe(false)
  expect(cache.capture("AssistantMessage", key(), "row-0")()).toBe(true)
  expect(first()).toBe(false)
  const maps = Object.values(cache).filter(value => value instanceof Map)
  expect(maps.reduce((sum, map) => sum + map.size, 0)).toBeLessThanOrEqual(96)
  expect(maps.flatMap(map => [...map.keys()]).some(stored =>
    typeof stored === "string" && stored.includes("x".repeat(3000)))).toBe(false)
})

it("keeps exact protected drawing data and geometry without executable drawing identities", () => {
  const cache = new FunctionSitePresentationCache(() => true)
  cache.save(key(), "AssistantMessage", drawing(), 367, cache.capture("AssistantMessage"))
  const cached = cache.read(key())!
  expect(cached.current()).toBe(true)
  expect(cached.presentation.height).toBe(367)
  const saved = JSON.stringify(cached.presentation)
  for (const forbidden of ["old-owner", "old-generation", "handle", '"press"', '"href"'])
    expect(saved).not.toContain(forbidden === '"press"' ? '"press":' : forbidden)
  expect(saved).toContain("protected")
  expect(cache.read(key("other"))).toBeNull()
  expect(cache.read(key("message", "changed"))).toBeNull()
  expect(cache.read(key("message", "raw", 801))).toBeNull()
  expect(functionSitePresentationKey("thread", "AssistantMessage", undefined, "{}", 800)).toBeNull()
  expect(functionSitePresentationKey("thread", "AbovePrompt", "message", "{}", 800)).toBeNull()
})

it("revokes existing observations and rejects late reads across component or authority changes", () => {
  let authorized = true
  const cache = new FunctionSitePresentationCache(() => authorized)
  const ticket = cache.capture("AssistantMessage")
  cache.save(key(), "AssistantMessage", drawing(), 20, ticket)
  const observation = cache.read(key())!
  cache.invalidate("UserMessage")
  expect(observation.current()).toBe(true)
  cache.invalidate("AssistantMessage")
  expect(observation.current()).toBe(false)
  cache.save(key(), "AssistantMessage", drawing(), 20, ticket)
  expect(cache.read(key())).toBeNull()
  cache.save(key(), "AssistantMessage", drawing(), 20, cache.capture("AssistantMessage"))
  authorized = false
  expect(cache.read(key())).toBeNull()
})

it("fences older reads while removing only the changed entry and preserving unrelated history", () => {
  const cache = new FunctionSitePresentationCache(() => true)
  const first = key("first"),
    other = key("other")
  const firstTicket = cache.capture("AssistantMessage", first)
  const otherTicket = cache.capture("AssistantMessage", other)
  cache.save(first, "AssistantMessage", drawing(), 20, firstTicket)
  cache.save(other, "AssistantMessage", drawing(), 20, otherTicket)
  const observation = cache.read(first)!
  cache.invalidateKey(first)
  expect(observation.current()).toBe(false)
  expect(firstTicket()).toBe(false)
  expect(otherTicket()).toBe(false)
  expect(cache.read(first)).toBeNull()
  expect(cache.read(other)).not.toBeNull()
})

it("bounds metadata after thousands of distinct facts and never revives old read admission", () => {
  const cache = new FunctionSitePresentationCache(() => true)
  const firstKey = key("first", "original")
  const firstTicket = cache.capture("AssistantMessage", firstKey)
  const keptKey = key("kept")
  cache.save(keptKey, "AssistantMessage", drawing(), 20, cache.capture("AssistantMessage"))
  const kept = cache.read(keptKey)!
  for (let index = 0; index < 1200; index++) {
    const changed = key("stream", String(index) + "x".repeat(3000))
    const candidate = cache.capture("AssistantMessage", changed)
    cache.save(changed, "AssistantMessage", drawing(), 20, candidate)
    cache.invalidateKey(changed, false)
    expect(candidate()).toBe(false)
    expect(cache.read(changed)).toBeNull()
    // Independent history remains cached while other entries repeatedly pass through LRU.
    cache.save(
      key(String(index)),
      "AssistantMessage",
      drawing(),
      20,
      cache.capture("AssistantMessage")
    )
    expect(cache.read(keptKey)).not.toBeNull()
  }
  expect(kept.current()).toBe(true)
  expect(firstTicket()).toBe(false)
  cache.save(firstKey, "AssistantMessage", drawing(), 20, firstTicket)
  expect(cache.read(firstKey)).toBeNull()
  const freshTicket = cache.capture("AssistantMessage", firstKey)
  cache.save(firstKey, "AssistantMessage", drawing(), 20, freshTicket)
  expect(cache.read(firstKey)).not.toBeNull()
  expect(firstTicket()).toBe(false)
  // Include metadata as well as the byte/entry-bounded drawing store in this audit.
  const maps = Object.values(cache).filter((value) => value instanceof Map)
  expect(maps.reduce((sum, map) => sum + map.size, 0)).toBeLessThanOrEqual(97)
  expect(
    maps
      .flatMap((map) => [...map.keys()])
      .some((stored) => typeof stored === "string" && stored.includes("x".repeat(3000)))
  ).toBe(false)
})

it("bounds retained bytes, entries and age and never caches a Client instance", () => {
  vi.useFakeTimers()
  const cache = new FunctionSitePresentationCache(() => true)
  for (let index = 0; index < 97; index++)
    cache.save(
      key(String(index)),
      "AssistantMessage",
      drawing(),
      20,
      cache.capture("AssistantMessage")
    )
  expect(cache.read(key("0"))).toBeNull()
  expect(cache.read(key("96"))).not.toBeNull()
  const oversized = drawing()
  oversized.tree = { type: "Text", props: {}, children: ["x".repeat(128 * 1024)] }
  cache.save(key("oversized"), "AssistantMessage", oversized, 20, cache.capture("AssistantMessage"))
  expect(cache.read(key("oversized"))).toBeNull()
  const byteBound = new FunctionSitePresentationCache(() => true)
  const larger = drawing()
  larger.tree = { type: "Text", props: {}, children: ["x".repeat(25000)] }
  for (let index = 0; index < 50; index++)
    byteBound.save(
      key(String(index)),
      "AssistantMessage",
      larger,
      20,
      byteBound.capture("AssistantMessage")
    )
  expect(byteBound.read(key("0"))).toBeNull()
  expect(byteBound.read(key("49"))).not.toBeNull()
  const client = drawing()
  client.tree = { type: "Client", props: { key: "client" }, client: { plugin: "test" } }
  cache.save(key("client"), "AssistantMessage", client, 20, cache.capture("AssistantMessage"))
  expect(cache.read(key("client"))).toBeNull()
  const observation = cache.read(key("96"))!
  vi.advanceTimersByTime(120001)
  expect(observation.current()).toBe(false)
  expect(cache.read(key("96"))).toBeNull()
})
