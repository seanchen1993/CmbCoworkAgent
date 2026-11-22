import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { afterEach, expect, it, vi } from "vitest"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"

const fixture = vi.hoisted(() => ({
  root: "",
  plugin: undefined as { id: string; path: string; name: string; version: string; enabled: boolean } |
    undefined,
  readScope: vi.fn((threadId: string) => ({
    created_at: 1,
    metadata: JSON.stringify({
      workspacePath: fixture.root,
      ...(threadId === "chat" ? {} : { harnessProjectSession: { projectId: threadId } })
    })
  }))
}))

vi.mock("../db", () => ({
  getThreadRuntimeScope: fixture.readScope,
  getThreadCore: () => { throw Error("Full thread history must not be read by project admission") }
}))
vi.mock("../storage", () => ({
  getOpenworkDir: () => fixture.root,
  getPlugins: () => fixture.plugin ? [fixture.plugin] : []
}))
vi.mock("../harness-board/service", () => ({
  readHarnessFeatureMetadata: () => undefined,
  getHarnessProjectAdapterSnapshot: async () => ({ id: "installed", type: "plugin" }),
  getHarnessProjectRootPath: () => fixture.root,
  assertHarnessProjectAdapterCurrent: () => undefined
}))
vi.mock("../harness-board/managed-run-store", () => ({ managedRunStore: {} }))
vi.mock("../mods/builtins/legacy-metrics", () => ({ registerBuiltinLegacyMetricsReader: vi.fn() }))
vi.mock("../mcp/capability-service", () => ({ closeProjectCapabilityMcpService: vi.fn() }))
vi.mock("../agent/agent-run-service", () => ({ isAgentRunBusy: () => false }))
vi.mock("../agent/local-sandbox", () => ({ LocalSandbox: {} }))
vi.mock("../agent/coordinator-worker-manager", () => ({ coordinatorWorkerManager: {} }))
vi.mock("./project-workspace-resources", () => ({ authorizeProjectWorkspaceResources: vi.fn() }))

afterEach(() => {
  vi.restoreAllMocks()
  if (fixture.root) rmSync(fixture.root, { recursive: true, force: true })
  fixture.root = ""
  fixture.plugin = undefined
  fixture.readScope.mockClear()
})

async function register() {
  vi.resetModules()
  const { registerLegacyProjectRuntimeHandlers } = await import("./project-runtime-legacy")
  const { prepareAgentRunAdmission } = await import("../agent/agent-run-admission")
  const { prepareFlowRuntimeAdmission } = await import("../mods/flows/runtime-admission")
  const { assertLegacyProjectEntry, withLegacyProjectSkillSource } =
    await import("../harness-board/project-runtime/legacy-entry-gate")
  const { LegacyOperationStore } = await import("../harness-board/project-runtime/legacy-operation-store")
  const { LegacyOptInIndex } = await import("../harness-board/project-runtime/legacy-opt-in-index")
  const openedStores: InstanceType<typeof LegacyOperationStore>[] = []
  const recover = LegacyOperationStore.prototype.recoverInterrupted
  vi.spyOn(LegacyOperationStore.prototype, "recoverInterrupted").mockImplementation(function (
    this: InstanceType<typeof LegacyOperationStore>
  ) {
    const result = recover.call(this)
    openedStores.push(this)
    return result
  })
  const handlers = new Map<string, (event: IpcMainInvokeEvent, projectId: string) => unknown>()
  const ipc = { handle: (name: string, callback: (event: IpcMainInvokeEvent, projectId: string) => unknown) =>
    handlers.set(name, callback) } as unknown as IpcMain
  const paths = {
    ledger: join(fixture.root, "legacy-project-runtime", "operations.sqlite"),
    index: join(fixture.root, "legacy-project-bindings.sqlite"),
    root: join(fixture.root, "legacy-project-runtime")
  }
  return {
    paths,
    index: new LegacyOptInIndex(paths.index),
    store: LegacyOperationStore,
    register: () => registerLegacyProjectRuntimeHandlers(ipc, () => undefined),
    close: () => openedStores.forEach((item) => item.close()),
    view: (id: string) => handlers.get("project-runtime:legacy-view")!({} as IpcMainInvokeEvent, id),
    enable: (id: string) => handlers.get("project-runtime:legacy-enable")!({} as IpcMainInvokeEvent, id),
    agent: (threadId: string) =>
      prepareAgentRunAdmission({ threadId, message: "Continue" }, { source: "desktop" }),
    flow: async (threadId: string) => prepareFlowRuntimeAdmission({
      threadId, workspace: fixture.root, requestId: "request", input: "Continue"
    }),
    stage: (id: string) => assertLegacyProjectEntry(id, "feature", fixture.root, undefined),
    skill: (id: string) => withLegacyProjectSkillSource(id, fixture.root, async (source) => source)
  }
}

