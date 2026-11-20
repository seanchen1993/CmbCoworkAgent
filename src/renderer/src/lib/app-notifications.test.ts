import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppNotification } from "../../../shared/app-notifications"

const react = vi.hoisted(() => ({
  subscribe: undefined as ((listener: () => void) => () => void) | undefined,
  snapshot: undefined as (() => AppNotification[]) | undefined
}))
vi.mock("react", () => ({
  useSyncExternalStore: (
    subscribe: (listener: () => void) => () => void,
    snapshot: () => AppNotification[]
  ) => {
    react.subscribe = subscribe
    react.snapshot = snapshot
    return snapshot()
  }
}))
let list: ReturnType<typeof vi.fn<() => Promise<AppNotification[]>>>
let changed: () => void
let focus: () => void
let unsubscribe: ReturnType<typeof vi.fn>
let api: typeof import("./app-notifications")
const cleanups: (() => void)[] = []
function message(id: string): AppNotification {
  return {
    notificationId: id,
    type: "human_gate",
    kind: "decision",
    status: "pending",
    title: "Gate",
    message: "Gate",
    targets: ["app_view"],
    payload: {},
    createdAt: "2026-09-13 08:00:00",
    updatedAt: "2026-09-13 08:00:00"
  }
}
function deferred() {
  let resolve!: (value: AppNotification[]) => void
  const promise = new Promise<AppNotification[]>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
function mount() {
  api.useAppNotifications()
  const listener = vi.fn()
  cleanups.push(react.subscribe!(listener))
  return listener
}
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  unsubscribe = vi.fn()
  list = vi.fn<() => Promise<AppNotification[]>>().mockResolvedValue([])
  vi.stubGlobal("window", {
    api: {
      appNotifications: {
        list,
        onChanged: (callback: () => void) => {
          changed = callback
          return unsubscribe
        }
      }
    },
    addEventListener: (_name: string, callback: () => void) => {
      focus = callback
    },
    removeEventListener: vi.fn()
  })
  api = await import("./app-notifications")
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("APP notification shared subscription", () => {
  it("shares one initial query across multiple mounted consumers", async () => {
    list.mockResolvedValue([message("first")])
    const first = mount()
    const second = mount()
    await settle()
    expect(list).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(react.snapshot!()[0].notificationId).toBe("first")
  })

  it("coalesces simultaneous refresh calls into one request", async () => {
    await Promise.all(Array.from({ length: 20 }, () => api.refreshAppNotifications()))
    expect(list).toHaveBeenCalledTimes(1)
  })

  it("coalesces changes during an in-flight query and never publishes its stale result", async () => {
    const first = deferred()
    const next = deferred()
    list.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise)
    const listener = mount()
    await settle()
    for (let i = 0; i < 20; i++) changed()
    focus()
    expect(list).toHaveBeenCalledTimes(1)
    first.resolve([message("stale")])
    await settle()
    expect(list).toHaveBeenCalledTimes(2)
    expect(listener).not.toHaveBeenCalled()
    next.resolve([message("latest")])
    await settle()
    expect(react.snapshot!().map((item) => item.notificationId)).toEqual(["latest"])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("retains the last snapshot on failure and retries after two seconds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    list
      .mockResolvedValueOnce([message("visible")])
      .mockRejectedValueOnce(new Error("IPC failed"))
      .mockResolvedValue([])
    mount()
    await settle()
    changed()
    await settle()
    expect(react.snapshot!()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(list).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(list).toHaveBeenCalledTimes(3)
    expect(react.snapshot!()).toEqual([])
  })

  it("drops an unmounted in-flight result and refreshes correctly on remount", async () => {
    const first = deferred()
    list.mockReturnValueOnce(first.promise).mockResolvedValue([message("remounted")])
    mount()
    await settle()
    cleanups.pop()!()
    first.resolve([message("obsolete")])
    await settle()
    expect(react.snapshot!()).toEqual([])
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    mount()
    await settle()
    expect(react.snapshot!()[0].notificationId).toBe("remounted")
  })

  it("stops retrying when the last consumer leaves", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    list.mockRejectedValue(new Error("offline"))
    mount()
    await settle()
    cleanups.pop()!()
    await vi.advanceTimersByTimeAsync(10000)
    expect(list).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
