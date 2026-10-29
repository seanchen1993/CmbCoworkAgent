import { afterEach, expect, it, vi } from "vitest"
import type { FunctionPaneSnapshot } from "../../../shared/mods/v2/ui"
import { functionSitePresentationBudget as budget } from "./function-site-presentation-budget"
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

it("keeps neutral measured heights after drawing LRU eviction, with exact facts and width", () => {
  const cache = new FunctionSitePresentationCache(() => true)
  const measuredKey = key("measured")
  cache.measure(measuredKey, "AssistantMessage", { height: 1391, width: 720, layoutWidth: 720 }, "host-row")
  cache.save(measuredKey, "AssistantMessage", drawing(), 1391, cache.capture("AssistantMessage"))
  for (let index = 0; index < 110; index++)
    cache.save(key(`other-${index}`), "AssistantMessage", drawing(), 20,
      cache.capture("AssistantMessage"))
  expect(cache.read(measuredKey)).toBeNull()
  expect(cache.measuredHeight(measuredKey, 720)).toBe(1391)
  expect(cache.measuredHeight(measuredKey, 640)).toBeUndefined()
  expect(cache.measuredHeight(measuredKey, Number.NaN)).toBeUndefined()
  expect(cache.measuredHeight(key("measured", "changed"), 720)).toBeUndefined()
  const retained = JSON.stringify([...cache["measurements"].values()])
  expect(retained).not.toContain("protected")
  expect(retained).not.toContain("old-owner")
  cache.invalidateProjection("host-row")
  expect(cache.measuredHeight(measuredKey, 720)).toBeUndefined()
  cache.invalidate()
})

it("expires and revokes neutral measurements on row, component and capability changes", () => {
  vi.useFakeTimers()
  let authorized = true
  const cache = new FunctionSitePresentationCache(() => authorized)
  const save = () => cache.measure(key(), "AssistantMessage",
    { height: 320, width: 600, layoutWidth: 600 })
  save()
  cache.invalidate("UserMessage")
  expect(cache.measuredHeight(key(), 600)).toBe(320)
  cache.invalidateKey(key())
  expect(cache.measuredHeight(key(), 600)).toBeUndefined()
  save()
  cache.invalidate("AssistantMessage")
  expect(cache.measuredHeight(key(), 600)).toBeUndefined()
  save()
  authorized = false
  expect(cache.measuredHeight(key(), 600)).toBeUndefined()
  authorized = true
  vi.advanceTimersByTime(120001)
  expect(cache.measuredHeight(key(), 600)).toBeUndefined()
  cache.invalidate()
})

it("bounds neutral measurements within the renderer budget and rejects invalid dimensions", () => {
  const cache = new FunctionSitePresentationCache(() => true)
  for (let index = 0; index < 4000; index++) {
    cache.measure(key(String(index)), "AssistantMessage",
      { height: index + 1, width: 600, layoutWidth: 600 })
    expect(budget.stats().bytes).toBeLessThanOrEqual(budget.stats().maxBytes)
  }
  expect(cache["measurements"].size).toBeLessThanOrEqual(1536)
  expect(cache.measuredHeight(key("0"), 600)).toBeUndefined()
  expect(cache.measuredHeight(key("3999"), 600)).toBe(4000)
  for (const height of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY, 100001])
    cache.measure(key("invalid"), "AssistantMessage", { height, width: 600, layoutWidth: 600 })
  expect(cache.measuredHeight(key("invalid"), 600)).toBeUndefined()
  cache.invalidate()
})

