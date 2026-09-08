import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const watcherMocks = vi.hoisted(() => ({
  existingDirectories: new Set(["openwork", "plugins"]),
  callbacks: new Map<
    string,
    (eventType: string, fileName: string | null) => void
  >()
}))

vi.mock("fs", () => ({
  existsSync: (path: string) => watcherMocks.existingDirectories.has(path),
  mkdirSync: (path: string) => {
    watcherMocks.existingDirectories.add(path)
  },
  watch: (
    directory: string,
    _options: unknown,
    callback: (eventType: string, fileName: string | null) => void
  ) => {
    watcherMocks.callbacks.set(directory, callback)
    const watcher = {
      on: vi.fn(() => watcher),
      close: vi.fn()
    }
    return watcher
  }
}))

vi.mock("../storage", () => ({
  getCustomSkillsDir: () => "custom-skills",
  getOpenworkDir: () => "openwork",
  getPluginsDir: () => "plugins",
  invalidateEnabledSkillsCache: vi.fn()
}))
vi.mock("../hooks/notifications", () => ({ notifyHooksChanged: vi.fn() }))

import {
  shouldBumpDisabledSkillStoreRevision,
  startHookConfigWatcher,
  stopHookConfigWatcher
} from "./hook-config-watcher"
import {
  getDisabledSkillStoreRevision,
  resetDisabledSkillStoreRevisionForTests
} from "../skills/disabled-store-revision"
import {
  getHookCatalogGlobalRevision,
  resetHookCatalogRevisionsForTests
} from "../hook-catalog/revision"

afterEach(() => {
  stopHookConfigWatcher()
  resetDisabledSkillStoreRevisionForTests()
  resetHookCatalogRevisionsForTests()
  watcherMocks.callbacks.clear()
  watcherMocks.existingDirectories.clear()
  watcherMocks.existingDirectories.add("openwork")
  watcherMocks.existingDirectories.add("plugins")
})

describe("hook config watcher disabled-skill revision fence", () => {
  it("conservatively advances the openwork revision when fs.watch omits the filename", () => {
    expect(shouldBumpDisabledSkillStoreRevision(null, true)).toBe(true)
  })

  it("only matches named disabled-skill events under the openwork watcher", () => {
    expect(shouldBumpDisabledSkillStoreRevision("disabled-skills.json", true)).toBe(true)
    expect(
      shouldBumpDisabledSkillStoreRevision(
        join("nested", "disabled-skills.json"),
        true
      )
    ).toBe(true)
    expect(shouldBumpDisabledSkillStoreRevision("plugins.json", true)).toBe(false)
    expect(
      shouldBumpDisabledSkillStoreRevision(join("review", "SKILL.md"), true)
    ).toBe(false)
  })

  it("never advances the disabled revision for custom/plugin watcher events", () => {
    expect(shouldBumpDisabledSkillStoreRevision(null, false)).toBe(false)
    expect(
      shouldBumpDisabledSkillStoreRevision("disabled-skills.json", false)
    ).toBe(false)
  })

  it("scopes unknown fs.watch events to the openwork root", () => {
    startHookConfigWatcher()

    watcherMocks.callbacks.get("custom-skills")?.("change", null)
    watcherMocks.callbacks.get("plugins")?.("change", null)
    expect(getDisabledSkillStoreRevision()).toBe(0)

    watcherMocks.callbacks.get("openwork")?.("change", null)
    expect(getDisabledSkillStoreRevision()).toBe(1)
  })

  it("creates and watches a missing custom root before the first skill is installed", () => {
    expect(watcherMocks.existingDirectories.has("custom-skills")).toBe(false)
    startHookConfigWatcher()

    expect(watcherMocks.existingDirectories.has("custom-skills")).toBe(true)
    expect(watcherMocks.callbacks.has("custom-skills")).toBe(true)
    watcherMocks.callbacks.get("custom-skills")?.("change", join("first", "SKILL.md"))
    expect(getHookCatalogGlobalRevision()).toBe(1)
  })

  it("immediately fences external directory rename events", () => {
    startHookConfigWatcher()

    watcherMocks.callbacks.get("custom-skills")?.("rename", "renamed-skill")
    expect(getHookCatalogGlobalRevision()).toBe(1)
  })
})
