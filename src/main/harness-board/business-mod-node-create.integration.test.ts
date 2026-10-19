import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { afterAll, expect, it, vi } from "vitest"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import type { PluginMetadata } from "../types"
import type { NativeNodeCatalog, NativeNodePlan } from "../../shared/node-composition"
import type { BusinessModCatalog } from "../../shared/business-mods"

const state = vi.hoisted(() => ({
  root: `${process.env.TEMP || process.cwd()}/business-node-create-${process.pid}-${Date.now()}`,
  source: process.env.AUTOBIZ_BUSINESS_SOURCE || "",
  warehouse: process.env.AUTOBIZ_BUSINESS_WAREHOUSE_SOURCE || "",
  workspace: "",
  plugin: undefined as PluginMetadata | undefined,
  project: {} as Record<string, unknown>,
  config: {} as Record<string, unknown>
}))
vi.mock("../storage", () => ({
  getOpenworkDir: () => state.root,
  getPlugins: () => (state.plugin ? [state.plugin] : []),
  getUserInfo: () => ({})
}))
vi.mock("./notifications", () => ({ harnessNotifications: {} }))
vi.mock("./managed-run-store", () => ({ managedRunStore: { getLatestRun: () => undefined } }))
vi.mock("./catalog-client", () => ({
  cancelHarnessCatalogScope: () => undefined,
  readHarnessProjectContextsInWorker: async () => ({
    projects: {
      demo: {
        project: state.project,
        plugin: state.plugin,
        projectDirectoryExists: true,
        configSnapshot: { value: state.config, error: null },
        selectedDeployUnits: []
      }
    }
  }),
  readHarnessCatalogPageInWorker: async () => ({
    projects: [state.project],
    projectNextCursor: null
  })
}))
vi.mock("../db", () => ({
  // Native facts captures this export on import; node composition must not access AppDB.
  getDb: () => {
    throw Error("UNEXPECTED_NODE_COMPOSITION_DATABASE_ACCESS")
  },
  getThreadCore: () => ({
    created_at: 1,
    metadata: JSON.stringify({
      workspacePath: state.workspace,
      cmb_thread_incarnation: "test-incarnation"
    })
  })
}))
import { registerNodeCompositionHandlers } from "../ipc/node-composition"
import { initializeHarnessConfigV2 } from "./config-v2"
import { createHarnessFeature } from "./service"
import { assembleBusinessMods } from "../plugins/business-mod-assembler"
import { businessModCatalog } from "../plugins/business-mod-manifest"
import { snapshotDerivationSource, writeDerivationFiles } from "../plugins/derivation-source"
import {
  businessModSelectionPolicy,
  closeBusinessModSelection,
  readBusinessModSelectionPolicy
} from "../plugins/business-mod-selection"
import {
  nativeClosureInvocation,
  validateNativeClosure,
  type NativeNodeContext
} from "./node-composition"
import { readNativeCapabilityCatalog } from "../plugins/capability-catalog"

const execute = promisify(execFile)
afterAll(async () => {
  vi.unstubAllEnvs()
  if (state.workspace) await rm(resolve(state.root), { recursive: true, force: true })
})

it.skipIf(!state.source)(
  "passes the exact nearest-producer closure to the original Python solver",
  async () => {
    const nodes = [
      { id: "create", inputs: [], outputs: [{ path: "state.json", required: true }] },
      { id: "replace", inputs: [], outputs: [{ path: "state.json", required: true }] },
      { id: "check", inputs: [{ path: "state.json", required: true }], outputs: [] }
    ]
    const catalog: BusinessModCatalog = {
      apiVersion: "devclaw.business-mods/v1",
      kind: "catalog",
      kernelRef: { id: "autobiz.python-kernel", version: "1.0.0" },
      modules: nodes.map((node) => ({
        id: node.id,
        title: node.id,
        node: { id: node.id, artifacts: { inputs: node.inputs, outputs: node.outputs } },
        skill: { entry: `skills/${node.id}/SKILL.md`, resources: [] },
        resources: [],
        dependencies: { required: [], advisory: [] },
        checks: { validators: [], guards: [] }
      }))
    }
    const policy = businessModSelectionPolicy(catalog)
    const selected = closeBusinessModSelection(policy, ["check"], true)
    expect(selected).toEqual(["replace", "check"])
    const context = {
      strictBusinessSelection: policy,
      config: {
        templates: [{ id: "custom", templateType: "custom", requiredNodes: [] }],
        nodes: nodes.map((node) => ({ id: node.id }))
      },
      nodes: nodes.map((node) => ({
        id: node.id,
        inputs: node.inputs.map((input) => input.path),
        optionalInputs: [],
        outputs: node.outputs.map((output) => output.path)
      })),
      invocation: {
        cwd: state.source,
        invocation: {
          executable: "python",
          args: [join(state.source, "hooks/inspect_workflow_templates.py")]
        }
      }
    } as unknown as NativeNodeContext
    const invocation = nativeClosureInvocation(context, "custom", selected, true)
    expect(invocation.invocation.args).not.toContain("--auto-include")
    const result = await execute(
      "python",
      [
        "-B",
        "-X",
        "utf8",
        "-c",
        `import json,sys
from board_core.workflow_closure import solve_node_closure
r=solve_node_closure(json.loads(sys.argv[1]),json.loads(sys.argv[2]),auto_include_producers=sys.argv[3]=='1')
print(json.dumps({'ok':True,'mode':'closure','closure':{'nodes':list(r.nodes),'dropped':r.dropped}}))`,
        JSON.stringify({ workflow: { nodes: catalog.modules.map((mod) => mod.node) } }),
        JSON.stringify(selected),
        invocation.invocation.args.includes("--auto-include") ? "1" : "0"
      ],
      { cwd: state.source, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }
    )
    expect(
      validateNativeClosure(context, "custom", ["check"], JSON.parse(result.stdout), true).ordered
    ).toEqual(selected)
  }
)

