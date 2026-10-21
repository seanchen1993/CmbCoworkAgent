import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { afterEach, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../../types"
import {
  CONTEXT_HANDOFF_PROTOCOL,
  wrapProjectRuntimeManifest
} from "../../../shared/project-runtime"
import { ModControlStore } from "../../mods/control-store"
import { FunctionModsManager } from "../../mods/v2/manager"
import { FunctionGuestRuntime } from "../../mods/v2/guest-runtime"
import { withNativeConfigurationScope } from "../../mods/v2/native-configuration-scope"
import { RetainedPackageSnapshots } from "./package-snapshots"
import { createHostProjectInputIdentity } from "./package-input-identity"
import { captureLegacyCompositionInputs } from "./composition-legacy-inputs"
import { FlowManager } from "../../mods/flows/manager"
import { FlowStore } from "../../mods/flows/store"
import { setProjectActionRuntime } from "../project-action-runtime"
import { readNativeCapabilityCatalog } from "../../plugins/capability-catalog"
import { readPackageExtensionContract } from "../../plugins/extension-contract"
import { extensionContextStorageKey, prepareExtensionContext } from "../extension-context"
import { assertCompositionUnitContextSelection } from "./composition-unit-context"

const state = vi.hoisted(() => ({ root: "", plugins: [] as PluginMetadata[] }))
vi.mock("../../storage", () => ({
  getOpenworkDir: () => state.root,
  getPlugins: () => state.plugins
}))
const execute = promisify(execFile)
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

/** Shared binding/input fences with a real stdlib collector, not reviewed AutoBiz admission.
 * Full original AutoBiz/collector evidence lives in composition-unit-context-autobiz.integration.test.ts.
 */
it("collects a frozen producer's actual business knowledge and rejects later knowledge/config/source changes", async () => {
  const fixture = resolve("tests/fixtures/composition-context-collector")
  const root = (state.root = await mkdtemp(join(tmpdir(), "composition-context-real-")))
  cleanup.push(async () => {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !root.split(/[\\/]/).at(-1)!.startsWith("composition-context-real-")
    )
      throw Error("UNSAFE_TEST_CLEANUP")
    await rm(root, { recursive: true, force: true })
  })
  const source = join(root, "installed"),
    workspace = join(root, "unit"),
    knowledge = join(root, "knowledge")
  await mkdir(workspace)
  await cp(join(fixture, "package"), source, { recursive: true })
  await cp(join(fixture, "knowledge"), knowledge, { recursive: true })
  // Exercise Windows checkout text with Python's real universal-newline reader on every OS.
  for (const file of ["UNIT/AGENTS.md", "UNIT/one.md", "UNIT/two.md"]) {
    const path = join(knowledge, file)
    await writeFile(path, (await readFile(path, "utf8")).replace(/\r?\n/g, "\r\n"))
  }
  const metadata = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"))
  const context = {
    sourceAccess: "read-only" as const,
    mutableData: "host" as const,
    configuration: "host-resolved" as const,
    knowledge: { required: true, binding: "knowledgeRoot" },
    provider: { entry: "context-provider.py", operations: ["session-context" as const] }
  }
  await writeFile(
    join(source, "devclaw.project-runtime.json"),
    JSON.stringify(
      wrapProjectRuntimeManifest(
        {
          apiVersion: "devclaw.project-runtime/v1",
          plugin: { id: metadata.name, version: metadata.version },
          mode: "legacy",
          stateOwner: "plugin",
          stages: [],
          actions: [],
          artifacts: [],
          checks: [],
          environment: [],
          capabilities: {
            execution: true,
            conditionalTransition: false,
            idempotency: false,
            reconciliation: false,
            cancellation: true
          }
        },
        {
          apiVersion: "devclaw.extension-contract/v1",
          requires: [CONTEXT_HANDOFF_PROTOCOL],
          context
        }
      )
    )
  )
  await writeFile(
    join(source, "devclaw.capabilities.json"),
    JSON.stringify({
      apiVersion: "devclaw.capabilities/v1",
      capabilities: [
        {
          id: "knowledge-fixture",
          title: "Unit knowledge",
          kind: "flow",
          usage: "project",
          entry: "devclaw.project-runtime.json"
        }
      ]
    })
  )
  await mkdir(join(source, "board_core"))
  await writeFile(
    join(source, "board_core/board_config.json"),
    JSON.stringify({
      apiVersion: 2,
      supported_deploy_units: ["STALE_SOURCE_DEFAULT"],
      inspectCommands: Object.fromEntries(
        ["win32", "linux", "darwin"].map((platform) => [platform, {}])
      )
    })
  )
  const originalProvider = await readFile(join(source, "context-provider.py"))
  const snapshots = new RetainedPackageSnapshots(join(root, "retained"))
  const retained = snapshots.capture(source),
    contentGuard = snapshots.captureGuard(retained.digest)
  const plugin = {
    id: "installed-producer",
    name: metadata.name,
    version: metadata.version,
    path: source,
    enabled: true
  } as PluginMetadata
  state.plugins = [plugin]
  const bound = { ...plugin, path: retained.root }
  let owner = true
  const guard = () => {
    if (!owner || !plugin.enabled) throw Error("ORIGINAL_CONTEXT_OWNER_REVOKED")
    contentGuard()
  }
  const store = new ModControlStore(join(root, "mods.sqlite"))
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => state.plugins,
      enabled: () => true,
      publish: async (_workspace, value) => value,
      changed: () => {}
    },
    () => {
      const guests: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          return guest
        },
        stop() {
          for (const guest of guests) void guest.dispose()
        },
        async stopAndDrain() {
          await Promise.all(guests.map((guest) => guest.dispose()))
        }
      }
    }
  )
  cleanup.push(() => {
    manager.close()
    store.close()
  })
  const nativeScope = {
    workspace,
    projectId: "composition-legacy:run:unit",
    plugin: bound,
    assertCurrent: guard,
    assertContentCurrent: guard
  }
  const nativeSave = async (directory: string) =>
    withNativeConfigurationScope(nativeScope, async () => {
      const signal = new AbortController().signal
      const view = await manager.userConfig(
        workspace,
        nativeScope.projectId,
        plugin.id,
        signal,
        guard
      )
      return manager.saveUserConfig(
        workspace,
        nativeScope.projectId,
        plugin.id,
        view.digest,
        "knowledgeRoot",
        directory,
        view.savedRevision,
        signal,
        guard
      )
    })
  await nativeSave(knowledge)
  const grantScope = { projectId: nativeScope.projectId, packageDigest: retained.digest }
  const configuration = { workspace, plugin: bound, scope: grantScope }
  const inputs = createHostProjectInputIdentity(manager, {
    rules: () => [],
    contextDataRoot: join(root, "plugin-data")
  })
  const flows = new FlowManager(new FlowStore(store), {
    assertScope: () => undefined,
    changed: () => undefined,
    prepare: async () => {
      throw Error("NO_FLOW_EXECUTION_FOR_CONTEXT_READ")
    }
  })
  setProjectActionRuntime({
    ...inputs,
    flows,
    catalog: async () => [],
    prepareSelection: async () => undefined
  })
  const read = async () => {
    guard()
    await manager.prepareRuntimeSourceFacts(configuration)
    manager.assertRuntimeSourceReady(configuration)
    const captured = await captureLegacyCompositionInputs(bound, retained.digest, workspace)
    if (!captured) throw Error("CONTEXT_INPUTS_REQUIRED")
    const assertCurrent = () => {
      guard()
      manager.assertRuntimeSourceReady(configuration)
      captured.assertCurrent()
      guard()
    }
    const prepared = await prepareExtensionContext({
      sourceRoot: retained.root,
      workspace,
      dataRoot: join(root, "plugin-data"),
      operation: "session-context",
      invocation: {
        executable: process.env.CMB_AUTOBIZ_PYTHON || "python",
        args: ["-I", "-B", "-X", "utf8", join(retained.root, "context-provider.py"), "--collect"]
      },
      configuration: {
        directoryBinding: (_name, key) =>
          manager.readRetainedDirectoryUserConfig(configuration, key, assertCurrent)
      }
    })
    if (!prepared) throw Error("CONTEXT_PROVIDER_REQUIRED")
    try {
      assertCurrent()
      const result = await execute(prepared.invocation.executable, prepared.invocation.args, {
        cwd: retained.root,
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 512 * 1024,
        env: { ...process.env, ...prepared.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
      })
      assertCurrent()
      const actual = JSON.parse(result.stdout) as { candidates: string[]; sessionContext: string }
      return {
        actual,
        assertCurrent,
        view: {
          supported: true,
          required: true,
          selected: [],
          candidates: actual.candidates,
          contextFingerprint: createHash("sha256")
            .update(JSON.stringify([retained.digest, captured.fingerprint, actual.candidates]))
            .digest("hex")
        }
      }
    } finally {
      prepared.release()
    }
  }
  await expect(read()).rejects.toThrow("PROJECT_MODS_APPROVAL_REQUIRED")
  const review = await manager.runtimeSourceReview(configuration)
  await manager.approveRuntimeSource({ ...configuration, digest: review!.digest }, guard)
  const catalog = await readNativeCapabilityCatalog(bound, "project")
  expect(catalog.status, JSON.stringify(catalog)).toBe("declared")
  expect(catalog.legacyAdapter).toBeUndefined()
  const initial = await read()
  expect(initial.view).toMatchObject({
    supported: true,
    required: true,
    candidates: ["UNIT.ONE", "UNIT.TWO"]
  })
  expect(initial.view.candidates).not.toContain("STALE_SOURCE_DEFAULT")
  for (const file of ["UNIT/AGENTS.md", "UNIT/one.md", "UNIT/two.md"])
    expect(initial.actual.sessionContext).toContain(
      (await readFile(join(knowledge, file), "utf8")).replace(/\r\n/g, "\n")
    )
  const selected = {
    deployUnitIds: ["UNIT.ONE"],
    contextFingerprint: initial.view.contextFingerprint
  }
  expect(() => assertCompositionUnitContextSelection(initial.view, selected)).not.toThrow()
  expect(() => assertCompositionUnitContextSelection(initial.view, undefined)).toThrow(
    "CONTEXT_REQUIRED"
  )
  const knowledgeFile = join(knowledge, "UNIT/one.md")
  const original = await readFile(knowledgeFile, "utf8")
  await writeFile(knowledgeFile, original + "\nChanged actual knowledge bytes\n")
  expect(initial.assertCurrent).toThrow("COMPOSITION_CONTEXT_INPUT_CHANGED")
  const changed = await read()
  expect(changed.actual.sessionContext).toContain("Changed actual knowledge bytes")
  expect(changed.view.contextFingerprint).not.toBe(initial.view.contextFingerprint)
  expect(() => assertCompositionUnitContextSelection(changed.view, selected)).toThrow(
    "CONTEXT_CHANGED"
  )
  const otherKnowledge = join(root, "other-knowledge")
  await cp(knowledge, otherKnowledge, { recursive: true })
  const otherManifestPath = join(otherKnowledge, "agents.manifest.json")
  const otherManifest = JSON.parse(await readFile(otherManifestPath, "utf8")) as {
    systems: Array<{ deployUnits: Array<{ deployUnitId: string }> }>
  }
  for (const system of otherManifest.systems)
    for (const unit of system.deployUnits)
      unit.deployUnitId = unit.deployUnitId.replace("UNIT.", "OTHER.")
  await writeFile(otherManifestPath, JSON.stringify(otherManifest))
  await writeFile(
    join(otherKnowledge, "UNIT/one.md"),
    "Facts from the newly selected knowledge directory.\n"
  )
  await nativeSave(otherKnowledge)
  expect(changed.assertCurrent).toThrow("CONTEXT_INPUT_CHANGED")
  const rebound = await read()
  expect(rebound.view.candidates).toEqual(["OTHER.ONE", "OTHER.TWO"])
  expect(rebound.actual.sessionContext).toContain(
    "Facts from the newly selected knowledge directory."
  )
  expect(rebound.actual.sessionContext).not.toContain("Changed actual knowledge bytes")
  const reboundContext = readPackageExtensionContract(retained.root)!.context!
  const data = join(
    root,
    "plugin-data",
    extensionContextStorageKey(
      metadata,
      await readFile(join(retained.root, "board_core/board_config.json")),
      reboundContext,
      realpathSync(otherKnowledge)
    )
  )
  const evidence = JSON.parse((await readFile(join(data, "collector-runs.jsonl"), "utf8")).trim())
  expect(evidence.candidates).toEqual(["OTHER.ONE", "OTHER.TWO"])
  expect(evidence.pid).not.toBe(process.pid)
  // The physical run stays bound to its frozen producer, not a later installed revision.
  await writeFile(
    join(source, "context-provider.py"),
    "raise RuntimeError('live replacement must not execute')\n"
  )
  expect((await read()).actual).toEqual(rebound.actual)
  plugin.enabled = false
  expect(rebound.assertCurrent).toThrow("OWNER_REVOKED")
  plugin.enabled = true
  owner = false
  await expect(read()).rejects.toThrow("OWNER_REVOKED")
  owner = true
  await writeFile(
    join(retained.root, "context-provider.py"),
    "raise RuntimeError('frozen source was modified')\n"
  )
  expect(rebound.assertCurrent).toThrow("PACKAGE_CHANGED")
  await expect(read()).rejects.toThrow("PACKAGE_CHANGED")
  expect(await readFile(join(fixture, "package/context-provider.py"))).toEqual(originalProvider)
}, 45_000)
