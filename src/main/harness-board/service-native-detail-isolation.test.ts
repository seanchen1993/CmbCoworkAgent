import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { HarnessProjectMetadata } from "../../shared/harness-board-types"
import type { PluginMetadata } from "../types"
import { createProjectTemplate } from "../mods/devtools/project-template"
import { derivationContentIdentity, snapshotDerivationSource } from "../plugins/derivation-source"

const state = vi.hoisted(() => ({ root: "", plugins: [] as PluginMetadata[] }))
vi.mock("../storage", () => ({
  getOpenworkDir: () => state.root,
  getPlugins: () => state.plugins,
  getUserInfo: () => undefined
}))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => state.root }))
vi.mock("./notifications", () => ({ harnessNotifications: {} }))
vi.mock("./catalog-client", async (original) => ({
  ...(await original<typeof import("./catalog-client")>()),
  // The production catalog reader runs against isolated stores; only worker transport is a seam.
  readHarnessProjectContextsInWorker: async (ids: string[]) => {
    const { readHarnessProjectContexts } = await import("./catalog-reader")
    return readHarnessProjectContexts(
      join(state.root, "harness-board-projects.json"),
      join(state.root, "plugins.json"),
      ids
    )
  }
}))

let service: typeof import("./service")
let native: typeof import("./native-harness")
let healthy: HarnessProjectMetadata
let orphan: HarnessProjectMetadata
let originalStore: string
const template = createProjectTemplate({
  packageId: "generic-docs",
  name: "Generic docs",
  version: "1.0.0"
})

beforeEach(async () => {
  vi.resetModules()
  state.root = await mkdtemp(join(tmpdir(), "harness-native-details-"))
  const pluginRoot = join(state.root, "plugin")
  for (const file of template.files) {
    await mkdir(dirname(join(pluginRoot, file.path)), { recursive: true })
    await writeFile(join(pluginRoot, file.path), file.text)
  }
  state.plugins = [
    {
      id: "current-exact-id",
      name: "generic-docs",
      path: pluginRoot,
      version: "1.0.0",
      enabled: true,
      description: "",
      author: "",
      skillCount: 2,
      mcpServerCount: 0,
      createdAt: "",
      updatedAt: ""
    }
  ]
  const project = (projectId: string, installedPluginId: string): HarnessProjectMetadata => ({
    projectId,
    name: projectId,
    description: "",
    projectCode: projectId,
    projectFromLean: false,
    projectDir: projectId,
    systemId: "system",
    systemName: "System",
    workspacePath: state.root,
    "harness-adapter": {
      id: installedPluginId,
      name: "generic-docs",
      version: "1.0.0",
      type: "plugin"
    },
    nativeBinding: { engine: "host", installedPluginId },
    lifecycle: { status: "active", createAt: new Date().toISOString() }
  })
  healthy = project("healthy-project", "current-exact-id")
  // An identically named/versioned new installation must never replace this durable identity.
  orphan = project("orphan-project", "uninstalled-old-exact-id")
  await mkdir(join(state.root, healthy.projectDir))
  await mkdir(join(state.root, orphan.projectDir))
  originalStore = JSON.stringify({ version: 1, projects: [orphan, healthy] })
  await writeFile(join(state.root, "plugins.json"), JSON.stringify(state.plugins))
  await writeFile(join(state.root, "harness-board-projects.json"), originalStore)
  service = await import("./service")
  native = await import("./native-harness")
}, 30000)

afterEach(async () => {
  vi.restoreAllMocks()
  native.closeNativeHarnessFeatureStore()
  const root = await realpath(state.root)
  expect(dirname(root)).toBe(await realpath(tmpdir()))
  expect(basename(root)).toMatch(/^harness-native-details-[a-zA-Z0-9]{6}$/)
  await rm(root, { recursive: true, force: true })
})

it.each([false, true])(
  "isolates a missing native plugin in either batch order (%s)",
  async (reverse) => {
    const projects = reverse ? [healthy, orphan] : [orphan, healthy]
    const details = await service.getHarnessProjectDetails(
      projects.map((project) => project.projectId)
    )
    expect(Object.keys(details)).toEqual(projects.map((project) => project.projectId))
    expect(details[healthy.projectId].workflow.nodes).toHaveLength(2)
    expect(details[healthy.projectId].error).toBeNull()
    expect(details[orphan.projectId]).toMatchObject({
      project: {
        projectId: orphan.projectId,
        workspacePath: state.root,
        projectRootPath: join(state.root, orphan.projectDir)
      },
      projectState: { label: "项目插件不可用", uiKind: "warning" },
      loading: false,
      runs: [],
      error: "此项目绑定的插件已不可用，请恢复原插件安装后重试。"
    })
    expect(details[orphan.projectId].workflow.nodes).toEqual([])
    expect(details[orphan.projectId].systemConstraintUpdate).toBeUndefined()
    expect(await readFile(join(state.root, "harness-board-projects.json"), "utf8")).toBe(
      originalStore
    )
  }
)

