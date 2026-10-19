import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createProjectTemplate } from "../mods/devtools/project-template"
import { CONTEXT_HANDOFF_PROTOCOL, parseProjectRuntimeManifest, wrapProjectRuntimeManifest } from "../../shared/project-runtime"
let extension: typeof import("./extension-context")
let service: typeof import("./service")
import { FEATURE_V2_FILE, DEPLOY_UNIT_V2_FILE, initializeHarnessConfigV2 } from "./config-v2"

const state = vi.hoisted(() => ({ root: "", source: "", projectWorkspace: "", featureWorkspace: "",
  chatWorkspace: "", wrongAdapter: false, featureChat: false,
  bindings: new Map<string, string>(), board: {} as Record<string, unknown> }))
const plugin = () => ({ id: "plugin", name: "scope-provider", path: state.source,
  version: "0.1.0", enabled: true, description: "Knowledge scope", author: "fixture",
  skillCount: 1, mcpServerCount: 0, createdAt: "", updatedAt: "" })
vi.mock("../storage", () => ({ getOpenworkDir: () => state.root,
  getPlugins: () => [{ id: "plugin", name: "scope-provider", path: state.source,
    version: "0.1.0", enabled: true }] }))
vi.mock("../db", async original => ({ ...await original<typeof import("../db")>(), getThreadCore: (id: string) => id === "chat" ? {
  metadata: JSON.stringify({ workspacePath: state.chatWorkspace,
    ...(state.featureChat ? { harnessFeature: { projectId: "p", slug: "f" } } : {}) })
} : undefined }))
vi.mock("./notifications", () => ({ harnessNotifications: {} }))
vi.mock("./catalog-client", () => ({
  cancelHarnessCatalogScope: () => {},
  readHarnessProjectContextsInWorker: async () => ({ projects: { p: {
    project: { projectId: "p", name: "Project", projectCode: "p", projectDir: "project",
      workspacePath: state.projectWorkspace, lifecycle: { status: "active" },
      "harness-adapter": { id: state.wrongAdapter ? "another-installed-id" : "plugin",
        name: "scope-provider", type: "plugin" } },
    plugin: { id: "plugin", name: "scope-provider", path: state.source, version: "0.1.0" },
    configSnapshot: { error: null, value: state.board }
  } } })
}))

beforeEach(async () => {
  vi.resetModules()
  state.root = await mkdtemp(join(tmpdir(), "harness-knowledge-target-"))
  state.source = join(state.root, "source")
  state.projectWorkspace = join(state.root, "project-workspace")
  state.featureWorkspace = join(state.root, "feature-worktree")
  state.chatWorkspace = join(state.root, "chat-workspace")
  state.wrongAdapter = false
  state.featureChat = false
  state.bindings.clear()
  for (const path of [state.projectWorkspace, state.featureWorkspace, state.chatWorkspace]) await mkdir(path)
  const template = createProjectTemplate({ packageId: "scope-provider", name: "Knowledge" })
  const runtime = parseProjectRuntimeManifest(JSON.parse(template.files.find(file =>
    file.path === "devclaw.project-runtime.json")!.text))
  await mkdir(join(state.source, "board_core"), { recursive: true })
  await mkdir(join(state.source, "mods/context"), { recursive: true })
  await writeFile(join(state.source, "mods/context/provider.py"), "raise RuntimeError('must not execute in projection')")
  const wrapped = wrapProjectRuntimeManifest(runtime, {
    apiVersion: "devclaw.extension-contract/v1", requires: [CONTEXT_HANDOFF_PROTOCOL], context: {
      sourceAccess: "read-only", mutableData: "host", configuration: "host-resolved",
      knowledge: { required: true, binding: "knowledgeRoot" },
      provider: { entry: "mods/context/provider.py", operations: ["session-context", "sync-knowledge"] }
    }
  })
  await writeFile(join(state.source, "devclaw.project-runtime.json"), JSON.stringify(wrapped))
  await writeFile(join(state.source, "plugin.json"), JSON.stringify({ name: plugin().name, version: "0.1.0" }))
  state.board = { apiVersion: 2, supported_deploy_units: ["old-unit"], inspectCommands: {
    [process.platform]: { knowledge_path: "${pluginPath}/sys", pull_knowledge: "python hooks/sync.py" }
  } }
  await writeFile(join(state.source, "board_core/board_config.json"), JSON.stringify(state.board))
  await writeFile(join(state.root, FEATURE_V2_FILE), JSON.stringify({ version: 2, bindings: [{
    projectId: "p", featureId: "f", selectedDeployUnitMappings: [],
    sessionContextInjectionSource: "plugin", createdAt: "2026-10-17 00:00:00",
    sessionWorkspace: { source: "directory", path: state.featureWorkspace }
  }] }))
  await writeFile(join(state.root, DEPLOY_UNIT_V2_FILE), JSON.stringify({ version: 2, mappings: [] }))
  await initializeHarnessConfigV2(state.root)
  extension = await import("./extension-context")
  service = await import("./service")
  extension.configureExtensionContextDirectoryBinding(async (_source, workspace) => state.bindings.get(workspace))
})
afterEach(async () => {
  extension.configureExtensionContextDirectoryBinding()
  if (dirname(resolve(state.root)) !== resolve(tmpdir()) ||
    !basename(state.root).startsWith("harness-knowledge-target-")) throw Error("Unsafe cleanup")
  await rm(state.root, { recursive: true, force: true })
})

