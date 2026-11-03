import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync, chmodSync } from "node:fs"
import { dirname, join, basename } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { HarnessProjectMetadata } from "../../shared/harness-board-types"
import type { PluginMetadata } from "../types"
import { canonicalTmpdir } from "../../../tests/support/canonical-temp-dir"
import { HostProjectStore } from "./project-runtime/host-store"
import { HostProjectService } from "./project-runtime/host-service"
import { HostPackageSnapshots } from "./project-runtime/package-snapshots"
import { hostProjectFixture } from "./project-runtime/host-fixtures.test-helper"
import { createNativeProjectTemplate } from "../mods/devtools/project-native-template"
import { compileNativeComposition, type NativeComposition } from "../plugins/native-composition"

const state = vi.hoisted(() => ({ root: "", plugins: [] as PluginMetadata[] }))
vi.mock("../storage", () => ({ getOpenworkDir: () => state.root, getPlugins: () => state.plugins }))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => state.root }))
import { buildNativeDiscussionContext } from "./native-discussion-context"
import {
  configureNativeHarnessRuntime,
  createNativeHarnessFeature,
  ensureNativeHarnessFeatureRun,
  initializeNativeHarnessProject,
  closeNativeHarnessFeatureStore
} from "./native-harness"

let store: HostProjectStore
let host: HostProjectService
let snapshots: HostPackageSnapshots
let project: HarnessProjectMetadata
let workspace: string
let pluginRoot: string
let executions: number
const write = (path: string, text: string | Buffer) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const saveProject = () =>
  write(
    join(state.root, "harness-board-projects.json"),
    JSON.stringify({ version: 1, projects: [project] })
  )
