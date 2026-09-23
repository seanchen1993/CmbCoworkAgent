import { afterEach, expect, it, vi } from "vitest"
import { CompletionFreshness } from "./completion-freshness"
import type { CompletionEvidenceBinding } from "./completion-evidence"

const binding = { files: [{ path: "a.ts", sha256: "one", size: 3 }] } as CompletionEvidenceBinding
afterEach(() => vi.useRealTimers())

it("coalesces notifications and preserves a PASS when captured content is unchanged", async () => {
  vi.useFakeTimers()
  const stale = vi.fn()
  const capture = vi.fn(async () => binding)
  const monitor = new CompletionFreshness(stale)
  monitor.track("attempt", binding, capture)
  for (let i = 0; i < 100; i++) monitor.changed()
  await vi.advanceTimersByTimeAsync(100)
  expect(capture).toHaveBeenCalledOnce()
  expect(stale).not.toHaveBeenCalled()
  monitor.close("closed")
})

it("invalidates once on changed content and never reruns an already stale proof", async () => {
  vi.useFakeTimers()
  const stale = vi.fn()
  const capture = vi.fn(async () => ({ ...binding, requirementVersion: "new" }))
  const monitor = new CompletionFreshness(stale)
  monitor.track("attempt", binding, capture)
  monitor.changed()
  await vi.advanceTimersByTimeAsync(100)
  monitor.changed()
  await vi.advanceTimersByTimeAsync(100)
  expect(stale).toHaveBeenCalledExactlyOnceWith("attempt", binding, "input-changed")
  expect(capture).toHaveBeenCalledOnce()
  monitor.close("closed")
})

it("does not lose a change arriving during a pending recheck", async () => {
  vi.useFakeTimers()
  let resolve!: (value: CompletionEvidenceBinding) => void
  const capture = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    .mockResolvedValue({ ...binding, requirementVersion: "new" })
  const stale = vi.fn()
  const monitor = new CompletionFreshness(stale)
  monitor.track("attempt", binding, capture)
  monitor.changed()
  await vi.advanceTimersByTimeAsync(100)
  monitor.changed()
  resolve(binding)
  await vi.advanceTimersByTimeAsync(200)
  expect(stale).toHaveBeenCalledOnce()
  expect(capture).toHaveBeenCalledTimes(2)
  monitor.close("closed")
})

it("bounds captures with cancellation and invalidates rather than claiming fresh on timeout", async () => {
  vi.useFakeTimers()
  let signal!: AbortSignal
  const stale = vi.fn()
  const monitor = new CompletionFreshness(stale)
  monitor.track("attempt", binding, async (value) => {
    signal = value
    return new Promise(() => {})
  })
  monitor.changed()
  await vi.advanceTimersByTimeAsync(10_100)
  expect(signal.aborted).toBe(true)
  expect(stale).toHaveBeenCalledExactlyOnceWith("attempt", binding, "COMPLETION_FRESHNESS_TIMEOUT")
  monitor.close("closed")
  expect(vi.getTimerCount()).toBe(0)
})

it("revocation cancels in-flight capture and records exactly one invalidation", async () => {
  vi.useFakeTimers()
  let resolve!: (value: CompletionEvidenceBinding) => void
  let signal!: AbortSignal
  const stale = vi.fn()
  const monitor = new CompletionFreshness(stale)
  monitor.track("attempt", binding, (value) => {
    signal = value
    return new Promise((r) => {
      resolve = r
    })
  })
  monitor.changed()
  await vi.advanceTimersByTimeAsync(100)
  monitor.close("runtime-replaced")
  expect(signal.aborted).toBe(true)
  resolve({ ...binding, requirementVersion: "new" })
  await vi.advanceTimersByTimeAsync(20_000)
  expect(stale).toHaveBeenCalledExactlyOnceWith("attempt", binding, "runtime-replaced")
  expect(vi.getTimerCount()).toBe(0)
})

it("caps retained captures and does no idle or disabled work", async () => {
  vi.useFakeTimers()
  const stale = vi.fn()
  const capture = vi.fn(async () => binding)
  const monitor = new CompletionFreshness(stale)
  monitor.changed()
  expect(vi.getTimerCount()).toBe(0)
  for (let i = 0; i < 33; i++) monitor.track(String(i), binding, capture)
  expect(stale).toHaveBeenCalledTimes(1)
  expect(stale).toHaveBeenCalledWith("0", binding, "evidence-retention-limit")
  expect(vi.getTimerCount()).toBe(0)
  monitor.close("closed")
  monitor.changed()
  expect(vi.getTimerCount()).toBe(0)
  expect(capture).not.toHaveBeenCalled()
})

it("does not let an unavailable evidence sink prevent runtime teardown", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  const stale = vi.fn(() => {
    throw Error("store unavailable")
  })
  const monitor = new CompletionFreshness(stale)
  monitor.track("one", binding, async () => binding)
  monitor.track("two", binding, async () => binding)
  try {
    expect(() => monitor.close("runtime-replaced")).not.toThrow()
    expect(stale).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(2)
  } finally {
    warn.mockRestore()
  }
})
