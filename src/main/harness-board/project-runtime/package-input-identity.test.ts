import { extensionContextStorageKey } from "../extension-context"
import { afterEach, expect, it, vi } from "vitest"
import { cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  createHostProjectInputIdentity,
  fingerprintProjectKnowledge
} from "./package-input-identity"
import { hostProjectFixture } from "./host-fixtures.test-helper"
import type { HostProjectState } from "../../../shared/project-runtime/host-types"
import {
  wrapProjectRuntimeManifest,
  CONTEXT_HANDOFF_PROTOCOL
} from "../../../shared/project-runtime"
import { DECLARED_CONTEXT_FILES_PROTOCOL, EXECUTION_RESOURCES_PROTOCOL } from "../../../shared/project-runtime"
import { FunctionModsManager } from "../../mods/v2/manager"
import { ModControlStore } from "../../mods/control-store"
import { FunctionUserConfigValues } from "../../mods/v2/user-config-values"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import { ApplicationCompletionPolicies } from "../../mods/v2/application-completion-policy"
import { HostProjectService } from "./host-service"
import { HostProjectStore } from "./host-store"
import { HostPackageSnapshots } from "./package-snapshots"
import { setProjectActionRuntime } from "../project-action-runtime"
import { captureLegacyCompositionInputs } from "./composition-legacy-inputs"

const cleanup: Array<() => void> = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
)

it("binds internal legacy composition admission to actual shared configuration, knowledge and mutable deployment facts", async () => {
  const f = await fixture()
  const manifest = {
    ...f.state.manifest, mode: "legacy" as const, stateOwner: "plugin" as const, stages: []
  }
  const context = {
    sourceAccess: "read-only" as const, mutableData: "host" as const,
    configuration: "host-resolved" as const,
    knowledge: { required: true, binding: "knowledge" },
    provider: { entry: "context-provider.py", operations: ["session-context" as const] }
  }
  writeFileSync(join(f.source, "context-provider.py"), "# original package provider")
  mkdirSync(join(f.source, "board_core"))
  const board = Buffer.from('{"apiVersion":2,"supported_deploy_units":["default"]}')
  writeFileSync(join(f.source, "board_core/board_config.json"), board)
  writeFileSync(join(f.source, "devclaw.project-runtime.json"), JSON.stringify(
    wrapProjectRuntimeManifest(manifest, {
      apiVersion: "devclaw.extension-contract/v1", requires: [CONTEXT_HANDOFF_PROTOCOL], context
    })
  ))
  setProjectActionRuntime({
    ...f.input,
    catalog: async () => [], prepareSelection: async () => {},
    flows: { startSaved: vi.fn(), waitForSettlement: vi.fn(), run: vi.fn(), cancel: vi.fn() }
  })
  const inputs = await captureLegacyCompositionInputs(
    { id: "native-uuid", name: "document-project", path: f.source, version: "1.0.0" },
    "c".repeat(64), f.root
  )
  expect(inputs).toBeDefined()
  inputs!.assertCurrent()
  writeFileSync(join(f.knowledge, "glossary.md"), "changed original knowledge")
  expect(() => inputs!.assertAuthorityCurrent()).not.toThrow()
  expect(() => inputs!.assertCurrent()).toThrow("COMPOSITION_CONTEXT_INPUT_CHANGED")
  writeFileSync(join(f.knowledge, "glossary.md"), "invoice=approved")
  inputs!.assertCurrent()
  const key = extensionContextStorageKey(
    { name: "document-project", version: "1.0.0" }, board, context, f.knowledge
  )
  mkdirSync(join(f.dataRoot, key), { recursive: true })
  writeFileSync(join(f.dataRoot, key, "board_config.json"),
    '{"supported_deploy_units":["warehouse"]}')
  expect(() => inputs!.assertAuthorityCurrent()).not.toThrow()
  expect(() => inputs!.assertCurrent()).toThrow("COMPOSITION_CONTEXT_INPUT_CHANGED")
  rmSync(join(f.dataRoot, key, "board_config.json"))
  inputs!.assertCurrent()
  f.values.save(f.root, "document-native-id", f.schema, "audience", "changed", 1, () => {})
  expect(() => inputs!.assertAuthorityCurrent()).toThrow("COMPOSITION_CONTEXT_INPUT_CHANGED")
})

