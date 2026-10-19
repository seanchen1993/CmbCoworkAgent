import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { afterAll, expect, it, vi } from "vitest"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import type { PluginMetadata } from "../types"
import type { NativeNodeCatalog, NativeNodePlan } from "../../shared/node-composition"

// Opt in to the real local demo source. No production settings, model, or user project is touched.
const state = vi.hoisted(() => ({
  root: `${process.env.TEMP || process.cwd()}/autobiz-mods-create-${process.pid}-${Date.now()}`,
  source: process.env.AUTOBIZ_MODS_SOURCE || "",
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
      cmb_thread_incarnation: "demo-incarnation"
    })
  })
}))
import { registerNodeCompositionHandlers } from "../ipc/node-composition"
import { initializeHarnessConfigV2 } from "./config-v2"
import { compileFunctionPlugin } from "../mods/v2/loader"
import { readNativeCapabilityCatalog } from "../plugins/capability-catalog"
import { readProjectCompositionCatalog } from "../plugins/project-composition-catalog"

const execute = promisify(execFile)
afterAll(async () => {
  vi.unstubAllEnvs()
  if (state.workspace) await rm(resolve(state.root), { recursive: true, force: true })
})

it.skipIf(!state.source)(
  "real AutoBiz IPC previews optional closure and original createFeature persists exactly three nodes",
  async () => {
    state.source = resolve(state.source)
    state.workspace = join(state.root, "workspace")
    const projectRoot = join(state.workspace, "demo")
    await mkdir(projectRoot, { recursive: true })
    await initializeHarnessConfigV2(state.root)
    const metadata = JSON.parse(await readFile(join(state.source, "plugin.json"), "utf8"))
    state.plugin = { ...metadata, id: "demo-autobiz", path: state.source, enabled: true }
    state.config = JSON.parse(
      await readFile(join(state.source, "board_core/board_config.json"), "utf8")
    )
    state.project = {
      projectId: "demo",
      name: "Real AutoBiz demo",
      projectCode: "demo",
      projectDir: "demo",
      workspacePath: state.workspace,
      systemId: "demo",
      systemName: "Demo",
      lifecycle: { status: "active" },
      boardCompatibility: { compatible: true },
      "harness-adapter": {
        id: state.plugin!.id,
        name: metadata.name,
        version: metadata.version,
        type: "plugin"
      }
    }
    await execute(
      "python",
      [
        "-X",
        "utf8",
        join(state.source, "hooks/init_workspace.py"),
        "--mode",
        "createProject",
        "--workspace",
        state.workspace,
        "--project",
        "demo"
      ],
      {
        cwd: state.source,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
      }
    )
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
    const scope = { threadId: "demo-thread", expectedWorkspace: state.workspace }
    const call = (method: string, fields: Record<string, unknown>) =>
      handlers.get(`node-composition:${method}`)!(event, { ...scope, ...fields })
    const catalog = (await call("catalog", { projectId: "demo" })) as NativeNodeCatalog
    const selected = ["dev.specs", "dev.code", "ops.archive"]
    expect(catalog.config.templates.some((template) => template.id === "custom")).toBe(true)
    const all = (await call("preview", {
      projectId: "demo",
      templateId: "custom",
      selected
    })) as NativeNodePlan
    expect(all.includeOptionalDependencies).toBe(true)
    expect(all.ordered).toHaveLength(7)
    const subset = (await call("preview", {
      projectId: "demo",
      templateId: "custom",
      selected,
      includeOptionalDependencies: false
    })) as NativeNodePlan
    expect(subset.ordered).toEqual(selected)
    expect(subset.includeOptionalDependencies).toBe(false)
    expect(subset.optionalOmissions.length).toBeGreaterThan(0)
    expect(subset.entryInputFallbacks.length).toBeGreaterThan(0)
    for (const omission of subset.optionalOmissions)
      expect(catalog.nodes.find((node) => node.id === omission.nodeId)?.optionalInputs).toContain(
        omission.path
      )
    const feature = {
      projectId: "demo",
      feature: "mods-three-step-demo",
      sessionContextInjectionSource: "plugin",
      sessionWorkspace: { source: "directory", path: projectRoot },
      // The IPC plan, not these forged values, must control the actual adapter invocation.
      workflowTemplate: "standard",
      workflowNodes: ["biz.prd"],
      workflowConfig: { templates: [], nodes: [] }
    }
    await expect(call("create", { planId: subset.planId, feature })).rejects.toThrow("入口输入要求")
    const created = await call("create", {
      planId: subset.planId,
      feature,
      acknowledgeEntryRequirements: true
    })
    expect(created.slug).toBe(feature.feature)
    expect(await call("create", { planId: subset.planId, feature })).toEqual(created)
    const persisted = JSON.parse(
      await readFile(join(projectRoot, ".autobizdevops/state.json"), "utf8")
    )
    const record = persisted.features[feature.feature]
    expect(record.workflowTemplate).toBe("custom")
    expect(record.workflowNodes).toEqual(selected)
    expect(record.checkpoint).toBe("specs_in_progress")
    const capabilityCatalog = await readNativeCapabilityCatalog(state.plugin!, "project")
    expect(capabilityCatalog.status).toBe("declared")
    expect(capabilityCatalog.legacyAdapter).toBe("autobiz-v1")
    const composition = await readProjectCompositionCatalog(
      [state.plugin!],
      undefined,
      async () => capabilityCatalog
    )
    expect(
      composition.sources.some((source) => source.entry.available && source.entry.kind === "flow")
    ).toBe(true)
    const compiled = await compileFunctionPlugin(state.source)
    expect(compiled.actions?.map((action) => action.id)).toEqual([
      "collect-evidence",
      "generate-report"
    ])
    for (const action of compiled.actions!)
      expect(action.platform?.id).toBe("autobiz.delivery-report")
    const evidenceRoot = resolve("output/demo-readiness-20261016")
    await mkdir(evidenceRoot, { recursive: true })
    await writeFile(
      join(evidenceRoot, "autobiz-mods-node-create-integration.json"),
      JSON.stringify(
        {
          plugin: { name: metadata.name, version: metadata.version },
          fullNodes: all.ordered,
          selectedNodes: subset.ordered,
          optionalOmissions: subset.optionalOmissions,
          entryInputFallbacks: subset.entryInputFallbacks,
          persisted: record,
          capabilityIds: capabilityCatalog.capabilities.map((item) => item.id),
          actionIds: compiled.actions!.map((action) => action.id),
          boundary:
            "Real IPC handlers, original host createFeature, Python and filesystem. Renderer transport and host catalog DB are fixture adapters. No model or delivery quality assertion."
        },
        null,
        2
      )
    )
  },
  45_000
)
