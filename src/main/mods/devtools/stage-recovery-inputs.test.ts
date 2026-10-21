import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { StageRecoveryInputs } from "./stage-recovery-inputs"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "../v2/manager"
import { FunctionUserConfigValues } from "../v2/user-config-values"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import { testSecretProtector } from "../../../../tests/support/mods-secret-protector"
import { hostProjectFixture } from "../../harness-board/project-runtime/host-fixtures.test-helper"
import {
  wrapProjectRuntimeManifest,
  CONTEXT_HANDOFF_PROTOCOL
} from "../../../shared/project-runtime"
import {
  extensionContextStorageKey,
  prepareExtensionContext
} from "../../harness-board/extension-context"
import { createHostProjectInputIdentity } from "../../harness-board/project-runtime/package-input-identity"
import { readProjectRecoveryContext } from "../../harness-board/project-runtime/recovery-context"
import type { HostSkillExecutionContext } from "../../harness-board/project-runtime/host-service"

const cleanup: Array<() => void> = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
)
async function fixture(external = true, configurationOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "stage-recovery-inputs-"))
  const source = join(root, "source"),
    workspace = join(root, "workspace"),
    branch = join(root, "branch")
  const knowledge = join(root, "knowledge"),
    data = join(root, "plugin-data"),
    copies = join(root, "private-inputs")
  for (const directory of [
    source,
    workspace,
    branch,
    knowledge,
    data,
    join(source, "mods"),
    join(source, "board_core")
  ])
    mkdirSync(directory, { recursive: true })
  const schema = parseFunctionUserConfig({
    knowledge: { type: "directory", title: "Knowledge", description: "Read only" },
    audience: { type: "string", title: "Audience", description: "", default: "product" },
    roles: {
      type: "string",
      multiple: true,
      title: "Roles",
      description: "",
      default: ["reader", "writer"]
    },
    enabled: { type: "boolean", title: "Enabled", description: "", default: true },
    quota: { type: "number", title: "Quota", description: "", default: 7 },
    secretDefault: {
      type: "string",
      sensitive: true,
      title: "Secret default",
      description: "",
      default: "sensitive-default"
    },
    token: { type: "string", title: "Private", description: "", required: true, sensitive: true }
  })!
  const runtime = hostProjectFixture(workspace).manifest
  const contract = {
    apiVersion: "devclaw.extension-contract/v1" as const,
    requires: [CONTEXT_HANDOFF_PROTOCOL],
    context: {
      sourceAccess: "read-only" as const,
      mutableData: "host" as const,
      configuration: "host-resolved" as const,
      knowledge: { required: true, ...(external ? { binding: "knowledge" } : {}) },
      provider: { entry: "provider.py", operations: ["session-context" as const] }
    }
  }
  const configName = configurationOnly ? "docs" : "native-context"
  writeFileSync(
    join(source, "plugin.json"),
    JSON.stringify({
      name: "docs",
      version: "1.0.0",
      ...(configurationOnly ? { userConfig: schema } : {})
    })
  )
  writeFileSync(
    join(source, "devclaw.project-runtime.json"),
    JSON.stringify(wrapProjectRuntimeManifest(runtime, contract))
  )
  if (!configurationOnly) {
    writeFileSync(
      join(source, "mods/manifest.json"),
      JSON.stringify({
        apiVersion: "cmb.mods/v2",
        id: "native-context",
        entry: "register.ts",
        userConfig: schema
      })
    )
    writeFileSync(join(source, "mods/register.ts"), "export function register() {}")
  }
  writeFileSync(join(source, "provider.py"), "# reviewed original context provider")
  const board = Buffer.from(
    JSON.stringify({
      apiVersion: 2,
      supported_deploy_units: ["default"],
      inspectCommands: { [process.platform]: { knowledge_path: "original" } }
    })
  )
  writeFileSync(join(source, "board_core/board_config.json"), board)
  writeFileSync(join(knowledge, "rules.md"), "PRESERVE_EXACT_KNOWLEDGE")
  const key = extensionContextStorageKey(
    { name: "docs", version: "1.0.0" },
    board,
    contract.context,
    external ? knowledge : undefined
  )
  const sourceData = join(data, key)
  mkdirSync(join(sourceData, "knowledge"), { recursive: true })
  writeFileSync(join(sourceData, "knowledge/rules.md"), "PRESERVE_EXACT_KNOWLEDGE")
  writeFileSync(
    join(sourceData, "board_config.json"),
    JSON.stringify({ supported_deploy_units: ["warehouse"] })
  )
  const store = new ModControlStore(join(root, "settings.sqlite")),
    protector = testSecretProtector()
  const values = new FunctionUserConfigValues(store, protector)
  values.saveSensitive(
    workspace,
    configName,
    schema,
    "token",
    { operation: "set", value: "fixture-private" },
    0,
    () => {}
  )
  values.save(workspace, configName, schema, "audience", "engineers", 1, () => {})
  if (external) values.save(workspace, configName, schema, "knowledge", knowledge, 2, () => {})
  const manager = new FunctionModsManager(store, {
    plugins: () => [{ id: "installed", name: "docs", path: source, enabled: true }],
    enabled: () => !configurationOnly,
    secretProtector: protector,
    publish: async (_workspace, value) => value,
    changed: () => {}
  })
  const recovery = new StageRecoveryInputs({ root: copies, contextDataRoot: data, manager })
  cleanup.push(() => {
    manager.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  cleanup.push(() => recovery.close())
  const project = {
    ...hostProjectFixture(workspace),
    projectId: "original",
    installedPluginId: "installed",
    schemaVersion: 1 as const,
    stateOwner: "host" as const,
    version: 1,
    stageIndex: 0,
    status: "active" as const,
    createdAt: 1,
    updatedAt: 1
  }
  const context = {
    project,
    snapshotRoot: source,
    inputIdentity: "a".repeat(64),
    signal: new AbortController().signal,
    assertInputsCurrent: () => {}
  } as HostSkillExecutionContext & { inputIdentity: string }
  const packageRoot = join(root, "branch-package")
  cpSync(source, packageRoot, { recursive: true })
  const target = {
    projectId: "branch",
    workspace: branch,
    installedPluginId: "preview-branch",
    packageRoot
  }
  return {
    root,
    workspace,
    source,
    branch,
    knowledge,
    sourceData,
    copies,
    values,
    schema,
    manager,
    protector,
    recovery,
    store,
    target,
    context,
    data,
    configName
  }
}

it.each([true, false])(
  "restores native config, sealed credentials, knowledge and provider context with external binding=%s",
  async (external) => {
    const f = await fixture(external)
    const pointer = await f.recovery.capture(f.context)
    expect(pointer).toBeDefined()
    expect(Object.keys(pointer!).sort()).toEqual(["digest", "id", "schemaVersion"])
    expect(JSON.stringify(pointer)).not.toContain(f.knowledge)
    expect(readFileSync(join(f.copies, pointer!.id, "record.json"), "utf8")).not.toContain(
      "fixture-private"
    )
    await f.recovery.bind(pointer!, f.target, () => {})
    const [privateKnowledge] = f.recovery.branchReadOnlyRoots("branch")
    expect(privateKnowledge.startsWith(f.copies)).toBe(true)
    expect(readFileSync(join(privateKnowledge, "rules.md"), "utf8")).toBe(
      "PRESERVE_EXACT_KNOWLEDGE"
    )
    expect(f.values.resolve(f.branch, "native-context", f.schema)).toMatchObject({
      token: "fixture-private",
      audience: "engineers"
    })
    expect(f.store.getGrant(f.branch, "function:native-context")).toBeNull()
    const bound = readProjectRecoveryContext(f.branch, { name: "docs", version: "1.0.0" })!
    expect(bound.directory.startsWith(f.copies)).toBe(true)
    expect(
      JSON.parse(readFileSync(join(bound.directory, "board_config.json"), "utf8"))
        .supported_deploy_units
    ).toEqual(["warehouse"])
    const prepared = await prepareExtensionContext({
      sourceRoot: f.target.packageRoot,
      workspace: f.branch,
      dataRoot: f.data,
      operation: "session-context",
      invocation: { executable: "python", args: ["provider.py"] },
      configuration: { directoryBinding: async () => (external ? privateKnowledge : undefined) }
    })
    expect(prepared?.env.DEVCLAW_KNOWLEDGE_ROOT).toBe(privateKnowledge)
    expect(prepared?.env.DEVCLAW_PLUGIN_DATA_ROOT).toBe(bound.directory)
    expect(prepared?.env.DEVCLAW_KNOWLEDGE_READONLY).toBe("1")
    prepared?.assertCurrent?.()
    prepared?.release()
    f.recovery.assertBranchCurrent("branch")
    expect(
      JSON.parse(readFileSync(join(f.sourceData, "board_config.json"), "utf8"))
        .supported_deploy_units
    ).toEqual(["warehouse"])
  }
)

it("recovers a real configuration-only Host package through native forms without a guest or transferred approval", async () => {
  const f = await fixture(true, true)
  const signal = new AbortController().signal
  const view = await f.manager.userConfig(f.workspace, "thread", "installed", signal, () => {})
  expect(view.fields.find((field) => field.key === "token")).toMatchObject({
    sensitive: true,
    secretState: "saved"
  })
  expect(JSON.stringify(view)).not.toContain("fixture-private")
  await f.manager.saveUserConfig(
    f.workspace,
    "thread",
    "installed",
    view.digest,
    "audience",
    "data team",
    view.savedRevision,
    signal,
    () => {}
  )
  const input = {
    workspace: f.workspace,
    plugin: { id: "installed", name: "docs", path: f.source, enabled: true },
    scope: { projectId: "original", packageDigest: "a".repeat(64) }
  }
  const review = await f.manager.runtimeSourceReview(input)
  expect(review).toMatchObject({
    configurationOnly: true,
    configurationReady: true,
    state: "ready",
    capabilities: [],
    scannedMethods: []
  })
  expect(await f.manager.status(f.workspace)).toEqual([])
  f.manager.assertRuntimeSourceReady(input)
  await expect(
    f.manager.approveRuntimeSource({ ...input, digest: review!.digest }, () => {})
  ).rejects.toThrow("MODS_APPROVAL_STALE")
  const pointer = (await f.recovery.capture(f.context))!
  await f.recovery.bind(pointer, f.target, () => {})
  expect(f.values.resolve(f.branch, "docs", f.schema)).toMatchObject({
    audience: "data team",
    token: "fixture-private"
  })
  expect(f.store.getGrant(f.branch, "function:docs")).toBeNull()
  const [knowledge] = f.recovery.branchReadOnlyRoots("branch")
  const prepared = await prepareExtensionContext({
    sourceRoot: f.target.packageRoot,
    workspace: f.branch,
    dataRoot: f.data,
    operation: "session-context",
    invocation: { executable: "python", args: ["provider.py"] },
    configuration: { directoryBinding: async () => knowledge }
  })
  expect(prepared?.env.DEVCLAW_KNOWLEDGE_ROOT).toBe(knowledge)
  expect(prepared?.env.DEVCLAW_PLUGIN_DATA_ROOT).toContain(f.copies)
  prepared?.assertCurrent?.()
  prepared?.release()
})

it.each(["knowledge", "configuration", "mutable-context"])(
  "refuses changed original %s before binding",
  async (change) => {
    const f = await fixture(),
      pointer = (await f.recovery.capture(f.context))!
    if (change === "knowledge") writeFileSync(join(f.knowledge, "rules.md"), "Changed")
    if (change === "configuration")
      f.values.save(f.workspace, "native-context", f.schema, "audience", "Changed", 3, () => {})
    if (change === "mutable-context")
      writeFileSync(
        join(f.sourceData, "board_config.json"),
        '{"supported_deploy_units":["changed"]}'
      )
    await expect(f.recovery.bind(pointer, f.target, () => {})).rejects.toThrow()
    expect(f.values.read(f.branch, "native-context").revision).toBe(0)
  }
)

it("does not consume snapshot capacity when native knowledge validation fails", async () => {
  const f = await fixture()
  rmSync(join(f.knowledge, "rules.md"))
  for (let attempt = 0; attempt < 34; attempt++)
    await expect(f.recovery.capture(f.context)).rejects.toThrow("KNOWLEDGE_REQUIRED")
  expect(readdirSync(f.copies).filter((name) => /^[a-f0-9-]{36}$/.test(name))).toEqual([])
  writeFileSync(join(f.knowledge, "rules.md"), "PRESERVE_EXACT_KNOWLEDGE")
  expect(await f.recovery.capture(f.context)).toBeDefined()
})

it("freezes a generic text provider's native configuration and knowledge without legacy board resources", async () => {
  const f = await fixture(true, true)
  rmSync(join(f.source, "board_core/board_config.json"))
  rmSync(join(f.target.packageRoot, "board_core/board_config.json"))
  const pointer = (await f.recovery.capture(f.context))!
  await f.recovery.bind(pointer, f.target, () => {})
  const current = readProjectRecoveryContext(f.branch, { name: "docs", version: "1.0.0" })!
  expect(current.directory.startsWith(f.copies)).toBe(true)
  expect(readdirSync(current.directory)).toEqual([])
  expect(readFileSync(join(current.knowledgeRoot!, "rules.md"), "utf8")).toBe(
    "PRESERVE_EXACT_KNOWLEDGE"
  )
  expect(f.values.resolve(f.branch, "docs", f.schema)).toMatchObject({
    audience: "engineers",
    token: "fixture-private"
  })
  current.assertCurrent()
})

it.each([true, false])(
  "prepares frozen first-trial provider inputs without source binding or configuration writes, board=%s",
  async (board) => {
    const f = await fixture(true, true)
    if (!board) rmSync(join(f.source, "board_core/board_config.json"))
    const before = f.manager.readUserConfigIdentity(f.workspace, "docs")
    const pointer = (await f.recovery.capture(f.context))!
    const prepared = await f.recovery.prepareProviderInputs(pointer, () => {})
    expect(prepared.directory.startsWith(join(f.copies, pointer.id))).toBe(true)
    expect(prepared.knowledgeRoot).toBe(join(f.copies, pointer.id, "knowledge"))
    expect(f.manager.readUserConfigIdentity(f.workspace, "docs")).toEqual(before)
    expect(
      readProjectRecoveryContext(f.workspace, { name: "docs", version: "1.0.0" })
    ).toBeUndefined()
    expect(f.store.getGrant(f.workspace, "function:docs")).toBeNull()
    prepared.assertCurrent()
    writeFileSync(
      join(prepared.directory, "board_config.json"),
      '{"supported_deploy_units":["tampered"]}'
    )
    expect(() => prepared.assertCurrent()).toThrow("CONTEXT_CHANGED")
    await expect(f.recovery.prepareProviderInputs(pointer, () => {})).rejects.toThrow(
      "CONTEXT_CHANGED"
    )
  }
)

it.each([true, false])(
  "supplies frozen ordinary native values/defaults and private knowledge to provider inputs, configurationOnly=%s",
  async (configurationOnly) => {
    const f = await fixture(true, configurationOnly)
    const snapshot = (await f.recovery.capture(f.context))!
    const trial = await f.recovery.prepareProviderInputs(snapshot, () => {})
    expect(trial.configuration).toEqual({
      audience: "engineers",
      roles: ["reader", "writer"],
      enabled: true,
      quota: 7,
      knowledge: trial.knowledgeRoot
    })
    expect(JSON.stringify(trial.configuration)).not.toContain("fixture-private")
    expect(JSON.stringify(trial.configuration)).not.toContain("sensitive-default")
    expect(trial.configuration).not.toHaveProperty("token")
    expect(trial.configuration).not.toHaveProperty("secretDefault")
    await f.recovery.bind(snapshot, f.target, () => {})
    const branch = readProjectRecoveryContext(f.branch, { name: "docs", version: "1.0.0" })!
    expect(branch.configuration).toEqual(trial.configuration)
    ;(branch.configuration!.roles as string[]).push("mutated caller copy")
    expect(
      readProjectRecoveryContext(f.branch, { name: "docs", version: "1.0.0" })!.configuration!.roles
    ).toEqual(["reader", "writer"])
    trial.assertCurrent()
    branch.assertCurrent()
  }
)

it("does not treat existing target configuration as an interrupted native recovery", async () => {
  const f = await fixture(),
    pointer = (await f.recovery.capture(f.context))!
  f.values.save(f.branch, "native-context", f.schema, "audience", "engineers", 0, () => {})
  await expect(f.recovery.bind(pointer, f.target, () => {})).rejects.toThrow(
    "TARGET_CONFIGURATION_EXISTS"
  )
  await expect(f.recovery.bind(pointer, f.target, () => {})).rejects.toThrow(
    "TARGET_CONFIGURATION_EXISTS"
  )
  expect(readdirSync(join(f.copies, "bindings"))).toEqual([])
})

it("refuses snapshot tamper and branch changes, supports cold native readback, and never overwrites a different target", async () => {
  const f = await fixture(),
    pointer = (await f.recovery.capture(f.context))!
  await f.recovery.bind(pointer, f.target, () => {})
  const identity = f.manager.readUserConfigIdentity(f.branch, "native-context")
  await f.recovery.bind(pointer, f.target, () => {})
  expect(f.manager.readUserConfigIdentity(f.branch, "native-context")).toEqual(identity)
  const equivalent = (await f.recovery.capture(f.context))!
  expect(f.recovery.identity(equivalent)).toBe(f.recovery.identity(pointer))
  await expect(f.recovery.bind(equivalent, f.target, () => {})).rejects.toThrow("BINDING_CHANGED")
  await expect(
    f.recovery.bind(pointer, { ...f.target, workspace: f.workspace }, () => {})
  ).rejects.toThrow()
  f.recovery.close()
  const cold = new StageRecoveryInputs({
    root: f.copies,
    contextDataRoot: f.data,
    manager: f.manager
  })
  cleanup.push(() => cold.close())
  cold.assertBranchCurrent("branch")
  const [knowledge] = cold.branchReadOnlyRoots("branch")
  writeFileSync(join(knowledge, "rules.md"), "Changed private snapshot")
  expect(() => cold.assertBranchCurrent("branch")).toThrow("KNOWLEDGE_CHANGED")
  await expect(
    cold.assertCurrent({ ...pointer, digest: "b".repeat(64) }, () => {})
  ).rejects.toThrow("RECORD_CHANGED")
})

it("uses the isolated context in the original Host input identity and rejects mutation instead of fallback", async () => {
  const f = await fixture(false),
    pointer = (await f.recovery.capture(f.context))!
  await f.recovery.bind(pointer, f.target, () => {})
  const input = createHostProjectInputIdentity(f.manager, {
    rules: () => [],
    contextDataRoot: f.data
  })
  const project = {
    ...f.context.project,
    projectId: "branch",
    workspace: f.branch,
    installedPluginId: f.target.installedPluginId
  }
  await input.prepareInputIdentity(project, f.target.packageRoot)
  const before = input.inputIdentity(project, f.target.packageRoot)
  writeFileSync(
    join(f.sourceData, "board_config.json"),
    '{"supported_deploy_units":["original-now-changed"]}'
  )
  f.values.save(
    f.workspace,
    "native-context",
    f.schema,
    "audience",
    "new original audience",
    2,
    () => {}
  )
  // A branch reads its private native inputs, while the source is checked again for new recovery.
  expect(input.inputIdentity(project, f.target.packageRoot)).toBe(before)
  const [knowledge] = f.recovery.branchReadOnlyRoots("branch")
  writeFileSync(join(knowledge, "rules.md"), "tampered")
  expect(() => input.inputIdentity(project, f.target.packageRoot)).toThrow("KNOWLEDGE_CHANGED")
})

it("rechecks snapshots with a genuinely new native manager and retains an already bound branch without old grants", async () => {
  const f = await fixture(),
    pointer = (await f.recovery.capture(f.context))!
  await f.recovery.bind(pointer, f.target, () => {})
  f.recovery.close()
  f.manager.close()
  const manager = new FunctionModsManager(f.store, {
    plugins: () => [],
    enabled: () => false,
    secretProtector: f.protector,
    publish: async (_workspace, value) => value,
    changed: () => {}
  })
  const cold = new StageRecoveryInputs({ root: f.copies, contextDataRoot: f.data, manager })
  cleanup.push(() => {
    cold.close()
    manager.close()
  })
  cold.assertBranchCurrent("branch")
  await cold.assertCurrent(pointer, () => {})
  expect(f.store.getGrant(f.branch, "function:native-context")).toBeNull()
  expect(f.values.resolve(f.branch, "native-context", f.schema).token).toBe("fixture-private")
})
