import AdmZip from "adm-zip"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import type { BrowserWindow } from "electron"
import type { PluginMetadata } from "../../types"
import { FunctionModsManager } from "../../mods/v2/manager"
import { FunctionGuestRuntime } from "../../mods/v2/guest-runtime"
import { compileFunctionPlugin } from "../../mods/v2/loader"
import { ModControlStore } from "../../mods/control-store"
import { ApplicationCompletionPolicies } from "../../mods/v2/application-completion-policy"
import { FlowManager } from "../../mods/flows/manager"
import { FlowStore } from "../../mods/flows/store"
import {
  registerAgentRunImplementation,
  startAgentRun,
  type AgentRunDelivery
} from "../../agent/agent-run-service"
import {
  captureRuntimePluginSourceContentGuard,
  currentRuntimePluginSource
} from "../../plugins/runtime-source-scope"
import { snapshotDerivationSource, writeDerivationFiles } from "../../plugins/derivation-source"
import { assertPackageExtensionCompatibility } from "../../plugins/extension-contract"
import { readNativeCapabilityCatalog } from "../../plugins/capability-catalog"
import { prepareExtensionContext } from "../extension-context"
import { setProjectActionRuntime } from "../project-action-runtime"
import { createHostProjectInputIdentity } from "./package-input-identity"
import { LegacyProjectRuntimeService } from "./legacy-runtime-service"
import { LegacyOperationStore } from "./legacy-operation-store"
import { HostPackageSnapshots } from "./package-snapshots"
import { createLegacyModsRuntime, registerLegacyModsRuntime } from "./legacy-mods-runtime"
import { prepareAutobizCollectorFixture } from "../../../../tests/support/autobiz-collector-dependency-fixture"

const execute = promisify(execFile)
const library = resolve(
  process.env.AUTOBIZ_CREATOR_DEMO_LIBRARY ?? "output/deliveries/mods-creator-accepted-20261017"
)
const packages = [
  {
    title: "original full AutoBiz 1.0.1",
    archive: join(library, "10-完整AutoBiz+并行进度+知识版.zip"),
    version: "1.0.1",
    sha256: "b625ef04d22dbf02f4b44446396b79d78204236a0ae4828ce50d5cf93cc0a0a7"
  },
  {
    title: "reviewed warehouse 1.0.4 with complete Specs agent resources",
    archive: resolve(
      "output/deliveries/mods-creator-utest-library-20261018-v104/12-数仓可验证产物导出版-1.0.4.zip"
    ),
    version: "1.0.4",
    sha256: "8a1c6539e05f323b8bd269646c9b49e680b9cf64ff57a9e55c4760958be45487"
  }
]
const incompleteWarehouse = join(library, "11-数仓开发+进度+知识版.zip")
const incompleteWarehouseDigest = "a5cffc71e590fac67125bcd484f018643881fc3219b1babc4188d89a41d5681b"
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const delivery: AgentRunDelivery = {
  window: {} as BrowserWindow,
  send: () => undefined,
  isAvailable: () => true
}

async function unpackFixture(originalZip: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "ab-input-"))
  cleanup.push(async () => {
    if (dirname(root) !== tmpdir() || !basename(root).startsWith("ab-input-"))
      throw Error("UNSAFE_TEST_CLEANUP")
    await rm(root, { recursive: true, force: true })
  })
  const source = join(root, "plugin")
  await writeDerivationFiles(
    source,
    new AdmZip(originalZip)
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => {
        const bytes = entry.getData()
        return {
          path: entry.entryName,
          bytes,
          mode: 0o644,
          digest: createHash("sha256").update(bytes).digest("hex")
        }
      })
  )
  return { root, source }
}

