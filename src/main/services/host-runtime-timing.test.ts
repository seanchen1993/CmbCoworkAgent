import { afterEach, describe, expect, it, vi } from "vitest"
import { performance } from "node:perf_hooks"
import {
  measureHostRuntimeAsync,
  measureHostRuntimeSync,
  reportHostRuntimeTiming,
  startHostRuntimeTiming,
  withHostRuntimeTiming
} from "./host-runtime-timing"

afterEach(() => vi.restoreAllMocks())

function fixture() {
  let now = 0
  vi.spyOn(performance, "now").mockImplementation(() => now)
  const log = vi.spyOn(console, "info").mockImplementation(() => {})
  return {
    advance: (ms: number) => { now += ms },
    log,
    summary: (index = 0) => JSON.parse(String(log.mock.calls[index][1]))
  }
}

describe("Host runtime timing observations", () => {
  it("leaves ordinary execution and errors untouched without a Host scope", async () => {
    const f = fixture(), error = Error("ordinary failure")
    expect(measureHostRuntimeSync("authority", () => 42)).toBe(42)
    await expect(measureHostRuntimeAsync("inputs", async () => { throw error })).rejects.toBe(error)
    reportHostRuntimeTiming(10_000)
    expect(f.log).not.toHaveBeenCalled()
  })

  it("counts original synchronous work, including throwing guards, without swallowing failures", () => {
    const f = fixture(), error = Error("secret task content")
    withHostRuntimeTiming(() => {
      expect(() => measureHostRuntimeSync("authority", () => {
        f.advance(300)
        throw error
      })).toThrow(error)
      reportHostRuntimeTiming(300, true)
    })
    expect(f.summary().authority).toEqual({ calls: 1, ms: 300 })
    expect(f.summary().failed).toBe(1)
    expect(String(f.log.mock.calls[0][1])).not.toContain(error.message)
  })

  it("records actual async waiting and ends each queue sample exactly once", async () => {
    const f = fixture(), gate = Promise.withResolvers<void>()
    await withHostRuntimeTiming(async () => {
      const waiting = measureHostRuntimeAsync("composePrompt", async () => {
        const finish = startHostRuntimeTiming("policyQueue")
        await gate.promise
        finish()
        finish()
        return "original result"
      })
      f.advance(275)
      gate.resolve()
      expect(await waiting).toBe("original result")
      reportHostRuntimeTiming(275)
    })
    expect(f.summary().policyQueue).toEqual({ calls: 1, ms: 275 })
    expect(f.summary().composePrompt).toEqual({ calls: 1, ms: 275 })
    expect(f.summary().inclusive).toBe(1)
  })

  it("resets every request round, including quiet rounds, and only logs slow observations", () => {
    const f = fixture()
    withHostRuntimeTiming(() => {
      measureHostRuntimeSync("inputs", () => f.advance(200))
      reportHostRuntimeTiming(200)
      measureHostRuntimeSync("inputs", () => f.advance(60))
      reportHostRuntimeTiming(60)
      expect(f.log).not.toHaveBeenCalled()
      measureHostRuntimeSync("describeTools", () => f.advance(251))
      reportHostRuntimeTiming(251)
      reportHostRuntimeTiming(1)
    })
    expect(f.log).toHaveBeenCalledTimes(1)
    expect(f.summary().round).toBe(3)
    expect(f.summary().inputs).toEqual({ calls: 0, ms: 0 })
    expect(f.summary().describeTools).toEqual({ calls: 1, ms: 251 })
  })

  it("isolates overlapping Host operations without a process-wide execution registry", async () => {
    const f = fixture(), gate = Promise.withResolvers<void>()
    const first = withHostRuntimeTiming(async () => {
      measureHostRuntimeSync("snapshot", () => f.advance(300))
      await gate.promise
      reportHostRuntimeTiming(0)
    })
    withHostRuntimeTiming(() => {
      measureHostRuntimeSync("hostFacts", () => f.advance(400))
      reportHostRuntimeTiming(0)
    })
    gate.resolve()
    await first
    expect(f.summary(0).snapshot.calls).toBe(0)
    expect(f.summary(1).hostFacts.calls).toBe(0)
    expect(f.summary(0).round).toBe(1)
    expect(f.summary(1).round).toBe(1)
  })

  it("retains an in-flight sample across reporting without counting it twice", () => {
    const f = fixture()
    withHostRuntimeTiming(() => {
      const finish = startHostRuntimeTiming("policyQueue")
      f.advance(200)
      reportHostRuntimeTiming(0)
      f.advance(100)
      finish()
      reportHostRuntimeTiming(0)
      finish()
      reportHostRuntimeTiming(0)
    })
    expect(f.log).toHaveBeenCalledTimes(1)
    expect(f.summary().round).toBe(2)
    expect(f.summary().policyQueue).toEqual({ calls: 1, ms: 300 })
  })

  it("bounds summaries and never lets a logging failure alter execution", () => {
    const f = fixture()
    withHostRuntimeTiming(() => reportHostRuntimeTiming(Infinity))
    expect(f.summary().preparationMs).toBe(86_400_000)
    expect(String(f.log.mock.calls[0][1]).length).toBeLessThan(1000)
    f.log.mockImplementation(() => { throw Error("logger unavailable") })
    expect(withHostRuntimeTiming(() => {
      reportHostRuntimeTiming(999)
      return "success"
    })).toBe("success")
  })
})
