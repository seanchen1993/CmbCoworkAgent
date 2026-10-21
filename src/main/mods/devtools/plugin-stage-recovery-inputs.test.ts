import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { PluginStageRecoveryInputs } from "./plugin-stage-recovery-inputs"
import { FunctionModsManager } from "../v2/manager"
import { FunctionUserConfigValues } from "../v2/user-config-values"
import { ModControlStore } from "../control-store"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import {
  parseProjectRuntimeManifest,
  wrapProjectRuntimeManifest,
  CONTEXT_HANDOFF_PROTOCOL
} from "../../../shared/project-runtime"
import { testSecretProtector } from "../../../../tests/support/mods-secret-protector"
import { readProjectRecoveryContext } from "../../harness-board/project-runtime/recovery-context"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture(bare = false, canonicalConfiguration = false) {
  const root = mkdtempSync(join(tmpdir(), "plugin-recovery-inputs-"))
  const source = join(root, "package"),
    workspace = join(root, "SourceProjectCase"),
    branch = join(root, "BranchProjectCase")
  const configurationWorkspace = (path: string) =>
    canonicalConfiguration ? path.toLowerCase() : path
  const privateRoot = join(root, "native-inputs"),
    knowledge = join(root, "external-knowledge")
  for (const directory of [source, workspace, branch, knowledge]) mkdirSync(directory)
  const name = "independent-plugin",
    schema = parseFunctionUserConfig({
      knowledgeRoot: { type: "directory", title: "Knowledge", description: "", required: true },
      audience: { type: "string", title: "Audience", description: "", default: "authors" },
      tags: {
        type: "string",
        multiple: true,
        title: "Tags",
        description: "",
        default: ["stable", "reviewed"]
      },
      token: { type: "string", sensitive: true, required: true, title: "Token", description: "" }
    })!
  writeFileSync(
    join(source, "plugin.json"),
    JSON.stringify({ name, version: "1.0.0", ...(!bare ? { userConfig: schema } : {}) })
  )
  if (!bare) {
    const runtime = parseProjectRuntimeManifest({
      apiVersion: "devclaw.project-runtime/v1",
      plugin: { id: name, version: "1.0.0" },
      mode: "legacy",
      stateOwner: "plugin",
      stages: [
        {
          id: "review",
          title: "Review",
          skill: "skills/review/SKILL.md",
          actionIds: [],
          artifactIds: [],
          checkIds: [],
          approval: "none"
        }
      ],
      actions: [],
      artifacts: [],
      checks: [],
      environment: [],
      capabilities: {
        execution: false,
        conditionalTransition: false,
        idempotency: false,
        reconciliation: false,
        cancellation: false
      }
    })
    writeFileSync(
      join(source, "devclaw.project-runtime.json"),
      JSON.stringify(
        wrapProjectRuntimeManifest(runtime, {
          apiVersion: "devclaw.extension-contract/v1",
          requires: [CONTEXT_HANDOFF_PROTOCOL],
          context: {
            sourceAccess: "read-only",
            mutableData: "host",
            configuration: "host-resolved",
            knowledge: { required: true, binding: "knowledgeRoot" },
            provider: { entry: "provider.py", operations: ["session-context"] }
          }
        })
      )
    )
    writeFileSync(join(source, "provider.py"), "# Plugin-owned original context implementation\n")
  }
  writeFileSync(join(knowledge, "rules.md"), "Preserve exact external rules")
  const store = new ModControlStore(join(root, "native.sqlite")),
    protector = testSecretProtector()
  const values = new FunctionUserConfigValues(store, protector)
  if (!bare) {
    values.saveSensitive(
      configurationWorkspace(workspace),
      name,
      schema,
      "token",
      { operation: "set", value: "private-fixture" },
      0,
      () => {}
    )
    values.save(
      configurationWorkspace(workspace),
      name,
      schema,
      "knowledgeRoot",
      knowledge,
      1,
      () => {}
    )
    values.save(
      configurationWorkspace(workspace),
      name,
      schema,
      "audience",
      "reviewers",
      2,
      () => {}
    )
  }
  const manager = new FunctionModsManager(store, {
    plugins: () => [],
    enabled: () => false,
    secretProtector: protector,
    publish: async (_workspace, value) => value,
    changed: () => {}
  })
  const deps = {
    root: privateRoot,
    contextDataRoot: join(root, "plugin-data"),
    normalizeConfigurationWorkspace: configurationWorkspace,
    manager
  }
  const inputs = new PluginStageRecoveryInputs(deps)
  let current = true
  const origin = {
    sourceId: "actual-plugin-trial",
    workspace,
    packageRoot: source,
    packageDigest: "a".repeat(64),
    packageId: name,
    packageVersion: "1.0.0",
    guard: () => {
      if (!current) throw Error("OWNER_CHANGED")
    }
  }
  const retained = join(root, "retained-package")
  cpSync(source, retained, { recursive: true })
  const target = {
    projectId: "independent-branch",
    workspace: branch,
    packageRoot: retained,
    installedPluginId: "native-preview"
  }
  cleanup.push(() => {
    inputs.close()
    manager.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    inputs,
    manager,
    protector,
    values,
    schema,
    name,
    store,
    origin,
    target,
    knowledge,
    privateRoot,
    deps,
    configurationWorkspace,
    stale: () => {
      current = false
    }
  }
}

it("freezes a genuine plugin-owned source without Host state and rebinds native config/secret/knowledge privately", async () => {
  const f = fixture(),
    handle = await f.inputs.capture(f.origin)
  expect(Object.keys(handle).sort()).toEqual(["id", "schemaVersion"])
  expect(JSON.stringify(handle)).not.toContain("private-fixture")
  const frozen = (await f.inputs.prepareProviderInputs(handle, () => {}))!
  expect(frozen.configuration).toEqual({
    audience: "reviewers",
    tags: ["stable", "reviewed"],
    knowledgeRoot: frozen.knowledgeRoot
  })
  expect(frozen.knowledgeRoot).not.toBe(f.knowledge)
  expect(readFileSync(join(frozen.knowledgeRoot!, "rules.md"), "utf8")).toBe(
    "Preserve exact external rules"
  )
  expect(
    (await f.inputs.readOnlyRoots(handle)).every((path) => path.startsWith(f.privateRoot))
  ).toBe(true)
  await f.inputs.bind(handle, f.target, () => {})
  const bound = readProjectRecoveryContext(f.target.workspace, { name: f.name, version: "1.0.0" })!
  expect(bound.configuration).toEqual(frozen.configuration)
  expect(f.values.resolve(f.target.workspace, f.name, f.schema)).toMatchObject({
    token: "private-fixture",
    knowledgeRoot: frozen.knowledgeRoot
  })
  expect(f.values.read(f.target.workspace, f.name).sealed?.token).not.toBe(
    f.values.read(f.origin.workspace, f.name).sealed?.token
  )
  expect(f.store.getGrant(f.target.workspace, "function:" + f.name)).toBeNull()
  f.values.save(
    f.origin.workspace,
    f.name,
    f.schema,
    "audience",
    "source changed later",
    3,
    () => {}
  )
  f.inputs.assertTargetCurrent(f.target.projectId)
  await expect(f.inputs.assertCurrent(handle)).rejects.toThrow()
  writeFileSync(join(frozen.knowledgeRoot!, "rules.md"), "tampered private copy")
  expect(() => f.inputs.assertTargetCurrent(f.target.projectId)).toThrow("KNOWLEDGE_CHANGED")
})

it("uses canonical native configuration keys while retaining real filesystem paths", async () => {
  const f = fixture(false, true),
    sourceKey = f.configurationWorkspace(f.origin.workspace),
    targetKey = f.configurationWorkspace(f.target.workspace),
    handle = await f.inputs.capture(f.origin)
  expect(sourceKey).not.toBe(f.origin.workspace)
  expect(targetKey).not.toBe(f.target.workspace)
  const provider = (await f.inputs.prepareProviderInputs(handle, () => {}))!
  expect(provider.configuration?.audience).toBe("reviewers")
  await f.inputs.bind(handle, f.target, () => {})
  expect(f.values.read(f.target.workspace, f.name).revision).toBe(0)
  expect(f.values.resolve(targetKey, f.name, f.schema)).toMatchObject({
    audience: "reviewers",
    token: "private-fixture",
    knowledgeRoot: provider.knowledgeRoot
  })
  f.inputs.assertTargetCurrent(f.target.projectId)
  f.values.save(targetKey, f.name, f.schema, "audience", "edited target", 1, () => {})
  expect(() => f.inputs.assertTargetCurrent(f.target.projectId)).toThrow("CONFIGURATION_CHANGED")
  expect(f.store.getGrant(targetKey, "function:" + f.name)).toBeNull()
})

it("keeps facts identity stable across fresh captures and changes it for actual input changes", async () => {
  const f = fixture(),
    original = await f.inputs.capture(f.origin),
    repeated = await f.inputs.capture(f.origin)
  expect(original.id).not.toBe(repeated.id)
  expect(f.inputs.identity(original)).toBe(f.inputs.identity(repeated))
  expect(() => f.inputs.identity({ ...original })).toThrow("REFERENCE_INVALID")
  writeFileSync(join(f.knowledge, "rules.md"), "New external knowledge")
  const changed = await f.inputs.capture(f.origin)
  expect(f.inputs.identity(changed)).not.toBe(f.inputs.identity(original))
  await expect(f.inputs.assertCurrent(original)).rejects.toThrow("KNOWLEDGE_CHANGED")
})

it("reads adopted frozen target inputs cold without consulting subsequently changed source facts", async () => {
  const f = fixture(),
    handle = await f.inputs.capture(f.origin),
    identity = f.inputs.identity(handle)
  await f.inputs.bind(handle, f.target, () => {})
  f.stale()
  f.values.save(f.origin.workspace, f.name, f.schema, "audience", "source later", 3, () => {})
  writeFileSync(join(f.knowledge, "rules.md"), "Source knowledge later")
  writeFileSync(join(f.origin.packageRoot, "provider.py"), "# source code later\n")
  f.inputs.close()
  const cold = new PluginStageRecoveryInputs(f.deps)
  cleanup.push(() => cold.close())
  let targetCurrent = true
  const frame = await cold.targetInputs(f.target.projectId, {
    guard: () => {
      if (!targetCurrent) throw Error("TARGET_SCOPE_CHANGED")
    }
  })
  expect(frame.inputsDigest).toBe(identity)
  expect(frame.providerInput?.configuration?.audience).toBe("reviewers")
  expect(frame.providerInput?.configuration).not.toHaveProperty("token")
  expect(readFileSync(join(frame.providerInput!.knowledgeRoot!, "rules.md"), "utf8")).toBe(
    "Preserve exact external rules"
  )
  expect(frame.readOnlyRoots.every((path) => path.startsWith(f.privateRoot))).toBe(true)
  frame.providerInput!.assertCurrent()
  targetCurrent = false
  expect(() => frame.providerInput!.assertCurrent()).toThrow("TARGET_SCOPE_CHANGED")
  expect(f.store.getGrant(f.target.workspace, "function:" + f.name)).toBeNull()
  await expect(cold.targetInputs("unregistered", { guard: () => {} })).rejects.toThrow(
    "BINDING_CHANGED"
  )
})

it("reconciles a cold native binding after a lost publication without rewriting config or grants", async () => {
  const f = fixture(),
    original = await f.inputs.capture(f.origin),
    identity = f.inputs.identity(original)
  await f.inputs.bind(original, f.target, () => {})
  const record = f.values.read(f.target.workspace, f.name),
    roots = f.inputs.targetReadOnlyRoots(f.target.projectId)
  f.inputs.close()
  const coldManager = new FunctionModsManager(f.store, {
    plugins: () => [],
    enabled: () => false,
    secretProtector: f.protector,
    publish: async (_workspace, value) => value,
    changed: () => {}
  })
  const cold = new PluginStageRecoveryInputs({ ...f.deps, manager: coldManager })
  cleanup.push(() => {
    cold.close()
    coldManager.close()
  })
  const fresh = await cold.capture(f.origin)
  expect(cold.identity(fresh)).toBe(identity)
  await cold.bind(fresh, f.target, () => {})
  expect(f.values.read(f.target.workspace, f.name)).toEqual(record)
  expect(cold.targetReadOnlyRoots(f.target.projectId)).toEqual(roots)
  expect(f.store.getGrant(f.target.workspace, "function:" + f.name)).toBeNull()
  await expect(
    cold.bind(fresh, { ...f.target, installedPluginId: "different-installation" }, () => {})
  ).rejects.toThrow("BINDING_CHANGED")
  f.values.save(f.origin.workspace, f.name, f.schema, "audience", "new input", 3, () => {})
  const changed = await cold.capture(f.origin)
  expect(cold.identity(changed)).not.toBe(identity)
  await expect(cold.bind(changed, f.target, () => {})).rejects.toThrow("BINDING_CHANGED")
  expect(f.values.read(f.target.workspace, f.name)).toEqual(record)
})

it.each(["knowledge", "configuration", "owner"])(
  "rejects changed plugin %s before native binding",
  async (change) => {
    const f = fixture(),
      handle = await f.inputs.capture(f.origin)
    if (change === "knowledge") writeFileSync(join(f.knowledge, "rules.md"), "Changed")
    if (change === "configuration")
      f.values.save(f.origin.workspace, f.name, f.schema, "audience", "Changed", 3, () => {})
    if (change === "owner") f.stale()
    await expect(f.inputs.bind(handle, f.target, () => {})).rejects.toThrow()
    expect(f.values.read(f.target.workspace, f.name).revision).toBe(0)
  }
)

it("rejects forged/foreign/closed handles and a mismatched actual package identity", async () => {
  const f = fixture(),
    handle = await f.inputs.capture(f.origin)
  await expect(f.inputs.assertCurrent({ ...handle })).rejects.toThrow("REFERENCE_INVALID")
  await expect(f.inputs.capture({ ...f.origin, packageId: "different" })).rejects.toThrow(
    "SOURCE_CHANGED"
  )
  await expect(
    f.inputs.bind(handle, { ...f.target, workspace: f.origin.workspace }, () => {})
  ).rejects.toThrow("TARGET_INVALID")
  f.inputs.close()
  await expect(f.inputs.assertCurrent(handle)).rejects.toThrow("REFERENCE_INVALID")
})

it("supports bare plugin-owned inputs without inventing a Host project or configuration write", async () => {
  const f = fixture(true),
    handle = await f.inputs.capture(f.origin)
  const readonly = await f.inputs.readOnlyRoots(handle)
  expect(readonly).toHaveLength(1)
  expect(readonly[0].startsWith(f.privateRoot)).toBe(true)
  await f.inputs.bind(handle, f.target, () => {})
  expect(f.values.read(f.target.workspace, f.name).revision).toBe(0)
  f.inputs.assertTargetCurrent(f.target.projectId)
  expect(f.inputs.targetReadOnlyRoots(f.target.projectId)).toEqual([])
  f.inputs.close()
  const cold = new PluginStageRecoveryInputs(f.deps)
  cleanup.push(() => cold.close())
  cold.assertTargetCurrent(f.target.projectId)
  expect(cold.targetReadOnlyRoots(f.target.projectId)).toEqual([])
  await expect(cold.assertCurrent(handle)).rejects.toThrow("REFERENCE_INVALID")
  renameSync(f.target.workspace, f.target.workspace + "-old")
  mkdirSync(f.target.workspace)
  expect(() => cold.assertTargetCurrent(f.target.projectId)).toThrow("BINDING_CHANGED")
})
