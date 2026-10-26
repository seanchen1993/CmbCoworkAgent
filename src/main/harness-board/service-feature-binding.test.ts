import { execFileSync } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  root: `/tmp/harness-binding-review-${process.pid}-${Date.now()}`,
  supportsPlugin: true,
  featureExists: true,
  projectExists: true,
  artifactConfig: undefined as unknown,
  sessionContextCommand: "",
  supportedDeployUnits: ["legacy-unit"],
  knowledgeBaseIds: ["bound-knowledge"],
  inspect: vi.fn()
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
              knowledgeBaseIds: state.knowledgeBaseIds,
              lifecycle: { status: "active" },
              "harness-adapter": { id: "plugin", name: "plugin", type: "plugin" }
            },
            plugin: { id: "plugin", name: "plugin", path: state.root },
            leanToken: "test-token",
            projectDirectoryExists: true,
            selectedDeployUnits: [],
            sessionContextInjectionSource: state.sessionContextCommand ? "plugin" : "cmbdevclaw",
            configSnapshot: {
              error: null,
              value: {
                apiVersion: 1,
                supported_deploy_units: state.supportedDeployUnits,
                artifact_sync: state.artifactConfig,
                inspectCommands: {
                  [process.platform]: {
                    project_status: `${process.execPath} --version`,
                    feature_status: `${process.execPath} --version`,
                    system_prompt_inject: "workspace=${sessionWorkspacePath}",
                    session_context_inject: state.sessionContextCommand
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
  parseHarnessAdapterRunInWorker: async () => ({
    workflow: { nodes: [], states: [] },
    run: { slug: "f", title: "Feature", nodes: [], watchRefs: [], hookLogRefs: [] }
  }),
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
  prepareHarnessKnowledgeDeposition,
  getHarnessProjectPublicAgentmdDeployUnits,
  getHarnessRunDetail
} from "./service"
import {
  mergeCloudKnowledgeState,
  writeKnowledgeState,
  knowledgeDirectory
} from "../services/knowledge-base-state"
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
  state.sessionContextCommand = ""
  state.supportedDeployUnits = ["legacy-unit"]
  state.knowledgeBaseIds = ["bound-knowledge"]
  state.inspect.mockClear()
})
afterAll(() => rm(state.root, { recursive: true, force: true }))
const update = () =>
  updateHarnessFeatureDeployUnits({
    projectId: "p",
    featureId: "f",
    selectedDeployUnits: [],
    sessionWorkspace: { source: "directory", path: state.root }
  })

describe("public system constraint indicators", () => {
  beforeEach(async () => {
    vi.stubEnv("CMB_COWORK_AGENT_HOME", state.root)
    await rm(join(state.root, "knowledge"), { recursive: true, force: true })
    await rm(join(state.root, "knowledge-state.json"), { force: true })
    state.sessionContextCommand = "inject --knowledge-path ${knowledgePath}"
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  const manifest = (...ids: string[]): string =>
    JSON.stringify({
      systems: ids.map((deployUnitId) => ({ deployUnits: [{ deployUnitId }] }))
    })

  const saveLibraries = async (
    libraries: Array<{ id: string; read?: string; write?: string; available?: boolean }>
  ): Promise<void> => {
    const saved = mergeCloudKnowledgeState(
      null,
      libraries.map(({ id }) => ({
        idKey: id,
        name: id,
        description: "",
        ownerId: "",
        ownerName: "",
        repoUrl: "https://example.test/repo.git",
        sshUrl: null,
        gitRef: "main"
      }))
    )
    for (const [index, item] of saved.knowledgeBases.entries()) {
      const library = libraries[index]
      item.workspaces[0].status = library.available === false ? "failed" : "success"
      for (const role of ["read", "write"] as const) {
        const path = knowledgeDirectory(item.idKey, role)
        await mkdir(join(path, ".git"), { recursive: true })
        if (library[role] !== undefined) {
          await writeFile(join(path, "agents.manifest.json"), library[role])
        }
      }
    }
    await writeKnowledgeState(saved)
  }

  it("keeps the configured deploy units for legacy injection commands", async () => {
    state.sessionContextCommand = "inject"
    state.supportedDeployUnits = [" legacy-unit ", "legacy-unit", "second"]
    expect(await getHarnessProjectPublicAgentmdDeployUnits("p")).toEqual(["legacy-unit", "second"])
  })

  it("returns no public units without an injection command", async () => {
    state.sessionContextCommand = ""
    expect(await getHarnessProjectPublicAgentmdDeployUnits("p")).toEqual([])
  })

  it("merges only bound, available read manifests and ignores legacy and write content", async () => {
    state.knowledgeBaseIds = ["first", "second", "unavailable"]
    await saveLibraries([
      { id: "first", read: manifest(" unit-a ", "shared"), write: manifest("write-only") },
      { id: "second", read: manifest("shared", "unit-b") },
      { id: "unbound", read: manifest("unbound-unit") },
      { id: "unavailable", read: manifest("unavailable-unit"), available: false }
    ])
    expect(await getHarnessProjectPublicAgentmdDeployUnits("p")).toEqual([
      "unit-a",
      "shared",
      "unit-b"
    ])
  })

  it.each([
    undefined,
    "{invalid json",
    JSON.stringify({ systems: {} }),
    JSON.stringify({ systems: [{ deployUnits: {} }] }),
    JSON.stringify({ systems: [{ deployUnits: [{ deployUnitId: "partial" }, {}] }] })
  ])("logs invalid or missing manifests and continues with other libraries: %s", async (read) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    state.knowledgeBaseIds = ["broken", "valid"]
    await saveLibraries([
      { id: "broken", read },
      { id: "valid", read: manifest("valid-unit") }
    ])
    expect(await getHarnessProjectPublicAgentmdDeployUnits("p")).toEqual(["valid-unit"])
    expect(warning).toHaveBeenCalledOnce()
    expect(warning.mock.calls[0][1]).toMatchObject({
      manifestPath: join(knowledgeDirectory("broken", "read"), "agents.manifest.json")
    })
  })

  it("does not fall back to legacy units when no bound read library is available", async () => {
    expect(await getHarnessProjectPublicAgentmdDeployUnits("p")).toEqual([])
    state.knowledgeBaseIds = []
    expect(await getHarnessProjectPublicAgentmdDeployUnits("p")).toEqual([])
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

  it("warns without blocking an injection command when bound read content is unavailable", async () => {
    vi.stubEnv("CMB_COWORK_AGENT_HOME", state.root)
    const script = join(state.root, "knowledge-injection.cjs")
    const argsPath = join(state.root, "knowledge-args.json")
    await rm(join(state.root, "knowledge-state.json"), { force: true })
    await writeFile(
      script,
      `require("node:fs").writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({ok:true,sessionContext:""}));`
    )
    state.sessionContextCommand = `"${process.execPath}" "${script}" --knowledge-path '\${knowledgePath}'`
    try {
      const context = await buildHarnessFeatureAgentContext({
        harnessFeature: { projectId: "p", slug: "f" }
      })
      expect(JSON.parse(await readFile(argsPath, "utf8"))).toEqual(["--knowledge-path", "[]"])
      expect(context?.sessionContextInjectWarning).toBe(
        "项目绑定的知识库当前不可用，本次会话未加载知识库"
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("passes all available libraries including ids as one JSON argument and warns on partial availability", async () => {
    vi.stubEnv("CMB_COWORK_AGENT_HOME", state.root)
    state.knowledgeBaseIds = ["second", "missing", "first"]
    const libraries = ["first", "second"].map((idKey) => ({
      idKey,
      name: `知识库 ${idKey}`,
      description: "",
      ownerId: "",
      ownerName: "",
      repoUrl: "https://example.test/repo.git",
      sshUrl: null,
      gitRef: "main"
    }))
    const saved = mergeCloudKnowledgeState(null, libraries)
    for (const item of saved.knowledgeBases) {
      item.workspaces[0].status = "success"
      await mkdir(join(knowledgeDirectory(item.idKey, "read"), ".git"), { recursive: true })
      execFileSync("git", ["init", "--quiet", knowledgeDirectory(item.idKey, "write")])
    }
    await writeKnowledgeState(saved)
    const script = join(state.root, "multiple-knowledge.cjs")
    const argsPath = join(state.root, "multiple-knowledge-args.json")
    await writeFile(
      script,
      `require("node:fs").writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({ok:true,sessionContext:"complete"}));`
    )
    state.sessionContextCommand = `"${process.execPath}" "${script}" --knowledge-path \${knowledgePath}`
    try {
      const context = await buildHarnessFeatureAgentContext({
        harnessFeature: { projectId: "p", slug: "f" }
      })
      const args = JSON.parse(await readFile(argsPath, "utf8"))
      expect(args).toHaveLength(2)
      expect(JSON.parse(args[1])).toEqual(
        ["second", "first"].map((id) => ({
          id,
          name: `知识库 ${id}`,
          path: knowledgeDirectory(id, "read")
        }))
      )
      expect(context?.sessionContextInjectWarning).toBe(
        "部分项目知识库当前不可用，本次会话仅加载可用知识库"
      )
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
              knowledgeBaseIds: ["first", "second"],
              "harness-adapter": { id: "plugin", name: "plugin", type: "plugin" }
            }
          ]
        })
      )
      await expect(prepareHarnessKnowledgeDeposition("p", "second")).resolves.toEqual({
        path: knowledgeDirectory("second", "write")
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("runs an existing plugin command without reading corrupt knowledge state when the placeholder is absent", async () => {
    vi.stubEnv("CMB_COWORK_AGENT_HOME", state.root)
    const script = join(state.root, "session-context.cjs")
    const marker = join(state.root, "session-context-ran")
    await writeFile(join(state.root, "knowledge-state.json"), "invalid JSON")
    await writeFile(
      script,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); console.log(JSON.stringify({ok:true,sessionContext:""}));`
    )
    state.sessionContextCommand = `"${process.execPath}" "${script}"`
    try {
      const context = await buildHarnessFeatureAgentContext({
        harnessFeature: { projectId: "p", slug: "f" }
      })
      expect(await readFile(marker, "utf8")).toBe("ran")
      expect(context?.sessionContextInjectWarning).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })
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
