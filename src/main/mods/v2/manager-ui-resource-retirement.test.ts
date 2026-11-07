import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import { FunctionModsManager } from "./manager"
import { FunctionDesktopNotifications } from "./desktop-notify"
import { FunctionUiResolveMainQuota } from "./ui-resolve-main-quota"
import { FunctionUiResolveHostLifetime } from "./ui-resolve-host-lifetime"

interface Entry {
  workspace: string
  threadId: string
  loading: Promise<void>
  client: { stopAndDrain(): Promise<void> }
  activity: { resume(): void }
  session: { close(): Promise<void>; assertRetirementComplete(): void }
}

interface Inspection {
  closed: boolean
  sessions: Map<string, Entry>
  pendingSessionBuilds: Map<string, object>
  runtimeReservations: Map<string, object>
  endingEntries: Map<string, object>
  candidates: Set<Entry>
  retiringEntries: Set<Entry>
  entryDrains: WeakMap<Entry, Promise<void>>
  uiResolveQuotas: Map<string, FunctionUiResolveMainQuota>
  desktopNotifiers: Map<string, FunctionDesktopNotifications>
  reclaimIdleUiResources(): void
  drainEntry(entry: Entry): Promise<void>
  prepareEnd(reason: "clear", threadId: string): { finish(): void }
}

const key = JSON.stringify(["workspace", "thread"])
const context = () => ({
  signal: new AbortController().signal,
  lifetime: new AbortController().signal,
  enabled: () => true,
  assertLive() {}
})

