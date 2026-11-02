import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { basename, dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { canonicalTmpdir } from "../../../tests/support/canonical-temp-dir"
import type { HarnessProjectMetadata } from "../../shared/harness-board-types"
import type { PluginMetadata } from "../types"
import { HostProjectStore } from "./project-runtime/host-store"
import { HostProjectService } from "./project-runtime/host-service"
import { HostPackageSnapshots } from "./project-runtime/package-snapshots"
import { hostProjectFixture, TEST_FINGERPRINT } from "./project-runtime/host-fixtures.test-helper"
import { runtimeDirectoryIdentity } from "./project-runtime/safe-files"
import * as worktreeApi from "../services/git-worktree"

const state = vi.hoisted(() => ({ root: "", plugins: [] as PluginMetadata[] }))
vi.mock("../storage", () => ({
  getOpenworkDir: () => state.root,
  getDbPath: () => join(state.root, "threads.sqlite"),
  getPlugins: () => state.plugins,
  getUserInfo: () => undefined,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => state.root }))
vi.mock("./notifications", () => ({ harnessNotifications: {} }))
import {
  assertNativeHarnessFeatureCurrent,
  closeNativeHarnessFeatureStore,
  configureNativeHarnessRuntime,
  createNativeHarnessFeature,
  ensureNativeHarnessFeatureRun,
  initializeNativeHarnessProject,
  nativeHarnessFeatureConfiguration,
  nativeHarnessRunDetail,
  readNativeHarnessFeature,
  updateNativeHarnessFeatureConfiguration
} from "./native-harness"

let project: HarnessProjectMetadata
let repository: string
let hostStore: HostProjectStore
let host: HostProjectService
const executions = vi.fn(async () => {
  throw Error("MODEL_EXECUTION_FORBIDDEN")
})
const worktrees: worktreeApi.WorkflowWorktreeInfo[] = []

beforeEach(() => {
  state.root = mkdtempSync(join(canonicalTmpdir(), "native-selected-directory-"))
  repository = join(state.root, "user-repository")
  mkdirSync(repository)
  writeFileSync(join(repository, "user.txt"), "existing user work\n")
  const pluginRoot = join(state.root, "plugin")
  const manifest = hostProjectFixture(repository).manifest
  mkdirSync(pluginRoot)
  writeFileSync(join(pluginRoot, "plugin.json"), JSON.stringify({ name: "docs", version: "1.0.0" }))
  writeFileSync(join(pluginRoot, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  for (const stage of manifest.stages) {
    mkdirSync(dirname(join(pluginRoot, stage.skill!)), { recursive: true })
    writeFileSync(
      join(pluginRoot, stage.skill!),
      `---\nname: ${stage.id}\n---\nDiscuss the document.`
    )
  }
  state.plugins = [
    {
      id: "installed-docs",
      name: "docs",
      version: "1.0.0",
      path: pluginRoot,
      enabled: true,
      description: "",
      author: "",
      skillCount: 2,
      mcpServerCount: 0,
      createdAt: "",
      updatedAt: ""
    }
  ]
  project = {
    projectId: "container",
    name: "Documents",
    description: "",
    projectCode: "docs",
    projectFromLean: false,
    projectDir: "project",
    systemId: "system",
    systemName: "System",
    workspacePath: state.root,
    "harness-adapter": { id: "installed-docs", name: "docs", version: "1.0.0", type: "plugin" },
    nativeBinding: { engine: "host", installedPluginId: "installed-docs" },
    lifecycle: { status: "active", createAt: "2026-11-02T00:00:00Z" }
  }
  initializeNativeHarnessProject(project)
  writeFileSync(
    join(state.root, "harness-board-projects.json"),
    JSON.stringify({ version: 1, projects: [project] })
  )
  writeFileSync(join(state.root, "plugins.json"), JSON.stringify(state.plugins))
  hostStore = new HostProjectStore(join(state.root, "host.sqlite"))
  host = new HostProjectService(hostStore, new HostPackageSnapshots(join(state.root, "packages")), {
    resolveInstalledPlugin: async (id) => ({
      installedPluginId: id,
      root: pluginRoot,
      packageId: "docs",
      packageVersion: "1.0.0",
      enabled: true
    }),
    authorize: async () => {},
    executeSkill: executions
  })
  configureNativeHarnessRuntime({
    create: async (input, guard) => {
      if (!host.get(input.projectId)) await host.localCreate(input, guard)
      return {
        project: host.get(input.projectId)!,
        operations: host.operations(input.projectId, 100)
      }
    },
    view: (id) =>
      host.get(id) ? { project: host.get(id)!, operations: host.operations(id, 100) } : undefined
  })
  executions.mockClear()
})

afterEach(async () => {
  vi.restoreAllMocks()
  closeNativeHarnessFeatureStore()
  hostStore.close()
  for (const info of worktrees.splice(0))
    await worktreeApi.removeWorkflowWorktree({
      directory: info.directory,
      gitRoot: info.gitRoot,
      branch: info.branch,
      expectedBranchHead: info.baseCommit,
      preserveChanges: true
    })
  const root = realpathSync(state.root)
  expect(dirname(root)).toBe(canonicalTmpdir())
  expect(basename(root)).toMatch(/^native-selected-directory-[a-zA-Z0-9]{6}$/)
  rmSync(root, { recursive: true, force: true })
})

function feature(featureId: string, workspace = repository) {
  return createNativeHarnessFeature({
    project,
    featureId,
    repositoryWorkspace: workspace,
    sessionWorkspace: { source: "directory", path: workspace },
    selectedDeployUnits: []
  })
}
function git(...args: string[]) {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    windowsHide: true
  }).trim()
}
function initializeGit() {
  git("init")
  git("config", "user.name", "Directory fixture")
  git("config", "user.email", "directory@example.invalid")
  git("config", "core.autocrlf", "false")
  git("add", ".")
  git("commit", "-m", "fixture base")
}
function changeRecord(featureId: string, change: (record: Record<string, unknown>) => void) {
  closeNativeHarnessFeatureStore()
  const database = new DatabaseSync(join(state.root, "harness-native-features.sqlite"))
  try {
    const row = database
      .prepare("SELECT data FROM native_harness_features WHERE project_id=? AND feature_id=?")
      .get(project.projectId, featureId) as { data: string }
    const record = JSON.parse(row.data) as Record<string, unknown>
    change(record)
    database
      .prepare("UPDATE native_harness_features SET data=? WHERE project_id=? AND feature_id=?")
      .run(JSON.stringify(record), project.projectId, featureId)
  } finally {
    database.close()
  }
}

it("keeps a non-Git Feature and its persisted conversation/artifact path in the selected directory", async () => {
  const created = await feature("plain")
  expect(created).toMatchObject({
    workspace: repository,
    repositoryWorkspace: repository,
    workspaceMode: "selected-directory",
    workspaceIdentity: runtimeDirectoryIdentity(repository)
  })
  expect(created.worktree).toBeUndefined()
  expect(created.initialUserMessage).toBeUndefined()
  expect(hostStore.listProjects()).toEqual([])
  expect(existsSync(join(state.root, "project/.harness-features"))).toBe(false)
  closeNativeHarnessFeatureStore()
  expect(readNativeHarnessFeature(project.projectId, "plain")).toEqual(created)
  expect(nativeHarnessRunDetail(project, "plain").run.resolvedSessionWorkspacePath).toBe(repository)
  expect(nativeHarnessRunDetail(project, "plain").project.projectRootPath).toBe(repository)
  expect(() => assertNativeHarnessFeatureCurrent(created)).not.toThrow()
  expect(readFileSync(join(repository, "user.txt"), "utf8")).toBe("existing user work\n")
  expect(executions).not.toHaveBeenCalled()
})

it("accepts dirty Git unchanged and issues no repository isolation or worktree command", async () => {
  initializeGit()
  writeFileSync(join(repository, "user.txt"), "uncommitted user change\n")
  writeFileSync(join(repository, "untracked.txt"), "untracked user file\n")
  const status = git("status", "--porcelain")
  const before = git("worktree", "list", "--porcelain")
  const identify = vi.spyOn(worktreeApi, "identifyRepository")
  const prepare = vi.spyOn(worktreeApi, "prepareWorkflowWorktreeSource")
  const create = vi.spyOn(worktreeApi, "createWorkflowWorktree")
  const pristine = vi.spyOn(worktreeApi, "isWorktreePristine")
  const created = await feature("dirty")
  expect(created.workspace).toBe(repository)
  expect(created.worktree).toBeUndefined()
  expect(identify).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(pristine).not.toHaveBeenCalled()
  expect(git("status", "--porcelain")).toBe(status)
  expect(git("worktree", "list", "--porcelain")).toBe(before)
  expect(readFileSync(join(repository, "untracked.txt"), "utf8")).toBe("untracked user file\n")
})

it("updates an unstarted Feature to the newly selected directory and rejects the old binding", async () => {
  const original = await feature("editable")
  const next = join(state.root, "next-user-directory")
  mkdirSync(next)
  writeFileSync(join(next, "other.txt"), "other user data")
  updateNativeHarnessFeatureConfiguration(
    project.projectId,
    "editable",
    next,
    { source: "directory", path: next },
    []
  )
  const updated = readNativeHarnessFeature(project.projectId, "editable")!
  expect(updated.workspace).toBe(next)
  expect(updated.repositoryWorkspace).toBe(next)
  expect(updated.workspaceIdentity).toBe(runtimeDirectoryIdentity(next))
  expect(() => assertNativeHarnessFeatureCurrent(original)).toThrow("BINDING_CHANGED")
  expect(() => assertNativeHarnessFeatureCurrent(updated)).not.toThrow()
  expect(readFileSync(join(repository, "user.txt"), "utf8")).toBe("existing user work\n")
  expect(readFileSync(join(next, "other.txt"), "utf8")).toBe("other user data")
})

it("rejects a selected directory replaced at the same path and retains its original identity", async () => {
  const original = await feature("replaced")
  const backup = join(state.root, "original-directory-backup")
  renameSync(repository, backup)
  mkdirSync(repository)
  writeFileSync(join(repository, "replacement.txt"), "different directory")
  expect(() => assertNativeHarnessFeatureCurrent(original)).toThrow("PROJECT_CHANGED")
  expect(() => nativeHarnessRunDetail(project, "replaced")).toThrow("PROJECT_CHANGED")
  expect(readNativeHarnessFeature(project.projectId, "replaced")).toEqual(original)
  expect(readFileSync(join(backup, "user.txt"), "utf8")).toBe("existing user work\n")
})

it("preserves an old unmarked artifact-directory record without migrating it to the repository", async () => {
  await feature("legacy-artifacts")
  const oldWorkspace = join(state.root, "project/.harness-features/legacy-artifacts")
  mkdirSync(oldWorkspace, { recursive: true })
  writeFileSync(join(oldWorkspace, "historical.txt"), "old artifact")
  changeRecord("legacy-artifacts", (record) => {
    delete record.workspaceMode
    delete record.workspaceIdentity
    record.workspace = oldWorkspace
  })
  const before = readNativeHarnessFeature(project.projectId, "legacy-artifacts")!
  expect(before.workspaceMode).toBeUndefined()
  expect(() => assertNativeHarnessFeatureCurrent(before)).not.toThrow()
  closeNativeHarnessFeatureStore()
  expect(readNativeHarnessFeature(project.projectId, "legacy-artifacts")).toEqual(before)
  expect(nativeHarnessRunDetail(project, "legacy-artifacts").project.projectRootPath).toBe(
    oldWorkspace
  )
  expect(nativeHarnessRunDetail(project, "legacy-artifacts").run.resolvedSessionWorkspacePath).toBe(
    repository
  )
  expect(readFileSync(join(oldWorkspace, "historical.txt"), "utf8")).toBe("old artifact")
})

it("retains an old owned Git worktree and its execution binding without converting it", async () => {
  initializeGit()
  await feature("legacy-worktree")
  const source = await worktreeApi.prepareWorkflowWorktreeSource(repository)
  const info = await worktreeApi.createWorkflowWorktree({
    workspacePath: repository,
    source,
    runId: "legacy-fixture",
    threadId: "legacy-fixture",
    label: "legacy",
    persistOwnership: true
  })
  worktrees.push(info)
  changeRecord("legacy-worktree", (record) => {
    delete record.workspaceMode
    delete record.workspaceIdentity
    record.workspace = realpathSync(info.workspaceDirectory)
    record.worktree = info
  })
  const before = readNativeHarnessFeature(project.projectId, "legacy-worktree")!
  expect(() => assertNativeHarnessFeatureCurrent(before)).not.toThrow()
  const run = await ensureNativeHarnessFeatureRun(
    project.projectId,
    "legacy-worktree",
    "Review historical files"
  )
  expect(run.project.workspace).toBe(before.workspace)
  expect(readNativeHarnessFeature(project.projectId, "legacy-worktree")?.worktree).toEqual(info)
  expect(
    readNativeHarnessFeature(project.projectId, "legacy-worktree")?.workspaceMode
  ).toBeUndefined()
  expect(executions).not.toHaveBeenCalled()
}, 30000)

it("keeps the real HostStore same-directory operation fence across two Feature records", async () => {
  const first = await feature("first")
  const second = await feature("second")
  expect(first.workspace).toBe(second.workspace)
  for (const binding of [first, second])
    hostStore.create({
      ...hostProjectFixture(repository),
      projectId: binding.hostRunId
    })
  const other = new HostProjectStore(join(state.root, "host.sqlite"))
  try {
    const operation = hostStore.prepare({
      projectId: first.hostRunId,
      stageId: "draft",
      expectedVersion: 1,
      idempotencyKey: "first-operation",
      inputFingerprint: TEST_FINGERPRINT
    })
    expect(() =>
      other.prepare({
        projectId: second.hostRunId,
        stageId: "draft",
        expectedVersion: 1,
        idempotencyKey: "second-operation",
        inputFingerprint: TEST_FINGERPRINT
      })
    ).toThrow("WORKSPACE_OPERATION_ACTIVE")
    hostStore.cancel(operation.operationId)
    expect(
      other.prepare({
        projectId: second.hostRunId,
        stageId: "draft",
        expectedVersion: 1,
        idempotencyKey: "second-operation",
        inputFingerprint: TEST_FINGERPRINT
      }).status
    ).toBe("prepared")
  } finally {
    other.close()
  }
  expect(readFileSync(join(repository, "user.txt"), "utf8")).toBe("existing user work\n")
})

it("rejects workspace-mode corruption instead of accepting an invented historical scope", async () => {
  await feature("invalid")
  changeRecord("invalid", (record) => {
    record.workspaceMode = "other-directory"
  })
  expect(() => readNativeHarnessFeature(project.projectId, "invalid")).toThrow("BINDING_INVALID")
})

it("reads an archived pending Feature without authorizing creation or execution", async () => {
  const binding = await feature("archived-pending")
  project.lifecycle.status = "archived"
  writeFileSync(join(state.root, "harness-board-projects.json"),
    JSON.stringify({ version: 1, projects: [project] }))
  const detail = nativeHarnessRunDetail(project, "archived-pending")
  expect(detail.project).toMatchObject({ projectId: project.projectId, projectRootPath: repository })
  expect(detail.project.lifecycle?.status).toBe("archived")
  expect(detail.nativeBinding).toEqual(binding)
  expect(detail.run.resolvedSessionWorkspacePath).toBe(repository)
  expect(detail.nativeProject).toBeUndefined()
  expect(() => assertNativeHarnessFeatureCurrent(binding)).toThrow("PROJECT_CHANGED")
  await expect(ensureNativeHarnessFeatureRun(project.projectId, "archived-pending", "Do not run"))
    .rejects.toThrow("PROJECT_CHANGED")
  await expect(feature("archived-new")).rejects.toThrow("PROJECT_UNAVAILABLE")
  expect(hostStore.listProjects()).toEqual([])
  expect(readNativeHarnessFeature(project.projectId, "archived-new")).toBeUndefined()
  expect(executions).not.toHaveBeenCalled()
})

it("retains real Host history and artifact reads after archive while rejecting identity changes", async () => {
  await feature("archived-history")
  const run = await ensureNativeHarnessFeatureRun(project.projectId, "archived-history", "Review files")
  const operation = hostStore.prepare({ projectId: run.project.projectId,
    stageId: run.project.manifest.stages[0].id, expectedVersion: run.project.version,
    idempotencyKey: "archive-history", inputFingerprint: TEST_FINGERPRINT })
  host.cancel(operation.operationId)
  const declaration = run.project.manifest.artifacts[0]
  const artifact = join(repository, declaration.path)
  mkdirSync(dirname(artifact), { recursive: true })
  writeFileSync(artifact, "preserved artifact")
  const binding = readNativeHarnessFeature(project.projectId, "archived-history")!
  project.lifecycle.status = "archived"
  writeFileSync(join(state.root, "harness-board-projects.json"),
    JSON.stringify({ version: 1, projects: [project] }))
  const detail = nativeHarnessRunDetail(project, "archived-history")
  expect(detail.project.lifecycle?.status).toBe("archived")
  expect(detail.nativeProject?.project).toEqual(host.get(run.project.projectId))
  expect(detail.nativeProject?.operations).toContainEqual(expect.objectContaining({
    operationId: operation.operationId, status: "cancelled"
  }))
  expect(detail.run.nodes.flatMap(node => node.artifacts).find(item => item.id === declaration.id)?.exists)
    .toBe(true)
  expect(readFileSync(artifact, "utf8")).toBe("preserved artifact")
  expect(() => assertNativeHarnessFeatureCurrent(binding)).toThrow("PROJECT_CHANGED")
  expect(() => nativeHarnessRunDetail({ ...project, nativeBinding: {
    engine: "host", installedPluginId: "other-installation"
  } }, "archived-history")).toThrow("PROJECT_CHANGED")
  const backup = join(state.root, "archived-directory-backup")
  renameSync(repository, backup)
  mkdirSync(repository)
  expect(() => nativeHarnessRunDetail(project, "archived-history")).toThrow("PROJECT_CHANGED")
  expect(executions).not.toHaveBeenCalled()
  expect(hostStore.listOperations(run.project.projectId, 100)).toContainEqual(expect.objectContaining({
    operationId: operation.operationId, status: "cancelled"
  }))
})

it("uses a confirmed execution override without changing the default discussion directory", async () => {
  const binding = await feature("override")
  const execution = join(state.root, "confirmed-execution-directory")
  mkdirSync(execution)
  writeFileSync(join(execution, "execution-user.txt"), "existing execution data")
  const run = await ensureNativeHarnessFeatureRun(
    project.projectId,
    "override",
    "Use confirmed directory",
    undefined,
    execution
  )
  expect(run.project.workspace).toBe(execution)
  const bound = readNativeHarnessFeature(project.projectId, "override")!
  expect(bound.workspace).toBe(execution)
  expect(bound.repositoryWorkspace).toBe(repository)
  expect(bound.workspaceIdentity).toBe(runtimeDirectoryIdentity(execution))
  expect(bound.repositoryWorkspaceIdentity).toBe(runtimeDirectoryIdentity(repository))
  expect(
    nativeHarnessFeatureConfiguration(project.projectId, "override")?.sessionWorkspace
  ).toEqual({ source: "directory", path: repository })
  closeNativeHarnessFeatureStore()
  expect(readNativeHarnessFeature(project.projectId, "override")).toEqual(bound)
  expect(nativeHarnessRunDetail(project, "override").run.resolvedSessionWorkspacePath).toBe(
    repository
  )
  expect(nativeHarnessRunDetail(project, "override").project.projectRootPath).toBe(execution)
  await expect(
    ensureNativeHarnessFeatureRun(
      project.projectId,
      "override",
      "Use confirmed directory",
      undefined,
      repository
    )
  ).rejects.toThrow("已固定目录")
  expect(() =>
    updateNativeHarnessFeatureConfiguration(
      project.projectId,
      "override",
      repository,
      { source: "directory", path: repository },
      []
    )
  ).toThrow("不能更换")
  expect(readFileSync(join(repository, "user.txt"), "utf8")).toBe("existing user work\n")
  expect(readFileSync(join(execution, "execution-user.txt"), "utf8")).toBe(
    "existing execution data"
  )
  expect(binding.repositoryWorkspace).toBe(repository)
  expect(executions).not.toHaveBeenCalled()
})

it("retains both directory identities when Host creation fails after confirming an override", async () => {
  await feature("failed-create")
  const execution = join(state.root, "failed-create-execution")
  mkdirSync(execution)
  configureNativeHarnessRuntime({
    create: async () => {
      throw Error("CONTROLLED_HOST_CREATE_FAILURE")
    },
    view: () => undefined
  })
  await expect(
    ensureNativeHarnessFeatureRun(
      project.projectId,
      "failed-create",
      "Original requirement",
      undefined,
      execution
    )
  ).rejects.toThrow("CONTROLLED_HOST_CREATE_FAILURE")
  const before = readNativeHarnessFeature(project.projectId, "failed-create")!
  expect(before.workspace).toBe(execution)
  expect(before.repositoryWorkspace).toBe(repository)
  expect(before.repositoryWorkspaceIdentity).toBe(runtimeDirectoryIdentity(repository))
  expect(before.workspaceIdentity).toBe(runtimeDirectoryIdentity(execution))
  expect(before.initialUserMessage).toBe("Original requirement")
  expect(before.packageDigest).toBeUndefined()
  expect(
    nativeHarnessFeatureConfiguration(project.projectId, "failed-create")?.sessionWorkspace
  ).toEqual({ source: "directory", path: repository })
  closeNativeHarnessFeatureStore()
  expect(readNativeHarnessFeature(project.projectId, "failed-create")).toEqual(before)
  await expect(
    ensureNativeHarnessFeatureRun(
      project.projectId,
      "failed-create",
      "Original requirement",
      undefined,
      repository
    )
  ).rejects.toThrow("已固定目录")
  expect(hostStore.listProjects()).toEqual([])
})

it.each(["execution", "repository"])(
  "rejects an override whose %s directory inode was replaced",
  async (target) => {
    await feature("replaced-override")
    const execution = join(state.root, "replacement-execution")
    mkdirSync(execution)
    await ensureNativeHarnessFeatureRun(
      project.projectId,
      "replaced-override",
      "Pinned directories",
      undefined,
      execution
    )
    const bound = readNativeHarnessFeature(project.projectId, "replaced-override")!
    const directory = target === "execution" ? execution : repository
    const backup = directory + "-original"
    renameSync(directory, backup)
    mkdirSync(directory)
    expect(() => assertNativeHarnessFeatureCurrent(bound)).toThrow("PROJECT_CHANGED")
    expect(readNativeHarnessFeature(project.projectId, "replaced-override")).toEqual(bound)
    if (target === "repository")
      expect(readFileSync(join(backup, "user.txt"), "utf8")).toBe("existing user work\n")
  }
)

it("checks real session/capability scopes and removes only registration while retaining user files", async () => {
  const binding = await feature("retained-user-files")
  const { initializeHarnessConfigV2 } = await import("./config-v2")
  await initializeHarnessConfigV2(state.root)
  const service = await import("./service")
  const prepared = await service.prepareHarnessFeatureThreadSession(
    project.projectId,
    "retained-user-files"
  )
  expect(prepared?.workspacePath).toBe(repository)
  expect(prepared?.launchStage?.name).toBe("draft")
  expect(
    service.getHarnessCapabilityFeatureWorkspace(project.projectId, "retained-user-files")
  ).toBe(repository)
  const appDb = await import("../db")
  await appDb.initializeDatabase()
  try {
    appDb.createThread("manual-discussion", {
      workspacePath: repository,
      harnessFeature: {
        projectId: project.projectId,
        slug: "retained-user-files",
        source: "autobizdevops"
      }
    })
    const { captureProjectCapabilityContext } = await import("../mods/project-capability-context")
    const context = captureProjectCapabilityContext("manual-discussion", repository)
    expect(context.projectId).toBe(project.projectId)
    expect(() => context.assertCurrent()).not.toThrow()
    const storePath = join(state.root, "harness-board-projects.json")
    const originalStore = readFileSync(storePath, "utf8")
    writeFileSync(storePath, originalStore + "\n")
    expect(() => prepared!.assertCurrent()).toThrow()
    expect(
      service.getHarnessCapabilityFeatureWorkspace(project.projectId, "retained-user-files")
    ).toBeUndefined()
    expect(() => context.assertCurrent()).toThrow()
    writeFileSync(storePath, originalStore)
    await service.initializeHarnessManagedRunProjectDirectories()
    const current = await service.prepareHarnessFeatureThreadSession(
      project.projectId,
      "retained-user-files"
    )
    const backup = repository + "-original"
    renameSync(repository, backup)
    mkdirSync(repository)
    expect(() => current!.assertCurrent()).toThrow()
    expect(
      service.getHarnessCapabilityFeatureWorkspace(project.projectId, "retained-user-files")
    ).toBeUndefined()
    rmdirSync(repository)
    renameSync(backup, repository)
    expect(() => current!.assertCurrent()).not.toThrow()
    const parentRoot = join(state.root, project.projectDir)
    const parentBackup = parentRoot + "-original"
    renameSync(parentRoot, parentBackup)
    mkdirSync(parentRoot)
    expect(() => current!.assertCurrent()).toThrow()
    rmdirSync(parentRoot)
    renameSync(parentBackup, parentRoot)
    expect(() => current!.assertCurrent()).not.toThrow()
    const archived = { ...project, lifecycle: { ...project.lifecycle, status: "archived" } }
    writeFileSync(storePath, JSON.stringify({ version: 1, projects: [archived] }))
    await service.initializeHarnessManagedRunProjectDirectories()
    expect(
      service.getHarnessCapabilityFeatureWorkspace(project.projectId, "retained-user-files")
    ).toBeUndefined()
    await expect(
      service.prepareHarnessFeatureThreadSession(project.projectId, "retained-user-files")
    ).rejects.toThrow("PROJECT_CHANGED")
    writeFileSync(storePath, originalStore)
    await service.initializeHarnessManagedRunProjectDirectories()
    await feature("override-discussion")
    const execution = join(state.root, "discussion-execution")
    mkdirSync(execution)
    await ensureNativeHarnessFeatureRun(
      project.projectId,
      "override-discussion",
      "Separate execution",
      undefined,
      execution
    )
    const discussion = await service.prepareHarnessFeatureThreadSession(
      project.projectId,
      "override-discussion"
    )
    expect(discussion?.workspacePath).toBe(repository)
    expect(
      service.getHarnessCapabilityFeatureWorkspace(project.projectId, "override-discussion")
    ).toBe(repository)
    const deleted = await service.deleteHarnessProject(project.projectId)
    expect(deleted.projectId).toBe(project.projectId)
    expect(
      service.getHarnessCapabilityFeatureWorkspace(project.projectId, "retained-user-files")
    ).toBeUndefined()
    expect(() => discussion!.assertCurrent()).toThrow()
    expect(existsSync(execution)).toBe(true)
  } finally {
    await appDb.closeDatabase()
  }
  expect(
    JSON.parse(readFileSync(join(state.root, "harness-board-projects.json"), "utf8")).projects
  ).toEqual([])
  expect(existsSync(repository)).toBe(true)
  expect(readFileSync(join(repository, "user.txt"), "utf8")).toBe("existing user work\n")
  expect(readNativeHarnessFeature(project.projectId, "retained-user-files")).toEqual(binding)
  expect(() => assertNativeHarnessFeatureCurrent(binding)).toThrow("PROJECT_CHANGED")
  expect(executions).not.toHaveBeenCalled()
}, 30000)
