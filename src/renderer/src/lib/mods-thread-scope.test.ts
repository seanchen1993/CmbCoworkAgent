import { afterEach, expect, it, vi } from "vitest"
import {
  createModsScopeLifetime,
  createModsThreadScope,
  modsWorkspaceKey
} from "./mods-thread-scope"
afterEach(() => vi.unstubAllGlobals())
it("admits only a known nonempty workspace, keeping root paths distinct from no workspace", () => {
  for (const value of [undefined, null, 0, {}, "", "  ", "x\0y"])
    expect(modsWorkspaceKey(value)).toBeNull()
  expect(modsWorkspaceKey("/")).toBe("/")
  expect(createModsThreadScope("thread", null)).toBeNull()
  expect(createModsThreadScope("", "/repo")).toBeNull()
})
it("uses existing Windows path normalization and fresh owner identity for each committed scope", () => {
  vi.stubGlobal("window", { electron: { process: { platform: "win32" } } })
  expect(modsWorkspaceKey("C:\\Repo\\")).toBe(modsWorkspaceKey("c:/repo"))
  const first = createModsThreadScope("thread", modsWorkspaceKey("C:\\Repo"))!
  const returned = createModsThreadScope("thread", modsWorkspaceKey("C:\\Repo"))!
  expect(returned).toEqual(first)
  expect(returned).not.toBe(first)
  expect(Object.isFrozen(first)).toBe(true)
})
it("cannot revive a captured asynchronous continuation after disposal and reactivation", () => {
  const lifetime = createModsScopeLifetime()
  expect(lifetime.capture()).toBeNull()
  lifetime.activate()
  const token = lifetime.capture()
  expect(lifetime.isCurrent(token)).toBe(true)
  lifetime.dispose()
  expect(lifetime.isCurrent(token)).toBe(false)
  lifetime.activate()
  expect(lifetime.isCurrent(token)).toBe(false)
  expect(lifetime.isCurrent(lifetime.capture())).toBe(true)
})