it("resolves project, saved feature and ordinary chat identities through their original stores", async () => {
  for (const path of [state.projectWorkspace, state.featureWorkspace, state.chatWorkspace]) {
    const knowledge = join(path, "knowledge")
    await mkdir(knowledge)
    state.bindings.set(path, knowledge)
  }
  expect((await service.getHarnessKnowledgePreviewBinding("plugin", { projectId: "p" }))?.root)
    .toBe(state.bindings.get(state.projectWorkspace))
  expect((await service.getHarnessKnowledgePreviewBinding("plugin", { projectId: "p", featureId: "f" }))?.root)
    .toBe(state.bindings.get(state.featureWorkspace))
  expect((await service.getHarnessKnowledgePreviewBinding("plugin", { threadId: "chat" }))?.root)
    .toBe(state.bindings.get(state.chatWorkspace))
  state.featureChat = true
  expect((await service.getHarnessKnowledgePreviewBinding("plugin", { threadId: "chat" }))?.root)
    .toBe(state.bindings.get(state.featureWorkspace))
})

it("rejects renderer paths and mismatched plugin targets rather than using a global fallback", async () => {
  await expect(service.getHarnessKnowledgePreviewBinding("plugin", { workspace: state.root } as never))
    .rejects.toThrow("TARGET_INVALID")
  await expect(service.getHarnessKnowledgePreviewBinding("plugin", { projectId: "p", threadId: "chat" }))
    .rejects.toThrow("TARGET_INVALID")
  state.wrongAdapter = true
  await expect(service.getHarnessKnowledgePreviewBinding("plugin", { projectId: "p" }))
    .rejects.toThrow("ADAPTER_CHANGED")
})

it("refuses synchronization against a bound directory before spawning the original command", async () => {
  const knowledge = join(state.projectWorkspace, "knowledge")
  await mkdir(knowledge)
  await writeFile(join(knowledge, "keep.md"), "Never delete or overwrite")
  state.bindings.set(state.projectWorkspace, knowledge)
  await expect(service.syncHarnessProjectConstraints("plugin", { projectId: "p" }))
    .rejects.toThrow("KNOWLEDGE_READONLY")
  expect(await readFile(join(knowledge, "keep.md"), "utf8")).toBe("Never delete or overwrite")
})