it("keeps an unavailable native project's execution entry rejected without rebinding", async () => {
  await service.getHarnessProjectDetails([orphan.projectId, healthy.projectId])
  const repository = join(state.root, "repository")
  await mkdir(repository)
  await expect(
    native.createNativeHarnessFeature({
      project: orphan,
      featureId: "blocked",
      repositoryWorkspace: repository,
      sessionWorkspace: { source: "directory", path: repository },
      selectedDeployUnits: []
    })
  ).rejects.toThrow("PROJECT_PLUGIN_UNAVAILABLE")
  expect(native.readNativeHarnessFeature(orphan.projectId, "blocked")).toBeUndefined()
  expect(await readFile(join(state.root, "harness-board-projects.json"), "utf8")).toBe(
    originalStore
  )
})

it("reads the original native workflow again when its exact installation is restored", async () => {
  expect(
    (await service.getHarnessProjectDetails([orphan.projectId]))[orphan.projectId].error
  ).toContain("恢复原插件")
  state.plugins.push({ ...state.plugins[0], id: orphan.nativeBinding!.installedPluginId })
  await writeFile(join(state.root, "plugins.json"), JSON.stringify(state.plugins))
  const details = await service.getHarnessProjectDetails([orphan.projectId, healthy.projectId])
  expect(details[orphan.projectId].error).toBeNull()
  expect(details[orphan.projectId].workflow.nodes).toHaveLength(2)
  expect(await readFile(join(state.root, "harness-board-projects.json"), "utf8")).toBe(
    originalStore
  )
})

it("keeps native project creation on the original service and exact template identity", async () => {
  const plugin = state.plugins[0]
  const created = await service.createHarnessProject({
    adapterId: plugin.id,
    adapterType: "plugin",
    name: "New project",
    description: "",
    projectCode: "new-project",
    projectDir: "new-project",
    projectFromLean: false,
    systemId: "system",
    systemName: "System",
    workspacePath: state.root,
    expectedNativeTemplate: {
      pluginId: plugin.id,
      name: plugin.name,
      version: plugin.version!,
      digest: derivationContentIdentity((await snapshotDerivationSource(plugin.path)).files)
    }
  })
  expect(created.nativeBinding?.installedPluginId).toBe(plugin.id)
  const detail = (await service.getHarnessProjectDetails([created.projectId]))[created.projectId]
  expect(detail.error).toBeNull()
  expect(detail.workflow.nodes).toHaveLength(2)
})

it("still enforces the whole batch response budget after isolating one unavailable plugin", async () => {
  await expect(
    service.getHarnessProjectDetails([orphan.projectId, healthy.projectId], {
      maxResponseBytes: 1
    })
  ).rejects.toThrow("Harness project details exceeded IPC limit (1 bytes)")
})

it("honors cancellation before classifying a missing native plugin", async () => {
  const scope = "native-missing-cancelled"
  vi.spyOn(native, "nativeHarnessProjectDetail").mockImplementationOnce(async () => {
    service.cancelHarnessDetailRequestScope(scope)
    throw Error("PROJECT_PLUGIN_UNAVAILABLE")
  })
  await expect(
    service.getHarnessProjectDetails([orphan.projectId, healthy.projectId], { scope })
  ).rejects.toMatchObject({ name: "AbortError", message: "Harness detail request was superseded" })
})

it("propagates unrelated errors and non-Error failures without inventing unavailable details", async () => {
  const read = vi.spyOn(native, "nativeHarnessProjectDetail")
  for (const failure of [
    new Error("PROJECT_RUNTIME_SCHEMA_INVALID"),
    new Error("PROJECT_HOST_PACKAGE_LIMIT"),
    new Error("EACCES"),
    new Error("PROJECT_PLUGIN_UNAVAILABLE_SUFFIX"),
    { message: "PROJECT_PLUGIN_UNAVAILABLE" },
    "PROJECT_PLUGIN_UNAVAILABLE"
  ]) {
    read.mockRejectedValueOnce(failure)
    await expect(service.getHarnessProjectDetails([healthy.projectId])).rejects.toBe(failure)
  }
})
