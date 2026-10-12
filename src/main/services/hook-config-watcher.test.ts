import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { notifyHooksChanged } from "../hooks/notifications"
import { subscribeRuntimeConfiguration } from "../runtime-configuration-events"

const watcherMocks = vi.hoisted(() => ({
  existingDirectories: new Set(["openwork", "plugins"]),
  callbacks: new Map<string, (eventType: string, fileName: string | null) => void>(),
  files: new Map<string, number>(),
  directoryVersions: new Map<string, number>(),
  failedDirectories: new Set<string>(),
  symlinks: new Set<string>(),
  reads: 0,
  heldRead: null as null | { directory: string; wait: Promise<void> },
  closes: [] as ReturnType<typeof vi.fn>[]
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

vi.mock("node:fs/promises", () => ({
  lstat: async (path: string) => {
    const directory = watcherMocks.existingDirectories.has(path)
    const version = watcherMocks.files.get(path)
    if (!directory && version === undefined)
      throw Object.assign(new Error("missing"), { code: "ENOENT" })
    return {
      mode: directory ? 0o40700n : 0o100600n,
      dev: 1n,
      ino: BigInt(directory ? (watcherMocks.directoryVersions.get(path) ?? 1) : version!),
      size: BigInt(directory ? 0 : version!),
      mtimeNs: BigInt(version ?? 1),
      ctimeNs: BigInt(version ?? 1),
      isDirectory: () => directory,
      isSymbolicLink: () => watcherMocks.symlinks.has(path)
    }
  },
  opendir: async (path: string) => {
    watcherMocks.reads++
    if (watcherMocks.heldRead?.directory === path) await watcherMocks.heldRead.wait
    if (watcherMocks.failedDirectories.has(path))
      throw Object.assign(new Error("denied"), { code: "EACCES" })
    const names = [...watcherMocks.existingDirectories, ...watcherMocks.files.keys()].filter(
      (candidate) =>
        candidate.startsWith(path + "/") && !candidate.slice(path.length + 1).includes("/")
    )
    let index = 0
    const close = vi.fn(async () => {})
    watcherMocks.closes.push(close)
    return {
      read: async () => {
        const candidate = names[index++]
        return candidate
          ? {
              name: candidate.slice(path.length + 1),
              isDirectory: () =>
                watcherMocks.existingDirectories.has(candidate) &&
                !watcherMocks.symlinks.has(candidate)
            }
          : null
      },
      close
    }
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
  vi.useRealTimers()
  vi.clearAllMocks()
  resetDisabledSkillStoreRevisionForTests()
  resetHookCatalogRevisionsForTests()
  watcherMocks.callbacks.clear()
  watcherMocks.files.clear()
  watcherMocks.directoryVersions.clear()
  watcherMocks.failedDirectories.clear()
  watcherMocks.symlinks.clear()
  watcherMocks.heldRead = null
  watcherMocks.reads = 0
  watcherMocks.closes.length = 0
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
    expect(shouldBumpDisabledSkillStoreRevision(join("nested", "disabled-skills.json"), true)).toBe(
      true
    )
    expect(shouldBumpDisabledSkillStoreRevision("plugins.json", true)).toBe(false)
    expect(shouldBumpDisabledSkillStoreRevision(join("review", "SKILL.md"), true)).toBe(false)
  })

  it("never advances the disabled revision for custom/plugin watcher events", () => {
    expect(shouldBumpDisabledSkillStoreRevision(null, false)).toBe(false)
    expect(shouldBumpDisabledSkillStoreRevision("disabled-skills.json", false)).toBe(false)
  })

  it("scopes unknown fs.watch events to the openwork root", async () => {
    await startHookConfigWatcher()

    watcherMocks.callbacks.get("custom-skills")?.("change", null)
    watcherMocks.callbacks.get("plugins")?.("change", null)
    expect(getDisabledSkillStoreRevision()).toBe(0)

    watcherMocks.callbacks.get("openwork")?.("change", null)
    expect(getDisabledSkillStoreRevision()).toBe(1)
  })

  it("creates and watches a missing custom root before the first skill is installed", async () => {
    expect(watcherMocks.existingDirectories.has("custom-skills")).toBe(false)
    await startHookConfigWatcher()

    expect(watcherMocks.existingDirectories.has("custom-skills")).toBe(true)
    expect(watcherMocks.callbacks.has("custom-skills")).toBe(true)
    watcherMocks.callbacks.get("custom-skills")?.("change", join("first", "SKILL.md"))
    expect(getHookCatalogGlobalRevision()).toBe(1)
  })

  it("immediately fences external directory rename events", async () => {
    await startHookConfigWatcher()

    watcherMocks.callbacks.get("custom-skills")?.("rename", "renamed-skill")
    expect(getHookCatalogGlobalRevision()).toBe(1)
  })

  it("ignores queued callbacks after watcher shutdown", async () => {
    vi.useFakeTimers()
    await startHookConfigWatcher()
    const late = watcherMocks.callbacks.get("custom-skills")!
    stopHookConfigWatcher()
    late("change", "SKILL.md")
    vi.advanceTimersByTime(200)
    expect(getHookCatalogGlobalRevision()).toBe(0)
    expect(notifyHooksChanged).not.toHaveBeenCalled()
  })

  it("rebinds a replaced root without accepting events from the retired watcher", async () => {
    await startHookConfigWatcher()
    const retired = watcherMocks.callbacks.get("custom-skills")!
    watcherMocks.callbacks.get("openwork")!("rename", "custom-skills")
    await vi.waitFor(() => expect(watcherMocks.callbacks.get("custom-skills")).not.toBe(retired))
    const replacement = watcherMocks.callbacks.get("custom-skills")!
    const revision = getHookCatalogGlobalRevision()
    retired("change", "SKILL.md")
    expect(getHookCatalogGlobalRevision()).toBe(revision)
    replacement("change", "SKILL.md")
    expect(getHookCatalogGlobalRevision()).toBe(revision + 1)
  })

  it("does not revoke running Bots for unrelated data-root file or directory changes", async () => {
    vi.useFakeTimers()
    const changed = vi.fn()
    const unsubscribe = subscribeRuntimeConfiguration(changed)
    try {
      await startHookConfigWatcher()
      for (const name of [
        "shell-project",
        "bot-host",
        "settings.json",
        "logs",
        "cmbcoworkagent.sqlite-wal"
      ]) {
        watcherMocks.callbacks.get("openwork")?.("rename", name)
        watcherMocks.callbacks.get("openwork")?.("change", name)
      }
      vi.advanceTimersByTime(200)
      expect(changed).not.toHaveBeenCalled()
      expect(notifyHooksChanged).not.toHaveBeenCalled()
      expect(getHookCatalogGlobalRevision()).toBe(0)
      expect(getDisabledSkillStoreRevision()).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  it.each(["custom-skills", "plugins", "plugins.json", "disabled-skills.json", "hooks.json", null])(
    "still fences relevant data-root changes immediately: %s",
    async (name) => {
      await startHookConfigWatcher()
      watcherMocks.callbacks.get("openwork")?.("rename", name)
      expect(getHookCatalogGlobalRevision()).toBe(1)
      expect(getDisabledSkillStoreRevision()).toBe(
        name === null || name === "disabled-skills.json" ? 1 : 0
      )
    }
  )
})

describe("finite native registration reconciliation", () => {
  const flush = async () => {
    for (let i = 0; i < 60; i++) await Promise.resolve()
  }
  it("fences one lost initial root write and nested manifest without replaying a native event", async () => {
    vi.useFakeTimers()
    await startHookConfigWatcher()
    watcherMocks.files.set("custom-skills/SKILL.md", 2)
    watcherMocks.existingDirectories.add("plugins/team")
    watcherMocks.files.set("plugins/team/plugin.json", 3)
    await vi.advanceTimersByTimeAsync(150)
    expect(getHookCatalogGlobalRevision()).toBe(2)
    expect(getDisabledSkillStoreRevision()).toBe(0)
    await vi.advanceTimersByTimeAsync(600)
    expect(getHookCatalogGlobalRevision()).toBe(2)
    const reads = watcherMocks.reads
    await vi.advanceTimersByTimeAsync(30_000)
    expect(watcherMocks.reads).toBe(reads)
    for (const close of watcherMocks.closes) expect(close).toHaveBeenCalledOnce()
  })
  it("does not bump startup or unchanged catalog identity, even for pre-existing manifests", async () => {
    vi.useFakeTimers()
    watcherMocks.files.set("custom-skills/SKILL.md", 1)
    await startHookConfigWatcher()
    await vi.advanceTimersByTimeAsync(1000)
    expect(getHookCatalogGlobalRevision()).toBe(0)
    expect(notifyHooksChanged).not.toHaveBeenCalled()
  })
  it("detects disabled-store mutation and root inode replacement during the registration window", async () => {
    vi.useFakeTimers()
    await startHookConfigWatcher()
    const retired = watcherMocks.callbacks.get("custom-skills")!
    watcherMocks.files.set("openwork/disabled-skills.json", 2)
    watcherMocks.directoryVersions.set("custom-skills", 7)
    await vi.advanceTimersByTimeAsync(150)
    expect(getDisabledSkillStoreRevision()).toBe(1)
    expect(getHookCatalogGlobalRevision()).toBeGreaterThan(0)
    const replacement = watcherMocks.callbacks.get("custom-skills")!
    expect(replacement).not.toBe(retired)
    const revision = getHookCatalogGlobalRevision()
    retired("change", "SKILL.md")
    expect(getHookCatalogGlobalRevision()).toBe(revision)
    watcherMocks.files.set("custom-skills/SKILL.md", 8)
    await vi.advanceTimersByTimeAsync(700)
    expect(getHookCatalogGlobalRevision()).toBeGreaterThan(revision)
  })
  it("ignores stopped startup and closes a directory handle delivered after retirement", async () => {
    let release!: () => void
    watcherMocks.heldRead = {
      directory: "custom-skills",
      wait: new Promise<void>((resolve) => {
        release = resolve
      })
    }
    const initializing = startHookConfigWatcher()
    await flush()
    stopHookConfigWatcher()
    watcherMocks.files.set("custom-skills/SKILL.md", 9)
    release()
    await initializing
    expect(watcherMocks.callbacks.has("custom-skills")).toBe(false)
    expect(getHookCatalogGlobalRevision()).toBe(0)
    for (const close of watcherMocks.closes) expect(close).toHaveBeenCalledOnce()
  })
  it("never publishes a late reconciliation into a replacement watcher generation", async () => {
    vi.useFakeTimers()
    await startHookConfigWatcher()
    let release!: () => void
    watcherMocks.heldRead = {
      directory: "custom-skills",
      wait: new Promise<void>((resolve) => {
        release = resolve
      })
    }
    await vi.advanceTimersByTimeAsync(100)
    stopHookConfigWatcher()
    watcherMocks.heldRead = null
    await startHookConfigWatcher()
    watcherMocks.files.set("custom-skills/SKILL.md", 12)
    release()
    await flush()
    expect(getHookCatalogGlobalRevision()).toBe(0)
    await vi.advanceTimersByTimeAsync(150)
    expect(getHookCatalogGlobalRevision()).toBe(1)
  })
  it("conservatively invalidates incomplete source reads without retaining a scan loop", async () => {
    vi.useFakeTimers()
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      watcherMocks.failedDirectories.add("custom-skills")
      await startHookConfigWatcher()
      await vi.advanceTimersByTimeAsync(1200)
      expect(getHookCatalogGlobalRevision()).toBeGreaterThan(0)
      expect(warning).toHaveBeenCalled()
      const reads = watcherMocks.reads
      await vi.advanceTimersByTimeAsync(30_000)
      expect(watcherMocks.reads).toBe(reads)
    } finally {
      warning.mockRestore()
    }
  })
})

it("keeps registration scans bounded and never traverses symlinks or dependency directories", async () => {
  vi.useFakeTimers()
  watcherMocks.existingDirectories.add("custom-skills/node_modules")
  watcherMocks.existingDirectories.add("custom-skills/link")
  watcherMocks.symlinks.add("custom-skills/link")
  watcherMocks.files.set("custom-skills/node_modules/SKILL.md", 1)
  watcherMocks.files.set("custom-skills/link/SKILL.md", 2)
  await startHookConfigWatcher()
  await vi.advanceTimersByTimeAsync(1200)
  expect(watcherMocks.reads).toBe(6) // two catalog roots, baseline + two finite checks
  expect(getHookCatalogGlobalRevision()).toBe(0)
  const reads = watcherMocks.reads
  await vi.advanceTimersByTimeAsync(30_000)
  expect(watcherMocks.reads).toBe(reads)
})
it("invalidates over-budget snapshots instead of accepting a partial unchanged projection", async () => {
  vi.useFakeTimers()
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    for (let i = 0; i < 2100; i++) watcherMocks.existingDirectories.add(`custom-skills/item-${i}`)
    await startHookConfigWatcher()
    await vi.advanceTimersByTimeAsync(1500)
    expect(getHookCatalogGlobalRevision()).toBeGreaterThan(0)
    expect(warning).toHaveBeenCalled()
    const reads = watcherMocks.reads
    await vi.advanceTimersByTimeAsync(30_000)
    expect(watcherMocks.reads).toBe(reads)
  } finally {
    warning.mockRestore()
  }
}, 10_000)
it("a synchronous shutdown subscriber cannot rearm a reconciliation or root watcher", async () => {
  vi.useFakeTimers()
  await startHookConfigWatcher()
  const unsubscribe = subscribeRuntimeConfiguration(stopHookConfigWatcher)
  try {
    watcherMocks.directoryVersions.set("custom-skills", 8)
    await vi.advanceTimersByTimeAsync(150)
    const revision = getHookCatalogGlobalRevision(),
      reads = watcherMocks.reads
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getHookCatalogGlobalRevision()).toBe(revision)
    expect(watcherMocks.reads).toBe(reads)
    for (const close of watcherMocks.closes) expect(close).toHaveBeenCalledOnce()
  } finally {
    unsubscribe()
  }
})
