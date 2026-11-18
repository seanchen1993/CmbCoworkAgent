import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { HarnessProjectMetadata } from "../../shared/harness-board-types"
import type { PluginMetadata } from "../types"
import { createProjectTemplate } from "../mods/devtools/project-template"
import { derivationContentIdentity, snapshotDerivationSource } from "../plugins/derivation-source"
import { canonicalTmpdir } from "../../../tests/support/canonical-temp-dir"
import { projectUseConsentFixture } from "../../../tests/support/project-use-consent"
import type { NativeHarnessRuntime } from "./native-harness"

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
let consent: Awaited<ReturnType<typeof projectUseConsentFixture>> | undefined
const template = createProjectTemplate({
  packageId: "generic-docs",
  name: "Generic docs",
  version: "1.0.0"
})

beforeEach(async () => {
  vi.resetModules()
  state.root = await mkdtemp(join(canonicalTmpdir(), "harness-native-details-"))
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
    projectFromLean: false, isTestProject: true,
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
  consent?.close()
  consent = undefined
  native.closeNativeHarnessFeatureStore()
  const root = await realpath(state.root)
  expect(dirname(root)).toBe(await realpath(tmpdir()))
  expect(basename(root)).toMatch(/^harness-native-details-[a-zA-Z0-9]{6}$/)
  await rm(root, { recursive: true, force: true })
})

it("keeps persisted execution modes when installed adapters are replaced or missing", async () => {
  const legacy = { ...healthy }
  delete legacy.nativeBinding
  const file = join(state.root, "harness-board-projects.json")
  await writeFile(file, JSON.stringify({ version: 1, projects: [legacy, orphan] }))

  for (const project of [legacy, orphan]) {
    const updated = await service.updateHarnessProjectMetadata(project.projectId, {
      ...project,
      name: "Renamed " + project.name,
      adapterId: project["harness-adapter"].id,
      adapterType: "plugin",
      isTestProject: true
    })
    expect(updated.name).toBe("Renamed " + project.name)
    expect(updated.nativeBinding).toEqual(project.nativeBinding)
    expect(updated["harness-adapter"]).toEqual(project["harness-adapter"])
  }

  const persisted = JSON.parse(await readFile(file, "utf8")).projects
  expect(persisted[0]).not.toHaveProperty("nativeBinding")
  expect(persisted[1].nativeBinding).toEqual(orphan.nativeBinding)
})

it("keeps an empty Host project bound when a Legacy adapter is selected", async () => {
  const legacyRoot = join(state.root, "legacy-plugin")
  await mkdir(join(legacyRoot, "board_core"), { recursive: true })
  await writeFile(join(legacyRoot, "plugin.json"), JSON.stringify({ name: "legacy", version: "1.0.0" }))
  await writeFile(join(legacyRoot, "board_core", "board_config.json"), JSON.stringify({ apiVersion: 1 }))
  state.plugins.push({ ...state.plugins[0], id: "legacy", name: "legacy", path: legacyRoot })
  const storeFile = join(state.root, "harness-board-projects.json")

  await expect(service.updateHarnessProjectMetadata(healthy.projectId, {
    ...healthy,
    name: "Changed name",
    adapterId: "legacy",
    adapterType: "plugin",
    isTestProject: true
  })).rejects.toThrow("原生项目不能直接改用旧版执行插件")

  expect(await readFile(storeFile, "utf8")).toBe(originalStore)
})

it("rebinds an empty Host project after review and preserves that binding during a plain edit", async () => {
  const root = join(state.root, "replacement-host")
  for (const file of createProjectTemplate({
    packageId: "replacement-host", name: "Replacement Host", version: "1.0.0"
  }).files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true })
    await writeFile(join(root, file.path), file.text)
  }
  const replacement = { ...state.plugins[0], id: "replacement-installed-id", name: "replacement-host", path: root }
  state.plugins.push(replacement)
  await writeFile(join(state.root, "plugins.json"), JSON.stringify(state.plugins))
  expect(service.readHarnessProjectUseParent(healthy.projectId)).toBeUndefined()
  consent = await projectUseConsentFixture(state.root, () => state.plugins)

  const input = { ...healthy, adapterId: replacement.id, adapterType: "plugin" as const }
  const updated = await consent.update(healthy.projectId, input)
  expect(updated["harness-adapter"].id).toBe(replacement.id)
  expect(updated.nativeBinding?.installedPluginId).toBe(replacement.id)
  expect(updated.projectUseStatus?.state).toBe("ready")
  const receipt = consent.store.getProjectUseAuthorization(healthy.projectId)
  expect(receipt?.policy.plugin.pluginId).toBe(replacement.id)
  expect(consent.guestLoads()).toBe(0)

  replacement.enabled = false
  const probe = vi.spyOn(native, "nativeHarnessPlugin").mockRejectedValue(Error("stale plugin artifact"))
  const renamed = await service.updateHarnessProjectMetadata(healthy.projectId, {
    ...input, name: "Metadata edit while the Host is unavailable"
  })
  expect(renamed.name).toBe("Metadata edit while the Host is unavailable")
  expect(renamed.nativeBinding).toEqual(updated.nativeBinding)
  expect(renamed["harness-adapter"]).toEqual(updated["harness-adapter"])
  expect(consent.store.getProjectUseAuthorization(healthy.projectId)).toEqual(receipt)
  expect(probe).not.toHaveBeenCalled()
})

