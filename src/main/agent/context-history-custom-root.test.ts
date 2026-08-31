import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

describe("custom-root thread data compatibility", () => {
  const previousRoot = process.env.CMB_COWORK_AGENT_HOME

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.CMB_COWORK_AGENT_HOME
    else process.env.CMB_COWORK_AGENT_HOME = previousRoot
    vi.doUnmock("os")
    vi.resetModules()
  })

  it("treats a configured-root alias of the default root as one read location", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-root-alias-"))
    const workspace = join(root, "workspace")
    const legacyHome = join(root, "home")
    const defaultRoot = join(legacyHome, ".cmbcoworkagent")
    const configuredRoot = join(root, "portable-alias")
    await mkdir(workspace, { recursive: true })
    await mkdir(defaultRoot, { recursive: true })
    await symlink(
      defaultRoot,
      configuredRoot,
      process.platform === "win32" ? "junction" : "dir"
    )
    process.env.CMB_COWORK_AGENT_HOME = configuredRoot

    vi.resetModules()
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return { ...actual, homedir: () => legacyHome }
    })

    try {
      const {
        getProjectThreadDataDirectory,
        getProjectThreadDataDirectoryReadCandidates
      } = await import("./context-history-path")
      const candidates = await getProjectThreadDataDirectoryReadCandidates(
        workspace,
        "thread-alias"
      )
      expect(candidates).toHaveLength(1)
      expect(candidates[0].startsWith(configuredRoot)).toBe(true)
      await expect(getProjectThreadDataDirectory(workspace, "thread-alias")).resolves.toBe(
        candidates[0]
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("moves pre-custom-root history into the configured root before returning it", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-custom-root-"))
    const workspace = join(root, "workspace")
    const legacyHome = join(root, "home")
    const configuredRoot = join(root, "portable")
    await mkdir(workspace, { recursive: true })
    process.env.CMB_COWORK_AGENT_HOME = configuredRoot

    vi.resetModules()
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return { ...actual, homedir: () => legacyHome }
    })

    try {
      const { getProjectThreadDataDirectory, sanitizeHistoryPathComponent } = await import(
        "./context-history-path"
      )
      const projectComponent = sanitizeHistoryPathComponent(await realpath(workspace))
      const legacyDirectory = join(
        legacyHome,
        ".cmbcoworkagent",
        "projects",
        projectComponent,
        "thread-custom"
      )
      const targetDirectory = join(
        configuredRoot,
        "projects",
        projectComponent,
        "thread-custom"
      )
      await mkdir(join(legacyDirectory, "conversation_history"), { recursive: true })
      await writeFile(join(legacyDirectory, "conversation_history", "session.json"), "history")

      await expect(getProjectThreadDataDirectory(workspace, "thread-custom")).resolves.toBe(
        targetDirectory
      )
      await expect(access(legacyDirectory)).rejects.toThrow()
      await expect(
        access(join(targetDirectory, "conversation_history", "session.json"))
      ).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("negative-caches an absent legacy directory after the first custom-root resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-custom-negative-"))
    const workspace = join(root, "workspace")
    const legacyHome = join(root, "home")
    const configuredRoot = join(root, "portable")
    await mkdir(workspace, { recursive: true })
    process.env.CMB_COWORK_AGENT_HOME = configuredRoot

    vi.resetModules()
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return { ...actual, homedir: () => legacyHome }
    })

    try {
      const {
        getProjectThreadDataDirectory,
        setBeforeLegacyThreadDataProbeForTest
      } = await import("./context-history-path")
      let probes = 0
      setBeforeLegacyThreadDataProbeForTest(() => {
        probes += 1
      })

      const first = await getProjectThreadDataDirectory(workspace, "thread-new-negative")
      const second = await getProjectThreadDataDirectory(workspace, "thread-new-negative")
      expect(second).toBe(first)
      expect(probes).toBe(1)
      setBeforeLegacyThreadDataProbeForTest()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("bounds migrations across targets while preserving same-target coalescing", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-custom-pressure-"))
    const workspace = join(root, "workspace")
    const legacyHome = join(root, "home")
    const configuredRoot = join(root, "portable")
    await mkdir(workspace, { recursive: true })
    process.env.CMB_COWORK_AGENT_HOME = configuredRoot

    vi.resetModules()
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return { ...actual, homedir: () => legacyHome }
    })

    let releaseProbes: (() => void) | undefined
    const probeGate = new Promise<void>((resolve) => {
      releaseProbes = resolve
    })
    let migrations: Promise<string>[] = []
    try {
      const {
        getProjectThreadDataDirectory,
        getThreadDataMigrationCacheDiagnosticsForTest,
        sanitizeHistoryPathComponent,
        setBeforeLegacyThreadDataProbeForTest
      } = await import("./context-history-path")
      const projectComponent = sanitizeHistoryPathComponent(await realpath(workspace))
      const diagnostics = getThreadDataMigrationCacheDiagnosticsForTest()
      const admitted = diagnostics.migrationMaxActive + diagnostics.migrationMaxWaiters
      for (let index = 0; index <= admitted; index += 1) {
        const legacyDirectory = join(
          legacyHome,
          ".cmbcoworkagent",
          "projects",
          projectComponent,
          `thread-pressure-${index}`
        )
        await mkdir(legacyDirectory, { recursive: true })
        await writeFile(join(legacyDirectory, "history.json"), `${index}`)
      }
      setBeforeLegacyThreadDataProbeForTest(async () => probeGate)
      migrations = Array.from({ length: admitted }, (_, index) =>
        getProjectThreadDataDirectory(workspace, `thread-pressure-${index}`)
      )

      await vi.waitFor(() => {
        const current = getThreadDataMigrationCacheDiagnosticsForTest()
        expect(current.migrationActive).toBe(current.migrationMaxActive)
        expect(current.migrationWaiters).toBe(current.migrationMaxWaiters)
      })

      // Same-target callers still share the admitted migration even while the
      // global queue is full.
      const duplicate = getProjectThreadDataDirectory(workspace, "thread-pressure-0")
      const overflowThread = `thread-pressure-${admitted}`
      const overflowLegacy = join(
        legacyHome,
        ".cmbcoworkagent",
        "projects",
        projectComponent,
        overflowThread
      )
      const overflowTarget = join(configuredRoot, "projects", projectComponent, overflowThread)
      await expect(getProjectThreadDataDirectory(workspace, overflowThread)).resolves.toBe(
        overflowLegacy
      )
      await expect(access(overflowTarget)).rejects.toThrow()

      const targetOnlyThread = `thread-pressure-${admitted + 1}`
      const targetOnlyDirectory = join(
        configuredRoot,
        "projects",
        projectComponent,
        targetOnlyThread
      )
      await mkdir(targetOnlyDirectory, { recursive: true })
      await expect(getProjectThreadDataDirectory(workspace, targetOnlyThread)).resolves.toBe(
        targetOnlyDirectory
      )

      const newThread = `thread-pressure-${admitted + 2}`
      const newTargetDirectory = join(configuredRoot, "projects", projectComponent, newThread)
      await expect(getProjectThreadDataDirectory(workspace, newThread)).resolves.toBe(
        newTargetDirectory
      )
      await expect(access(newTargetDirectory)).rejects.toThrow()

      releaseProbes?.()
      const migrated = await Promise.all(migrations)
      await expect(duplicate).resolves.toBe(migrated[0])
      expect(migrated.every((directory) => directory.startsWith(configuredRoot))).toBe(true)
      expect(getThreadDataMigrationCacheDiagnosticsForTest()).toMatchObject({
        migrationActive: 0,
        migrationWaiters: 0
      })
      setBeforeLegacyThreadDataProbeForTest()
    } finally {
      releaseProbes?.()
      await Promise.allSettled(migrations)
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("clears the completed migration cache when a fixed-id thread is deleted and recreated", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-thread-custom-recreate-"))
    const workspace = join(root, "workspace")
    const legacyHome = join(root, "home")
    const configuredRoot = join(root, "portable")
    const threadId = "thread-fixed-recreate"
    await mkdir(workspace, { recursive: true })
    process.env.CMB_COWORK_AGENT_HOME = configuredRoot

    vi.resetModules()
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return { ...actual, homedir: () => legacyHome }
    })

    try {
      const {
        deleteProjectThreadDataDirectory,
        getProjectThreadDataDirectory,
        sanitizeHistoryPathComponent
      } = await import("./context-history-path")
      const projectComponent = sanitizeHistoryPathComponent(await realpath(workspace))
      const legacyDirectory = join(
        legacyHome,
        ".cmbcoworkagent",
        "projects",
        projectComponent,
        threadId
      )
      const targetDirectory = join(configuredRoot, "projects", projectComponent, threadId)
      await mkdir(legacyDirectory, { recursive: true })
      await mkdir(targetDirectory, { recursive: true })
      await writeFile(join(legacyDirectory, "first.json"), "first")
      await getProjectThreadDataDirectory(workspace, threadId)

      await deleteProjectThreadDataDirectory(workspace, threadId)
      await mkdir(legacyDirectory, { recursive: true })
      await writeFile(join(legacyDirectory, "second.json"), "second")

      await expect(getProjectThreadDataDirectory(workspace, threadId)).resolves.toBe(
        targetDirectory
      )
      await expect(readFile(join(targetDirectory, "second.json"), "utf8")).resolves.toBe(
        "second"
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("discovers workflow runs left under the pre-custom-root managed directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-workflow-custom-root-"))
    const workspace = join(root, "workspace")
    const legacyHome = join(root, "home")
    const configuredRoot = join(root, "portable")
    const threadId = "thread-workflow-custom"
    const runId = "wf_custom123"
    await mkdir(workspace, { recursive: true })
    process.env.CMB_COWORK_AGENT_HOME = configuredRoot

    vi.resetModules()
    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return { ...actual, homedir: () => legacyHome }
    })

    try {
      const { sanitizeHistoryPathComponent } = await import("./context-history-path")
      const { listWorkflowRunsPage } = await import("./workflow/run-store")
      const legacyRunDir = join(
        legacyHome,
        ".cmbcoworkagent",
        "projects",
        sanitizeHistoryPathComponent(await realpath(workspace)),
        threadId,
        "workflows"
      )
      await mkdir(legacyRunDir, { recursive: true })
      await writeFile(
        join(legacyRunDir, `${runId}.json.bak`),
        JSON.stringify({
          version: 1,
          runId,
          threadId,
          workflowName: "legacy custom-root run",
          script: "export default async () => null",
          scriptSha256: "legacy",
          status: "completed",
          phases: [],
          currentPhase: null,
          agents: [],
          worktrees: [],
          logs: [],
          journal: [],
          stats: {
            agentsTotal: 0,
            agentsCached: 0,
            agentsFailed: 0,
            outputTokens: 0,
            durationMs: 1
          },
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          notificationDelivered: false
        })
      )

      const page = await listWorkflowRunsPage(workspace, threadId)
      expect(page.runs.map((run) => run.runId)).toEqual([runId])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