async function fixture(saveConfiguration = true) {
  const root = mkdtempSync(join(tmpdir(), "project-runtime-input-"))
  const source = join(root, "plugin"),
    knowledge = join(root, "knowledge")
  mkdirSync(join(source, "mods"), { recursive: true })
  mkdirSync(knowledge)
  writeFileSync(join(knowledge, "glossary.md"), "invoice=approved")
  const schema = parseFunctionUserConfig({
    knowledge: {
      type: "directory",
      title: "Knowledge",
      description: "Read-only vocabulary",
      required: true
    },
    audience: {
      type: "string",
      title: "Audience",
      description: "Document reader",
      default: "product"
    }
  })!
  writeFileSync(
    join(source, "plugin.json"),
    JSON.stringify({ name: "document-project", version: "1.0.0" })
  )
  writeFileSync(
    join(source, "mods/manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "document-native-id",
      entry: "register.ts",
      userConfig: schema
    })
  )
  writeFileSync(
    join(source, "mods/register.ts"),
    'export function register(){throw Error("Static admission must not run me")}'
  )
  const state: HostProjectState = {
    ...hostProjectFixture(root),
    schemaVersion: 1,
    stateOwner: "host",
    version: 1,
    stageIndex: 0,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    installedPluginId: "native-uuid",
    packageId: "document-project"
  }
  state.manifest.plugin.id = "document-project"
  writeFileSync(
    join(source, "devclaw.project-runtime.json"),
    JSON.stringify(
      wrapProjectRuntimeManifest(state.manifest, {
        apiVersion: "devclaw.extension-contract/v1",
        requires: [CONTEXT_HANDOFF_PROTOCOL],
        context: {
          sourceAccess: "read-only",
          mutableData: "host",
          configuration: "host-resolved",
          knowledge: { required: true, binding: "knowledge" }
        }
      })
    )
  )
  const store = new ModControlStore(join(root, "mods.sqlite"))
  const values = new FunctionUserConfigValues(store)
  if (saveConfiguration)
    values.save(root, "document-native-id", schema, "knowledge", knowledge, 0, () => {})
  const functions = new FunctionModsManager(store, {
    plugins: () => [{ id: "native-uuid", name: "document-project", path: source, enabled: true }],
    enabled: () => false,
    changed: () => {},
    publish: async (_workspace, value) => value
  })
  const policies = new ApplicationCompletionPolicies(store)
  const dataRoot = join(root, "plugin-data")
  const input = createHostProjectInputIdentity(functions, {
    contextDataRoot: dataRoot,
    rules: (workspace, names) =>
      names.map((name) => [name, policies.value(workspace, name) ?? null])
  })
  cleanup.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close(),
    () => functions.close()
  )
  await input.prepareInputIdentity(state, source)
  return {
    root,
    source,
    knowledge,
    dataRoot,
    state,
    store,
    functions,
    values,
    schema,
    policies,
    input
  }
}

