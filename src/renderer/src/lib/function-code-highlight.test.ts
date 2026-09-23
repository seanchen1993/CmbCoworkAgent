import { afterEach, beforeEach, expect, it, vi } from "vitest"
vi.mock("../components/tabs/code-highlight-client", () => ({ requestCodeHighlight: vi.fn() }))
import { createFunctionCodeHighlighter } from "./function-code-highlight"

function fixture() {
  const calls: Array<{
    source: string
    resolve(value: string): void
    reject(error: Error): void
    cancel: ReturnType<typeof vi.fn>
  }> = []
  const raw = vi.fn((source: string) => {
    let resolve!: (value: string) => void, reject!: (error: Error) => void
    const promise = new Promise<string>((yes, no) => {
      resolve = yes
      reject = no
    })
    const cancel = vi.fn()
    calls.push({ source, resolve, reject, cancel })
    return { promise, cancel }
  })
  return { calls, raw, scheduler: createFunctionCodeHighlighter(raw) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => vi.useRealTimers())

it("keeps one raw calculation and only the newest pending input per component", async () => {
  const f = fixture(),
    owner = {}
  const outcomes: Array<Promise<string>> = []
  for (let i = 0; i < 50; i++) {
    const request = f.scheduler.request(owner, `source-${i}`, "typescript")
    outcomes.push(request.promise.catch((error) => error.message))
  }
  expect(f.raw).toHaveBeenCalledTimes(1)
  expect(await outcomes[0]).toBe("MODS_CODE_HIGHLIGHT_CANCELLED")
  expect(await outcomes[48]).toBe("MODS_CODE_HIGHLIGHT_CANCELLED")
  f.calls[0].resolve("obsolete result")
  await vi.advanceTimersByTimeAsync(99)
  expect(f.raw).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.calls.map((call) => call.source)).toEqual(["source-0", "source-49"])
  f.calls[1].resolve("current result")
  expect(await outcomes[49]).toBe("current result")
  expect(f.calls[0].cancel).not.toHaveBeenCalled()
})

it("limits continued input to one calculation per 100 ms without publishing superseded output", async () => {
  const starts: number[] = []
  const published: string[] = []
  const raw = vi.fn((source: string) => {
    starts.push(Date.now())
    return {
      promise: new Promise<string>((resolve) => setTimeout(() => resolve(source), 40)),
      cancel: vi.fn()
    }
  })
  const scheduler = createFunctionCodeHighlighter(raw)
  const owner = {}
  for (let i = 0; i < 60; i++) {
    void scheduler.request(owner, `input-${i}`, "typescript").promise.then(
      (html) => published.push(html),
      () => {}
    )
    await vi.advanceTimersByTimeAsync(16)
  }
  await vi.advanceTimersByTimeAsync(200)
  expect(published).toEqual(["input-59"])
  expect(starts.length).toBeLessThanOrEqual(11)
  expect(starts.every((time, index) => index === 0 || time - starts[index - 1] >= 100)).toBe(true)
  expect(raw.mock.results.every((result) => result.value.cancel.mock.calls.length === 0)).toBe(true)
})

it("rejects an unmounted request immediately but waits for raw settlement before another owner", async () => {
  const f = fixture()
  const first = f.scheduler.request({}, "first", "typescript")
  const firstOutcome = first.promise.catch((error) => error.message)
  const next = f.scheduler.request({}, "next", "typescript")
  first.cancel()
  expect(await firstOutcome).toBe("MODS_CODE_HIGHLIGHT_CANCELLED")
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.raw).toHaveBeenCalledTimes(1)
  expect(f.calls[0].cancel).not.toHaveBeenCalled()
  f.calls[0].resolve("must not publish")
  await vi.advanceTimersByTimeAsync(0)
  expect(f.raw).toHaveBeenCalledTimes(2)
  f.calls[1].resolve("next published")
  expect(await next.promise).toBe("next published")
})