it.skipIf(!state.source || !state.warehouse)(
  "creates the real assembled custom closure, preserves required contracts and rejects missing artifacts",
  async () => {
    const source = await snapshotDerivationSource(state.source)
    const warehouse = await snapshotDerivationSource(state.warehouse)
    const expected = [
      "biz.prd",
      "dev.specs",
      "warehouse.model",
      "warehouse.sql",
      "warehouse.quality"
    ]
    const assembled = assembleBusinessMods(
      [
        { snapshot: source, catalog: businessModCatalog(source), modIds: ["biz.prd", "dev.specs"] },
        { snapshot: warehouse, catalog: businessModCatalog(warehouse), modIds: expected.slice(2) }
      ],
      { name: "strict-custom-warehouse", version: "1.0.0", sources: [] }
    )
    expect(readBusinessModSelectionPolicy(assembled)?.nodes.map((node) => node.id)).toEqual(
      expected
    )
    const pluginPath = join(state.root, "package")
    await writeDerivationFiles(pluginPath, assembled.files)
    state.workspace = join(state.root, "workspace")
    const projectRoot = join(state.workspace, "demo")
    await mkdir(projectRoot, { recursive: true })
    await initializeHarnessConfigV2(state.root)
    state.plugin = {
      id: "independent-new-plugin",
      name: "strict-custom-warehouse",
      version: "1.0.0",
      path: pluginPath,
      enabled: true
    } as PluginMetadata
    state.config = JSON.parse(
      await readFile(join(pluginPath, "board_core/board_config.json"), "utf8")
    )
    state.project = {
      projectId: "demo",
      name: "Custom warehouse",
      projectCode: "demo",
      projectDir: "demo",
      workspacePath: state.workspace,
      systemId: "demo",
      systemName: "Demo",
      lifecycle: { status: "active" },
      boardCompatibility: { compatible: true },
      "harness-adapter": {
        id: state.plugin.id,
        name: state.plugin.name,
        version: "1.0.0",
        type: "plugin"
      }
    }
    const python = (args: string[], feature = "prd-only") =>
      execute("python", ["-B", "-X", "utf8", ...args], {
        cwd: pluginPath,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONIOENCODING: "utf-8",
          PLUGIN_WORKSPACE: state.workspace,
          PROJECT_DIR: "demo",
          FEATURE_ID: feature
        }
      })
    await python([
      join(pluginPath, "hooks/init_workspace.py"),
      "--mode",
      "createProject",
      "--workspace",
      state.workspace,
      "--project",
      "demo"
    ])
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173")
    const frame = { url: "http://localhost:5173/", processId: 1, routingId: 2 }
    const sender = { id: 5, mainFrame: frame, isDestroyed: () => false }
    const owner = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
    const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
    registerNodeCompositionHandlers(
      {
        handle: (id: string, handler: Parameters<IpcMain["handle"]>[1]) => {
          handlers.set(id, handler)
        }
      } as unknown as IpcMain,
      () => owner
    )
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
    const call = (method: string, fields: Record<string, unknown>) =>
      handlers.get(`node-composition:${method}`)!(event, {
        threadId: "demo-thread",
        expectedWorkspace: state.workspace,
        ...fields
      })
    const catalog = (await call("catalog", { projectId: "demo" })) as NativeNodeCatalog
    expect(
      catalog.config.templates.find((template) => template.id === "custom")?.requiredNodes
    ).toEqual([])
    const preview = (selected: string[]) =>
      call("preview", {
        projectId: "demo",
        templateId: "custom",
        selected,
        includeOptionalDependencies: false
      }) as Promise<NativeNodePlan>
    const first = await preview(["biz.prd"])
    expect(first.ordered).toEqual(["biz.prd"])
    const all = await preview(["warehouse.quality"])
    expect(all.ordered).toEqual(expected)
    expect(all.added).toEqual(expected.slice(0, -1))
    expect(all.entryInputFallbacks).toEqual([])
    const feature = (name: string) => ({
      projectId: "demo",
      feature: name,
      sessionContextInjectionSource: "plugin" as const,
      sessionWorkspace: { source: "directory" as const, path: projectRoot },
      workflowTemplate: "custom",
      workflowNodes: ["warehouse.quality"],
      workflowConfig: catalog.config
    })
    // A forged create bypassing the preview cannot use the Python compiler's dropped-input path.
    const statePath = join(projectRoot, ".autobizdevops/state.json")
    const before = await readFile(statePath)
    await expect(createHarnessFeature(feature("forged"))).rejects.toThrow("必需依赖")
    expect(await readFile(statePath)).toEqual(before)
    await call("create", { planId: first.planId, feature: feature("prd-only") })
    await call("create", { planId: all.planId, feature: feature("warehouse-full") })
    const persisted = JSON.parse(await readFile(statePath, "utf8"))
    expect(persisted.features["prd-only"].workflowNodes).toEqual(["biz.prd"])
    expect(persisted.features["warehouse-full"].workflowNodes).toEqual(expected)
    expect(persisted.features["warehouse-full"].workflowTemplate).toBe("custom")
    const contracts = JSON.parse(
      (
        await python([
          "-c",
          `import json,sys
from pathlib import Path
from board_core.contracts import load_record_workflow_contracts
p=Path(sys.argv[1]); r=json.loads((p/'.autobizdevops/state.json').read_text(encoding='utf-8'))['features']['warehouse-full']
c=load_record_workflow_contracts(Path.cwd(),r,workspace=p)
print(json.dumps(list(c.nodes),ensure_ascii=False))`,
          projectRoot
        ])
      ).stdout
    )
    for (const mod of [
      ...businessModCatalog(source).modules,
      ...businessModCatalog(warehouse).modules
    ]) {
      if (!expected.includes(mod.id)) continue
      const compiled = contracts.find((node: { id: string }) => node.id === mod.id)
      const original = mod.node.artifacts as { inputs?: Array<{ required?: boolean }> }
      expect(
        compiled.artifacts.inputs.filter(
          (input: { required?: boolean }) => input.required !== false
        )
      ).toEqual((original.inputs ?? []).filter((input) => input.required !== false))
      expect(compiled.validators).toEqual(mod.node.validators ?? [])
      expect(compiled.guards ?? []).toEqual(mod.node.guards ?? [])
    }
    const checkpoint = [
      join(pluginPath, "hooks/update_checkpoint.py"),
      "--checkpoint",
      "prd_done",
      "--json"
    ]
    const unchanged = await readFile(statePath)
    await expect(python(checkpoint)).rejects.toThrow()
    expect(await readFile(statePath)).toEqual(unchanged)
    const featureRoot = join(projectRoot, ".autobizdevops/features/prd-only")
    await writeFile(
      join(featureRoot, "PRD.md"),
      "# Controlled contract\n\n## 外部资料与实现约束\n无\n"
    )
    await writeFile(
      join(featureRoot, "UI_CONTEXT.json"),
      JSON.stringify({
        version: 1,
        featureId: "prd-only",
        uiRequired: false,
        decisionStatus: "locked",
        decisionSource: "user_confirmed",
        notApplicableReason: "Controlled contract only; no business acceptance claim",
        lockedAtCheckpoint: "prd_done",
        pages: [],
        interactions: [],
        visualSources: [],
        capabilities: []
      })
    )
    await python([
      join(pluginPath, "skills/autobiz/hooks/biz_validate.py"),
      "prd",
      "--feature",
      "prd-only",
      "--json",
      "--draft"
    ])
    await python(checkpoint)
    expect(JSON.parse(await readFile(statePath, "utf8")).features["prd-only"].checkpoint).toBe(
      "prd_done"
    )
    // A source replacement inside the real spawn guard cannot create another feature.
    const resource = join(pluginPath, "mods/business/warehouse.quality/check.py")
    const originalResource = await readFile(resource)
    await expect(
      createHarnessFeature({ ...feature("late-source"), workflowNodes: expected }, async () => {
        await writeFile(resource, "# changed after preparation\n")
      })
    ).rejects.toThrow("已变化")
    await writeFile(resource, originalResource)
    expect(JSON.parse(await readFile(statePath, "utf8")).features["late-source"]).toBeUndefined()
    const capability = await readNativeCapabilityCatalog(state.plugin, "project")
    expect(capability.legacyAdapter).toBe("autobiz-v1")
  },
  45_000
)
