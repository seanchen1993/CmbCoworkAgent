import { afterEach, describe, expect, it, vi } from "vitest"
import { CloudTraceReporter } from "./cloud-reporter"
import type { AgentTrace } from "./types"

function makeTrace(index: number): AgentTrace {
  return {
    traceId: `trace-${index}`,
    threadId: "thread-cloud-reporter",
    startedAt: "2026-08-26T00:00:00.000Z",
    endedAt: "2026-08-26T00:00:01.000Z",
    durationMs: 1_000,
    userMessage: "message",
    modelId: "model",
    steps: [],
    totalToolCalls: 0,
    outcome: "success",
    usedSkills: [],
    evolvedSkills: [],
    triggerSource: "chat"
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("CloudTraceReporter admission", () => {
  it("bounds active and waiting uploads while preserving admitted FIFO work", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const pending: Array<(response: Response) => void> = []
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve)
        })
    )
    vi.stubGlobal("fetch", fetchMock)
    const reporter = new CloudTraceReporter("https://example.test", {
      maxConcurrent: 2,
      maxWaiters: 3,
      timeoutMs: 5_000
    })

    const reports = Array.from({ length: 8 }, (_, index) => reporter.report(makeTrace(index)))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(reporter.getDiagnosticsForTest()).toMatchObject({
      active: 2,
      waiters: 3,
      dropped: 3
    })

    for (let index = 0; index < 5; index += 1) {
      const resolveFetch = pending.shift()
      expect(resolveFetch).toBeDefined()
      resolveFetch?.({ ok: true } as Response)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await Promise.all(reports)
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(reporter.getDiagnosticsForTest()).toMatchObject({ active: 0, waiters: 0 })
  })

  it("aborts a timed-out fetch before releasing its admission slot", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    let uploadSignal: AbortSignal | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        uploadSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          uploadSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true
          })
        })
      })
    )
    const reporter = new CloudTraceReporter("https://example.test", {
      timeoutMs: 10,
      maxConcurrent: 1,
      maxWaiters: 0
    })

    await reporter.report(makeTrace(1))

    expect(uploadSignal?.aborted).toBe(true)
    expect(reporter.getDiagnosticsForTest()).toMatchObject({ active: 0, waiters: 0 })
  })

  it("counts queue wait against one total report deadline", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    })
    vi.stubGlobal("fetch", fetchMock)
    const reporter = new CloudTraceReporter("https://example.test", {
      timeoutMs: 50,
      maxConcurrent: 1,
      maxWaiters: 1
    })

    const first = reporter.report(makeTrace(1))
    const queued = reporter.report(makeTrace(2))
    await vi.advanceTimersByTimeAsync(50)
    await Promise.all([first, queued])

    // The queued request may inherit a sub-millisecond remainder, but it must
    // never receive a fresh 50 ms upload budget after waiting for the first.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2)
    expect(reporter.getDiagnosticsForTest()).toMatchObject({ active: 0, waiters: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })
})
