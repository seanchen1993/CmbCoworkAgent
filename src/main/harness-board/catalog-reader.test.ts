import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { mkdtemp, rm } from "node:fs/promises"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  getHarnessCatalogReaderCacheDiagnosticsForTests,
  HARNESS_BOARD_CONFIG_MAX_BYTES,
  HARNESS_CONFIG_CACHE_MAX_BYTES,
  HARNESS_CONFIG_CACHE_MAX_ENTRIES,
  HARNESS_PROJECT_STORE_MAX_BYTES,
  HARNESS_PROJECT_STORE_MAX_PROJECTS,
  readHarnessCatalogPage,
  readHarnessDialogTips,
  readHarnessProjectContexts,
  resetHarnessCatalogReaderCacheForTests
} from "./catalog-reader"
import {
  HARNESS_CATALOG_MAX_RESPONSE_BYTES,
  HARNESS_DIALOG_TIPS_MAX_RESPONSE_BYTES
} from "./catalog-protocol"
import { HARNESS_WORKER_RESOURCE_LIMITS, harnessWorkerOptions } from "./worker-limits"
import { HARNESS_PROJECT_TEXT_MAX_CHARS } from "./store-limits"

const tempDirs: string[] = []
let workerBuildDirectory = ""
let workerBundlePath = ""

beforeAll(async () => {
  workerBuildDirectory = mkdtempSync(join(tmpdir(), "cmb-harness-catalog-worker-build-"))
  workerBundlePath = join(workerBuildDirectory, "catalog-worker.cjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./catalog-worker.ts", import.meta.url))],
    outfile: workerBundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22"
  })
})

afterAll(() => {
  rmSync(workerBuildDirectory, { recursive: true, force: true })
})

