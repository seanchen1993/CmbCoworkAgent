import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../storage", () => ({ getUserInfo: () => undefined }))
vi.mock("../net-utils", () => ({ getLocalIP: () => "127.0.0.1" }))
vi.mock("../util/local-time", () => ({ nowIsoLocal: () => "2026-08-31T12:00:00.000+08:00" }))
vi.mock("../org-levels", () => ({ deriveUpperOrgLevelsFromPath: () => ({}) }))

import {
  HttpEventReporter,
  NoopEventReporter,
  setEventReporter,
  trackEvent,
  type CoworkEvent
} from "./event-reporter"

function event(index = 1): CoworkEvent {
  return {
    eventId: `event-${index}`,
    eventName: "hook.executed",
    eventCategory: "hook",
    eventTime: "2026-08-31T12:00:00.000+08:00",
    userName: "tester",
    userIp: "127.0.0.1"
  }
}

function okResponse(): Response {
  return new Response(null, { status: 200 })
}

describe("HttpEventReporter", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-31T04:00:00.000Z"))
  })

  afterEach(() => {
    setEventReporter(new NoopEventReporter())
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("backs off unconfigured reporters for five minutes without claiming an upload", async () => {
    await expect(new NoopEventReporter().report(event())).resolves.toEqual({
      ok: false,
      retryable: true,
      error: "event reporter is not configured",
      retryAfterMs: 5 * 60_000,
      attempted: false
    })
    await expect(new HttpEventReporter("  ").report(event())).resolves.toEqual({
      ok: false,
      retryable: true,
      error: "event reporter base URL is empty",
      retryAfterMs: 5 * 60_000,
      attempted: false
    })
  })

  it("aborts the underlying fetch when the upload times out", async () => {
    let requestSignal: AbortSignal | undefined
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          const error = new Error("aborted")
          error.name = "AbortError"
          reject(error)
        })
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    const reportPromise = new HttpEventReporter("https://events.example.test").report(event())
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestSignal?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(10_000)
    const result = await reportPromise

    expect(requestSignal?.aborted).toBe(true)
    expect(result).toMatchObject({
      ok: false,
      retryable: true,
      error: "upload timed out after 10000ms",
      retryAfterMs: 1_000
    })
  })

  it("cancels response bodies that the telemetry protocol does not consume", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
      },
      cancel
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })))

    await expect(
      new HttpEventReporter("https://events.example.test").report(event())
    ).resolves.toEqual({ ok: true, status: 200 })
    await vi.advanceTimersByTimeAsync(0)

    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it("cancels a response that resolves after the reporter deadline", async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    const cancel = vi.fn()
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve
          })
      )
    )

    const reportPromise = new HttpEventReporter("https://events.example.test").report(event())
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(reportPromise).resolves.toMatchObject({
      ok: false,
      retryable: true,
      error: "upload timed out after 10000ms"
    })

    resolveFetch?.(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([4, 5, 6]))
          },
          cancel
        }),
        { status: 200 }
      )
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it("bounds one reporter to two active uploads and drops excess waiting work", async () => {
    let active = 0
    let maximumActive = 0
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          active -= 1
          reject(new Error("aborted"))
        })
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    const reporter = new HttpEventReporter("https://events.example.test")
    const reports = Array.from({ length: 20 }, (_, index) => reporter.report(event(index)))
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(maximumActive).toBe(2)

    await vi.advanceTimersByTimeAsync(10_000)
    const results = await Promise.all(reports)
    const overloaded = results.filter((result) => !result.ok && result.error.includes("overloaded"))

    expect(overloaded).toHaveLength(18)
    expect(results.every((result) => result.ok || result.retryable)).toBe(true)
    expect(active).toBe(0)
  })

  it("bounds uploads globally across multiple reporter instances", async () => {
    let active = 0
    let maximumActive = 0
    const releases: Array<() => void> = []
    const fetchMock = vi.fn(() => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      return new Promise<Response>((resolve) => {
        releases.push(() => {
          active -= 1
          resolve(okResponse())
        })
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    const reporters = Array.from(
      { length: 3 },
      () => new HttpEventReporter("https://events.example.test")
    )
    const reports = reporters.flatMap((reporter, reporterIndex) => [
      reporter.report(event(reporterIndex * 2)),
      reporter.report(event(reporterIndex * 2 + 1))
    ])
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(maximumActive).toBe(4)
    releases.splice(0).forEach((release) => release())
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(6)
    releases.splice(0).forEach((release) => release())

    await expect(Promise.all(reports)).resolves.toEqual(
      Array.from({ length: 6 }, () => ({ ok: true, status: 200 }))
    )
    expect(maximumActive).toBe(4)
    expect(active).toBe(0)
  })

  it("backs off exponentially after network failures and rate-limits identical logs", async () => {
    const dnsError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND events.example.test"), {
        code: "ENOTFOUND"
      })
    })
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(dnsError)
      .mockRejectedValueOnce(dnsError)
      .mockResolvedValue(okResponse())
    vi.stubGlobal("fetch", fetchMock)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const reporter = new HttpEventReporter("https://events.example.test")

    const first = await reporter.report(event(1))
    const blocked = await reporter.report(event(2))
    expect(first).toMatchObject({ ok: false, retryable: true, retryAfterMs: 1_000 })
    expect(blocked).toMatchObject({ ok: false, retryable: true, retryAfterMs: 1_000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    const second = await reporter.report(event(3))
    expect(second).toMatchObject({ ok: false, retryable: true, retryAfterMs: 2_000 })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(2_000)
    await expect(reporter.report(event(4))).resolves.toEqual({ ok: true, status: 200 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toHaveLength(1)
    expect(warn.mock.calls[0]?.[0]).toContain("ENOTFOUND")
    expect(typeof warn.mock.calls[0]?.[0]).toBe("string")
  })

  it("defers queued work after a failure and does not let an older success clear backoff", async () => {
    let rejectFirst: ((error: Error) => void) | undefined
    let resolveSecond: ((response: Response) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectFirst = reject
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveSecond = resolve
          })
      )
      .mockResolvedValue(okResponse())
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const reporter = new HttpEventReporter("https://events.example.test")

    const first = reporter.report(event(1))
    const olderSuccess = reporter.report(event(2))
    const queued = reporter.report(event(3))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    rejectFirst?.(new TypeError("fetch failed"))
    await expect(first).resolves.toMatchObject({ ok: false, retryable: true })
    await expect(queued).resolves.toMatchObject({
      ok: false,
      retryable: true,
      attempted: false,
      retryAfterMs: 1_000
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    resolveSecond?.(okResponse())
    await expect(olderSuccess).resolves.toEqual({ ok: true, status: 200 })
    await expect(reporter.report(event(4))).resolves.toMatchObject({
      ok: false,
      attempted: false,
      retryAfterMs: 1_000
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1_000)
    await expect(reporter.report(event(5))).resolves.toEqual({ ok: true, status: 200 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("preserves retry-after guidance for durable outbox callers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "retry-after": "5" }
        })
      )
    )

    const result = await new HttpEventReporter("https://events.example.test").report(event())

    expect(result).toEqual({
      ok: false,
      retryable: true,
      error: "503 Service Unavailable",
      status: 503,
      retryAfterMs: 5_000
    })
  })

  it("returns the finite retry delay it actually applies for unsafe retry-after values", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "retry-after": "1e308" }
        })
      )
      .mockResolvedValueOnce(okResponse())
    vi.stubGlobal("fetch", fetchMock)
    const reporter = new HttpEventReporter("https://events.example.test")

    await expect(reporter.report(event(1))).resolves.toEqual({
      ok: false,
      retryable: true,
      error: "503 Service Unavailable",
      status: 503,
      retryAfterMs: 60_000
    })
    await expect(reporter.report(event(2))).resolves.toMatchObject({
      ok: false,
      attempted: false,
      retryAfterMs: 60_000
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(reporter.report(event(3))).resolves.toEqual({ ok: true, status: 200 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("never throws even when fetch and console diagnostics both fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("console bridge failed")
    })

    await expect(
      new HttpEventReporter("https://events.example.test").report(event())
    ).resolves.toMatchObject({ ok: false, retryable: true, error: "offline" })
  })

  it("does not invoke getters or Proxy traps while summarizing fetch failures", async () => {
    let unsafeReads = 0
    const hostileError = Object.create(null) as Record<string, unknown>
    Object.defineProperties(hostileError, {
      message: {
        get: () => {
          unsafeReads += 1
          console.error("hostile error getter must not run")
          throw new Error("hostile error getter must not run")
        }
      },
      cause: {
        get: () => {
          unsafeReads += 1
          throw new Error("hostile cause getter must not run")
        }
      }
    })
    const hostileProxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          unsafeReads += 1
          console.error("hostile error proxy must not run")
          throw new Error("hostile error proxy must not run")
        }
      }
    )
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(hostileError).mockRejectedValue(hostileProxy)
    )

    await expect(
      new HttpEventReporter("https://events.example.test").report(event(1))
    ).resolves.toMatchObject({ ok: false, retryable: true })
    await expect(
      new HttpEventReporter("https://events.example.test").report(event(2))
    ).resolves.toMatchObject({ ok: false, retryable: true })
    expect(unsafeReads).toBe(0)
  })

  it("does not claim a transport attempt when fetch throws before returning a promise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fetch bootstrap failed")
      })
    )
    vi.spyOn(console, "warn").mockImplementation(() => undefined)

    await expect(
      new HttpEventReporter("https://events.example.test").report(event())
    ).resolves.toMatchObject({
      ok: false,
      retryable: true,
      error: "fetch bootstrap failed",
      attempted: false
    })
  })

  it("contains synchronous exceptions from third-party reporters used by trackEvent", () => {
    setEventReporter({
      report: () => {
        throw new Error("custom reporter failed")
      }
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    expect(() => trackEvent("hook.executed", "hook")).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      "[EventReporter] trackEvent unexpected error: custom reporter failed"
    )
  })
})
