import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { HostProjectStore } from "../../harness-board/project-runtime/host-store"
import { HostProjectService } from "../../harness-board/project-runtime/host-service"
import { HostPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import { hostProjectFixture } from "../../harness-board/project-runtime/host-fixtures.test-helper"
import { captureThreadIncarnation } from "../../services/thread-incarnation"
import { resolveNativeProjectRuntimeScope } from "./platform-project-runtime-native"
import { createProjectRuntimePlatformProvider } from "./platform-project-runtime-provider"
import type { NativePlatformCallContext } from "./platform-capabilities-types"
import type { ModObject } from "../../../shared/mods/types"

const database = vi.hoisted(() => ({
  read: vi.fn(() => { throw Error("UNEXPECTED_NATIVE_DATABASE_ACCESS") }),
  workflowRead: vi.fn(() => { throw Error("UNEXPECTED_GLOBAL_WORKFLOW_READ") })
}))
// The focused resolver supplies original rows and readers below. It must not initialize
// the application-wide workflow runtime or silently read the user's global database.
vi.mock("../../agent/workflow/run-manager", () => ({ workflowRunManager: {
  isActive: database.workflowRead, getFlushFailedRun: database.workflowRead
} }))
vi.mock("../../db", () => ({ getThreadCore: vi.fn(), getDb: database.read }))
vi.mock("../../storage", () => ({ getPlugins: vi.fn(() => []) }))
const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close())
  expect(database.read).not.toHaveBeenCalled()
  expect(database.workflowRead).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-project-facade-"))
  const workspace = join(root, "workspace"),
    installed = join(root, "installed")
  mkdirSync(workspace)
  mkdirSync(installed)
  const manifest = hostProjectFixture(workspace).manifest
  writeFileSync(join(installed, "plugin.json"), JSON.stringify({ name: "docs", version: "1.0.0" }))
  writeFileSync(join(installed, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  for (const stage of manifest.stages) {
    mkdirSync(join(installed, "skills", stage.id), { recursive: true })
    writeFileSync(join(installed, stage.skill!), `---\nname: ${stage.id}\n---\nCreate the document`)
  }
  const store = new HostProjectStore(join(root, "state.sqlite"))
  cleanups.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const executeSkill = vi.fn(
    async (
      context: Parameters<ConstructorParameters<typeof HostProjectService>[2]["executeSkill"]>[0]
    ) => {
      context.bindThread("thread")
      writeFileSync(join(workspace, "document.md"), "real output")
      return "succeeded" as const
    }
  )
  const service = new HostProjectService(store, new HostPackageSnapshots(join(root, "snapshots")), {
    resolveInstalledPlugin: async () => ({
      installedPluginId: "installed",
      root: installed,
      packageId: "docs",
      packageVersion: "1.0.0",
      enabled: true
    }),
    authorize: async () => {},
    executeSkill
  })
  const project = await service.localCreate({
    projectId: "project",
    name: "Project",
    workspace,
    installedPluginId: "installed",
    goal: "Produce the document"
  })
  const operation = service.prepare({
    projectId: project.projectId,
    expectedVersion: 1,
    idempotencyKey: "first"
  })
  await service.start(operation.operationId)
  const binding = {
    projectId: project.projectId,
    operationId: operation.operationId,
    stageId: operation.stageId,
    pluginDigest: project.pluginDigest
  }
  const row = {
    created_at: 1,
    metadata: JSON.stringify({
      workspacePath: workspace,
      cmb_thread_incarnation: "thread-incarnation",
      hostProjectRuntime: binding
    })
  }
  const context: NativePlatformCallContext = {
    workspace,
    threadId: "thread",
    incarnation: JSON.stringify(captureThreadIncarnation(row)),
    generation: "native-1",
    caller: { name: "consumer", provider: "consumer", digest: "source", generation: "consumer-1" },
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
    invoke: vi.fn(),
    publish: vi.fn()
  }
  const readers = { thread: vi.fn(() => row), runtime: vi.fn(() => service), authorize: vi.fn() }
  return { service, store, project, operation, row, binding, context, readers, executeSkill }
}

it("resolves actual Host receipts and preflights actual retained inputs without executing", async () => {
  const f = await fixture()
  const readInputs = vi.spyOn(f.service, "readDebugInputIdentity")
  const provider = createProjectRuntimePlatformProvider({
    resolve: (context) => resolveNativeProjectRuntimeScope(context, f.readers)
  })
  expect(await provider.read!(f.context)).toMatchObject({
    status: "ready",
    operationStatus: "succeeded"
  })
  expect(await provider.act(f.context, "inspect", {})).toMatchObject({
    checks: [{ result: "passed" }]
  })
  expect(await provider.act(f.context, "preflight", { kind: "continue" })).toMatchObject({
    expectedVersion: 1,
    executionGranted: false
  })
  expect(readInputs).toHaveBeenCalledWith("project")
  expect(f.executeSkill).toHaveBeenCalledOnce()
  expect(f.service.operations("project")).toHaveLength(1)
})

it("does not resolve or initialize Host for an ordinary Mod conversation", async () => {
  const f = await fixture()
  f.row.metadata = JSON.stringify({
    workspacePath: f.context.workspace,
    cmb_thread_incarnation: "thread-incarnation"
  })
  expect(resolveNativeProjectRuntimeScope(f.context, f.readers)).toBeUndefined()
  expect(f.readers.runtime).not.toHaveBeenCalled()
})

it.each(["thread", "workspace", "incarnation", "project", "operation", "digest"])(
  "refuses substituted native binding %s",
  async (changed) => {
    const f = await fixture()
    if (changed === "thread") f.context = { ...f.context, threadId: "foreign" }
    if (changed === "workspace") f.context = { ...f.context, workspace: "C:/foreign" }
    if (changed === "incarnation") f.context = { ...f.context, incarnation: "old" }
    const metadata = JSON.parse(f.row.metadata)
    if (changed === "project") metadata.hostProjectRuntime.projectId = "foreign"
    if (changed === "operation") metadata.hostProjectRuntime.operationId = "foreign"
    if (changed === "digest") metadata.hostProjectRuntime.pluginDigest = "forged"
    f.row.metadata = JSON.stringify(metadata)
    expect(() => resolveNativeProjectRuntimeScope(f.context, f.readers)).toThrow(
      /SCOPE_CHANGED|BINDING_INVALID/
    )
  }
)

it("separates pre-execution state guard from post-execution authority and respects human approval", async () => {
  const f = await fixture()
  const provider = createProjectRuntimePlatformProvider({
    resolve: (context) => resolveNativeProjectRuntimeScope(context, f.readers),
    executeNative: async (request) => {
      request.assertCurrent()
      const result = await f.service.continue(request.projectId, {
        beforeStart: () => request.assertAuthority()
      })
      request.assertAuthority()
      expect(() => request.assertCurrent()).toThrow("STATE_CHANGED")
      expect(result.reason).toBe("approval_required")
      return {
        status: "completed",
        projectVersion: result.project.version,
        operationStatus: result.operations.at(-1)?.status
      }
    }
  })
  const plan = (await provider.act(f.context, "preflight", { kind: "continue" })) as ModObject
  expect(await provider.act(f.context, "request", { planId: plan.planId })).toMatchObject({
    status: "completed",
    projectVersion: 2,
    operationStatus: "prepared"
  })
  expect(
    f.service.operations("project").find((operation) => operation.stageId === "review")?.approval
  ).toBeNull()
  expect(f.executeSkill).toHaveBeenCalledOnce()
})

it("keeps cancel/reconcile preflight usable without running configuration preparation", async () => {
  const f = await fixture()
  const inputs = vi
    .spyOn(f.service, "readDebugInputIdentity")
    .mockRejectedValue(Error("bad configuration"))
  const scope = resolveNativeProjectRuntimeScope(f.context, f.readers)!
  await expect(scope.preflight("cancel")).resolves.toBeTypeOf("string")
  await expect(scope.preflight("reconcile")).resolves.toBeTypeOf("string")
  expect(inputs).not.toHaveBeenCalled()
  await expect(scope.preflight("continue")).rejects.toThrow("bad configuration")
})

it("rechecks plugin authorization and native metadata after asynchronous input preparation", async () => {
  const f = await fixture()
  const scope = resolveNativeProjectRuntimeScope(f.context, f.readers)!
  vi.spyOn(f.service, "readDebugInputIdentity").mockImplementation(async () => {
    f.row.metadata = JSON.stringify({
      workspacePath: f.context.workspace,
      cmb_thread_incarnation: "replacement",
      hostProjectRuntime: f.binding
    })
    return "input"
  })
  await expect(scope.preflight("continue")).rejects.toThrow("SCOPE_CHANGED")
})