it("keeps a captured Host owner live during an unrelated project save", async () => {
  consent = await projectUseConsentFixture(state.root, () => state.plugins)
  const owner = await consent.update(healthy.projectId, {
    ...healthy, adapterId: healthy["harness-adapter"].id, adapterType: "plugin"
  })
  const repository = join(state.root, "active-owner-repository")
  await mkdir(repository)
  const binding = await native.createNativeHarnessFeature({
    project: owner, featureId: "active-owner", repositoryWorkspace: repository,
    sessionWorkspace: { source: "directory", path: repository }, selectedDeployUnits: []
  })
  const { captureProjectUseFeature } = await import("./project-use-authorization")
  const assertCurrent = captureProjectUseFeature(binding)
  expect(assertCurrent).toBeDefined()

  const store = await import("./async-json-store")
  const write = store.writeHarnessJsonFileAtomic
  const written = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  vi.spyOn(store, "writeHarnessJsonFileAtomic").mockImplementation(async (...args) => {
    await write(...args)
    written.resolve()
    await release.promise
  })
  const saving = service.updateHarnessProjectMetadata(orphan.projectId, {
    ...orphan, name: "Unrelated project edited", adapterId: orphan["harness-adapter"].id,
    adapterType: "plugin"
  })
  try {
    await Promise.race([written.promise, saving.then(() => {
      throw Error("UNEXPECTED_SAVE_WITHOUT_WRITE_BARRIER")
    })])
    expect(assertCurrent).not.toThrow()
    const file = join(state.root, "harness-board-projects.json")
    const snapshot = await readFile(file, "utf8")
    const stored = JSON.parse(snapshot) as { projects: HarnessProjectMetadata[] }
    const original = stored.projects.find((entry) => entry.projectId === owner.projectId)!
    original.lifecycle = { ...original.lifecycle, status: "archived" }
    await writeFile(file, JSON.stringify(stored))
    expect(assertCurrent).toThrow("PROJECT_USE_AUTHORIZATION_INVALID")
    const installed = state.plugins[0]
    state.plugins[0] = { ...installed, enabled: false }
    try {
      expect(assertCurrent).toThrow("PROJECT_USE_AUTHORIZATION_INVALID")
      await writeFile(file, snapshot)
      expect(assertCurrent).toThrow("PROJECT_USE_SOURCE_CHANGED")
    } finally {
      state.plugins[0] = installed
    }
  } finally {
    release.resolve()
    await saving
  }
  expect(assertCurrent).not.toThrow()
  const retainedRepository = repository + "-retained"
  await rename(repository, retainedRepository)
  await mkdir(repository)
  expect(assertCurrent).toThrow("HARNESS_NATIVE_PROJECT_CHANGED")
  await rename(repository, repository + "-replacement")
  await rename(retainedRepository, repository)
  expect(assertCurrent).not.toThrow()
})

it("keeps the verified Host owner when an older project read completes after a save", async () => {
  consent = await projectUseConsentFixture(state.root, () => state.plugins)
  const owner = await consent.update(healthy.projectId, {
    ...healthy, adapterId: healthy["harness-adapter"].id, adapterType: "plugin"
  })
  const repository = join(state.root, "active-owner-repository")
  await mkdir(repository)
  const binding = await native.createNativeHarnessFeature({
    project: owner, featureId: "active-owner", repositoryWorkspace: repository,
    sessionWorkspace: { source: "directory", path: repository }, selectedDeployUnits: []
  })
  const { captureProjectUseFeature } = await import("./project-use-authorization")
  const assertCurrent = captureProjectUseFeature(binding)
  expect(assertCurrent).toBeDefined()

  const store = await import("./async-json-store")
  const read = store.parseHarnessJsonBytesBounded
  const captured = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  vi.spyOn(store, "parseHarnessJsonBytesBounded").mockImplementationOnce(async (...args) => {
    const snapshot = await read(...args)
    captured.resolve()
    await release.promise
    return snapshot
  })
  const opening = service.prepareHarnessFeatureThreadSession(owner.projectId, binding.featureId)
  void opening.catch(() => {})
  try {
    await Promise.race([captured.promise, opening.then(() => {
      throw Error("UNEXPECTED_OPEN_WITHOUT_READ_BARRIER")
    })])
    await service.updateHarnessProjectMetadata(orphan.projectId, {
      ...orphan, name: "Unrelated project edited", adapterId: orphan["harness-adapter"].id,
      adapterType: "plugin"
    })
    expect(assertCurrent).not.toThrow()
  } finally {
    release.resolve()
  }
  await expect(opening).resolves.toMatchObject({ workspacePath: await realpath(repository) })
  expect(assertCurrent).not.toThrow()
  native.configureNativeHarnessRuntime({
    view: () => undefined,
    create: async () => { throw Error("Archive unexpectedly started a Host run") }
  })
  await service.archiveHarnessProject(owner.projectId)
  expect(assertCurrent).toThrow("PROJECT_USE_AUTHORIZATION_INVALID")
})

