import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../types"
import type { HarnessProjectMetadata } from "../../shared/harness-board-types"
import { HostProjectStore } from "./project-runtime/host-store"
import { HostPackageSnapshots } from "./project-runtime/package-snapshots"
import { HostProjectService } from "./project-runtime/host-service"
import { hostProjectFixture } from "./project-runtime/host-fixtures.test-helper"
import { removeWorkflowWorktree, type WorkflowWorktreeInfo } from "../services/git-worktree"

const state = vi.hoisted(() => ({ root: "", plugins: [] as PluginMetadata[] }))
vi.mock("../storage", () => ({ getOpenworkDir: () => state.root, getPlugins: () => state.plugins }))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => state.root }))
import {
  configureNativeHarnessRuntime,
  createNativeHarnessFeature,
  ensureNativeHarnessFeatureRun,
  initializeNativeHarnessProject,
  nativeHarnessProjectDetail,
  nativeHarnessRunDetail,
  readNativeHarnessFeature,
  assertNativeHarnessFeatureCurrent,
  assertNativeHarnessProjectMutable,
  closeNativeHarnessFeatureStore,
  nativeHarnessFeatureConfiguration,
  updateNativeHarnessFeatureConfiguration
} from "./native-harness"

let hostStore: HostProjectStore
let host: HostProjectService
let project: HarnessProjectMetadata
let repository: string
let authorized: boolean
let executions: number
const worktrees: WorkflowWorktreeInfo[] = []
const saveProject = () =>
  writeFileSync(
    join(state.root, "harness-board-projects.json"),
    JSON.stringify({ version: 1, projects: [project] })
  )
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "native-harness-"))
  repository = join(state.root, "repository")
  mkdirSync(repository)
  const path = join(state.root, "plugin")
  mkdirSync(path)
  const manifest = hostProjectFixture(repository).manifest
  writeFileSync(join(path, "plugin.json"), JSON.stringify({ name: "docs", version: "1.0.0" }))
  writeFileSync(join(path, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  for (const stage of manifest.stages) {
    mkdirSync(dirname(join(path, stage.skill!)), { recursive: true })
    writeFileSync(
      join(path, stage.skill!),
      `---\nname: ${stage.id}\n---\nWrite the requested document.`
    )
  }
  state.plugins = [
    {
      id: "installed-docs",
      name: "docs",
      version: "1.0.0",
      path,
      enabled: true,
      author: "",
      description: "",
      skillCount: 2,
      mcpServerCount: 0,
      createdAt: "",
      updatedAt: ""
    }
  ]
  project = {
    projectId: "container",
    name: "Documents",
    description: "Not the user request",
    projectCode: "docs",
    projectFromLean: false,
    projectDir: "project",
    systemId: "system",
    systemName: "System",
    workspacePath: state.root,
    "harness-adapter": { id: "installed-docs", name: "docs", type: "plugin", version: "1.0.0" },
    nativeBinding: { engine: "host", installedPluginId: "installed-docs" },
    lifecycle: { status: "active", createAt: new Date().toISOString() }
  }
  initializeNativeHarnessProject(project)
  saveProject()
  authorized = true
  executions = 0
  hostStore = new HostProjectStore(join(state.root, "host.sqlite"))
  host = new HostProjectService(
    hostStore,
    new HostPackageSnapshots(join(state.root, "snapshots")),
    {
      resolveInstalledPlugin: async (id) => ({
        installedPluginId: id,
        root: path,
        packageId: "docs",
        packageVersion: "1.0.0",
        enabled: true
      }),
      authorize: async () => {
        if (!authorized) throw Error("PERMISSION_REQUIRED")
      },
      executeSkill: async (context) => {
        // Controlled model seam; real Host snapshots, file checks, SQLite and transition execute below.
        executions++
        writeFileSync(join(context.project.workspace, "document.md"), context.project.goal)
        return "succeeded"
      }
    }
  )
  configureNativeHarnessRuntime({
    create: async (input, guard) => {
      const existing = host.get(input.projectId)
      if (!existing) await host.localCreate(input, guard)
      return {
        project: host.get(input.projectId)!,
        operations: host.operations(input.projectId, 100)
      }
    },
    view: (id) =>
      host.get(id) ? { project: host.get(id)!, operations: host.operations(id, 100) } : undefined
  })
})
afterEach(async () => {
  closeNativeHarnessFeatureStore()
  hostStore.close()
  for (const info of worktrees.splice(0))
    await removeWorkflowWorktree({
      directory: info.directory,
      gitRoot: info.gitRoot,
      branch: info.branch,
      expectedBranchHead: info.baseCommit,
      preserveChanges: true
    })
  const root = realpathSync(state.root)
  expect(dirname(root)).toBe(realpathSync(tmpdir()))
  expect(basename(root)).toMatch(/^native-harness-[a-zA-Z0-9]{6}$/)
  rmSync(root, { recursive: true, force: true })
})
async function feature(id: string) {
  const value = await createNativeHarnessFeature({
    project,
    featureId: id,
    repositoryWorkspace: repository,
    sessionWorkspace: { source: "directory", path: repository },
    selectedDeployUnits: []
  })
  if (value.worktree) worktrees.push(value.worktree)
  return value
}

