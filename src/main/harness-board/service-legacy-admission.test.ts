import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createProjectTemplate } from "../mods/devtools/project-template"
import type { PluginMetadata } from "../types"
import type { HarnessProjectCreateInput } from "../../shared/harness-board-types"

const state = vi.hoisted(() => ({ root: "", plugins: [] as PluginMetadata[] }))
vi.mock("../storage", () => ({
  getOpenworkDir: () => state.root,
  getPlugins: () => state.plugins,
  getUserInfo: () => undefined
}))
vi.mock("./notifications", () => ({ harnessNotifications: {} }))
vi.mock("./catalog-client", async (original) => ({
  ...(await original<typeof import("./catalog-client")>()),
  // Exercise the real catalogue projection; only Electron's bundled worker transport is a seam.
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
beforeEach(async () => {
  vi.resetModules()
  state.root = await mkdtemp(join(tmpdir(), "harness-direct-admission-"))
  const path = join(state.root, "plugin")
  await mkdir(join(path, "board_core"), { recursive: true })
  const command = join(path, "create-project.cjs")
  await writeFile(
    command,
    `require("node:fs").writeFileSync(${JSON.stringify(join(state.root, "created-marker.txt"))}, "created by original command")`
  )
  await writeFile(
    join(path, "board_core/board_config.json"),
    JSON.stringify({
      apiVersion: 1,
      inspectCommands: {
        [process.platform]: { create_project: `"${process.execPath}" "${command}"` }
      }
    })
  )
  state.plugins = [
    {
      id: "plugin",
      name: "native-package",
      path,
      version: "1.0.0",
      enabled: true,
      description: "fixture",
      author: "fixture",
      skillCount: 0,
      mcpServerCount: 0,
      createdAt: "",
      updatedAt: ""
    }
  ]
  await writeFile(join(state.root, "plugins.json"), JSON.stringify(state.plugins))
  service = await import("./service")
})
afterEach(async () => {
  const native = await import("./native-harness")
  native.closeNativeHarnessFeatureStore()
  expect(dirname(resolve(state.root))).toBe(resolve(tmpdir()))
  expect(basename(state.root)).toMatch(/^harness-direct-admission-[a-zA-Z0-9]{6}$/)
  await rm(state.root, { recursive: true, force: true })
})

function input(): HarnessProjectCreateInput {
  return {
    adapterId: "plugin",
    adapterType: "plugin",
    name: "Project",
    description: "",
    projectCode: "sample",
    projectDir: "sample",
    projectFromLean: false,
    systemId: "system",
    systemName: "System",
    workspacePath: state.root
  }
}
async function declareHost() {
  const source = createProjectTemplate({
    packageId: "native-package",
    name: "Host",
    version: "1.0.0"
  })
  for (const file of source.files) {
    await mkdir(dirname(join(state.plugins[0].path, file.path)), { recursive: true })
    await writeFile(join(state.plugins[0].path, file.path), file.text)
  }
}

it("creates a native Harness container by exact Host id without invoking board-shaped scripts", async () => {
  await declareHost()
  const { derivationContentIdentity, snapshotDerivationSource } =
    await import("../plugins/derivation-source")
  const expectedNativeTemplate = {
    pluginId: "plugin",
    name: "native-package",
    version: "1.0.0",
    digest: derivationContentIdentity((await snapshotDerivationSource(state.plugins[0].path)).files)
  }
  await expect(service.createHarnessProject(input())).rejects.toThrow("PACKAGE_IDENTITY_MISMATCH")
  const project = await service.createHarnessProject({ ...input(), expectedNativeTemplate })
  expect(project).toMatchObject({
    nativeBinding: { engine: "host", installedPluginId: "plugin" }
  })
  await expect(readFile(join(state.root, "created-marker.txt"))).rejects.toMatchObject({
    code: "ENOENT"
  })
  await expect(
    service.createHarnessProject({
      ...input(),
      projectCode: "second",
      projectDir: "second",
      adapterId: "native-package"
    })
  ).rejects.toThrow("Selected plugin is not installed or does not provide")
  const { initializeHarnessConfigV2 } = await import("./config-v2")
  await initializeHarnessConfigV2(state.root)
  const native = await import("./native-harness")
  native.configureNativeHarnessRuntime({
    view: () => undefined,
    create: async () => {
      throw Error("not started")
    }
  })
  const created = await service.createHarnessFeature({
    projectId: project.projectId,
    feature: "request-a",
    selectedDeployUnits: [],
    sessionWorkspace: { source: "directory", path: state.root }
  })
  expect(created).toMatchObject({ projectId: project.projectId, slug: "request-a" })
  expect(await service.getHarnessFeatureBinding(project.projectId, "request-a")).toMatchObject({
    sessionWorkspace: { source: "directory", path: state.root }
  })
  expect(native.nativeHarnessRunDetail(project, "request-a").nativeBinding?.workspace).not.toBe(
    state.root
  )
  await expect(readFile(join(state.root, "created-marker.txt"))).rejects.toMatchObject({
    code: "ENOENT"
  })
})

it("preserves old creation and rejects an existing binding changed to a native Host declaration", async () => {
  const project = await service.createHarnessProject(input())
  expect(project["harness-adapter"].id).toBe("plugin")
  expect(await readFile(join(state.root, "created-marker.txt"), "utf8")).toBe(
    "created by original command"
  )
  const before = await readFile(join(state.root, "harness-board-projects.json"), "utf8")
  await declareHost()
  await expect(service.updateHarnessProjectMetadata(project.projectId, input())).rejects.toThrow(
    "旧项目不能直接改为原生执行"
  )
  expect(await readFile(join(state.root, "harness-board-projects.json"), "utf8")).toBe(before)
})

it("projects the real AutoBiz scaffold through original project and Feature services without execution", async () => {
  const { compileFunctionPlugin } = await import("../mods/v2/loader")
  const { readProjectSource } = await import("../mods/devtools/project-source")
  const { compileNativeComposition, nativeCompositionSchema } =
    await import("../plugins/native-composition")
  const { derivationContentIdentity, snapshotDerivationSource } =
    await import("../plugins/derivation-source")
  const root = resolve("resources/native-compositions/autobiz-lean")
  const actions = (
    await Promise.all(
      ["knowledge", "rules", "delivery"].map(async (name) => {
        const provider = await compileFunctionPlugin(join(root, "providers", name))
        if (!provider?.actions) throw Error("Reference provider compilation failed")
        return provider.actions.map(({ id, ...action }) => ({
          ...action,
          actionId: id,
          pluginId: `fixture-${name}`,
          plugin: provider.name,
          digest: provider.digest
        }))
      })
    )
  ).flat()
  const bundle = (await readProjectSource(join(root, "project"))).bundle
  const source = nativeCompositionSchema.parse(
    JSON.parse(bundle.files.find((file) => file.path === "composition/source.json")!.text)
  )
  const compiled = compileNativeComposition(source, {
    files: bundle.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.text) })),
    actionCatalog: actions
  })
  for (const file of compiled.files) {
    await mkdir(dirname(join(state.plugins[0].path, file.path)), { recursive: true })
    await writeFile(join(state.plugins[0].path, file.path), file.bytes)
  }
  const metadata = JSON.parse(await readFile(join(state.plugins[0].path, "plugin.json"), "utf8"))
  Object.assign(state.plugins[0], { name: metadata.name, version: metadata.version })
  await writeFile(join(state.root, "plugins.json"), JSON.stringify(state.plugins))
  const expectedNativeTemplate = {
    pluginId: "plugin",
    name: metadata.name,
    version: metadata.version,
    digest: derivationContentIdentity((await snapshotDerivationSource(state.plugins[0].path)).files)
  }
  const native = await import("./native-harness")
  const execute = vi.fn(async () => {
    throw Error("Lazy admission must not execute")
  })
  native.configureNativeHarnessRuntime({ view: () => undefined, create: execute })
  const project = await service.createHarnessProject({ ...input(), expectedNativeTemplate })
  const detail = await service.getHarnessProjectDetail(project.projectId)
  expect(detail.error).toBeNull()
  expect(detail.runs).toEqual([])
  const { initializeHarnessConfigV2 } = await import("./config-v2")
  await initializeHarnessConfigV2(state.root)
  await service.createHarnessFeature({
    projectId: project.projectId,
    feature: "inventory-request",
    selectedDeployUnits: [],
    sessionWorkspace: { source: "directory", path: state.root }
  })
  const pending = await service.getHarnessRunDetail(project.projectId, "inventory-request")
  expect(pending.run.nodes.map((node) => node.id)).toEqual([
    "baseline",
    "definition",
    "solution",
    "code",
    "delivery"
  ])
  expect(pending.nativeProject).toBeUndefined()
  expect(pending.nativeBinding).toMatchObject({
    engine: "host",
    installedPluginId: "plugin",
    repositoryWorkspace: state.root,
    expectedPlugin: expectedNativeTemplate
  })
  expect(pending.project.projectRootPath).toBe(pending.nativeBinding!.workspace)
  expect(dirname(pending.nativeBinding!.workspace)).toBe(
    join(state.root, "sample", ".harness-features")
  )
  expect(pending.run.sessionWorkspace).toEqual({ source: "directory", path: state.root })
  expect((await service.getHarnessProjectDetail(project.projectId)).runs).toHaveLength(1)
  expect(execute).not.toHaveBeenCalled()
  await expect(readFile(join(state.root, "created-marker.txt"))).rejects.toMatchObject({
    code: "ENOENT"
  })
  expect((await readProjectSource(join(root, "project"))).bundle.digest).toBe(bundle.digest)
})