async function originalCanContinue(f: Awaited<ReturnType<typeof register>>) {
  await expect(f.agent("chat")).resolves.toBeUndefined()
  await expect(f.agent("unbound")).resolves.toBeUndefined()
  await expect(f.flow("unbound")).resolves.toBeUndefined()
  expect(() => f.stage("unbound")).not.toThrow()
  await expect(f.skill("unbound")).resolves.toBeUndefined()
}

async function protectedCannotContinue(f: Awaited<ReturnType<typeof register>>) {
  await expect(f.agent("retained")).rejects.toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
  await expect(f.flow("retained")).rejects.toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
  expect(() => f.stage("retained")).toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
}

it("does not open optional project storage for ordinary and unbound projects on a fresh profile", async () => {
  fixture.root = mkdtempSync(join(tmpdir(), "legacy-lazy-admission-"))
  const f = await register()
  const service = f.register()
  try {
    await originalCanContinue(f)
    expect(f.view("unbound")).toEqual({ binding: null, operations: [] })
    expect(service?.listImportSources()).toEqual([])
    expect(existsSync(f.paths.root)).toBe(false)
    expect(existsSync(f.paths.index)).toBe(false)

    // Another instance can publish a binding and hold an active operation before the lazy open.
    mkdirSync(f.paths.root)
    const peer = new f.store(f.paths.ledger, undefined, undefined, undefined, f.index)
    const ownerProcess = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true
    })
    try {
      await once(ownerProcess, "spawn")
      const owner = { processId: ownerProcess.pid!, incarnation: "peer-instance" }
      const binding = peer.enable({
        projectId: "retained", workspace: fixture.root, installedPluginId: "installed",
        packageId: "example", packageVersion: "1", packageDigest: "a".repeat(64), mods: null
      })
      const { operation: started, ticket } = peer.admit({
        projectId: binding.projectId, workspace: binding.workspace,
        installedPluginId: binding.installedPluginId, packageDigest: binding.packageDigest,
        featureId: "feature", threadId: "retained", threadIncarnation: "peer-thread",
        requestId: "peer-request", inputDigest: "b".repeat(64), owner
      })

      await originalCanContinue(f)
      expect(() => f.stage("retained")).toThrow("LEGACY_RUN_ENTRY_REQUIRED")
      expect(peer.get(started.operationId)).toEqual(started)
      expect(peer.settle(ticket, "succeeded", "peer-finished").status).toBe("succeeded")
    } finally {
      ownerProcess.stdin.end()
      if (ownerProcess.pid !== undefined && ownerProcess.exitCode === null)
        await once(ownerProcess, "exit")
      peer.close()
    }
  } finally {
    f.close()
  }
})

