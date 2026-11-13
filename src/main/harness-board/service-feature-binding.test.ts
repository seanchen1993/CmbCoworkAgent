import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  root: `/tmp/harness-binding-review-${process.pid}-${Date.now()}`,
  supportsPlugin: true,
  featureExists: true,
  projectExists: true,
  artifactConfig: undefined as unknown,
  inspect: vi.fn(),
  featureCommand: undefined as string | undefined,
  transferRunInput: false,
  runInputs: [] as string[]
}))
vi.mock("../storage", () => ({ getOpenworkDir: () => state.root }))
vi.mock("./notifications", () => ({ harnessNotifications: {} }))
vi.mock("./managed-run-store", () => ({ managedRunStore: { getLatestRun: () => undefined } }))
vi.mock("./catalog-client", () => ({
  cancelHarnessCatalogScope: () => undefined,
  readHarnessProjectContextsInWorker: async () => ({
    projects: state.projectExists
      ? {
          p: {
            project: {
              projectId: "p",
              name: "project",
              projectCode: "project",
              projectDir: "project",
              workspacePath: state.root,
              lifecycle: { status: "active" },
              "harness-adapter": { id: "plugin", name: "plugin", type: "plugin" }
            },
            plugin: { id: "plugin", name: "plugin", path: state.root },
            leanToken: "test-token",
            projectDirectoryExists: true,
            selectedDeployUnits: [],
            configSnapshot: {
              error: null,
              value: {
                apiVersion: 1,
                artifact_sync: state.artifactConfig,
                inspectCommands: {
                  [process.platform]: {
                    project_status: `"${process.execPath}" --version`,
                    feature_status: state.featureCommand ?? `"${process.execPath}" --version`,
                    system_prompt_inject: "workspace=${sessionWorkspacePath}"
                  }
                }
              }
            }
          }
        }
      : {}
  }),
  readHarnessCatalogPageInWorker: async () => ({
    projects: [{ projectId: "p", supportsSessionContextInjection: state.supportsPlugin }],
    projectNextCursor: null
  })
}))
vi.mock("./adapter-detail-client", () => ({
  cancelHarnessAdapterDetailScope: () => undefined,
  parseHarnessAdapterRunInWorker: async (buffer: Buffer) => {
    state.runInputs.push(buffer.toString())
    if (state.transferRunInput) {
      // Match the real adapter worker's ownership transfer.
      structuredClone(buffer.buffer, { transfer: [buffer.buffer] })
    }
    return {
      workflow: { nodes: [], states: [] },
      run: { slug: "f", title: "Feature", nodes: [], watchRefs: [], hookLogRefs: [] }
    }
  },
  parseHarnessAdapterDetailBatchInWorker: async () => {
    state.inspect()
    return {
      workflow: {},
      projects: {
        project: {
          runs: state.featureExists ? [{ kind: "feature", slug: "f" }] : [],
          watchRefs: []
        }
      }
    }
  }
}))
import {
  updateHarnessFeatureDeployUnits,
  buildHarnessFeatureAgentContext,
  archiveHarnessProject,
  getHarnessCapabilityFeatureWorkspace,
  getHarnessCapabilityWorkspaces,
  initializeHarnessManagedRunProjectDirectories,
  getHarnessRunDetail,
  resolveHarnessFeatureCurrentStage,
  inspectHarnessManagedFeatureStatus
} from "./service"
import { invalidateHarnessRunInspection } from "./run-inspect-cache"
import { FEATURE_V2_FILE, DEPLOY_UNIT_V2_FILE, initializeHarnessConfigV2 } from "./config-v2"

const binding = {
  projectId: "p",
  featureId: "f",
  selectedDeployUnitMappings: [],
  sessionContextInjectionSource: "plugin",
  createdAt: "2026-09-01 10:00:00"
}
beforeEach(async () => {
  await mkdir(state.root, { recursive: true })
  await writeFile(join(state.root, FEATURE_V2_FILE), JSON.stringify({ version: 2, bindings: [] }))
  await writeFile(
    join(state.root, DEPLOY_UNIT_V2_FILE),
    JSON.stringify({ version: 2, mappings: [] })
  )
  await initializeHarnessConfigV2(state.root)
  state.supportsPlugin = true
  state.featureExists = true
  state.projectExists = true
  state.artifactConfig = undefined
  state.inspect.mockClear()
  state.featureCommand = undefined
  state.transferRunInput = false
  state.runInputs = []
  invalidateHarnessRunInspection("p", "f")
})
afterAll(() => rm(state.root, { recursive: true, force: true }))
const update = () =>
  updateHarnessFeatureDeployUnits({
    projectId: "p",
    featureId: "f",
    selectedDeployUnits: [],
    sessionWorkspace: { source: "directory", path: state.root }
  })