it("retains only the input digest in protected presentation cache keys", () => {
  const cache = new FunctionSitePresentationCache(() => true)
  const raw = "PRIVATE_UNPUBLISHED_BODY_" + "秘密😀".repeat(16384)
  const input = JSON.stringify({ text: raw, isFirstOfReply: true })
  const cacheKey = functionSitePresentationKey("thread", "AssistantMessage", "message", input, 800)!
  expect(JSON.parse(cacheKey)[3]).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(cacheKey.length).toBeLessThan(160)
  const ticket = cache.capture("AssistantMessage", cacheKey, "message")
  cache.save(cacheKey, "AssistantMessage", drawing(), 367, ticket)
  expect(cache.read(cacheKey)?.presentation.nativeContent?.entries[0].props.text).toBe("protected")
  const retained = Object.values(cache)
    .filter((value) => value instanceof Map)
    .flatMap((map) => [...map.keys(), ...map.values()])
  expect(JSON.stringify(retained)).not.toContain("PRIVATE_UNPUBLISHED_BODY_")
  expect(JSON.stringify(retained)).not.toContain(input)
  expect(cache.read(key("message", raw, 801))).toBeNull()
  expect(cache.read(key("different", raw))).toBeNull()
  expect(cache.read(key("message", raw + "changed"))).toBeNull()
  expect(functionSitePresentationKey("thread", "AssistantMessage", "message", input, 800)).toBe(
    cacheKey
  )
  expect(
    functionSitePresentationKey("thread", "AssistantMessage", "message", "\ud800", 800)
  ).not.toBe(functionSitePresentationKey("thread", "AssistantMessage", "message", "\ufffd", 800))
})

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
  const maps = Object.values(cache).filter((value) => value instanceof Map)
  expect(maps.reduce((sum, map) => sum + map.size, 0)).toBeLessThanOrEqual(96)
  expect(
    maps
      .flatMap((map) => [...map.keys()])
      .some((stored) => typeof stored === "string" && stored.includes("x".repeat(3000)))
  ).toBe(false)
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
  const beforeOtherCache = cache.read(key("96"))!
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
  expect(beforeOtherCache.current()).toBe(false)
  const client = drawing()
  client.tree = { type: "Client", props: { key: "client" }, client: { plugin: "test" } }
  cache.save(key("client"), "AssistantMessage", client, 20, cache.capture("AssistantMessage"))
  expect(cache.read(key("client"))).toBeNull()
  cache.save(key("fresh-age"), "AssistantMessage", drawing(), 20, cache.capture("AssistantMessage"))
  const observation = cache.read(key("fresh-age"))!
  vi.advanceTimersByTime(120001)
  expect(observation.current()).toBe(false)
  expect(cache.read(key("fresh-age"))).toBeNull()
})

it("shares one renderer byte budget across caches, evicts by row recency and notifies only the evicted key", () => {
  const before = budget.stats().bytes
  const first = new FunctionSitePresentationCache(() => true)
  const second = new FunctionSitePresentationCache(() => true)
  const large = drawing()
  large.tree = { type: "Text", props: {}, children: ["x".repeat(40000)] }
  const save = (cache: FunctionSitePresentationCache, id: string) =>
    cache.save(key(id), "AssistantMessage", large, 20, cache.capture("AssistantMessage"))
  save(first, "global-cold")
  save(first, "global-hot")
  const cold = first.read(key("global-cold"))!
  const hot = first.read(key("global-hot"))!
  const coldChanged = vi.fn(),
    hotChanged = vi.fn(),
    unrelatedChanged = vi.fn()
  first.subscribe(coldChanged, key("global-cold"))
  first.subscribe(hotChanged, key("global-hot"))
  second.subscribe(unrelatedChanged, key("unrelated"))
  try {
    for (let index = 0; index < 36; index++) {
      save(second, "global-other-" + index)
      expect(first.read(key("global-hot"))).not.toBeNull()
      expect(budget.stats().bytes).toBeLessThanOrEqual(2 * 1024 * 1024)
    }
    expect(cold.current()).toBe(false)
    expect(first.read(key("global-cold"))).toBeNull()
    expect(hot.current()).toBe(true)
    expect(coldChanged).toHaveBeenCalledOnce()
    expect(hotChanged).not.toHaveBeenCalled()
    expect(unrelatedChanged).not.toHaveBeenCalled()
    // Releasing either provider returns its passive records to the shared budget.
    const occupied = budget.stats().bytes
    first.invalidate()
    expect(hot.current()).toBe(false)
    expect(budget.stats().bytes).toBeLessThan(occupied)
  } finally {
    first.invalidate()
    second.invalidate()
  }
  expect(budget.stats().bytes).toBeLessThanOrEqual(before)
})