async function createLegacyProjectFixture() {
  const legacyDir = "legacy-project"
  const legacyRoot = join(state.root, "legacy-plugin")
  await mkdir(join(legacyRoot, "board_core"), { recursive: true })
  await mkdir(join(state.root, legacyDir))
  await writeFile(join(legacyRoot, "adapter.cjs"),
    `console.log(${JSON.stringify(JSON.stringify({ projects: { [legacyDir]: { runs: [] } } }))})`)
  await writeFile(join(legacyRoot, "board_core", "board_config.json"), JSON.stringify({
    apiVersion: 1,
    inspectCommands: { [process.platform]: {
      project_status: `"${process.execPath.replaceAll("\\", "/")}" "\${pluginPath}/adapter.cjs"`
    } }
  }))
  const legacy = {
    ...healthy, projectId: legacyDir, projectCode: legacyDir, projectDir: legacyDir,
    "harness-adapter": { ...healthy["harness-adapter"], id: "legacy", name: "legacy" }
  }
  delete legacy.nativeBinding
  state.plugins.push({ ...state.plugins[0], id: "legacy", name: "legacy", path: legacyRoot })
  await writeFile(join(state.root, "plugins.json"), JSON.stringify(state.plugins))
  return legacy
}

it("isolates a corrupt Host feature index from a healthy Legacy adapter", async () => {
  const legacy = await createLegacyProjectFixture()
  const archived = { ...orphan, lifecycle: { ...orphan.lifecycle, status: "archived" as const } }
  await writeFile(join(state.root, "harness-board-projects.json"), JSON.stringify({
    version: 1, projects: [healthy, legacy, archived]
  }))
  const index = join(state.root, "harness-native-features.sqlite")
  const damaged = Buffer.from("invalid SQLite feature index".repeat(128))
  await writeFile(index, damaged)
  const create = vi.fn<NativeHarnessRuntime["create"]>()
  const view = vi.fn<NativeHarnessRuntime["view"]>()
  native.configureNativeHarnessRuntime({ create, view })

  const details = await service.getHarnessProjectDetails([
    healthy.projectId, legacy.projectId, archived.projectId
  ])
  expect(details[legacy.projectId]).toMatchObject({ error: null, runs: [] })
  expect(details[healthy.projectId]).toMatchObject({
    projectState: { label: "Host 特性索引不可读", uiKind: "warning" },
    error: expect.stringContaining("恢复原索引")
  })
  expect(details[archived.projectId]?.projectState?.uiKind).toBe("archived")
  await expect(native.ensureNativeHarnessFeatureRun(healthy.projectId, "existing", "Keep original"))
    .rejects.toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 26 })
  expect(create).not.toHaveBeenCalled()
  expect(view).not.toHaveBeenCalled()
  expect(await readFile(index)).toEqual(damaged)
})