beforeEach(() => {
  state.root = mkdtempSync(join(canonicalTmpdir(), "discussion-context-"))
  workspace = join(state.root, "repo")
  mkdirSync(workspace)
  pluginRoot = join(state.root, "plugin")
  const manifest = hostProjectFixture(workspace).manifest
  write(join(pluginRoot, "plugin.json"), JSON.stringify({ name: "docs", version: "1.0.0" }))
  write(join(pluginRoot, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  for (const stage of manifest.stages)
    write(
      join(pluginRoot, stage.skill!),
      `---\nname: ${stage.id}\n---\n${stage.id === "draft" ? "DRAFT_ONLY: clarify the audience and write document.md." : "REVIEW_ONLY: independently review document.md."}`
    )
  state.plugins = [
    {
      id: "installed",
      name: "docs",
      version: "1.0.0",
      path: pluginRoot,
      enabled: true
    } as PluginMetadata
  ]
  project = {
    projectId: "parent",
    name: "Generic documents",
    description: "Not the submitted goal",
    projectCode: "docs",
    projectDir: "project",
    projectFromLean: false,
    systemId: "system",
    systemName: "System",
    workspacePath: state.root,
    "harness-adapter": { id: "installed", name: "docs", version: "1.0.0", type: "plugin" },
    nativeBinding: { engine: "host", installedPluginId: "installed" },
    lifecycle: { status: "active", createAt: new Date().toISOString() }
  }
  initializeNativeHarnessProject(project)
  saveProject()
  executions = 0
  store = new HostProjectStore(join(state.root, "host.sqlite"))
  snapshots = new HostPackageSnapshots(join(state.root, "local-projects", "packages"))
  host = new HostProjectService(store, snapshots, {
    resolveInstalledPlugin: async () => ({
      installedPluginId: "installed",
      root: pluginRoot,
      packageId: state.plugins[0].name,
      packageVersion: state.plugins[0].version,
      enabled: true
    }),
    authorize: async () => undefined,
    executeSkill: async (context) => {
      executions++
      write(join(context.project.workspace, "document.md"), context.project.goal)
      return "succeeded"
    }
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
})
afterEach(() => {
  vi.restoreAllMocks()
  closeNativeHarnessFeatureStore()
  store.close()
  const root = realpathSync(state.root)
  expect(dirname(root)).toBe(canonicalTmpdir())
  expect(basename(root)).toMatch(/^discussion-context-/)
  rmSync(root, { recursive: true, force: true })
})
const createFeature = (featureId = "request") =>
  createNativeHarnessFeature({
    project,
    featureId,
    repositoryWorkspace: workspace,
    sessionWorkspace: { source: "directory", path: workspace },
    selectedDeployUnits: []
  })
const prompt = () =>
  buildNativeDiscussionContext(project.projectId, "request", { workspacePath: workspace })
const facts = (text: string) => JSON.parse(text.slice(text.lastIndexOf("\n") + 1))

it("injects the actual current skill without a slash, creating a run, executing hooks or loading other stages", async () => {
  const binding = await createFeature()
  const text = await prompt()
  expect(text).toContain("普通讨论")
  expect(text).toContain("DRAFT_ONLY")
  expect(text).not.toContain("REVIEW_ONLY")
  expect(facts(text)).toMatchObject({
    goal: null,
    state: "not_started",
    currentStage: { id: "draft" },
    artifacts: [
      { id: "document", presence: "missing", validation: "not_checked_in_this_conversation" }
    ]
  })
  expect(host.get(binding.hostRunId)).toBeUndefined()
  expect(executions).toBe(0)
})

it("refreshes stages and presence each turn, retains the frozen skill, and stops suggesting work after completion", async () => {
  const binding = await createFeature()
  await ensureNativeHarnessFeatureRun(project.projectId, "request", "Write a report for operators")
  // An updated installation must not invalidate an existing run's retained version.
  state.plugins[0].version = "2.0.0"
  write(join(pluginRoot, "skills/draft/SKILL.md"), "NEW_INSTALLATION_MUST_NOT_REPLACE_FROZEN")
  expect(await prompt()).toContain("DRAFT_ONLY")
  expect(facts(await prompt()).plugin.version).toBe("1.0.0")
  expect(await prompt()).not.toContain("NEW_INSTALLATION")
  await host.continue(binding.hostRunId)
  const review = facts(await prompt())
  expect(review.goal).toBe("Write a report for operators")
  expect(review.currentStage.id).toBe("review")
  expect(review.stageSkillReference).toContain("REVIEW_ONLY")
  expect(review.artifacts[0].presence).toBe("present")
  const operation = host
    .operations(binding.hostRunId, 100)
    .find((item) => item.status === "prepared")!
  host.approve(operation.operationId, {
    expectedVersion: operation.expectedVersion,
    inputFingerprint: operation.inputFingerprint,
    decision: "approved",
    actorId: "test"
  })
  await host.continue(binding.hostRunId)
  const completed = facts(await prompt())
  expect(completed).toMatchObject({
    state: "completed",
    currentStage: null,
    nextStage: null,
    stageSkillReference: null
  })
  expect(executions).toBe(2)
  // This is a complete two-stage filesystem/SQLite lifecycle, including snapshot retention
  // and approval. Its overall deadline is separate from per-read performance observations.
}, 20_000)

it.each(["changed", "version", "disabled", "removed", "workspace", "archived"])(
  "fails closed for %s instead of answering without context",
  async (kind) => {
    await createFeature()
    if (kind === "changed") write(join(pluginRoot, "skills/draft/SKILL.md"), "changed")
    if (kind === "version") state.plugins[0].version = "2.0.0"
    if (kind === "disabled") state.plugins[0].enabled = false
    if (kind === "removed") state.plugins = []
    if (kind === "archived") {
      project.lifecycle.status = "archived"
      saveProject()
    }
    await expect(
      buildNativeDiscussionContext(project.projectId, "request", {
        workspacePath: kind === "workspace" ? state.root : workspace
      })
    ).rejects.toThrow()
    expect(executions).toBe(0)
  }
)

it.skipIf(process.platform !== "win32")(
  "accepts the same repository with different Windows path casing",
  async () => {
    await createFeature()
    const text = await buildNativeDiscussionContext(project.projectId, "request", {
      workspacePath: workspace.toUpperCase()
    })
    expect(text).toContain("DRAFT_ONLY")
  }
)

it("reports the newest attempt of the current stage rather than an older retry", async () => {
  const binding = await createFeature()
  await ensureNativeHarnessFeatureRun(project.projectId, "request", "Goal")
  await host.continue(binding.hostRunId)
  const current = host.operations(binding.hostRunId).find((item) => item.stageId === "review")!
  expect(current.status).toBe("prepared")
  vi.spyOn(host, "operations").mockReturnValue([
    current,
    { ...current, operationId: "older-attempt", status: "failed" }
  ])
  expect(facts(await prompt()).lastRecordedOperation).toMatchObject({
    id: current.operationId,
    status: "prepared"
  })
})

it("rejects corrupted retained source and cancellation without substituting installed bytes", async () => {
  await createFeature()
  const view = await ensureNativeHarnessFeatureRun(project.projectId, "request", "Goal")
  const skill = join(snapshots.root, view.project.pluginDigest, "package", "skills/draft/SKILL.md")
  chmodSync(skill, 0o600)
  writeFileSync(skill, "corrupt snapshot")
  await expect(prompt()).rejects.toThrow("PACKAGE_CHANGED")
  await expect(
    buildNativeDiscussionContext(project.projectId, "request", {
      signal: AbortSignal.abort()
    })
  ).rejects.toThrow()
  expect(executions).toBe(0)
})

it("rejects a stage/binding change while source is being read", async () => {
  await createFeature()
  const { snapshotDerivationSource } = await import("../plugins/derivation-source")
  const source = await import("../plugins/derivation-source")
  vi.spyOn(source, "snapshotDerivationSource").mockImplementation(async (root) => {
    const value = await snapshotDerivationSource(root)
    project.lifecycle.status = "archived"
    saveProject()
    return value
  })
  await expect(prompt()).rejects.toThrow("HARNESS_NATIVE_PROJECT_CHANGED")
})

it.each([false, true])(
  "uses real creator compilation for new and derived/assembled plugins (%s)",
  async (derived) => {
    const template = createNativeProjectTemplate({
      packageId: "research-desk",
      name: "研究资料整理",
      version: "1.0.0"
    })
    const source = JSON.parse(
      template.files.find((file) => file.path === "composition/source.json")!.text
    ) as NativeComposition
    const files = template.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.text) }))
    if (derived) {
      source.plugin.id = "requirements-conversion"
      const first = structuredClone(source.modules[0])
      first.id = "convert"
      first.title = "需求3.0转换"
      first.userGuide = "请提供格式定义和转换规则"
      first.skill = "modules/convert/SKILL.md"
      first.outputs = [{ id: "converted", path: "converted.json", contract: "document/v1" }]
      first.checks = [{ ...first.checks[0], id: "converted-schema", artifactId: "converted" }]
      source.modules[0].inputs = [{ artifactId: "converted", contract: "document/v1" }]
      source.modules.unshift(first)
      files.push({
        path: first.skill,
        bytes: Buffer.from(
          "---\nname: convert\n---\nAsk for the exact format before converting requirements."
        )
      })
    }
    const built = compileNativeComposition(source, { files, actionCatalog: [] })
    for (const file of built.files) write(join(pluginRoot, file.path), file.bytes)
    state.plugins[0].name = source.plugin.id
    project["harness-adapter"].name = source.plugin.id
    saveProject()
    await createFeature()
    const context = facts(await prompt())
    expect(context.currentStage.id).toBe(derived ? "convert" : "draft")
    expect(context.route.map((stage: { id: string }) => stage.id)).toEqual(
      derived ? ["convert", "draft", "review"] : ["draft", "review"]
    )
    expect(context.stageSkillReference).toContain(
      derived ? "exact format" : "Compiled stage contract"
    )
    expect(context.currentStage.checks[0].schema).toBeDefined()
    expect(executions).toBe(0)
  }
)

