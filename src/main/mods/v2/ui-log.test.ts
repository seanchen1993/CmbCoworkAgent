import { afterEach, expect, it, vi } from "vitest"
import { FunctionUiLog } from "./ui-log"

afterEach(() => vi.useRealTimers())

it("keeps logging order despite late publication and sends every accepted line to debug", () => {
  vi.useFakeTimers()
  const debug = vi.fn()
  const logs = new FunctionUiLog(vi.fn(), debug)
  const first = logs.reserve("first")
  const second = logs.reserve("second")
  logs.settle(second, { text: "two", to: "transcript" })
  expect(logs.snapshot()).toEqual([])
  logs.settle(first, { text: "one", to: "debug" })
  expect(debug.mock.calls).toEqual([
    ["first", "one"],
    ["second", "two"]
  ])
  expect(logs.snapshot().map((row) => row.text)).toEqual(["two"])
  logs.close()
})

it("skips denied slots, bounds pending slots, and does not publish after close", () => {
  vi.useFakeTimers()
  const debug = vi.fn()
  const logs = new FunctionUiLog(vi.fn(), debug)
  const ids = Array.from({ length: 32 }, () => logs.reserve("test"))
  expect(() => logs.reserve("overflow")).toThrow("MODS_UI_LOG_CAPACITY")
  logs.settle(ids[1], { text: "accepted", to: "transcript" })
  logs.settle(ids[0])
  expect(logs.snapshot()).toHaveLength(1)
  logs.close()
  logs.settle(ids[2], { text: "late", to: "transcript" })
  expect(logs.snapshot()).toEqual([])
  expect(debug).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it("coalesces render notifications and bounds Unicode history by actual bytes", async () => {
  vi.useFakeTimers()
  const changed = vi.fn()
  const logs = new FunctionUiLog(changed, vi.fn())
  expect(vi.getTimerCount()).toBe(0)
  for (let i = 0; i < 100; i++) {
    logs.settle(logs.reserve("test"), { text: "🙂".repeat(5000), to: "transcript" })
  }
  expect(Buffer.byteLength(JSON.stringify(logs.snapshot()))).toBeLessThanOrEqual(256 * 1024)
  expect(logs.snapshot().length).toBeLessThanOrEqual(64)
  await vi.advanceTimersByTimeAsync(40)
  expect(changed).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  logs.close()
})

it("rechecks a buffered line's live authority before a previous line releases it", () => {
  const debug = vi.fn()
  const logs = new FunctionUiLog(vi.fn(), debug)
  const first = logs.reserve("first")
  const second = logs.reserve("second")
  let live = true
  logs.settle(second, { text: "late", to: "transcript" }, () => live)
  live = false
  logs.settle(first)
  expect(logs.snapshot()).toEqual([])
  expect(debug).not.toHaveBeenCalled()
  logs.close()
})