it("reads declared knowledge from the original saved binding without starting a guest or leaking its local path", async () => {
  const f = await fixture()
  writeFileSync(join(f.source, "devclaw.project-runtime.json"), JSON.stringify(
    wrapProjectRuntimeManifest(f.state.manifest, {
      apiVersion: "devclaw.extension-contract/v1",
      requires: [CONTEXT_HANDOFF_PROTOCOL, DECLARED_CONTEXT_FILES_PROTOCOL],
      context: { sourceAccess: "read-only", mutableData: "host", configuration: "host-resolved",
        knowledge: { required: true, binding: "knowledge" },
        provider: { operations: ["session-context"], files: [
          { source: "knowledge", path: "glossary.md", stages: ["draft"] }
        ] } }
    })
  ))
  await f.input.prepareInputIdentity(f.state, f.source)
  const value = f.input.readDeclaredContext(f.state, f.source, "draft")
  expect(value).toContain("invoice=approved")
  expect(value).not.toContain(f.knowledge)
  const first = f.input.inputIdentity(f.state, f.source)
  // An explicitly selected glossary must not scan an unrelated large knowledge subtree.
  writeFileSync(join(f.knowledge, "unrelated.bin"), Buffer.alloc(33 * 1024 * 1024))
  expect(f.input.inputIdentity(f.state, f.source)).toBe(first)
  const nextStage = { ...f.state, stageIndex: 1 }
  const later = f.input.inputIdentity(nextStage, f.source)
  writeFileSync(join(f.knowledge, "glossary.md"), "invoice=changed")
  expect(f.input.inputIdentity(f.state, f.source)).not.toBe(first)
  expect(f.input.inputIdentity(nextStage, f.source)).toBe(later)
  expect(f.input.readDeclaredContext(f.state, f.source, "draft")).toContain("invoice=changed")
  const empty = join(f.root, "empty-knowledge")
  mkdirSync(empty)
  f.values.save(f.root, "document-native-id", f.schema, "knowledge", empty, 1, () => {})
  expect(() => f.input.readDeclaredContext(f.state, f.source, "draft")).toThrow()
})

it("exposes only declared public configuration through the original saved configuration store", async () => {
  const f = await fixture()
  const input = { workspace: f.root, plugin: {
    id: "native-uuid", name: "document-project", path: f.source, enabled: true
  } }
  expect(f.functions.readRuntimePublicConfiguration(input, ["audience"]))
    .toEqual({ audience: "product" })
  expect(f.functions.readRuntimePublicConfiguration(input, [])).toEqual({})
  for (const keys of [["knowledge"], ["missing"], ["audience", "audience"]])
    expect(() => f.functions.readRuntimePublicConfiguration(input, keys)).toThrow()
  f.values.save(f.root, "document-native-id", f.schema, "audience", "engineering", 1, () => {})
  expect(f.functions.readRuntimePublicConfiguration(input, ["audience"]))
    .toEqual({ audience: "engineering" })
})

it("binds execution workspace aliases to original required directory configuration and invalidates rebinding", async () => {
  const f = await fixture()
  const write = (binding: string) => writeFileSync(join(f.source, "devclaw.project-runtime.json"), JSON.stringify(
    wrapProjectRuntimeManifest(f.state.manifest, {
      apiVersion: "devclaw.extension-contract/v1", requires: [EXECUTION_RESOURCES_PROTOCOL],
      executionResources: { profiles: [], workspaces: [{ id: "repository", binding }] }
    })))
  write("knowledge")
  const first = f.input.inputIdentity(f.state, f.source)
  expect(f.input.readExecutionResources(f.state, f.source)?.workspaces[0])
    .toMatchObject({ id: "repository", path: expect.stringMatching(/knowledge$/) })
  const next = join(f.root, "next-repository")
  mkdirSync(next)
  f.values.save(f.root, "document-native-id", f.schema, "knowledge", next, 1, () => {})
  expect(f.input.inputIdentity(f.state, f.source)).not.toBe(first)
  expect(f.input.readExecutionResources(f.state, f.source)?.workspaces[0].path).toMatch(/next-repository$/)
  write("audience")
  expect(() => f.input.readExecutionResources(f.state, f.source)).toThrow("WORKSPACE_BINDING_INVALID")
})

