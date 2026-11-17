import { afterEach, expect, it, vi } from "vitest"
import {
  invalidateModsGlobalEnabled,
  observeModsGlobalEnabled,
  readModsGlobalEnabled
} from "./mods-global-enabled"

afterEach(() => {
  invalidateModsGlobalEnabled()
  vi.unstubAllGlobals()
})
it("shares concurrent Mods-off probes and does not cache an obsolete switch", async () => {
  const first = Promise.withResolvers<boolean>()
  const globalEnabled = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true)
  vi.stubGlobal("window", { api: { mods: { globalEnabled } } })
  const evidence = readModsGlobalEnabled()
  const peers = readModsGlobalEnabled()
  expect(globalEnabled).toHaveBeenCalledOnce()
  first.resolve(false)
  expect(await evidence).toBe(false)
  expect(await peers).toBe(false)
  expect(await readModsGlobalEnabled()).toBe(true)
  expect(globalEnabled).toHaveBeenCalledTimes(2)
})

it("does not reuse a pending pre-configuration response or clear a newer read", async () => {
  const old = Promise.withResolvers<boolean>()
  const current = Promise.withResolvers<boolean>()
  const globalEnabled = vi.fn().mockReturnValueOnce(old.promise).mockReturnValue(current.promise)
  vi.stubGlobal("window", { api: { mods: { globalEnabled } } })
  const stale = readModsGlobalEnabled()
  invalidateModsGlobalEnabled()
  const fresh = readModsGlobalEnabled()
  old.resolve(true)
  await stale
  expect(readModsGlobalEnabled()).toBe(fresh)
  current.resolve(false)
  expect(await fresh).toBe(false)
  expect(globalEnabled).toHaveBeenCalledTimes(2)
})

it("coalesces configuration wakes and ignores obsolete and unmounted observations", async () => {
  const initial = Promise.withResolvers<boolean>()
  const current = Promise.withResolvers<boolean>()
  const last = Promise.withResolvers<boolean>()
  const globalEnabled = vi.fn().mockReturnValueOnce(initial.promise)
    .mockReturnValueOnce(current.promise).mockReturnValueOnce(last.promise)
  const unsubscribe = vi.fn()
  const removeEventListener = vi.fn()
  const listeners = new Set<(event?: { scope: "schema" }) => void>()
  vi.stubGlobal("window", {
    api: {
      mods: {
        globalEnabled,
        onConfigurationChanged: (listener: (event?: { scope: "schema" }) => void) => {
          listeners.add(listener)
          return unsubscribe
        }
      }
    },
    addEventListener: vi.fn(),
    removeEventListener
  })
  const accept = vi.fn()
  const stop = observeModsGlobalEnabled(accept)
  const notify = [...listeners][0]
  await vi.waitFor(() => expect(globalEnabled).toHaveBeenCalledTimes(1))
  notify({ scope: "schema" })
  await Promise.resolve()
  expect(globalEnabled).toHaveBeenCalledTimes(1)
  notify()
  notify()
  await vi.waitFor(() => expect(globalEnabled).toHaveBeenCalledTimes(2))
  current.resolve(false)
  await vi.waitFor(() => expect(accept.mock.calls).toEqual([[false]]))
  initial.resolve(true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(accept.mock.calls).toEqual([[false]])
  notify()
  await vi.waitFor(() => expect(globalEnabled).toHaveBeenCalledTimes(3))
  stop()
  last.resolve(true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(accept.mock.calls).toEqual([[false]])
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(removeEventListener).toHaveBeenCalledOnce()
})
