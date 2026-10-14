import { expect, it, vi } from "vitest"
import { FunctionModuleResources, functionTimerDelay } from "./module-resources"

it("strict retirement retains a cleanup failure after the entry was already removed", async () => {
  const registry = new FunctionModuleResources<object>(() => {})
  const resource = registry.create({}, new AbortController().signal, async () => {
    throw Error("backend close failed")
  })
  await expect(resource.close()).rejects.toThrow("backend close failed")
  expect(registry.size).toBe(0)
  await registry.closeAll()
  expect(() => registry.assertRetired()).toThrow("backend close failed")
})

it("strict retirement waits the same in-flight close and never retries cleanup", async () => {
  const registry = new FunctionModuleResources<object>(() => {})
  const finish = Promise.withResolvers<void>()
  const cleanup = vi.fn(() => finish.promise)
  const resource = registry.create({}, new AbortController().signal, cleanup)
  const first = resource.close()
  const retiring = registry.closeAll()
  await Promise.resolve()
  expect(() => registry.assertRetired()).toThrow("MODS_RESOURCE_CLEANUP_PENDING")
  finish.resolve()
  await Promise.all([first, retiring])
  expect(() => registry.assertRetired()).not.toThrow()
  expect(cleanup).toHaveBeenCalledOnce()
})

it("binds handles to owners and retains quota until cleanup completes", async () => {
  const owner = {},
    other = {}
  const registry = new FunctionModuleResources<object>(() => {})
  const controller = new AbortController()
  let finish!: () => void
  const cleanup = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const first = registry.create(owner, controller.signal, cleanup)
  expect(() => registry.assert(other, first.id)).toThrow("MODS_RESOURCE_UNAVAILABLE")
  expect(() => registry.close(other, first.id)).toThrow("MODS_RESOURCE_OWNER")
  for (let i = 1; i < 64; i++) registry.create(owner, controller.signal, () => {})
  const closed = first.close()
  expect(first.signal.aborted).toBe(true)
  expect(() => registry.create(owner, controller.signal, () => {})).toThrow("MODS_RESOURCE_LIMIT")
  await Promise.resolve()
  finish()
  await closed
  expect(cleanup).toHaveBeenCalledTimes(1)
  registry.create(owner, controller.signal, () => {})
  await registry.closeAll()
  expect(registry.size).toBe(0)
})

it("cancels all owner resources and shares reentrant cleanup", async () => {
  const owner = {}
  const registry = new FunctionModuleResources<object>(() => {})
  const parent = new AbortController()
  const cleanup = vi.fn()
  const resource = registry.create(owner, parent.signal, cleanup)
  resource.signal.addEventListener("abort", () => {
    void resource.close()
  })
  parent.abort()
  await registry.closeOwner(owner)
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(registry.size).toBe(0)
})

it("rejects overflow delays instead of letting Node clamp them to one millisecond", () => {
  expect(functionTimerDelay(0, true)).toBe(1)
  expect(functionTimerDelay(60000)).toBe(60000)
  for (const value of [NaN, Infinity, -1, 60001, 2147483648, "1"])
    expect(() => functionTimerDelay(value)).toThrow("MODS_TIMER_DELAY")
})
