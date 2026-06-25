import { afterEach, describe, expect, it, vi } from "vitest"
import { scheduleHardDeadline, waitBestEffort } from "./shutdown-deadline"

afterEach(() => {
  vi.useRealTimers()
})

describe("shutdown deadlines", () => {
  it("bounds a persistence promise that never settles", async () => {
    vi.useFakeTimers()
    const pending = waitBestEffort(new Promise(() => undefined), 2_000)

    await vi.advanceTimersByTimeAsync(1_999)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe("timed_out")
  })

  it("fires the hard deadline independently and supports cancellation", async () => {
    vi.useFakeTimers()
    const callback = vi.fn()
    const cancel = scheduleHardDeadline(callback, 12_500)

    await vi.advanceTimersByTimeAsync(12_500)
    expect(callback).toHaveBeenCalledTimes(1)

    const cancelledCallback = vi.fn()
    const cancelSecond = scheduleHardDeadline(cancelledCallback, 100)
    cancelSecond()
    await vi.advanceTimersByTimeAsync(100)
    expect(cancelledCallback).not.toHaveBeenCalled()
    cancel()
  })
})
