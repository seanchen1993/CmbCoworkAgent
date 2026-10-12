import { afterEach, expect, it, vi } from "vitest"
import type { ModCard } from "../../../shared/mods/types"
import { getModCards, subscribeModCards } from "./mod-cards-store"
import { createModsThreadScope } from "./mods-thread-scope"
const stops: (() => void)[] = []
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
afterEach(async () => {
  for (const stop of stops.splice(0)) stop()
  await flush()
  vi.unstubAllGlobals()
})
function card(label: string): ModCard {
  return {
    id: label,
    agentId: "agent",
    modId: "mod",
    name: label,
    threadId: "thread",
    callId: "call",
    nodes: [{ type: "text", text: label }]
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, no) => {
    resolve = ok
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture() {
  const callbacks = new Set<(event: { threadId: string }) => void>(),
    events = new EventTarget()
  const fetch = vi.fn(async (): Promise<ModCard[]> => [card("default")])
  vi.stubGlobal("window", {
    api: {
      mods: {
        cards: fetch,
        onCardsChanged: (callback: (event: { threadId: string }) => void) => {
          callbacks.add(callback)
          return () => callbacks.delete(callback)
        }
      }
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events)
  })
  return {
    fetch,
    callbacks,
    configure: () => events.dispatchEvent(new Event("mods:configuration-changed"))
  }
}
it("no scope installs no listeners and performs no reads", () => {
  const f = fixture()
  const stop = subscribeModCards(null, vi.fn())
  stop()
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.callbacks.size).toBe(0)
  const empty = getModCards(null)
  expect(getModCards(null)).toBe(empty)
})
it("shares one fetch across forty rows and preserves same-owner same-frame virtual remount", async () => {
  const f = fixture(),
    scope = createModsThreadScope("thread", "/a")!
  const mounted = Array.from({ length: 40 }, () => subscribeModCards(scope, vi.fn()))
  stops.push(...mounted)
  await flush()
  expect(f.fetch).toHaveBeenCalledTimes(1)
  expect(f.callbacks.size).toBe(1)
  for (const stop of mounted) stop()
  const reattach = subscribeModCards(scope, vi.fn())
  stops.push(reattach)
  await flush()
  expect(f.fetch).toHaveBeenCalledTimes(1)
  reattach()
  f.configure()
  expect(f.fetch).toHaveBeenCalledTimes(1)
  await flush()
  expect(f.callbacks.size).toBe(0)
  f.configure()
  expect(f.fetch).toHaveBeenCalledTimes(1)
})
it("retires an in-flight owner's queued refresh and does not publish it into a new workspace", async () => {
  const f = fixture(),
    a = createModsThreadScope("thread", "/a")!,
    b = createModsThreadScope("thread", "/b")!,
    old = deferred<ModCard[]>()
  f.fetch.mockImplementationOnce(() => old.promise).mockResolvedValueOnce([card("B")])
  stops.push(subscribeModCards(a, vi.fn()))
  f.configure()
  stops.push(subscribeModCards(b, vi.fn()))
  await flush()
  expect(getModCards(a)).toEqual([])
  expect(getModCards(b)[0].name).toBe("B")
  old.resolve([card("old A")])
  await flush()
  expect(f.fetch).toHaveBeenCalledTimes(2)
  expect(getModCards(b)[0].name).toBe("B")
})
it("rejects a late A result even after the same thread returns to A with a fresh owner", async () => {
  const f = fixture(),
    old = deferred<ModCard[]>(),
    a = createModsThreadScope("thread", "/a")!,
    b = createModsThreadScope("thread", "/b")!,
    returned = createModsThreadScope("thread", "/a")!
  f.fetch
    .mockImplementationOnce(() => old.promise)
    .mockResolvedValueOnce([card("B")])
    .mockResolvedValueOnce([card("new A")])
  stops.push(
    subscribeModCards(a, vi.fn()),
    subscribeModCards(b, vi.fn()),
    subscribeModCards(returned, vi.fn())
  )
  await flush()
  old.reject(new Error("old denied"))
  await flush()
  expect(getModCards(returned)[0].name).toBe("new A")
  expect(getModCards(a)).toEqual([])
  expect(f.callbacks.size).toBe(1)
})
it("keeps one current listener across two hundred scope changes and releases the final entry", async () => {
  const f = fixture()
  let stop = () => {}
  for (let index = 0; index < 200; index++) {
    stop()
    stop = subscribeModCards(createModsThreadScope("thread", "/" + index)!, vi.fn())
    expect(f.callbacks.size).toBe(1)
  }
  stops.push(stop)
  await flush()
  stop()
  await flush()
  expect(f.callbacks.size).toBe(0)
  const previous = f.fetch.mock.calls.length
  f.configure()
  expect(f.fetch).toHaveBeenCalledTimes(previous)
})
