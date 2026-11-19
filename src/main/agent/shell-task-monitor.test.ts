import { getEventListeners } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ShellTaskMonitor } from "./shell-task-monitor"

describe("ShellTaskMonitor", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("waits for publication with no polling or timers", async () => {
    const monitor = new ShellTaskMonitor()
    const listener = vi.fn()
    const pending = monitor.wait().then(listener)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(listener).not.toHaveBeenCalled()

    monitor.publish()
    monitor.publish()
    await pending
    expect(listener).toHaveBeenCalledExactlyOnceWith("completed")
    await expect(monitor.wait()).resolves.toBe("completed")
  })

  it("cleans up expired and aborted waiters while others receive completion", async () => {
    const monitor = new ShellTaskMonitor()
    const subscriptions = Array.from({ length: 128 }, (_, index) => {
      const controller = new AbortController()
      const pending = monitor.wait({
        timeoutMs: index < 64 ? 100 : 10_000,
        signal: controller.signal
      })
      return { controller, pending }
    })
    const [expiring, aborting, completing] = [
      subscriptions.slice(0, 64),
      subscriptions.slice(64, 112),
      subscriptions.slice(112)
    ]

    await vi.advanceTimersByTimeAsync(100)
    for (const { controller } of aborting) controller.abort()

    await expect(Promise.all(expiring.map(({ pending }) => pending))).resolves.toEqual(
      Array(64).fill("timeout")
    )
    await expect(Promise.all(aborting.map(({ pending }) => pending))).resolves.toEqual(
      Array(48).fill("aborted")
    )
    expect(vi.getTimerCount()).toBe(16)
    const waiters = Reflect.get(monitor, "waiters") as Set<unknown>
    expect(waiters.size).toBe(16)

    monitor.publish()
    await expect(Promise.all(completing.map(({ pending }) => pending))).resolves.toEqual(
      Array(16).fill("completed")
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(waiters.size).toBe(0)
    for (const { controller } of subscriptions) {
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    }
  })

  it("answers immediate and already-aborted requests without subscribing", async () => {
    const monitor = new ShellTaskMonitor()
    const signal = AbortSignal.abort()
    await expect(monitor.wait({ signal, timeoutMs: 50 })).resolves.toBe("aborted")
    await expect(monitor.wait({ timeoutMs: 0 })).resolves.toBe("timeout")
    expect(vi.getTimerCount()).toBe(0)
    expect(getEventListeners(signal, "abort")).toHaveLength(0)
  })
})