it("persists two isolated Features and projects the original Host facts into the old view models", async () => {
  const a = await feature("first")
  const b = await feature("second")
  expect(a.workspace).not.toBe(b.workspace)
  expect(a.repositoryWorkspace).toBe(realpathSync(repository))
  expect(nativeHarnessRunDetail(project, "first").nativeProject).toBeUndefined()
  expect((await nativeHarnessProjectDetail(project)).runs.map((run) => run.featureStatus)).toEqual([
    "not_started",
    "not_started"
  ])
  const view = await ensureNativeHarnessFeatureRun(project.projectId, "first", "Actual request A")
  expect(view.project.goal).toBe("Actual request A")
  expect(host.get(b.hostRunId)).toBeUndefined()
  await host.continue(a.hostRunId)
  expect(executions).toBe(1)
  expect(readFileSync(join(a.workspace, "document.md"), "utf8")).toBe("Actual request A")
  expect(existsSync(join(b.workspace, "document.md"))).toBe(false)
  expect(nativeHarnessRunDetail(project, "first").run.nodes[0].nodeStatus).toBe("done")
  expect(nativeHarnessRunDetail(project, "first").run.nodes[1].nodeStatus).toBe("blocked")
  expect(() => assertNativeHarnessProjectMutable(project.projectId)).toThrow("尚未结算")
  const binding = readNativeHarnessFeature(project.projectId, "first")!
  closeNativeHarnessFeatureStore()
  expect(readNativeHarnessFeature(project.projectId, "first")).toEqual(binding)
  expect(nativeHarnessFeatureConfiguration(project.projectId, "first")?.sessionWorkspace).toEqual({
    source: "directory",
    path: repository
  })
  await expect(
    ensureNativeHarnessFeatureRun(project.projectId, "first", "Changed request")
  ).rejects.toThrow("REQUIREMENT_CHANGED")
  expect(() => assertNativeHarnessProjectMutable(project.projectId, true)).toThrow("不能更换")
  const finish = async (id: string) => {
    const operation = host.operations(id, 100).find((op) => op.status === "prepared")!
    host.approve(operation.operationId, {
      expectedVersion: operation.expectedVersion,
      inputFingerprint: operation.inputFingerprint,
      decision: "approved",
      actorId: "test-user"
    })
    expect((await host.continue(id)).reason).toBe("completed")
  }
  await finish(a.hostRunId)
  await ensureNativeHarnessFeatureRun(project.projectId, "second", "Actual request B")
  expect((await host.continue(b.hostRunId)).reason).toBe("approval_required")
  await finish(b.hostRunId)
  expect((await nativeHarnessProjectDetail(project)).runs.map((run) => run.featureStatus)).toEqual([
    "done",
    "done"
  ])
  expect(readFileSync(join(a.workspace, "document.md"), "utf8")).toBe("Actual request A")
  expect(readFileSync(join(b.workspace, "document.md"), "utf8")).toBe("Actual request B")
  const before = executions
  expect((await host.continue(a.hostRunId)).reason).toBe("completed")
  expect(executions).toBe(before)
  expect(nativeHarnessRunDetail(project, "first").run.nodes[0].artifacts[0]).toMatchObject({
    artifactStatus: "generated",
    path: "document.md"
  })
  expect(nativeHarnessRunDetail(project, "first").project.projectRootPath).toBe(a.workspace)
  expect(() => assertNativeHarnessProjectMutable(project.projectId)).not.toThrow()
  hostStore.close()
  hostStore = new HostProjectStore(join(state.root, "host.sqlite"))
  expect(hostStore.get(a.hostRunId)?.status).toBe("completed")
  expect(hostStore.get(b.hostRunId)?.status).toBe("completed")
})