describe("page and conversation inspection sharing", () => {
  it("runs the adapter once, survives page buffer transfer and keeps managed decisions fresh", async () => {
    const script = join(state.root, "inspect.cjs")
    const countFile = join(state.root, "inspect-count")
    const snapshotFile = join(state.root, "inspect-snapshot.json")
    const snapshot = {
      workflow: { nodes: [{ id: "dev", label: "Develop", group: "Work" }] },
      run: { currentNodeId: "dev", currentNodeStatus: "in_progress" }
    }
    await writeFile(countFile, "")
    await writeFile(snapshotFile, JSON.stringify(snapshot))
    await writeFile(
      script,
      [
        'const fs = require("node:fs")',
        `fs.appendFileSync(${JSON.stringify(countFile)}, "x")`,
        `process.stdout.write(fs.readFileSync(${JSON.stringify(snapshotFile)}))`
      ].join("\n")
    )
    state.featureCommand = `"${process.execPath}" "${script}"`
    state.transferRunInput = true
    await getHarnessRunDetail("p", "f")
    await expect(resolveHarnessFeatureCurrentStage("p", "f")).resolves.toEqual({
      name: "Work-Develop",
      status: "进行中"
    })
    await getHarnessRunDetail("p", "f")
    expect(await readFile(countFile, "utf8")).toBe("x")
    expect(state.runInputs).toEqual([JSON.stringify(snapshot), JSON.stringify(snapshot)])

    snapshot.run.currentNodeStatus = "done"
    await writeFile(snapshotFile, JSON.stringify(snapshot))
    expect((await inspectHarnessManagedFeatureStatus("p", "f")).currentNodeStatus).toBe("done")
    expect(await readFile(countFile, "utf8")).toBe("xx")
    invalidateHarnessRunInspection("p", "f")
    await expect(resolveHarnessFeatureCurrentStage("p", "f")).resolves.toEqual({
      name: "Work-Develop",
      status: "已完成"
    })
    expect(await readFile(countFile, "utf8")).toBe("xxx")
  })
})

describe("artifact accumulation sessions", () => {
  it("resolves the configured action with project, feature, token and workspace placeholders", async () => {
    await update()
    state.artifactConfig = {
      sync_type: "invoke_session",
      nextAction: {
        slashSkill: "artifact-sync",
        userMessage: "${projectCode}|${feature}|${leanToken}|${sessionWorkspacePath}",
        dialogTips: "沉淀 ${feature}"
      }
    }
    const detail = await getHarnessRunDetail("p", "f")
    expect(detail.artifactAccumulation).toEqual({
      syncType: "invoke_session",
      nextAction: {
        slashSkill: "artifact-sync",
        userMessage: `project|f|test-token|${state.root}`,
        dialogTips: "沉淀 f"
      }
    })
    expect(detail.run.resolvedSessionWorkspacePath).toBe(state.root)
  })

  it.each([
    undefined,
    { sync_type: "other", nextAction: { slashSkill: "artifact-sync" } },
    { sync_type: "invoke_session", nextAction: {} }
  ])("omits unavailable artifact actions: %j", async (config) => {
    state.artifactConfig = config
    expect((await getHarnessRunDetail("p", "f")).artifactAccumulation).toBeUndefined()
  })
})

