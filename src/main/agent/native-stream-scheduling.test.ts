import { performance } from "node:perf_hooks"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createNativeStreamScheduler } from "./native-stream-scheduling"

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe("native stream scheduling budget", () => {
  it("shares one timer quantum across buffered frames, then yields at the CPU budget", async () => {
    vi.useFakeTimers()
    let now = 0
    vi.spyOn(performance, "now").mockImplementation(() => now)
    const schedule = createNativeStreamScheduler()
    const first = schedule()
    expect(first).toBeInstanceOf(Promise)
    await vi.runAllTimersAsync()
    await first
    for (let index = 0; index < 128; index++) expect(schedule()).toBeUndefined()
    now = 7.9
    expect(schedule()).toBeUndefined()
    now = 8
    const next = schedule()
    expect(next).toBeInstanceOf(Promise)
    now = 24
    await vi.runAllTimersAsync()
    await next
    expect(schedule()).toBeUndefined()
  })

  it("always gives snapshot computation its original event-loop boundary", async () => {
    vi.useFakeTimers()
    vi.spyOn(performance, "now").mockReturnValue(0)
    const schedule = createNativeStreamScheduler()
    for (let index = 0; index < 3; index++) {
      const forced = schedule(true)
      expect(forced).toBeInstanceOf(Promise)
      await vi.runAllTimersAsync()
      await forced
    }
  })
})