it("charges admission and invalidation metadata across providers and revokes evicted pending proofs", () => {
  const before = budget.stats().bytes
  const caches: FunctionSitePresentationCache[] = []
  const old = new FunctionSitePresentationCache(() => true)
  caches.push(old)
  const ticket = old.capture("AssistantMessage", null, "old-row-" + "x".repeat(1900))
  const read = old.captureProjectionRead()
  old.invalidateProjection("old-projection")
  try {
    for (let scope = 0; scope < 12; scope++) {
      const cache = new FunctionSitePresentationCache(() => true)
      caches.push(cache)
      for (let row = 0; row < 96; row++) {
        cache.capture("AssistantMessage", null, `${scope}:${row}:` + "x".repeat(1900))
        cache.invalidateProjection(`${scope}:${row}:` + "h".repeat(200))
      }
      expect(budget.stats().bytes).toBeLessThanOrEqual(2 * 1024 * 1024)
    }
    expect(ticket()).toBe(false)
    expect(read("old-projection")).toBe(false)
    expect(read("unrelated")).toBe(false) // Evicted log coverage cannot authorize an old read.
    expect(old.captureProjectionRead()("unrelated")).toBe(true)
  } finally {
    for (const cache of caches) cache.invalidate()
  }
  expect(budget.stats().bytes).toBeLessThanOrEqual(before)
})

it("retains passive projection data without constructing an interaction snapshot", () => {
  const cache = new FunctionSitePresentationCache(() => true)
  const current = cache.capture("AssistantMessage", key(), "row")
  const data = {
    component: "AssistantMessage" as const,
    nativeContent: {
      component: "AssistantMessage" as const,
      entries: [{ ref: 0, props: { text: "protected", isFirstOfReply: true } }]
    }
  }
  cache.saveData(key(), data, 200, current, 640)
  data.nativeContent.entries[0].props.text = "later mutation"
  const cached = cache.read(key())!
  expect(cached.presentation.tree).toEqual({ type: "engine", ref: 0 })
  expect(cached.presentation.nativeContent?.entries[0].props.text).toBe("protected")
  for (const field of ["owner", "generation", "press", "clients", "markdownLinks"])
    expect(JSON.stringify(cached.presentation)).not.toContain(`"${field}"`)
  cache.invalidate("AssistantMessage")
  expect(cached.current()).toBe(false)
  cache.saveData(key(), data, 200, current)
  expect(cache.read(key())).toBeNull()
  expect(() =>
    cache.saveData(
      key(),
      {
        component: "AssistantMessage",
        tree: {
          type: "Button",
          props: { key: "active", label: "active" },
          press: { plugin: "x", handle: 1 }
        }
      },
      1,
      cache.capture("AssistantMessage")
    )
  ).toThrow("MODS_DISPLAY_DATA_ACTIVE")
})

function releasePreviousBudgetRecords(): void {
  const primer = new FunctionSitePresentationCache(() => true)
  const data = {
    component: "AssistantMessage" as const,
    hostMessage: { text: "x".repeat(60000), isFirstOfReply: true }
  }
  for (let index = 0; index < 24; index++)
    primer.saveData(key("primer-" + index), data, 20, primer.capture("AssistantMessage"))
  primer.invalidate()
  expect(budget.stats().bytes).toBe(0)
}

it("does not register a phantom budget record when another cache's eviction subscriber invalidates its producer", () => {
  releasePreviousBudgetRecords()
  const first = new FunctionSitePresentationCache(() => true)
  const producer = new FunctionSitePresentationCache(() => true)
  const data = {
    component: "AssistantMessage" as const,
    hostMessage: { text: "x".repeat(60000), isFirstOfReply: true }
  }
  first.saveData(key("victim"), data, 20, first.capture("AssistantMessage"))
  let notified = 0
  const stop = first.subscribe(() => {
    notified++
    producer.invalidate()
  }, key("victim"))
  try {
    for (let index = 0; index < 24 && !notified; index++)
      producer.saveData(key("producer-" + index), data, 20, producer.capture("AssistantMessage"))
    expect(notified).toBe(1)
  } finally {
    stop()
    first.invalidate()
    producer.invalidate()
  }
  expect(budget.stats()).toMatchObject({ bytes: 0, records: 0 })
})