/** Native admission and the original Python/JS are real; no model or remote business is used. */
async function fixture(inputPackage: (typeof packages)[number]) {
  const archive = inputPackage.archive
  const originalZip = await readFile(archive)
  const zipHash = createHash("sha256").update(originalZip).digest("hex")
  expect(zipHash).toBe(inputPackage.sha256)
  const { root, source } = await unpackFixture(originalZip)
  const originalSource = await snapshotDerivationSource(source)
  const metadata = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"))
  const envelope = JSON.parse(await readFile(join(source, "devclaw.project-runtime.json"), "utf8"))
  expect(envelope.runtime).toMatchObject({
    mode: "legacy",
    stateOwner: "plugin",
    plugin: { version: inputPackage.version }
  })
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  await writeFile(join(workspace, "AGENTS.md"), "# Rules\nWORKSPACE_INPUT_RULE_MUST_SURVIVE\n")
  const repository = join(root, "knowledge-upstream")
  await mkdir(join(repository, "DW"), { recursive: true })
  await writeFile(
    join(repository, "agents.manifest.json"),
    JSON.stringify({
      schemaVersion: "v1",
      systems: [
        {
          systemId: "DW",
          systemName: "Warehouse",
          agentsPath: "DW/AGENTS.md",
          deployUnits: [{ deployUnitId: "DW.ORDER", description: "Order model" }]
        }
      ]
    })
  )
  await writeFile(
    join(repository, "DW/AGENTS.md"),
    "# Warehouse\nKNOWLEDGE_INPUT_RULE_MUST_SURVIVE\n"
  )
  await writeFile(
    join(repository, "DW/orders.md"),
    "---\ndeploy_unit: DW.ORDER\ntype: Product Knowledge\ntitle: Order model\ndescription: KNOWLEDGE_INPUT_RULE_MUST_SURVIVE\n---\nOrder facts\n"
  )
  for (const args of [
    ["init", "-b", "fixture-knowledge", repository],
    ["-C", repository, "add", "."],
    [
      "-C",
      repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture"
    ]
  ])
    await execute("git", args, { windowsHide: true, timeout: 15_000 })

  const control = new ModControlStore(join(root, "mods.sqlite"))
  cleanup.push(() => control.close())
  const plugin: PluginMetadata = {
    ...metadata,
    id: randomUUID(),
    path: source,
    enabled: true
  }
  const functions = new FunctionModsManager(
    control,
    {
      plugins: () => [plugin],
      enabled: () => true,
      changed: () => undefined,
      publish: async (_workspace, value) => value
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
  cleanup.push(() => functions.close())
  const compiled = await compileFunctionPlugin(source)
  // Enter the original native code-consent service, including its real pure VM probe.
  await functions.approve(workspace, plugin.id, compiled.digest)
  expect(control.getGrant(workspace, `function:${compiled.name}`)?.digest).toBe(compiled.digest)
  const dataRoot = join(root, "data")
  const policies = new ApplicationCompletionPolicies(control)
  const input = createHostProjectInputIdentity(functions, {
    contextDataRoot: dataRoot,
    rules: (directory, names) =>
      names.map((name) => [name, policies.value(directory, name) ?? null])
  })
  const flows = new FlowManager(new FlowStore(control), {
    assertScope: () => undefined,
    changed: () => undefined,
    prepare: async () => {
      throw Error("MUST_USE_ORIGINAL_AGENT_ADMISSION")
    }
  })
  setProjectActionRuntime({
    ...input,
    flows,
    catalog: async () => [],
    prepareSelection: async () => undefined
  })
  cleanup.push(
    registerLegacyModsRuntime(
      createLegacyModsRuntime({
        store: control,
        isEnabled: () => true,
        workspaceKey: (value) => value,
        plugins: () => [plugin]
      })
    )
  )
  const ledger = new LegacyOperationStore(join(root, "legacy.sqlite"))
  cleanup.push(() => ledger.close())
  const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
  const projectId = randomUUID(),
    threadId = randomUUID()
  const service = new LegacyProjectRuntimeService(ledger, snapshots, {
    resolveThread: (id) =>
      id === threadId
        ? { projectId, featureId: "alpha", workspace, incarnation: "original-native-owner" }
        : undefined,
    resolvePlugin: async () => plugin,
    assertProjectIdle: () => undefined,
    assertInstalledSourceCurrent: (id, directory, installedId) => {
      if (
        id !== projectId ||
        directory !== workspace ||
        installedId !== plugin.id ||
        !plugin.enabled
      )
        throw Error("ACTUAL_PROJECT_SOURCE_CHANGED")
    },
    assertProjectBindingCurrent: (id, directory, installedId) => {
      if (id !== projectId || directory !== workspace || installedId !== plugin.id)
        throw Error("ACTUAL_PROJECT_BINDING_CHANGED")
    }
  })
  cleanup.push(service.register())
  const binding = await service.enable(projectId, workspace)
  const retained = snapshots.read(binding.packageDigest)
  const projectInput = {
    workspace,
    installedPluginId: plugin.id,
    packageId: plugin.name,
    pluginDigest: retained.digest,
    manifest: retained.manifest
  }
  await input.prepareInputIdentity(projectInput, retained.root)

  const networkFixture = join(root, "metadata-fixture.cjs")
  await writeFile(
    networkFixture,
    `const http=require("node:http"),{Readable}=require("node:stream"),{EventEmitter}=require("node:events");
http.request=(options,callback)=>{if(options.hostname!=="archguardservice.paas.cmbchina.cn")throw Error("NETWORK_BLOCKED");
const request=new EventEmitter();request.end=()=>queueMicrotask(()=>callback(Readable.from([JSON.stringify({returnCode:"SUC0000",body:{buildEngineName:"java"}})])));request.destroy=()=>{};return request};`
  )
  const prepare = (operation: "session-context" | "sync-knowledge", args: string[]) =>
    prepareExtensionContext({
      sourceRoot: retained.root,
      workspace,
      dataRoot,
      operation,
      invocation: {
        executable: "python",
        args: [
          "-I",
          "-B",
          "-X",
          "utf8",
          join(
            retained.root,
            "hooks",
            operation === "sync-knowledge"
              ? "sync_agents.py"
              : "render_collected_session_context.py"
          ),
          ...args
        ]
      },
      configuration: {
        // Pre-admission native sync reads the installed package. During an admitted
        // original agent, use its exact opaque retained source, as production IPC does.
        directoryBinding: (_name, key) =>
          functions.readDirectoryUserConfig(
            workspace,
            currentRuntimePluginSource()?.plugin.path ?? plugin.path,
            key
          )
      }
    })
  const run = async (prepared: NonNullable<Awaited<ReturnType<typeof prepare>>>) => {
    try {
      const result = await execute(prepared.invocation.executable, prepared.invocation.args, {
        cwd: retained.root,
        windowsHide: true,
        timeout: 45_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          ...prepared.env,
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          npm_config_offline: "true",
          GIT_ALLOW_PROTOCOL: "file",
          NODE_OPTIONS: `--require "${networkFixture.replace(/\\/g, "/")}"`
        }
      })
      return JSON.parse(result.stdout)
    } finally {
      prepared.release()
    }
  }
  // The frozen board's remote source is not modified: use the original CLI's local override.
  const sync = (await prepare("sync-knowledge", [
    "--repo-url",
    pathToFileURL(repository).href,
    "--ref",
    "fixture-knowledge",
    "--prefer-manifest",
    "--write-board-config"
  ]))!
  const data = sync.env.DEVCLAW_PLUGIN_DATA_ROOT
  const knowledge = sync.env.DEVCLAW_KNOWLEDGE_ROOT
  expect(await run(sync)).toMatchObject({
    ok: true,
    supported_deploy_units: ["DW.ORDER"],
    runtimeConfigWritten: true,
    boardConfigWritten: false
  })
  // The first render must materialize its own original scripts, outside knowledge/source.
  await rm(join(data, "collector"), { recursive: true })
  prepareAutobizCollectorFixture(join(data, "collector"))
  expect(existsSync(join(data, "collector/collect-knowledge.js"))).toBe(false)
  const beforeRender = input.inputIdentity(projectInput, retained.root)
  const render = async () =>
    run(
      (await prepare("session-context", [
        "--selected-deployUnit",
        JSON.stringify([{ deployUnitId: "DW.ORDER" }]),
        "--session-workspace-path",
        workspace,
        "--node-command",
        process.execPath
      ]))!
    )
  const start = async (body: (guard: () => void) => Promise<void>) => {
    registerAgentRunImplementation(async (_request, _delivery, context) => {
      expect(currentRuntimePluginSource()?.mode).toBe("legacy")
      const guard = captureRuntimePluginSourceContentGuard()!
      guard()
      await body(guard)
      context.onRunTerminated?.({ outcome: "success", code: "actual_context_render_complete" })
    })
    await (
      await startAgentRun(
        { threadId, message: "Load actual project context", streamRequestId: randomUUID() },
        delivery
      )
    ).completion
  }
  const unchanged = async () => {
    expect((await snapshotDerivationSource(source)).digest).toBe(originalSource.digest)
    expect(snapshots.read(binding.packageDigest).digest).toBe(retained.digest)
    expect(
      createHash("sha256")
        .update(await readFile(archive))
        .digest("hex")
    ).toBe(zipHash)
  }
  return {
    input,
    projectInput,
    retained,
    data,
    knowledge,
    service,
    projectId,
    start,
    render,
    unchanged,
    beforeRender,
    root,
    compiled,
    control,
    workspace,
    zipHash,
    originalSource,
    archiveName: basename(archive)
  }
}

// These immutable delivery archives are an explicit local integration prerequisite.
describe.skipIf(packages.some((inputPackage) => !existsSync(inputPackage.archive)))(
  "actual frozen AutoBiz context and legacy admission identity",
  () => {
    it.each(packages)(
      "keeps legal sync-before-admission and cold/repeated render valid: $title",
      async (archive) => {
        const f = await fixture(archive)
        await f.start(async (guard) => {
          for (let index = 0; index < 2; index++) {
            guard()
            const rendered = await f.render()
            expect(rendered.ok).toBe(true)
            expect(rendered.sessionContext).toContain("KNOWLEDGE_INPUT_RULE_MUST_SURVIVE")
            expect(rendered.sessionContext).toContain("WORKSPACE_INPUT_RULE_MUST_SURVIVE")
            guard()
            expect(f.input.inputIdentity(f.projectInput, f.retained.root)).toBe(f.beforeRender)
          }
        })
        expect(existsSync(join(f.data, "collector/collect-knowledge.js"))).toBe(true)
        expect(f.service.operations(f.projectId)[0].status).toBe("succeeded")
        await f.start(async (guard) => {
          guard()
          expect((await f.render()).ok).toBe(true)
          guard()
        })
        expect(f.service.operations(f.projectId)).toHaveLength(2)
        expect(
          f.service.operations(f.projectId).every((operation) => operation.status === "succeeded")
        ).toBe(true)
        await f.unchanged()
      },
      120_000
    )

    it.each(packages)(
      "rejects actual knowledge and deployment-unit changes after admission: $title",
      async (archive) => {
        for (const change of ["knowledge", "deployment-units"] as const) {
          const f = await fixture(archive)
          await f.start(async (guard) => {
            expect((await f.render()).ok).toBe(true)
            guard()
            if (change === "knowledge")
              await writeFile(join(f.knowledge, "DW/AGENTS.md"), "# Changed real knowledge\n")
            else {
              const path = join(f.data, "board_config.json")
              const config = JSON.parse(await readFile(path, "utf8"))
              config.supported_deploy_units.push("DW.NEW")
              await writeFile(path, JSON.stringify(config))
            }
            expect(guard).toThrow("LEGACY_CONTEXT_INPUT_CHANGED")
            expect(f.input.inputIdentity(f.projectInput, f.retained.root)).not.toBe(f.beforeRender)
          })
          expect(f.service.operations(f.projectId)[0]).toMatchObject({
            status: "unknown",
            terminalCode: "legacy_runtime_inputs_changed"
          })
          await f.unchanged()
          // Revoke registrations before the next independent real project fixture starts.
          for (const close of cleanup.splice(0).reverse()) await close()
        }
      },
      120_000
    )
  }
)

it.skipIf(!existsSync(incompleteWarehouse))(
  "refuses the immutable old warehouse package before exposing an executable business entry",
  async () => {
    const originalZip = await readFile(incompleteWarehouse)
    expect(createHash("sha256").update(originalZip).digest("hex")).toBe(incompleteWarehouseDigest)
    const { source } = await unpackFixture(originalZip)
    const metadata = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"))
    expect(() => assertPackageExtensionCompatibility(source)).toThrow(
      "PROJECT_AGENT_RESOURCE_MISSING: agents/explore.md"
    )
    const catalog = await readNativeCapabilityCatalog(
      {
        ...metadata,
        id: "immutable-incomplete-warehouse",
        path: source,
        enabled: true
      },
      "project"
    )
    expect(catalog.status).toBe("invalid")
    expect(catalog.reasons.join(";")).toContain("PROJECT_AGENT_RESOURCE_MISSING")
    expect(catalog.capabilities).toEqual([])
    expect(catalog.legacyAdapter).toBeUndefined()
    expect(
      createHash("sha256")
        .update(await readFile(incompleteWarehouse))
        .digest("hex")
    ).toBe(incompleteWarehouseDigest)
  }
)