function fixture() {
  // Exercise the actual manager retirement methods without booting Electron or compiling guests.
  const manager = Object.assign(Object.create(FunctionModsManager.prototype), {
    closed: false,
    sessions: new Map(),
    pendingSessionBuilds: new Map(),
    runtimeReservations: new Map(),
    endingEntries: new Map(),
    endingRequests: new Set(),
    candidates: new Set(),
    retiringEntries: new Set(),
    entryDrains: new WeakMap(),
    uiResolveQuotas: new Map(),
    desktopNotifiers: new Map(),
    publishConfigurationIdle: vi.fn()
  }) as Inspection
  const quota = new FunctionUiResolveMainQuota()
  manager.uiResolveQuotas.set(key, quota)
  const entry: Entry = {
    workspace: "workspace",
    threadId: "thread",
    loading: Promise.resolve(),
    client: { stopAndDrain: async () => {} },
    activity: { resume() {} },
    session: { close: async () => {}, assertRetirementComplete() {} }
  }
  return { manager, quota, entry }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it("reclaims idle quotas after a confirmed physical and session retirement", async () => {
  const f = fixture()
  const close = vi.spyOn(f.quota, "close")
  await f.manager.drainEntry(f.entry)
  expect(f.manager.retiringEntries.size).toBe(0)
  expect(f.manager.uiResolveQuotas.size).toBe(0)
  expect(close).toHaveBeenCalledOnce()
})

it("reclaims the scope when an ending receipt finishes after its owner already drained", async () => {
  const f = fixture()
  f.manager.sessions.set(key, f.entry)
  const end = f.manager.prepareEnd("clear", "thread")
  f.manager.sessions.delete(key)
  await f.manager.drainEntry(f.entry)
  expect(f.manager.uiResolveQuotas.get(key)).toBe(f.quota)
  end.finish()
  expect(f.manager.endingEntries.size).toBe(0)
  expect(f.manager.uiResolveQuotas.size).toBe(0)
})

it("keeps retired scope containers and idle timers bounded across 1000 completed sessions", async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.manager.uiResolveQuotas.clear()
  for (let index = 0; index < 1000; index++) {
    const threadId = `thread-${index}`
    f.manager.uiResolveQuotas.set(
      JSON.stringify(["workspace", threadId]),
      new FunctionUiResolveMainQuota()
    )
    await f.manager.drainEntry({ ...f.entry, threadId })
  }
  expect(f.manager.uiResolveQuotas.size).toBe(0)
  expect(f.manager.retiringEntries.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it("retains accounting across replacement, construction and unconfirmed cleanup", async () => {
  const f = fixture()
  f.manager.sessions.set(key, f.entry)
  f.manager.reclaimIdleUiResources()
  expect(f.manager.uiResolveQuotas.get(key)).toBe(f.quota)
  f.manager.sessions.clear()
  for (const map of [
    f.manager.pendingSessionBuilds,
    f.manager.runtimeReservations,
    f.manager.endingEntries
  ]) {
    map.set(key, {})
    f.manager.reclaimIdleUiResources()
    expect(f.manager.uiResolveQuotas.get(key)).toBe(f.quota)
    map.clear()
  }
  f.entry.client.stopAndDrain = async () => {
    throw Error("exit unconfirmed")
  }
  await expect(f.manager.drainEntry(f.entry)).rejects.toThrow("exit unconfirmed")
  f.manager.reclaimIdleUiResources()
  expect(f.manager.uiResolveQuotas.get(key)).toBe(f.quota)
})

it("never releases live/quarantined leases or host work that outlives VM exit", async () => {
  const f = fixture()
  const lifetime = new FunctionUiResolveHostLifetime({})
  const pending = Promise.withResolvers<void>()
  const work = lifetime.run(() => pending.promise)
  f.quota.register(lifetime)
  lifetime.confirmExit()
  f.manager.reclaimIdleUiResources()
  expect(f.manager.uiResolveQuotas.get(key)).toBe(f.quota)
  pending.resolve()
  await work
  await Promise.resolve()
  f.manager.reclaimIdleUiResources()
  expect(f.manager.uiResolveQuotas.size).toBe(0)

  const g = fixture()
  const failed = Promise.withResolvers<void>()
  g.quota.register({
    owner: {},
    disposed: failed.promise,
    hostDrained: Promise.resolve(),
    assertCurrent() {}
  })
  failed.reject(Error("unknown native outcome"))
  await Promise.resolve()
  await Promise.resolve()
  expect(g.quota.stats.quarantined).toBe(1)
  g.manager.reclaimIdleUiResources()
  expect(g.manager.uiResolveQuotas.get(key)).toBe(g.quota)
})

it("does not reset notification rate limits on retirement and uses one idle retry", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const f = fixture()
  class Handle extends EventEmitter {
    show() {
      this.emit("failed")
    }
    close() {}
  }
  const notifier = new FunctionDesktopNotifications({
    isSupported: () => true,
    create: () => new Handle()
  })
  f.manager.desktopNotifiers.set("workspace", notifier)
  f.manager.desktopNotifiers.set("second-workspace", notifier)
  for (let index = 0; index < 3; index++)
    await notifier.show("plugin", { text: "sample" }, context())
  await f.manager.drainEntry(f.entry)
  f.manager.reclaimIdleUiResources()
  expect(vi.getTimerCount()).toBe(1)
  expect(await notifier.show("plugin", { text: "sample" }, context())).toMatchObject({
    reason: "rate-limit"
  })
  await vi.advanceTimersByTimeAsync(9999)
  expect(f.manager.desktopNotifiers.size).toBe(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.manager.desktopNotifiers.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it("does not close another thread's notification owner in the same workspace", () => {
  const f = fixture()
  const notifier = new FunctionDesktopNotifications({
    isSupported: () => true,
    create: () => {
      throw Error("unused")
    }
  })
  const close = vi.spyOn(notifier, "close")
  f.manager.desktopNotifiers.set("workspace", notifier)
  f.manager.candidates.add({ ...f.entry, threadId: "replacement" })
  f.manager.reclaimIdleUiResources()
  expect(f.manager.desktopNotifiers.get("workspace")).toBe(notifier)
  expect(close).not.toHaveBeenCalled()
  f.manager.candidates.clear()
  f.manager.reclaimIdleUiResources()
  expect(f.manager.desktopNotifiers.size).toBe(0)
  expect(close).toHaveBeenCalledOnce()
})
