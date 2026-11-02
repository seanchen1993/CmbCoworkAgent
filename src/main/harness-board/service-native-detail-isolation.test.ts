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
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { HarnessProjectMetadata } from "../../shared/harness-board-types"
import type { PluginMetadata } from "../types"
import { createProjectTemplate } from "../mods/devtools/project-template"
import { derivationContentIdentity, snapshotDerivationSource } from "../plugins/derivation-source"
import { canonicalTmpdir } from "../../../tests/support/canonical-temp-dir"
import { projectUseConsentFixture } from "../../../tests/support/project-use-consent"

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
    { message: "PROJECT_PLUGIN_UNAVAILABLE" },
    "PROJECT_PLUGIN_UNAVAILABLE"
  ]) {
    read.mockRejectedValueOnce(failure)
    await expect(service.getHarnessProjectDetails([healthy.projectId])).rejects.toBe(failure)
  }
})
