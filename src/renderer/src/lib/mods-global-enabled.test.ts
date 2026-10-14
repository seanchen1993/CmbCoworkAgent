import { afterEach, expect, it, vi } from "vitest"
import { invalidateModsGlobalEnabled, readModsGlobalEnabled } from "./mods-global-enabled"

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