it.each([
  { status: "active", field: "JSON", corrupt: () => "{", readFailure: SyntaxError },
  {
    status: "archived",
    field: "engine",
    corrupt: () => '{"engine":"legacy"}',
    readFailure: "HARNESS_NATIVE_BINDING_INVALID"
  },
  {
    status: "active",
    field: "goal",
    corrupt: (original: string) => JSON.stringify({ ...JSON.parse(original), goal: 42 }),
    readFailure: "HARNESS_NATIVE_BINDING_INVALID"
  },
  {
    status: "active",
    field: "createdAt",
    corrupt: (original: string) =>
      JSON.stringify({ ...JSON.parse(original), createdAt: 8_640_000_000_000_001 }),
    readFailure: "HARNESS_NATIVE_BINDING_INVALID"
  },
  {
    status: "active",
    field: "title",
    corrupt: (original: string) =>
      JSON.stringify({ ...JSON.parse(original), title: { invalid: true } }),
    readFailure: "HARNESS_NATIVE_BINDING_INVALID"
  },
  {
    status: "active",
    field: "binding identity",
    corrupt: (_original: string, other: string) => other,
    readFailure: "HARNESS_NATIVE_BINDING_INVALID"
  }
] as const)(
  "isolates a malformed feature record with invalid $field in an $status Host project",
  async ({ status, corrupt, readFailure }) => {
    const legacy = await createLegacyProjectFixture()
    const affected = {
      ...healthy,
      projectId: orphan.projectId,
      projectCode: orphan.projectCode,
      projectDir: orphan.projectDir
    }
    const catalog = join(state.root, "harness-board-projects.json")
    const writeProjects = () =>
      writeFile(
        catalog,
        JSON.stringify({
          version: 1,
          projects: [affected, healthy, legacy]
        })
      )
    await writeProjects()
    const workspace = await realpath(state.root)
    const feature = await native.createNativeHarnessFeature({
      project: affected,
      featureId: "feature",
      repositoryWorkspace: workspace,
      sessionWorkspace: { source: "directory", path: workspace },
      selectedDeployUnits: []
    })
    const healthyFeature = await native.createNativeHarnessFeature({
      project: healthy,
      featureId: "healthy-feature",
      repositoryWorkspace: workspace,
      sessionWorkspace: { source: "directory", path: workspace },
      selectedDeployUnits: []
    })
    const view = vi.fn<NativeHarnessRuntime["view"]>()
    const create = vi.fn<NativeHarnessRuntime["create"]>()
    native.configureNativeHarnessRuntime({ create, view })
    affected.lifecycle = { ...affected.lifecycle, status }
    await writeProjects()

    const db = new DatabaseSync(join(state.root, "harness-native-features.sqlite"))
    try {
      const read = db.prepare("SELECT data FROM native_harness_features WHERE host_run_id=?")
      const original = read.get(feature.hostRunId)?.data
      const other = read.get(healthyFeature.hostRunId)?.data
      if (typeof original !== "string" || typeof other !== "string")
        throw Error("Expected persisted feature records")
      const damage = corrupt(original, other)
      const update = db.prepare("UPDATE native_harness_features SET data=? WHERE host_run_id=?")
      expect(update.run(damage, feature.hostRunId).changes).toBe(1)

      const details = await service.getHarnessProjectDetails([
        affected.projectId,
        healthy.projectId,
        legacy.projectId
      ])
      expect(details[healthy.projectId]).toMatchObject({
        error: null,
        runs: [{ id: healthyFeature.featureId }]
      })
      expect(view).toHaveBeenCalledExactlyOnceWith(healthyFeature.hostRunId, "summary")
      view.mockClear()
      expect(details[legacy.projectId]).toMatchObject({ error: null, runs: [] })
      expect(details[affected.projectId]).toMatchObject({
        projectState:
          status === "archived"
            ? { label: "已归档 · Host 特性索引不可读", uiKind: "archived" }
            : { label: "Host 特性索引不可读", uiKind: "warning" },
        error: expect.stringContaining("恢复原索引"),
        runs: []
      })
      await expect(
        service.getHarnessRunDetail(affected.projectId, feature.featureId)
      ).rejects.toThrow(readFailure)
      await expect(
        native.ensureNativeHarnessFeatureRun(affected.projectId, feature.featureId, "Original goal")
      ).rejects.toThrow(readFailure)
      expect(() => native.readNativeHarnessFeature(affected.projectId, feature.featureId)).toThrow(
        readFailure
      )
      expect(() => native.findNativeHarnessFeatureByRunId(feature.hostRunId)).toThrow(readFailure)
      expect(view).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      expect(read.get(feature.hostRunId)?.data).toBe(damage)

      expect(update.run(original, feature.hostRunId).changes).toBe(1)
      const recovered = await service.getHarnessProjectDetail(affected.projectId)
      expect(recovered).toMatchObject({ error: null, runs: [{ id: feature.featureId }] })
      expect(native.readNativeHarnessFeature(affected.projectId, feature.featureId)).toEqual(
        feature
      )
    } finally {
      db.close()
    }
  },
  15_000
)

it.each(["active", "archived"] as const)(
  "isolates an offline %s Host workspace from the rest of the project batch",
  async (status) => {
    const workspace = join(state.root, "removable-workspace")
    const renamed = join(state.root, "detached-workspace")
    const offline = {
      ...healthy, projectId: "offline-project", projectCode: "offline-project",
      workspacePath: workspace, lifecycle: { ...healthy.lifecycle, status }
    }
    await mkdir(join(workspace, offline.projectDir), { recursive: true })
    await writeFile(join(state.root, "harness-board-projects.json"), JSON.stringify({
      version: 1, projects: [offline, healthy]
    }))
    await rename(workspace, renamed)

    const details = await service.getHarnessProjectDetails([offline.projectId, healthy.projectId])
    expect(details[healthy.projectId].error).toBeNull()
    expect(details[healthy.projectId].workflow.nodes).toHaveLength(2)
    expect(details[offline.projectId]).toMatchObject({
      project: { projectId: offline.projectId, workspacePath: workspace },
      projectState: status === "archived"
        ? { label: "已归档", uiKind: "archived" }
        : { label: "项目目录不存在", uiKind: "warning" },
      error: status === "archived" ? null : expect.stringContaining(workspace)
    })

    await rename(renamed, workspace)
    const recovered = await service.getHarnessProjectDetail(offline.projectId)
    expect(recovered.error).toBeNull()
    expect(recovered.workflow.nodes).toHaveLength(2)
  }
)

