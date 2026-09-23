import { afterEach, expect, it, vi } from "vitest"
import { FunctionPanes } from "./panes"

afterEach(() => vi.useRealTimers())
function fixture() {
  vi.useFakeTimers()
  const changed = vi.fn()
  const panes = new FunctionPanes({
    plugins: [],
    assertLive: () => {},
    changed,
    publish: async (value) => value,
    dispatch: async () => ({}),
    callback: async () => {}
  })
  return { panes, changed }
}

it("coalesces live Client notifications into one frame without a 100 ms debounce", async () => {
  const { panes, changed } = fixture()
  for (let i = 0; i < 100; i++) panes.notify()
  await vi.advanceTimersByTimeAsync(15)
  expect(changed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(changed).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(100)
  expect(changed).toHaveBeenCalledOnce()
  panes.close()
})

it("expedites a pending ordinary notification once when a Client draws", async () => {
  const { panes, changed } = fixture()
  panes.open("plugin", { id: "pane" })
  await vi.advanceTimersByTimeAsync(10)
  panes.notify()
  await vi.advanceTimersByTimeAsync(16)
  expect(changed).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(100)
  expect(changed).toHaveBeenCalledOnce()
  panes.close()
})

it("retains ordinary pane batching and releases an outstanding frame on close", async () => {
  const { panes, changed } = fixture()
  panes.open("plugin", { id: "pane" })
  await vi.advanceTimersByTimeAsync(99)
  expect(changed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(changed).toHaveBeenCalledOnce()
  panes.notify()
  panes.close()
  await vi.advanceTimersByTimeAsync(200)
  expect(changed).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it("never postpones a notification already due sooner than the Client frame", async () => {
  const { panes, changed } = fixture()
  panes.open("plugin", { id: "pane" })
  await vi.advanceTimersByTimeAsync(99)
  panes.notify()
  await vi.advanceTimersByTimeAsync(1)
  expect(changed).toHaveBeenCalledOnce()
  panes.close()
})