describe("editing historical feature bindings", () => {
  it("publishes only persisted workspace facts and refreshes them after binding changes", async () => {
    await writeFile(
      join(state.root, "harness-board-projects.json"),
      JSON.stringify({
        version: 1,
        projects: [
          {
            projectId: "p",
            name: "project",
            projectCode: "project",
            projectDir: "project",
            workspacePath: state.root,
            lifecycle: { status: "active" },
            "harness-adapter": { id: "plugin", name: "plugin", type: "plugin" }
          }
        ]
      })
    )
    await update()
    await initializeHarnessManagedRunProjectDirectories()
    expect(getHarnessCapabilityWorkspaces("p")).toEqual([
      resolve(state.root),
      resolve(state.root, "project")
    ])
    const observed = getHarnessCapabilityWorkspaces("p") as string[]
    observed.push("spoofed")
    expect(getHarnessCapabilityWorkspaces("p")).not.toContain("spoofed")
    expect(getHarnessCapabilityFeatureWorkspace("p", "f")).toBe(resolve(state.root))
    const next = join(state.root, "new-session")
    await mkdir(next, { recursive: true })
    await updateHarnessFeatureDeployUnits({
      projectId: "p",
      featureId: "f",
      selectedDeployUnits: [],
      sessionWorkspace: { source: "directory", path: next }
    })
    expect(getHarnessCapabilityFeatureWorkspace("p", "f")).toBe(resolve(next))
    expect(getHarnessCapabilityFeatureWorkspace("p", "other")).toBeUndefined()
    expect(getHarnessCapabilityWorkspaces("missing")).toBeUndefined()
    await writeFile(join(state.root, FEATURE_V2_FILE), "corrupt")
    await initializeHarnessManagedRunProjectDirectories()
    expect(getHarnessCapabilityFeatureWorkspace("p", "f")).toBeUndefined()
  })

  it.each([true, false])(
    "derives missing binding injection source from project capability: %s",
    async (supportsPlugin) => {
      state.supportsPlugin = supportsPlugin
      const result = await update()
      expect(result.sessionContextInjectionSource).toBe(supportsPlugin ? "plugin" : "cmbdevclaw")
      expect(state.inspect).toHaveBeenCalledOnce()
      const saved = JSON.parse(await readFile(join(state.root, FEATURE_V2_FILE), "utf8"))
      expect(saved.bindings).toHaveLength(1)
      expect(saved.bindings[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    }
  )
  it("preserves the existing source even when current project capability differs", async () => {
    state.supportsPlugin = false
    await writeFile(
      join(state.root, FEATURE_V2_FILE),
      JSON.stringify({ version: 2, bindings: [binding] })
    )
    expect((await update()).sessionContextInjectionSource).toBe("plugin")
    expect(state.inspect).not.toHaveBeenCalled()
  })
  it.each(["feature", "project"])(
    "rejects a missing %s without writing a binding",
    async (missing) => {
      if (missing === "feature") state.featureExists = false
      else state.projectExists = false
      const before = await readFile(join(state.root, FEATURE_V2_FILE), "utf8")
      await expect(update()).rejects.toThrow(
        missing === "feature" ? "未找到该特性" : "Project not found"
      )
      expect(await readFile(join(state.root, FEATURE_V2_FILE), "utf8")).toBe(before)
    }
  )
})

describe("plugin workspace placeholder", () => {
  it.each(["/original-thread", "/fork-parent", "/managed-confirmed"])(
    "uses the actual session directory: %s",
    async (workspacePath) => {
      const context = await buildHarnessFeatureAgentContext(
        { harnessFeature: { projectId: "p", slug: "f" } },
        { workspacePath }
      )
      expect(context?.systemPromptInject).toBe(`workspace=${workspacePath}`)
    }
  )
})

describe("opaque legacy project workspace", () => {
  it.each(["/" + "x".repeat(9000), { obsolete: [1, "path"] }])(
    "preserves the raw value on writeback without exposing it",
    async (sessionWorkspacePath) => {
      const path = join(state.root, "harness-board-projects.json")
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          projects: [
            {
              projectId: "p",
              name: "project",
              projectCode: "project",
              projectDir: "project",
              workspacePath: state.root,
              sessionWorkspacePath,
              "harness-adapter": { id: "plugin", name: "plugin", type: "plugin" }
            }
          ]
        })
      )
      const result = await archiveHarnessProject("p")
      expect(result).not.toHaveProperty("sessionWorkspacePath")
      expect(JSON.parse(await readFile(path, "utf8")).projects[0].sessionWorkspacePath).toEqual(
        sessionWorkspacePath
      )
    }
  )
})
