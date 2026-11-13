import { expect, it, vi } from "vitest"
import { createLatestRefreshCoordinator } from "./latest-refresh-coordinator"

const settle = async () => { for (let tick = 0; tick < 12; tick++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
it("coalesces a burst into one physical read and one final trailing read", async () => {
  const first = deferred<boolean>(), refresh = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true)
  const gate = createLatestRefreshCoordinator({ ready: () => true, refresh })
  gate.request(); await settle()
  for (let count = 0; count < 100; count++) gate.request()
  expect(refresh).toHaveBeenCalledTimes(1)
  first.resolve(true); await settle()
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(gate.dirty()).toBe(false)
})
it.each([false, "reject"])("keeps a trailing notification after an unsuccessful %s read", async result => {
  const first = deferred<boolean>(), refresh = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true)
  const failed = vi.fn(), gate = createLatestRefreshCoordinator({ ready: () => true, refresh, failed })
  gate.request(); await settle(); gate.request()
  if (result === false) first.resolve(false)
  else first.reject(Error("read failed"))
  await settle()
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(gate.dirty()).toBe(false)
})
it("holds busy invalidation until idle, including idle during physical completion", async () => {
  let ready = false
  const first = deferred<boolean>(), refresh = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true)
  const gate = createLatestRefreshCoordinator({ ready: () => ready, refresh })
  gate.request(); await settle(); expect(refresh).not.toHaveBeenCalled()
  ready = true; gate.wake(); await settle()
  first.resolve(false); gate.wake(); await settle()
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(gate.dirty()).toBe(false)
})
it("does not spin on persistent failure and stops retries on owner retirement", async () => {
  const refresh = vi.fn().mockResolvedValue(false)
  const gate = createLatestRefreshCoordinator({ ready: () => true, refresh })
  gate.request(); await settle()
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(gate.dirty()).toBe(true)
  gate.close(); gate.wake(); gate.request(); await settle()
  expect(refresh).toHaveBeenCalledTimes(1)
})