it("rejects synchronous eviction-subscriber writeback and uncharged metadata across two caches", () => {
  releasePreviousBudgetRecords()
  const first = new FunctionSitePresentationCache(() => true)
  const second = new FunctionSitePresentationCache(() => true)
  const data = {
    component: "AssistantMessage" as const,
    hostMessage: { text: "x".repeat(60000), isFirstOfReply: true }
  }
  first.saveData(key("refill-victim"), data, 20, first.capture("AssistantMessage"))
  const pending = second.captureProjectionRead()
  let notified = 0,
    callbackTicket: (() => boolean) | undefined
  const stop = first.subscribe(() => {
    notified++
    second.saveData(key("callback-refill"), data, 20, second.capture("AssistantMessage"))
    callbackTicket = second.capture("AssistantMessage", null, "callback-admission")
    second.invalidateProjection("callback-state-change")
  }, key("refill-victim"))
  try {
    for (let index = 0; index < 24 && !notified; index++)
      second.saveData(key("refill-producer-" + index), data, 20, second.capture("AssistantMessage"))
    expect(notified).toBe(1)
    expect(second.read(key("callback-refill"))).toBeNull()
    expect(callbackTicket?.()).toBe(false)
    expect(pending("callback-state-change")).toBe(false)
    expect(budget.stats().bytes).toBeLessThanOrEqual(2 * 1024 * 1024)
    // Normal writes resume after the observer fence; the refusal does not disable this scope.
    second.saveData(key("after-observer"), data, 20, second.capture("AssistantMessage"))
    expect(second.read(key("after-observer"))).not.toBeNull()
  } finally {
    stop()
    first.invalidate()
    second.invalidate()
  }
  expect(budget.stats()).toMatchObject({ bytes: 0, records: 0 })
})

it("finishes reciprocal scope invalidation once without recursive notifications or retained records", () => {
  releasePreviousBudgetRecords()
  const first = new FunctionSitePresentationCache(() => true)
  const second = new FunctionSitePresentationCache(() => true)
  first.save(
    key("reciprocal-first"),
    "AssistantMessage",
    drawing(),
    20,
    first.capture("AssistantMessage")
  )
  second.save(
    key("reciprocal-second"),
    "AssistantMessage",
    drawing(),
    20,
    second.capture("AssistantMessage")
  )
  const firstChanged = vi.fn(() => second.invalidate())
  const secondChanged = vi.fn(() => first.invalidate())
  const stopFirst = first.subscribe(firstChanged)
  const stopSecond = second.subscribe(secondChanged)
  try {
    first.invalidate()
    expect(firstChanged).toHaveBeenCalledOnce()
    expect(secondChanged).toHaveBeenCalledOnce()
    expect(budget.stats()).toMatchObject({ bytes: 0, records: 0 })
  } finally {
    stopFirst()
    stopSecond()
    first.invalidate()
    second.invalidate()
  }
})

it("notifies a different exact key revoked reentrantly even if its subscriber was visited earlier", () => {
  const cache = new FunctionSitePresentationCache(() => true)
  const data = {
    component: "AssistantMessage" as const,
    tree: { type: "Text" as const, props: {}, children: ["safe"] }
  }
  cache.saveData(
    key("nested-first"),
    data,
    20,
    cache.capture("AssistantMessage"),
    0,
    "nested-host-first"
  )
  cache.saveData(
    key("nested-second"),
    data,
    20,
    cache.capture("AssistantMessage"),
    0,
    "nested-host-second"
  )
  const second = cache.read(key("nested-second"))!
  const changedSecond = vi.fn()
  cache.subscribe(changedSecond, key("nested-second"))
  cache.subscribe(() => cache.invalidateProjection("nested-host-second"), key("nested-first"))
  cache.invalidateProjection("nested-host-first")
  expect(second.current()).toBe(false)
  expect(changedSecond).toHaveBeenCalledOnce()
  cache.invalidate()
})

