import { afterEach, describe, expect, it, vi } from "vitest"
import { RetainedFunctionSiteCaches } from "./function-site-retained-cache"
import type { CachedFunctionSitePresentation } from "./function-site-presentation"
import { FUNCTION_PASSIVE_DISPLAY_SITES } from "../../../shared/mods/v2/sites"

function fixture(maximum = 8) {
  const listeners = new Map<string, Set<(event?: unknown) => void>>()
  const subscribe =
    (name: string) =>
    <T>(listener: (event: T) => void) => {
      const set = listeners.get(name) ?? new Set()
      listeners.set(name, set)
      const invoke = (event?: unknown) => listener(event as T)
      set.add(invoke)
      return () => {
        set.delete(invoke)
      }
    }
  const caches = new RetainedFunctionSiteCaches(
    {
      configuration: subscribe("config"),
      cards: subscribe("cards"),
      threads: subscribe("threads"),
      account: subscribe("account"),
      localConfiguration: subscribe("local")
    },
    maximum,
    1000
  )
  const save = (lease: ReturnType<typeof caches.acquire>, key = "body") => {
    lease.cache.saveData(
      key,
      {
        component: "AssistantMessage",
        tree: { type: "Text", props: {}, children: ["protected body"] }
      },
      100,
      lease.cache.capture("AssistantMessage"),
      600,
      "host-body"
    )
    return lease.cache.read(key)!
  }
  return {
    caches,
    save,
    emit: (name: string, event?: unknown) => {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(event)
    },
    subscribers: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("passive presentation retention between mounted chat views", () => {
  it.each(FUNCTION_PASSIVE_DISPLAY_SITES)("revokes dormant %s on its component redraw", component => {
    vi.useFakeTimers()
    const f = fixture()
    const lease = f.caches.acquire("A", "workspace")
    lease.cache.saveData("body", { component,
      tree: { type: "Text", props: {}, children: ["old protected result"] } },
    100, lease.cache.capture(component), 600, "host-" + component)
    const body = lease.cache.read("body")!
    expect(body).not.toBeNull()
    lease.release()
    f.emit("cards", { threadId: "A", scope: `site-presentations:${component}` })
    expect(body.current()).toBe(false)
    const replacement = f.caches.acquire("A", "workspace")
    expect(replacement.cache.read("body")).toBeNull()
    replacement.revoke()
    expect(f.subscribers()).toBe(0)
  })

  it("keeps drawings without keeping old view callbacks or owners", () => {
    vi.useFakeTimers()
    const f = fixture()
    const original = f.caches.acquire("A", "workspace")
    const body = f.save(original)
    original.release()
    const replacement = f.caches.acquire("A", "workspace")
    expect(replacement.cache).toBe(original.cache)
    expect(body.current()).toBe(true)
    expect(replacement.cache.read("body")?.presentation.tree).toEqual({
      type: "Text",
      props: {},
      children: ["protected body"]
    })
    replacement.release()
    vi.advanceTimersByTime(1001)
    expect(body.current()).toBe(false)
    expect(f.subscribers()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("drops owner-dependent drawings at view release but keeps host projections and neutral geometry", () => {
    vi.useFakeTimers()
    const f = fixture()
    const lease = f.caches.acquire("A", "workspace")
    const projected = f.save(lease, "projected")
    lease.cache.save("owned", "AssistantMessage", {
      key: "owned", id: "owned", plugin: "fixture", title: "Owned drawing",
      generation: "old-generation", closeOnEscape: false, rows: 8,
      tree: { type: "Text", props: {}, children: ["old mutable state"] }
    }, 150, lease.cache.capture("AssistantMessage"), 600)
    lease.cache.measure("owned", "AssistantMessage", { height: 150, width: 600, layoutWidth: 600 })
    const owned = lease.cache.read("owned")!
    const pendingWrite = lease.cache.capture("AssistantMessage", "late", "old-row")
    expect(owned.current()).toBe(true)
    lease.release()
    expect(owned.current()).toBe(false)
    expect(pendingWrite()).toBe(false)
    const next = f.caches.acquire("A", "workspace")
    expect(next.cache.read("owned")).toBeNull()
    expect(projected.current()).toBe(true)
    expect(next.cache.measuredHeight("owned", 600)).toBe(150)
    next.revoke()
    expect(f.subscribers()).toBe(0)
  })

  it.each(["config", "account", "local", "threads"])("revokes dormant drawings on %s", (kind) => {
    vi.useFakeTimers()
    const f = fixture()
    const lease = f.caches.acquire("A", "workspace"),
      body = f.save(lease)
    lease.release()
    f.emit(kind)
    expect(body.current()).toBe(false)
    expect(f.subscribers()).toBe(0)
    const replacement = f.caches.acquire("A", "workspace")
    expect(replacement.cache.read("body")).toBeNull()
    replacement.revoke()
  })

  it("does not clear unrelated rows for another thread or schema changes", () => {
    vi.useFakeTimers()
    const f = fixture()
    const lease = f.caches.acquire("A", "workspace"),
      body = f.save(lease)
    lease.release()
    f.emit("config", { scope: "schema" })
    f.emit("cards", { threadId: "B", scope: "source-retiring:1" })
    f.emit("cards", { threadId: "A", scope: "placed" })
    expect(body.current()).toBe(true)
    f.emit("cards", { threadId: "A", scope: "site-projection:host-body" })
    expect(body.current()).toBe(false)
    vi.advanceTimersByTime(1001)
  })

  it("revokes the old directory before acquiring another directory for the same thread", () => {
    vi.useFakeTimers()
    const f = fixture()
    const lease = f.caches.acquire("A", "old"),
      body = f.save(lease)
    lease.release()
    const next = f.caches.acquire("A", "new")
    expect(body.current()).toBe(false)
    expect(next.cache.read("body")).toBeNull()
    next.revoke()
  })

  it("limits dormant entries and uses just one expiry timer", () => {
    vi.useFakeTimers()
    const f = fixture(2),
      retained: CachedFunctionSitePresentation[] = []
    for (let index = 0; index < 100; index++) {
      const lease = f.caches.acquire(String(index), "workspace")
      retained.push(f.save(lease))
      lease.release()
    }
    expect(retained.filter((body) => body.current())).toHaveLength(2)
    expect(f.subscribers()).toBe(5)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1001)
    expect(f.subscribers()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not share retry revocation between two simultaneously mounted panes", () => {
    vi.useFakeTimers()
    const f = fixture()
    const left = f.caches.acquire("A", "workspace"),
      leftBody = f.save(left)
    const right = f.caches.acquire("A", "workspace"),
      rightBody = f.save(right)
    expect(left.cache).not.toBe(right.cache)
    left.revoke()
    expect(leftBody.current()).toBe(false)
    expect(rightBody.current()).toBe(true)
    right.release()
    f.caches.discardDormant("A")
    expect(rightBody.current()).toBe(false)
    expect(f.subscribers()).toBe(0)
  })
})