afterEach(async () => {
  resetHarnessCatalogReaderCacheForTests()
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makeCatalog(size: number): Promise<{ projects: string; plugins: string }> {
  const root = await mkdtemp(join(tmpdir(), "harness-catalog-"))
  tempDirs.push(root)
  const pluginRoot = join(root, "plugin")
  mkdirSync(join(pluginRoot, "board_core"), { recursive: true })
  writeFileSync(
    join(pluginRoot, "board_core", "board_config.json"),
    JSON.stringify({
      apiVersion: 1,
      inspectCommands: {
        [process.platform]: {
          session_context_inject: "run",
          pull_knowledge: "pull",
          dialog_tips: "Project ${projectCode} feature ${feature} token ${leanToken}"
        }
      }
    })
  )
  const pluginRows = Array.from({ length: size }, (_, index) => ({
    id: `adapter-${index}`,
    name: `Adapter ${index}`,
    version: "1.0.0",
    description: "x".repeat(200),
    path: pluginRoot,
    enabled: true,
    author: "test",
    skillCount: 0,
    mcpServerCount: 0,
    createdAt: "",
    updatedAt: ""
  }))
  const projectRows = Array.from({ length: size }, (_, index) => ({
    projectId: `project-${index}`,
    name: `Project ${index}`,
    description: "d".repeat(2_000),
    projectCode: `P${index}`,
    projectDir: `p-${index}`,
    systemId: `system-${index % 1_000}`,
    systemName: `System ${index % 1_000}`,
    workspacePath: root,
    "harness-adapter": {
      id: `adapter-${index}`,
      name: `Adapter ${index}`,
      version: "1.0.0",
      type: "plugin"
    },
    lifecycle: { status: index % 5 === 0 ? "archived" : "active", createAt: "2026-01-01" }
  }))
  const projects = join(root, "projects.json")
  const plugins = join(root, "plugins.json")
  writeFileSync(projects, JSON.stringify({ version: 1, projects: projectRows }))
  writeFileSync(plugins, JSON.stringify(pluginRows))
  return { projects, plugins }
}

describe("Harness catalog reader", () => {
  it("keeps a near-limit project/plugin response paged and below the IPC byte cap", async () => {
    const paths = await makeCatalog(1_000)
    const first = readHarnessCatalogPage(paths.projects, paths.plugins, {
      projectLimit: 64,
      registryLimit: 64
    })
    expect(first.projects).toHaveLength(64)
    expect(first.registry).toHaveLength(64)
    expect(first.summary.totalProjects).toBe(1_000)
    expect(first.summary.totalRegistry).toBe(1_000)
    expect(first.projectNextCursor).toBe(64)
    expect(first.registryNextCursor).toBe(64)
    expect(first.stats.responseBytes).toBeLessThanOrEqual(HARNESS_CATALOG_MAX_RESPONSE_BYTES)

    const selected = readHarnessCatalogPage(paths.projects, paths.plugins, {
      projectId: "project-999",
      projectLimit: 1,
      includeRegistry: false
    })
    expect(selected.projects.map((project) => project.projectId)).toEqual(["project-999"])
    expect(selected.stats.responseBytes).toBeLessThan(HARNESS_CATALOG_MAX_RESPONSE_BYTES)
  }, 20_000)

  it("observes a shared cancellation flag while scanning", async () => {
    const paths = await makeCatalog(1_000)
    const flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    Atomics.store(flag, 0, 1)
    const result = readHarnessCatalogPage(paths.projects, paths.plugins, {}, undefined, flag)
    expect(result.stats.cancelled).toBe(true)
    expect(result.projects).toHaveLength(0)
  })

  it("projects authoritative contexts by id from a cached near-limit store", async () => {
    const paths = await makeCatalog(1_000)
    const selectedProjectDirectory = join(paths.projects, "..", "p-999")
    mkdirSync(selectedProjectDirectory, { recursive: true })
    const first = readHarnessProjectContexts(paths.projects, paths.plugins, [
      "project-999",
      "missing"
    ])
    expect(first.projects["project-999"]).toMatchObject({
      project: { projectId: "project-999", projectDir: "p-999" },
      plugin: { id: "adapter-999" },
      configSnapshot: { value: { apiVersion: 1 }, error: null },
      projectDirectoryExists: true
    })
    expect(first.projects.missing).toBeNull()
    expect(first.stats.responseBytes).toBeLessThanOrEqual(HARNESS_CATALOG_MAX_RESPONSE_BYTES)

    const cached = readHarnessProjectContexts(paths.projects, paths.plugins, ["project-0"])
    expect(cached.projects["project-0"]?.project.projectId).toBe("project-0")
    expect(cached.stats.responseBytes).toBeLessThanOrEqual(HARNESS_CATALOG_MAX_RESPONSE_BYTES)
  }, 20_000)

  it("projects selected feature deploy units in the worker and refreshes mapping snapshots", async () => {
    const paths = await makeCatalog(1)
    const root = join(paths.projects, "..")
    const featureBindingStorePath = join(root, "harness-board-features.json")
    const deployUnitMappingStorePath = join(root, "harness-deployUnitId-mapping.json")
    writeFileSync(
      featureBindingStorePath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            projectId: "project-0",
            featureId: "feature-a",
            selectedDeployUnitMappings: [
              {
                deployUnitIdMapping: "mapping-a",
                deployUnitId: "snapshot-id",
                localRepoPath: "C:/snapshot"
              }
            ]
          }
        ]
      })
    )
    writeFileSync(
      deployUnitMappingStorePath,
      JSON.stringify({
        version: 1,
        mappings: [
          {
            deployUnitIdMapping: "mapping-a",
            deployUnitId: "current-id",
            localRepoPath: "C:/current"
          }
        ]
      })
    )

    const result = readHarnessProjectContexts(
      paths.projects,
      paths.plugins,
      ["project-0"],
      undefined,
      undefined,
      { featureSlug: "feature-a", featureBindingStorePath, deployUnitMappingStorePath }
    )

    expect(result.projects["project-0"]?.selectedDeployUnits).toEqual([
      {
        deployUnitIdMapping: "mapping-a",
        deployUnitId: "current-id",
        localRepoPath: "C:/current"
      }
    ])
    expect(result.projects["project-0"]?.sessionContextInjectionSource).toBe("cmbdevclaw")
    expect(result.stats.responseBytes).toBeLessThanOrEqual(HARNESS_CATALOG_MAX_RESPONSE_BYTES)
  })

  it("keeps the main ticker moving while the worker opens a cold near-limit store", async () => {
    const paths = await makeCatalog(1_000)
    const leanTokenStorePath = join(paths.projects, "..", "leanstar-config.json")
    writeFileSync(leanTokenStorePath, JSON.stringify({ leanToken: "secret" }))
    const worker = new Worker(
      workerBundlePath,
      harnessWorkerOptions("harness-catalog-performance-test")
    )
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    const startedAt = performance.now()
    try {
      expect(worker.resourceLimits).toMatchObject(HARNESS_WORKER_RESOURCE_LIMITS)
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.once("error", reject)
        worker.once("message", (response: { ok: boolean; result?: Record<string, unknown> }) => {
          if (response.ok && response.result) resolve(response.result)
          else reject(new Error("Harness catalog worker request failed"))
        })
        worker.postMessage({
          type: "read-dialog-tips",
          requestId: 1,
          projectStorePath: paths.projects,
          pluginStorePath: paths.plugins,
          leanTokenStorePath,
          projectId: "project-999",
          slug: "feature-a",
          maxResponseBytes: HARNESS_DIALOG_TIPS_MAX_RESPONSE_BYTES,
          cancelBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
        })
      })
      expect(result).toMatchObject({
        tips: "Project P999 feature feature-a token secret"
      })
      expect(ticks).toBeGreaterThan(0)
      expect(performance.now() - startedAt).toBeLessThan(5_000)
    } finally {
      clearInterval(ticker)
      await worker.terminate()
    }
  }, 20_000)

  it("projects dialog tips in the catalog worker boundary with a strict byte cap", async () => {
    const paths = await makeCatalog(1)
    const leanTokenStorePath = join(paths.projects, "..", "leanstar-config.json")
    writeFileSync(leanTokenStorePath, JSON.stringify({ leanToken: "bounded-token" }))

    const result = readHarnessDialogTips(
      paths.projects,
      paths.plugins,
      leanTokenStorePath,
      "project-0",
      "feature-b"
    )

    expect(result.tips).toBe("Project P0 feature feature-b token bounded-token")
    expect(result.stats.responseBytes).toBeLessThanOrEqual(
      HARNESS_DIALOG_TIPS_MAX_RESPONSE_BYTES
    )
  })

  it("invalidates project and board-config caches when their signatures change", async () => {
    const paths = await makeCatalog(1)
    const first = readHarnessProjectContexts(paths.projects, paths.plugins, ["project-0"])
    expect(first.projects["project-0"]?.project.name).toBe("Project 0")
    expect(first.projects["project-0"]?.configSnapshot?.value).toMatchObject({ apiVersion: 1 })

    const projectStore = JSON.parse(readFileSync(paths.projects, "utf8")) as {
      projects: Array<Record<string, unknown>>
    }
    projectStore.projects[0]!.name = "Renamed project"
    writeFileSync(paths.projects, JSON.stringify({ version: 1, projects: projectStore.projects }))

    const pluginRows = JSON.parse(readFileSync(paths.plugins, "utf8")) as Array<{
      path: string
    }>
    writeFileSync(
      join(pluginRows[0]!.path, "board_core", "board_config.json"),
      JSON.stringify({
        apiVersion: 2,
        inspectCommands: { [process.platform]: { feature_status: "new-command" } }
      })
    )

    const updated = readHarnessProjectContexts(paths.projects, paths.plugins, ["project-0"])
    expect(updated.projects["project-0"]?.project.name).toBe("Renamed project")
    expect(updated.projects["project-0"]?.configSnapshot?.value).toMatchObject({
      apiVersion: 2,
      inspectCommands: { [process.platform]: { feature_status: "new-command" } }
    })
  })

  it("advances past corrupt matching rows instead of repeating a page cursor", async () => {
    const paths = await makeCatalog(2)
    writeFileSync(
      paths.projects,
      JSON.stringify({
        version: 1,
        projects: [
          { projectId: "corrupt", name: "Corrupt" },
          {
            projectId: "valid",
            name: "Valid",
            projectCode: "V",
            workspacePath: "C:/valid",
            "harness-adapter": {
              id: "adapter-0",
              name: "Adapter 0",
              version: "1.0.0",
              type: "plugin"
            },
            lifecycle: { status: "active", createAt: "2026-01-01" }
          }
        ]
      })
    )
    resetHarnessCatalogReaderCacheForTests()
    const page = readHarnessCatalogPage(paths.projects, paths.plugins, {
      projectLimit: 1,
      includeRegistry: false
    })
    expect(page.projects.map((project) => project.projectId)).toEqual(["valid"])
    expect(page.projectNextCursor).toBeNull()
  })

  it("rejects oversized and over-count project stores before retaining their rows", async () => {
    const paths = await makeCatalog(1)
    writeFileSync(
      paths.projects,
      `${JSON.stringify({ version: 1, projects: [] })}${" ".repeat(HARNESS_PROJECT_STORE_MAX_BYTES)}`
    )
    expect(() =>
      readHarnessCatalogPage(paths.projects, paths.plugins, { includeRegistry: false })
    ).toThrow(`Harness project store exceeded ${HARNESS_PROJECT_STORE_MAX_BYTES} bytes`)

    writeFileSync(
      paths.projects,
      JSON.stringify({
        version: 1,
        projects: Array.from({ length: HARNESS_PROJECT_STORE_MAX_PROJECTS + 1 }, () => ({}))
      })
    )
    resetHarnessCatalogReaderCacheForTests()
    expect(() =>
      readHarnessCatalogPage(paths.projects, paths.plugins, { includeRegistry: false })
    ).toThrow(`Harness project store exceeded ${HARNESS_PROJECT_STORE_MAX_PROJECTS} projects`)

    const worker = new Worker(
      workerBundlePath,
      harnessWorkerOptions("harness-catalog-over-count-test")
    )
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      const response = await new Promise<{
        ok: boolean
        error?: { message?: string }
      }>((resolve, reject) => {
        worker.once("error", reject)
        worker.once("message", resolve)
        worker.postMessage({
          type: "read-page",
          requestId: 1,
          projectStorePath: paths.projects,
          pluginStorePath: paths.plugins,
          input: { includeRegistry: false },
          maxResponseBytes: HARNESS_CATALOG_MAX_RESPONSE_BYTES,
          cancelBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
        })
      })
      expect(response.ok).toBe(false)
      expect(response.error?.message).toContain(
        `exceeded ${HARNESS_PROJECT_STORE_MAX_PROJECTS} projects`
      )
      expect(ticks).toBeGreaterThan(0)
    } finally {
      clearInterval(ticker)
      await worker.terminate()
    }
  })

  it("rejects oversized project fields and isolates oversized board config parsing", async () => {
    const paths = await makeCatalog(1)
    const projectStore = JSON.parse(readFileSync(paths.projects, "utf8")) as {
      projects: Array<Record<string, unknown>>
    }
    projectStore.projects[0]!.name = "x".repeat(HARNESS_PROJECT_TEXT_MAX_CHARS + 1)
    writeFileSync(paths.projects, JSON.stringify({ version: 1, projects: projectStore.projects }))
    resetHarnessCatalogReaderCacheForTests()
    expect(() =>
      readHarnessCatalogPage(paths.projects, paths.plugins, { includeRegistry: false })
    ).toThrow(`Harness project name exceeded ${HARNESS_PROJECT_TEXT_MAX_CHARS} characters`)

    projectStore.projects[0]!.name = "bounded"
    writeFileSync(paths.projects, JSON.stringify({ version: 1, projects: projectStore.projects }))
    const pluginRows = JSON.parse(readFileSync(paths.plugins, "utf8")) as Array<{ path: string }>
    writeFileSync(
      join(pluginRows[0]!.path, "board_core", "board_config.json"),
      `${JSON.stringify({ apiVersion: 1 })}${" ".repeat(HARNESS_BOARD_CONFIG_MAX_BYTES)}`
    )

    const worker = new Worker(
      workerBundlePath,
      harnessWorkerOptions("harness-catalog-large-config-test")
    )
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      const response = await new Promise<{
        ok: boolean
        result?: {
          projects: Record<
            string,
            { configSnapshot?: { error?: string | null } } | null
          >
        }
      }>((resolve, reject) => {
        worker.once("error", reject)
        worker.once("message", resolve)
        worker.postMessage({
          type: "read-project-contexts",
          requestId: 1,
          projectStorePath: paths.projects,
          pluginStorePath: paths.plugins,
          leanTokenStorePath: join(paths.projects, "..", "leanstar-config.json"),
          projectIds: ["project-0"],
          maxResponseBytes: HARNESS_CATALOG_MAX_RESPONSE_BYTES,
          cancelBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
        })
      })
      expect(response.ok).toBe(true)
      expect(response.result?.projects["project-0"]?.configSnapshot?.error).toContain(
        `exceeded ${HARNESS_BOARD_CONFIG_MAX_BYTES} bytes`
      )
      expect(ticks).toBeGreaterThan(0)
    } finally {
      clearInterval(ticker)
      await worker.terminate()
    }
  })

  it("bounds board-config cache entries and retained bytes across many plugin paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-config-cache-"))
    tempDirs.push(root)
    const plugins = Array.from({ length: HARNESS_CONFIG_CACHE_MAX_ENTRIES * 2 }, (_, index) => {
      const pluginRoot = join(root, `plugin-${index}`)
      mkdirSync(join(pluginRoot, "board_core"), { recursive: true })
      writeFileSync(
        join(pluginRoot, "board_core", "board_config.json"),
        JSON.stringify({ apiVersion: 1, inspectCommands: { [process.platform]: {} } })
      )
      return {
        id: `adapter-${index}`,
        name: `Adapter ${index}`,
        version: "1.0.0",
        description: "test",
        path: pluginRoot,
        enabled: true,
        author: "test",
        skillCount: 0,
        mcpServerCount: 0,
        createdAt: "",
        updatedAt: ""
      }
    })
    const projects = join(root, "projects.json")
    const pluginStore = join(root, "plugins.json")
    writeFileSync(projects, JSON.stringify({ version: 1, projects: [] }))
    writeFileSync(pluginStore, JSON.stringify(plugins))

    let cursor: number | undefined
    do {
      const page = readHarnessCatalogPage(projects, pluginStore, {
        includeProjects: false,
        registryLimit: 64,
        ...(cursor === undefined ? {} : { registryCursor: cursor })
      })
      cursor = page.registryNextCursor ?? undefined
    } while (cursor !== undefined)

    expect(getHarnessCatalogReaderCacheDiagnosticsForTests()).toMatchObject({
      configEntries: HARNESS_CONFIG_CACHE_MAX_ENTRIES
    })
    expect(getHarnessCatalogReaderCacheDiagnosticsForTests().configBytes).toBeLessThanOrEqual(
      HARNESS_CONFIG_CACHE_MAX_BYTES
    )
  })
})