it.each([
  { failure: "missing", status: "active" },
  { failure: "missing", status: "archived" },
  { failure: "unreadable", status: "active" },
  { failure: "unreadable", status: "archived" }
] as const)(
  "isolates a $failure published $status Host execution without rebuilding it",
  async ({ failure, status }) => {
    const affected = { ...healthy, projectId: "partly-restored", projectCode: "partly-restored",
      projectDir: "partly-restored" }
    const legacy = await createLegacyProjectFixture()
    await mkdir(join(state.root, affected.projectDir))
    await writeFile(join(state.root, "harness-board-projects.json"), JSON.stringify({
      version: 1, projects: [affected, healthy, legacy]
    }))
    const repository = await realpath(state.root)
    const { HostProjectStore } = await import("./project-runtime/host-store")
    const { HostProjectService } = await import("./project-runtime/host-service")
    const { HostPackageSnapshots } = await import("./project-runtime/package-snapshots")
    const hostPath = join(state.root, "host.sqlite")
    const hostStore = new HostProjectStore(hostPath)
    let storeOpen = true
    try {
      const host = new HostProjectService(hostStore,
        new HostPackageSnapshots(join(state.root, "snapshots")), {
          resolveInstalledPlugin: async (id) => ({
            installedPluginId: id, root: state.plugins[0].path,
            packageId: "generic-docs", packageVersion: "1.0.0", enabled: true
          }),
          authorize: async () => {},
          executeSkill: async () => { throw Error("Unexpected Host execution") }
        })
      const view = vi.fn<NativeHarnessRuntime["view"]>((id) => {
        const project = host.get(id)
        return project ? { project, operations: host.operations(id, 100) } : undefined
      })
      const create = vi.fn<NativeHarnessRuntime["create"]>(async (input, guard) => {
        if (!host.get(input.projectId)) await host.localCreate(input, guard)
        return view(input.projectId)!
      })
      native.configureNativeHarnessRuntime({ view, create })
      const feature = await native.createNativeHarnessFeature({
        project: affected, featureId: "restored-feature", repositoryWorkspace: repository,
        sessionWorkspace: { source: "directory", path: repository }, selectedDeployUnits: []
      })
      const goal = "Original published request"
      await native.ensureNativeHarnessFeatureRun(affected.projectId, feature.featureId, goal)
      const published = native.readNativeHarnessFeature(affected.projectId, feature.featureId)
      expect(published?.packageDigest).toMatch(/^[a-f0-9]{64}$/)
      if (status === "archived") await service.archiveHarnessProject(affected.projectId)
      const damaged = Buffer.from("invalid SQLite Host state".repeat(128))
      if (failure === "unreadable") {
        hostStore.close()
        storeOpen = false
        await writeFile(hostPath, damaged)
        view.mockImplementation((id) => {
          const store = new HostProjectStore(hostPath)
          try {
            const project = store.get(id)
            return project ? { project, operations: [] } : undefined
          } finally {
            store.close()
          }
        })
      } else {
        const db = new DatabaseSync(hostPath)
        try {
          expect(db.prepare("DELETE FROM host_projects WHERE id=?").run(feature.hostRunId).changes)
            .toBe(1)
        } finally {
          db.close()
        }
      }

      view.mockClear()
      const details = await service.getHarnessProjectDetails([
        affected.projectId, healthy.projectId, legacy.projectId
      ])
      expect(view).toHaveBeenCalledExactlyOnceWith(feature.hostRunId, "summary")
      expect(details[healthy.projectId].error).toBeNull()
      expect(details[healthy.projectId].workflow.nodes).toHaveLength(2)
      expect(details[legacy.projectId]).toMatchObject({ error: null, runs: [] })
      const label = failure === "missing" ? "运行记录缺失" : "Host 运行记录不可读"
      expect(details[affected.projectId]).toMatchObject({
        projectState: status === "archived"
          ? { label: `已归档 · ${label}`, uiKind: "archived" }
          : { label, uiKind: "warning" },
        error: expect.stringContaining("请恢复原运行数据"),
        runs: []
      })
      const detailFailure = expect(service.getHarnessRunDetail(affected.projectId, feature.featureId)).rejects
      if (failure === "unreadable") {
        await detailFailure.toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 26 })
      } else {
        await detailFailure.toThrow("HARNESS_NATIVE_EXECUTION_MISSING")
      }
      expect(view).toHaveBeenLastCalledWith(feature.hostRunId, undefined)
      const startFailure = expect(native.ensureNativeHarnessFeatureRun(
        affected.projectId, feature.featureId, goal
      )).rejects
      if (status === "archived") await startFailure.toThrow("HARNESS_NATIVE_PROJECT_CHANGED")
      else if (failure === "unreadable") await startFailure.toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 26 })
      else await startFailure.toThrow("HARNESS_NATIVE_EXECUTION_MISSING")
      expect(create).toHaveBeenCalledTimes(1)
      if (failure === "unreadable") expect(await readFile(hostPath)).toEqual(damaged)
      else expect(host.get(feature.hostRunId)).toBeUndefined()
      expect(native.readNativeHarnessFeature(affected.projectId, feature.featureId)).toEqual(published)
    } finally {
      if (storeOpen) hostStore.close()
    }
  }
)

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