it("keeps authorization, exact source identity, parent lifecycle and duplicate creation fences", async () => {
  await expect(
    createNativeHarnessFeature({
      project,
      featureId: "unsupported-deployment",
      repositoryWorkspace: repository,
      selectedDeployUnits: [],
      sessionWorkspace: { source: "deployUnit", deployUnitId: "unit" }
    })
  ).rejects.toThrow("旧发布单元配置不会注入")
  await expect(
    createNativeHarnessFeature({
      project,
      featureId: "unsupported-units",
      repositoryWorkspace: repository,
      sessionWorkspace: { source: "directory", path: repository },
      selectedDeployUnits: [
        { deployUnitId: "unit", deployUnitIdMapping: "unit", localRepoPath: repository }
      ]
    })
  ).rejects.toThrow("旧发布单元配置不会注入")
  const a = await feature("one")
  const configuration = nativeHarnessFeatureConfiguration(project.projectId, "one")
  expect(() =>
    updateNativeHarnessFeatureConfiguration(
      project.projectId,
      "one",
      repository,
      { source: "deployUnit", deployUnitId: "unit" },
      []
    )
  ).toThrow("旧发布单元配置不会注入")
  expect(() =>
    updateNativeHarnessFeatureConfiguration(
      project.projectId,
      "one",
      repository,
      { source: "directory", path: repository },
      [{ deployUnitId: "unit", deployUnitIdMapping: "unit", localRepoPath: repository }]
    )
  ).toThrow("旧发布单元配置不会注入")
  expect(nativeHarnessFeatureConfiguration(project.projectId, "one")).toEqual(configuration)
  await expect(feature("one")).rejects.toThrow("已存在")
  await expect(
    ensureNativeHarnessFeatureRun(project.projectId, "one", "bad\0request")
  ).rejects.toThrow()
  expect(readNativeHarnessFeature(project.projectId, "one")?.initialUserMessage).toBeUndefined()
  await ensureNativeHarnessFeatureRun(project.projectId, "one", "Original request")
  authorized = false
  await host.continue(a.hostRunId)
  expect(executions).toBe(0)
  expect(nativeHarnessRunDetail(project, "one").run.nodes[0].nodeStatus).toBe("error")
  const b = await feature("two")
  writeFileSync(join(state.plugins[0].path, "skills/draft/SKILL.md"), "changed source")
  await expect(
    ensureNativeHarnessFeatureRun(project.projectId, "two", "Request two")
  ).rejects.toThrow("PACKAGE_IDENTITY_MISMATCH")
  expect(host.get(b.hostRunId)).toBeUndefined()
  project.lifecycle.status = "archived"
  saveProject()
  expect(() =>
    assertNativeHarnessFeatureCurrent(readNativeHarnessFeature(project.projectId, "one")!)
  ).toThrow("PROJECT_CHANGED")
})

it("uses a real owned Git worktree and rejects dirty input instead of silently dropping it", async () => {
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", windowsHide: true }).trim()
  git(["init"])
  git(["config", "user.name", "Harness Test"])
  git(["config", "user.email", "harness@example.invalid"])
  git(["config", "core.autocrlf", "false"])
  mkdirSync(join(repository, "src"))
  writeFileSync(join(repository, "src/example.txt"), "original\n")
  git(["add", "."])
  git(["commit", "-m", "base"])
  writeFileSync(join(repository, "uncommitted.txt"), "user data")
  await expect(feature("dirty")).rejects.toThrow("未提交或未跟踪")
  expect(readNativeHarnessFeature(project.projectId, "dirty")).toBeUndefined()
  rmSync(join(repository, "uncommitted.txt"))
  const a = await feature("clean")
  expect(a.worktree?.sourceRoot).toBe(realpathSync(repository))
  expect(a.workspace).not.toBe(repository)
  expect(readFileSync(join(a.workspace, "src/example.txt"), "utf8")).toBe("original\n")
  expect(
    execFileSync("git", ["-C", a.workspace, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      windowsHide: true
    })
      .trim()
      .replaceAll("\\", "/")
  ).toBe(a.worktree!.directory.replaceAll("\\", "/"))
  expect(git(["status", "--porcelain"])).toBe("")
}, 30000)