it("bounds prompt size without silently dropping a required stage skill", async () => {
  write(join(pluginRoot, "skills/draft/SKILL.md"), "x".repeat(60_001))
  await createFeature()
  await expect(prompt()).rejects.toThrow("60000")
  expect(executions).toBe(0)
})

it("refuses a missing current skill even when the selected package identity is valid", async () => {
  rmSync(join(pluginRoot, "skills/draft/SKILL.md"))
  await createFeature()
  await expect(prompt()).rejects.toThrow("PROJECT_STAGE_SKILL_MISSING")
  expect(executions).toBe(0)
})

it("keeps repeated discussion reads bounded without starting a run or invoking a model", async () => {
  const binding = await createFeature()
  const elapsed: number[] = []
  let size = 0
  for (let i = 0; i < 10; i++) {
    const start = performance.now()
    size = (await prompt()).length
    elapsed.push(performance.now() - start)
  }
  elapsed.sort((a, b) => a - b)
  console.info(
    "Native discussion fixture performance",
    JSON.stringify({
      iterations: elapsed.length,
      medianMs: elapsed[5],
      maxMs: elapsed[9],
      promptChars: size
    })
  )
  expect(size).toBeLessThan(10_000)
  expect(host.get(binding.hostRunId)).toBeUndefined()
  expect(executions).toBe(0)
})