it("bounds the multi-component pending queue and frees a cancelled slot", async () => {
  const f = fixture()
  const active = f.scheduler.request({}, "active", "typescript")
  void active.promise.catch(() => {})
  const pending = Array.from({ length: 16 }, (_, i) => {
    const request = f.scheduler.request({}, `pending-${i}`, "typescript")
    void request.promise.catch(() => {})
    return request
  })
  const rejected = f.scheduler.request({}, "overflow", "typescript")
  await expect(rejected.promise).rejects.toThrow("MODS_CODE_HIGHLIGHT_QUEUE_FULL")
  pending[0].cancel()
  const accepted = f.scheduler.request({}, "replacement", "typescript")
  void accepted.promise.catch(() => {})
  expect(f.raw).toHaveBeenCalledTimes(1)
  for (const request of pending) request.cancel()
  active.cancel()
  f.calls[0].resolve("old")
  await vi.advanceTimersByTimeAsync(100)
  expect(f.calls.map((call) => call.source)).toEqual(["active", "replacement"])
  f.calls[1].resolve("new")
  expect(await accepted.promise).toBe("new")
})

it("keeps other components progressing after a raw failure and separates cache languages", async () => {
  const f = fixture()
  const first = f.scheduler.request({}, "bad", "typescript")
  const rejected = expect(first.promise).rejects.toThrow("worker failure")
  const second = f.scheduler.request({}, "good", "typescript")
  f.calls[0].reject(Error("worker failure"))
  await rejected
  await vi.advanceTimersByTimeAsync(100)
  f.calls[1].resolve("typescript html")
  expect(await second.promise).toBe("typescript html")
  expect(await f.scheduler.request({}, "good", "typescript").promise).toBe("typescript html")
  expect(f.raw).toHaveBeenCalledTimes(2)
  const other = f.scheduler.request({}, "good", "javascript")
  await vi.advanceTimersByTimeAsync(100)
  expect(f.raw).toHaveBeenCalledTimes(3)
  f.calls[2].resolve("javascript html")
  expect(await other.promise).toBe("javascript html")
})

it("evicts old cached output and refuses oversized source or highlighted markup", async () => {
  const f = fixture()
  for (let i = 0; i < 18; i++) {
    const request = f.scheduler.request({}, `cache-${i}`, "typescript")
    await vi.advanceTimersByTimeAsync(100)
    f.calls.at(-1)!.resolve(`html-${i}`)
    await request.promise
  }
  const old = f.scheduler.request({}, "cache-0", "typescript")
  await vi.advanceTimersByTimeAsync(100)
  expect(f.raw).toHaveBeenCalledTimes(19)
  f.calls.at(-1)!.resolve("html-new")
  await old.promise
  await expect(f.scheduler.request({}, "x".repeat(10001), "typescript").promise).rejects.toThrow(
    "MODS_CODE_HIGHLIGHT_INPUT"
  )
  const large = f.scheduler.request({}, "large", "typescript")
  const rejected = expect(large.promise).rejects.toThrow("MODS_CODE_HIGHLIGHT_OUTPUT")
  await vi.advanceTimersByTimeAsync(100)
  f.calls.at(-1)!.resolve("x".repeat(512 * 1024 + 1))
  await rejected
})

it("also bounds aggregate cached markup and recovers from synchronous worker startup errors", async () => {
  const f = fixture()
  f.raw.mockImplementationOnce(() => {
    throw new Error("worker startup failed")
  })
  await expect(f.scheduler.request({}, "startup", "typescript").promise).rejects.toThrow(
    "worker startup failed"
  )
  for (let i = 0; i < 3; i++) {
    const request = f.scheduler.request({}, `large-${i}`, "typescript")
    await vi.advanceTimersByTimeAsync(100)
    f.calls.at(-1)!.resolve("x".repeat(400 * 1024))
    await request.promise
  }
  const evicted = f.scheduler.request({}, "large-0", "typescript")
  await vi.advanceTimersByTimeAsync(100)
  expect(f.raw).toHaveBeenCalledTimes(5)
  f.calls.at(-1)!.resolve("fresh")
  expect(await evicted.promise).toBe("fresh")
  await expect(f.scheduler.request({}, "safe", "typescript\u0000other").promise).rejects.toThrow(
    "MODS_CODE_HIGHLIGHT_INPUT"
  )
})