it("creates a real retained project before required configuration is filled, then blocks stage preparation until native values are saved", async () => {
  const f = await fixture(false)
  for (const stage of f.state.manifest.stages) {
    mkdirSync(join(f.source, "skills", stage.id), { recursive: true })
    writeFileSync(join(f.source, stage.skill!), `---\nname: ${stage.id}\n---\nOriginal Skill`)
  }
  const projects = new HostProjectStore(join(f.root, "projects.sqlite"))
  cleanup.push(() => projects.close())
  let executed = false
  const service = new HostProjectService(projects, new HostPackageSnapshots(join(f.root, "snapshots")), {
    ...f.input,
    resolveInstalledPlugin: async () => ({
      installedPluginId: "native-uuid", root: f.source, packageId: "document-project",
      packageVersion: "1.0.0", enabled: true
    }),
    authorize: async () => {},
    executeSkill: async () => { executed = true; return "succeeded" }
  })
  const project = await service.localCreate({
    projectId: "unconfigured", name: "Configure first", workspace: f.root,
    installedPluginId: "native-uuid", goal: "Write a configured document"
  })
  expect(service.get(project.projectId)).toBeDefined()
  expect(f.values.read(f.root, "document-native-id").values).toEqual({})
  expect(() => service.prepare({ projectId: project.projectId, expectedVersion: 1, idempotencyKey: "empty" }))
    .toThrow("Invalid plugin configuration field: knowledge")
  expect(executed).toBe(false)
  expect(service.operations(project.projectId)).toEqual([])
  f.values.save(f.root, "document-native-id", f.schema, "knowledge", f.knowledge, 0, () => {})
  const operation = service.prepare({ projectId: project.projectId, expectedVersion: 1, idempotencyKey: "configured" })
  // A later native configuration removal must also stop an already-prepared operation.
  f.values.reset(f.root, "document-native-id", f.schema, "knowledge", 1, () => {})
  await expect(service.start(operation.operationId)).rejects.toThrow("Invalid plugin configuration field: knowledge")
  expect(executed).toBe(false)
  expect(f.store.getGrant(f.root, "function:document-native-id")).toBeNull()
})

it("uses actual compiled native identity and original config/rule records without executing or granting the source", async () => {
  const f = await fixture()
  const initial = f.input.inputIdentity(f.state, f.source)
  expect(f.store.getGrant(f.root, "function:document-native-id")).toBeNull()
  f.values.save(
    f.root,
    "document-project",
    f.schema,
    "audience",
    "unrelated-display-name",
    0,
    () => {}
  )
  expect(f.input.inputIdentity(f.state, f.source)).toBe(initial)
  f.values.save(f.root, "document-native-id", f.schema, "audience", "engineering", 1, () => {})
  const configured = f.input.inputIdentity(f.state, f.source)
  expect(configured).not.toBe(initial)
  f.policies.save(f.root, "document-native-id", { mode: "off" })
  expect(f.input.inputIdentity(f.state, f.source)).not.toBe(configured)
})