it("caches bounded host message props without an empty engine frame or an interaction identity", () => {
  const cache = new FunctionSitePresentationCache(() => true)
  const data = {
    component: "AssistantMessage" as const,
    hostMessage: { text: "protected host body".repeat(700), isFirstOfReply: true }
  }
  cache.saveData(key(), data, 300, cache.capture("AssistantMessage"), 800, "host-message")
  data.hostMessage.text = "mutated after publication"
  const cached = cache.read(key())!
  expect(cached.presentation.tree).toBeUndefined()
  expect(cached.presentation.nativeContent).toBeUndefined()
  expect(cached.presentation.hostMessage?.text).toBe("protected host body".repeat(700))
  expect(cached.hostKey).toBe("host-message")
  for (const field of ["owner", "generation", "press", "clients", "markdownLinks"])
    expect(JSON.stringify(cached.presentation)).not.toContain(`"${field}"`)
  cache.invalidateProjection("host-message")
  expect(cached.current()).toBe(false)
  expect(cache.read(key())).toBeNull()
  cache.saveData(
    key("oversize-host"),
    { ...data, hostMessage: { text: "x".repeat(70000), isFirstOfReply: true } },
    300,
    cache.capture("AssistantMessage")
  )
  expect(cache.read(key("oversize-host"))).toBeNull()
  expect(() =>
    cache.saveData(
      key(),
      {
        component: "AssistantMessage",
        hostMessage: { text: "body", isFirstOfReply: true, handle: 1 }
      },
      1,
      cache.capture("AssistantMessage")
    )
  ).toThrow("MODS_UI_SITE_PROPS")
})

it("invalidates only entries and subscribers with the exact host projection key", () => {
  const cache = new FunctionSitePresentationCache(() => true)
  const data = {
    component: "AssistantMessage" as const,
    tree: { type: "Text" as const, props: {}, children: ["protected"] }
  }
  const first = key("first"),
    second = key("second"),
    legacy = key("legacy")
  cache.saveData(first, data, 20, cache.capture("AssistantMessage"), 0, "host-first")
  cache.saveData(second, data, 20, cache.capture("AssistantMessage"), 0, "host-second")
  cache.save(legacy, "AssistantMessage", drawing(), 20, cache.capture("AssistantMessage"))
  const oldFirst = cache.read(first)!,
    other = cache.read(second)!,
    oldLegacy = cache.read(legacy)!
  const firstChanged = vi.fn(),
    secondChanged = vi.fn(),
    legacyChanged = vi.fn()
  cache.subscribe(firstChanged, first)
  cache.subscribe(secondChanged, second)
  cache.subscribe(legacyChanged, legacy)
  const pending = cache.captureProjectionRead()
  cache.invalidateProjection("host-first")
  expect(oldFirst.current()).toBe(false)
  expect(other.current()).toBe(true)
  expect(oldLegacy.current()).toBe(true)
  expect(firstChanged).toHaveBeenCalledOnce()
  expect(secondChanged).not.toHaveBeenCalled()
  expect(legacyChanged).not.toHaveBeenCalled()
  expect(pending("host-first")).toBe(false)
  expect(pending("host-second")).toBe(true)
  expect(cache.captureProjectionRead()("host-first")).toBe(true)
  expect(cache.matchesProjection(second, "host-second")).toBe(true)
  expect(cache.matchesProjection(second, "host-first")).toBe(false)
  cache.invalidate()
  expect(other.current()).toBe(false)
  expect(oldLegacy.current()).toBe(false)
  expect(pending("host-second")).toBe(false)
})

it("bounds unknown-key invalidation history without reviving an older pending read", () => {
  const cache = new FunctionSitePresentationCache(() => true)
  const old = cache.captureProjectionRead()
  cache.invalidateProjection("earliest")
  for (let i = 0; i < 96; i++) cache.invalidateProjection("later-" + i)
  expect(old("earliest")).toBe(false)
  expect(old("unrelated")).toBe(false) // Lost log coverage is conservative only for already-pending work.
  const fresh = cache.captureProjectionRead()
  expect(fresh("earliest")).toBe(true)
  expect(fresh("unrelated")).toBe(true)
  expect(
    Object.values(cache)
      .filter((value) => value instanceof Map)
      .reduce((sum, map) => sum + map.size, 0)
  ).toBeLessThanOrEqual(96)
})