it("projects synced host metadata to the real project UI and never imports cached executable commands", async () => {
  const prepared = (await extension.prepareExtensionContext({ sourceRoot: state.source,
    workspace: state.featureWorkspace, dataRoot: join(state.root, "plugin-data"),
    operation: "session-context", invocation: { executable: "python", args: ["context.py"] } }))!
  const cached = JSON.parse(await readFile(prepared.env.DEVCLAW_RUNTIME_CONFIG_PATH, "utf8"))
  cached.supported_deploy_units = ["fresh-unit"]
  cached.inspectCommands[process.platform].pull_knowledge = "forged-command"
  await writeFile(prepared.env.DEVCLAW_RUNTIME_CONFIG_PATH, JSON.stringify(cached))
  const configPath = prepared.env.DEVCLAW_RUNTIME_CONFIG_PATH
  const root = prepared.env.DEVCLAW_KNOWLEDGE_ROOT
  prepared.release()
  expect(await service.getHarnessProjectPublicAgentmdDeployUnits("p")).toEqual(["fresh-unit"])
  expect((await service.getHarnessKnowledgePreviewBinding("plugin", { projectId: "p" }))?.root).toBe(root)
  const actual = JSON.parse(await readFile(configPath, "utf8"))
  expect(actual.inspectCommands[process.platform].pull_knowledge).toBe("python hooks/sync.py")
  expect(JSON.parse(await readFile(join(state.source, "board_core/board_config.json"), "utf8")))
    .toEqual(state.board)
})

it("uses only the trusted internal directory projection for routine capability classification", async () => {
  const registry = await import("./internal-project-context")
  const projectId = "composition-legacy:original-run:original-unit"
  const full = vi.fn(() => { throw Error("full-content-must-not-run") })
  let authorized = true
  const index = vi.fn((id: string) => {
    if (id !== projectId) return undefined
    if (!authorized) throw Error("original-owner-revoked")
    return { projectId, featureId: "original-feature", workspace: state.featureWorkspace }
  })
  const stop = registry.registerInternalHarnessProjectProvider(full, undefined, index)
  try {
    for (let count = 0; count < 100; count++) {
      expect(service.getHarnessCapabilityWorkspaces(projectId)).toEqual([state.featureWorkspace])
      expect(service.getHarnessCapabilityFeatureWorkspace(projectId, "original-feature")).toBe(state.featureWorkspace)
    }
    expect(service.getHarnessCapabilityFeatureWorkspace(projectId, "foreign-feature")).toBeUndefined()
    expect(service.getHarnessCapabilityWorkspaces("composition-legacy:foreign:unit")).toBeUndefined()
    expect(full).not.toHaveBeenCalled()
    expect(() => registry.readInternalHarnessProject(projectId)).toThrow("full-content-must-not-run")
    authorized = false
    expect(() => service.getHarnessCapabilityWorkspaces(projectId)).toThrow("original-owner-revoked")
  } finally { stop() }
  expect(service.getHarnessCapabilityWorkspaces(projectId)).toBeUndefined()
})

it("retains the original full-provider path when an old provider has no directory reader", async () => {
  const registry = await import("./internal-project-context")
  const projectId = "composition-legacy:old-run:old-unit"
  const full = vi.fn(() => ({ featureId: "feature", context: { project: {
    projectId, workspacePath: state.projectWorkspace, projectDir: "old-feature"
  } } }) as unknown as import("./internal-project-context").InternalHarnessProjectContext)
  const stop = registry.registerInternalHarnessProjectProvider(full)
  try {
    expect(service.getHarnessCapabilityWorkspaces(projectId)).toEqual([join(state.projectWorkspace, "old-feature")])
    expect(service.getHarnessCapabilityFeatureWorkspace(projectId, "feature"))
      .toBe(join(state.projectWorkspace, "old-feature"))
    expect(full).toHaveBeenCalledTimes(2)
  } finally { stop() }
})

it("retains the original outside-workspace rejection on the old provider fallback", async () => {
  const registry = await import("./internal-project-context")
  const projectId = "composition-legacy:old-run:old-unit"
  const stop = registry.registerInternalHarnessProjectProvider(() => ({ featureId: "feature", context: {
    project: { projectId, workspacePath: state.projectWorkspace, projectDir: "../foreign" }
  } }) as unknown as import("./internal-project-context").InternalHarnessProjectContext)
  try {
    expect(() => service.getHarnessCapabilityWorkspaces(projectId)).toThrow("Project dir resolves outside workspace")
  } finally { stop() }
})