it("passes a native Feature's current skill to ordinary chat without replacing AGENTS or granting execution", async () => {
  const repository = join(state.root, "discussion-repo")
  await mkdir(repository)
  const binding = await native.createNativeHarnessFeature({ project: healthy, featureId: "discussion",
    repositoryWorkspace: repository, sessionWorkspace: { source: "directory", path: repository },
    selectedDeployUnits: [] })
  const context = await service.buildHarnessFeatureAgentContext({ harnessFeature: {
    projectId: healthy.projectId, slug: "discussion"
  } }, { workspacePath: binding.repositoryWorkspace })
  expect(context?.systemPromptInject).toContain("devclaw.project-discussion/v1")
  expect(context?.systemPromptInject).toContain("stageSkillReference")
  expect(context?.systemPromptInject).toContain("普通讨论")
  expect(context?.harnessAgentsPrompt).toBeUndefined()
  expect(context?.enableAgentsPrompt).toBeUndefined()
  expect(context?.pluginRoot).toBeUndefined()
  expect(context?.additionalAgentsWorkspacePaths).toBeUndefined()
  expect(native.readNativeHarnessFeature(healthy.projectId, "discussion")?.packageDigest).toBeUndefined()
})

it("keeps native project creation on the original service and exact template identity", async () => {
  const plugin = state.plugins[0]
  consent = await projectUseConsentFixture(state.root, () => state.plugins)
  const created = await consent.create({
    adapterId: plugin.id,
    adapterType: "plugin",
    name: "New project",
    description: "",
    projectCode: "new-project",
    projectDir: "new-project",
    projectFromLean: false, isTestProject: true,
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
  expect(consent.guestLoads()).toBe(0)
  const detail = (await service.getHarnessProjectDetails([created.projectId]))[created.projectId]
  expect(detail.error).toBeNull()
  expect(detail.workflow.nodes).toHaveLength(2)
})

it("uses real source and dependency consent while keeping required encrypted configuration separate", async () => {
  const plugin = state.plugins[0]
  const manifestPath = join(plugin.path, "plugin.json")
  const metadata = JSON.parse(await readFile(manifestPath, "utf8"))
  metadata.mods = "mods/manifest.json"
  metadata.userConfig = {
    token: {
      type: "string",
      title: "Token",
      description: "Service access",
      sensitive: true,
      required: true
    }
  }
  await mkdir(join(plugin.path, "mods"))
  await writeFile(manifestPath, JSON.stringify(metadata))
  await writeFile(
    join(plugin.path, "mods/manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "generic-docs",
      entry: "main.ts"
    })
  )
  await writeFile(join(plugin.path, "mods/main.ts"), "export function register(){}")
  const provider = {
    ...plugin,
    id: "provider-exact-id",
    name: "generic-validator",
    path: join(state.root, "provider")
  }
  await mkdir(join(provider.path, "mods"), { recursive: true })
  await writeFile(
    join(provider.path, "plugin.json"),
    JSON.stringify({
      name: provider.name,
      version: "1.0.0",
      mods: "mods/manifest.json"
    })
  )
  await writeFile(
    join(provider.path, "mods/manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: provider.name,
      claw: {
        componentsVersion: 1,
        components: [
          {
            id: "main",
            kind: "module",
            name: "Validator",
            entry: "main.ts",
            dependsOn: [],
            actionIds: ["validate"]
          }
        ],
        actions: [
          { id: "validate", name: "Validate", command: "validate", inputSchema: { type: "object" } }
        ]
      }
    })
  )
  await writeFile(join(provider.path, "mods/main.ts"), "export function register(){}")
  state.plugins.push(provider)
  await writeFile(join(state.root, "plugins.json"), JSON.stringify(state.plugins))
  const { compileFunctionPlugin } = await import("../mods/v2/loader")
  const compiled = await compileFunctionPlugin(provider.path)
  const { createProjectActionBinding } = await import("./project-runtime/action-input")
  const { id: actionId, ...action } = compiled!.actions![0]
  const binding = createProjectActionBinding(
    "validate",
    {
      ...action,
      actionId,
      pluginId: provider.id,
      plugin: compiled!.name,
      digest: compiled!.digest
    },
    {}
  )
  const projectManifestPath = join(plugin.path, "devclaw.project-runtime.json")
  const projectManifest = JSON.parse(await readFile(projectManifestPath, "utf8"))
  projectManifest.actions = [{ id: binding.id, ref: binding.ref }]
  projectManifest.stages[0].actionIds = [binding.id]
  await writeFile(projectManifestPath, JSON.stringify(projectManifest))
  await writeFile(
    join(plugin.path, "devclaw.project-actions.lock.json"),
    JSON.stringify({
      apiVersion: "devclaw.project-actions-lock/v1",
      bindings: [binding]
    })
  )
  consent = await projectUseConsentFixture(state.root, () => state.plugins)
  const expectedNativeTemplate = {
    pluginId: plugin.id,
    name: plugin.name,
    version: plugin.version!,
    digest: derivationContentIdentity((await snapshotDerivationSource(plugin.path)).files)
  }
  const createInput = {
    adapterId: plugin.id,
    adapterType: "plugin",
    name: "Authorized",
    description: "",
    projectCode: "authorized",
    projectDir: "AuthorizedCase",
    projectFromLean: false, isTestProject: true,
    systemId: "system",
    systemName: "System",
    workspacePath: state.root,
    expectedNativeTemplate
  } as const
  const target = join(state.root, createInput.projectDir)
  const runtimePreparation = vi.spyOn(consent.manager, "prepareRuntimeSourceFacts")
  const configurationRead = vi.spyOn(consent.manager, "userConfig")
  expect(() => consent!.core.workspaceKey(target)).toThrow("不存在或不可访问")
  const reviewed = await consent.review(createInput)
  expect(reviewed.workspace).toBe(process.platform === "win32" ? target.toLowerCase() : target)
  if (process.platform === "win32") {
    const same = await consent.review({ ...createInput, workspacePath: state.root.toUpperCase() })
    expect(same.workspace).toBe(reviewed.workspace)
  }
  const cancelled = await consent.review({ ...createInput, projectDir: "cancelled" })
  await expect(access(join(state.root, "cancelled"))).rejects.toMatchObject({ code: "ENOENT" })
  await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" })
  expect(() => consent!.core.workspaceKey(target)).toThrow("不存在或不可访问")
  expect(consent.store.getProjectUseAuthorization(reviewed.projectId)).toBeUndefined()
  expect(consent.store.getProjectUseAuthorization(cancelled.projectId)).toBeUndefined()
  expect(consent.store.getSetting(`enabled:${reviewed.workspace}`, "")).toBe("")
  expect(consent.core.isGloballyEnabled()).toBe(false)
  expect(runtimePreparation).not.toHaveBeenCalled()
  expect(configurationRead).not.toHaveBeenCalled()
  expect(consent.guestLoads()).toBe(0)
  // A normal parent edit must not revoke consent: directory mtime is not an ownership identity.
  await writeFile(join(state.root, "ordinary-edit.txt"), "Unrelated parent file")
  const created = await consent.createReviewed(createInput, reviewed)
  expect(created.projectUseStatus?.state).toBe("ready")
  const receipt = consent.store.getProjectUseAuthorization(created.projectId)!
  expect(receipt.policy.sources.map((source) => source.pluginId)).toEqual([plugin.id, provider.id])
  const { initializeHarnessConfigV2 } = await import("./config-v2")
  await initializeHarnessConfigV2(state.root)
  await service.createHarnessFeature({
    projectId: created.projectId,
    feature: "request",
    selectedDeployUnits: [],
    sessionWorkspace: { source: "directory", path: state.root }
  })
  const feature = native.readNativeHarnessFeature(created.projectId, "request")!
  const auth = await import("./project-use-authorization")
  auth.admitProjectUseFeature(feature)
  const { HostPackageSnapshots } = await import("./project-runtime/package-snapshots")
  const retained = new HostPackageSnapshots(join(state.root, "local-projects", "packages")).read(
    receipt.policy.packageDigest
  )
  const source = { ...plugin, path: retained.root }
  const scope = { projectId: feature.hostRunId, packageDigest: receipt.policy.packageDigest }
  const workspace = consent.core.workspaceKey(feature.workspace)
  const input = { workspace, plugin: source, scope }
  expect(await consent.manager.runtimeSourceReview(input)).toMatchObject({
    state: "ready",
    configurationReady: false
  })
  expect(() => consent!.manager.assertRuntimeSourceReady(input)).toThrow(
    "Invalid plugin configuration field: token"
  )
  expect(
    consent.manager.isInstalledRuntimeSourceApproved({
      workspace,
      plugin: provider,
      name: compiled!.name,
      digest: compiled!.digest,
      scope
    })
  ).toBe(true)
  const { withNativeConfigurationScope } = await import("../mods/v2/native-configuration-scope")
  const guard = auth.captureProjectUseFeature(feature)!
  const signal = new AbortController().signal
  const secret = "fixture-only-local-token"
  const configured = await withNativeConfigurationScope(
    {
      workspace,
      projectId: feature.hostRunId,
      plugin: source,
      assertCurrent: guard,
      assertContentCurrent: guard
    },
    async () => {
      const view = await consent!.manager.userConfig(
        workspace,
        feature.hostRunId,
        plugin.id,
        signal,
        guard
      )
      return consent!.manager.saveSensitiveUserConfig(
        workspace,
        feature.hostRunId,
        plugin.id,
        view.digest,
        "token",
        { operation: "set", value: secret },
        view.savedRevision,
        signal,
        guard
      )
    }
  )
  expect(JSON.stringify(configured)).not.toContain(secret)
  expect(JSON.stringify(receipt)).not.toContain(secret)
  expect(await consent.manager.runtimeSourceReview(input)).toMatchObject({
    state: "ready",
    configurationReady: true
  })
  expect(() => consent!.manager.assertRuntimeSourceReady(input)).not.toThrow()
  expect(consent.store.getGrant(workspace, `function:${plugin.name}`)).toBeNull()
  expect(consent.store.getGrant(workspace, `function:${provider.name}`)).toBeNull()
  expect(consent.guestLoads()).toBe(0)
  auth.revokeProjectUseAuthorization(created.projectId)
  expect(() => consent!.manager.assertRuntimeSourceReady(input)).toThrow(
    "PROJECT_USE_AUTHORIZATION_INVALID"
  )
})