it("keeps routine authority on preloaded names and original revisions while content changes remain execution-boundary checks", async () => {
  const f = await fixture()
  const currentAuthority = f.input.captureInputAuthorityIdentity(f.state, f.source)
  const authority = currentAuthority()
  const content = f.input.inputIdentity(f.state, f.source)
  const sourceReads = vi.spyOn(f.functions, "getRuntimeSourceFacts")
  sourceReads.mockImplementation(() => { throw Error("ROUTINE_CONTENT_READ") })
  try {
    for (let i = 0; i < 50; i++) expect(currentAuthority()).toBe(authority)
    writeFileSync(join(f.knowledge, "glossary.md"), "changed knowledge")
    expect(currentAuthority()).toBe(authority)
    expect(sourceReads).not.toHaveBeenCalled()
    f.values.save(f.root, "document-native-id", f.schema, "audience", "new revision", 1, () => {})
    expect(currentAuthority()).not.toBe(authority)
  } finally { sourceReads.mockRestore() }
  const unprepared = join(f.root, "not-preloaded-package")
  cpSync(f.source, unprepared, { recursive: true })
  expect(() => f.input.captureInputAuthorityIdentity(f.state, unprepared))
    .toThrow("PROJECT_INPUT_SOURCE_NOT_PREPARED")
  expect(f.input.inputIdentity(f.state, f.source)).not.toBe(content)
  writeFileSync(join(f.source, "mods/register.ts"), "export function register(){}")
  expect(() => f.input.inputIdentity(f.state, f.source)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
})

it("hashes actual bound knowledge bytes and detects replacement independently of source/config revisions", async () => {
  const f = await fixture()
  const initial = f.input.inputIdentity(f.state, f.source)
  writeFileSync(join(f.knowledge, "glossary.md"), "invoice=rejected")
  expect(f.input.inputIdentity(f.state, f.source)).not.toBe(initial)
  writeFileSync(join(f.knowledge, "new.md"), "additional domain constraint")
  const added = f.input.inputIdentity(f.state, f.source)
  rmSync(join(f.knowledge, "new.md"))
  expect(f.input.inputIdentity(f.state, f.source)).not.toBe(added)
  writeFileSync(join(f.source, "mods/register.ts"), "export function register(){}")
  expect(() => f.input.inputIdentity(f.state, f.source)).toThrow("MODS_CONFIG_SOURCE_CHANGED")
})

it("rejects missing or unsafe required knowledge instead of replacing the input version with an empty default", async () => {
  const f = await fixture()
  rmSync(join(f.knowledge, "glossary.md"))
  expect(() => f.input.inputIdentity(f.state, f.source)).toThrow("PROJECT_KNOWLEDGE_REQUIRED")
  const outside = join(f.root, "outside.md")
  writeFileSync(outside, "outside bytes")
  linkSync(outside, join(f.knowledge, "linked.md"))
  expect(() => fingerprintProjectKnowledge(f.knowledge)).toThrow("FILE_UNSAFE")
})

it("retains the existing board provider host-cache identity when no optional external directory is selected", async () => {
  const f = await fixture()
  const manifestPath = join(f.source, "mods/manifest.json")
  const native = JSON.parse(readFileSync(manifestPath, "utf8"))
  native.userConfig.knowledge.required = false
  writeFileSync(manifestPath, JSON.stringify(native))
  f.values.save(f.root, "document-native-id", native.userConfig, "knowledge", "", 1, () => {})
  const runtimePath = join(f.source, "devclaw.project-runtime.json")
  const envelope = JSON.parse(readFileSync(runtimePath, "utf8"))
  const context = envelope.extensionContract.context
  context.provider = { entry: "context-provider.py", operations: ["session-context"] }
  writeFileSync(runtimePath, JSON.stringify(envelope))
  writeFileSync(join(f.source, "context-provider.py"), "# use original host-assigned cache")
  mkdirSync(join(f.source, "board_core"))
  const board = Buffer.from('{"apiVersion":2,"inspectCommands":{}}')
  writeFileSync(join(f.source, "board_core/board_config.json"), board)
  const key = extensionContextStorageKey(
    { name: "document-project", version: "1.0.0" },
    board,
    context
  )
  const cache = join(f.dataRoot, key, "knowledge")
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, "knowledge.md"), "actual cached domain knowledge")
  await f.input.prepareInputIdentity(f.state, f.source)
  const initial = f.input.inputIdentity(f.state, f.source)
  writeFileSync(join(cache, "knowledge.md"), "updated cached domain knowledge")
  expect(f.input.inputIdentity(f.state, f.source)).not.toBe(initial)
  const knowledgeVersion = f.input.inputIdentity(f.state, f.source)
  writeFileSync(
    join(f.dataRoot, key, "board_config.json"),
    '{"supported_deploy_units":["new-domain"]}'
  )
  expect(f.input.inputIdentity(f.state, f.source)).not.toBe(knowledgeVersion)
})