it("opens the original isolated ledger on the first explicit opt-in", async () => {
  fixture.root = mkdtempSync(join(tmpdir(), "legacy-first-enable-"))
  const f = await register()
  const plugin = join(fixture.root, "installed")
  mkdirSync(plugin)
  const manifest = hostProjectFixture(fixture.root).manifest
  manifest.mode = "legacy"
  manifest.stateOwner = "plugin"
  writeFileSync(join(plugin, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  writeFileSync(join(plugin, "plugin.json"), '{"name":"docs","version":"1.0.0"}')
  fixture.plugin = { id: "installed", path: plugin, name: "docs", version: "1.0.0", enabled: true }
  f.register()
  try {
    expect(existsSync(f.paths.root)).toBe(false)
    await expect(f.enable("retained")).resolves.toMatchObject({
      binding: { projectId: "retained", installedPluginId: "installed" },
      operations: []
    })
    expect(existsSync(f.paths.ledger)).toBe(true)
    expect(f.index.readGeneration("retained")).toBeTruthy()
    expect(() => f.stage("retained")).toThrow("LEGACY_RUN_ENTRY_REQUIRED")
    await originalCanContinue(f)
  } finally {
    f.close()
  }
})

it("does not reconstruct an empty legacy state while retained packages remain", async () => {
  fixture.root = mkdtempSync(join(tmpdir(), "legacy-missing-authority-"))
  const f = await register()
  mkdirSync(join(f.paths.root, "packages", "a".repeat(64)), { recursive: true })
  expect(f.register()).toBeUndefined()
  try {
    await protectedCannotContinue(f)
    await expect(f.agent("unbound")).rejects.toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
    await expect(f.agent("chat")).resolves.toBeUndefined()
    expect(existsSync(f.paths.ledger)).toBe(false)
    expect(existsSync(f.paths.index)).toBe(false)
  } finally {
    f.close()
  }
})

it("keeps an unbound project working beside a corrupt retained marker and an unavailable ledger", async () => {
  fixture.root = mkdtempSync(join(tmpdir(), "legacy-scoped-unavailable-"))
  const f = await register()
  mkdirSync(f.paths.root)
  writeFileSync(f.paths.ledger, Buffer.alloc(8192, 0x5a))
  f.index.write(new Map([["retained", "known-generation"]]))
  const index = new DatabaseSync(f.paths.index)
  try {
    index.prepare("UPDATE opt_in_index SET data=? WHERE id=1").run(
      JSON.stringify({ version: 1, projects: [["retained", null]] })
    )
    expect(f.register()).toBeUndefined()
    await originalCanContinue(f)
    await protectedCannotContinue(f)
    expect(f.view("unbound")).toEqual({ binding: null, operations: [], writeUnavailable: true })

    // Duplicate or unreadable project IDs make the entire membership proof indeterminate.
    for (const projects of [
      [["retained", "one"], ["retained", "two"]],
      [["", "unidentified"]]
    ]) {
      index.prepare("UPDATE opt_in_index SET data=? WHERE id=1").run(JSON.stringify({ version: 1, projects }))
      await expect(f.agent("unbound")).rejects.toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
      await expect(f.flow("unbound")).rejects.toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
      expect(() => f.stage("unbound")).toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
    }
    await expect(f.agent("chat")).resolves.toBeUndefined()
  } finally {
    index.close()
    f.close()
  }
})

it("keeps original projects running after an opened ledger fails while retaining the bound fence", async () => {
  fixture.root = mkdtempSync(join(tmpdir(), "legacy-live-unavailable-"))
  const f = await register()
  mkdirSync(f.paths.root)
  const seed = new f.store(f.paths.ledger, undefined, undefined, undefined, f.index)
  try {
    seed.enable({ projectId: "retained", workspace: fixture.root, installedPluginId: "installed",
      packageId: "example", packageVersion: "1", packageDigest: "a".repeat(64), mods: null })
  } finally {
    seed.close()
  }
  const service = f.register()
  expect(service).toBeDefined()
  const writer = new DatabaseSync(f.paths.ledger)
  try {
    writer.exec("DROP TABLE legacy_bindings; DROP TABLE legacy_operations")
    await originalCanContinue(f)
    await protectedCannotContinue(f)
    expect(f.view("unbound")).toEqual({ binding: null, operations: [], writeUnavailable: true })
  } finally {
    writer.close()
    f.close()
  }
})
