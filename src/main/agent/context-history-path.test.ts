import {
  access,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { describe, expect, it } from "vitest"
import {
  canonicalizeWorkspacePathSync,
  dedupePathsByRealLocation,
  deleteProjectThreadDataDirectory,
  getConversationHistoryDirectory,
  getProjectThreadDataDirectory,
  getProjectThreadDataDirectoryReadCandidatesSync,
  getProjectThreadDataDirectorySync,
  getThreadDataMigrationCacheDiagnosticsForTest,
  migrateProjectThreadDataDirectory,
  resetThreadDataMigrationCacheForTest,
  sanitizeHistoryPathComponent,
  setThreadDataMigrationNowForTest
} from "./context-history-path"

describe("conversation history paths", () => {
  it("canonical-dedupes alias roots even when the thread leaf does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-history-alias-root-"))
    const physicalRoot = join(root, "physical")
    const aliasRoot = join(root, "alias")
    await mkdir(physicalRoot, { recursive: true })
    await symlink(physicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir")

    try {
      const physicalCandidate = join(physicalRoot, "projects", "missing", "thread")
      const aliasCandidate = join(aliasRoot, "projects", "missing", "thread")
      await expect(
        dedupePathsByRealLocation([aliasCandidate, physicalCandidate])
      ).resolves.toEqual([aliasCandidate])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("uses the user-level CmbCowork project and thread directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-history-"))
    const workspace = join(root, "IdeaProjects", "firstDemo")
    const userHome = join(root, "home")
    await mkdir(workspace, { recursive: true })

    const canonicalWorkspace = await realpath(workspace)
    await expect(getConversationHistoryDirectory(workspace, "thread-123", userHome)).resolves.toBe(
      join(
        userHome,
        ".cmbcoworkagent",
        "projects",
        sanitizeHistoryPathComponent(canonicalWorkspace),
        "thread-123",
        "conversation_history"
      )
    )
  })

  it("uses Claude Code-compatible readable project slugs", () => {
    expect(sanitizeHistoryPathComponent("/Users/chenqiang/IdeaProjects/firstDemo")).toBe(
      "-Users-chenqiang-IdeaProjects-firstDemo"
    )
  })

  it("keeps synchronous workflow storage paths aligned with the async thread directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-path-sync-"))
    const workspace = join(root, "workspace")
    const userHome = join(root, "home")
    await mkdir(workspace, { recursive: true })

    try {
      expect(canonicalizeWorkspacePathSync(workspace)).toBe(await realpath(workspace))
      await expect(getProjectThreadDataDirectory(workspace, "thread-sync", userHome)).resolves.toBe(
        getProjectThreadDataDirectorySync(
          workspace,
          "thread-sync",
          join(userHome, ".cmbcoworkagent")
        )
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps all default thread paths under CMB_COWORK_AGENT_HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-path-override-"))
    const workspace = join(root, "workspace")
    const appDataRoot = join(root, "portable-data")
    const previous = process.env.CMB_COWORK_AGENT_HOME
    await mkdir(workspace, { recursive: true })
    process.env.CMB_COWORK_AGENT_HOME = appDataRoot

    try {
      const expected = getProjectThreadDataDirectorySync(workspace, "thread-portable")
      await expect(getProjectThreadDataDirectory(workspace, "thread-portable")).resolves.toBe(
        expected
      )
      await expect(getConversationHistoryDirectory(workspace, "thread-portable")).resolves.toBe(
        join(expected, "conversation_history")
      )

      await mkdir(join(expected, "large_tool_results"), { recursive: true })
      await deleteProjectThreadDataDirectory(workspace, "thread-portable")
      await expect(access(expected)).rejects.toThrow()
    } finally {
      if (previous === undefined) delete process.env.CMB_COWORK_AGENT_HOME
      else process.env.CMB_COWORK_AGENT_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it("lists the pre-custom-root directory as a read compatibility candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-path-candidates-"))
    const workspace = join(root, "workspace")
    const appDataRoot = join(root, "portable-data")
    const previous = process.env.CMB_COWORK_AGENT_HOME
    await mkdir(workspace, { recursive: true })
    process.env.CMB_COWORK_AGENT_HOME = appDataRoot

    try {
      const candidates = getProjectThreadDataDirectoryReadCandidatesSync(
        workspace,
        "thread-portable-candidate"
      )
      expect(candidates[0]).toBe(
        getProjectThreadDataDirectorySync(workspace, "thread-portable-candidate")
      )
      expect(candidates).toHaveLength(2)
      expect(candidates[1]).not.toBe(candidates[0])
    } finally {
      if (previous === undefined) delete process.env.CMB_COWORK_AGENT_HOME
      else process.env.CMB_COWORK_AGENT_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it("atomically migrates an old thread directory without losing nested data", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-data-migrate-"))
    const legacy = join(root, "legacy", "thread-1")
    const target = join(root, "portable", "thread-1")
    await mkdir(join(legacy, "conversation_history"), { recursive: true })
    await mkdir(join(legacy, "large_tool_results"), { recursive: true })
    await writeFile(join(legacy, "conversation_history", "session.json"), "history")
    await writeFile(join(legacy, "large_tool_results", "call-1"), "payload")

    try {
      await expect(migrateProjectThreadDataDirectory(legacy, target)).resolves.toBe(target)
      await expect(access(legacy)).rejects.toThrow()
      await expect(access(join(target, "conversation_history", "session.json"))).resolves.toBeUndefined()
      await expect(access(join(target, "large_tool_results", "call-1"))).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("converges concurrent migration attempts on one configured directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-data-migrate-race-"))
    const legacy = join(root, "legacy", "thread-1")
    const target = join(root, "portable", "thread-1")
    await mkdir(join(legacy, "conversation_history"), { recursive: true })
    await writeFile(join(legacy, "conversation_history", "session.json"), "history")

    try {
      await expect(
        Promise.all([
          migrateProjectThreadDataDirectory(legacy, target),
          migrateProjectThreadDataDirectory(legacy, target)
        ])
      ).resolves.toEqual([target, target])
      await expect(access(join(target, "conversation_history", "session.json"))).resolves.toBeUndefined()
      await expect(access(legacy)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("merges split roots without overwriting the configured-root copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-data-merge-"))
    const legacy = join(root, "legacy", "thread-1")
    const target = join(root, "portable", "thread-1")
    await mkdir(join(legacy, "conversation_history"), { recursive: true })
    await mkdir(join(target, "conversation_history"), { recursive: true })
    await writeFile(join(legacy, "conversation_history", "legacy.json"), "legacy")
    await writeFile(join(legacy, "conversation_history", "same.json"), "old")
    await writeFile(join(target, "conversation_history", "same.json"), "new")

    try {
      await expect(migrateProjectThreadDataDirectory(legacy, target)).resolves.toBe(target)
      await expect(access(join(target, "conversation_history", "legacy.json"))).resolves.toBeUndefined()
      await expect(readFile(join(target, "conversation_history", "same.json"), "utf8")).resolves.toBe(
        "new"
      )
      // A split source is retained as a read-only recovery source because its
      // colliding file was deliberately not allowed to overwrite newer data.
      await expect(access(join(legacy, "conversation_history", "same.json"))).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("uses the process cache and durable marker instead of recursively merging every turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-data-marker-"))
    const legacy = join(root, "legacy", "thread-1")
    const target = join(root, "portable", "thread-1")
    await mkdir(legacy, { recursive: true })
    await mkdir(target, { recursive: true })
    await writeFile(join(legacy, "initial.json"), "initial")

    try {
      await migrateProjectThreadDataDirectory(legacy, target)
      await expect(access(join(target, ".cmbcowork-migration.json"))).resolves.toBeUndefined()
      await writeFile(join(legacy, "written-by-old-build-later.json"), "late")

      await migrateProjectThreadDataDirectory(legacy, target)
      await expect(access(join(target, "written-by-old-build-later.json"))).rejects.toThrow()

      resetThreadDataMigrationCacheForTest()
      await migrateProjectThreadDataDirectory(legacy, target)
      await expect(access(join(target, "written-by-old-build-later.json"))).rejects.toThrow()
    } finally {
      resetThreadDataMigrationCacheForTest()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rechecks an absent legacy root after the bounded negative-cache TTL", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-data-negative-ttl-"))
    const legacy = join(root, "legacy", "thread-1")
    const target = join(root, "portable", "thread-1")
    let now = 1_000
    setThreadDataMigrationNowForTest(() => now)

    try {
      await migrateProjectThreadDataDirectory(legacy, target)
      await mkdir(legacy, { recursive: true })
      await writeFile(join(legacy, "late.json"), "late")

      // A hot turn stays stat-free and does not recursively copy immediately.
      await migrateProjectThreadDataDirectory(legacy, target)
      await expect(access(join(target, "late.json"))).rejects.toThrow()

      now += getThreadDataMigrationCacheDiagnosticsForTest().negativeTtlMs + 1
      await migrateProjectThreadDataDirectory(legacy, target)
      await expect(readFile(join(target, "late.json"), "utf8")).resolves.toBe("late")
    } finally {
      resetThreadDataMigrationCacheForTest()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("bounds absent-legacy negative cache entries with LRU eviction", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-data-negative-lru-"))
    const target = join(root, "portable", "thread-1")
    const { negativeMaxEntries } = getThreadDataMigrationCacheDiagnosticsForTest()
    setThreadDataMigrationNowForTest(() => 1_000)

    try {
      for (let index = 0; index < negativeMaxEntries + 8; index += 1) {
        await migrateProjectThreadDataDirectory(join(root, `legacy-${index}`), target)
      }
      expect(getThreadDataMigrationCacheDiagnosticsForTest().negativeEntries).toBe(
        negativeMaxEntries
      )
    } finally {
      resetThreadDataMigrationCacheForTest()
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)

  it("bounds completed migration targets and reloads an evicted durable marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-data-completed-lru-"))
    const { completedMaxTargets } = getThreadDataMigrationCacheDiagnosticsForTest()
    const firstLegacy = join(root, "legacy-0")
    const firstTarget = join(root, "target-0")

    try {
      for (let index = 0; index < completedMaxTargets + 1; index += 1) {
        const legacy = join(root, `legacy-${index}`)
        const target = join(root, `target-${index}`)
        await Promise.all([
          mkdir(legacy, { recursive: true }),
          mkdir(target, { recursive: true })
        ])
        await migrateProjectThreadDataDirectory(legacy, target)
      }
      expect(getThreadDataMigrationCacheDiagnosticsForTest().completedTargets).toBe(
        completedMaxTargets
      )

      // The first target was evicted from RAM, but its durable identity marker
      // must suppress a second recursive copy when it is touched again.
      let copied = false
      await migrateProjectThreadDataDirectory(firstLegacy, firstTarget, {
        copy: (async (...args: Parameters<typeof cp>) => {
          copied = true
          return cp(...args)
        }) as typeof cp,
        move: rename
      })
      expect(copied).toBe(false)
      expect(getThreadDataMigrationCacheDiagnosticsForTest().completedTargets).toBe(
        completedMaxTargets
      )
    } finally {
      resetThreadDataMigrationCacheForTest()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("keeps a successful merge hot-cached when marker persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-data-marker-fail-"))
    const legacy = join(root, "legacy", "thread-1")
    const target = join(root, "portable", "thread-1")
    await mkdir(legacy, { recursive: true })
    await mkdir(join(target, ".cmbcowork-migration.json"), { recursive: true })
    await writeFile(join(legacy, "first.json"), "first")

    try {
      await migrateProjectThreadDataDirectory(legacy, target)
      await writeFile(join(legacy, "second.json"), "second")

      // Marker publication failed because a directory occupies its path, but a
      // successful merge must still avoid a second recursive copy this process.
      await migrateProjectThreadDataDirectory(legacy, target)
      await expect(access(join(target, "second.json"))).rejects.toThrow()

      // A new process has no hot cache and therefore retries the missing durable
      // boundary (and the merge), making the late compatibility file visible.
      resetThreadDataMigrationCacheForTest()
      await migrateProjectThreadDataDirectory(legacy, target)
      await expect(readFile(join(target, "second.json"), "utf8")).resolves.toBe("second")
    } finally {
      resetThreadDataMigrationCacheForTest()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not mark a failed concurrent-rename merge and retries it", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-data-concurrent-fail-"))
    const legacy = join(root, "legacy", "thread-1")
    const target = join(root, "portable", "thread-1")
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, "legacy.json"), "legacy")

    try {
      await migrateProjectThreadDataDirectory(legacy, target, {
        copy: (async () => {
          throw new Error("injected partial concurrent copy")
        }) as typeof cp,
        move: (async () => {
          await mkdir(target, { recursive: true })
          throw Object.assign(new Error("concurrent publisher won"), { code: "EEXIST" })
        }) as typeof rename
      })
      await expect(access(join(target, ".cmbcowork-migration.json"))).rejects.toThrow()

      await migrateProjectThreadDataDirectory(legacy, target)
      await expect(readFile(join(target, "legacy.json"), "utf8")).resolves.toBe("legacy")
      await expect(access(join(target, ".cmbcowork-migration.json"))).resolves.toBeUndefined()
    } finally {
      resetThreadDataMigrationCacheForTest()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not mark a failed cross-volume publish-race merge and retries it", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-data-cross-fail-"))
    const legacy = join(root, "legacy", "thread-1")
    const target = join(root, "portable", "thread-1")
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, "legacy.json"), "legacy")
    let moveCalls = 0
    let copyCalls = 0

    try {
      await migrateProjectThreadDataDirectory(legacy, target, {
        copy: (async (...args: Parameters<typeof cp>) => {
          copyCalls += 1
          if (copyCalls === 1) return cp(...args)
          throw new Error("injected partial publish-race copy")
        }) as typeof cp,
        move: (async () => {
          moveCalls += 1
          if (moveCalls === 1) {
            throw Object.assign(new Error("cross volume"), { code: "EXDEV" })
          }
          await mkdir(target, { recursive: true })
          throw Object.assign(new Error("publisher won"), { code: "EEXIST" })
        }) as typeof rename
      })
      await expect(access(join(target, ".cmbcowork-migration.json"))).rejects.toThrow()

      await migrateProjectThreadDataDirectory(legacy, target)
      await expect(readFile(join(target, "legacy.json"), "utf8")).resolves.toBe("legacy")
      await expect(access(join(target, ".cmbcowork-migration.json"))).resolves.toBeUndefined()
    } finally {
      resetThreadDataMigrationCacheForTest()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("bounds unusually long project and thread path components", () => {
    const result = sanitizeHistoryPathComponent(`/workspace/${"nested/".repeat(80)}project`)
    expect(result.length).toBeLessThanOrEqual(255)
    expect(result).toMatch(/^[-a-zA-Z0-9]+$/)
    expect(result).toBe(sanitizeHistoryPathComponent(`/workspace/${"nested/".repeat(80)}project`))
  })

  it("deletes only the selected thread's app-managed history and large results", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-data-delete-"))
    const workspace = join(root, "workspace")
    const userHome = join(root, "home")
    await mkdir(workspace, { recursive: true })

    try {
      const targetDirectory = await getProjectThreadDataDirectory(
        workspace,
        "thread-target",
        userHome
      )
      const siblingDirectory = await getProjectThreadDataDirectory(
        workspace,
        "thread-sibling",
        userHome
      )
      await mkdir(join(targetDirectory, "conversation_history"), { recursive: true })
      await mkdir(join(targetDirectory, "large_tool_results"), { recursive: true })
      await mkdir(siblingDirectory, { recursive: true })
      await writeFile(join(targetDirectory, "conversation_history", "session.md"), "history")
      await writeFile(join(targetDirectory, "large_tool_results", "call-1"), "payload")
      await writeFile(join(siblingDirectory, "keep.txt"), "sibling")

      await deleteProjectThreadDataDirectory(workspace, "thread-target", userHome)

      await expect(access(targetDirectory)).rejects.toThrow()
      await expect(access(join(siblingDirectory, "keep.txt"))).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses an empty thread id instead of resolving the project directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-data-empty-id-"))
    try {
      await expect(getProjectThreadDataDirectory(root, "", join(root, "home"))).rejects.toThrow(
        "Thread ID is required"
      )
      expect(() =>
        getProjectThreadDataDirectorySync(root, "", join(root, "home", ".cmbcoworkagent"))
      ).toThrow("Thread ID is required")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