it("rejects parent, existing target and future junction replacements without creating a grant", async () => {
  const plugin = state.plugins[0]
  consent = await projectUseConsentFixture(state.root, () => state.plugins)
  const expectedNativeTemplate = {
    pluginId: plugin.id,
    name: plugin.name,
    version: plugin.version!,
    digest: derivationContentIdentity((await snapshotDerivationSource(plugin.path)).files)
  }
  const base = {
    adapterId: plugin.id,
    adapterType: "plugin",
    name: "Ownership",
    description: "",
    projectCode: "ownership",
    projectFromLean: false, isTestProject: true,
    systemId: "system",
    systemName: "System",
    expectedNativeTemplate
  } as const
  const parent = join(state.root, "parent")
  await mkdir(parent)
  const first = { ...base, workspacePath: parent, projectDir: "future" }
  const parentReview = await consent.review(first)
  await rename(parent, join(state.root, "old-parent"))
  await mkdir(parent)
  await expect(consent.createReviewed(first, parentReview)).rejects.toThrow(
    "PROJECT_USE_REVIEW_CHANGED"
  )
  await expect(access(join(parent, first.projectDir))).rejects.toMatchObject({ code: "ENOENT" })
  expect(consent.store.getProjectUseAuthorization(parentReview.projectId)).toBeUndefined()
  const second = { ...base, workspacePath: parent, projectDir: "existing" }
  const target = join(parent, second.projectDir)
  await mkdir(target)
  const targetReview = await consent.review(second)
  await rename(target, join(parent, "old-target"))
  await mkdir(target)
  await expect(consent.createReviewed(second, targetReview)).rejects.toThrow(
    "PROJECT_USE_REVIEW_CHANGED"
  )
  expect(consent.store.getProjectUseAuthorization(targetReview.projectId)).toBeUndefined()
  const third = { ...base, workspacePath: parent, projectDir: "linked" }
  const linkedReview = await consent.review(third)
  const outside = join(state.root, "outside")
  await mkdir(outside)
  await symlink(
    outside,
    join(parent, third.projectDir),
    process.platform === "win32" ? "junction" : "dir"
  )
  await expect(consent.createReviewed(third, linkedReview)).rejects.toThrow(
    "PROJECT_HOST_DIRECTORY_INVALID"
  )
  expect(consent.store.getProjectUseAuthorization(linkedReview.projectId)).toBeUndefined()
  expect(consent.guestLoads()).toBe(0)
  expect(await readFile(join(state.root, "harness-board-projects.json"), "utf8")).toBe(
    originalStore
  )
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
    new Error("HARNESS_NATIVE_EXECUTION_MISSING_SUFFIX"),
    { message: "PROJECT_PLUGIN_UNAVAILABLE" },
    "PROJECT_PLUGIN_UNAVAILABLE"
  ]) {
    read.mockRejectedValueOnce(failure)
    await expect(service.getHarnessProjectDetails([healthy.projectId])).rejects.toBe(failure)
  }
})
